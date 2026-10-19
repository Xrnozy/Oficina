// Reference files and task attachments: validation, scoping, the manifest agents receive, updates and removal.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attach-'));

const { q, q1, run } = await import('../src/db.ts');
const A = await import('../src/services/attachments.ts');
const { createRun, createUserTask, wireEngineEvents, stopRun } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');

const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attachrepo-'));
ensureRepo(repoDir);
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-a','{}','[]')`);
for (const id of ['ws-a', 'ws-b']) {
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
       VALUES (?,?,'', ?, '[]','pol-a','isolated','{"workMode":"direct"}')`, id, id, `["repo-${id}"]`);
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
       VALUES (?,?,?,NULL,'main','integration','','')`, `repo-${id}`, id, repoDir);
}
run(`INSERT INTO agents (id, name) VALUES ('ag-1','Dev One'), ('ag-2','Dev Two')`);
wireEngineEvents();

const buf = (s) => Buffer.from(s, 'utf8');
const ok = (r) => { assert.ok(!('error' in r), 'error' in r ? r.error : ''); return r.attachment; };

test('a Markdown reference is stored outside any repository with a one-line summary', () => {
  const a = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'design.md', data: buf('# Design system\n\nUse 8px radii.\n') }));
  assert.equal(a.kind, 'markdown');
  assert.match(a.summary, /Design system/);
  assert.ok(A.fileOf(a).startsWith(path.join(process.env.OFFICE_DATA_DIR, 'attachments')));
  assert.equal(fs.readFileSync(A.fileOf(a), 'utf8'), '# Design system\n\nUse 8px radii.\n');
  assert.ok(!fs.existsSync(path.join(repoDir, 'design.md')), 'nothing is written into the repository');
});

test('bad input is refused with a reason: type, size, emptiness, binary-as-text, unknown targets', () => {
  const add = (o) => A.addAttachment({ workspaceId: 'ws-a', scope: 'project', data: buf('x'), name: 'a.md', ...o });
  assert.equal(add({ name: 'run.exe' }).status, 415);
  assert.equal(add({ name: 'noext' }).status, 415);
  assert.equal(add({ name: '' }).status, 400);
  assert.equal(add({ data: Buffer.alloc(0) }).status, 400);
  assert.equal(add({ data: Buffer.alloc(A.MAX_FILE_BYTES + 1, 97) }).status, 413);
  assert.equal(add({ data: Buffer.from([65, 0, 66]) }).status, 415, 'a .md with NUL bytes is not text');
  assert.equal(add({ workspaceId: 'nope' }).status, 404);
  assert.equal(add({ scope: 'agent', agentId: 'ghost' }).status, 404);
  assert.equal(add({ scope: 'task', taskId: 'ghost' }).status, 404);
  assert.equal(add({ scope: 'weird' }).status, 400);
});

test('names are cleaned: no folders, no traversal, no reserved device names', () => {
  assert.equal(A.cleanName('..\\..\\evil/../notes.md'), 'notes.md');
  assert.equal(A.cleanName('/etc/passwd'), 'passwd');
  assert.equal(A.cleanName('a<b>:c.md'), 'abc.md');
  assert.equal(A.cleanName('CON.txt'), '_CON.txt');
  const a = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: '../../escape.md', data: buf('# hi') }));
  assert.equal(a.name, 'escape.md');
  assert.ok(A.fileOf(a).startsWith(path.join(process.env.OFFICE_DATA_DIR, 'attachments', 'ws-a')));
});

test('re-adding a file with the same name in the same place updates it; identical bytes change nothing', () => {
  const first = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'spec.md', data: buf('# Spec v1\n') }));
  const same = A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'SPEC.md', data: buf('# Spec v1\n') });
  assert.equal(same.attachment.id, first.id);
  assert.equal(same.updated, false);
  const upd = A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'spec.md', data: buf('# Spec v2\n\nMore.\n') });
  assert.equal(upd.attachment.id, first.id);
  assert.equal(upd.updated, true);
  assert.match(upd.attachment.summary, /Spec v2/);
  assert.equal(fs.readFileSync(A.fileOf(upd.attachment), 'utf8'), '# Spec v2\n\nMore.\n');
  assert.equal(A.listAttachments({ workspaceId: 'ws-a', scope: 'project' }).filter((x) => x.name.toLowerCase() === 'spec.md').length, 1);
  assert.ok(!fs.existsSync(`${A.fileOf(first)}.tmp`), 'no temp file is left behind');
});

