import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import {
  RAW, changedFilesBetween, unaddablePaths, displayDiff, largeUntracked, patchBetween, pinTree, snapshotTree,
  type ApplyCheck, type FileChange,
} from './snapshot.ts';
import { applyPlan, planTransition, treeDelta, type FilePlan, type TransitionPlan } from './apply-tree.ts';

// Checkpoints (two levels, deliberately separate):
//   general — the whole result of a task (or a manual save point): before and
//             after snapshots of the working tree around everything the task did;
//   agent   — one agent's work item inside a task: before/after around just
//             that agent's edits, so it can be undone on its own.
// Undo/redo apply the recorded patch (reversed/forward) to the CURRENT working
// tree after a dry run; nothing is re-run and no model is called. Changes that
// aren't part of the checkpoint — the user's own edits, other agents' work —
// stay untouched; when they overlap, the dry run fails and nothing changes.
//
// Statuses: open (work running) · applied (its changes are in the tree) ·
// undone · interrupted (the daemon stopped mid-work; closed on boot).

export type CheckpointKind = 'general' | 'agent' | 'manual';
export interface Checkpoint {
  id: string; repoId: string; kind: CheckpointKind; parentId: string | null;
  runId: string | null; taskId: string | null; workItemId: string | null; agentId: string | null;
  label: string; prompt: string; beforeTree: string; afterTree: string | null;
  files: FileChange[]; status: 'open' | 'applied' | 'undone' | 'interrupted';
  commitSha: string | null; createdAt: string; completedAt: string | null; changedAt: string | null;
  headSha: string | null; branch: string | null; fileCount: number | null; skipped: string[];   // what the snapshot was taken against, and what it could not hold
}

function rowTo(r: Record<string, unknown>): Checkpoint {
  return {
    id: r.id as string, repoId: r.repo_id as string, kind: r.kind as CheckpointKind, parentId: (r.parent_id as string) ?? null,
    runId: (r.run_id as string) ?? null, taskId: (r.task_id as string) ?? null, workItemId: (r.work_item_id as string) ?? null,
    agentId: (r.agent_id as string) ?? null, label: (r.label as string) ?? '', prompt: (r.prompt as string) ?? '',
    beforeTree: r.before_tree as string, afterTree: (r.after_tree as string) ?? null,
    files: parseJson(r.files as string, []), status: r.status as Checkpoint['status'],
    commitSha: (r.commit_sha as string) ?? null, createdAt: r.created_at as string,
    completedAt: (r.completed_at as string) ?? null, changedAt: (r.changed_at as string) ?? null,
    headSha: (r.head_sha as string) ?? null, branch: (r.branch as string) ?? null, fileCount: (r.file_count as number) ?? null, skipped: parseJson(r.skipped as string, []),
  };
}

export function getCheckpoint(id: string): Checkpoint | undefined {
  const r = q1('SELECT * FROM repo_checkpoints WHERE id = ?', id);
  return r ? rowTo(r) : undefined;
}

function repoPath(repoId: string): string {
  const r = q1('SELECT path FROM repos WHERE id = ?', repoId);
  if (!r) throw new Error(`repo ${repoId} not found`);
  return r.path as string;
}

function logOp(cp: Checkpoint, op: string, ok: boolean, detail: string, files: unknown[] = [], actor = 'owner'): void {
  run('INSERT INTO checkpoint_ops (id, checkpoint_id, op, actor, ok, detail, files, at) VALUES (?,?,?,?,?,?,?,?)',
    ulid(), cp.id, op, actor, ok ? 1 : 0, detail.slice(0, 2000), JSON.stringify(files), now());
  emit(`checkpoint.${op}`, actor, { checkpointId: cp.id, kind: cp.kind, ok, detail: detail.slice(0, 300), taskId: cp.taskId, label: cp.label }, cp.runId, cp.id);
}

// ---------------------------------------------------------------- recording

