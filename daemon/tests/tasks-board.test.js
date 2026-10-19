// The Tasks board: holding, releasing and deleting tasks, work items on new tasks, and the rule that only the workflow
// may put a task in In progress / In review / Done / Failed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-board-'));

const { q, q1, run } = await import('../src/db.ts');
const A = await import('../src/services/attachments.ts');
const { createRun, createUserTask, moveTask, deleteTask, wireEngineEvents, stopRun } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');

run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-b','{}','[]')`);
wireEngineEvents();

let n = 0;
// one workspace and repository per run: background planning in one test must not race git in another
const live = () => {
  const id = 'ws-b' + (++n), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-boardrepo-'));
  ensureRepo(dir);
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
       VALUES (?,?,'', ?, '[]','pol-b','isolated','{"workMode":"direct"}')`, id, id, JSON.stringify(['repo-' + id]));
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
       VALUES (?,?,?,NULL,'main','integration','','')`, 'repo-' + id, id, dir);
  const r = createRun({ workspaceId: id, goal: 'Board test', budgetUsd: 5 });
  run(`UPDATE runs SET status = 'running' WHERE id = ?`, r.id);
  return r;
};
const status = (id) => q1('SELECT status FROM tasks WHERE id = ?', id)?.status;

test('a task can be created on hold and is never dispatched', () => {
  const r = live();
  const t = createUserTask(r.id, { title: 'Park me', hold: true });
  assert.equal(t.status, 'held');
  assert.equal(q1(`SELECT COUNT(*) c FROM work_items WHERE task_id = ?`, t.id).c, 0);
  stopRun(r.id);
});

test('hold and release: only Ready and On hold are the owner\'s to choose', () => {
  const r = live();
  const t = createUserTask(r.id, { title: 'Movable' });
  assert.equal(t.status, 'ready');
  assert.equal(moveTask(t.id, 'held').task.status, 'held');
  assert.equal(q1('SELECT meta FROM tasks WHERE id = ?', t.id).meta.includes('heldFrom'), true);
  assert.equal(moveTask(t.id, 'held').task.status, 'held', 'holding twice is harmless');
  assert.equal(moveTask(t.id, 'ready').task.status, 'ready');
  for (const to of ['in-progress', 'in-review', 'done', 'failed', 'approved', 'verifying', 'blocked', 'nonsense']) {
    const res = moveTask(t.id, to);
    assert.equal(res.status, 409, `${to} must be refused`);
    assert.match(res.error, /workflow|Ready or On hold/);
  }
  assert.equal(status(t.id), 'ready', 'a refused move changes nothing');
  assert.equal(moveTask('nope', 'held').status, 404);
  stopRun(r.id);
});

test('a task an agent has started cannot be held or moved back to Ready by hand', () => {
  const r = live();
  const t = createUserTask(r.id, { title: 'Started' });
  for (const s of ['assigned', 'in-progress', 'verifying', 'in-review', 'changes-requested', 'done', 'failed', 'blocked']) {
    run('UPDATE tasks SET status = ? WHERE id = ?', s, t.id);
    assert.equal(moveTask(t.id, 'held').status, 409, `${s} -> held refused`);
    assert.equal(moveTask(t.id, 'ready').status, 409, `${s} -> ready refused`);
    assert.equal(status(t.id), s);
  }
  stopRun(r.id);
});

test('a task other open tasks wait for cannot be held until they are', () => {
  const r = live();
  const base = createUserTask(r.id, { title: 'Base' });
  const next = createUserTask(r.id, { title: 'Next' });
  run('UPDATE tasks SET depends_on = ? WHERE id = ?', JSON.stringify([base.id]), next.id);
  const res = moveTask(base.id, 'held');
  assert.equal(res.status, 409);
  assert.match(res.error, /Next/);
  assert.equal(moveTask(next.id, 'held').task.status, 'held');
  assert.equal(moveTask(base.id, 'held').task.status, 'held');
  stopRun(r.id);
});

test('releasing on a finished run is refused', () => {
  const r = live();
  const t = createUserTask(r.id, { title: 'Late', hold: true });
  run(`UPDATE runs SET status = 'done' WHERE id = ?`, r.id);
  assert.match(moveTask(t.id, 'ready').error, /run is done/);
  assert.equal(status(t.id), 'held');
});

