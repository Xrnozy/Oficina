import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { q, q1, run } from '../db.ts';
import { emit, onEvent } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import { commitsBetween, isAncestor } from './commits.ts';

// Watches every registered repository for changes made outside the app — a commit from VS Code or a terminal, a branch
// switch, an amend, a reset, a new or deleted branch — so the repository timeline reflects them within seconds instead of
// only when a task commits. What it saw last is stored per repository (it survives restarts: commits made while the daemon
// was down are found on the next start). Commits themselves are always read from git by the timeline; this service adds the
// events that git history alone cannot show (switches, rewrites, branch changes) and tells the UI when to refresh.

const exec = promisify(execFile);
const POLL_MS = 3000;
const MAX_COMMITS_PER_CHANGE = 50;

interface Seen { head: string | null; branch: string | null; refs: Record<string, string> }

async function git(repo: string, args: string[]): Promise<string | null> {
  try { return (await exec('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(); }
  catch { return null; }
}

async function observe(repo: string): Promise<Seen | null> {
  if ((await git(repo, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return null;
  const head = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
  const branch = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])) || null;
  const refs: Record<string, string> = {};
  for (const line of ((await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'])) ?? '').split('\n')) {
    const i = line.lastIndexOf(' ');
    if (i > 0) refs[line.slice(0, i)] = line.slice(i + 1);
  }
  return { head: head || null, branch, refs };
}

// commits Oficina itself made (task commits, reverts): they are the AI's, not "outside"
const ownCommits = new Set<string>();
let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  onEvent((e) => {
    const sha = (e.payload as Record<string, unknown>).sha ?? (e.payload as Record<string, unknown>).newSha;
    if (typeof sha === 'string' && /^(commit\.(created|reverted|reapplied))$/.test(e.type)) { ownCommits.add(sha); if (ownCommits.size > 500) ownCommits.delete(ownCommits.values().next().value as string); }
  });
}
const isOwn = (sha: string): boolean => ownCommits.has(sha) || !!q1('SELECT 1 FROM repo_checkpoints WHERE commit_sha = ?', sha);

function record(repoId: string, kind: string, f: { sha?: string | null; prev?: string | null; branch?: string | null; subject?: string; author?: string; detail?: Record<string, unknown> }): void {
  run('INSERT INTO repo_activity (id, repo_id, kind, sha, prev_sha, branch, subject, author, detail, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ulid(), repoId, kind, f.sha ?? null, f.prev ?? null, f.branch ?? null, f.subject ?? '', f.author ?? '', JSON.stringify(f.detail ?? {}), now());
}

const inflight = new Set<string>();

/** Compare a repository with what was seen last time and record/emit whatever changed. Returns true if something did. */
export async function checkRepo(repoId: string): Promise<boolean> {
  if (inflight.has(repoId)) return false;
  const row = q1('SELECT id, path FROM repos WHERE id = ?', repoId);
  if (!row) return false;
  inflight.add(repoId);
  try {
    hook();
    const repo = row.path as string;
    const cur = await observe(repo);
    if (!cur) return false;
    const stored = q1('SELECT * FROM repo_watch WHERE repo_id = ?', repoId);
    const save = () => run('INSERT INTO repo_watch (repo_id, head, branch, refs, seen_at) VALUES (?,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET head = excluded.head, branch = excluded.branch, refs = excluded.refs, seen_at = excluded.seen_at',
      repoId, cur.head, cur.branch, JSON.stringify(cur.refs), now());
    if (!stored) { save(); return false; }                       // first sight: nothing to compare with
    const prev: Seen = { head: (stored.head as string) ?? null, branch: (stored.branch as string) ?? null, refs: parseJson(stored.refs as string, {}) };
    const same = prev.head === cur.head && prev.branch === cur.branch && JSON.stringify(prev.refs) === JSON.stringify(cur.refs);
    if (same) return false;

    const kinds: string[] = [];
    if (prev.branch !== cur.branch) {
      record(repoId, 'branch-switch', { sha: cur.head, prev: prev.head, branch: cur.branch, subject: `Switched from ${prev.branch ?? 'a detached HEAD'} to ${cur.branch ?? 'a detached HEAD'}`, detail: { from: prev.branch, to: cur.branch } });
      kinds.push('branch-switch');
    } else if (prev.head && cur.head && prev.head !== cur.head) {
      if (isAncestor(repo, prev.head, cur.head)) {
        const fresh = commitsBetween(repo, prev.head, cur.head, MAX_COMMITS_PER_CHANGE);
        const outside = fresh.filter((c) => !isOwn(c.sha));
        for (const c of outside.slice(-5)) emit('repo.commit.external', 'git', { repoId, sha: c.sha, subject: c.subject, author: c.author, branch: cur.branch }, null, c.sha);
        if (outside.length) kinds.push('commit-external');
        if (fresh.length > outside.length) kinds.push('commit');
      } else {
        // HEAD moved to something that does not contain the old HEAD: an amend, a reset, a rebase
        record(repoId, 'history-rewritten', { sha: cur.head, prev: prev.head, branch: cur.branch, subject: 'History was rewritten (amend, reset or rebase)', detail: { from: prev.head, to: cur.head } });
        kinds.push('history-rewritten');
      }
    } else if (!prev.head && cur.head) { kinds.push('commit-external'); }
    // other branches and tags
    for (const [ref, oid] of Object.entries(cur.refs)) {
      const name = ref.replace(/^refs\/(heads|tags)\//, '');
      const isTag = ref.startsWith('refs/tags/');
      if (!(ref in prev.refs)) { record(repoId, isTag ? 'tag-created' : 'branch-created', { sha: oid, branch: name, subject: `${isTag ? 'Tag' : 'Branch'} ${name} created`, detail: { ref } }); kinds.push('refs'); }
      else if (prev.refs[ref] !== oid && ref !== `refs/heads/${cur.branch}` && !isTag) {
        const ahead = isAncestor(repo, prev.refs[ref], oid);
        record(repoId, 'branch-moved', { sha: oid, prev: prev.refs[ref], branch: name, subject: `${name} ${ahead ? 'advanced' : 'was rewritten'}`, detail: { ref, fastForward: ahead } });
        kinds.push('refs');
      }
    }
    for (const ref of Object.keys(prev.refs)) {
      if (!(ref in cur.refs)) { const name = ref.replace(/^refs\/(heads|tags)\//, ''); record(repoId, ref.startsWith('refs/tags/') ? 'tag-deleted' : 'branch-deleted', { prev: prev.refs[ref], branch: name, subject: `${name} deleted`, detail: { ref } }); kinds.push('refs'); }
    }
    save();
    emit('repo.changed', 'git', { repoId, kinds: [...new Set(kinds)], head: cur.head, branch: cur.branch }, null, repoId);
    return true;
  } finally { inflight.delete(repoId); }
}

/** Activity rows (switches, rewrites, branch and tag changes) for the timeline, newest first. */
export function listActivity(repoId: string, before: string, limit: number): Record<string, unknown>[] {
  return q('SELECT * FROM repo_activity WHERE repo_id = ? AND at < ? ORDER BY at DESC LIMIT ?', repoId, before, limit)
    .map((r) => ({ ...r, detail: parseJson(r.detail as string, {}) }));
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startRepoWatcher(): void {
  if (timer) return;
  const tick = () => { for (const r of q('SELECT id FROM repos')) void checkRepo(r.id as string).catch(() => undefined); };
  tick();
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
}
export function stopRepoWatcher(): void { if (timer) clearInterval(timer); timer = null; }