const gitOut = (repo: string, args: string[]): string | null => {
  try { return execFileSync('git', [...RAW, '-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; }
};

/**
 * Take a snapshot of the working tree and prove it is usable before anything relies on it: the tree object must be readable,
 * it must be pinned under a ref git will never collect, and that ref must resolve to the same tree. A failed first attempt (a
 * stale index, a transient lock) is retried once from a fresh index. Also records what the snapshot was taken against: the
 * commit and branch HEAD was on, how many files it holds, and which files could not be stored.
 */
function reliableSnapshot(repo: string, id: string, side: 'before' | 'after', label: string): { tree: string; head: string | null; branch: string | null; count: number; skipped: string[] } {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tree = snapshotTree(repo);
      pinTree(repo, tree, `cp/${id}/${side}`, `checkpoint ${id} ${side}: ${label}`.slice(0, 200));
      const pinned = gitOut(repo, ['rev-parse', '--verify', `refs/officechain/cp/${id}/${side}^{tree}`]);
      if (gitOut(repo, ['cat-file', '-t', tree]) !== 'tree' || pinned !== tree) throw new Error('the snapshot could not be read back from git');
      const count = (gitOut(repo, ['ls-tree', '-r', '--name-only', tree]) ?? '').split('\n').filter(Boolean).length;
      return {
        tree, count, head: gitOut(repo, ['rev-parse', '--verify', 'HEAD']), branch: gitOut(repo, ['symbolic-ref', '--short', '-q', 'HEAD']) || null,
        skipped: [...new Set([...largeUntracked(repo), ...unaddablePaths(repo)])],
      };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`could not record a reliable snapshot of the repository: ${String((lastErr as Error)?.message ?? lastErr).slice(0, 300)}`);
}

export function beginCheckpoint(opts: {
  repoId: string; kind: CheckpointKind; label: string; prompt?: string; parentId?: string | null;
  runId?: string | null; taskId?: string | null; workItemId?: string | null; agentId?: string | null;
}): Checkpoint {
  const repo = repoPath(opts.repoId);
  const id = ulid();
  const { tree, head, branch, count, skipped } = reliableSnapshot(repo, id, 'before', opts.label);
  run(`INSERT INTO repo_checkpoints (id, repo_id, kind, parent_id, run_id, task_id, work_item_id, agent_id, label, prompt, before_tree, status, created_at, head_sha, branch, file_count, skipped)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, opts.repoId, opts.kind, opts.parentId ?? null, opts.runId ?? null, opts.taskId ?? null, opts.workItemId ?? null,
    opts.agentId ?? null, opts.label, (opts.prompt ?? '').slice(0, 20000), tree, 'open', now(), head, branch, count, JSON.stringify(skipped.slice(0, 200)));
  const cp = getCheckpoint(id)!;
  emit('checkpoint.created', 'engine', { checkpointId: id, kind: cp.kind, label: cp.label, taskId: cp.taskId, agentId: cp.agentId }, cp.runId, id);
  return cp;
}

/** Close an open checkpoint with an after-snapshot of the working tree. */
export function endCheckpoint(id: string, status: 'applied' | 'interrupted' = 'applied'): Checkpoint {
  const cp = getCheckpoint(id);
  if (!cp) throw new Error(`checkpoint ${id} not found`);
  if (cp.status !== 'open') return cp;
  const repo = repoPath(cp.repoId);
  let tree: string;
  try {
    tree = reliableSnapshot(repo, id, 'after', cp.label).tree;
  } catch (e) {
    // never leave it open: an open checkpoint holds the repository for its task
    const error = String((e as Error)?.message ?? e).slice(0, 500);
    run('UPDATE repo_checkpoints SET status = ?, completed_at = ? WHERE id = ?', 'interrupted', now(), id);
    emit('checkpoint.error', 'engine', { checkpointId: id, label: cp.label, taskId: cp.taskId, error }, cp.runId, id);
    return getCheckpoint(id)!;
  }
  const files = changedFilesBetween(repo, cp.beforeTree, tree);
  run('UPDATE repo_checkpoints SET after_tree = ?, files = ?, status = ?, completed_at = ? WHERE id = ?', tree, JSON.stringify(files), status, now(), id);
  const done = getCheckpoint(id)!;
  const unaddable = unaddablePaths(repo);
  emit('checkpoint.completed', 'engine', { checkpointId: id, kind: done.kind, label: done.label, taskId: done.taskId, agentId: done.agentId, files: files.length, status,
    ...(unaddable.length ? { skipped: unaddable, note: `git cannot index ${unaddable.join(', ')} — not part of this checkpoint` } : {}) }, done.runId, id);
  return done;
}

/** A save point of the current working tree, made by the owner. */
export function manualCheckpoint(repoId: string, label: string): Checkpoint {
  const cp = beginCheckpoint({ repoId, kind: 'manual', label: label || 'Manual checkpoint' });
  run('UPDATE repo_checkpoints SET after_tree = before_tree, status = ?, completed_at = ? WHERE id = ?', 'applied', now(), cp.id);
  return getCheckpoint(cp.id)!;
}

/** After a crash, close checkpoints left open with what is on disk now. */
export function recoverInterruptedCheckpoints(): number {
  const open = q(`SELECT id FROM repo_checkpoints WHERE status = 'open'`);
  for (const r of open) {
    try { endCheckpoint(r.id as string, 'interrupted'); } catch { /* repo gone */ }
  }
  return open.length;
}

export function setCheckpointCommit(id: string, sha: string): void {
  run('UPDATE repo_checkpoints SET commit_sha = ? WHERE id = ?', sha, id);
}

// ---------------------------------------------------------------- queries

export function listCheckpoints(f: { repoId?: string; kind?: string; taskId?: string; agentId?: string; file?: string; since?: string; until?: string; limit?: number; before?: string } = {}): Checkpoint[] {
  const where: string[] = []; const p: unknown[] = [];
  if (f.repoId) { where.push('repo_id = ?'); p.push(f.repoId); }
  if (f.kind) { where.push('kind = ?'); p.push(f.kind); }
  if (f.taskId) { where.push('task_id = ?'); p.push(f.taskId); }
  if (f.agentId) { where.push('agent_id = ?'); p.push(f.agentId); }
  if (f.since) { where.push('created_at >= ?'); p.push(f.since); }
  if (f.until) { where.push('created_at <= ?'); p.push(f.until); }
  if (f.before) { where.push('created_at < ?'); p.push(f.before); }
  if (f.file) { where.push(`files LIKE ?`); p.push(`%"${f.file.replace(/[%_"]/g, '')}%`); }
  const rows = q(`SELECT * FROM repo_checkpoints ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, rowid DESC LIMIT ?`, ...p, Math.min(f.limit ?? 100, 500));
  return rows.map(rowTo);
}

export function checkpointOps(id: string): Record<string, unknown>[] {
  return q('SELECT * FROM checkpoint_ops WHERE checkpoint_id = ? ORDER BY at', id).map((o) => ({ ...o, files: parseJson(o.files as string, []) }));
}

function children(cp: Checkpoint): Checkpoint[] {
  return q(`SELECT * FROM repo_checkpoints WHERE parent_id = ? ORDER BY created_at, rowid`, cp.id).map(rowTo);
}

// The tree this checkpoint's changes currently amount to: for a task whose
// agents were partly undone, only the agent work still applied counts.
function effectiveAfter(repo: string, cp: Checkpoint): string {
  if (!cp.afterTree) throw new Error('checkpoint is still open');
  const kids = children(cp);
  if (cp.kind !== 'general' || !kids.some((k) => k.status === 'undone')) return cp.afterTree;
  const tmp = path.join(os.tmpdir(), `oc-eff-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmp };
  const g = (args: string[], input?: string) => execFileSync('git', [...RAW, '-C', repo, ...args], { windowsHide: true, encoding: 'utf8', env, input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    g(['read-tree', cp.beforeTree]);
    for (const k of kids) {
      if (k.status !== 'applied' || !k.afterTree) continue;
      const patch = patchBetween(repo, k.beforeTree, k.afterTree);
      if (patch.trim()) g(['apply', '--cached', '--whitespace=nowarn'], patch);
    }
    return g(['write-tree']).trim();
  } finally { fs.rmSync(tmp, { force: true }); }
}

