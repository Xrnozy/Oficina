// General + agent checkpoints on throwaway git repos: undo/redo must restore
// exactly the checkpoint's own changes and never touch anything else.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cp-data-'));
const { run } = await import('../src/db.ts');
const cp = await import('../src/services/checkpoints.ts');

const g = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0;
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cp-repo-'));
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'cache/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a1\na2\na3\na4\na5\na6\na7\na8\na9\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\nb2\n');
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'to delete\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-m', 'init');
  const id = `repo-t${++n}`;
  run('INSERT INTO repos (id, workspace_id, path, default_branch, integration_branch) VALUES (?,?,?,?,?)', id, 'ws', dir, 'main', 'main');
  return { dir, id };
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

test('general checkpoint: undo restores the pre-task state, redo the result — incl. untracked, deleted and pre-existing user edits', () => {
  const { dir, id } = makeRepo();
  write(dir, 'b.txt', 'b1 USER EDIT\nb2\n');          // uncommitted user work before the task
  write(dir, 'notes.md', 'user untracked\n');           // untracked user file
  const statusBefore = g(dir, 'status', '--porcelain');
  const gen = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'task' });
  write(dir, 'a.txt', read(dir, 'a.txt').replace('a1', 'A1 task'));
  write(dir, 'src/new.js', 'export const x = 1;\n');  // created
  fs.rmSync(path.join(dir, 'gone.txt'));                // deleted
  write(dir, 'cache/big.bin', 'ignored');               // ignored: not part of any checkpoint
  const done = cp.endCheckpoint(gen.id);
  assert.deepEqual(done.files.map((f) => `${f.status} ${f.path}`).sort(), ['A src/new.js', 'D gone.txt', 'M a.txt']);

  const u = cp.perform(gen.id, 'undo');
  assert.ok(u.ok, u.message);
  assert.equal(read(dir, 'a.txt').split('\n')[0], 'a1');
  assert.ok(!exists(dir, 'src/new.js'));
  assert.equal(read(dir, 'gone.txt'), 'to delete\n');
  assert.equal(read(dir, 'b.txt'), 'b1 USER EDIT\nb2\n');   // user work preserved
  assert.equal(read(dir, 'notes.md'), 'user untracked\n');
  assert.ok(exists(dir, 'cache/big.bin'));
  assert.equal(g(dir, 'status', '--porcelain'), statusBefore, 'repo back to the pre-task state');
  assert.equal(g(dir, 'rev-parse', 'HEAD'), g(dir, 'rev-parse', 'main'));

  const r = cp.perform(gen.id, 'redo');
  assert.ok(r.ok, r.message);
  assert.equal(read(dir, 'a.txt').split('\n')[0], 'A1 task');
  assert.equal(read(dir, 'src/new.js'), 'export const x = 1;\n');
  assert.ok(!exists(dir, 'gone.txt'));
  assert.equal(read(dir, 'b.txt'), 'b1 USER EDIT\nb2\n');
});

test('agent checkpoints: one agent is undone alone; another agent and later user edits stay', () => {
  const { dir, id } = makeRepo();
  const gen = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'task' });
  const backend = cp.beginCheckpoint({ repoId: id, kind: 'agent', parentId: gen.id, agentId: 'dev', label: 'backend' });
  write(dir, 'a.txt', read(dir, 'a.txt').replace('a1', 'BACKEND'));
  cp.endCheckpoint(backend.id);
  const frontend = cp.beginCheckpoint({ repoId: id, kind: 'agent', parentId: gen.id, agentId: 'fe', label: 'frontend' });
  write(dir, 'b.txt', 'FRONTEND\nb2\n');
  cp.endCheckpoint(frontend.id);
  cp.endCheckpoint(gen.id);
  write(dir, 'a.txt', read(dir, 'a.txt').replace('a9', 'a9 user later'));   // user edit after, same file, other lines

  const pv = cp.preview(frontend.id, 'undo');
  assert.ok(pv.allowed);
  assert.deepEqual(pv.files.map((f) => f.path), ['b.txt']);
  assert.match(pv.diff, /-FRONTEND/);
  const u = cp.perform(frontend.id, 'undo');
  assert.ok(u.ok, u.message);
  assert.equal(read(dir, 'b.txt'), 'b1\nb2\n');
  assert.match(read(dir, 'a.txt'), /^BACKEND/);
  assert.match(read(dir, 'a.txt'), /a9 user later/);

  // undoing the whole task now only reverts what is still applied (backend)
  const t = cp.perform(gen.id, 'undo');
  assert.ok(t.ok, t.message);
  assert.match(read(dir, 'a.txt'), /^a1/);
  assert.match(read(dir, 'a.txt'), /a9 user later/);
  assert.equal(read(dir, 'b.txt'), 'b1\nb2\n');
  assert.equal(cp.getCheckpoint(backend.id).status, 'undone');
  // agent redo is refused while its task is undone
  assert.equal(cp.preview(backend.id, 'redo').allowed, false);
  const r = cp.perform(gen.id, 'redo');
  assert.ok(r.ok, r.message);
  assert.match(read(dir, 'a.txt'), /^BACKEND/);
  assert.equal(read(dir, 'b.txt'), 'FRONTEND\nb2\n');
});

