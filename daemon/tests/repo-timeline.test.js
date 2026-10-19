// The repository timeline follows the repository itself: commits made in VS Code or a terminal show up (and are announced)
// within a poll, branch switches / amends / resets / branch changes are recorded, and Oficina's own commits stay labelled as the AI's.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tl-data-'));
const { q, q1, run } = await import('../src/db.ts');
const { onEvent, emit } = await import('../src/bus.ts');
const W = await import('../src/services/repo-watch.ts');
const { createServer } = await import('../src/api/server.ts');

const g = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let n = 0;
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tl-repo-'));
  g(dir, 'init', '-b', 'main');
  g(dir, 'config', 'user.email', 'dev@example.com'); g(dir, 'config', 'user.name', 'Dev In VSCode');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g(dir, 'add', '-A'); g(dir, 'commit', '-m', 'initial commit');
  const id = `repo-tl${++n}`;
  run('INSERT INTO repos (id, workspace_id, path, default_branch, integration_branch) VALUES (?,?,?,?,?)', id, 'ws', dir, 'main', 'main');
  return { dir, id };
}
const commit = (dir, file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); g(dir, 'add', '-A'); g(dir, 'commit', '-m', msg); return g(dir, 'rev-parse', 'HEAD'); };
const events = [];
onEvent((e) => { if (e.type.startsWith('repo.')) events.push(e); });
const take = (type) => { const hit = events.filter((e) => e.type === type); events.length = 0; return hit; };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('first sight stores the repository state without inventing history', async () => {
  const { id } = makeRepo();
  assert.equal(await W.checkRepo(id), false);
  assert.equal(await W.checkRepo(id), false, 'nothing changed');
  assert.equal(W.listActivity(id, '9999', 50).length, 0);
});

test('a commit made outside the app is detected and announced; an Oficina commit is not', async () => {
  const { dir, id } = makeRepo();
  await W.checkRepo(id);
  take('repo.commit.external');
  const sha = commit(dir, 'b.txt', 'two\n', 'feat: added in VS Code');
  assert.equal(await W.checkRepo(id), true);
  const ext = take('repo.commit.external');
  assert.equal(ext.length, 1);
  assert.equal(ext[0].payload.sha, sha);
  assert.equal(ext[0].payload.subject, 'feat: added in VS Code');
  assert.equal(ext[0].payload.author, 'Dev In VSCode');
  assert.equal(ext[0].payload.branch, 'main');

  // the engine's own commit (it announces itself with commit.created) is the AI's, not "outside"
  const own = commit(dir, 'c.txt', 'three\n', 'feat: made by the office');
  emit('commit.created', 'engine', { sha: own, title: 'feat: made by the office' }, null, 'x');
  assert.equal(await W.checkRepo(id), true);
  assert.equal(take('repo.commit.external').length, 0);
});

test('several commits made while the daemon was not watching are all found on the next check', async () => {
  const { dir, id } = makeRepo();
  await W.checkRepo(id);
  take('repo.commit.external');
  for (let i = 1; i <= 3; i++) commit(dir, `f${i}.txt`, `${i}\n`, `commit ${i}`);
  await W.checkRepo(id);
  assert.deepEqual(take('repo.commit.external').map((e) => e.payload.subject), ['commit 1', 'commit 2', 'commit 3']);
});

