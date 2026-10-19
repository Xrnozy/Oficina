// Reference files and task attachments: validation, audiences and the documents/ folder, the manifest agents receive,
// updates, removal, and keeping the office's own files out of every task's changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attach-'));

const { q, q1, run } = await import('../src/db.ts');
const A = await import('../src/services/attachments.ts');
const { createRun, createUserTask, wireEngineEvents, stopRun } = await import('../src/engine/engine.ts');
const { ensureRepo } = await import('../src/services/git.ts');
const { snapshotTree, changedFilesBetween } = await import('../src/services/snapshot.ts');
const { dirtyPaths } = await import('../src/services/commits.ts');

const mkRepo = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-attachrepo-')); ensureRepo(d); return d; };
const repoA = mkRepo(), repoB = mkRepo();
run(`INSERT INTO policies (id, scope, rules) VALUES ('pol-a','{}','[]')`);
for (const [id, dir] of [['ws-a', repoA], ['ws-b', repoB]]) {
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings)
       VALUES (?,?,'', ?, '[]','pol-a','isolated','{"workMode":"direct"}')`, id, id, `["repo-${id}"]`);
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
       VALUES (?,?,?,NULL,'main','integration','','')`, `repo-${id}`, id, dir);
}
// an office with no repository at all
run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES ('ws-bare','bare','', '[]','[]','pol-a','isolated','{}')`);
for (const name of ['pm', 'developer', 'reviewer', 'qa', 'analyst', 'docs', 'prompt-creator']) {
  run(`INSERT INTO roles (id, name, version, responsibilities, allowed_actions, default_instructions, default_skills) VALUES (?,?,1,'[]','[]','','[]')`, `role-${name}`, name);
}
run(`INSERT INTO agents (id, name) VALUES ('ag-1','Dev One'), ('ag-2','Dev Two')`);
wireEngineEvents();

const buf = (s) => Buffer.from(s, 'utf8');
const ok = (r) => { assert.ok(!('error' in r), 'error' in r ? r.error : ''); return r.attachment; };
const rel = (a) => a.location;
const docsIn = (repo) => (fs.existsSync(path.join(repo, 'documents')) ? fs.readdirSync(path.join(repo, 'documents'), { recursive: true }).map(String).sort() : []);

test('a project-wide reference lands in documents/all-agents/ of the repository with a one-line summary', () => {
  const a = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'design.md', data: buf('# Design system\n\nUse 8px radii.\n') }));
  assert.equal(a.kind, 'markdown');
  assert.match(a.summary, /Design system/);
  assert.equal(rel(a), 'documents/all-agents/design.md');
  assert.equal(fs.readFileSync(path.join(repoA, 'documents', 'all-agents', 'design.md'), 'utf8'), '# Design system\n\nUse 8px radii.\n');
  assert.equal(fs.readFileSync(A.fileOf(a), 'utf8'), '# Design system\n\nUse 8px radii.\n');
});

test('audiences pick the folder: PM, developers, other roles, one agent, one run — and the role names are forgiving', () => {
  const pm = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', role: 'pm', name: 'roadmap.md', data: buf('# Roadmap\n') }));
  const dev = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', role: 'dev', name: 'standards.md', data: buf('# Coding standards\n') }));
  const qa = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', role: 'QA', name: 'test-plan.md', data: buf('# Test plan\n') }));
  const one = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'agent', agentId: 'ag-1', name: 'notes.md', data: buf('# Notes for Dev One\n') }));
  assert.equal(rel(pm), 'documents/pm/roadmap.md');
  assert.equal(rel(dev), 'documents/dev/standards.md');
  assert.equal(dev.role, 'developer');
  assert.equal(rel(qa), 'documents/qa/test-plan.md');
  assert.equal(rel(one), 'documents/agents/dev-one/notes.md');
  assert.equal(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', role: 'janitor', name: 'x.md', data: buf('x') }).status, 404);
  assert.equal(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', name: 'x.md', data: buf('x') }).status, 404);
  assert.ok(['all-agents', 'agents', 'dev', 'pm', 'qa'].every((d) => docsIn(repoA).includes(d)), docsIn(repoA).join(','));
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

test('names are cleaned: no folders, no traversal, no reserved device names — nothing escapes documents/', () => {
  assert.equal(A.cleanName('..\\..\\evil/../notes.md'), 'notes.md');
  assert.equal(A.cleanName('/etc/passwd'), 'passwd');
  assert.equal(A.cleanName('a<b>:c.md'), 'abc.md');
  assert.equal(A.cleanName('CON.txt'), '_CON.txt');
  const a = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: '../../escape.md', data: buf('# hi') }));
  assert.equal(a.name, 'escape.md');
  assert.ok(path.resolve(A.fileOf(a)).startsWith(path.join(repoA, 'documents', 'all-agents') + path.sep));
  assert.ok(!fs.existsSync(path.join(repoA, '..', 'escape.md')));
});

test("a file the owner already has in documents/ is never overwritten: the new one gets a free name", () => {
  fs.mkdirSync(path.join(repoB, 'documents', 'dev'), { recursive: true });
  fs.writeFileSync(path.join(repoB, 'documents', 'dev', 'spec.md'), 'MY OWN SPEC');
  const a = ok(A.addAttachment({ workspaceId: 'ws-b', scope: 'role', role: 'developer', name: 'spec.md', data: buf('# Uploaded spec\n') }));
  assert.equal(a.name, 'spec (2).md');
  assert.equal(fs.readFileSync(path.join(repoB, 'documents', 'dev', 'spec.md'), 'utf8'), 'MY OWN SPEC');
  assert.equal(fs.readFileSync(path.join(repoB, 'documents', 'dev', 'spec (2).md'), 'utf8'), '# Uploaded spec\n');
  // re-adding the same name updates our file (not the owner's)
  const again = A.addAttachment({ workspaceId: 'ws-b', scope: 'role', role: 'developer', name: 'spec (2).md', data: buf('# Uploaded spec v2\n') });
  assert.equal(again.updated, true);
  assert.equal(fs.readFileSync(path.join(repoB, 'documents', 'dev', 'spec.md'), 'utf8'), 'MY OWN SPEC');
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
  assert.ok(!docsIn(repoA).some((f) => f.includes('oficina-tmp')), 'no temp file is left behind');
});

test('the same file name for two audiences is two files', () => {
  const p = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'project', name: 'api.md', data: buf('# API for everyone\n') }));
  const d = ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', role: 'developer', name: 'api.md', data: buf('# API internals\n') }));
  assert.notEqual(p.id, d.id);
  assert.equal(rel(p), 'documents/all-agents/api.md');
  assert.equal(rel(d), 'documents/dev/api.md');
});

test('the manifest lists project, role, agent and task files for exactly who they belong to', () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Fix the login page', budgetUsd: 5 });
  const t1 = createUserTask(r.id, { title: 'Fix login bug', description: 'see the screenshot', workItems: [{ title: 'Align the button' }] });
  const t2 = createUserTask(r.id, { title: 'Other task' });
  assert.ok(!('error' in t1) && !('error' in t2));
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'task', taskId: t1.id, itemRef: 'w1', name: 'bug.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]) }));
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'task', taskId: t2.id, name: 'other.md', data: buf('# Other\n') }));
  ok(A.addAttachment({ workspaceId: 'ws-b', scope: 'project', name: 'foreign.md', data: buf('# Other office\n') }));

  const dev = A.manifestSection({ workspaceId: 'ws-a', runId: r.id, taskId: t1.id, agentId: 'ag-1', role: 'developer' }).section;
  assert.match(dev, /bug\.png.*\[for work item 1: Align the button\]/s);
  assert.match(dev, /standards\.md/, 'developer-role file');
  assert.match(dev, /notes\.md/, "this agent's own file");
  assert.match(dev, /design\.md/, 'project-wide file');
  assert.doesNotMatch(dev, /roadmap\.md/, "the PM's file is not for the developer");
  assert.doesNotMatch(dev, /test-plan\.md/, "the QA file is not for the developer");
  assert.doesNotMatch(dev, /other\.md/, "another task's file never leaks");
  assert.doesNotMatch(dev, /foreign\.md/, "another office's file never leaks");
  assert.match(dev, /do not read them all/i);
  assert.ok(!dev.includes('Use 8px radii'), 'only paths and summaries, never contents');
  assert.ok(dev.includes(path.join(repoA, 'documents', 'dev', 'standards.md')), 'the absolute path is given');

  const other = A.manifestSection({ workspaceId: 'ws-a', runId: r.id, taskId: t2.id, agentId: 'ag-2', role: 'developer' }).section;
  assert.match(other, /other\.md/);
  assert.doesNotMatch(other, /bug\.png|notes\.md/, 'neither the first task\'s file nor the other agent\'s file');

  const pm = A.manifestSection({ workspaceId: 'ws-a', runId: r.id, taskId: null, agentId: 'ag-pm', role: 'pm' }).section;
  assert.match(pm, /roadmap\.md/, "the PM's own file");
  assert.match(pm, /Given to other agents[\s\S]*standards\.md[\s\S]*\[for developer\]/, 'the PM can see what the other audiences got, to route it');
  stopRun(r.id);
});

test("a file the PM points a task at reaches that task's agent whatever audience it was filed under", () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Route a doc', budgetUsd: 5 });
  const base = { workspaceId: 'ws-a', runId: r.id, agentId: 'ag-2', role: 'developer' };
  assert.doesNotMatch(A.manifestSection(base).section, /test-plan\.md/);
  const picked = A.manifestSection({ ...base, references: ['test-plan.md', 'documents/pm/roadmap.md'] }).section;
  assert.match(picked, /Chosen by the PM for this task:[\s\S]*test-plan\.md[\s\S]*\[PM pick\]/);
  assert.match(picked, /roadmap\.md/);
  assert.notEqual(A.manifestFingerprint(base), A.manifestFingerprint({ ...base, references: ['test-plan.md'] }), 'the result cache sees the pick');
  stopRun(r.id);
});

test('a reference chosen for one run is invisible to other runs and filed under documents/runs/; removing deletes the file and empty folders', () => {
  const f = ok(A.addAttachment({ workspaceId: 'ws-b', scope: 'project', name: 'only-this-run.md', data: buf('# Scoped\n') }));
  assert.equal(rel(f), 'documents/all-agents/only-this-run.md');
  A.bindToRun([f.id], 'run-1', 'ws-b');
  const moved = A.getAttachment(f.id);
  assert.match(moved.location, /^documents\/runs\/run-1\/only-this-run\.md$/);
  assert.ok(fs.existsSync(moved.path));
  assert.match(A.manifestSection({ workspaceId: 'ws-b', runId: 'run-1' }).section, /only-this-run/);
  assert.doesNotMatch(A.manifestSection({ workspaceId: 'ws-b', runId: 'run-2' }).section, /only-this-run/);
  const fp = A.manifestFingerprint({ workspaceId: 'ws-b', runId: 'run-1' });
  assert.deepEqual(A.removeAttachment(f.id), { ok: true });
  assert.ok(!fs.existsSync(moved.path));
  assert.ok(!fs.existsSync(path.dirname(moved.path)), 'the empty run folder is removed');
  assert.equal(A.getAttachment(f.id), null);
  assert.notEqual(A.manifestFingerprint({ workspaceId: 'ws-b', runId: 'run-1' }), fp);
  assert.equal(A.removeAttachment(f.id).status, 404);
  // the owner's own documents/dev/spec.md in this repo is still there
  assert.ok(fs.existsSync(path.join(repoB, 'documents', 'dev', 'spec.md')));
});

test('removing the last reference removes documents/ itself, but never a folder that holds the owner\'s files', () => {
  const repo = mkRepo();
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES ('ws-c','c','', '["repo-c"]','[]','pol-a','isolated','{}')`);
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd) VALUES ('repo-c','ws-c',?,NULL,'main','integration','','')`, repo);
  const a = ok(A.addAttachment({ workspaceId: 'ws-c', scope: 'project', name: 'one.md', data: buf('# one') }));
  assert.ok(fs.existsSync(path.join(repo, 'documents')));
  A.removeAttachment(a.id);
  assert.ok(!fs.existsSync(path.join(repo, 'documents')), 'nothing of ours is left');
  fs.mkdirSync(path.join(repo, 'documents', 'all-agents'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'documents', 'all-agents', 'mine.md'), 'mine');
  const b = ok(A.addAttachment({ workspaceId: 'ws-c', scope: 'project', name: 'two.md', data: buf('# two') }));
  A.removeAttachment(b.id);
  assert.equal(fs.readFileSync(path.join(repo, 'documents', 'all-agents', 'mine.md'), 'utf8'), 'mine');
});

test('an office without a repository keeps its files in the data folder, and the manifest still works', () => {
  const a = ok(A.addAttachment({ workspaceId: 'ws-bare', scope: 'project', name: 'brief.md', data: buf('# Brief\n') }));
  assert.equal(a.location, null);
  assert.ok(A.fileOf(a).startsWith(path.join(process.env.OFFICE_DATA_DIR, 'attachments')));
  assert.match(A.manifestSection({ workspaceId: 'ws-bare', runId: null }).section, /brief\.md/);
  assert.deepEqual(A.removeAttachment(a.id), { ok: true });
  assert.ok(!fs.existsSync(A.fileOf(a)));
});

test('reference files from the earlier layout (data folder) are moved into documents/ once, and nothing is lost', () => {
  const id = 'legacy-1', dir = path.join(process.env.OFFICE_DATA_DIR, 'attachments', 'ws-b', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old.md'), '# Old reference');
  run(`INSERT INTO attachments (id, workspace_id, scope, name, mime, size, sha256, kind, summary, created_at, updated_at) VALUES (?,?, 'project', 'old.md', 'text/markdown', 15, 'x', 'markdown', 'Old reference', 'now', 'now')`, id, 'ws-b');
  assert.ok(A.relocateLegacy() >= 1);
  const a = A.getAttachment(id);
  assert.equal(a.location, 'documents/all-agents/old.md');
  assert.equal(fs.readFileSync(a.path, 'utf8'), '# Old reference');
  assert.ok(!fs.existsSync(dir), 'the old copy is gone');
  assert.equal(A.relocateLegacy(), 0, 'a second pass changes nothing');
});

test('limits: a task holds at most MAX_PER_TASK files', () => {
  const r = createRun({ workspaceId: 'ws-b', goal: 'Many files', budgetUsd: 5 });
  const t = createUserTask(r.id, { title: 'Crowded' });
  for (let i = 0; i < A.MAX_PER_TASK; i++) ok(A.addAttachment({ workspaceId: 'ws-b', scope: 'task', taskId: t.id, name: `f${i}.txt`, data: buf(`n${i}`) }));
  assert.equal(A.addAttachment({ workspaceId: 'ws-b', scope: 'task', taskId: t.id, name: 'one-too-many.txt', data: buf('x') }).status, 409);
  stopRun(r.id);
});

test('task work-item files must name a work item the task really has', () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Items', budgetUsd: 5 });
  const t = createUserTask(r.id, { title: 'Two items', workItems: [{ title: 'A' }, { title: 'B' }] });
  assert.equal(A.addAttachment({ workspaceId: 'ws-a', scope: 'task', taskId: t.id, itemRef: 'w3', name: 'x.md', data: buf('x') }).status, 400);
  assert.equal(ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'task', taskId: t.id, itemRef: 'w2', name: 'x.md', data: buf('x') })).itemRef, 'w2');
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

test('files are announced to the PM / the role through the inbox and the event log without touching running work', () => {
  const r = createRun({ workspaceId: 'ws-a', goal: 'Announce', budgetUsd: 5 });
  const before = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ?`, r.id).c;
  ok(A.addAttachment({ workspaceId: 'ws-a', scope: 'role', role: 'reviewer', name: 'late.md', data: buf('# Late\n') }));
  assert.ok(q(`SELECT 1 FROM events WHERE type = 'attachment.added' AND run_id = ?`, r.id).length >= 1);
  const msg = q1(`SELECT to_role, text FROM agent_messages WHERE run_id = ? ORDER BY rowid DESC LIMIT 1`, r.id);
  assert.equal(msg.to_role, 'reviewer');
  assert.match(msg.text, /documents\/reviewer\/late\.md/);
  assert.equal(q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ?`, r.id).c, before, 'no work item is created or restarted by a file');
  stopRun(r.id);
});

test('documents/ files never count as a task\'s changes, checkpoints or dirty paths — the owner\'s own edits still do', () => {
  const repo = mkRepo();
  run(`INSERT INTO workspaces (id, name, purpose, repo_ids, allowed_provider_ids, policy_id, memory_scope, settings) VALUES ('ws-d','d','', '["repo-d"]','[]','pol-a','isolated','{}')`);
  run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd) VALUES ('repo-d','ws-d',?,NULL,'main','integration','','')`, repo);
  const before = snapshotTree(repo);
  ok(A.addAttachment({ workspaceId: 'ws-d', scope: 'role', role: 'developer', name: 'standards.md', data: buf('# Standards\n') }));
  ok(A.addAttachment({ workspaceId: 'ws-d', scope: 'project', name: 'design [v2].md', data: buf('# Design\n') }));
  assert.equal(snapshotTree(repo), before, 'adding references leaves the working-state snapshot unchanged');
  assert.deepEqual(dirtyPaths(repo), []);
  fs.writeFileSync(path.join(repo, 'feature.js'), 'export const f = 1;\n');
  fs.mkdirSync(path.join(repo, 'documents', 'dev'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'documents', 'dev', 'my-own.md'), 'owner file next to ours');
  const after = snapshotTree(repo);
  const changed = changedFilesBetween(repo, before, after).map((f) => f.path).sort();
  assert.deepEqual(changed, ['documents/dev/my-own.md', 'feature.js'], "the owner's files count; the office's references do not");
  assert.ok(dirtyPaths(repo).includes('feature.js'));
  assert.ok(!dirtyPaths(repo).some((p) => p.includes('standards.md') || p.includes('design [v2]')));
  // and `git status` really does see the references as untracked files in the repository (they are visible to the owner)
  assert.match(execFileSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }), /documents\/dev\/standards\.md/);
});
