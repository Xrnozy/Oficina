import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { parseJson } from '../util.ts';
import {
  checkpointDiff, checkpointOps, compare, dependents, getCheckpoint, lastRedoable, lastUndoable,
  listCheckpoints, manualCheckpoint, perform, preview, type Checkpoint,
} from '../services/checkpoints.ts';
import { commitDiff, commitInfo, currentBranch, dirtyPaths, gitLog, revertCommit } from '../services/commits.ts';
import { isGitRepo } from '../services/snapshot.ts';
import { checkRepo, listActivity } from '../services/repo-watch.ts';
import { gitOk } from '../services/git.ts';
import { commitTask, getTask } from '../engine/engine.ts';
import { getAgent } from '../services/router.ts';

// Repository history: checkpoints (general / agent / manual) with undo, redo,
// restore and compare; the repository timeline; task commits; and the
// per-task prompt record.

const ok = (res: Response, data: unknown) => res.json(data);
const err = (res: Response, code: number, msg: string) => res.status(code).json({ error: msg });

function repoOf(id: string): { id: string; path: string } | null {
  const r = q1('SELECT id, path FROM repos WHERE id = ?', id);
  return r ? { id: r.id as string, path: r.path as string } : null;
}

function withNames(cp: Checkpoint) {
  const task = cp.taskId ? getTask(cp.taskId) : undefined;
  return { ...cp, agentName: getAgent(cp.agentId)?.name ?? null, taskTitle: task?.title ?? null, prompt: cp.prompt.slice(0, 2000) };
}

const OPS = ['undo', 'redo', 'restore'] as const;