/** Later work touching the same files — undoing this may conflict with it. */
export function dependents(cp: Checkpoint): { id: string; kind: string; label: string; agentId: string | null; files: string[] }[] {
  if (!cp.completedAt) return [];
  const mine = new Set(cp.files.flatMap((f) => [f.path, f.from].filter(Boolean) as string[]));
  return q(`SELECT * FROM repo_checkpoints WHERE repo_id = ? AND status = 'applied' AND kind = 'agent' AND created_at >= ? AND id != ? AND (parent_id IS NULL OR parent_id != ?)`,
    cp.repoId, cp.completedAt, cp.id, cp.id).map(rowTo)
    .filter((o) => !(cp.kind === 'agent' && o.parentId === cp.id))
    .map((o) => ({ id: o.id, kind: o.kind, label: o.label, agentId: o.agentId, files: o.files.map((f) => f.path).filter((p) => mine.has(p)) }))
    .filter((o) => o.files.length > 0);
}

export interface PlannedFile { path: string; state: 'already' | 'clean' | 'merge' | 'conflict' | 'overwrite'; reason?: string }
export interface Preview {
  op: 'undo' | 'redo' | 'restore'; checkpoint: Checkpoint; allowed: boolean; reason?: string;
  check: ApplyCheck; files: FileChange[]; diff: string; dependents: ReturnType<typeof dependents>;
  plan: PlannedFile[];            // what will happen to each file: replaced, merged with your edits, left alone (conflict), already done
  partialAllowed: boolean;        // some files conflict but others can still be changed on their own
}

