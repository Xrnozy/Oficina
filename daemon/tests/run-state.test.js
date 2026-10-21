// Run snapshots and restart recovery.
//  - The 15 s snapshot timer stored a full copy of every task and work item each time, changed or not: a real database
//    reached 632 MB of identical rows. Unchanged state is now skipped and each run keeps its newest 20.
//  - A task between two steps (a retry waiting out its backoff) when the daemon stopped had no work item to recover,
//    so nothing ever picked it up again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-runstate-'));
const { q1, run } = await import('../src/db.ts');
const { checkpoint, reconcileOnBoot } = await import('../src/engine/engine.ts');
const { verifyChain, emit } = await import('../src/bus.ts');

const count = (runId) => q1('SELECT COUNT(*) c FROM checkpoints WHERE run_id = ?', runId).c;

test('a snapshot is written only when the run changed — heartbeats alone do not count', () => {
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-s','ws','g','running')`);
  run(`INSERT INTO tasks (id, run_id, title, status) VALUES ('t-s','run-s','T','in-progress')`);
  run(`INSERT INTO work_items (id, task_id, run_id, kind, status, heartbeat_at) VALUES ('w-s','t-s','run-s','implement','running','2026-01-01T00:00:00Z')`);
  checkpoint('run-s'); checkpoint('run-s'); checkpoint('run-s');
  assert.equal(count('run-s'), 1);
  run(`UPDATE work_items SET heartbeat_at = '2026-01-01T00:05:00Z' WHERE id = 'w-s'`);
  checkpoint('run-s');
  assert.equal(count('run-s'), 1, 'a heartbeat is not a state change');
  run(`UPDATE tasks SET status = 'verifying' WHERE id = 't-s'`);
  checkpoint('run-s');
  assert.equal(count('run-s'), 2);
  assert.equal(q1(`SELECT checkpoint_id FROM runs WHERE id = 'run-s'`).checkpoint_id, q1(`SELECT id FROM checkpoints WHERE run_id = 'run-s' ORDER BY rowid DESC LIMIT 1`).id);
});

test('each run keeps its newest 20 snapshots; boot trims what older versions piled up', () => {
  for (let i = 0; i < 30; i++) { run(`UPDATE tasks SET priority = ? WHERE id = 't-s'`, i); checkpoint('run-s'); }
  assert.equal(count('run-s'), 20);
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-old','ws','g','done')`);
  for (let i = 0; i < 40; i++) run(`INSERT INTO checkpoints (id, run_id, seq, snapshot, created_at) VALUES (?, 'run-old', ?, '{}', '')`, `cp-old-${i}`, i);
  reconcileOnBoot();
  assert.equal(count('run-old'), 20);
  assert.ok(q1(`SELECT 1 FROM checkpoints WHERE id = 'cp-old-39'`), 'the newest one is kept');
  assert.ok(!q1(`SELECT 1 FROM checkpoints WHERE id = 'cp-old-0'`));
});

test('after a restart, a task left between two steps is picked up again; parked and waiting tasks keep their state', () => {
  run(`INSERT INTO runs (id, workspace_id, goal, status) VALUES ('run-b','ws','g','paused')`);
  const task = (id, status, meta = {}) => run(`INSERT INTO tasks (id, run_id, title, status, meta) VALUES (?, 'run-b', ?, ?, ?)`, id, id, status, JSON.stringify(meta));
  task('t-backoff', 'in-progress');                                        // its retry timer died with the daemon
  task('t-between', 'assigned');                                           // a prompt stage waiting to retry
  task('t-parked', 'assigned', { treeWait: true, promptReady: true, parkedPrompt: { kind: 'implement' } });
  task('t-gate', 'assigned', { wf: { nodes: [], awaiting: { kind: 'human', nodeId: 'h' } } });
  task('t-owner', 'waiting-input');
  task('t-live', 'in-progress');
  run(`INSERT INTO work_items (id, task_id, run_id, kind, status) VALUES ('w-live', 't-live', 'run-b', 'implement', 'waiting')`);
  reconcileOnBoot();
  const st = (id) => q1('SELECT status FROM tasks WHERE id = ?', id).status;
  assert.equal(st('t-backoff'), 'ready');
  assert.equal(st('t-between'), 'ready');
  assert.equal(st('t-parked'), 'assigned');
  assert.equal(st('t-gate'), 'assigned');
  assert.equal(st('t-owner'), 'waiting-input');
  assert.equal(st('t-live'), 'in-progress', 'work that is still accounted for is left alone');
});

test('the event chain check continues from where it stopped and still catches a broken chain', () => {
  emit('test.one', 'test', { n: 1 });
  const a = verifyChain();
  assert.equal(a.ok, true);
  emit('test.two', 'test', { n: 2 });
  const b = verifyChain();
  assert.equal(b.ok, true);
  assert.equal(b.checked, a.checked + 1);
  const last = q1('SELECT seq FROM events ORDER BY seq DESC LIMIT 1').seq;
  run(`UPDATE events SET payload = '{"n":99}' WHERE seq = ?`, last);
  assert.equal(verifyChain().ok, false, 'a changed event is caught');
});
