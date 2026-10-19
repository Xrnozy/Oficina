// Task commits must contain exactly the task's files, never the user's other
// work; reverts are checked patches + normal commits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { snapshotTree } from '../src/services/snapshot.ts';
import { buildCommitMessage, commitPaths, dirtyPaths, gitLog, planTaskCommit, revertCommit } from '../src/services/commits.ts';

const g = (repo, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function makeRepo(subjects = ['feat: init', 'fix(core): handle empty input', 'docs: readme']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-commit-'));
  g(dir, 'init', '-b', 'main'); g(dir, 'config', 'user.email', 'me@example.com'); g(dir, 'config', 'user.name', 'Me');
  for (const [i, s] of subjects.entries()) { fs.writeFileSync(path.join(dir, `f${i}.txt`), `${i}\n`); g(dir, 'add', '-A'); g(dir, 'commit', '-m', s); }
  return dir;
}
const write = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

test('a task commit includes only the task files; user edits stay uncommitted and staged work stays staged', () => {
  const dir = makeRepo();
  write(dir, 'user.txt', 'user wip\n');                  // untracked user file
  write(dir, 'f0.txt', 'user edit\n'); g(dir, 'add', 'f0.txt');   // staged user change
  const before = snapshotTree(dir);
  write(dir, 'src/feature/a.js', 'export const a = 1;\n');
  write(dir, 'f1.txt', 'task\n');
  const after = snapshotTree(dir);
  const plan = planTaskCommit(dir, before, after);
  assert.ok(plan.ok, plan.reason);
  assert.deepEqual(plan.paths.sort(), ['f1.txt', 'src/feature/a.js']);
  const c = commitPaths(dir, plan.paths, 'feat(feature): add a\n\n- Add src/feature/a.js');
  assert.ok(c.ok, c.error);
  assert.deepEqual(g(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort(), ['f1.txt', 'src/feature/a.js']);
  assert.equal(g(dir, 'log', '-1', '--format=%an <%ae>'), 'Me <me@example.com>\n');
  assert.deepEqual(dirtyPaths(dir).sort(), ['f0.txt', 'user.txt']);
  assert.match(g(dir, 'status', '--porcelain'), /^M  f0\.txt/m, 'the staged user change is still staged');
});

test('committing with no task paths is refused and stages nothing', () => {
  const dir = makeRepo();
  write(dir, 'user.txt', 'user wip');
  const r = commitPaths(dir, [], 'feat: nothing');
  assert.equal(r.ok, false);
  assert.equal(g(dir, 'diff', '--cached', '--name-only'), '');
  assert.equal(commitPaths(dir, ['.'], 'x').ok, false);
});

test('a task that touched a file the user had already modified is not committed silently', () => {
  const dir = makeRepo();
  write(dir, 'f1.txt', 'user line\n');
  const before = snapshotTree(dir);
  write(dir, 'f1.txt', 'user line\ntask line\n');
  const plan = planTaskCommit(dir, before, snapshotTree(dir));
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.mixed, ['f1.txt']);
});

test('edits made after the task finished block the commit', () => {
  const dir = makeRepo();
  const before = snapshotTree(dir);
  write(dir, 'n.txt', 'task\n');
  const after = snapshotTree(dir);
  write(dir, 'n.txt', 'task + later edit\n');
  const plan = planTaskCommit(dir, before, after);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.changedSince, ['n.txt']);
});

test('revert and reapply are new commits; conflicts change nothing', () => {
  const dir = makeRepo();
  write(dir, 'x.txt', 'one\ntwo\n'); g(dir, 'add', '-A'); g(dir, 'commit', '-m', 'feat: add x');
  const sha = g(dir, 'rev-parse', 'HEAD').trim();
  const r = revertCommit(dir, sha);
  assert.ok(r.ok, r.message);
  assert.ok(!fs.existsSync(path.join(dir, 'x.txt')));
  assert.match(g(dir, 'log', '-1', '--format=%s'), /^Revert "feat: add x"/);
  const again = revertCommit(dir, sha, true);
  assert.ok(again.ok, again.message);
  assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'one\ntwo\n');
  // the file changes in a way that overlaps → refused, untouched
  write(dir, 'x.txt', 'ONE\ntwo\n'); g(dir, 'commit', '-am', 'fix: capitalise');
  const blocked = revertCommit(dir, sha);
  assert.equal(blocked.ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'x.txt'), 'utf8'), 'ONE\ntwo\n');
  assert.equal(gitLog(dir).length, 7);
});

test('commit messages: specific, convention-aware, and honest about verification', () => {
  const conv = makeRepo();
  const files = [{ status: 'M', path: 'src/navigation/guide.ts' }, { status: 'A', path: 'src/navigation/guide.test.ts' }];
  const m = buildCommitMessage({ repo: conv, taskType: 'bugfix', taskTitle: 'Prevent stale obstacle data from triggering outdated guidance', files, proposed: { title: 'fix' }, evidence: { checks: [{ name: 'unit', status: 'fail' }], qa: null } });
  assert.equal(m.title, 'fix(navigation): prevent stale obstacle data from triggering outdated guidance');
  assert.match(m.message, /NOT VERIFIED/);
  assert.match(m.message, /Checks: unit fail/);
  const good = buildCommitMessage({ repo: conv, taskType: 'feature', taskTitle: 't', files, proposed: { title: 'feat(nav): reject observations older than the freshness limit', body: '- Reject stale frames' }, evidence: { checks: [{ name: 'unit', status: 'pass' }], qa: 'pass' } });
  assert.equal(good.title, 'feat(nav): reject observations older than the freshness limit');
  assert.doesNotMatch(good.message, /NOT VERIFIED/);
  const plain = makeRepo(['Initial import', 'Add parser', 'Handle empty lines']);
  const p = buildCommitMessage({ repo: plain, taskType: 'feature', taskTitle: 'add a table of contents flag', files, evidence: { checks: [] } });
  assert.equal(p.title, 'Add a table of contents flag');
  assert.match(p.message, /Checks: none run/);
});

test('history is paginated', () => {
  const dir = makeRepo(Array.from({ length: 12 }, (_, i) => `feat: step ${i}`));
  const page1 = gitLog(dir, { limit: 5 });
  const page2 = gitLog(dir, { limit: 5, skip: 5 });
  assert.equal(page1.length, 5);
  assert.equal(page1[0].subject, 'feat: step 11');
  assert.equal(page2[0].subject, 'feat: step 6');
});