const entryStatus = (f: FilePlan): FileChange['status'] => (!f.from ? 'A' : !f.to ? 'D' : 'M');

// What an operation would change: the exact files and lines, which of them can be changed safely, and what later work
// depends on it. Nothing is written here.
function plan(cp: Checkpoint, op: 'undo' | 'redo' | 'restore'): { preview: Preview; tp: TransitionPlan | null } {
  const repo = repoPath(cp.repoId);
  const base = { checkpoint: cp, op, dependents: [] as ReturnType<typeof dependents>, plan: [] as PlannedFile[], partialAllowed: false };
  const deny = (reason: string) => ({ preview: { ...base, allowed: false, reason, check: { ok: false, conflicts: [], message: reason }, files: [], diff: '' } as Preview, tp: null });
  if (cp.status === 'open') return deny('work is still running in this checkpoint');
  if (!cp.afterTree && cp.kind !== 'manual') return deny('the state after this work could not be recorded (see the checkpoint error) — use Restore on an earlier checkpoint instead');
  let from: string, to: string;
  if (op === 'restore') {
    // make the working tree equal to this checkpoint's (after) state
    from = snapshotTree(repo); to = cp.afterTree ?? cp.beforeTree;
  } else {
    if (cp.kind === 'manual') return deny('a manual checkpoint is a save point — use Restore');
    if (cp.kind === 'agent' && cp.parentId) {
      const parent = getCheckpoint(cp.parentId);
      if (parent?.status === 'undone') return deny('the whole task is undone — redo the task first');
    }
    if (op === 'undo' && cp.status === 'undone') return deny('already undone');
    if (op === 'redo' && cp.status !== 'undone') return deny('only an undone checkpoint can be redone');
    const after = op === 'redo' ? cp.afterTree! : effectiveAfter(repo, cp);
    if (!treeDelta(repo, cp.beforeTree, after).length) return deny('this checkpoint changed no files');
    [from, to] = op === 'undo' ? [after, cp.beforeTree] : [cp.beforeTree, after];
  }
  const tp = planTransition(repo, from, to, { force: op === 'restore' });
  const touched = tp.files.filter((f) => f.state !== 'already');
  const files: FileChange[] = tp.changing.map((f) => ({ status: entryStatus(f), path: f.path }));
  const diffPaths = touched.map((f) => f.path);
  const reason = tp.ok ? undefined : tp.conflicts.length === tp.files.length
    ? 'files changed since this checkpoint overlap its changes' : `${tp.conflicts.length} of ${tp.files.length} files changed since this checkpoint overlap its changes`;
  return {
    preview: {
      ...base, allowed: tp.ok, reason,
      check: { ok: tp.ok, conflicts: tp.conflicts, message: tp.ok ? 'applies cleanly' : (reason ?? '') },
      files, diff: diffPaths.length ? displayDiff(repo, from, to, diffPaths) : '',
      dependents: op === 'restore' ? [] : dependents(cp),
      plan: tp.files.map((f) => ({ path: f.path, state: f.state, reason: f.reason })),
      partialAllowed: !tp.ok && tp.changing.length > 0,
    },
    tp,
  };
}

export function preview(id: string, op: 'undo' | 'redo' | 'restore'): Preview {
  const cp = getCheckpoint(id);
  if (!cp) throw new Error('checkpoint not found');
  return plan(cp, op).preview;
}

export interface OpResult { ok: boolean; message: string; preview: Preview; partial?: boolean; skipped?: { path: string; reason: string }[] }

/**
 * Undo, redo or restore. Refuses (changing nothing) when a file cannot be changed safely, unless `partial` asks for the safe
 * files only. A failed write puts every file back; the result is verified file by file.
 */
