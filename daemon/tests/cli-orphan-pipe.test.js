// An agent that starts a dev server (or browser) for a test leaves it running after the CLI exits. That process inherits
// the CLI's output pipes, so the "close" event never comes. The hand-off must not wait for it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-orphan-'));
const { cliAdapter } = await import('../src/adapters/cli.ts');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-orphan-repo-'));
const fake = path.join(repo, 'fake-cli.mjs');
const pidFile = path.join(repo, 'child.pid');
fs.writeFileSync(fake, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
// a long-lived helper that keeps this process's stdout/stderr open, like \`npm start\` run for a smoke test
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
helper.unref();
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'finished the work' }));
`);

test('the work item is delivered shortly after the CLI exits even though a process it started still holds its output', async () => {
  const events = [];
  const started = Date.now();
  const res = await cliAdapter.dispatch({
    workItem: { id: 'orphan-1', kind: 'qa', runId: 'r', attempt: 1 },
    task: { id: 't', title: 'T' }, prompt: 'go', worktree: repo, repo: { path: repo },
    agent: { id: 'ag-o', name: 'o', settings: {} },
    account: { id: 'acct-o', config: { command: `"${process.execPath}" "${fake}"` } }, model: null,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const took = Date.now() - started;
  try {
    assert.ok(took < 15_000, `took ${took}ms`);
    assert.equal(res.raw.exitCode, 0);
    assert.match(res.summary, /finished the work/);
    assert.ok(events.some((e) => /still holding its output open/.test(String(e.payload?.text ?? ''))));
  } finally {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
  }
});
