// Stage 5: change-risk classifier, approval modes (always-ask / ask-when-risky
// / auto) and batch approve of low-risk items.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-pol-'));
const { q1, run } = await import('../src/db.ts');
const { classifyChangeRisk, requestApproval, decideApproval, approvalModeForRun } = await import('../src/services/policy.ts');
const { onEvent } = await import('../src/bus.ts');

run(`INSERT INTO workspaces (id, name, settings) VALUES ('ws-pol', 'Pol', ?)`, JSON.stringify({}));
run(`INSERT INTO workspaces (id, name, settings) VALUES ('ws-risky', 'Risky', ?)`, JSON.stringify({ approvalMode: 'ask-when-risky' }));
run(`INSERT INTO workspaces (id, name, settings) VALUES ('ws-auto', 'Auto', ?)`, JSON.stringify({ approvalMode: 'auto' }));
for (const [id, ws] of [['run-def', 'ws-pol'], ['run-risky', 'ws-risky'], ['run-auto', 'ws-auto']])
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES (?,?,'g','running')`, id, ws);

test('classifyChangeRisk: each risky signal and the clean case', () => {
  assert.equal(classifyChangeRisk({ files: ['src/a.ts'], declaredPaths: ['src/**'], checksRan: true }).risky, false);
  assert.match(classifyChangeRisk({ files: ['lib/evil.ts'], declaredPaths: ['src/**'] }).reasons[0], /outside/);
  assert.match(classifyChangeRisk({ files: ['.github/workflows/ci.yml'] }).reasons[0], /CI/);
  assert.match(classifyChangeRisk({ files: ['.env.production'] }).reasons[0], /secret/i);
  assert.match(classifyChangeRisk({ files: ['package-lock.json'] }).reasons[0], /lockfile/i);
  assert.match(classifyChangeRisk({ files: [{ path: 'old.ts', status: 'D' }] }).reasons[0], /deletes/);
  assert.match(classifyChangeRisk({ files: ['a.ts'], diffChars: 90_000 }).reasons[0], /large diff/);
  assert.match(classifyChangeRisk({ files: ['a.ts'], checksRan: false }).reasons[0], /no checks ran/);
  // several reasons stack
  const r = classifyChangeRisk({ files: ['x.ts', '.env'], checksRan: false });
  assert.equal(r.reasons.length, 2);
});

test('approvalModeForRun reads the workspace setting, default always-ask', () => {
  assert.equal(approvalModeForRun('run-def'), 'always-ask');
  assert.equal(approvalModeForRun('run-risky'), 'ask-when-risky');
  assert.equal(approvalModeForRun('run-auto'), 'auto');
  assert.equal(approvalModeForRun('missing'), 'always-ask');
});

test('always-ask leaves every request pending', () => {
  const a = requestApproval({ action: 'commit.task', runId: 'run-def', requestedBy: 'engine', payload: { summary: 'c', risk: { risky: false, reasons: [] } } });
  assert.equal(a.status, 'pending');
});

test('ask-when-risky auto-approves low-risk gates, logs the reason, keeps risky + decisions', () => {
  let autoEv = null;
  const off = onEvent((e) => { if (e.type === 'approval.auto') autoEv = e; });
  const low = requestApproval({ action: 'commit.task', runId: 'run-risky', requestedBy: 'engine', payload: { summary: 'clean commit', risk: { risky: false, reasons: [] } } });
  assert.equal(low.status, 'approved');
  assert.equal(q1('SELECT status FROM approvals WHERE id = ?', low.id).status, 'approved');
  assert.ok(autoEv, 'approval.auto event logged');
  assert.equal(autoEv.payload.action, 'commit.task');

  const risky = requestApproval({ action: 'commit.task', runId: 'run-risky', requestedBy: 'engine', payload: { summary: 'commit with .env', risk: { risky: true, reasons: ['secret file: .env'] } } });
  assert.equal(risky.status, 'pending');

  const q = requestApproval({ action: 'agent.question', runId: 'run-risky', requestedBy: 'ag', payload: { summary: 'which API?' } });
  assert.equal(q.status, 'pending'); // decisions always ask
  off();
});

test('auto mode approves even risky gates — but never a decision', () => {
  const risky = requestApproval({ action: 'commit.task', runId: 'run-auto', requestedBy: 'engine', payload: { summary: 'big risky commit', risk: { risky: true, reasons: ['deletes 3 files'] } } });
  assert.equal(risky.status, 'approved');
  const esc = requestApproval({ action: 'task.escalate', runId: 'run-auto', requestedBy: 'engine', payload: { summary: 'task failed 3x' } });
  assert.equal(esc.status, 'pending');
});