test('branch switches, amends and resets, and branch changes are recorded as activity', async () => {
  const { dir, id } = makeRepo();
  await W.checkRepo(id);
  g(dir, 'switch', '-c', 'feature/login');
  await W.checkRepo(id);
  commit(dir, 'login.txt', 'x\n', 'login form');
  await W.checkRepo(id);
  g(dir, 'switch', 'main');
  await W.checkRepo(id);
  g(dir, 'commit', '--amend', '-m', 'initial commit (reworded)');
  await W.checkRepo(id);
  g(dir, 'branch', '-D', 'feature/login');
  g(dir, 'tag', 'v1');
  await W.checkRepo(id);
  const kinds = W.listActivity(id, '9999', 50).map((a) => a.kind);
  for (const k of ['branch-created', 'branch-switch', 'history-rewritten', 'branch-deleted', 'tag-created']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`);
  const sw = W.listActivity(id, '9999', 50).filter((a) => a.kind === 'branch-switch').map((a) => a.detail);
  assert.deepEqual(sw.map((d) => `${d.from}>${d.to}`).sort(), ['feature/login>main', 'main>feature/login']);
  assert.ok(take('repo.changed').length >= 4, 'each change tells the UI to refresh');
});

test('the timeline endpoint shows commits from any tool at once, with origin, branches, stats and the live working state', async () => {
  const { dir, id } = makeRepo();
  const aiSha = commit(dir, 'ai.txt', 'ai\n', 'feat: by an agent');
  run(`INSERT INTO repo_checkpoints (id, repo_id, kind, label, before_tree, status, created_at, commit_sha) VALUES ('cp-ai', ?, 'general', 'agent task', 'x', 'applied', ?, ?)`, id, new Date().toISOString(), aiSha);
  const port = await freePort();
  const server = createServer(port, os.tmpdir());
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try {
    const get = async (qs = '') => (await fetch(`http://127.0.0.1:${port}/api/repos/${id}/timeline?${qs}`)).json();
    await get();                                           // first sight
    const vs = commit(dir, 'vs.txt', 'one\ntwo\nthree\n', 'fix: typo found in VS Code');   // made behind the app's back
    g(dir, 'switch', '-c', 'feature/x');
    commit(dir, 'x.txt', 'x\n', 'feature work');
    g(dir, 'switch', 'main');
    fs.writeFileSync(path.join(dir, 'dirty.txt'), 'uncommitted\n');
    const t = await get();
    const byTitle = Object.fromEntries(t.entries.filter((e) => e.type === 'commit').map((e) => [e.title, e]));
    assert.equal(byTitle['fix: typo found in VS Code'].sha, vs);
    assert.equal(byTitle['fix: typo found in VS Code'].origin, 'user');
    assert.equal(byTitle['fix: typo found in VS Code'].author, 'Dev In VSCode');
    assert.deepEqual(byTitle['fix: typo found in VS Code'].stat, { files: 1, added: 3, removed: 0 });
    assert.equal(byTitle['feat: by an agent'].origin, 'ai');
    assert.ok(byTitle['feat: by an agent'].checkpointId);
    assert.ok(byTitle['feature work'], 'commits on other branches are in the timeline too');
    assert.ok(byTitle['feature work'].branches.includes('feature/x'));
    assert.ok(byTitle['fix: typo found in VS Code'].head === false || byTitle['fix: typo found in VS Code'].branches.includes('main'));
    assert.ok(t.entries.some((e) => e.type === 'activity' && e.activity === 'branch-created' && e.branch === 'feature/x'));
    assert.equal(t.working.branch, 'main');
    assert.equal(t.working.dirty.count, 1);
    assert.deepEqual(t.working.dirty.files, ['dirty.txt']);
    assert.equal(t.working.head.subject, 'fix: typo found in VS Code');
    // filters
    assert.ok((await get('kinds=commit')).entries.every((e) => e.type === 'commit'));
    assert.deepEqual((await get('kinds=commit&q=typo')).entries.map((e) => e.title), ['fix: typo found in VS Code']);
    assert.ok((await get('kinds=commit&author=VSCode')).entries.length >= 3);
    assert.equal((await get('kinds=commit&author=nobody-here')).entries.length, 0);
    // entries are newest first and paging by the cursor repeats and skips nothing
    const p1 = await get('kinds=commit&limit=2');
    assert.equal(p1.entries.length, 2);
    assert.ok(p1.next);
    const p2 = await get(`kinds=commit&limit=50&before=${encodeURIComponent(p1.next)}`);
    const all = new Set([...p1.entries, ...p2.entries].map((e) => e.sha));
    assert.equal(all.size, p1.entries.length + p2.entries.length, 'no commit appears twice');
  } finally { server.close(); }
});
