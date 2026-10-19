// Undo / redo / restore under awkward conditions: missing and emptied folders, later edits that overlap or merely sit nearby,
// partial undo, a write that fails halfway, restores over edited files, and the snapshot recorded when a checkpoint is created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cprobust-data-'));
const { run } = await import('../src/db.ts');
const cp = await import('../src/services/checkpoints.ts');
const { applyPlan, planTransition } = await import('../src/services/apply-tree.ts');
const snap = await import('../src/services/snapshot.ts');

const g = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let n = 0;
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-cprobust-repo-'));
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 't@t'); g(dir, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'lib', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: 12 }, (_, i) => `a${i + 1}`).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b1\nb2\n');
  fs.writeFileSync(path.join(dir, 'lib', 'keep.txt'), 'keep\n');
  fs.writeFileSync(path.join(dir, 'lib', 'deep', 'old.txt'), 'old\n');
  fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
  g(dir, 'add', '-A'); g(dir, 'commit', '-m', 'init');
  const id = `repo-r${++n}`;
  run('INSERT INTO repos (id, workspace_id, path, default_branch, integration_branch) VALUES (?,?,?,?,?)', id, 'ws', dir, 'main', 'main');
  return { dir, id };
}
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const exists = (dir, f) => fs.existsSync(path.join(dir, f));
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const task = (id, label, fn) => { const c = cp.beginCheckpoint({ repoId: id, kind: 'general', label }); fn(); return cp.endCheckpoint(c.id); };

test('undoing a task removes the folders it created, but never a folder that still holds something', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'new dirs', () => {
    write(dir, 'src/features/login/form.js', 'form\n');
    write(dir, 'src/features/login/style.css', 'css\n');
    write(dir, 'src/readme.md', 'kept by the user\n');
    write(dir, 'lib/deep/new.txt', 'new\n');
  });
  write(dir, 'src/features/mine.txt', 'my own file in a folder the task created\n');
  const u = cp.perform(t.id, 'undo');
  assert.ok(u.ok, u.message);
  assert.ok(!exists(dir, 'src/features/login'), 'the emptied folder is gone');
  assert.ok(!exists(dir, 'lib/deep/new.txt'));
  assert.equal(read(dir, 'src/features/mine.txt'), 'my own file in a folder the task created\n', "the user's file and its folder stay");
  assert.ok(exists(dir, 'src/features'));
  assert.ok(exists(dir, 'lib/deep/old.txt'), 'an existing folder keeps its other files');
});

test('missing directories are created again: undo of a delete after the folder was removed, and redo after the folder was removed', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'delete + add', () => {
    fs.rmSync(path.join(dir, 'lib', 'deep', 'old.txt'));
    write(dir, 'gen/out/result.json', '{}\n');
  });
  fs.rmSync(path.join(dir, 'lib', 'deep'), { recursive: true });     // the whole folder is gone now
  const u = cp.perform(t.id, 'undo');
  assert.ok(u.ok, u.message);
  assert.equal(read(dir, 'lib/deep/old.txt'), 'old\n', 'folder and file are back');
  assert.ok(!exists(dir, 'gen'));
  fs.rmSync(path.join(dir, 'gen'), { recursive: true, force: true });
  const r = cp.perform(t.id, 'redo');
  assert.ok(r.ok, r.message);
  assert.equal(read(dir, 'gen/out/result.json'), '{}\n');
  assert.ok(!exists(dir, 'lib/deep/old.txt'));
  assert.ok(!exists(dir, 'lib/deep'), 'the emptied folder is removed again');
});

test('a later edit near (not on) the task\'s lines is merged instead of blocking the undo', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'edit a3', () => write(dir, 'a.txt', read(dir, 'a.txt').replace('a3', 'TASK a3')));
  write(dir, 'a.txt', read(dir, 'a.txt').replace('a6', 'USER a6'));   // close enough that a plain patch would not apply
  const pv = cp.preview(t.id, 'undo');
  assert.equal(pv.allowed, true);
  assert.equal(pv.plan.find((p) => p.path === 'a.txt').state, 'merge');
  const u = cp.perform(t.id, 'undo');
  assert.ok(u.ok, u.message);
  assert.match(u.message, /merged/);
  const text = read(dir, 'a.txt');
  assert.match(text, /^a1\na2\na3\n/);
  assert.match(text, /USER a6/);
  assert.doesNotMatch(text, /TASK/);
  assert.equal(cp.getCheckpoint(t.id).status, 'undone');
});

