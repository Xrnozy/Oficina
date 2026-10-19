import { execFileSync } from 'node:child_process';
import { RAW, applyPatch, changedFilesBetween, checkPatch, ownPaths, patchBetween, snapshotTree, type FileChange } from './snapshot.ts';

// Task commits on the user's own branch. Only the task's files are committed
// (`git commit --only -- <paths>`, so hooks, signing and the repo's identity
// apply and anything else the user has staged stays staged); a path the user
// had already modified before the task started is never committed silently.
// Reverts are applied as a checked patch plus a normal commit — no
// `git reset`, no history rewrite, no force-push.

function git(repo: string, args: string[], input?: string): string {
  return execFileSync('git', [...RAW, '-C', repo, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
function tryGit(repo: string, args: string[], input?: string): { ok: boolean; out: string; err: string } {
  try { return { ok: true, out: git(repo, args, input), err: '' }; }
  catch (e: any) { return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) }; }
}

export function currentBranch(repo: string): string | null {
  const r = tryGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.ok ? r.out.trim() || null : null;
}

/** Paths (excluding the office's own files) that differ from HEAD right now. */
export function dirtyPaths(repo: string): string[] {
  const r = tryGit(repo, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '.', ...ownPaths(repo).map((p) => `:(exclude,literal)${p}`)]);
  if (!r.ok) return [];
  const parts = r.out.split('\0').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    out.push(p.slice(3));
    if (p[0] === 'R' || p[0] === 'C') i++; // rename source follows
  }
  return out;
}

// ------------------------------------------------------------ messages

const TYPE_FOR: Record<string, string> = { feature: 'feat', bugfix: 'fix', refactor: 'refactor', infra: 'build', test: 'test', docs: 'docs' };
const GENERIC = /^(update|updates|fix|fixes|changes?|wip|misc|ai( modifications?)?|modifications?|edit|edits|commit|work|stuff)\.?$/i;

/** Does the repo's recent history use Conventional Commits? */
export function usesConventional(repo: string): boolean {
  const r = tryGit(repo, ['log', '-n', '30', '--format=%s']);
  const subjects = r.ok ? r.out.split('\n').filter(Boolean) : [];
  if (subjects.length < 3) return true;
  const conv = subjects.filter((s) => /^[a-z]+(\([^)]+\))?!?: \S/.test(s)).length;
  return conv / subjects.length >= 0.4;
}

function scopeOf(files: string[]): string | null {
  const dirs = files.map((f) => f.split('/')).filter((p) => p.length > 1).map((p) => p[0] === 'src' && p.length > 2 ? p[1] : p[0]);
  if (!dirs.length || dirs.length < files.length * 0.6) return null;
  const top = dirs.sort((a, b) => dirs.filter((x) => x === b).length - dirs.filter((x) => x === a).length)[0];
  return top.replace(/[^a-z0-9-]/gi, '').toLowerCase() || null;
}

export interface CommitEvidence { checks: { name: string; status: string }[]; qa?: 'pass' | 'fail' | null }

/**
 * Build the commit message: a proposed title/body (from the developer's notes
 * or the PM) when it is specific, otherwise one derived from the task; then a
 * trailer stating only the verification that actually happened.
 */