test('the manifest lists project, agent and task files for exactly the agent and task they belong to', () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Fix the login page', budgetUsd: 5 });
  const t1 = createUserTask(r.id, { title: 'Fix login bug', description: 'see the screenshot' });
  const t2 = createUserTask(r.id, { title: 'Other task' });
  assert.ok(!('error' in t1) && !('error' in t2));
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'task', taskId: t1.id, name: 'bug.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]) }));
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'task', taskId: t2.id, name: 'other.md', data: buf('# Other\n') }));
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'agent', agentId: 'ag-1', name: 'style.md', data: buf('# House style\n') }));
  ok(A.addAttachment({ workspaceId: 'ws-b', scope: 'project', name: 'foreign.md', data: buf('# Other office\n') }));

  const m1 = A.manifestSection({ workspaceId: 'ws-a', runId: r.id, taskId: t1.id, agentId: 'ag-1' }).section;
  assert.match(m1, /bug\.png/);
  assert.match(m1, /style\.md/);
  assert.match(m1, /design\.md/);
  assert.doesNotMatch(m1, /other\.md/, "another task's file never leaks");
  assert.doesNotMatch(m1, /foreign\.md/, "another office's file never leaks");
  assert.match(m1, /do not read them all/i);
  assert.ok(!m1.includes('Use 8px radii'), 'only paths and summaries, never contents');

  const m2 = A.manifestSection({ workspaceId: 'ws-a', runId: r.id, taskId: t2.id, agentId: 'ag-2' }).section;
  assert.match(m2, /other\.md/);
  assert.doesNotMatch(m2, /bug\.png|style\.md/);
  stopRun(r.id);
});

test('a reference chosen for one run is invisible to other runs; removing a file removes it from disk and prompts', () => {
  const f = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'only-this-run.md', data: buf('# Scoped\n') }));
  A.bindToRun([f.id], 'run-1', 'ws-a');
  assert.match(A.manifestSection({ workspaceId: 'ws-a', runId: 'run-1' }).section, /only-this-run/);
  assert.doesNotMatch(A.manifestSection({ workspaceId: 'ws-a', runId: 'run-2' }).section, /only-this-run/);
  const fp = A.manifestFingerprint({ workspaceId: 'ws-a', runId: 'run-1' });
  const file = A.fileOf(f);
  assert.deepEqual(A.removeAttachment(f.id), { ok: true });
  assert.ok(!fs.existsSync(file));
  assert.equal(A.getAttachment(f.id), null);
  assert.notEqual(A.manifestFingerprint({ workspaceId: 'ws-a', runId: 'run-1' }), fp, 'the result cache sees the change');
  assert.equal(A.removeAttachment(f.id).status, 404);
});

test('limits: a task holds at most MAX_PER_TASK files', () => {
  const r = createRun({ workspaceId: 'ws-b', goal: 'Many files', budgetUsd: 5 });
  const t = createUserTask(r.id, { title: 'Crowded' });
  for (let i = 0; i < A.MAX_PER_TASK; i++) ok(A.addAttachment({ workspaceId: 'ws-b', scope: 'task', taskId: t.id, name: `f${i}.txt`, data: buf(`n${i}`) }));
  const over = A.addAttachment({ workspaceId: 'ws-b', scope: 'task', taskId: t.id, name: 'one-too-many.txt', data: buf('x') });
  assert.equal(over.status, 409);
  stopRun(r.id);
});

test('an owner task is created ready (running run) or waiting (before the DoD is approved), with validation', () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Add things', budgetUsd: 5 });
  assert.match(createUserTask(r.id, { title: '   ' }).error, /title/);
  assert.match(createUserTask(r.id, { title: 'x'.repeat(201) }).error, /too long/);
  assert.match(createUserTask('nope', { title: 'a' }).error, /not found/);
  const waiting = createUserTask(r.id, { title: 'Before approval' });
  assert.equal(waiting.status, 'backlog');
  run(`UPDATE runs SET status = 'running' WHERE id = ?`, r.id);
  const ready = createUserTask(r.id, { title: 'While running', description: 'details' });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.plannedBy, 'owner');
  assert.ok(ready.acceptanceCriteria.length >= 1);
  run(`UPDATE runs SET status = 'done' WHERE id = ?`, r.id);
  assert.match(createUserTask(r.id, { title: 'Too late' }).error, /done/);
});

test('files are announced to the PM inbox and the event log without touching running work', () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Announce', budgetUsd: 5 });
  const before = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ?`, r.id).c;
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'late.md', data: buf('# Late\n') }));
  assert.ok(q(`SELECT 1 FROM events WHERE type = 'attachment.added' AND run_id = ?`, r.id).length >= 1);
  assert.equal(q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ?`, r.id).c, before, 'no work item is created or restarted by a file');
  stopRun(r.id);
});