test('overlapping edits: the full undo is refused and changes nothing; a partial undo does the safe files and says what it left', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'two files', () => {
    write(dir, 'a.txt', read(dir, 'a.txt').replace('a3', 'TASK a3'));
    write(dir, 'b.txt', 'TASK b1\nb2\n');
    write(dir, 'new.txt', 'new\n');
  });
  write(dir, 'a.txt', read(dir, 'a.txt').replace('TASK a3', 'USER REWROTE a3'));   // same line
  const before = { a: read(dir, 'a.txt'), b: read(dir, 'b.txt') };
  const pv = cp.preview(t.id, 'undo');
  assert.equal(pv.allowed, false);
  assert.equal(pv.partialAllowed, true);
  assert.deepEqual(pv.check.conflicts.map((c) => c.path), ['a.txt']);
  assert.match(pv.check.conflicts[0].reason, /same place/);
  const refused = cp.perform(t.id, 'undo');
  assert.equal(refused.ok, false);
  assert.equal(read(dir, 'a.txt'), before.a);
  assert.equal(read(dir, 'b.txt'), before.b, 'a refused undo touches no file at all');
  assert.ok(exists(dir, 'new.txt'));

  const part = cp.perform(t.id, 'undo', 'owner', { partial: true });
  assert.ok(part.ok, part.message);
  assert.equal(part.partial, true);
  assert.deepEqual(part.skipped.map((s) => s.path), ['a.txt']);
  assert.equal(read(dir, 'b.txt'), 'b1\nb2\n');
  assert.ok(!exists(dir, 'new.txt'));
  assert.equal(read(dir, 'a.txt'), before.a, 'the conflicting file is left exactly as it was');
  assert.equal(cp.getCheckpoint(t.id).status, 'applied', 'not marked undone: one file is still outstanding');

  // once the owner fixes the last file by hand, the undo completes (already-done files are recognised)
  write(dir, 'a.txt', read(dir, 'a.txt').replace('USER REWROTE a3', 'a3'));
  const done = cp.perform(t.id, 'undo');
  assert.ok(done.ok, done.message);
  assert.equal(cp.getCheckpoint(t.id).status, 'undone');
});

test('files the user deleted or rewrote as binary are conflicts, not silent overwrites', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'touch', () => { write(dir, 'b.txt', 'TASK\nb2\n'); fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([9, 9, 9, 0, 9])); });
  fs.rmSync(path.join(dir, 'b.txt'));                                         // the user removed a file the task edited
  fs.writeFileSync(path.join(dir, 'logo.bin'), Buffer.from([7, 0, 7, 0, 7])); // and changed the binary
  const pv = cp.preview(t.id, 'undo');
  assert.equal(pv.allowed, false);
  assert.deepEqual(pv.check.conflicts.map((c) => c.path).sort(), ['b.txt', 'logo.bin']);
  assert.match(pv.check.conflicts.find((c) => c.path === 'b.txt').reason, /deleted/);
  assert.match(pv.check.conflicts.find((c) => c.path === 'logo.bin').reason, /binary/);
  assert.equal(cp.perform(t.id, 'undo').ok, false);
});

test('a write that fails halfway puts every file back', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'two', () => { write(dir, 'a.txt', read(dir, 'a.txt').replace('a1', 'TASK a1')); write(dir, 'b.txt', 'TASK b\nb2\n'); });
  const tp = planTransition(dir, cp.getCheckpoint(t.id).afterTree, cp.getCheckpoint(t.id).beforeTree);
  assert.equal(tp.changing.length, 2);
  // sabotage the second file's temporary name: the write throws after the first file was already replaced
  const second = tp.changing[1].path;
  fs.mkdirSync(path.join(dir, `${second}.oficina-tmp`));
  const snapshotBefore = snap.snapshotTree(dir);
  const res = applyPlan(dir, tp);
  assert.equal(res.ok, false);
  assert.match(res.message, /put back/);
  fs.rmSync(path.join(dir, `${second}.oficina-tmp`), { recursive: true });
  assert.equal(snap.snapshotTree(dir), snapshotBefore, 'the tree is byte-for-byte what it was');
});