export function buildCommitMessage(opts: {
  repo: string; taskType: string; taskTitle: string; files: FileChange[];
  proposed?: { title?: string; body?: string } | null; evidence: CommitEvidence;
}): { title: string; body: string; message: string } {
  const conventional = usesConventional(opts.repo);
  const paths = opts.files.map((f) => f.path);
  let title = (opts.proposed?.title ?? '').split('\n')[0].trim().replace(/\.$/, '');
  const bare = title.replace(/^[a-z]+(\([^)]+\))?!?:\s*/, '');
  if (!title || GENERIC.test(bare) || bare.split(/\s+/).length < 3) {
    const subject = opts.taskTitle.trim().replace(/\.$/, '');
    const lead = subject.charAt(0).toLowerCase() + subject.slice(1);
    const type = TYPE_FOR[opts.taskType] ?? 'chore';
    const scope = scopeOf(paths);
    title = conventional ? `${type}${scope ? `(${scope})` : ''}: ${lead}` : subject.charAt(0).toUpperCase() + subject.slice(1);
  } else if (!conventional) {
    title = bare.charAt(0).toUpperCase() + bare.slice(1);
  }
  if (title.length > 100) title = title.slice(0, 100).replace(/\s+\S*$/, '');  // keep whole words
  const verb: Record<string, string> = { A: 'Add', M: 'Update', D: 'Remove', R: 'Rename', C: 'Copy', T: 'Change type of' };
  let body = (opts.proposed?.body ?? '').trim();
  if (!body) {
    body = opts.files.slice(0, 12).map((f) => `- ${verb[f.status] ?? 'Update'} ${f.from ? `${f.from} → ${f.path}` : f.path}`).join('\n');
    if (opts.files.length > 12) body += `\n- …and ${opts.files.length - 12} more file(s)`;
  }
  // verification trailer: facts only
  const ran = opts.evidence.checks;
  const failed = ran.filter((c) => c.status !== 'pass');
  const verify = [
    ran.length ? `Checks: ${ran.map((c) => `${c.name} ${c.status}`).join(', ')}` : 'Checks: none run',
    opts.evidence.qa ? `Review/QA: ${opts.evidence.qa}` : null,
    failed.length ? 'NOT VERIFIED: some checks did not pass.' : null,
  ].filter(Boolean).join('\n');
  const message = `${title}\n\n${body}\n\n${verify}`;
  return { title, body, message };
}

// ------------------------------------------------------------ committing

export interface CommitPlan {
  ok: boolean; paths: string[]; files: FileChange[];
  mixed: string[];        // paths the user had changed before the task — need the owner's decision
  changedSince: string[]; // paths edited after the task finished — content differs from the task result
  reason?: string;
}

/** Which paths a task commit would include, and whether that is safe. */
export function planTaskCommit(repo: string, beforeTree: string, afterTree: string): CommitPlan {
  const files = changedFilesBetween(repo, beforeTree, afterTree);
  const paths = [...new Set(files.flatMap((f) => [f.path, f.from].filter(Boolean) as string[]))].filter((p) => !p.startsWith('.office/'));
  if (!paths.length) return { ok: false, paths, files, mixed: [], changedSince: [], reason: 'the task changed no files' };
  const head = tryGit(repo, ['rev-parse', '--verify', 'HEAD']).out.trim();
  // user's own uncommitted changes in these files when the task started
  const mixed = head ? changedFilesBetween(repo, head, beforeTree).map((f) => f.path).filter((p) => paths.includes(p)) : [];
  const now = snapshotTree(repo);
  const changedSince = changedFilesBetween(repo, afterTree, now).map((f) => f.path).filter((p) => paths.includes(p));
  const ok = !mixed.length && !changedSince.length;
  return {
    ok, paths, files, mixed, changedSince,
    reason: mixed.length ? `you had uncommitted changes in ${mixed.join(', ')} before the task — committing would include them`
      : changedSince.length ? `${changedSince.join(', ')} changed after the task finished` : undefined,
  };
}

export function commitPaths(repo: string, paths: string[], message: string): { ok: boolean; sha?: string; error?: string } {
  // never without paths: `git add -A --` with no pathspec would stage the whole tree
  const clean = paths.filter((p) => p && p.trim() && p !== '.' && !p.startsWith('-'));
  if (!clean.length || clean.length !== paths.length) return { ok: false, error: 'nothing to commit — no task files given' };
  const add = tryGit(repo, ['add', '-A', '--', ...paths]);
  if (!add.ok) return { ok: false, error: add.err.trim().slice(0, 500) };
  const c = tryGit(repo, ['commit', '--only', '-F', '-', '--', ...paths], message);
  if (!c.ok) return { ok: false, error: (c.err || c.out).trim().slice(0, 800) };
  return { ok: true, sha: git(repo, ['rev-parse', 'HEAD']).trim() };
}

