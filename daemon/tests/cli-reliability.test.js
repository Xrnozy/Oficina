// CLI agents that stop answering, die early, or were left behind by a previous daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-clirel-'));
const { cliAdapter, failureTail, reapOrphanedCliChildren } = await import('../src/adapters/cli.ts');
const { buildCliCommand, killPidTreeSync, spawnShell } = await import('../src/adapters/cli-resolve.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-clirel-cli-'));
const script = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ctxFor(file, config = {}) {
  const events = [];
  return {
    events,
    ctx: {
      workItem: { id: `wi-${path.basename(file)}-${Date.now()}`, kind: 'qa', runId: 'r', attempt: 1 },
      task: { id: 't', title: 'T' }, prompt: 'check it', worktree: dir, repo: { path: dir },
      agent: { id: 'ag-rel', name: 'Rel', settings: {} },
      account: { id: 'acct-rel', config: { command: `"${process.execPath}" "${file}"`, ...config } }, model: null,
      emit: (type, payload) => events.push({ type, payload }),
    },
  };
}

// the signature seen in the field: reasoning streams, "thinking completed", then nothing — no tool running
const stalls = script('stalls.mjs', `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(dir, 'stalls.pid'))}, String(process.pid));
const w = (o) => console.log(JSON.stringify(o));
w({ type: 'system', subtype: 'init', session_id: 's' });
for (const t of ['Checking', ' the', ' tests']) w({ type: 'thinking', subtype: 'delta', text: t });
w({ type: 'thinking', subtype: 'completed' });
setInterval(() => {}, 1000);
`);

test('a stream-json CLI that goes silent with no tool running is stopped as stalled, with a plain reason', { timeout: 30000 }, async () => {
  const { ctx, events } = ctxFor(stalls, { idleTimeoutSec: 2 });
  const t0 = Date.now();
  await assert.rejects(cliAdapter.dispatch(ctx), (e) => {
    assert.equal(e.kind, 'timeout');
    assert.match(e.message, /stopped responding — no output for 2s/);
    assert.doesNotMatch(e.message, /thinking/);
    return true;
  });
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0}ms`);
  assert.ok(events.some((e) => e.type === 'agent.activity' && /has stalled/.test(e.payload.text)));
  const pid = Number(fs.readFileSync(path.join(dir, 'stalls.pid'), 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  assert.equal(alive(pid), false, 'the stalled CLI process is gone');
});

test('a long-running tool call (a build, a test run) is not mistaken for a stall', { timeout: 30000 }, async () => {
  const busy = script('busy-tool.mjs', `
const w = (o) => console.log(JSON.stringify(o));
w({ type: 'system', subtype: 'init', session_id: 's' });
w({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm test' } } } });
setTimeout(() => {
  w({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { shellToolCall: { args: { command: 'npm test' }, result: { success: { stdout: 'ok' } } } } });
  w({ type: 'result', subtype: 'success', result: '{"decision":"pass","summary":"ok"}' });
}, 4500);
`);
  const { ctx } = ctxFor(busy, { idleTimeoutSec: 2 });
  const res = await cliAdapter.dispatch(ctx);
  assert.equal(res.raw.exitCode, 0);
  assert.equal(res.raw.json.decision, 'pass');
});

test('a plain-text CLI is not stopped by the default watchdog (it may legitimately say nothing for a while)', { timeout: 30000 }, async () => {
  const quiet = script('quiet.mjs', `console.log('working'); setTimeout(() => console.log('Done.'), 3000);`);
  const { ctx } = ctxFor(quiet, {});      // no idleTimeoutSec: the default applies only to stream-json CLIs
  const res = await cliAdapter.dispatch(ctx);
  assert.equal(res.raw.exitCode, 0);
});

test('the hard timeout is reported as a timeout, not as the last line of output', { timeout: 30000 }, async () => {
  const chatty = script('chatty.mjs', `setInterval(() => console.log(JSON.stringify({ type: 'thinking', subtype: 'delta', text: 'hm' })), 200);`);
  const { ctx } = ctxFor(chatty, { timeoutSec: 2 });
  await assert.rejects(cliAdapter.dispatch(ctx), (e) => e.kind === 'timeout' && /still running after 2s/.test(e.message));
});

test('a CLI that exits before reading its prompt does not crash the daemon', { timeout: 30000 }, async () => {
  const early = script('early.mjs', `process.exit(2);`);
  const { ctx } = ctxFor(early, {});
  ctx.prompt = 'x'.repeat(4 * 1024 * 1024);   // far more than a pipe buffer: the write fails with EPIPE
  await assert.rejects(cliAdapter.dispatch(ctx), /cli exited 2/);
});

test('failureTail keeps the reason and drops streamed reasoning', () => {
  const out = [
    JSON.stringify({ type: 'thinking', subtype: 'delta', text: ' match the design' }),
    JSON.stringify({ type: 'tool_call', subtype: 'started', call_id: 'x' }),
    'Error: connection reset by peer',
    JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', terminal_reason: 'api_error' }),
    '{"type":"thinking","subtype":"delta","text":"cut off',
  ].join('\n');
  const t = failureTail(out);
  assert.match(t, /connection reset by peer/);
  assert.match(t, /api_error/);
  assert.doesNotMatch(t, /match the design|cut off/);
});

test('{prompt} is passed as one quoted argument: shell operators in it stay text', async () => {
  const { cmd } = buildCliCommand(`"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" {prompt}`, { prompt: 'fix a & echo INJECTED | more $& done', worktree: dir });
  const out = await new Promise((resolve) => {
    let s = '';
    const c = spawnShell(cmd, { cwd: dir });
    c.stdout.on('data', (d) => { s += d; });
    c.on('close', () => resolve(s));
  });
  assert.doesNotMatch(out, /^INJECTED/m, 'the & started a second command');
  assert.deepEqual(JSON.parse(out.trim()), ['fix a & echo INJECTED | more $& done']);
});

test('on start, agent CLIs a previous daemon left running are stopped — and only those', { timeout: 30000, skip: process.platform !== 'win32' && 'Windows process lookup' }, async () => {
  const sleeper = script('sleeper.mjs', `setInterval(() => {}, 1000);`);
  const cmd = `"${process.execPath}" "${sleeper}" orphan`;
  const orphan = spawnShell(cmd, { cwd: dir, stdio: 'ignore' });
  const bystander = spawnShell(`"${process.execPath}" "${sleeper}" bystander`, { cwd: dir, stdio: 'ignore' });
  await sleep(800);
  try {
    fs.writeFileSync(path.join(process.env.OFFICE_DATA_DIR, 'cli-children.json'), JSON.stringify([
      { pid: orphan.pid, cmd, workItemId: 'old-1' },
      { pid: bystander.pid, cmd: `"${process.execPath}" "${sleeper}" something-else`, workItemId: 'old-2' },   // pid reused by another program
    ]));
    assert.equal(reapOrphanedCliChildren(), 1);
    await sleep(800);
    assert.equal(alive(orphan.pid), false, 'the orphaned agent CLI was stopped');
    assert.equal(alive(bystander.pid), true, 'an unrelated process with a recorded pid is left alone');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.OFFICE_DATA_DIR, 'cli-children.json'), 'utf8')), []);
  } finally {
    for (const c of [orphan, bystander]) killPidTreeSync(c.pid);
  }
});