test('restore replaces edited and deleted files, recreates missing folders, and its guard checkpoint brings everything back', () => {
  const { dir, id } = makeRepo();
  const save = cp.manualCheckpoint(id, 'known good');
  write(dir, 'a.txt', 'COMPLETELY DIFFERENT\n');
  write(dir, 'junk/tmp/x.txt', 'junk\n');
  fs.rmSync(path.join(dir, 'lib'), { recursive: true });
  const pv = cp.preview(save.id, 'restore');
  assert.equal(pv.allowed, true);
  const states = Object.fromEntries(pv.plan.map((p) => [p.path, p.state]));
  assert.equal(states['a.txt'], 'clean', 'restore starts from the live tree, so every difference is simply replaced');
  assert.equal(states['lib/keep.txt'], 'clean');
  const r = cp.perform(save.id, 'restore');
  assert.ok(r.ok, r.message);
  assert.match(read(dir, 'a.txt'), /^a1\n/);
  assert.equal(read(dir, 'lib/deep/old.txt'), 'old\n');
  assert.ok(!exists(dir, 'junk'), 'files that did not exist in the saved state are removed with their folders');
  assert.equal(snap.snapshotTree(dir), save.afterTree, 'the working tree equals the saved state exactly');
  const guard = cp.listCheckpoints({ repoId: id, kind: 'manual' }).find((c) => c.label.startsWith('Before restoring'));
  assert.ok(cp.perform(guard.id, 'restore').ok);
  assert.equal(read(dir, 'a.txt'), 'COMPLETELY DIFFERENT\n');
  assert.equal(read(dir, 'junk/tmp/x.txt'), 'junk\n');
  assert.ok(!exists(dir, 'lib'));
});

test('a file where a folder is needed is reported, not clobbered', () => {
  const { dir, id } = makeRepo();
  const t = task(id, 'add folder', () => write(dir, 'tools/run.js', 'run\n'));
  cp.perform(t.id, 'undo');
  fs.writeFileSync(path.join(dir, 'tools'), 'I am a file now\n');
  const pv = cp.preview(t.id, 'redo');
  assert.equal(pv.allowed, false);
  assert.match(pv.check.conflicts[0].reason, /in the way/);
  assert.equal(read(dir, 'tools'), 'I am a file now\n');
});

test('every snapshot is verified and records what it was taken against', () => {
  const { dir, id } = makeRepo();
  write(dir, 'untracked.txt', 'u\n');
  fs.writeFileSync(path.join(dir, 'huge.dat'), Buffer.alloc(snap.MAX_SNAPSHOT_FILE + 1024, 1));   // too large to keep: reported, not silently dropped
  const c = cp.beginCheckpoint({ repoId: id, kind: 'manual', label: 'meta' });
  assert.equal(c.branch, 'main');
  assert.equal(c.headSha, g(dir, 'rev-parse', 'HEAD').trim());
  assert.ok(c.fileCount >= 6, `file count ${c.fileCount}`);
  assert.deepEqual(c.skipped, ['huge.dat']);
  assert.equal(g(dir, 'rev-parse', `refs/officechain/cp/${c.id}/before^{tree}`).trim(), c.beforeTree, 'the pinned ref resolves to the recorded tree');
  assert.equal(g(dir, 'cat-file', '-t', c.beforeTree).trim(), 'tree');
  const done = cp.endCheckpoint(c.id);
  assert.equal(g(dir, 'rev-parse', `refs/officechain/cp/${c.id}/after^{tree}`).trim(), done.afterTree);
  // the snapshot survives garbage collection
  g(dir, 'gc', '--prune=now', '-q');
  assert.equal(g(dir, 'cat-file', '-t', c.beforeTree).trim(), 'tree');
});

test('a snapshot that cannot be proven readable is refused rather than trusted', () => {
  const { dir, id } = makeRepo();
  fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  assert.throws(() => cp.beginCheckpoint({ repoId: id, kind: 'general', label: 'no git' }), /reliable snapshot/);
});