// ------------------------------------------------------------ revert / reapply

export function commitInfo(repo: string, sha: string): { sha: string; parent: string | null; subject: string; body: string; author: string; date: string; files: FileChange[] } {
  const fmt = git(repo, ['show', '-s', '--format=%H%x00%P%x00%s%x00%b%x00%an%x00%aI', sha]).split('\0');
  const parent = fmt[1].trim().split(' ')[0] || null;
  const files = parent ? changedFilesBetween(repo, parent, fmt[0]) : [];
  return { sha: fmt[0], parent, subject: fmt[2], body: fmt[3].trim(), author: fmt[4], date: fmt[5].trim(), files };
}

/** Revert (or, with reapply, re-apply) a commit's change as a new commit. */
export function revertCommit(repo: string, sha: string, reapply = false, dryRun = false): { ok: boolean; sha?: string; conflicts?: { path: string; reason: string }[]; message: string; files: FileChange[] } {
  const info = commitInfo(repo, sha);
  if (!info.parent) return { ok: false, message: 'cannot revert a root commit', files: [] };
  const patch = patchBetween(repo, info.parent, info.sha);
  const reverse = !reapply;
  const check = checkPatch(repo, patch, reverse);
  if (!check.ok) return { ok: false, conflicts: check.conflicts, message: 'the files changed since this commit overlap it — nothing was changed', files: info.files };
  const paths = [...new Set(info.files.flatMap((f) => [f.path, f.from].filter(Boolean) as string[]))];
  const dirtyBefore = dirtyPaths(repo).filter((p) => paths.includes(p));
  if (dirtyBefore.length) return { ok: false, message: `uncommitted changes in ${dirtyBefore.join(', ')} — commit or set them aside first`, files: info.files };
  if (dryRun) return { ok: true, message: 'applies cleanly', files: info.files };
  applyPatch(repo, patch, reverse);
  const message = reapply ? `Reapply "${info.subject}"\n\nThis reapplies commit ${info.sha}.` : `Revert "${info.subject}"\n\nThis reverts commit ${info.sha}.`;
  const c = commitPaths(repo, paths, message);
  if (!c.ok) { applyPatch(repo, patch, !reverse); return { ok: false, message: `commit failed, change rolled back: ${c.error}`, files: info.files }; }
  return { ok: true, sha: c.sha, message: reapply ? 'reapplied' : 'reverted', files: info.files };
}

// ------------------------------------------------------------ history

export interface LogEntry { sha: string; parents: string[]; subject: string; author: string; email: string; date: string; refs: string; files?: number }

/** One page of history for a ref (default: HEAD), newest first. */
export function gitLog(repo: string, opts: { ref?: string; skip?: number; limit?: number; path?: string; before?: string } = {}): LogEntry[] {
  const r = tryGit(repo, ['log', opts.ref ?? 'HEAD', `--skip=${opts.skip ?? 0}`, `-n`, String(Math.min(opts.limit ?? 50, 200)), ...(opts.before ? [`--before=${opts.before}`] : []),
    '--format=%H%x1f%P%x1f%s%x1f%an%x1f%ae%x1f%aI%x1f%D%x1e', ...(opts.path ? ['--', opts.path] : [])]);
  if (!r.ok) return [];
  return r.out.split('\x1e').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sha, parents, subject, author, email, date, refs] = s.split('\x1f');
    return { sha, parents: parents ? parents.split(' ') : [], subject, author, email, date, refs };
  });
}

export function commitDiff(repo: string, sha: string, against?: string): { files: FileChange[]; diff: string } {
  const base = against ?? (commitInfo(repo, sha).parent ?? '4b825dc642cb6eb9a060e54bf8d69288fbee4904'); // empty tree
  return { files: changedFilesBetween(repo, base, sha), diff: git(repo, ['diff', '-M', '--no-color', base, sha]) };
}
