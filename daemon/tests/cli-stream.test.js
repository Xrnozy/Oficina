// The CLI adapter end to end with a fake stream-json CLI: activity is parsed
// from the real stream (even when lines arrive split), raw lines go to the
// technical log, and orchestration work never runs inside the repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-clistream-'));
const { cliAdapter } = await import('../src/adapters/cli.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-fakecli-'));
const fake = path.join(dir, 'fake.js');
const lines = [
  { type: 'system', subtype: 'init', session_id: 's-1', model: 'fake-model' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the converter.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/convert.js' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function convert' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }] } },
  { type: 'rate_limit_event', info: {} },
  { type: 'result', subtype: 'success', result: '{"decision":"pass","summary":"ok"}', total_cost_usd: 0.02, num_turns: 3 },
];
// write each line in two pieces with a pause, so chunks split JSON mid-line
fs.writeFileSync(fake, `
const lines = ${JSON.stringify(lines.map((l) => JSON.stringify(l)))};
process.stderr.write('warning: something odd\\n');
(async () => {
  for (const l of lines) {
    process.stdout.write(l.slice(0, 15)); await new Promise((r) => setTimeout(r, 15));
    process.stdout.write(l.slice(15) + '\\n'); await new Promise((r) => setTimeout(r, 15));
  }
  console.log('cwd=' + process.cwd());
})();
`);

function ctxFor(kind, repoPath) {
  const events = [];
  return {
    events,
    ctx: {
      workItem: { id: `wi-${kind}`, kind, runId: 'r', attempt: 1 },
      task: { id: 't', title: 'T' }, prompt: 'do it', worktree: kind === 'qa' ? repoPath : null, repo: { path: repoPath },
      agent: { id: 'ag-1', name: 'Fake', settings: {} },
      account: { config: { command: `"${process.execPath}" "${fake}"` } }, model: null,
      emit: (type, payload) => events.push({ type, payload }),
    },
  };
}

test('stream-json activity is parsed in order; technical records and raw lines are kept apart', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-'));
  const { ctx, events } = ctxFor('qa', repo);
  const res = await cliAdapter.dispatch(ctx);
  const all = events.filter((e) => e.type === 'agent.activity').map((e) => e.payload);
  assert.match(all[0].text, /^Started /);                          // process start and exit are reported
  assert.match(all[all.length - 1].text, /exited with code 0/);
  const act = all.filter((a) => a.kind !== 'status');
  assert.deepEqual(act.map((a) => a.kind), ['error', 'message', 'tool', 'tool-result', 'tool', 'result', 'message']);
  assert.equal(act[0].text, 'warning: something odd');            // stderr surfaces as an error line
  assert.equal(act[2].op, 'read'); assert.equal(act[2].file, 'src/convert.js');
  assert.equal(act[4].command, 'npm test');
  assert.equal(act[5].costUsd, 0.02);
  assert.ok(!act.some((a) => /rate_limit|init/.test(a.text ?? '')), 'technical records stay out of activity');
  const raw = events.filter((e) => e.type === 'agent.output').map((e) => e.payload.line);
  assert.ok(raw.some((l) => l.includes('rate_limit_event')), 'the technical log keeps every raw line');
  assert.ok(raw.every((l) => !l.startsWith('{') || (() => { try { JSON.parse(l); return true; } catch { return false; } })()), 'raw JSON lines are whole, never split');
  assert.equal(res.raw.json.decision, 'pass');
  assert.equal(res.usage.costUsd, 0.02);
});

test('PM acceptance runs on a desk outside the repository', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-'));
  const { ctx, events } = ctxFor('accept', repo);
  await cliAdapter.dispatch(ctx);
  const cwd = events.filter((e) => e.type === 'agent.activity').map((e) => e.payload.text).find((t) => t?.startsWith('cwd=')).slice(4);
  assert.ok(!path.resolve(cwd).startsWith(path.resolve(repo)), `accept ran in ${cwd}`);
  assert.ok(cwd.includes('desks'));
});

test('TUI-style output: carriage-return redraws, colour codes and lines without a newline still show up', async () => {
  const tui = path.join(dir, 'tui.js');
  fs.writeFileSync(tui, `
process.stdout.write('\\x1b[32mWorking on it\\x1b[0m\\r');
process.stdout.write('\\x1b[2KWorking on it\\r');           // the same status redrawn
process.stdout.write('Editing src/app.ts\\r\\n');
process.stdout.write('Waiting for tests');                      // no newline, then quiet
setTimeout(() => process.exit(0), 3500);
`);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-'));
  const { ctx, events } = ctxFor('qa', repo);
  ctx.account.config.command = `"${process.execPath}" "${tui}"`;
  const t0 = Date.now();
  let flushedAt = 0;
  const emit = ctx.emit;
  ctx.emit = (type, payload) => { if (type === 'agent.activity' && payload.text === 'Waiting for tests' && !flushedAt) flushedAt = Date.now(); emit(type, payload); };
  await cliAdapter.dispatch(ctx).catch(() => {});
  const msgs = events.filter((e) => e.type === 'agent.activity' && e.payload.kind === 'message').map((e) => e.payload.text);
  assert.deepEqual(msgs, ['Working on it', 'Editing src/app.ts', 'Waiting for tests']);
  assert.ok(flushedAt && flushedAt - t0 < 3400, 'an unterminated line is shown before the process exits');
});

test('a plain-text CLI\'s result is its final message; streamed thinking is joined into one block', async () => {
  const devin = path.join(dir, 'devin-like.js');
  fs.writeFileSync(devin, [
    "const w = (s) => process.stdout.write(s + String.fromCharCode(10));",
    "w('I will start by inspecting the repository.');",
    "for (const t of ['Checking', ' the', ' parser', ' first.']) w(JSON.stringify({ type: 'thinking', subtype: 'delta', text: t }));",
    "w('Running the tests.');",
    "setTimeout(() => { w('Done. Fixed the parser.'); w('**Validation**'); w('- 16/16 tests pass'); }, 3600);",
  ].join('\n'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-'));
  const { ctx, events } = ctxFor('qa', repo);
  ctx.account.config.command = `"${process.execPath}" "${devin}"`;
  const res = await cliAdapter.dispatch(ctx);
  assert.equal(res.summary, 'Done. Fixed the parser.\n**Validation**\n- 16/16 tests pass');
  const reasoning = events.filter((e) => e.type === 'agent.activity' && e.payload.kind === 'reasoning').map((e) => e.payload.text);
  assert.deepEqual(reasoning, ['Checking the parser first.']);
  const raw = events.filter((e) => e.type === 'agent.output').map((e) => e.payload.line);
  assert.ok(!raw.some((l) => l.includes('"delta"')), 'no per-fragment records');
  assert.ok(raw.some((l) => l.startsWith('[thinking] 4 streamed parts')));
});