export function registerHistoryRoutes(app: Express): void {
  // ---------------- checkpoints
  app.get('/api/checkpoints', (req: Request, res: Response) => {
    const s = (k: string) => (req.query[k] ? String(req.query[k]) : undefined);
    ok(res, listCheckpoints({ repoId: s('repoId'), kind: s('kind'), taskId: s('taskId'), agentId: s('agentId'), file: s('file'), since: s('since'), until: s('until'), before: s('before'), limit: Number(req.query.limit) || 100 }).map(withNames));
  });

  app.get('/api/checkpoints/compare', (req, res) => {
    try {
      ok(res, compare({ id: String(req.query.a), side: req.query.as === 'before' ? 'before' : 'after' }, { id: String(req.query.b), side: req.query.bs === 'before' ? 'before' : 'after' }));
    } catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });

  app.get('/api/checkpoints/:id', (req, res) => {
    const cp = getCheckpoint(req.params.id);
    if (!cp) return err(res, 404, 'checkpoint not found');
    try {
      const d = checkpointDiff(cp.id);
      const kids = q(`SELECT id FROM repo_checkpoints WHERE parent_id = ? ORDER BY created_at`, cp.id).map((x) => withNames(getCheckpoint(x.id as string)!));
      ok(res, { checkpoint: withNames(cp), prompt: cp.prompt, files: d.files, diff: d.diff, ops: checkpointOps(cp.id), children: kids, dependents: dependents(cp), parent: cp.parentId ? withNames(getCheckpoint(cp.parentId)!) : null });
    } catch (e) { err(res, 500, String((e as Error).message ?? e)); }
  });

  app.get('/api/checkpoints/:id/preview', (req, res) => {
    const op = String(req.query.op) as (typeof OPS)[number];
    if (!OPS.includes(op)) return err(res, 400, 'op must be undo | redo | restore');
    try { ok(res, preview(req.params.id, op)); } catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });

  app.post('/api/checkpoints/:id/:op', (req, res) => {
    const op = req.params.op as (typeof OPS)[number];
    if (!OPS.includes(op)) return err(res, 400, 'op must be undo | redo | restore');
    // a running task's working tree must not change underneath it
    const cp = getCheckpoint(req.params.id);
    if (!cp) return err(res, 404, 'checkpoint not found');
    const busy = q1(`SELECT id, label FROM repo_checkpoints WHERE repo_id = ? AND status = 'open'`, cp.repoId);
    if (busy) return err(res, 409, `"${busy.label}" is working in this repository right now — pause the run first`);
    try {
      // partial: change the files that can be changed safely and leave the ones that overlap later edits
      const r = perform(req.params.id, op, 'owner', { partial: req.body?.partial === true });
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) { err(res, 500, String((e as Error).message ?? e)); }
  });

  app.post('/api/repos/:id/checkpoints', (req, res) => {
    const repo = repoOf(req.params.id);
    if (!repo) return err(res, 404, 'repo not found');
    try { ok(res, withNames(manualCheckpoint(repo.id, String(req.body?.label ?? '').trim()))); } catch (e) { err(res, 500, String((e as Error).message ?? e)); }
  });

  // the last whole-task result: undo / redo
  app.get('/api/repos/:id/undo-redo', (req, res) => {
    const u = lastUndoable(req.params.id); const r = lastRedoable(req.params.id);
    ok(res, { undo: u ? withNames(u) : null, redo: r ? withNames(r) : null });
  });

  // ---------------- repository state
  app.get('/api/repos/:id/status', (req, res) => {
    const repo = repoOf(req.params.id);
    if (!repo) return err(res, 404, 'repo not found');
    if (!isGitRepo(repo.path)) return ok(res, { git: false, path: repo.path });
    ok(res, { git: true, path: repo.path, branch: currentBranch(repo.path), dirty: dirtyPaths(repo.path).slice(0, 200),
      working: q1(`SELECT id, label, task_id FROM repo_checkpoints WHERE repo_id = ? AND status = 'open' AND kind = 'general'`, repo.id) ?? null });
  });

  // ---------------- timeline: commits (from any tool) + checkpoints + operations + task events + repository activity, newest first
  app.get('/api/repos/:id/timeline', async (req, res) => {
    const repo = repoOf(req.params.id);
    if (!repo) return err(res, 404, 'repo not found');
    const limit = Math.min(Number(req.query.limit) || 40, 200);
    const lim = limit + 1;   // one more than a page, so we know whether another page exists
    const before = req.query.before ? String(req.query.before) : '9999';
    const text = req.query.q ? String(req.query.q).trim() : '';
    const author = req.query.author ? String(req.query.author) : '';
    const want = new Set((req.query.kinds ? String(req.query.kinds) : 'commit,checkpoint,event,activity').split(',').map((s) => s.trim()));
    // a commit made a moment ago in VS Code or a terminal must not wait for the next poll
    try { await checkRepo(repo.id); } catch { /* the page still works from what is stored */ }
    const git = isGitRepo(repo.path);
    const entries: Record<string, unknown>[] = [];
    // AI commits are known from their checkpoint/commit record
    const aiCommits = new Map<string, { taskId: string | null; checkpointId: string }>();
    for (const c of q(`SELECT id, task_id, commit_sha FROM repo_checkpoints WHERE repo_id = ? AND commit_sha IS NOT NULL`, repo.id)) aiCommits.set(c.commit_sha as string, { taskId: c.task_id as string | null, checkpointId: c.id as string });
    const matches = (s: string) => !text || s.toLowerCase().includes(text.toLowerCase());
    if (git && want.has('commit')) {
      for (const c of gitLog(repo.path, { all: true, limit: lim, before: before !== '9999' ? before : undefined, grep: text || undefined, author: author || undefined, stat: true })
        .filter((c) => new Date(c.committed).toISOString() < before)) {
        const ai = aiCommits.get(c.sha);
        const decorations = c.refs ? c.refs.split(', ').map((r) => r.trim()).filter(Boolean) : [];
        entries.push({
          id: `commit:${c.sha}`, type: 'commit', ts: new Date(c.committed).toISOString(), authoredAt: new Date(c.date).toISOString(), title: c.subject, actor: ai ? 'AI' : c.author,
          author: c.author, email: c.email, origin: ai ? 'ai' : 'user', sha: c.sha, parents: c.parents, merge: c.parents.length > 1,
          head: decorations.some((d) => d.startsWith('HEAD')), branches: decorations.filter((d) => !d.startsWith('tag:')).map((d) => d.replace(/^HEAD -> /, '')).filter((d) => d !== 'HEAD'),
          tags: decorations.filter((d) => d.startsWith('tag:')).map((d) => d.slice(4).trim()),
          taskId: ai?.taskId ?? null, checkpointId: ai?.checkpointId ?? null, stat: c.files != null ? { files: c.files, added: c.added ?? 0, removed: c.removed ?? 0 } : null,
        });
      }
    }
    if (want.has('checkpoint')) {
      for (const cp of listCheckpoints({ repoId: repo.id, before, limit: lim }).filter((cp) => matches(`${cp.label} ${cp.taskId ?? ''}`))) {
        entries.push({ id: `cp:${cp.id}`, type: cp.kind === 'agent' ? 'agent-checkpoint' : cp.kind === 'manual' ? 'manual-checkpoint' : 'general-checkpoint',
          ts: cp.createdAt, completedAt: cp.completedAt, title: cp.label, actor: getAgent(cp.agentId)?.name ?? (cp.kind === 'manual' ? 'you' : 'engine'),
          status: cp.status, files: cp.files, checkpointId: cp.id, parentId: cp.parentId, taskId: cp.taskId, sha: cp.commitSha, branch: cp.branch, headSha: cp.headSha, fileCount: cp.fileCount, skipped: cp.skipped });
      }
      for (const o of q(`SELECT o.*, c.label, c.kind, c.task_id FROM checkpoint_ops o JOIN repo_checkpoints c ON c.id = o.checkpoint_id WHERE c.repo_id = ? AND o.at < ? ORDER BY o.at DESC LIMIT ?`, repo.id, before, lim)) {
        const title = `${String(o.op).charAt(0).toUpperCase()}${String(o.op).slice(1)} ${o.kind} checkpoint "${o.label}"`;
        if (!matches(String(title))) continue;
        entries.push({ id: `op:${o.id}`, type: o.op, ts: o.at, title, actor: o.actor, ok: !!o.ok, detail: o.detail, files: parseJson(o.files as string, []), checkpointId: o.checkpoint_id, taskId: o.task_id });
      }
    }
    if (want.has('activity')) {
      for (const a of listActivity(repo.id, before, lim)) {
        if (!matches(String(a.subject))) continue;
        entries.push({ id: `act:${a.id}`, type: 'activity', activity: a.kind, ts: a.at, title: a.subject, actor: 'git', sha: a.sha ?? null, prevSha: a.prev_sha ?? null, branch: a.branch ?? null, detail: a.detail });
      }
    }
    const runIds = want.has('event') ? q('SELECT id FROM runs WHERE repo_id = ?', repo.id).map((r) => r.id as string) : [];
    if (runIds.length) {
      const evs = q(`SELECT * FROM events WHERE run_id IN (${runIds.map(() => '?').join(',')}) AND ts < ?
                     AND (type IN ('commit.created','commit.failed','readonly.violation','repo.dirty','checkpoint.recovered','qa.decided','review.decided','accept.decided','run.created','human.decided')
                          OR (type = 'task.status' AND json_extract(payload, '$.status') IN ('in-progress','done','failed','cancelled','blocked')))
                     ORDER BY seq DESC LIMIT ?`, ...runIds, before, lim);
      for (const e of evs) {
        const p = parseJson<Record<string, unknown>>(e.payload as string, {});
        const title = e.type === 'task.status' ? `Task ${p.status === 'in-progress' ? 'started' : p.status}: ${p.title ?? ''}`
          : e.type === 'commit.created' ? `Committed: ${p.title}` : e.type === 'run.created' ? `Request: ${p.goal}`
            : e.type === 'qa.decided' || e.type === 'review.decided' ? `Review ${p.decision}` : e.type === 'accept.decided' ? `PM ${p.decision === 'accept' ? 'accepted' : 'sent back'}${p.notes ? ` — ${p.notes}` : ''}`
              : e.type === 'human.decided' ? `You ${p.decision} "${p.nodeLabel}"${p.feedback ? ` — ${p.feedback}` : ''}`
                : e.type === 'readonly.violation' ? `${p.agent} changed files during read-only ${p.kind}` : e.type === 'repo.dirty' ? `Uncommitted changes found before a task (${p.count} file(s)) — preserved`
                  : e.type === 'checkpoint.recovered' ? 'Interrupted work recovered after restart' : e.type === 'commit.failed' ? `Commit failed: ${p.error}` : e.type;
        if (!matches(String(title))) continue;
        entries.push({ id: `ev:${e.seq}`, type: e.type === 'task.status' ? 'task' : e.type === 'run.created' ? 'request' : 'event', event: e.type, ts: e.ts, title, actor: e.actor,
          taskId: (p.taskId as string) ?? (e.type === 'task.status' ? e.entity_id : null), sha: p.sha ?? null, files: p.files ?? null, runId: e.run_id });
      }
    }
    entries.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    const page = entries.slice(0, limit);
    // the live picture, with the first page only: where HEAD is, what is uncommitted, how far ahead of the remote
    let working: Record<string, unknown> | null = null;
    if (git && before === '9999') {
      const head = gitOk(repo.path, ['log', '-1', '--format=%H%x1f%s%x1f%an%x1f%cI']);
      const [hSha, hSubject, hAuthor, hAt] = head.ok ? head.out.split('\x1f') : [];
      const dirty = dirtyPaths(repo.path);
      const lr = gitOk(repo.path, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
      const [behind, ahead] = lr.ok ? lr.out.split(/\s+/).map(Number) : [null, null];
      working = {
        branch: currentBranch(repo.path), head: hSha ? { sha: hSha, subject: hSubject, author: hAuthor, at: hAt } : null,
        dirty: { count: dirty.length, files: dirty.slice(0, 8) }, ahead, behind, upstream: lr.ok,
        task: q1(`SELECT id, label, task_id FROM repo_checkpoints WHERE repo_id = ? AND status = 'open' AND kind = 'general'`, repo.id) ?? null,
      };
    }
    ok(res, { entries: page, next: entries.length > limit ? String(page[page.length - 1].ts) : null, working });
  });

  // ---------------- commits
  app.get('/api/repos/:id/commits/:sha', (req, res) => {
    const repo = repoOf(req.params.id);
    if (!repo) return err(res, 404, 'repo not found');
    try {
      const info = commitInfo(repo.path, req.params.sha);
      const d = commitDiff(repo.path, info.sha, req.query.against ? String(req.query.against) : undefined);
      const link = q1('SELECT id, task_id FROM repo_checkpoints WHERE commit_sha = ?', info.sha);
      const task = link?.task_id ? getTask(link.task_id as string) : undefined;
      const agents = link?.task_id ? q(`SELECT DISTINCT agent_id FROM repo_checkpoints WHERE task_id = ? AND kind = 'agent'`, link.task_id).map((a) => getAgent(a.agent_id as string)?.name).filter(Boolean) : [];
      ok(res, { ...info, files: d.files, diff: d.diff, task: task ? { id: task.id, title: task.title } : null, checkpointId: link?.id ?? null, agents, origin: link ? 'ai' : 'user' });
    } catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });

  app.post('/api/repos/:id/commits/:sha/revert', (req, res) => {
    const repo = repoOf(req.params.id);
    if (!repo) return err(res, 404, 'repo not found');
    const busy = q1(`SELECT label FROM repo_checkpoints WHERE repo_id = ? AND status = 'open'`, repo.id);
    if (busy && !req.body?.dryRun) return err(res, 409, `"${busy.label}" is working in this repository right now — pause the run first`);
    try {
      const r = revertCommit(repo.path, req.params.sha, !!req.body?.reapply, !!req.body?.dryRun);
      if (r.ok && !req.body?.dryRun) emit(req.body?.reapply ? 'commit.reapplied' : 'commit.reverted', 'owner', { repoId: repo.id, sha: req.params.sha, newSha: r.sha, files: r.files.map((f) => f.path) });
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) { err(res, 500, String((e as Error).message ?? e)); }
  });

  app.post('/api/tasks/:id/commit', (req, res) => {
    const r = commitTask(req.params.id, String(req.body?.message ?? ''), true);
    if (r.ok) {
      run(`UPDATE approvals SET status = 'approved', reason = 'committed from the task', decided_at = datetime('now') WHERE task_id = ? AND action = 'commit.task' AND status = 'pending'`, req.params.id);
    }
    res.status(r.ok ? 200 : 409).json(r);
  });

  // ---------------- live diffs: one agent's work item, or a whole task so far
  app.get('/api/workitems/:id/diff', (req, res) => {
    const c = q1(`SELECT id FROM repo_checkpoints WHERE work_item_id = ? AND kind = 'agent' ORDER BY created_at DESC LIMIT 1`, req.params.id);
    if (!c) return ok(res, { files: [], diff: '', checkpointId: null, note: 'this work item did not run in a repository checkpoint (isolated mode or read-only desk)' });
    try { const cp = getCheckpoint(c.id as string)!; ok(res, { ...checkpointDiff(cp.id, req.query.file ? [String(req.query.file)] : []), checkpointId: cp.id, status: cp.status, written: true }); }
    catch (e) { err(res, 500, String((e as Error).message ?? e)); }
  });
  app.get('/api/tasks/:id/diff', (req, res) => {
    const task = getTask(req.params.id);
    const ids = (task?.meta?.checkpointIds as string[] | undefined) ?? [];
    const general = ids.map((id) => getCheckpoint(id)).filter((c) => c?.kind === 'general');
    if (!general.length) return ok(res, { files: [], diff: '', checkpoints: [] });
    try {
      // first general checkpoint's before → now (or the last one's after when finished)
      const first = general[0]!; const last = general[general.length - 1]!;
      const d = last.status === 'open' || !last.afterTree ? checkpointDiff(first.id) : compare({ id: first.id, side: 'before' }, { id: last.id, side: 'after' });
      ok(res, { ...d, checkpoints: general.map((c) => c!.id), status: last.status });
    } catch (e) { err(res, 500, String((e as Error).message ?? e)); }
  });

  // ---------------- per-task record: request → prompts → work → review → result
  app.get('/api/tasks/:id/record', (req, res) => {
    const task = getTask(req.params.id);
    if (!task) return err(res, 404, 'task not found');
    const runRow = q1('SELECT goal, repo_id FROM runs WHERE id = ?', task.runId);
    const items = q(`SELECT w.id, w.kind, w.attempt, w.status, w.agent_id, COALESCE(w.started_at, p.created_at) AS created_at, w.finished_at, w.result, p.template_id, p.version, p.rendered_text
                     FROM work_items w LEFT JOIN prompt_versions p ON p.id = w.prompt_version_id WHERE w.task_id = ? ORDER BY w.rowid`, task.id)
      .map((w) => {
        const result = parseJson<Record<string, any>>(w.result as string, {});
        const raw = (result.raw?.json ?? result.raw ?? {}) as Record<string, unknown>;
        return { id: w.id, kind: w.kind, attempt: w.attempt, status: w.status, agent: getAgent(w.agent_id as string)?.name ?? null, at: w.created_at, finishedAt: w.finished_at,
          template: w.template_id, prompt: w.rendered_text, summary: result.summary ?? null, decision: raw.decision ?? null, notes: raw.notes ?? raw.summary ?? null,
          draftedPrompt: w.kind === 'prompt' ? (raw.prompt ?? null) : null, filesChanged: result.filesChanged ?? null };
      });
    const approved = [...items].reverse().find((w) => String(w.template ?? '').endsWith('/approved') && w.kind === 'implement')
      ?? items.find((w) => w.kind === 'implement');
    const checks = q(`SELECT c.name, cr.status, cr.summary, cr.created_at FROM check_runs cr JOIN checks c ON c.id = cr.check_id WHERE cr.task_id = ? ORDER BY cr.created_at`, task.id);
    const decisions = q(`SELECT type, actor, ts, payload FROM events WHERE entity_id = ? AND type IN ('qa.decided','review.decided','accept.decided','prompt.reviewed','prompt.drafted','commit.created','commit.failed','sod.waived') ORDER BY seq`, task.id)
      .map((e) => ({ type: e.type, actor: e.actor, ts: e.ts, ...parseJson<Record<string, unknown>>(e.payload as string, {}) }));
    const repo = runRow ? q1('SELECT path FROM repos WHERE id = ?', runRow.repo_id) : null;
    let notes = '';
    for (const p of [path.join(DATA_DIR, 'handoff', `${task.id}.md`), `.office/handoff/${task.id}.md`, 'HANDOFF.md']) {
      const base = task.worktree ?? (repo?.path as string | undefined);
      if (!base) break;
      try { notes = fs.readFileSync(path.resolve(base, p), 'utf8'); break; } catch { /* next */ }
    }
    ok(res, {
      request: runRow?.goal ?? null,
      task: { id: task.id, title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, status: task.status, type: task.type },
      approvedPrompt: approved ? { workItemId: approved.id, text: approved.prompt, template: approved.template } : null,
      items, checks, decisions, changeNotes: notes,
      checkpoints: listCheckpoints({ taskId: task.id, limit: 200 }).map(withNames).reverse(),
      commit: task.meta?.commitProposal ?? null,
    });
  });
}