test('overlapping changes: dependents are reported and a conflicting undo changes nothing', () => {
  const { dir, id } = makeRepo();
  const a = cp.beginCheckpoint({ repoId: id, kind: 'agent', agentId: 'dev', label: 'first' });
  write(dir, 'a.txt', read(dir, 'a.txt').replace('a2', 'DEV'));
  cp.endCheckpoint(a.id);
  const b = cp.beginCheckpoint({ repoId: id, kind: 'agent', agentId: 'fix', label: 'second' });
  write(dir, 'a.txt', read(dir, 'a.txt').replace('DEV', 'DEV+FIX'));
  cp.endCheckpoint(b.id);
  const pv = cp.preview(a.id, 'undo');
  assert.equal(pv.allowed, false);
  assert.ok(pv.check.conflicts.some((c) => c.path === 'a.txt'));
  assert.deepEqual(pv.dependents.map((d) => d.id), [b.id]);
  const before = read(dir, 'a.txt');
  const res = cp.perform(a.id, 'undo');
  assert.equal(res.ok, false);
  assert.equal(read(dir, 'a.txt'), before, 'a refused undo must not change the file');
  // undo in reverse order works
  assert.ok(cp.perform(b.id, 'undo').ok);
  assert.ok(cp.perform(a.id, 'undo').ok);
  assert.match(read(dir, 'a.txt'), /^a1\na2\n/);
});

test('redo conflicts with edits made after the undo are detected', () => {
  const { dir, id } = makeRepo();
  const gen = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'task' });
  write(dir, 'b.txt', 'TASK\nb2\n');
  cp.endCheckpoint(gen.id);
  assert.ok(cp.perform(gen.id, 'undo').ok);
  write(dir, 'b.txt', 'USER REWROTE\nb2\n');
  const r = cp.perform(gen.id, 'redo');
  assert.equal(r.ok, false);
  assert.equal(read(dir, 'b.txt'), 'USER REWROTE\nb2\n');
  assert.equal(cp.getCheckpoint(gen.id).status, 'undone');
});

test('multiple undo/redo across tasks, manual checkpoint restore, compare', () => {
  const { dir, id } = makeRepo();
  const save = cp.manualCheckpoint(id, 'clean start');
  const t1 = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 't1' }); write(dir, 'one.txt', '1\n'); cp.endCheckpoint(t1.id);
  const t2 = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 't2' }); write(dir, 'two.txt', '2\n'); cp.endCheckpoint(t2.id);
  assert.equal(cp.lastUndoable(id).id, t2.id);
  assert.ok(cp.perform(cp.lastUndoable(id).id, 'undo').ok);
  assert.ok(cp.perform(cp.lastUndoable(id).id, 'undo').ok);
  assert.ok(!exists(dir, 'one.txt') && !exists(dir, 'two.txt'));
  assert.equal(cp.lastRedoable(id).id, t1.id);
  assert.ok(cp.perform(cp.lastRedoable(id).id, 'redo').ok);
  assert.ok(exists(dir, 'one.txt') && !exists(dir, 'two.txt'));
  const cmp = cp.compare({ id: save.id, side: 'after' }, { id: t2.id, side: 'after' });
  assert.deepEqual(cmp.files.map((f) => f.path).sort(), ['one.txt', 'two.txt']);
  // restore the manual save point; the replaced state is kept as a checkpoint
  const res = cp.perform(save.id, 'restore');
  assert.ok(res.ok, res.message);
  assert.ok(!exists(dir, 'one.txt'));
  const guard = cp.listCheckpoints({ repoId: id, kind: 'manual' }).find((c) => c.label.startsWith('Before restoring'));
  assert.ok(guard);
  assert.ok(cp.perform(guard.id, 'restore').ok);
  assert.ok(exists(dir, 'one.txt'));
});