export function perform(id: string, op: 'undo' | 'redo' | 'restore', actor = 'owner', opts: { partial?: boolean } = {}): OpResult {
  const cp = getCheckpoint(id);
  if (!cp) throw new Error('checkpoint not found');
  const { preview: pv, tp } = plan(cp, op);
  if (!tp || (!pv.allowed && !(opts.partial && pv.partialAllowed))) {
    logOp(cp, op, false, pv.reason ?? pv.check.message, pv.check.conflicts, actor);
    return { ok: false, message: pv.reason ?? pv.check.message, preview: pv };
  }
  const repo = repoPath(cp.repoId);
  // restore is reversible too: record the state it replaces as a checkpoint
  const guard = op === 'restore' ? beginCheckpoint({ repoId: cp.repoId, kind: 'manual', label: `Before restoring "${cp.label}"` }) : null;
  if (guard) run('UPDATE repo_checkpoints SET after_tree = before_tree, status = ?, completed_at = ? WHERE id = ?', 'applied', now(), guard.id);
  const res = applyPlan(repo, tp, { partial: opts.partial });
  if (!res.ok) {
    logOp(cp, op, false, res.message, res.skipped, actor);
    return { ok: false, message: res.message, preview: { ...pv, allowed: false, check: { ok: false, conflicts: res.skipped, message: res.message } }, skipped: res.skipped };
  }
  const partial = res.skipped.length > 0;
  if (op !== 'restore' && !partial) {
    const status = op === 'undo' ? 'undone' : 'applied';
    run('UPDATE repo_checkpoints SET status = ?, changed_at = ? WHERE id = ?', status, now(), cp.id);
    // a task undone/redone as a whole takes its agents' checkpoints with it
    if (cp.kind === 'general') run(`UPDATE repo_checkpoints SET status = ?, changed_at = ? WHERE parent_id = ? AND status IN ('applied','undone')`, status, now(), cp.id);
  }
  const merged = tp.changing.filter((f) => f.state === 'merge').length;
  const detail = partial
    ? `${op} partly done — ${res.applied.length} file(s) changed, ${res.skipped.length} left alone because they overlap later edits`
    : `${op} applied to ${res.applied.length} file(s)${merged ? ` (${merged} merged with later edits)` : ''}`;
  logOp(cp, op, true, detail, pv.files, actor);
  return { ok: true, partial, skipped: partial ? res.skipped : undefined, message: partial ? detail : `${op} done — ${res.applied.length} file(s) changed${merged ? `, ${merged} merged with your later edits` : ''}`, preview: pv };
}

/** Undo the most recent applied general checkpoint / redo the most recently undone. */
export function lastUndoable(repoId: string): Checkpoint | undefined {
  const r = q1(`SELECT * FROM repo_checkpoints WHERE repo_id = ? AND kind = 'general' AND status IN ('applied','interrupted') ORDER BY created_at DESC, rowid DESC LIMIT 1`, repoId);
  return r ? rowTo(r) : undefined;
}
export function lastRedoable(repoId: string): Checkpoint | undefined {
  const r = q1(`SELECT * FROM repo_checkpoints WHERE repo_id = ? AND kind = 'general' AND status = 'undone' ORDER BY changed_at DESC, rowid DESC LIMIT 1`, repoId);
  return r ? rowTo(r) : undefined;
}

/** Diff between two checkpoints (each side: 'before' or 'after' state). */
export function compare(a: { id: string; side: 'before' | 'after' }, b: { id: string; side: 'before' | 'after' }): { files: FileChange[]; diff: string } {
  const ca = getCheckpoint(a.id); const cb = getCheckpoint(b.id);
  if (!ca || !cb) throw new Error('checkpoint not found');
  if (ca.repoId !== cb.repoId) throw new Error('checkpoints belong to different repositories');
  const ta = a.side === 'before' ? ca.beforeTree : (ca.afterTree ?? ca.beforeTree);
  const tb = b.side === 'before' ? cb.beforeTree : (cb.afterTree ?? cb.beforeTree);
  const repo = repoPath(ca.repoId);
  return { files: changedFilesBetween(repo, ta, tb), diff: displayDiff(repo, ta, tb) };
}

/** The checkpoint's own change (before → after) for inspection. */
export function checkpointDiff(id: string, paths: string[] = []): { files: FileChange[]; diff: string } {
  const cp = getCheckpoint(id);
  if (!cp) throw new Error('checkpoint not found');
  const repo = repoPath(cp.repoId);
  const after = cp.afterTree ?? snapshotTree(repo);
  return { files: changedFilesBetween(repo, cp.beforeTree, after), diff: displayDiff(repo, cp.beforeTree, after, paths) };
}

// Retention: keep the newest N per repo (default 500); older ones lose their
// pinned refs. Never touches the working tree.
export function pruneCheckpoints(repoId: string, keep = 500): number {
  const old = q(`SELECT id FROM repo_checkpoints WHERE repo_id = ? AND status != 'open' ORDER BY created_at DESC LIMIT -1 OFFSET ?`, repoId, keep);
  if (!old.length) return 0;
  const repo = repoPath(repoId);
  for (const r of old) {
    for (const side of ['before', 'after']) { try { execFileSync('git', ['-C', repo, 'update-ref', '-d', `refs/officechain/cp/${r.id}/${side}`], { stdio: 'ignore', windowsHide: true }); } catch { /* gone */ } }
    run('DELETE FROM repo_checkpoints WHERE id = ?', r.id);
    run('DELETE FROM checkpoint_ops WHERE checkpoint_id = ?', r.id);
  }
  return old.length;
}
