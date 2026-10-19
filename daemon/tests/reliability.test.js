// Stage 4: failure classification, backoff, crash recovery, idempotent
// requeue, and ceiling pause-notify.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-rel-'));
const { q1, run } = await import('../src/db.ts');
const { classifyFailure, backoffDelayMs, fixHintFor, notifyOnce } = await import('../src/services/failure.ts');
const { reconcileOnBoot, createWorkItemRecord } = await import('../src/engine/engine.ts');

test('classifyFailure: transient / model-quality / fatal', () => {
  for (const m of ['rate-limit: 429', 'timeout: no output for 10 min', 'network: ECONNRESET', 'server: 502 bad gateway', 'cli exited with code -1'])
    assert.equal(classifyFailure(m), 'transient', m);
  for (const m of ['bad-response: reply was not JSON', 'empty output from the model', 'invalid output: failed validation'])
    assert.equal(classifyFailure(m), 'model-quality', m);
  for (const m of ['auth: 401 unauthorized', 'api key missing', 'spawn agent ENOENT', 'claude not installed'])
    assert.equal(classifyFailure(m), 'fatal', m);
});

test('backoffDelayMs grows exponentially, stays capped, has jitter', () => {
  const d1 = backoffDelayMs(1), d3 = backoffDelayMs(3), d9 = backoffDelayMs(9);
  assert.ok(d1 >= 2000 && d1 < 3100);
  assert.ok(d3 >= 8000 && d3 < 13000);
  assert.ok(d9 >= 60000 && d9 <= 90000); // capped at 60s + jitter
});

test('fixHintFor names the concrete fix', () => {
  assert.match(fixHintFor('auth: 401'), /API key/i);
  assert.match(fixHintFor('spawn foo ENOENT'), /CLI/i);
});

test('notifyOnce raises one pending approval per run+action', () => {
  run(`INSERT INTO runs (id, workspace_id, goal) VALUES ('run-rel','ws','g')`);
  assert.equal(notifyOnce('run-rel', 'run.ceiling', null, 'first'), true);
  assert.equal(notifyOnce('run-rel', 'run.ceiling', null, 'again'), false);
  const n = q1(`SELECT COUNT(*) c FROM approvals WHERE run_id = 'run-rel' AND action = 'run.ceiling'`).c;
  assert.equal(n, 1);
});

const cand = { agent: { id: 'ag-t', name: 'Tee' }, account: null, model: null, provider: { adapterId: 'scripted' }, role: null, membership: {} };

test('simulated crash: running work items are interrupted and requeued once', () => {
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-crash','ws','g','paused')`);
  run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('task-crash','run-crash','Crashy','in-progress')`);
  run(`INSERT INTO work_items (id, task_id, run_id, kind, agent_id, idempotency_key, status, started_at, heartbeat_at)
       VALUES ('wi-stuck','task-crash','run-crash','implement','ag-t','k-1','running', ?, ?)`,
    new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 3600_000).toISOString());
  reconcileOnBoot();
  assert.equal(q1(`SELECT status FROM work_items WHERE id = 'wi-stuck'`).status, 'interrupted');
  assert.equal(q1(`SELECT status FROM tasks WHERE id = 'task-crash'`).status, 'ready');
  // second boot is a no-op for already-interrupted items
  reconcileOnBoot();
  assert.equal(q1(`SELECT status FROM work_items WHERE id = 'wi-stuck'`).status, 'interrupted');
});

test('idempotency key prevents a second live work item for the same dispatch', () => {
  const task = { id: 'task-crash' };
  const a = createWorkItemRecord('run-crash', task, 'implement', cand, 'same prompt text', 'h1');
  const b = createWorkItemRecord('run-crash', task, 'implement', cand, 'same prompt text', 'h1');
  assert.equal(a.id, b.id); // the live queued item is reused, not duplicated
  const n = q1(`SELECT COUNT(*) c FROM work_items WHERE task_id = 'task-crash' AND status NOT IN ('failed','cancelled','interrupted','delivered')`).c;
  assert.equal(n, 1);
  // a different prompt is a different logical dispatch — allowed
  const c = createWorkItemRecord('run-crash', task, 'implement', cand, 'another prompt', 'h1');
  assert.notEqual(c.id, a.id);
});