test('the office folder is never part of a snapshot, whether or not .gitignore lists it', () => {
  for (const ignored of [true, false]) {
    const { dir, id } = makeRepo();
    if (ignored) { fs.appendFileSync(path.join(dir, '.gitignore'), '.office/\n'); g(dir, 'commit', '-qam', 'ignore office'); }
    write(dir, '.office/handoff/T1.md', 'notes');
    const c = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'office' });
    write(dir, '.office/handoff/T1.md', 'notes changed');
    write(dir, 'real.txt', 'x\n');
    assert.deepEqual(cp.endCheckpoint(c.id).files.map((f) => f.path), ['real.txt'], `ignored=${ignored}`);
  }
});

test('a checkpoint left open by a crash is closed as interrupted and can still be undone', () => {
  const { dir, id } = makeRepo();
  const open = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'crashed' });
  write(dir, 'half.txt', 'partial\n');
  assert.ok(cp.recoverInterruptedCheckpoints() >= 1);
  const c = cp.getCheckpoint(open.id);
  assert.equal(c.status, 'interrupted');
  assert.deepEqual(c.files.map((f) => f.path), ['half.txt']);
  assert.ok(cp.perform(open.id, 'undo').ok);
  assert.ok(!exists(dir, 'half.txt'));
});

test('a file git cannot index (a stray `nul` on Windows) is skipped, not fatal', { skip: process.platform !== 'win32' }, () => {
  const { dir, id } = makeRepo();
  const c = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'nul' });
  const nul = '\\\\?\\' + path.join(dir, 'nul');           // what `cmd > nul` creates under Git Bash
  fs.writeFileSync(nul, 'oops');
  write(dir, 'real.txt', 'x\n');
  const done = cp.endCheckpoint(c.id);
  assert.equal(done.status, 'applied');
  assert.deepEqual(done.files.map((f) => f.path), ['real.txt']);
  fs.rmSync(nul);
});

test('a checkpoint whose after-state cannot be recorded is closed, never left holding the repo', () => {
  const { dir, id } = makeRepo();
  const c = cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'gone' });
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const done = cp.endCheckpoint(c.id);
  assert.equal(done.status, 'interrupted');
  assert.equal(cp.preview(c.id, 'undo').allowed, false);
});

test('live changes are computed without blocking and match the checkpoint snapshot', async () => {
  const { dir } = makeRepo();
  const snap = await import('../src/services/snapshot.ts');
  const base = snap.snapshotTree(dir);
  write(dir, 'a.txt', read(dir, 'a.txt').replace('a2', 'A2\nextra'));
  write(dir, 'src/live.js', 'x\n');
  fs.rmSync(path.join(dir, 'gone.txt'));
  write(dir, '.office/handoff/t.md', 'notes\n');           // the office's own folder is left out
  write(dir, 'mobile/.gradle-user-home/caches/x.bin', 'cache\n'); // untracked tool caches are left out
  write(dir, 'node_modules/pkg/index.js', 'cache\n');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  const live = await snap.liveChanges(dir, base);
  clearInterval(timer);
  assert.ok(ticks > 0, 'the event loop kept running while git worked');
  assert.equal(live.tree, snap.snapshotTree(dir));
  const by = Object.fromEntries(live.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ['a.txt', 'gone.txt', 'src/live.js']);
  assert.equal(by['a.txt'].status, 'M'); assert.equal(by['a.txt'].added, 2); assert.equal(by['a.txt'].removed, 1);
  assert.equal(by['gone.txt'].status, 'D');
  assert.deepEqual((await snap.liveChanges(dir, live.tree)).files, []);
});