test('work items become part of the description, the acceptance criteria and the task record', () => {
  const r = live();
  const t = createUserTask(r.id, {
    title: 'Polish login', description: 'See the screenshot.',
    workItems: [{ title: 'Align the button', instructions: 'Use the 8px grid.\nKeep the label.' }, { title: 'Fix the focus ring' }, { title: '', instructions: '' }],
  });
  assert.ok(!t.error, t.error);
  assert.match(t.description, /See the screenshot\./);
  assert.match(t.description, /## Work items\n1\. Align the button\n   Instructions: Use the 8px grid\.\n   Keep the label\.\n2\. Fix the focus ring/);
  assert.deepEqual(t.acceptanceCriteria, ['Work item 1 is done: Align the button', 'Work item 2 is done: Fix the focus ring', 'Existing behaviour keeps working']);
  assert.deepEqual(t.meta.workItems.map((w) => w.id), ['w1', 'w2'], 'the empty row is dropped');
  assert.match(createUserTask(r.id, { title: 'x', workItems: [{ instructions: 'no title' }] }).error, /short title/);
  assert.match(createUserTask(r.id, { title: 'x', workItems: Array.from({ length: 21 }, (_, i) => ({ title: `w${i}` })) }).error, /at most 20/);
  assert.match(createUserTask(r.id, { title: 'x', workItems: [{ title: 'y', instructions: 'z'.repeat(4001) }] }).error, /too long/);
  stopRun(r.id);
});

test('deleting a task removes it, its files and every link to it, and nothing else', () => {
  const r = live();
  const keep = createUserTask(r.id, { title: 'Keep' });
  const gone = createUserTask(r.id, { title: 'Gone' });
  run('UPDATE tasks SET depends_on = ? WHERE id = ?', JSON.stringify([gone.id]), keep.id);
  const f = A.addAttachment({ workspaceId: r.workspaceId, scope: 'task', taskId: gone.id, name: 'bug.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]) }).attachment;
  const other = A.addAttachment({ workspaceId: r.workspaceId, scope: 'task', taskId: keep.id, name: 'keep.md', data: Buffer.from('# keep') }).attachment;
  run(`INSERT INTO approvals (id, task_id, run_id, action, payload, requested_by, status, created_at) VALUES ('ap-x', ?, ?, 'x', '{}', 'e', 'pending', 'now')`, gone.id, r.id);
  const res = deleteTask(gone.id);
  assert.deepEqual({ ok: res.ok, title: res.title }, { ok: true, title: 'Gone' });
  assert.equal(status(gone.id), undefined);
  assert.ok(!fs.existsSync(A.fileOf(f)), 'its attachment is removed from disk');
  assert.ok(fs.existsSync(A.fileOf(other)), "another task's file stays");
  assert.equal(q1(`SELECT COUNT(*) c FROM approvals WHERE task_id = ?`, gone.id).c, 0);
  assert.deepEqual(JSON.parse(q1('SELECT depends_on d FROM tasks WHERE id = ?', keep.id).d), [], 'tasks stop waiting for it');
  assert.equal(status(keep.id), 'ready');
  assert.ok(q(`SELECT 1 FROM events WHERE type = 'task.deleted' AND entity_id = ?`, gone.id).length === 1);
  assert.equal(deleteTask(gone.id).status, 404);
  stopRun(r.id);
});

test('a task an agent is working on cannot be deleted', () => {
  const r = live();
  const t = createUserTask(r.id, { title: 'Busy' });
  run(`INSERT INTO work_items (id, task_id, run_id, kind, status, started_at) VALUES ('wi-live', ?, ?, 'implement', 'running', 'now')`, t.id, r.id);
  assert.equal(deleteTask(t.id).status, 409);
  assert.equal(status(t.id), 'ready');
  run(`UPDATE work_items SET status = 'delivered' WHERE id = 'wi-live'`);
  run(`UPDATE tasks SET status = 'in-progress' WHERE id = ?`, t.id);
  assert.equal(deleteTask(t.id).status, 409, 'in progress is refused even without a live work item');
  run(`UPDATE tasks SET status = 'done' WHERE id = ?`, t.id);
  assert.equal(deleteTask(t.id).ok, true, 'a finished task can be removed from the board');
  stopRun(r.id);
});
