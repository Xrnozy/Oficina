// A check command that leaves a process behind (a test that starts a server and never stops it) keeps the check's output
// pipes open after the command itself exited. The runner used to wait for those pipes to close, so the check never
// finished and the task stayed "verifying" forever — even past the check's timeout, which only killed the shell.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-checkrun-'));
const { runCheck } = await import('../src/services/verify.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-checkrun-wt-'));
const pidFile = path.join(dir, 'helper.pid');
fs.writeFileSync(path.join(dir, 'leaves-helper.mjs'), `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const helper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
helper.unref();
fs.writeFileSync(${JSON.stringify(pidFile)}, String(helper.pid));
console.log('tests passed');
process.exit(0);
`);
fs.writeFileSync(path.join(dir, 'hangs.mjs'), `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
console.log('started, never finishing');
setTimeout(() => {}, 120000);
`);
const node = 'node';                                    // on PATH, unquoted: the plain case
const quotedNode = JSON.stringify(process.execPath);    // "C:\Program Files\nodejs\node.exe": a quoted path with spaces
const check =(name, command, timeoutSec = 30) => ({ id: `chk-${name}`, repoId: 'r', name, kind: 'build', command, parser: 'exit0', passRule: 'exit0', timeoutSec, affectedPaths: [], protected: 0 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a check passes as soon as its command exits, even when a process it started still holds the output', async () => {
  const t0 = Date.now();
  try {
    const cr = await runCheck({ check: check('leaves-helper', `${node} leaves-helper.mjs`), worktree: dir, runId: 'run-c' });
    assert.equal(cr.status, 'pass');
    assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0}ms`);
  } finally {
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
  }
});

test('a check that runs past its timeout is stopped with everything it started, and reported as timed out', async () => {
  const t0 = Date.now();
  const cr = await runCheck({ check: check('hangs', `${node} hangs.mjs`, 2), worktree: dir, runId: 'run-c' });
  assert.equal(cr.status, 'error');
  assert.match(cr.summary, /timed out after 2s/);
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0}ms`);
});

test('a normal failing check still reports its exit code and output', async () => {
  const cr = await runCheck({ check: check('fails', `${node} -e "console.error('boom'); process.exit(3)"`), worktree: dir, runId: 'run-c' });
  assert.equal(cr.status, 'fail');
  assert.equal(cr.summary, 'exit 3');
});

test('a command with a quoted executable path (spaces) runs as written', async () => {
  const cr = await runCheck({ check: check('quoted', `${quotedNode} -e "process.exit(0)"`), worktree: dir, runId: 'run-c' });
  assert.equal(cr.status, 'pass', cr.summary);
});

test('the timed-out command and the processes it started are gone afterwards', async () => {
  const pf = path.join(dir, 'tree.pid');
  fs.writeFileSync(path.join(dir, 'tree.mjs'), `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const h = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(pf)}, String(h.pid));
setTimeout(() => {}, 120000);
`);
  await runCheck({ check: check('tree', `${node} tree.mjs`, 2), worktree: dir, runId: 'run-c' });
  const pid = Number(fs.readFileSync(pf, 'utf8'));
  await new Promise((r) => setTimeout(r, 1500));
  const still = alive(pid);
  if (still) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  assert.equal(still, false, 'a process the check started survived its timeout');
});
