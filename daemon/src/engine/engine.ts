import { DATA_DIR, q, q1, run, tx } from '../db.ts';
import { bindToRun, manifestFingerprint, manifestSection, removeAttachment } from '../services/attachments.ts';
import { appInfo, appLog, diagnose, openBrowser, probeRoutes, safeRoutePath, startApp, stopApp, type AppInfo, type Diagnostics } from '../services/app-launcher.ts';
import { emit, onEvent } from '../bus.ts';
import { anyGlobMatch, compactLog, minutesFromNow, now, parseJson, sha256, shortId, ulid } from '../util.ts';
import { rowToCycle, rowToRun, rowToTask, rowToWorkItem } from '../rows.ts';
import type {
  Check, DodItem, PlanDiff, PlanTaskSpec, Repo, Run, StopLimits, Task,
  TaskStatus, WorkItem, WorkItemKind, WorkItemResult, Workspace,
} from '../types.ts';
import {
  changedFiles, commitAll, createWorktree, diffText, ensureIntegration, gitOk,
  headSha, mergeIntoIntegration, removeWorktree, renameBranch, taskBranch,
} from '../services/git.ts';
import { checkByName, deriveChecks, repoChecks, runCheck } from '../services/verify.ts';
import { fileErrorReport, lessonsFor, openErrorBySignature, recordReviewerFlag, resolveError, rowToError } from '../services/errors.ts';
import { buildContextPack, type ContextPack } from '../services/context.ts';
import { finalizeApprovedPrompt, renderPrompt, type RenderedPrompt } from './prompts.ts';
import {
  candidatesForRole, dispatchThroughAdapter, getAgent, getAccount, pickAgent,
  type Candidate,
} from '../services/router.ts';
import { contextBudget } from '../services/models.ts';
import { extractMessages, formatInbox, postMessage, takeInbox } from '../services/messages.ts';
import { envelopeText, handoffEnvelope, STRICT_REPLY_KINDS, validateReply } from '../services/handoffs.ts';
import { backoffDelayMs, classifyFailure, fixHintFor, notifyOnce } from '../services/failure.ts';
import { getAdapter } from '../adapters/index.ts';
import { killCliChildrenForRun } from '../adapters/cli.ts';
import { classifyChangeRisk, requestApproval, resolveAction, scanDeliveredFiles } from '../services/policy.ts';
import { AdapterError } from '../adapters/types.ts';
import { beginCheckpoint, endCheckpoint, getCheckpoint, recoverInterruptedCheckpoints, setCheckpointCommit, type Checkpoint } from '../services/checkpoints.ts';
import { changedFilesBetween, displayDiff, liveChanges, snapshotTree, snapshotTreeAsync, snapshotTreeRecent } from '../services/snapshot.ts';
import { buildCommitMessage, commitPaths, currentBranch, dirtyPaths, planTaskCommit } from '../services/commits.ts';
import { skillsFor } from '../services/skills.ts';
import { finalizeRunSummary } from '../services/summary.ts';
import {
  activeWorkflowFor, getWorkflowVersion, latestVersionOf, DEFAULT_MAX_LOOPS,
  type WfCondition, type WfEdge, type WfGraph, type WfNode,
} from '../services/workflow.ts';
import path from 'node:path';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// The workflow engine owns the build loop (spec section 5). Agents are called
// only at decision points: plan, implement, review, analyse, fix. Everything
// here is deterministic: states, budgets, checks, stop rules.
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS: StopLimits = {
  maxCycles: 30, maxWallclockMin: 2880, maxParallel: 3, maxReadOnly: 2,
  sameErrorAttempts: 3, noProgressCycles: 3, disagreeK: 3,
  stuckAgentMinApi: 10, stuckAgentMinHosted: 45, cycleMaxMinutes: 60,
};

const TERMINAL_TASK: TaskStatus[] = ['done', 'approved', 'failed', 'cancelled'];
const ACTIVE_TASK: TaskStatus[] = ['assigned', 'in-progress', 'verifying', 'in-review', 'changes-requested', 'waiting-input'];
const IN_FLIGHT_WI = ['queued', 'running', 'waiting'];

export function getRun(id: string): Run | undefined {
  const r = q1('SELECT * FROM runs WHERE id = ?', id);
  return r ? rowToRun(r) : undefined;
}
export function getTask(id: string): Task | undefined {
  const r = q1('SELECT * FROM tasks WHERE id = ?', id);
  return r ? rowToTask(r) : undefined;
}
export function getWorkItem(id: string): WorkItem | undefined {
  const r = q1('SELECT * FROM work_items WHERE id = ?', id);
  return r ? rowToWorkItem(r) : undefined;
}
export function getRepo(id: string | null | undefined): Repo | undefined {
  if (!id) return undefined;
  const r = q1('SELECT * FROM repos WHERE id = ?', id);
  if (!r) return undefined;
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, path: r.path as string,
    remoteUrl: r.remote_url as string | null, defaultBranch: r.default_branch as string,
    integrationBranch: r.integration_branch as string, buildCmd: r.build_cmd as string,
    testCmd: r.test_cmd as string, checkProfileId: r.check_profile_id as string | null,
  };
}
export function getWorkspace(id: string): Workspace | undefined {
  const r = q1('SELECT * FROM workspaces WHERE id = ?', id);
  if (!r) return undefined;
  return {
    id: r.id as string, name: r.name as string, purpose: r.purpose as string,
    repoIds: parseJson(r.repo_ids as string, []), allowedProviderIds: parseJson(r.allowed_provider_ids as string, []),
    policyId: r.policy_id as string | null, memoryScope: r.memory_scope as string,
    settings: parseJson(r.settings as string, {}),
  };
}

function setRunStatus(runId: string, status: Run['status'], extra: Record<string, unknown> = {}): void {
  run(`UPDATE runs SET status = ?${extra.stopReason !== undefined ? ', stop_reason = ?' : ''} WHERE id = ?`,
    ...(extra.stopReason !== undefined ? [status, extra.stopReason, runId] : [status, runId]));
  // spec 6.6: a terminal run gets a stored summary built from tables only —
  // no model call. Paused/stopped states stay live, so summarize the finals.
  if (status === 'done' || status === 'stopped') finalizeRunSummary(runId);
  emit('run.status', 'engine', { status, ...extra }, runId, runId);
}

function setTaskStatus(taskId: string, status: TaskStatus, actor = 'engine', extra: Record<string, unknown> = {}): void {
  run('UPDATE tasks SET status = ? WHERE id = ?', status, taskId);
  if (['done', 'failed', 'cancelled', 'blocked'].includes(status)) { closeTaskCheckpoint(taskId); stopApp(taskId); }
  const t = getTask(taskId);
  emit('task.status', actor, { taskId, status, title: t?.title, ...extra }, t?.runId ?? null, taskId);
}

// A task's first items (plan, prompt drafting, implement) get the repo tour;
// downstream stages get only what the task changed. Desk jobs (accept, prompt
// pipeline) get no repository context at all.
const TASK_SCOPE_KINDS: WorkItemKind[] = ['qa', 'review', 'fix', 'analyse'];

// Context pack sized to the agent's configured context limit (spec 3).
function packFor(repo: Repo | null | undefined, task: Task | null, c: Candidate, wanted: number, kind?: WorkItemKind, opts: { diffChars?: number } = {}): ContextPack {
  const scope = kind && TASK_SCOPE_KINDS.includes(kind) ? 'task' : 'repo';
  const hasTools = ['cli', 'devin'].includes(c.provider?.adapterId ?? '');
  const changed = scope === 'task' && repo && task ? taskFiles(repo, task).slice(0, 24) : [];
  // reviewers/QA get the size-capped diff instead of full files when it is
  // smaller; a fixer always gets excerpts (it edits those files); tool-less
  // adapters are the only ones that need excerpts at all.
  let excerpts = false;
  if (scope === 'task' && !hasTools) {
    if (kind === 'fix') excerpts = true;
    else if (opts.diffChars != null && repo) {
      const est = changed.slice(0, 8).reduce((s, f) => {
        try { return s + Math.min(fs.statSync(path.join(repo.path, f)).size, 9600); } catch { return s; }
      }, 0);
      excerpts = opts.diffChars > est;
    }
  }
  const pack = buildContextPack({
    repo: repo ?? null, task, tokenBudget: contextBudget(c.agent.settings, c.model, wanted),
    scope, changedFiles: changed, excerpts, basePath: task?.worktree ?? undefined,
  });
  // CLI agents (Claude Code, Cursor, Devin) open files with their own tools —
  // pasting excerpts too made every prompt pay for the same files twice. They
  // get the paths; API models (no tools) still get the excerpts.
  if (hasTools && pack.files.length) {
    const list = pack.files.map((f) => `- ${f.path}`).join('\n');
    return { ...pack, files: [], repoSummary: `${pack.repoSummary}\n\nRelevant files (open them yourself as needed):\n${list}`.trim() };
  }
  return pack;
}

// Per-repo lessons for a task's next prompt (spec 6.5): at most 3, ~300 tokens.
function lessonNotes(r: Run, task: Task, extraFiles: string[] = []): string | undefined {
  const lessons = lessonsFor({
    workspaceId: r.workspaceId, repoId: r.repoId,
    files: [...task.affectedPaths, ...extraFiles],
    text: `${task.title} ${task.description} ${task.acceptanceCriteria.join(' ')}`,
  });
  if (!lessons.length) return undefined;
  const text = lessons.map((l) => `- ${l.text}`).join('\n');
  emit('lessons.injected', 'engine', { taskId: task.id, count: lessons.length, chars: text.length }, r.id, task.id);
  return text;
}

// No repository context at all — the budget still applies to the prompt.
function deskPack(c: Candidate, wanted: number, hash = 'desk'): ContextPack {
  return { repoSummary: '', files: [], errors: [], kbNotes: [], hash, approxTokens: 0, budgetChars: contextBudget(c.agent.settings, c.model, wanted) * 4 };
}

// Unread team messages for this agent, rendered for its prompt.
function inboxText(c: Candidate, runId: string, taskId: string | null): string {
  return formatInbox(takeInbox(c.agent.id, c.role?.name ?? null, runId, taskId));
}

// A pending requirement change note is delivered with the task's next prompt once.
function takeRequirementNote(task: Task | null): string | undefined {
  const note = task?.meta?.requirementsChanged as string | undefined;
  if (note && task) run(`UPDATE tasks SET meta = json_remove(meta, '$.requirementsChanged') WHERE id = ?`, task.id);
  return note;
}

function setTaskMeta(taskId: string, key: string, value: unknown): void {
  run(`UPDATE tasks SET meta = json_set(COALESCE(NULLIF(meta, ''), '{}'), ?, json(?)) WHERE id = ?`, `$.${key}`, JSON.stringify(value ?? null), taskId);
}

// ---------------------------------------------------------------------------
// Work mode (workspace setting workMode):
//   'direct' (default) — agents work inside the selected repository itself,
//     on the branch you have checked out, like a coding CLI. Code tasks run
//     one at a time; every task gets a general checkpoint and every agent
//     work item an agent checkpoint, so either can be undone. Nothing is
//     committed except per the commit policy (commitMode).
//   'isolated' — the original flow: a git worktree + agent/<task> branch per
//     task, merged into the integration branch.
// ---------------------------------------------------------------------------

function isDirect(r: Run | undefined): boolean {
  return !!r && getWorkspace(r.workspaceId)?.settings?.workMode !== 'isolated';
}

// The developer's change notes: in direct mode they live in the daemon's own data
// folder (absolute path), so nothing is ever created inside the user's repository.
function handoffPath(task: Task, direct: boolean): string {
  return direct ? path.join(DATA_DIR, 'handoff', `${task.id}.md`) : 'HANDOFF.md';
}

function taskCheckpoint(task: Task): Checkpoint | undefined {
  const id = task.meta?.generalCheckpointId as string | undefined;
  return id ? getCheckpoint(id) : undefined;
}

// A direct-mode task holds the repository from its first dispatch until it
// is finished, failed, blocked or cancelled.
function holdsRepo(task: Task): boolean {
  return taskCheckpoint(task)?.status === 'open';
}

function openTaskCheckpoint(r: Run, repo: Repo, task: Task): void {
  if (holdsRepo(task)) return;
  const dirty = dirtyPaths(repo.path);
  if (dirty.length) {
    // the snapshot keeps them out of the task's changes; they are never committed with it
    emit('repo.dirty', 'engine', { taskId: task.id, files: dirty.slice(0, 50), count: dirty.length,
      note: 'uncommitted changes found before the task started — preserved and excluded from this task' }, r.id, task.id);
  }
  const resumed = !!task.meta?.generalCheckpointId;
  const cp = beginCheckpoint({ repoId: repo.id, kind: 'general', label: `${resumed ? 'Resumed: ' : ''}${task.title}`, prompt: r.goal, runId: r.id, taskId: task.id });
  setTaskMeta(task.id, 'generalCheckpointId', cp.id);
  setTaskMeta(task.id, 'checkpointIds', [...((task.meta?.checkpointIds as string[]) ?? []), cp.id]);
  setTaskMeta(task.id, 'dirtyAtStart', dirty.slice(0, 200));
}

function closeTaskCheckpoint(taskId: string): void {
  const t = getTask(taskId);
  if (!t) return;
  const cp = taskCheckpoint(t);
  if (cp?.status === 'open') { try { endCheckpoint(cp.id); } catch (e) { emit('checkpoint.error', 'engine', { taskId, error: String(e).slice(0, 300) }, t.runId, taskId); } }
}

// Files and diff of everything the task changed so far. These only feed
// prompt context — a seconds-old tree is fine and halves the snapshots a
// delivery takes (checkpoints themselves always snapshot exactly).
function taskFiles(repo: Repo, task: Task): string[] {
  const cp = taskCheckpoint(task);
  if (!cp) return task.worktree ? changedFiles(task.worktree, repo.integrationBranch) : [];
  return changedFilesBetween(repo.path, cp.beforeTree, snapshotTreeRecent(repo.path)).map((f) => f.path).filter((p) => !p.startsWith('.office/'));
}
function taskDiff(repo: Repo, task: Task): string {
  const cp = taskCheckpoint(task);
  if (!cp) return task.worktree ? diffText(task.worktree, repo.integrationBranch) : '';
  return displayDiff(repo.path, cp.beforeTree, snapshotTreeRecent(repo.path));
}

function execGit(repoPath: string, args: string[]): string {
  return gitOk(repoPath, args).out;
}

function runTasks(runId: string, statuses?: TaskStatus[]): Task[] {
  const rows = statuses?.length
    ? q(`SELECT * FROM tasks WHERE run_id = ? AND status IN (${statuses.map(() => '?').join(',')})`, runId, ...statuses)
    : q('SELECT * FROM tasks WHERE run_id = ?', runId);
  return rows.map(rowToTask);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export function createRun(opts: { workspaceId: string; goal: string; budgetUsd?: number; repoId?: string; oneShot?: boolean; limits?: Partial<StopLimits>; workflowId?: string | null; attachmentIds?: string[] }): Run {
  const ws = getWorkspace(opts.workspaceId);
  if (!ws) throw new Error('workspace not found');
  const repoId = opts.repoId ?? ws.repoIds[0];
  const repo = getRepo(repoId);
  if (!repo) throw new Error('workspace has no repo');
  if (ws.settings?.workMode === 'isolated') ensureIntegration(repo);

  const runId = ulid();
  const dodId = ulid();
  // runs pin the workspace's active workflow version at creation so a later
  // edit can't change a run mid-flight
  // workflowId: undefined = the workspace default; "builtin" = the standard pipeline; else a saved workflow
  const chosen = opts.workflowId && opts.workflowId !== "builtin" ? latestVersionOf(opts.workflowId) : null;
  if (opts.workflowId && opts.workflowId !== "builtin" && !chosen) throw new Error("workflow not found or has no saved version");
  const wf = opts.workflowId === "builtin" ? null : chosen ?? activeWorkflowFor(ws.id);
  tx(() => {
    run(`INSERT INTO runs (id, workspace_id, repo_id, goal, status, dod_id, budget, limits, current_cycle, started_at, workflow_version_id)
         VALUES (?,?,?,?,?,?,?,?,0,?,?)`,
      runId, ws.id, repoId, opts.goal, 'draft', dodId,
      JSON.stringify({ runUsd: opts.budgetUsd ?? 50, taskUsd: 10, warnPct: 80 }),
      JSON.stringify({ ...DEFAULT_LIMITS, ...(opts.limits ?? {}), ...(opts.oneShot ? { maxCycles: 1, oneShot: true } : {}) }), null,
      wf?.versionId ?? null);
    run(`INSERT INTO dod (id, run_id, version, items, status) VALUES (?,?,1,'[]','draft')`, dodId, runId);
  });
  emit('run.created', 'owner', { goal: opts.goal }, runId, runId);
  if (wf) emit('workflow.run', 'engine', { workflowId: wf.workflowId, versionId: wf.versionId, v: q1('SELECT n FROM workflow_versions WHERE id = ?', wf.versionId)?.n ?? null }, runId);
  if (opts.attachmentIds?.length) bindToRun(opts.attachmentIds, runId, ws.id);
  // Bootstrap phase: PM drafts DoD + initial task graph
  void dispatchPlan(runId, true);
  return getRun(runId)!;
}

// Switch the workflow a run follows. Only while nothing is mid-flight on the
// old graph (its node ids would not exist on the new one).
export function setRunWorkflow(runId: string, workflowId: string): { ok: true } | { error: string } {
  const r = getRun(runId);
  if (!r) return { error: 'run not found' };
  if (!['draft', 'dod-review', 'paused'].includes(r.status)) return { error: 'pause the run first (or wait for it to finish) to change its workflow' };
  const mid = q(`SELECT id, meta FROM tasks WHERE run_id = ? AND status NOT IN ('done','cancelled')`, runId)
    .some((t) => { try { return ((JSON.parse((t.meta as string) || '{}').wf?.nodes ?? []).length > 0); } catch { return false; } });
  if (mid) return { error: 'tasks are mid-flow on the current workflow — let them finish or stop the run' };
  let versionId: string | null = null;
  if (workflowId !== 'builtin') {
    const wf = latestVersionOf(workflowId);
    if (!wf) return { error: 'workflow not found or has no saved version' };
    versionId = wf.versionId;
  }
  run('UPDATE runs SET workflow_version_id = ? WHERE id = ?', versionId, runId);
  wfGraphCache.delete(runId);
  emit('workflow.run', 'owner', { workflowId, versionId, switched: true }, runId);
  return { ok: true };
}

// ---- live workflow edits ---------------------------------------------------------------------------------------
// Saving a workflow while a run follows it must not disturb work in flight, and the run should use the new version from
// then on. A task mid-flow is identified by node ids, so the new version can take over as soon as every step that
// currently has work (running, waiting for the owner, parked, or stalled) still exists in it as the same kind of step.
// Anything added, rewired or reconfigured applies at once; if a running step was removed, the switch waits for it.

function nodesInFlight(runId: string): { taskTitle: string; nodeId: string }[] {
  const out: { taskTitle: string; nodeId: string }[] = [];
  for (const t of q(`SELECT title, meta FROM tasks WHERE run_id = ? AND status NOT IN ('done','cancelled','failed')`, runId)) {
    const wf = parseJson<Record<string, any>>(t.meta as string, {}).wf as Partial<WfState> | undefined;
    if (!wf) continue;
    const ids = new Set<string>([...(wf.nodes ?? []), ...(wf.queued ?? []), ...(wf.awaiting?.nodeId ? [wf.awaiting.nodeId] : []), ...(wf.held ? [wf.held] : []), ...(wf.deadEndNode ? [wf.deadEndNode] : [])]);
    for (const nodeId of ids) out.push({ taskTitle: t.title as string, nodeId });
  }
  return out;
}

/** Why the run cannot switch to this version right now (empty: it can). */
export function adoptBlockers(runId: string, to: WfGraph): string[] {
  const r = getRun(runId);
  const cur = r ? graphFor(r)?.graph : null;
  const blockers: string[] = [];
  for (const f of nodesInFlight(runId)) {
    const next = to.nodes.find((n) => n.id === f.nodeId);
    const prev = cur?.nodes.find((n) => n.id === f.nodeId);
    if (!next) blockers.push(`“${prev?.label ?? f.nodeId}” is still working on “${f.taskTitle}” but is not in the new version`);
    else if (prev && prev.type !== next.type) blockers.push(`“${prev.label}” changed kind while it is working on “${f.taskTitle}”`);
  }
  return blockers;
}

export function adoptWorkflowVersion(runId: string, versionId: string): { adopted: boolean; pending?: boolean; blockers?: string[] } {
  const r = getRun(runId);
  const v = getWorkflowVersion(versionId);
  if (!r || !v || ['done', 'stopped', 'failed'].includes(r.status) || !r.workflowVersionId || r.workflowVersionId === versionId) return { adopted: false };
  const blockers = adoptBlockers(runId, v.graph);
  if (blockers.length) {
    run('UPDATE runs SET pending_workflow_version_id = ? WHERE id = ?', versionId, runId);
    emit('workflow.pending', 'engine', { versionId, n: v.version.n, blockers }, runId);
    return { adopted: false, pending: true, blockers };
  }
  run('UPDATE runs SET workflow_version_id = ?, pending_workflow_version_id = NULL WHERE id = ?', versionId, runId);
  wfGraphCache.delete(runId);
  emit('workflow.adopted', 'engine', { from: r.workflowVersionId, versionId, n: v.version.n }, runId);
  // work that was parked or waiting on a step that now exists differently picks up the new definition
  void maybeAdvanceRun(runId);
  return { adopted: true };
}

/** Move one run to the newest saved version of the workflow it follows. */
export function adoptLatestForRun(runId: string): { adopted: boolean; pending?: boolean; blockers?: string[]; error?: string } {
  const r = getRun(runId);
  if (!r) return { adopted: false, error: 'run not found' };
  if (!r.workflowVersionId) return { adopted: false, error: 'this run follows the built-in flow, which has no versions' };
  const latest = q1('SELECT w.latest_version_id l FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.id = ?', r.workflowVersionId)?.l as string | undefined;
  if (!latest || latest === r.workflowVersionId) return { adopted: false, error: 'this run already follows the latest version' };
  return adoptWorkflowVersion(runId, latest);
}

/** A new version of a workflow was saved: every live run that follows that workflow switches to it. */
export function adoptSavedVersion(workflowId: string, versionId: string): void {
  for (const r of q(`SELECT r.id FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE v.workflow_id = ? AND r.status NOT IN ('done','stopped','failed')`, workflowId)) {
    adoptWorkflowVersion(r.id as string, versionId);
  }
}

/** Retry a switch that was waiting on a step to finish. */
function retryPendingAdoption(runId: string): void {
  const p = q1('SELECT pending_workflow_version_id p FROM runs WHERE id = ?', runId)?.p as string | null | undefined;
  if (!p) return;
  const latest = q1('SELECT w.latest_version_id l FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.id = ?', p)?.l as string | undefined;
  adoptWorkflowVersion(runId, latest ?? p);
}

// A task the owner adds while a run is going (Live activity, the Tasks board): it enters as ready, and the next assign
// sweep hands it to whichever eligible agent is free, exactly like a planned task. Nothing in flight is touched.
export interface UserWorkItem { id: string; title: string; instructions: string }

export function createUserTask(runId: string, spec: {
  title: string; description?: string; priority?: number; difficulty?: number; hold?: boolean;
  workItems?: { title?: string; instructions?: string }[];
}): Task | { error: string } {
  const r = getRun(runId);
  if (!r) return { error: 'run not found' };
  if (['done', 'stopped', 'failed'].includes(r.status)) return { error: `this run is ${r.status} — start a new run to add work` };
  const title = String(spec.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return { error: 'the task needs a title' };
  if (title.length > 200) return { error: 'the title is too long (200 characters at most)' };
  const rawItems = Array.isArray(spec.workItems) ? spec.workItems : [];
  if (rawItems.length > 20) return { error: 'a task holds at most 20 work items — split it into several tasks' };
  const items: UserWorkItem[] = [];
  for (const w of rawItems) {
    const t = String(w?.title ?? '').replace(/\s+/g, ' ').trim();
    const ins = String(w?.instructions ?? '').trim();
    if (!t && !ins) continue;                                   // an empty row is just ignored
    if (!t) return { error: 'every work item needs a short title' };
    if (t.length > 200) return { error: 'a work item title is too long (200 characters at most)' };
    if (ins.length > 4000) return { error: `the instructions for "${t}" are too long (4000 characters at most)` };
    items.push({ id: `w${items.length + 1}`, title: t, instructions: ins });
  }
  let description = String(spec.description ?? '').trim().slice(0, 8000);
  if (items.length) {
    // every prompt already carries the task's description and acceptance criteria — the work items ride along in both
    const list = items.map((w, i) => `${i + 1}. ${w.title}${w.instructions ? `\n   Instructions: ${w.instructions.replace(/\n/g, '\n   ')}` : ''}`).join('\n');
    description = [description, `## Work items\n${list}`].filter(Boolean).join('\n\n');
  }
  const id = `T-${shortId('')}u`.replace('T--', 'T-');
  const criteria = items.length
    ? [...items.map((w, i) => `Work item ${i + 1} is done: ${w.title}`), 'Existing behaviour keeps working']
    : [`${title} works as described`, 'Existing behaviour keeps working'];
  // on hold: kept on the board, never dispatched; otherwise before the DoD is approved it waits like the planned tasks
  const status: TaskStatus = spec.hold ? 'held' : r.status === 'running' ? 'ready' : 'backlog';
  run(`INSERT INTO tasks (id, run_id, title, description, type, status, priority, depends_on, acceptance_criteria, deliverables, planned_by, difficulty, budget_usd, dod_item_ids, affected_paths, meta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, runId, title, description, 'feature', status, Math.max(0, Math.min(9, Number(spec.priority ?? 1) || 1)),
    '[]', JSON.stringify(criteria), '[]', 'owner', Math.max(1, Math.min(5, Number(spec.difficulty ?? 2) || 2)), 5, '[]', '[]', JSON.stringify({ createdBy: 'owner', workItems: items }));
  emit('task.created', 'owner', { taskId: id, title, by: 'owner', held: !!spec.hold, workItems: items.length }, runId, id);
  void maybeAdvanceRun(runId);
  return getTask(id)!;
}

// The owner moving a card. Only two destinations are the owner's to choose: Ready (hand it to the agents) and On hold
// (keep it, but nobody works on it). In progress, In review, Done and Failed are facts the workflow produces from what
// the agents actually did — they can never be set by hand, here or through the API.
export function moveTask(taskId: string, to: string): { task: Task } | { error: string; status: number } {
  const t = getTask(taskId);
  if (!t) return { error: 'task not found', status: 404 };
  const r = getRun(t.runId);
  if (!r) return { error: 'run not found', status: 404 };
  if (to !== 'ready' && to !== 'held') {
    return { error: `"${to}" is set by the workflow from what the agents actually do — you can only move a task to Ready or On hold`, status: 409 };
  }
  if (to === 'held') {
    if (t.status === 'held') return { task: t };
    if (!['backlog', 'ready', 'blocked-quota'].includes(t.status)) {
      return { error: `this task is ${t.status.replace(/-/g, ' ')} — an agent has already started on it, so it can't be put on hold`, status: 409 };
    }
    const dependents = runTasks(t.runId).filter((x) => x.dependsOn.includes(t.id) && !['done', 'cancelled', 'failed', 'held'].includes(x.status));
    if (dependents.length) return { error: `${dependents.map((d) => `"${d.title}"`).join(', ')} wait${dependents.length === 1 ? 's' : ''} for this task — hold or delete ${dependents.length === 1 ? 'it' : 'them'} first`, status: 409 };
    setTaskMeta(t.id, 'heldFrom', t.status);
    setTaskStatus(t.id, 'held', 'owner', { reason: 'put on hold by the owner' });
    return { task: getTask(t.id)! };
  }
  // to ready
  if (t.status === 'ready' || t.status === 'backlog') return { task: t };
  if (t.status !== 'held') return { error: `this task is ${t.status.replace(/-/g, ' ')} — only a task that is on hold can be moved back to Ready`, status: 409 };
  if (['done', 'stopped', 'failed'].includes(r.status)) return { error: `this run is ${r.status} — start a new run to add work`, status: 409 };
  setTaskStatus(t.id, r.status === 'running' ? 'ready' : 'backlog', 'owner', { reason: 'released from hold by the owner' });
  void maybeAdvanceRun(t.runId);
  return { task: getTask(t.id)! };
}

// Removing a task from the board. Refused while an agent is on it; the repository, commits and checkpoints are never
// touched (undo them from Checkpoints), and other tasks stop waiting for it.
export function deleteTask(taskId: string): { ok: true; title: string } | { error: string; status: number } {
  const t = getTask(taskId);
  if (!t) return { error: 'task not found', status: 404 };
  const live = q1(`SELECT COUNT(*) c FROM work_items WHERE task_id = ? AND status IN ('queued','running','waiting')`, t.id)?.c as number;
  if (live > 0 || ['in-progress', 'verifying', 'in-review'].includes(t.status)) {
    return { error: 'an agent is working on this task right now — wait for it to finish, or stop the run, then delete it', status: 409 };
  }
  closeTaskCheckpoint(t.id);        // a task waiting on the owner still holds the repository; release it (its changes stay in the working tree)
  tx(() => {
    for (const other of runTasks(t.runId)) {
      if (other.dependsOn.includes(t.id)) run('UPDATE tasks SET depends_on = ? WHERE id = ?', JSON.stringify(other.dependsOn.filter((d) => d !== t.id)), other.id);
    }
    for (const a of q('SELECT id FROM attachments WHERE task_id = ?', t.id)) removeAttachment(a.id as string);
    run(`DELETE FROM approvals WHERE task_id = ? AND status = 'pending'`, t.id);
    run('DELETE FROM prompt_versions WHERE work_item_id IN (SELECT id FROM work_items WHERE task_id = ?)', t.id);
    run('DELETE FROM work_items WHERE task_id = ?', t.id);
    run('DELETE FROM check_runs WHERE task_id = ?', t.id);
    run('DELETE FROM error_reports WHERE task_id = ?', t.id);
    run('DELETE FROM handoffs WHERE task_id = ?', t.id);
    run('DELETE FROM agent_messages WHERE task_id = ?', t.id);
    run('DELETE FROM tasks WHERE id = ?', t.id);
  });
  try { fs.rmSync(path.join(DATA_DIR, 'handoff', `${t.id}.md`), { force: true }); } catch { /* notes are a courtesy */ }
  stopApp(t.id);
  emit('task.deleted', 'owner', { taskId: t.id, title: t.title, status: t.status }, t.runId, t.id);
  void maybeAdvanceRun(t.runId);
  return { ok: true, title: t.title };
}

export function approveDod(runId: string): void {
  const r = getRun(runId);
  if (!r || r.status !== 'dod-review') return;
  run(`UPDATE dod SET status = 'approved' WHERE id = ?`, r.dodId);
  run(`UPDATE runs SET status = 'running', started_at = ? WHERE id = ?`, now(), runId);
  emit('run.started', 'owner', {}, runId, runId);
  // the bootstrap plan's build phase is cycle 1 (later cycles open in beginCycle)
  if (r.currentCycle === 0) {
    run('UPDATE runs SET current_cycle = 1 WHERE id = ?', runId);
    const cid = ulid();
    run(`INSERT INTO cycles (id, run_id, n, phase, started_at, progress_score, spend_usd) VALUES (?,?,1,'build',?,?,?)`, cid, runId, now(), r.progressScore, r.spentUsd);
    emit('cycle.started', 'engine', { n: 1 }, runId, cid);
  }
  for (const t of runTasks(runId, ['backlog'])) setTaskStatus(t.id, 'ready');
  scheduleTimer(runId, DEFAULT_LIMITS.cycleMaxMinutes, 'timer.cycleMax', {});
  void maybeAdvanceRun(runId);
}

export function pauseRun(runId: string, hard = false): void {
  const r = getRun(runId);
  if (!r || r.status !== 'running') return;
  setRunStatus(runId, 'pausing', { hard });
  const inFlight = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND status IN ('queued','running')`, runId)?.c as number;
  if (hard) {
    // kill agent CLI children first — their close handlers must still see the
    // cancelled status below, so mark items after the kill fires
    killCliChildrenForRun(runId);
    for (const wi of q(`SELECT id FROM work_items WHERE run_id = ? AND status IN ('queued','running')`, runId)) {
      run(`UPDATE work_items SET status = 'cancelled', finished_at = ? WHERE id = ?`, now(), wi.id);
      emit('workitem.cancelled', 'owner', { hard: true }, runId, wi.id as string);
    }
    setRunStatus(runId, 'paused');
  } else if (inFlight === 0) {
    setRunStatus(runId, 'paused');
  }
}

export function resumeRun(runId: string): void {
  const r = getRun(runId);
  if (!r || (r.status !== 'paused' && r.status !== 'stopped')) return;
  setRunStatus(runId, 'running');
  void maybeAdvanceRun(runId);
}

export function stopRun(runId: string, reason = 'OWNER'): void {
  setRunStatus(runId, 'stopped', { stopReason: reason });
  const open = q(`SELECT id, agent_id FROM work_items WHERE run_id = ? AND status IN ('queued','running','waiting')`, runId);
  // cancelled first, so a process that dies now (and the router's fallback logic) sees that this was a stop
  for (const wi of open) run(`UPDATE work_items SET status = 'cancelled', finished_at = ? WHERE id = ?`, now(), wi.id);
  killCliChildrenForRun(runId);
  for (const t of q('SELECT id FROM tasks WHERE run_id = ?', runId)) stopApp(t.id as string);
  // nothing of this run is working any more: free its agents and the CLI sessions they were holding
  for (const wi of open) {
    run('UPDATE cli_sessions SET busy_item = NULL WHERE busy_item = ?', wi.id);
    const other = q1(`SELECT id FROM work_items WHERE agent_id = ? AND status IN ('queued','running') LIMIT 1`, wi.agent_id as string);
    if (!other) setAgentStatus(wi.agent_id as string, 'idle');
  }
}

// ---------------------------------------------------------------------------
// Planning (phase 1) — PM proposes; the engine validates and applies.
// ---------------------------------------------------------------------------

const pendingAnalysis = new Map<string, { checkRunId: string; taskId: string; checkName: string; files: string[] }>();
const pendingPlanDiff = new Map<string, { runId: string; diff: PlanDiff }>();
const planFailCount = new Map<string, number>();

async function dispatchPlan(runId: string, bootstrap: boolean): Promise<void> {
  const r = getRun(runId);
  if (!r) return;
  // a run-scope plan node may pin the planner (agent/role); default is the PM
  const planNode = graphFor(r)?.graph.nodes.find((n) => n.type === 'agent' && n.config?.scope === 'run' && n.config?.purpose === 'plan') ?? null;
  const candidate = planNode
    ? wfCandidate(r, null, planNode, 'plan', 3)
    : pickAgent(r.workspaceId, 'pm', null, 'plan', 3);
  if (!candidate) {
    emit('plan.unavailable', 'engine', { reason: 'no eligible PM agent; engine continues current plan' }, runId);
    if (bootstrap) {
      // No PM at all — ask the owner to supply a DoD via the approval inbox.
      requestApproval({
        action: 'dod.propose', runId, requestedBy: 'engine',
        payload: { summary: 'No Planner agent is eligible. Provide a DoD + task list manually via the DoD editor, then approve.', goal: r.goal },
      });
      setRunStatus(runId, 'dod-review');
    } else {
      assignSweep(runId);
    }
    return;
  }

  const repo = getRepo(r.repoId);
  const pack = packFor(repo, null, candidate, 20000);
  const cycleSummary = lastCycleSummary(runId);
  const dodRows = q1('SELECT items FROM dod WHERE id = ?', r.dodId);
  const prompt = renderPrompt({
    kind: 'plan', agent: candidate.agent, role: candidate.role, task: null, goal: r.goal, pack, adapterId: candidate.provider?.adapterId,
    extra: {
      cycleSummary,
      dodStatus: JSON.stringify(parseJson(dodRows?.items as string, [])),
      openErrors: JSON.stringify(q(`SELECT id, title, severity, status FROM error_reports WHERE run_id = ? AND status NOT IN ('resolved','wontfix')`, runId)),
      bootstrap,
      availableChecks: JSON.stringify(repo ? repoChecks(repo.id).map((c) => c.name) : []),
      // progress tracking: who holds each task and in which role
      existingTasks: JSON.stringify(runTasks(runId).map((t) => ({
        id: t.id, title: t.title, type: t.type, status: t.status, role: roleNameFor('implement', t),
        assignee: getAgent(t.ownerAgentId)?.name ?? null, reviewer: getAgent(t.reviewerAgentId)?.name ?? null,
        // what a finished task actually delivered (its commit line), so it isn't planned again
        delivered: t.status === 'done' ? (changeNotes(t).match(/^\s*Commit:\s*(.+)$/m)?.[1] ?? (t.meta?.commitProposal as { title?: string })?.title ?? null) : undefined,
      }))),
      inbox: inboxText(candidate, runId, null),
      nodeInstructions: planNode?.config?.instructions,
    },
  });
  const wi = createWorkItemRecord(runId, null, 'plan', candidate, prompt, pack.hash);
  if (planNode) run('UPDATE work_items SET workflow_node_id = ? WHERE id = ?', planNode.id, wi.id);
  emit('plan.started', 'engine', { bootstrap, agent: candidate.agent.name }, runId, wi.id);
  void executeWorkItem(wi, candidate, prompt.text, null);
}

function lastCycleSummary(runId: string): string {
  const c = q1('SELECT summary FROM cycles WHERE run_id = ? ORDER BY n DESC LIMIT 1', runId);
  return (c?.summary as string) ?? 'first cycle';
}

// Plan validation (spec 5.3) — deterministic guards against a bad PM.
export function validatePlanDiff(runId: string, diff: PlanDiff, dodItems?: DodItem[]): { ok: boolean; problems: string[]; needsApproval?: string } {
  const problems: string[] = [];
  const tasks = runTasks(runId);
  const byKeyOrId = new Map(tasks.map((t) => [t.id, t]));
  const r = getRun(runId);
  const repo = r ? getRepo(r.repoId) : null;

  // every DoD check ref must resolve to a real check — otherwise the item
  // would fail closed at evaluation time (or worse, never get measured)
  if (dodItems && repo) {
    for (const d of dodItems) {
      if (!d.checks?.length) problems.push(`dod item '${d.id}' has no machine-checkable checks`);
      for (const ref of d.checks ?? []) {
        if (!resolveCheck(repo, ref)) problems.push(`dod item '${d.id}' has unresolvable check '${ref}'`);
      }
    }
  }

  for (const t of diff.add ?? []) {
    if (!t.title) problems.push(`task '${t.key}' missing title`);
    if (!t.acceptanceCriteria?.length && !['infra', 'refactor'].includes(t.type))
      problems.push(`task '${t.key}' has no acceptance criteria and is not infra/refactor`);
    if ((t.difficulty ?? 1) > 5) problems.push(`task '${t.key}' difficulty > 5 — must be split`);
    if (!t.dodItemIds?.length && !['infra', 'refactor'].includes(t.type))
      problems.push(`task '${t.key}' does not map to a DoD item`);
  }
  // dependency cycles among new + existing
  const edges: [string, string][] = [];
  for (const t of diff.add ?? []) for (const d of t.dependsOn ?? []) edges.push([t.key, d]);
  for (const t of tasks) for (const d of t.dependsOn) edges.push([t.id, d]);
  if (hasCycle(edges)) problems.push('dependency cycle detected');

  const cancelling = diff.cancel ?? [];
  const doneWork = tasks.filter((t) => ['approved', 'done', 'in-review'].includes(t.status));
  const cancelledDone = cancelling.filter((id) => doneWork.some((t) => t.id === id));
  if (doneWork.length && cancelledDone.length / doneWork.length > 0.3) {
    return { ok: false, problems, needsApproval: 'plan cancels >30% of completed/approved work — owner approval required' };
  }
  return { ok: problems.length === 0, problems };
}

function hasCycle(edges: [string, string][]): boolean {
  const g = new Map<string, string[]>();
  for (const [a, b] of edges) g.set(a, [...(g.get(a) ?? []), b]);
  const state = new Map<string, number>();
  const dfs = (n: string): boolean => {
    const s = state.get(n) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(n, 1);
    for (const m of g.get(n) ?? []) if (dfs(m)) return true;
    state.set(n, 2);
    return false;
  };
  return [...g.keys()].some(dfs);
}

function applyPlanDiff(runId: string, diff: PlanDiff, plannedBy: string, dodItems?: DodItem[]): void {
  const r = getRun(runId)!;
  const keyMap = new Map<string, string>(); // task key -> id
  const actor = getAgent(plannedBy)?.name ?? plannedBy; // events name agents, never raw ids
  tx(() => {
    if (dodItems && r.status === 'draft') {
      const dod = q1('SELECT * FROM dod WHERE id = ?', r.dodId);
      const version = (dod?.version as number ?? 0) + 1;
      // spec 6.3: flag DoD items no runnable check can verify — the owner sees
      // them at DoD review instead of discovering a hollow gate later
      const repoId = r.repoId;
      const flagged = dodItems.map((d) => {
        const named = (d.checks ?? []).map((n) => checkByName(repoId, n)).filter(Boolean);
        const derived = deriveChecks(repoId, [d.text, ...(d.checks ?? [])]);
        const checkable = named.length > 0 || derived.some((x) => x.checkable);
        return { ...d, status: 'pending', checkable, checkNote: checkable ? null : 'no runnable check covers this item' };
      });
      const uncheckable = flagged.filter((d) => !d.checkable);
      if (uncheckable.length) emit('dod.flagged', 'engine', { items: uncheckable.map((d) => d.id), reason: 'no runnable check covers these DoD items — they rely on review alone' }, runId, r.dodId);
      run(`UPDATE dod SET items = ?, version = ? WHERE id = ?`, JSON.stringify(flagged), version, r.dodId);
    }
    const existingByTitle = new Map(runTasks(runId).map((t) => [t.title, t.id]));
    for (const spec of diff.add ?? []) {
      const dupId = existingByTitle.get(spec.title);
      if (dupId) { keyMap.set(spec.key, dupId); continue; }
      const id = `T-${shortId('')}${(spec.key ?? '').replace(/\W/g, '')}`.replace('T--', 'T-');
      const status: TaskStatus = r.status === 'running' ? 'ready' : 'backlog';
      // derived checks (spec 6.3): which repo check verifies each acceptance
      // criterion — known before the developer starts, not after it delivers
      const derived = deriveChecks(r.repoId, spec.acceptanceCriteria ?? []);
      const refs = (Array.isArray(spec.references) ? spec.references : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 10);
      const meta = {
        ...(spec.meta ?? {}),
        ...(refs.length ? { references: refs } : {}),
        derivedChecks: derived.filter((d) => d.checkable).map((d) => ({ criterion: d.criterion.slice(0, 200), check: d.checkName })),
        nonCheckable: derived.filter((d) => !d.checkable).map((d) => d.criterion.slice(0, 200)),
      };
      run(`INSERT INTO tasks (id, run_id, title, description, type, status, priority, depends_on, acceptance_criteria, deliverables, planned_by, difficulty, budget_usd, dod_item_ids, affected_paths, meta)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, runId, spec.title, spec.description ?? '', spec.type ?? 'feature', status, spec.priority ?? 1,
        '[]', JSON.stringify(spec.acceptanceCriteria ?? []), JSON.stringify(spec.deliverables ?? []),
        plannedBy, Math.min(5, spec.difficulty ?? 2), spec.budgetUsd ?? 5,
        JSON.stringify(spec.dodItemIds ?? []), JSON.stringify(spec.affectedPaths ?? []),
        JSON.stringify(meta));
      keyMap.set(spec.key, id);
      emit('task.created', actor, { taskId: id, title: spec.title, checks: derived.filter((d) => d.checkable).map((d) => d.checkName) }, runId, id);
    }
    // second pass: resolve dependsOn keys (plan keys or existing task ids)
    for (const spec of diff.add ?? []) {
      const id = keyMap.get(spec.key)!;
      const deps = (spec.dependsOn ?? []).map((d) => keyMap.get(d) ?? d);
      run('UPDATE tasks SET depends_on = ? WHERE id = ?', JSON.stringify(deps), id);
    }
    for (const id of diff.cancel ?? []) {
      const t = getTask(id);
      if (t && !TERMINAL_TASK.includes(t.status)) setTaskStatus(id, 'cancelled', actor);
    }
    for (const rp of diff.reprioritize ?? []) {
      run('UPDATE tasks SET priority = ? WHERE id = ?', rp.priority, keyMap.get(rp.taskId) ?? rp.taskId);
    }
    run('UPDATE runs SET plan_version = plan_version + 1 WHERE id = ?', runId);
  });
  emit('plan.applied', 'engine', { added: diff.add?.length ?? 0, cancelled: diff.cancel?.length ?? 0, notes: diff.notes }, runId);
}

// ---------------------------------------------------------------------------
// Work item records + dispatch
// ---------------------------------------------------------------------------

export function createWorkItemRecord(runId: string, task: Task | null, kind: WorkItemKind, candidate: Candidate, prompt: string | RenderedPrompt, packHash: string): WorkItem {
  const wiId = ulid();
  const pvId = ulid();
  const text = typeof prompt === 'string' ? prompt : prompt.text;
  const key = shaKey(task?.id ?? 'run', kind, text);
  // idempotent requeue: the same logical dispatch (task, kind, prompt) must
  // not create a second live work item — e.g. a restart plus a nudge
  const dup = q1(`SELECT id FROM work_items WHERE idempotency_key = ? AND status NOT IN ('failed','cancelled','interrupted','delivered')`, key);
  if (dup) return getWorkItem(dup.id as string)!;
  const dropped = typeof prompt === 'string' ? [] : prompt.dropped;
  const budgetChars = typeof prompt === 'string' ? null : prompt.budgetChars;
  run(`INSERT INTO prompt_versions (id, work_item_id, template_id, version, rendered_text, context_pack_hash, dropped, budget_chars, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, pvId, wiId, `${kind}/${candidate.provider?.adapterId ?? 'none'}`, 1, text, packHash, JSON.stringify(dropped), budgetChars, now());
  if (dropped.length) emit('prompt.trimmed', 'engine', { workItemId: wiId, taskId: task?.id, kind, dropped }, runId, wiId);
  // result cache key (spec 6.2): same kind + prompt + context pack + model ⇒
  // the same work — a later dispatch may reuse the delivered result
  // …and the reference files the agent can see: adding or changing one must not reuse an older result
  const wsId = getRun(runId)?.workspaceId ?? '';
  const cacheKey = sha256(`${kind}\n${text}\n${packHash}\n${candidate.model?.id ?? ''}\n${manifestFingerprint({ workspaceId: wsId, runId, taskId: task?.id, agentId: candidate.agent.id, role: candidate.role?.name })}`);
  run(`INSERT INTO work_items (id, task_id, run_id, kind, agent_id, account_id, model_id, prompt_version_id, idempotency_key, cache_key, status, started_at, heartbeat_at, attempt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    wiId, task?.id ?? null, runId, kind, candidate.agent.id, candidate.account?.id ?? null, candidate.model?.id ?? null,
    pvId, key, cacheKey, 'queued', now(), now(), task ? task.attempts + 1 : 1);
  emit('workitem.created', 'engine', { kind, agent: candidate.agent.name, taskId: task?.id }, runId, wiId);
  return getWorkItem(wiId)!;
}

// Stable key for a logical dispatch: a restart + nudge, or a double sweep,
// must not create two live work items for the same work.
function shaKey(taskId: string, kind: string, prompt: string): string {
  return `${taskId}:${kind}:${prompt.length}:${sha256(prompt)}`;
}

function scheduleTimer(runId: string | null, inMinutes: number, type: string, payload: Record<string, unknown>): void {
  run('INSERT INTO timers (id, run_id, fire_at, type, payload) VALUES (?,?,?,?,?)',
    ulid(), runId, minutesFromNow(inMinutes), type, JSON.stringify(payload));
}

async function executeWorkItem(wi: WorkItem, candidate: Candidate, approvedPrompt: string, worktree: string | null): Promise<void> {
  const r = getRun(wi.runId);
  if (!r) return;
  const repo = getRepo(r.repoId);
  const task = wi.taskId ? (getTask(wi.taskId) ?? null) : null;
  // Skills attached to this agent or its role, relevant to this work, ride
  // along with the prompt. The stored (approved) prompt stays as it was.
  // Graph runs add node-scoped skills from the pinned version's node config.
  const wfN = wi.workflowNodeId ? wfNode(graphFor(r)?.graph ?? { nodes: [], edges: [] }, wi.workflowNodeId) : null;
  const sk = skillsFor({
    agentId: candidate.agent.id, roleId: candidate.role?.id ?? null, kind: wi.kind,
    taskText: `${task?.title ?? ''}\n${task?.description ?? ''}\n${r.goal}`,
    nodeSkills: wfN?.config?.skills,
    inheritSkills: wfN ? (wfN.config?.inheritSkills !== false && !wfN.config?.skillsOnly) : true,
  });
  // lowest-value section: skills are the first thing dropped when the prompt
  // would exceed the budget it was fitted to
  const pvRow = wi.promptVersionId ? q1('SELECT budget_chars, dropped FROM prompt_versions WHERE id = ?', wi.promptVersionId) : null;
  const budget = (pvRow?.budget_chars as number | null) ?? contextBudget(candidate.agent.settings, candidate.model, 16000) * 4;
  let prompt = approvedPrompt;
  // reference files + this task's attachments: a short manifest (paths, not contents), recomputed for every dispatch so
  // a file added mid-run reaches the next work item without restarting anything
  const att = manifestSection({ workspaceId: r.workspaceId, runId: r.id, taskId: task?.id, agentId: candidate.agent.id, role: candidate.role?.name });
  if (att.section) prompt = `${approvedPrompt}\n\n${att.section}`;
  if (sk.section) {
    if (prompt.length + sk.section.length + 2 <= budget) prompt = `${prompt}\n\n${sk.section}`;
    else {
      const prev = parseJson<string[]>(pvRow?.dropped as string, []);
      run('UPDATE prompt_versions SET dropped = ? WHERE id = ?', JSON.stringify([...prev, 'skills']), wi.promptVersionId);
      emit('prompt.trimmed', 'engine', { workItemId: wi.id, taskId: task?.id, kind: wi.kind, dropped: [...prev, 'skills'] }, wi.runId, wi.id);
    }
  }
  if (sk.applied.length || sk.skipped.length) {
    emit('skill.applied', candidate.agent.name, { workItemId: wi.id, taskId: task?.id, kind: wi.kind, applied: sk.applied, skipped: sk.skipped }, wi.runId, wi.id);
  }

  run(`UPDATE work_items SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?`, now(), now(), wi.id);
  const direct = isDirect(r);
  let agentCp: Checkpoint | null = null;
  let live: ReturnType<typeof setInterval> | null = null;
  const promptStage = wi.kind === 'prompt' || wi.kind === 'prompt-review';
  if (task && !promptStage && ['assigned', 'changes-requested', 'ready'].includes(task.status)) setTaskStatus(task.id, 'in-progress', 'engine', { agent: candidate.agent.name });
  setAgentStatus(candidate.agent.id, AGENT_STATE[wi.kind] ?? 'working');
  emit('workitem.started', candidate.agent.name, { kind: wi.kind, taskId: task?.id }, wi.runId, wi.id);
  // the prompt this agent actually receives, for the activity view
  emit('agent.activity', candidate.agent.name, { workItemId: wi.id, taskId: task?.id, kind: 'prompt', text: `Prompt sent · ${wi.kind}`, detail: prompt.slice(0, 12000) }, wi.runId, wi.id);

  // Fallbacks stay within the role actually doing the work (a PM-drafted
  // prompt falls back to another PM, never to a specialist).
  const fallbacks = candidatesForRole(r.workspaceId, candidate.role.name).filter((c) => c.agent.id !== candidate.agent.id);
  const stuckMin = (candidate.provider?.tier === 1 && candidate.provider.kind === 'agent') ? r.limits.stuckAgentMinHosted : r.limits.stuckAgentMinApi;
  scheduleTimer(wi.runId, stuckMin, 'heartbeat.missed', { workItemId: wi.id });

  try {
    // a Human approval node's agent was chosen by the owner for this: any hands-on role may do it, but not the PM or the Prompt Creator
    const mayDo = wfN?.type === 'approval' ? !['pm', 'prompt-creator'].includes(candidate.role.name) : roleMayDo(candidate.role.name, wi.kind);
    if (!mayDo) {
      emit('role.violation', 'engine', { agent: candidate.agent.name, role: candidate.role.name, kind: wi.kind }, wi.runId, wi.id);
      throw new Error(`role '${candidate.role.name}' may not do '${wi.kind}' work`);
    }
    // Result cache (spec 6.2): an identical dispatch (kind + prompt + context
    // pack + model) already delivered — reuse it instead of calling a backend.
    const prevHit = wi.cacheKey
      ? q1(`SELECT id, result FROM work_items WHERE cache_key = ? AND status = 'delivered' AND id != ? AND result IS NOT NULL AND task_id IS ? ORDER BY finished_at DESC LIMIT 1`, wi.cacheKey, wi.id, wi.taskId ?? null)
      : null;
    if (prevHit) {
      const cached = parseJson<WorkItemResult & { cached?: unknown }>(prevHit.result as string, {} as never);
      const srcUsage = q1(`SELECT COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM usage_records WHERE work_item_id = ?`, prevHit.id);
      const srcChars = (q1(`SELECT COALESCE(SUM(LENGTH(rendered_text)),0) c FROM prompt_versions WHERE work_item_id = ?`, prevHit.id)?.c as number) ?? 0;
      const result: WorkItemResult & { cached?: unknown } = {
        ...cached,
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
        cached: { from: prevHit.id, saved: { promptChars: srcChars, inputTokens: srcUsage?.i ?? 0, outputTokens: srcUsage?.o ?? 0 } },
      };
      run(`UPDATE work_items SET status = 'delivered', finished_at = ?, result = ? WHERE id = ?`, now(), JSON.stringify(result), wi.id);
      emit('cache.hit', candidate.agent.name, { workItemId: wi.id, taskId: task?.id, kind: wi.kind, from: prevHit.id, savedPromptChars: srcChars }, wi.runId, wi.id);
      emit('agent.activity', candidate.agent.name, { workItemId: wi.id, taskId: task?.id, kind: 'status', text: `Cache hit — reusing the identical ${wi.kind} result (saved ~${srcChars} prompt chars)` }, wi.runId, wi.id);
      emit('workitem.delivered', candidate.agent.name, { kind: wi.kind, summary: result.summary, cached: true }, wi.runId, wi.id);
      setAgentStatus(candidate.agent.id, 'idle');
      if (live) clearInterval(live);
      await handleDelivered(wi, result, candidate.agent.id);
      return;
    }
    // agent checkpoint: exactly what this agent changed in the repository
    if (direct && worktree && task && repo) {
      agentCp = beginCheckpoint({ repoId: repo.id, kind: 'agent', parentId: (task.meta?.generalCheckpointId as string) ?? null, label: `${candidate.agent.name} · ${wi.kind} · ${task.title}`,
        prompt, runId: wi.runId, taskId: task.id, workItemId: wi.id, agentId: candidate.agent.id });
      setTaskMeta(task.id, 'checkpointIds', [...((getTask(task.id)?.meta?.checkpointIds as string[]) ?? []), agentCp.id]);
    }
    // live diff: while the agent works in the repository, push what it has
    // changed so far (only when the working tree actually changed)
    let lastTree = agentCp?.beforeTree ?? '';
    const liveCp = agentCp;
    // (async git, one pass at a time: sync git here froze the API and UI)
    // and backing off on slow repos so git is busy at most ~20% of the time
    let liveBusy = false;
    let liveNext = 0;
    live = liveCp && repo ? setInterval(() => {
      if (liveBusy || Date.now() < liveNext) return;
      liveBusy = true;
      const started = Date.now();
      liveChanges(repo.path, liveCp.beforeTree).then(({ tree, files: all }) => {
        if (tree === lastTree) return;
        lastTree = tree;
        const files = all.filter((f) => !f.path.startsWith('.office/'));
        emit('agent.diff', candidate.agent.name, { workItemId: wi.id, taskId: task?.id, checkpointId: liveCp.id, total: files.length,
          files: files.slice(0, 200) }, wi.runId, wi.id);
      }).catch(() => { /* transient (files mid-write) */ }).finally(() => { liveBusy = false; liveNext = Date.now() + 4 * (Date.now() - started); });
    }, 3000) : null;
    const { result, usedAgent, usedBackend } = await dispatchThroughAdapter(
      {
        workItem: wi, task, prompt, worktree, repo: repo ?? null,
        emit: (type, payload) => {
          run('UPDATE work_items SET heartbeat_at = ? WHERE id = ?', now(), wi.id);
          // a heartbeat only proves liveness — the timestamp above is all the
          // stuck-detector needs; storing each one flooded the event log
          if (type === 'agent.heartbeat') return;
          emit(type, candidate.agent.name, { workItemId: wi.id, taskId: task?.id, ...payload }, wi.runId, wi.id);
        },
        fetchQuotaHeaders: undefined,
      },
      candidate, fallbacks,
      // a work item dispatched by a workflow node inherits its modelTier —
      // the same field Routing and the Workflow inspector both edit
      wfN ? { id: wfN.id, label: wfN.label, requiredTier: wfN.config?.modelTier } : undefined,
    );

    if (live) clearInterval(live);
    // a stopped/hard-paused run killed this work item's process — the adapter
    // resolved, but the result must not be recorded as a delivery
    if (getWorkItem(wi.id)?.status === 'cancelled') {
      if (agentCp) { try { endCheckpoint(agentCp.id, 'interrupted'); } catch { /* repo gone */ } agentCp = null; }
      setAgentStatus(candidate.agent.id, 'idle');
      return;
    }
    if (agentCp) {
      const done = endCheckpoint(agentCp.id);
      agentCp = null;
      if (usedAgent.id !== candidate.agent.id) run('UPDATE repo_checkpoints SET agent_id = ? WHERE id = ?', usedAgent.id, done.id);
      const touched = done.files.map((f) => f.path).filter((p) => !p.startsWith('.office/'));
      if (['implement', 'fix', 'test', 'doc'].includes(wi.kind)) result.filesChanged = touched;
      else if (touched.length) {
        // read-only work (review, QA, analysis) must not change code — keep the evidence, let the owner undo it
        emit('readonly.violation', 'engine', { agent: usedAgent.name, kind: wi.kind, files: touched, checkpointId: done.id,
          note: 'changes kept; undo them from Checkpoints if unwanted' }, wi.runId, wi.id);
      }
    }
    // Isolated mode: commit the worktree on the task branch.
    if (!direct && worktree && ['implement', 'fix', 'test', 'doc'].includes(wi.kind)) {
      const sha = commitAll(worktree, `office(${task?.id}): ${wi.kind} — ${task?.title ?? ''}`.slice(0, 120));
      result.sha = result.sha ?? sha ?? undefined;
      result.branch = task?.branch ?? undefined;
      if (!result.filesChanged?.length && repo) {
        result.filesChanged = changedFiles(worktree, repo.integrationBranch);
      }
    }
    run(`UPDATE work_items SET status = 'delivered', finished_at = ?, result = ? WHERE id = ?`, now(), JSON.stringify(result), wi.id);
    if (result.usage?.costUsd && wi.taskId) {
      run('UPDATE tasks SET spent_usd = spent_usd + ? WHERE id = ?', result.usage.costUsd, wi.taskId);
      run('UPDATE runs SET spent_usd = spent_usd + ? WHERE id = ?', result.usage.costUsd, wi.runId);
      const t2 = getTask(wi.taskId);
      if (t2 && t2.spentUsd > t2.budgetUsd && !TERMINAL_TASK.includes(t2.status)) {
        // per-task cost ceiling: pause the run and ask once — the delivery
        // itself already landed, so the task waits for the owner's call
        setTaskStatus(t2.id, 'waiting-input', 'engine', { reason: `cost ceiling: spent $${t2.spentUsd.toFixed(2)} of $${t2.budgetUsd}` });
        notifyOnce(wi.runId, 'task.budget', t2.id, `Task "${t2.title}" exceeded its $${t2.budgetUsd} cost ceiling (spent $${t2.spentUsd.toFixed(2)})`, { hint: 'Raise the task budget and resume, or stop the run.' });
        pauseRun(wi.runId);
        setAgentStatus(usedAgent.id, 'idle');
        return;
      }
    }
    emit('workitem.delivered', usedAgent.name, { kind: wi.kind, summary: result.summary, sha: result.sha, costUsd: result.usage?.costUsd ?? 0, backend: usedBackend }, wi.runId, wi.id);
    relayAgentMessages(wi, result, usedAgent.id);
    setAgentStatus(usedAgent.id, 'idle');
    await handleDelivered(wi, result, usedAgent.id);
  } catch (e) {
    const msg = e instanceof AdapterError ? `${e.kind}: ${e.message}` : String((e as Error)?.message ?? e);
    if (live) clearInterval(live);
    // whatever the agent wrote before failing stays recorded and undoable
    if (agentCp) { try { endCheckpoint(agentCp.id, 'interrupted'); } catch { /* repo gone */ } agentCp = null; }
    // stopped by the owner: that is not a failure to retry, and it leaves the agent free
    if (getWorkItem(wi.id)?.status === 'cancelled' || getRun(wi.runId)?.status === 'stopped') {
      run(`UPDATE work_items SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ?`, now(), wi.id);
      setAgentStatus(candidate.agent.id, 'idle');
      return;
    }
    run(`UPDATE work_items SET status = 'failed', finished_at = ? WHERE id = ?`, now(), wi.id);
    emit('workitem.failed', 'engine', { kind: wi.kind, error: msg.slice(0, 400) }, wi.runId, wi.id);
    // Surface the reason in live output too — workitem.failed isn't rendered
    // in the activity feed, so silent retries look like the run is stuck.
    emit('agent.output', 'engine', { workItemId: wi.id, taskId: wi.taskId, line: `[error] ${wi.kind} failed — ${msg.slice(0, 300)}` }, wi.runId, wi.id);
    setAgentStatus(candidate.agent.id, 'idle');
    await handleWorkItemFailure(wi, msg);
  }

  // soft-pause landing: if run is pausing and nothing remains in flight → paused
  const rNow = getRun(wi.runId);
  if (rNow?.status === 'pausing') {
    const inFlight = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND status IN ('queued','running')`, wi.runId)?.c as number;
    if (!inFlight) setRunStatus(wi.runId, 'paused');
  }
}

// Messages an agent put in its reply go to their recipients; a question for
// the owner becomes an approval so a human actually sees it.
function relayAgentMessages(wi: WorkItem, result: NonNullable<WorkItem['result']>, fromAgentId: string): void {
  for (const m of extractMessages(result)) {
    const msg = postMessage({ runId: wi.runId, taskId: wi.taskId, workItemId: wi.id, from: fromAgentId, to: m.to, kind: m.kind, text: m.text });
    if (msg && msg.toRole === 'owner') {
      requestApproval({
        action: 'agent.question', taskId: wi.taskId, runId: wi.runId, workItemId: wi.id, requestedBy: fromAgentId,
        payload: { summary: `${getAgent(fromAgentId)?.name ?? 'An agent'} asks: ${m.text.slice(0, 300)}`, messageId: msg.id, kind: m.kind },
      });
    }
  }
}

// What each role may be dispatched. The PM orchestrates only — planning and
// prompts — and never receives code, review, test or analysis work. Roles not
// listed (custom roles) are unrestricted.
const ROLE_WORK: Record<string, WorkItemKind[]> = {
  pm: ['plan', 'prompt', 'prompt-review', 'accept', 'diagnose'],
  'prompt-creator': ['prompt'],
  reviewer: ['review'],
  analyst: ['analyse'],
  qa: ['qa'],           // the tester runs and reports; it never changes code
};

function roleMayDo(roleName: string, kind: WorkItemKind): boolean {
  const allowed = ROLE_WORK[roleName];
  return !allowed || allowed.includes(kind);
}

// The PM hands each task to its specialist on the record: the assignee's
// inbox says who assigned it, what is expected and where it goes next.
function pmHandoff(r: Run, task: Task, to: Candidate, text: string): void {
  const pm = candidatesForRole(r.workspaceId, 'pm')[0];
  if (!pm || pm.agent.id === to.agent.id) return;
  postMessage({ runId: r.id, taskId: task.id, from: pm.agent.id, to: to.agent.id, kind: 'handoff', text });
}

function roleNameFor(kind: WorkItemKind, task: Task | null): string {
  if (kind === 'plan' || kind === 'prompt-review' || kind === 'accept' || kind === 'diagnose') return 'pm';
  if (kind === 'prompt') return 'prompt-creator';
  if (kind === 'review') return 'reviewer';
  if (kind === 'analyse') return 'analyst';
  if (kind === 'qa') return 'qa';
  // every code change — test code included — is the developer's
  if (task?.type === 'docs') return 'docs';
  return 'developer';
}

// What an agent is doing, from the work it is actually running.
const AGENT_STATE: Partial<Record<WorkItemKind, string>> = {
  plan: 'planning', prompt: 'planning', 'prompt-review': 'reviewing', accept: 'reviewing', review: 'reviewing',
  qa: 'testing', test: 'coding', implement: 'coding', fix: 'coding', doc: 'coding', analyse: 'working', diagnose: 'working', custom: 'working',
};

function setAgentStatus(agentId: string, status: string): void {
  run('UPDATE agents SET status = ? WHERE id = ?', status, agentId);
  const a = getAgent(agentId);
  emit('agent.status', 'engine', { agentId, name: a?.name, status });
}

async function handleWorkItemFailure(wi: WorkItem, msg: string): Promise<void> {
  if (!wi.taskId) {
    // plan work item failed — retry transient errors, escalate deterministic
    // ones (auth, bad config, bad responses) instead of failing the same way
    // three times in a row.
    if (wi.kind === 'plan') {
      const fails = (planFailCount.get(wi.runId) ?? 0) + 1;
      planFailCount.set(wi.runId, fails);
      const transient = /^(rate-limit|server|timeout|network):/.test(msg);
      if (fails < 3 && transient) {
        emit('plan.retry', 'engine', { attempt: fails, error: msg.slice(0, 200) }, wi.runId);
        void dispatchPlan(wi.runId, true);
      } else {
        requestApproval({
          action: 'plan.escalate', runId: wi.runId, requestedBy: 'engine',
          payload: { summary: `Planning failed ${fails} times: ${msg.slice(0, 300)}` },
        });
      }
      return;
    }
    void maybeAdvanceRun(wi.runId);
    return;
  }
  const task = getTask(wi.taskId);
  if (!task) return;
  // A prompt stage that cannot run (every backend down) must not let the task
  // proceed on an unreviewed prompt — the owner decides instead.
  if (wi.kind === 'prompt' || wi.kind === 'prompt-review') {
    const job = promptJobs.get(wi.id);
    promptJobs.delete(wi.id);
    // provider hiccups (API errors, overload, rate limits, timeouts) are
    // retried twice with a pause before the owner is asked
    const transient = /api_error|overloaded|rate.?limit|timeout|network|ECONNRESET|ETIMEDOUT|\b5\d\d\b|stuck/i.test(msg);
    if (job && transient && (job.retries ?? 0) < 2) {
      const retry = { ...job, retries: (job.retries ?? 0) + 1 };
      emit('prompt.retry', 'engine', { taskId: job.taskId, stage: wi.kind, attempt: retry.retries, error: msg.slice(0, 200) }, wi.runId, job.taskId);
      setTimeout(() => (wi.kind === 'prompt' ? startPromptDraft(retry) : startPromptReview(retry)), 15000 * retry.retries!);
      return;
    }
    if (job) escalatePrompt(job, `${wi.kind === 'prompt' && job.drafter === 'prompt-creator' ? 'Prompt Creator' : 'PM'} could not run: ${msg.slice(0, 200)}`);
    return;
  }
  // Every backend rate-limited or out of quota: wait for the reset instead of
  // burning a retry attempt (spec 4: no endless retries).
  if (/rate[- ]limit|quota exhausted|hit your limit|usage limit/i.test(msg)) {
    const reset = q1(`SELECT MIN(resets_at) r FROM quota_windows WHERE remaining = 0 AND resets_at > ?`, now())?.r as string | undefined;
    const minutes = reset ? Math.max(0.5, (Date.parse(reset) - Date.now()) / 60000) : 5;
    setTaskStatus(task.id, 'blocked-quota', 'engine', { reason: msg.slice(0, 200), resetsAt: reset ?? null, resetSource: reset ? 'provider' : 'estimate (5 min)' });
    scheduleTimer(wi.runId, minutes, 'quota.reset', {});
    void maybeAdvanceRun(wi.runId);
    return;
  }
  // a tester that cannot run must not reset the task — review it without QA
  if (wi.kind === 'qa') {
    emit('qa.skipped', 'engine', { taskId: task.id, reason: msg.slice(0, 200) }, wi.runId, task.id);
    setTaskStatus(task.id, 'in-review', 'engine', { reason: 'QA unavailable' });
    dispatchReview(task, [], `QA could not run: ${msg.slice(0, 300)}`);
    return;
  }
  // analyse items failing must not reset the task — file a rule-only report.
  if (wi.kind === 'analyse') {
    const pending = pendingAnalysis.get(wi.id);
    pendingAnalysis.delete(wi.id);
    if (pending) {
      const cr = q1('SELECT * FROM check_runs WHERE id = ?', pending.checkRunId);
      if (cr) {
        const r = getRun(wi.runId)!;
        const { report } = fileErrorReport({
          runId: r.id, cycleN: r.currentCycle, task, workItemId: wi.id,
          checkRun: {
            id: cr.id as string, checkId: cr.check_id as string, workItemId: cr.work_item_id as string | null,
            taskId: cr.task_id as string | null, runId: r.id, commitSha: cr.commit_sha as string | null,
            ref: cr.ref as string, status: cr.status as never, durationMs: cr.duration_ms as number,
            evidenceRefs: parseJson(cr.evidence_refs as string, []), summary: cr.summary as string,
            failures: parseJson(cr.failures as string, []), createdAt: cr.created_at as string,
          },
          checkName: pending.checkName,
          checkCommand: (q1('SELECT command FROM checks WHERE id = ?', cr.check_id)?.command as string) ?? '',
          affectedFiles: pending.files, workspaceId: r.workspaceId,
        });
        routeFixAfterReport(task, report.id);
      }
    }
    return;
  }
  const cls = classifyFailure(msg);
  if (cls === 'fatal') {
    // fatal (auth, missing CLI, repo conflict): pause the run and raise one
    // Needs-you item with the concrete fix — retrying cannot help
    setTaskStatus(task.id, 'waiting-input', 'engine', { reason: msg.slice(0, 300) });
    notifyOnce(wi.runId, 'run.fatal', task.id, `Fatal error — run paused: ${msg.slice(0, 300)}`, { fix: fixHintFor(msg), kind: wi.kind });
    pauseRun(wi.runId);
    return;
  }
  const r = getRun(wi.runId)!;
  // model-quality dispatch failures: one bounce on a stronger tier before the
  // attempt budget burns (delivered-but-invalid replies go through repairReply)
  if (cls === 'model-quality' && !task.meta?.tierEscalated) {
    setTaskMeta(task.id, 'tierEscalated', true);
    run('UPDATE tasks SET difficulty = ? WHERE id = ?', Math.min(5, task.difficulty + 2), task.id);
    emit('task.strategy', 'engine', { taskId: task.id, strategy: 'stronger-tier', reason: msg.slice(0, 200) }, wi.runId, task.id);
    setTaskStatus(task.id, 'ready', 'engine', { reason: 'invalid output — retrying on a stronger model' });
    void maybeAdvanceRun(wi.runId);
    return;
  }
  run('UPDATE tasks SET attempts = attempts + 1 WHERE id = ?', task.id);
  if (task.attempts + 1 >= r.limits.sameErrorAttempts) {
    // before the owner is asked, the PM gets one shot at a diagnosis + strategy
    if (dispatchDiagnosis(getTask(task.id)!, msg)) return;
    setTaskStatus(task.id, 'failed', 'engine', { reason: msg });
    requestApproval({
      action: 'task.escalate', taskId: task.id, runId: wi.runId, requestedBy: 'engine',
      payload: { summary: `Task "${task.title}" failed ${task.attempts + 1} dispatch attempt(s): ${msg.slice(0, 200)}` },
    });
  } else {
    // transient: exponential backoff with jitter — the task stays out of the
    // ready pool until the delay lands
    const delay = cls === 'transient' ? backoffDelayMs(task.attempts + 1) : 0;
    emit('workitem.retry', 'engine', { taskId: task.id, kind: wi.kind, class: cls, inSec: Math.round(delay / 1000), error: msg.slice(0, 200) }, wi.runId, task.id);
    const requeue = () => { const t = getTask(task.id); if (t && !TERMINAL_TASK.includes(t.status) && t.status !== 'waiting-input') { setTaskStatus(task.id, 'ready', 'engine', { reason: 'retry after backoff' }); void maybeAdvanceRun(wi.runId); } };
    if (delay) setTimeout(requeue, delay); else requeue();
  }
}

// ---------------------------------------------------------------------------
// PM diagnosis (stage 4.3): when a task exhausts its dispatch attempts the PM
// writes a short diagnosis and picks one strategy change — a stronger model,
// or splitting the task — before the owner is asked.
// ---------------------------------------------------------------------------

function dispatchDiagnosis(task: Task, why: string): boolean {
  if (task.meta?.diagnosed) return false;   // already diagnosed once
  const r = getRun(task.runId);
  if (!r || r.status !== 'running') return false;
  const pm = pickHelper(r.workspaceId, 'pm', [task.ownerAgentId ?? undefined]);
  if (!pm) return false;
  setTaskMeta(task.id, 'diagnosed', true);
  const history = q(`SELECT kind, error_signature, status, finished_at FROM work_items WHERE task_id = ? AND status = 'failed' ORDER BY finished_at DESC LIMIT 4`, task.id)
    .map((w) => `- ${w.kind} failed: ${String(w.error_signature ?? '').slice(0, 200)}`);
  const prompt = renderPrompt({
    kind: 'diagnose', agent: pm.agent, role: pm.role, task, pack: deskPack(pm, 8000, 'diagnose'), adapterId: pm.provider?.adapterId,
    extra: { checkResults: `Dispatch failures (${r.limits.sameErrorAttempts} attempts exhausted):\n${why.slice(0, 800)}\n${history.join('\n')}`,
      approvedPrompt: approvedPromptFor(task.id) },
  });
  setTaskStatus(task.id, 'in-review', 'engine', { stage: 'diagnose', pm: pm.agent.name });
  const wi = createWorkItemRecord(r.id, task, 'diagnose', pm, prompt, 'desk');
  emit('task.diagnosing', 'engine', { taskId: task.id, pm: pm.agent.name }, r.id, wi.id);
  void executeWorkItem(wi, pm, prompt.text, null);
  return true;
}

// ---------------------------------------------------------------------------
// Delivered work item routing
// ---------------------------------------------------------------------------

// One repair retry per (task, kind): the repair prompt carries only the
// validation error and the bad output — never the whole prompt again.
const repairRetries = new Map<string, number>();

function repairReply(wi: WorkItem, err: string, raw: Record<string, any>, usedAgentId: string, r: Run, task: Task | null): boolean {
  const key = `${wi.taskId ?? wi.runId}:${wi.kind}`;
  const used = repairRetries.get(key) ?? 0;
  if (used >= 1) {
    emit('repair.exhausted', 'engine', { kind: wi.kind, taskId: wi.taskId, error: err.slice(0, 200) }, r.id, wi.id);
    return false;
  }
  const role = roleNameFor(wi.kind, task);
  const cand = candidatesForRole(r.workspaceId, role).find((c) => c.agent.id === usedAgentId && !c.blocked)
    ?? candidatesForRole(r.workspaceId, role).find((c) => !c.blocked);
  if (!cand) return false;
  repairRetries.set(key, used + 1);
  const job = promptJobs.get(wi.id);
  if (job) promptJobs.delete(wi.id);
  const bad = typeof raw.text === 'string' && raw.text.trim() ? raw.text : JSON.stringify(raw).slice(0, 6000);
  const prompt = finalizeApprovedPrompt(
    `Your previous reply failed validation.\n\nError: ${err}\n\nYour reply (truncated):\n${bad.slice(0, 6000) || '(empty)'}\n\nSend only the corrected reply.`,
    wi.kind, cand.provider?.adapterId, '', cand.role, 'HANDOFF.md', deskPack(cand, 8000).budgetChars);
  const nwi = createWorkItemRecord(r.id, task, wi.kind, cand, prompt, 'repair');
  if (wi.workflowNodeId) {
    run('UPDATE work_items SET workflow_node_id = ?, workflow_edge_id = ? WHERE id = ?', wi.workflowNodeId, wi.workflowEdgeId, nwi.id);
    nwi.workflowNodeId = wi.workflowNodeId;
    nwi.workflowEdgeId = wi.workflowEdgeId;
  }
  if (job) promptJobs.set(nwi.id, job);
  emit('workitem.repair', 'engine', { kind: wi.kind, taskId: wi.taskId, retryOf: wi.id, error: err.slice(0, 200) }, r.id, nwi.id);
  void executeWorkItem(nwi, cand, prompt.text, null);
  return true;
}

async function handleDelivered(wi: WorkItem, result: NonNullable<WorkItem['result']>, usedAgentId: string): Promise<void> {
  const task = wi.taskId ? getTask(wi.taskId) : null;
  const r = getRun(wi.runId);
  if (!r) return;
  // graph stamps are written after the row is created — the in-memory copy
  // can lag the DB, so refresh before routing
  if (!wi.workflowNodeId) {
    const stamp = q1('SELECT workflow_node_id, workflow_edge_id FROM work_items WHERE id = ?', wi.id);
    wi.workflowNodeId = (stamp?.workflow_node_id as string | null) ?? null;
    wi.workflowEdgeId = (stamp?.workflow_edge_id as string | null) ?? null;
  }

  // Strict JSON for the decision roles: an unusable reply gets one repair
  // retry carrying only the error and the bad output; it is a normal work
  // item so the token report counts it.
  if (STRICT_REPLY_KINDS.includes(wi.kind)) {
    const raw = (result.raw ?? {}) as Record<string, unknown>;
    const err = validateReply(wi.kind, (raw.json ?? raw) as Record<string, any>);
    if (err && repairReply(wi, err, raw, usedAgentId, r, task ?? null)) return;
  }

  // graph-dispatched items route through the workflow executor — the fixed
  // pipeline only handles legacy items (and run-scope plan, below)
  if (task && wi.workflowNodeId && graphFor(r)) {
    await graphDelivered(wi, result, usedAgentId, r, task);
    return;
  }

  switch (wi.kind) {
    case 'plan': {
      const raw = (result.raw ?? {}) as Record<string, unknown>;
      const json = (raw.json ?? raw) as { dodItems?: DodItem[]; planDiff?: PlanDiff; tasks?: PlanTaskSpec[] };
      const diff: PlanDiff = json.planDiff ?? { add: json.tasks ?? [] };
      const dodItems = json.dodItems;
      const v = validatePlanDiff(r.id, diff, dodItems);
      emit('plan.validated', 'engine', { ok: v.ok, problems: v.problems }, r.id);
      if (!v.ok) {
        if (v.needsApproval) {
          pendingPlanDiff.set(r.id, { runId: r.id, diff });
          requestApproval({ action: 'plan.override', runId: r.id, requestedBy: 'pm', payload: { summary: v.needsApproval, problems: v.problems } });
          return;
        }
        emit('plan.rejected', 'engine', { problems: v.problems }, r.id);
        const fails = (planFailCount.get(r.id) ?? 0) + 1;
        planFailCount.set(r.id, fails);
        if (fails >= 2) {
          requestApproval({ action: 'plan.escalate', runId: r.id, requestedBy: 'engine', payload: { summary: `Plan validation failed ${fails} times: ${v.problems.join('; ')}` } });
        } else {
          void dispatchPlan(r.id, r.status === 'draft');
        }
        return;
      }
      planFailCount.delete(r.id);
      applyPlanDiff(r.id, diff, usedAgentId, dodItems);
      if (r.status === 'draft') {
        // No DoD gate unless the owner asked to confirm plans (Team → Plan):
        // the PM's interpretation runs immediately. The owner can still edit
        // the DoD, pause or redirect the run at any time.
        const oneShot = !!(r.limits as { oneShot?: boolean }).oneShot;
        if (oneShot || !getWorkspace(r.workspaceId)?.settings?.confirmPlan) {
          setRunStatus(r.id, 'dod-review');
          emit('dod.auto_approved', 'engine', { reason: oneShot ? 'one-shot run' : 'plan confirmation is off' }, r.id);
          approveDod(r.id);
          return;
        }
        setRunStatus(r.id, 'dod-review');
        const dod = q1('SELECT items FROM dod WHERE id = ?', r.dodId);
        requestApproval({
          action: 'dod.approve', runId: r.id, requestedBy: usedAgentId,
          payload: { summary: 'Approve the Definition of Done to start the run', items: parseJson(dod?.items as string, []) },
        });
      } else {
        void maybeAdvanceRun(r.id);
      }
      return;
    }

    case 'prompt': {
      const job = promptJobs.get(wi.id);
      promptJobs.delete(wi.id);
      if (!job || !task) return;
      const raw = (result.raw ?? {}) as Record<string, any>;
      const j = (raw.json ?? raw) as { brief?: string; prompt?: string; rationale?: string };
      const draft = [j.brief, j.prompt, raw.text].find((x) => typeof x === 'string' && x.trim()) as string | undefined ?? job.basePrompt;
      run(`INSERT INTO prompt_versions (id, work_item_id, template_id, version, rendered_text, context_pack_hash, created_at) VALUES (?,?,?,?,?,?,?)`,
        ulid(), wi.id, `draft/${job.kind}`, job.revision + 1, draft, job.packHash, now());
      emit('prompt.drafted', getAgent(usedAgentId)?.name ?? job.drafter, { taskId: task.id, revision: job.revision, rationale: j.rationale ?? null, target: getAgent(job.targetAgentId)?.name, by: job.drafter }, r.id, task.id);
      // the PM is accountable for prompts it writes itself — no second review
      if (job.drafter === 'pm') { dispatchApprovedPrompt({ ...job, draft, creatorId: usedAgentId }); return; }
      startPromptReview({ ...job, draft, creatorId: usedAgentId });
      return;
    }

    case 'prompt-review': {
      const job = promptJobs.get(wi.id);
      promptJobs.delete(wi.id);
      if (!job || !task) return;
      const raw = (result.raw ?? {}) as Record<string, any>;
      const j = (raw.json ?? raw) as { decision?: string; notes?: string; checklist?: Record<string, boolean> };
      const approved = j.decision === 'approve';
      const notes = (j.notes ?? '').trim() || (approved ? '' : 'The PM reply could not be read as a decision; tighten the prompt and resubmit.');
      const pmName = getAgent(usedAgentId)?.name ?? 'pm';
      emit('prompt.reviewed', pmName, { taskId: task.id, decision: approved ? 'approve' : 'revise', notes, checklist: j.checklist ?? null, revision: job.revision }, r.id, task.id);
      if (job.creatorId) {
        postMessage({ runId: r.id, taskId: task.id, workItemId: wi.id, from: usedAgentId, to: job.creatorId, kind: 'decision',
          text: approved ? `Prompt for "${task.title}" approved (revision ${job.revision}).` : `Revise the prompt for "${task.title}": ${notes}` });
      }
      if (approved) { dispatchApprovedPrompt(job); return; }
      if (job.revision + 1 > PROMPT_MAX_REVISIONS) { escalatePrompt({ ...job, notes }, `PM still requests changes after ${job.revision + 1} drafts: ${notes}`); return; }
      startPromptDraft({ ...job, revision: job.revision + 1, notes });
      return;
    }

    case 'implement': case 'fix': case 'test': case 'doc': {
      if (!task) return;
      await verifyDeliveredTask(wi, task, result);
      return;
    }

    case 'review': {
      if (!task) return;
      const raw = (result.raw ?? {}) as Record<string, unknown>;
      const j = (raw.json ?? raw) as { decision?: string; notes?: string };
      const decision = j.decision === 'request-changes' ? 'request-changes' : 'approve';
      run('UPDATE tasks SET reviewer_agent_id = ? WHERE id = ?', usedAgentId, task.id);
      emit('review.decided', getAgent(usedAgentId)?.name ?? 'reviewer', { taskId: task.id, decision, notes: j.notes }, r.id, task.id);
      if (task.ownerAgentId) {
        postMessage({ runId: r.id, taskId: task.id, workItemId: wi.id, from: usedAgentId, to: task.ownerAgentId, kind: 'handoff',
          text: decision === 'approve' ? `Approved "${task.title}". ${j.notes ?? ''}`.trim() : `Changes requested on "${task.title}": ${j.notes ?? 'see review notes'}` });
      }
      // findings go to the PM, who accepts or prepares the correction
      const reviewReport = `REVIEW ${decision === 'approve' ? 'PASSED' : 'FAILED'}: ${j.notes ?? ''}`;
      if (decision !== 'approve' && j.notes) {
        // spec 6.5: reviewer flags teach the KB — a repeated flag becomes a
        // lesson injected into the next implement/fix prompt
        recordReviewerFlag({ workspaceId: r.workspaceId, repoId: r.repoId, flag: j.notes, files: task.affectedPaths });
      }
      const reviewFails = Number(task.meta?.qaFails ?? 0);
      if (decision !== 'approve') setTaskMeta(task.id, 'qaFails', reviewFails + 1);
      if (decision !== 'approve' && reviewFails === 0) {
        setTaskStatus(task.id, 'changes-requested', 'reviewer', { notes: j.notes });
        dispatchFix(task, `Reviewer requested changes: ${j.notes ?? 'see review notes'}`, false);
        return;
      }
      if (decision === 'approve' ? dispatchAccept(task, reviewReport.replace('REVIEW PASSED', 'QA PASSED'), false)
        : (rejectsBelowLimit(task, r) && dispatchAccept(task, reviewReport.replace('REVIEW FAILED', 'QA FAILED'), true))) return;
      if (decision === 'approve') {
        setTaskStatus(task.id, 'approved');
        await proceedMerge(task.id);
      } else {
        const rejects = (q1(`SELECT COUNT(*) c FROM work_items WHERE task_id = ? AND kind = 'review'`, task.id)?.c as number) ?? 0;
        setTaskStatus(task.id, 'changes-requested', 'reviewer', { notes: j.notes });
        if (rejects >= r.limits.disagreeK) {
          requestApproval({ action: 'task.arbitrate', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `Reviewer rejected "${task.title}" ${rejects} times`, notes: j.notes } });
          return;
        }
        dispatchFix(task, `Reviewer requested changes: ${j.notes ?? 'see review notes'}`, false);
      }
      return;
    }

    case 'qa': {
      if (!task) return;
      const raw = (result.raw ?? {}) as Record<string, unknown>;
      const j = (raw.json ?? raw) as { decision?: string; summary?: string; findings?: { severity?: string; kind?: string; message?: string; evidence?: string }[]; criteria?: { criterion?: string; met?: boolean; evidence?: string }[] };
      const findings = Array.isArray(j.findings) ? j.findings : [];
      const report = [j.summary ?? result.summary, ...findings.map((f) => `- [${f.severity ?? '?'}/${f.kind ?? '?'}] ${f.message ?? ''}${f.evidence ? ` (${String(f.evidence).slice(0, 300)})` : ''}`)].join('\n');
      const failed = j.decision === 'fail';
      emit('qa.decided', getAgent(usedAgentId)?.name ?? 'qa', { taskId: task.id, decision: failed ? 'fail' : 'pass', summary: j.summary ?? null, findings: findings.length }, r.id, task.id);
      // the tester reviewed the delivery (an independent agent — SoD holds)
      run('UPDATE tasks SET reviewer_agent_id = ? WHERE id = ?', usedAgentId, task.id);
      const criteria = Array.isArray(j.criteria) ? j.criteria : [];
      const qaReport = [`QA ${failed ? 'FAILED' : 'PASSED'}: ${report}`,
        ...criteria.map((c) => `- criterion ${c.met ? 'met' : 'NOT met'}: ${c.criterion ?? ''}${c.evidence ? ` (${String(c.evidence).slice(0, 200)})` : ''}`)].join('\n');
      // A first failure goes straight back to the developer with the findings
      // (agents talk directly); the PM is involved for acceptance, and when the
      // same task fails review again — then it is a blocker worth a decision.
      const qaFails = Number(task.meta?.qaFails ?? 0);
      if (failed) setTaskMeta(task.id, 'qaFails', qaFails + 1);
      if (failed && qaFails === 0) {
        setTaskStatus(task.id, 'changes-requested', 'qa', { reason: 'review found problems — sent straight to the developer' });
        dispatchFix(task, `The reviewer found problems:\n${qaReport}`, false);
        return;
      }
      if (dispatchAccept(task, qaReport, failed)) return;
      if (failed) {
        setTaskStatus(task.id, 'changes-requested', 'qa', { reason: 'QA found problems' });
        dispatchFix(task, `QA tester found problems:\n${report}`, false);
      } else {
        setTaskStatus(task.id, 'approved', 'qa', { reason: 'QA passed (no PM to accept)' });
        await proceedMerge(task.id);
      }
      return;
    }

    case 'accept': {
      if (!task) return;
      const raw = (result.raw ?? {}) as Record<string, unknown>;
      const j = (raw.json ?? raw) as { decision?: string; notes?: string; prompt?: string; commit?: { title?: string; body?: string } };
      const accepted = j.decision === 'accept';
      if (accepted && j.commit?.title) setTaskMeta(task.id, 'commitProposal', { title: String(j.commit.title), body: String(j.commit.body ?? '') });
      emit('accept.decided', getAgent(usedAgentId)?.name ?? 'pm', { taskId: task.id, decision: accepted ? 'accept' : 'rework', notes: j.notes ?? null }, r.id, task.id);
      if (accepted) {
        setTaskStatus(task.id, 'approved', 'pm', { reason: j.notes ?? 'accepted' });
        await proceedMerge(task.id);
        return;
      }
      setTaskStatus(task.id, 'changes-requested', 'pm', { reason: j.notes ?? 'sent back for rework' });
      const instructions = typeof j.prompt === 'string' && j.prompt.trim() ? j.prompt.trim() : `Rework needed: ${j.notes ?? 'see the QA report'}`;
      dispatchFix(task, instructions, false, instructions);
      return;
    }

    case 'diagnose': {
      if (!task) return;
      const raw = (result.raw ?? {}) as Record<string, any>;
      const j = (raw.json ?? raw) as { diagnosis?: string; strategy?: string; splits?: { title?: string; description?: string; affectedPaths?: string[]; acceptanceCriteria?: string[] }[]; notes?: string };
      emit('task.diagnosed', getAgent(usedAgentId)?.name ?? 'pm', { taskId: task.id, diagnosis: j.diagnosis ?? null, strategy: j.strategy ?? 'human' }, r.id, task.id);
      const splits = (Array.isArray(j.splits) ? j.splits : []).filter((s) => s?.title).slice(0, 3);
      if (j.strategy === 'retry-stronger') {
        run('UPDATE tasks SET attempts = 0, difficulty = ? WHERE id = ?', Math.min(5, task.difficulty + 2), task.id);
        emit('task.strategy', 'engine', { taskId: task.id, strategy: 'stronger-tier', diagnosis: j.diagnosis }, r.id, task.id);
        setTaskStatus(task.id, 'ready', 'engine', { reason: `PM diagnosis: retry on a stronger model — ${j.diagnosis ?? ''}` });
      } else if (j.strategy === 'split' && splits.length >= 2) {
        for (const s of splits) {
          const tid = ulid();
          run(`INSERT INTO tasks (id, run_id, parent_id, title, description, type, status, priority, depends_on, acceptance_criteria, planned_by, difficulty, budget_usd, affected_paths, meta)
               VALUES (?,?,?,?,?,?, 'ready', ?, '[]', ?, 'pm', ?, ?, ?, '{}')`,
            tid, r.id, task.id, String(s.title).slice(0, 200), String(s.description ?? '').slice(0, 2000), task.type, task.priority,
            JSON.stringify((s.acceptanceCriteria ?? []).slice(0, 8)), task.difficulty, task.budgetUsd, JSON.stringify((s.affectedPaths ?? []).slice(0, 20)));
          emit('task.created', 'engine', { taskId: tid, title: s.title, splitFrom: task.id }, r.id, tid);
        }
        setTaskStatus(task.id, 'cancelled', 'engine', { reason: `split into ${splits.length} subtasks by the PM` });
      } else {
        // "human" — or an unreadable strategy: escalate with the diagnosis
        setTaskStatus(task.id, 'failed', 'engine', { reason: j.diagnosis ?? 'PM could not find a strategy change' });
        requestApproval({
          action: 'task.escalate', taskId: task.id, runId: r.id, requestedBy: 'pm',
          payload: { summary: `"${task.title}" needs the owner. PM diagnosis: ${(j.diagnosis ?? j.notes ?? 'no path forward').slice(0, 300)}` },
        });
        return;
      }
      void maybeAdvanceRun(r.id);
      return;
    }

    case 'analyse': {
      const pending = pendingAnalysis.get(wi.id);
      pendingAnalysis.delete(wi.id);
      if (!pending || !task) return;
      const cr = q1('SELECT * FROM check_runs WHERE id = ?', pending.checkRunId);
      if (!cr) return;
      const raw = (result.raw ?? {}) as Record<string, unknown>;
      const j = (raw.json ?? raw) as Record<string, any>;
      const { report } = fileErrorReport({
        runId: r.id, cycleN: r.currentCycle, task, workItemId: wi.id,
        checkRun: {
          id: cr.id as string, checkId: cr.check_id as string, workItemId: cr.work_item_id as string | null,
          taskId: cr.task_id as string | null, runId: r.id, commitSha: cr.commit_sha as string | null,
          ref: cr.ref as string, status: cr.status as never, durationMs: cr.duration_ms as number,
          evidenceRefs: parseJson(cr.evidence_refs as string, []), summary: cr.summary as string,
          failures: parseJson(cr.failures as string, []), createdAt: cr.created_at as string,
        },
        checkName: pending.checkName, checkCommand: (q1('SELECT command FROM checks WHERE id = ?', cr.check_id)?.command as string) ?? '',
        affectedFiles: pending.files, workspaceId: r.workspaceId,
        analyst: {
          title: j.title, suspectedCause: j.suspectedCause, steps: j.steps, suggestedFix: j.suggestedFix,
        },
      });
      routeFixAfterReport(task, report.id);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Verify → document → fix/review (phases 5–7)
// ---------------------------------------------------------------------------

function selectChecksForTask(repo: Repo, filesChanged: string[]): Check[] {
  const all = repoChecks(repo.id);
  const intersects = (globs: string[]) =>
    globs.some((g) => {
      const prefix = g.replace(/[*?].*$/, '');
      return filesChanged.some((f) => f === g || f.startsWith(prefix));
    });
  // Command checks run per-task, scoped by affectedPaths (empty = global code
  // check). errors:* and review:* are DoD gates — integration branch only.
  const codeChecks = all.filter((c) => c.command && (!c.affectedPaths.length || intersects(c.affectedPaths)));
  // doc checks run per-task only when their target file was changed.
  const docChecks = all.filter((c) => !c.command && c.kind === 'doc').filter((c) => {
    const m = c.passRule.match(/\(([^,)]+)/);
    return m ? filesChanged.includes(m[1].trim()) : false;
  });
  const picked = [...codeChecks, ...docChecks];
  return picked.length ? picked : codeChecks;
}

async function verifyDeliveredTask(wi: WorkItem, task: Task, result: NonNullable<WorkItem['result']>): Promise<void> {
  const r = getRun(wi.runId)!;
  const repo = getRepo(r.repoId)!;
  const worktree = task.worktree!;

  // Anti-gaming enforcement (spec 5.2, 10.3): protected paths + dependency
  // changes need owner approval before merge.
  const files = isDirect(r) ? taskFiles(repo, task) : (result.filesChanged ?? changedFiles(worktree, repo.integrationBranch));
  const scan = scanDeliveredFiles(files.filter((f) => f !== 'HANDOFF.md'));
  if (scan.protectedHits.length) {
    requestApproval({
      action: 'file.write.protected', taskId: task.id, workItemId: wi.id, runId: r.id, requestedBy: wi.agentId ?? 'agent',
      payload: { summary: `Delivery touches protected paths: ${scan.protectedHits.join(', ')}`, files: scan.protectedHits,
        risk: { risky: true, reasons: [`protected paths: ${scan.protectedHits.slice(0, 6).join(', ')}`] } },
    });
  }
  if (scan.depChanges.length) {
    requestApproval({
      action: 'deps.add', taskId: task.id, workItemId: wi.id, runId: r.id, requestedBy: wi.agentId ?? 'agent',
      payload: { summary: `Dependency manifest changed: ${scan.depChanges.join(', ')}`, files: scan.depChanges,
        risk: { risky: true, reasons: [`dependency/lockfile changes: ${scan.depChanges.slice(0, 6).join(', ')}`] } },
    });
  }

  // Scope guard (spec 6.4): files outside the prompt's declared paths don't
  // block the change — they go to the PM as a question, and the accept stage
  // decides whether the extra files belong.
  const declared = (task.affectedPaths ?? []).filter(Boolean);
  const delivered = files.filter((f) => f !== 'HANDOFF.md' && !f.startsWith('.office/'));
  if (declared.length && delivered.length) {
    const outside = delivered.filter((f) => !anyGlobMatch(f, declared));
    if (outside.length) {
      emit('scope.violation', 'engine', { taskId: task.id, files: outside.slice(0, 20), declared }, r.id, task.id);
      const pm = pickHelper(r.workspaceId, 'pm', [task.ownerAgentId ?? undefined]);
      if (pm) postMessage({
        runId: r.id, taskId: task.id, workItemId: wi.id,
        from: wi.agentId ?? 'engine', to: pm.agent.id, kind: 'question',
        text: `Scope check on "${task.title}": the delivery changed files outside the declared paths.\nDeclared: ${declared.join(', ')}\nUnexpected: ${outside.join(', ')}\nDo these belong, or should the change be narrowed?`,
      });
      setTaskMeta(task.id, 'scopeViolation', { files: outside.slice(0, 20), at: now() });
    }
  }

  setTaskStatus(task.id, 'verifying');
  const checks = selectChecksForTask(repo, files);
  const results: { cr: ReturnType<typeof rowToCheckRun>; check: Check }[] = [];
  for (const check of checks) {
    const cr = await runCheck({
      check, worktree, runId: r.id, taskId: task.id, workItemId: wi.id,
      commitSha: result.sha ?? null, ref: task.branch ?? '',
    });
    results.push({ cr: rowToCheckRun(cr), check });
  }

  const failed = results.filter((x) => x.cr.status === 'fail' || x.cr.status === 'error');
  // graph runs: engine checks still decide pass/fail here; the graph's edges
  // decide which node runs next
  if (graphFor(r)) { await graphChecksDone(wi, task, results, files); return; }
  if (!failed.length) {
    // resolve open Error Reports for this task — fix acceptance is check-based.
    const passCr = results.find((x) => x.cr.status === 'pass')?.cr;
    for (const er of q(`SELECT id FROM error_reports WHERE task_id = ? AND status IN ('open','assigned','fixing','verifying','reopened')`, task.id)) {
      resolveError(er.id as string, result.sha ?? null, passCr?.id ?? '', `Fixed on attempt ${wi.attempt} (${result.summary})`, r.workspaceId);
    }
    // QA (phase 6b): a tester runs the tests and reports before review.
    if (task.type !== 'docs' && dispatchQa(task, results)) return;
    setTaskStatus(task.id, 'in-review');
    dispatchReview(task, results);
    return;
  }

  // Analyst phase (6): dispatch analysis if an analyst is eligible; otherwise
  // the engine files a rule-only report (spec: the loop slows but keeps working).
  const first = failed[0];
  const analyst = pickAgent(r.workspaceId, 'analyst', task, 'analyse', 2);
  if (analyst) {
    const pack = packFor(repo, task, analyst, 12000, 'analyse');
    const prompt = renderPrompt({
      kind: 'analyse', agent: analyst.agent, role: analyst.role, task, pack, adapterId: analyst.provider?.adapterId,
      extra: {
        checkResults: JSON.stringify(failed.map((f) => ({ check: f.check.name, summary: f.cr.summary, failures: f.cr.failures })), null, 2),
        inbox: inboxText(analyst, r.id, task.id),
      },
    });
    const wiA = createWorkItemRecord(r.id, task, 'analyse', analyst, prompt, pack.hash);
    pendingAnalysis.set(wiA.id, { checkRunId: first.cr.id, taskId: task.id, checkName: first.check.name, files });
    void executeWorkItem(wiA, analyst, prompt.text, null);
    return;
  }

  const { report } = fileErrorReport({
    runId: r.id, cycleN: r.currentCycle, task, workItemId: wi.id,
    checkRun: first.cr, checkName: first.check.name, checkCommand: first.check.command,
    affectedFiles: files, workspaceId: r.workspaceId,
  });
  updateReportHistory(report.id, wi.id, first.cr.id, 'still-failing');
  routeFixAfterReport(task, report.id);
}

function rowToCheckRun(cr: { id: string; checkId: string; workItemId: string | null; taskId: string | null; runId: string; commitSha: string | null; ref: string; status: string; durationMs: number; evidenceRefs: string[]; summary: string; failures: { name: string; file?: string; message?: string }[]; createdAt: string }) {
  return { ...cr, status: cr.status as 'pass' | 'fail' | 'error' | 'flaky' };
}

function updateReportHistory(reportId: string, wiId: string, checkRunId: string, outcome: string): void {
  const r = q1('SELECT history, task_id FROM error_reports WHERE id = ?', reportId);
  if (!r) return;
  const history = parseJson<{ attempt: number; agentId: string; commitSha: string | null; checkRunId: string; outcome: string }[]>(r.history as string, []);
  const wi = getWorkItem(wiId);
  history.push({ attempt: history.length + 1, agentId: wi?.agentId ?? '', commitSha: null, checkRunId, outcome });
  run('UPDATE error_reports SET history = ?, updated_at = ? WHERE id = ?', JSON.stringify(history), now(), reportId);
}

function routeFixAfterReport(task: Task, reportId: string): void {
  const report = rowToError(q1('SELECT * FROM error_reports WHERE id = ?', reportId)!);
  const r = getRun(task.runId)!;
  const attempt = report.assignment.attempt + 1;
  if (attempt > report.assignment.maxAttempts) {
    run(`UPDATE error_reports SET status = 'escalated', escalation = ?, updated_at = ? WHERE id = ?`,
      JSON.stringify({ to: 'owner', reason: `fix attempts exhausted (${report.assignment.maxAttempts})`, at: now() }), now(), reportId);
    setTaskStatus(task.id, 'blocked', 'engine', { reason: 'fix attempts exhausted', errorId: reportId });
    requestApproval({
      action: 'error.escalation', taskId: task.id, runId: r.id, requestedBy: 'analyst',
      payload: { summary: `${reportId}: "${report.title}" still failing after ${report.assignment.maxAttempts} fixes`, errorId: reportId },
    });
    void maybeAdvanceRun(r.id);
    return;
  }
  run(`UPDATE error_reports SET status = 'assigned', assignment = ?, updated_at = ? WHERE id = ?`,
    JSON.stringify({ ...report.assignment, attempt, assignedAt: now() }), now(), reportId);
  const analystWi = report.workItemId ? getWorkItem(report.workItemId) : null;
  const fromAgent = analystWi?.kind === 'analyse' ? analystWi.agentId : null;
  if (fromAgent && task.ownerAgentId) {
    postMessage({ runId: r.id, taskId: task.id, from: fromAgent, to: task.ownerAgentId, kind: 'finding',
      text: `${reportId}: ${report.title}. Suspected cause: ${report.suspectedCause?.summary ?? 'unknown'}. Suggested fix: ${report.suggestedFix?.approach ?? '—'}` });
  }
  dispatchFix(task, `Fix ${reportId}: ${report.title}\n\nSuspected cause: ${report.suspectedCause?.summary ?? '?'}\n\nLog excerpt:\n${compactLog(report.evidence?.logExcerpt ?? '', 60)}`, true);
}

// pmPrompt: the PM's rework instructions from acceptance — sent as written
// (with the engine's contract), so no extra prompt-writing call.
function dispatchFix(task: Task, reason: string, fromError: boolean, pmPrompt?: string): void {
  const r = getRun(task.runId)!;
  // Escalation ladder (5.6): attempt 1-2 original dev; attempt 3 different agent.
  const report = task.id ? q1(`SELECT id, assignment FROM error_reports WHERE task_id = ? AND status IN ('assigned','open','fixing','reopened') ORDER BY created_at DESC LIMIT 1`, task.id) : null;
  const attempt = report ? (parseJson<{ attempt: number }>(report.assignment as string, { attempt: 1 }).attempt) : 1;
  const fixRole = roleNameFor('fix', task);
  let candidate: Candidate | null = null;
  if (attempt <= 2 && task.ownerAgentId) {
    const agent = getAgent(task.ownerAgentId);
    const cands = candidatesForRole(r.workspaceId, fixRole);
    candidate = cands.find((c) => c.agent.id === agent?.id && !c.blocked) ?? null;
  }
  if (!candidate) {
    const all = candidatesForRole(r.workspaceId, fixRole).filter((c) => !c.blocked && c.agent.id !== task.ownerAgentId);
    candidate = all[0] ?? candidatesForRole(r.workspaceId, fixRole).find((c) => !c.blocked) ?? null;
  }
  if (!candidate) {
    setTaskStatus(task.id, 'blocked', 'engine', { reason: 'no eligible fixer' });
    void maybeAdvanceRun(r.id);
    return;
  }
  // bound the review/merge-conflict fix loop too (SAME_ERROR invariant)
  const fixCount = (q1(`SELECT COUNT(*) c FROM work_items WHERE task_id = ? AND kind = 'fix'`, task.id)?.c as number) ?? 0;
  if (fixCount >= r.limits.sameErrorAttempts) {
    setTaskStatus(task.id, 'blocked', 'engine', { reason: 'fix loop bound reached' });
    requestApproval({ action: 'task.escalate', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `"${task.title}" bounced ${fixCount} times (merge conflicts/review). Needs owner.` } });
    void maybeAdvanceRun(r.id);
    return;
  }
  const repo = getRepo(r.repoId);
  const pack = packFor(repo, task, candidate, 16000, 'fix');
  if (candidate.agent.id !== task.ownerAgentId) {
    pmHandoff(r, task, candidate, `Reassigning "${task.title}" to you (${candidate.role.name}) from ${getAgent(task.ownerAgentId)?.name ?? 'its previous owner'}. ${reason.split('\n')[0]}`.slice(0, 600));
  }
  if (pmPrompt && promptMode(r) === 'pipeline') {
    // the PM's findings become a correction prompt prepared by the Prompt Creator
    const base = renderPrompt({
      kind: 'fix', agent: candidate.agent, role: candidate.role, task, pack, adapterId: candidate.provider?.adapterId,
      extra: { checkResults: `Findings from the PM's acceptance check:\n${pmPrompt}`, approvedPrompt: approvedPromptFor(task.id),
        requirementsChanged: takeRequirementNote(task), handoffPath: handoffPath(task, isDirect(r)) },
    });
    setTaskStatus(task.id, 'assigned', 'pm', { fixer: candidate.agent.name, stage: 'correction prompt' });
    dispatchWork(r, task, 'fix', candidate, base, pack.hash, task.worktree, true, `Findings from the PM's acceptance check:\n${pmPrompt}`);
    return;
  }
  if (pmPrompt) {
    const header = [`# Rework: ${task.title}`, task.description,
      task.acceptanceCriteria.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
    const prompt = finalizeApprovedPrompt(`${header}\n\n## Instructions from the PM\n${pmPrompt}`, 'fix', candidate.provider?.adapterId, inboxText(candidate, r.id, task.id), candidate.role, handoffPath(task, isDirect(r)), pack.budgetChars);
    setTaskStatus(task.id, 'assigned', 'pm', { fixer: candidate.agent.name });
    dispatchWork(r, task, 'fix', candidate, prompt, pack.hash, task.worktree, false);
    return;
  }
  // The first correction of a task goes straight to the developer: the error
  // report / reviewer findings plus the approved brief say exactly what to
  // fix. Only a repeated failure gets a re-thought prompt (Prompt Creator + PM).
  const reviewed = pmWritesPrompt(r, 'fix') && fixCount >= 1;
  const prompt = renderPrompt({
    kind: 'fix', agent: candidate.agent, role: candidate.role, task, pack, adapterId: candidate.provider?.adapterId,
    extra: { handoff: envelopeText(handoffEnvelope(task, 'developer', { blockers: [reason.split('\n')[0].slice(0, 300)] })),
      checkResults: reason, requirementsChanged: takeRequirementNote(task), inbox: reviewed ? '' : inboxText(candidate, r.id, task.id), handoffPath: handoffPath(task, isDirect(r)), approvedPrompt: approvedPromptFor(task.id),
      kbNotes: lessonNotes(r, task) },
  });
  setTaskStatus(task.id, 'assigned', 'analyst', { fixer: candidate.agent.name, route: reviewed ? 'correction prompt' : 'direct' });
  dispatchWork(r, task, 'fix', candidate, prompt, pack.hash, task.worktree, reviewed, reason);
  void fromError;
}

type CheckOutcome = { cr: { status: string; summary: string }; check: Check };

// review rejections are bounded (disagreeK); past that the owner arbitrates
function rejectsBelowLimit(task: Task, r: Run): boolean {
  const rejects = (q1(`SELECT COUNT(*) c FROM work_items WHERE task_id = ? AND kind = 'review'`, task.id)?.c as number) ?? 0;
  return rejects < r.limits.disagreeK;
}

// The developer's own HANDOFF.md for this delivery, if it wrote one.
function changeNotes(task: Task): string {
  const direct = isDirect(getRun(task.runId));
  try { return task.worktree ? fs.readFileSync(path.resolve(task.worktree, handoffPath(task, direct)), 'utf8') : ''; } catch { return ''; }
}

// Review & validation stage: the tester (Cursor) reviews the diff, runs the
// tests and checks the acceptance criteria, then reports to the PM.
// Returns false when no tester is available (the task goes straight to review).
function dispatchQa(task: Task, results: CheckOutcome[]): boolean {
  const r = getRun(task.runId)!;
  const tester = pickAgent(r.workspaceId, 'qa', task, 'qa', task.difficulty);
  if (!tester || !task.worktree) return false;
  const repo = getRepo(r.repoId);
  const diff = repo && task.worktree ? taskDiff(repo, task) : '';
  const pack = packFor(repo, task, tester, 12000, 'qa', { diffChars: diff.length });
  if (task.ownerAgentId && task.ownerAgentId !== tester.agent.id) {
    postMessage({ runId: r.id, taskId: task.id, from: task.ownerAgentId, to: tester.agent.id, kind: 'handoff',
      text: `"${task.title}" passed the engine checks (${results.map((x) => `${x.check.name} ${x.cr.status}`).join(', ') || 'none ran'}). My notes are in CHANGE_NOTES — please review and validate it.` });
  }
  const reviewed = pmWritesPrompt(r, 'qa');
  const prompt = renderPrompt({
    kind: 'qa', agent: tester.agent, role: tester.role, task, pack, adapterId: tester.provider?.adapterId,
    extra: {
      handoff: envelopeText(handoffEnvelope(task, 'qa')),
      changeNotes: changeNotes(task),
      approvedPrompt: approvedPromptFor(task.id),
      diff,
      checkResults: results.map((x) => `${x.check.name}: ${x.cr.status} — ${x.cr.summary}`).join('\n'),
      inbox: reviewed ? '' : inboxText(tester, r.id, task.id),
    },
  });
  setTaskStatus(task.id, 'verifying', 'engine', { stage: 'qa', tester: tester.agent.name });
  dispatchWork(r, task, 'qa', tester, prompt, pack.hash, task.worktree, reviewed);
  return true;
}

function dispatchReview(task: Task, results: CheckOutcome[], qaReport?: string): void {
  const r = getRun(task.runId)!;
  let candidate = pickAgent(r.workspaceId, 'reviewer', task, 'review', Math.max(2, task.difficulty));
  // Opt-in (workspace setting selfReview): the author may do the review pass
  // when no independent reviewer exists — e.g. Devin implements and reviews.
  if (!candidate && getWorkspace(r.workspaceId)?.settings?.selfReview) {
    candidate = candidatesForRole(r.workspaceId, 'reviewer').find((c) => !c.blocked) ?? null;
    if (candidate) emit('sod.waived', 'engine', { taskId: task.id, reviewer: candidate.agent.name, reason: 'selfReview enabled for this workspace' }, r.id, task.id);
  }
  if (!candidate) {
    emit('sod.violation', 'engine', { taskId: task.id, reason: 'no eligible reviewer (author excluded)' }, r.id, task.id);
    requestApproval({ action: 'review.unavailable', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `No eligible reviewer for "${task.title}" (author cannot self-review). Owner can approve the task from its detail page.` } });
    return;
  }
  const repo = getRepo(r.repoId);
  const diff = task.worktree && repo ? taskDiff(repo, task) : '';
  const pack = packFor(repo, task, candidate, 12000, 'review', { diffChars: diff.length });
  const checkSummary = results.map((x) => `${x.check.name}: ${x.cr.status} — ${x.cr.summary}`).join('\n');
  if (task.ownerAgentId && task.ownerAgentId !== candidate.agent.id) {
    postMessage({ runId: r.id, taskId: task.id, from: task.ownerAgentId, to: candidate.agent.id, kind: 'handoff',
      text: `"${task.title}" is ready for review. Checks: ${results.map((x) => `${x.check.name} ${x.cr.status}`).join(', ') || 'none ran'}.${qaReport ? ' QA passed.' : ''}` });
  }
  const reviewed = pmWritesPrompt(r, 'review');
  const prompt = renderPrompt({
    kind: 'review', agent: candidate.agent, role: candidate.role, task, pack, adapterId: candidate.provider?.adapterId,
    extra: { handoff: envelopeText(handoffEnvelope(task, 'reviewer', { blockers: qaReport ? [qaReport.slice(0, 300)] : [] })),
      diff, changeNotes: changeNotes(task), approvedPrompt: approvedPromptFor(task.id), checkResults: qaReport ? `${checkSummary}\n\nQA REPORT:\n${qaReport}` : checkSummary, inbox: reviewed ? '' : inboxText(candidate, r.id, task.id) },
  });
  dispatchWork(r, task, 'review', candidate, prompt, pack.hash, null, reviewed);
}

export async function proceedMerge(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task || task.status !== 'approved') return;
  const r = getRun(task.runId)!;
  const repo = getRepo(r.repoId)!;

  // any pending approvals for this task? wait.
  const pending = q1(`SELECT COUNT(*) c FROM approvals WHERE task_id = ? AND status = 'pending' AND action != 'commit.task'`, taskId)?.c as number;
  if (pending > 0) {
    emit('merge.waiting-approval', 'engine', { taskId, pending }, r.id, taskId);
    return;
  }
  if (isDirect(r)) {
    // the work is already in the repository — record the result and commit per policy
    closeTaskCheckpoint(task.id);
    setTaskStatus(task.id, 'done');
    proposeTaskCommit(getTask(task.id)!);
    await evaluateDodOnIntegration(r.id);
    void maybeAdvanceRun(r.id);
    return;
  }
  // Strip HANDOFF.md on the task branch before merge (spec 6.5) — it is
  // metadata for agents, not deliverable, and would conflict across tasks.
  if (task.worktree && fs.existsSync(path.join(task.worktree, 'HANDOFF.md'))) {
    try {
      fs.rmSync(path.join(task.worktree, 'HANDOFF.md'));
      commitAll(task.worktree, 'office: remove HANDOFF.md pre-merge');
    } catch { /* best-effort */ }
  }
  const res = mergeIntoIntegration(repo, task.branch ?? taskBranch(task.id));
  if (!res.ok) {
    emit('merge.conflict', 'engine', { taskId, conflicts: res.conflicts }, r.id, taskId);
    setTaskStatus(task.id, 'changes-requested', 'engine', { reason: 'merge conflict', conflicts: res.conflicts });
    dispatchFix(task, `Merge conflict on ${res.conflicts?.join(', ')}. Rebase your branch onto integration and resolve.`, false);
    return;
  }
  // strip HANDOFF.md from integration history
  const wt = path.join(repo.path, '.office', 'integration');
  const hm = path.join(wt, 'HANDOFF.md');
  if (fs.existsSync(hm)) { fs.rmSync(hm); }
  emit('merge.completed', 'engine', { taskId, sha: res.sha }, r.id, taskId);
  run(`UPDATE handoffs SET artifacts = json_set(artifacts, '$.mergedSha', ?) WHERE task_id = ?`, res.sha ?? '', taskId);
  setTaskStatus(task.id, 'done');
  await evaluateDodOnIntegration(r.id);
  void maybeAdvanceRun(r.id);
}

// ---------------------------------------------------------------------------
// Prompt preparation (spec 2): Prompt Creator drafts → PM reviews → revise or
// approve → the target agent receives the approved prompt. Without a Prompt
// Creator the PM writes the prompt itself and it goes straight to the target.
// Revisions are bounded; past the bound, or when a stage cannot run, the
// owner decides.
// ---------------------------------------------------------------------------

interface PromptJob {
  runId: string; taskId: string; kind: WorkItemKind; targetAgentId: string;
  basePrompt: string; packHash: string; worktree: string | null; budgetChars?: number;
  revision: number; draft?: string; notes?: string; creatorId?: string;
  drafter: 'prompt-creator' | 'pm';   // who writes the prompt
  findings?: string;                   // what a correction must address
  retries?: number;                    // transient-failure retries of the current stage
}

const PROMPT_MAX_REVISIONS = 2;
const promptJobs = new Map<string, PromptJob>();      // keyed by the stage's work item id
const escalatedPrompts = new Map<string, PromptJob>(); // keyed by task id

// Which dispatches get a prepared prompt (workspace setting promptReview):
//   'pipeline' (default) — the Prompt Creator drafts the developer's prompt
//                and every correction prompt; the PM reviews each draft (the PM
//                drafts itself when there is no Prompt Creator). The reviewer
//                gets the developer's notes and the approved prompt directly.
//   'handoffs' — the PM writes only the developer's task prompt; its rework
//                instructions and check-failure reports go straight to the
//                developer. Fewest model calls.
//   'all'      — every prompt is prepared (implement, fix, QA, review).
//   'off'      — agents get the engine's prompt directly.
// (The older 'implement' value means 'handoffs'.)
function promptMode(r: Run): 'pipeline' | 'handoffs' | 'all' | 'off' {
  const mode = getWorkspace(r.workspaceId)?.settings?.promptReview;
  return mode === 'off' || mode === 'all' || mode === 'handoffs' ? mode : mode === 'implement' ? 'handoffs' : 'pipeline';
}
function pmWritesPrompt(r: Run, kind: WorkItemKind): boolean {
  const mode = promptMode(r);
  if (mode === 'off') return false;
  // reviewer/tester prompts are built from the approved brief, the change
  // notes and the diff — re-drafting them added two model calls per review
  // and changed nothing they check against ('all' now means pipeline)
  if (mode === 'all' || mode === 'pipeline') return kind === 'implement' || kind === 'fix';
  return kind === 'implement';
}

// The approved prompt for a task — the authoritative statement of what the
// developer was asked to do. Corrections and reviews are measured against it.
function approvedPromptFor(taskId: string): string {
  // the approved brief (short); the task statement when none was prepared.
  // Passing the full rendered prompt (repo excerpts and all) made every
  // review and acceptance re-read 10–20k characters.
  const t = getTask(taskId);
  const brief = t?.meta?.approvedBrief as string | undefined;
  if (brief) return brief;
  return t ? `${t.title}\n${t.description}`.trim() : '';
}

// Acceptance (final step): the PM checks the tester's report and the
// developer's notes against the request and accepts or sends the task back.
// Returns false when no PM is available.
function dispatchAccept(task: Task, qaReport: string, qaFailed: boolean): boolean {
  const r = getRun(task.runId)!;
  const pm = pickHelper(r.workspaceId, 'pm', [task.ownerAgentId ?? undefined]);
  if (!pm) return false;
  // a short prompt: no repo files, no diff — the PM judges outcomes, not code
  const pack = deskPack(pm, 12000, 'accept');
  const prompt = renderPrompt({
    kind: 'accept', agent: pm.agent, role: pm.role, task, goal: r.goal, pack, adapterId: pm.provider?.adapterId,
    extra: { handoff: envelopeText(handoffEnvelope(task, 'pm', { blockers: qaFailed ? [qaReport.slice(0, 300)] : [] })),
      changeNotes: changeNotes(task).slice(0, 3000), qaReport: qaReport.slice(0, 4000), approvedPrompt: approvedPromptFor(task.id), inbox: inboxText(pm, r.id, task.id) },
  });
  setTaskStatus(task.id, 'in-review', 'engine', { stage: 'accept', pm: pm.agent.name, qa: qaFailed ? 'fail' : 'pass' });
  const wi = createWorkItemRecord(r.id, task, 'accept', pm, prompt, pack.hash);
  void executeWorkItem(wi, pm, prompt.text, null);
  return true;
}

function pickHelper(workspaceId: string, roleName: string, exclude: (string | undefined)[]): Candidate | null {
  return candidatesForRole(workspaceId, roleName).find((c) => !c.blocked && !exclude.includes(c.agent.id)) ?? null;
}

function setPromptStage(task: Task, stage: string, extra: Record<string, unknown> = {}): void {
  setTaskMeta(task.id, 'promptStage', stage);
  emit('prompt.stage', 'engine', { taskId: task.id, title: task.title, stage, ...extra }, task.runId, task.id);
}

// Halts the pipeline when the owner paused/stopped: the task goes back to
// ready and is re-prepared from scratch on resume.
function pipelineHalted(job: PromptJob): boolean {
  const r = getRun(job.runId);
  if (r?.status === 'running') return false;
  const t = getTask(job.taskId);
  if (t && !TERMINAL_TASK.includes(t.status)) {
    setTaskMeta(t.id, 'promptStage', null);
    setTaskStatus(t.id, 'ready', 'engine', { reason: 'run paused during prompt preparation' });
  }
  return true;
}

function dispatchWork(r: Run, task: Task, kind: WorkItemKind, target: Candidate, prompt: string | RenderedPrompt, packHash: string, worktree: string | null, review: boolean, findings?: string): void {
  const promptText = typeof prompt === 'string' ? prompt : prompt.text;
  const budgetChars = typeof prompt === 'string' ? undefined : prompt.budgetChars;
  if (review) {
    // pipeline: the Prompt Creator drafts and the PM reviews; without a
    // Prompt Creator the PM writes the prompt itself
    const pm = pickHelper(r.workspaceId, 'pm', [target.agent.id]);
    const creator = promptMode(r) !== 'handoffs' ? pickHelper(r.workspaceId, 'prompt-creator', [target.agent.id]) : null;
    if (pm) {
      startPromptDraft({ runId: r.id, taskId: task.id, kind, targetAgentId: target.agent.id, basePrompt: promptText, packHash, worktree, budgetChars, revision: 0, drafter: creator ? 'prompt-creator' : 'pm', findings });
      return;
    }
    emit('prompt.review.skipped', 'engine', { taskId: task.id, reason: 'no PM available to write the prompt' }, r.id, task.id);
  }
  const wi = createWorkItemRecord(r.id, task, kind, target, prompt, packHash);
  void executeWorkItem(wi, target, promptText, worktree);
}

function startPromptDraft(job: PromptJob): void {
  if (pipelineHalted(job)) return;
  const r = getRun(job.runId)!;
  const task = getTask(job.taskId);
  if (!task) return;
  let creator = pickHelper(r.workspaceId, job.drafter, [job.targetAgentId]);
  // the Prompt Creator went away mid-pipeline — the PM takes the draft over
  if (!creator && job.drafter === 'prompt-creator') {
    creator = pickHelper(r.workspaceId, 'pm', [job.targetAgentId]);
    if (creator) job = { ...job, drafter: 'pm' };
  }
  if (!creator) { escalatePrompt(job, `no ${job.drafter === 'pm' ? 'PM' : 'Prompt Creator'} is available to write the prompt`); return; }
  const target = getAgent(job.targetAgentId);
  // desk work: no repo tour — the brief plus the target's facts are the job
  const pack = deskPack(creator, 12000, job.packHash);
  const prompt = renderPrompt({
    kind: 'prompt', agent: creator.agent, role: creator.role, task, goal: r.goal, pack, adapterId: creator.provider?.adapterId,
    // the drafter writes a short brief from the facts; the engine attaches
    // repository context, criteria and contract itself when it dispatches
    extra: {
      target: `${target?.name ?? job.targetAgentId} — ${roleNameFor(job.kind, task)} agent, work kind "${job.kind}"`,
      checkResults: job.findings, approvedPrompt: job.kind === 'fix' ? approvedPromptFor(task.id) : undefined,
      relevantFiles: task.affectedPaths.join('\n'), revisionNotes: job.notes, inbox: inboxText(creator, r.id, task.id),
    },
  });
  const wi = createWorkItemRecord(r.id, task, 'prompt', creator, prompt, job.packHash);
  promptJobs.set(wi.id, { ...job, creatorId: creator.agent.id });
  setPromptStage(task, job.revision ? 'revising' : 'drafting', { revision: job.revision, agent: creator.agent.name });
  void executeWorkItem(wi, creator, prompt.text, null);
}

function startPromptReview(job: PromptJob): void {
  if (pipelineHalted(job)) return;
  const r = getRun(job.runId)!;
  const task = getTask(job.taskId);
  if (!task) return;
  // the PM never reviews a prompt it drafted, nor one it will execute
  const pm = pickHelper(r.workspaceId, 'pm', [job.creatorId, job.targetAgentId]);
  if (!pm) { escalatePrompt(job, 'no PM is available to review the prompt'); return; }
  const pack = deskPack(pm, 12000, job.packHash);
  const prompt = renderPrompt({
    kind: 'prompt-review', agent: pm.agent, role: pm.role, task, goal: r.goal, pack, adapterId: pm.provider?.adapterId,
    extra: { draft: job.draft, target: `${getAgent(job.targetAgentId)?.name ?? job.targetAgentId} (${job.kind})`, inbox: inboxText(pm, r.id, task.id) },
  });
  const wi = createWorkItemRecord(r.id, task, 'prompt-review', pm, prompt, job.packHash);
  promptJobs.set(wi.id, job);
  setPromptStage(task, 'pm-review', { revision: job.revision, agent: pm.agent.name });
  void executeWorkItem(wi, pm, prompt.text, null);
}

function dispatchApprovedPrompt(job: PromptJob): void {
  if (pipelineHalted(job)) return;
  const r = getRun(job.runId)!;
  let task = getTask(job.taskId);
  if (!task) return;
  // read-only lane (direct mode): a task that drafted its prompt while another
  // task held the tree parks here — the write stage still needs the tree.
  // assignSweep resumes it the moment the holder finishes.
  if (isDirect(r) && ['implement', 'fix', 'test', 'doc'].includes(job.kind)) {
    const held = q(`SELECT t.id FROM tasks t WHERE t.id != ? AND t.status NOT IN ('done','failed','cancelled','blocked')
                    AND json_extract(t.meta, '$.generalCheckpointId') IS NOT NULL`, task.id)
      .some((x) => { const h = getTask(x.id as string); return h ? holdsRepo(h) : false; });
    if (held) {
      setTaskMeta(task.id, 'parkedPrompt', job);
      setTaskMeta(task.id, 'promptReady', true);
      emit('task.parked', 'engine', { taskId: task.id, reason: 'approved prompt ready — waiting for the repository' }, r.id, task.id);
      return;
    }
  }
  const role = roleNameFor(job.kind, task);
  const target = candidatesForRole(r.workspaceId, role).find((c) => c.agent.id === job.targetAgentId && !c.blocked)
    ?? pickAgent(r.workspaceId, role, task, job.kind, task.difficulty);
  if (!target) { setTaskStatus(task.id, 'ready', 'engine', { reason: 'target agent unavailable after prompt approval' }); void maybeAdvanceRun(r.id); return; }
  // a brief (the new format) rides on top of the engine's prompt, which already
  // carries the task, criteria, context and contract; an old-style full
  // prompt (contains its own contract) is used as written
  const draft = job.draft ?? job.basePrompt;
  const isBrief = !draft.includes('OUTPUT CONTRACT');
  const body = isBrief ? `## Brief (approved by the PM)\n${draft.trim()}\n\n${job.basePrompt}` : draft;
  const prompt = finalizeApprovedPrompt(body, job.kind, target.provider?.adapterId, inboxText(target, r.id, task.id), target.role, handoffPath(task, isDirect(r)), job.budgetChars ?? 0);
  if (isBrief) setTaskMeta(task.id, job.kind === 'implement' ? 'approvedBrief' : 'lastCorrection', draft.trim().slice(0, 6000));
  setPromptStage(task, 'approved', { revision: job.revision });
  // a parked read-only-lane job carries worktree=null — in direct mode the task
  // never got its worktree assigned on the normal path. Set it now so delivery
  // verification (task.worktree!) doesn't see null.
  const repo = getRepo(r.repoId);
  if (isDirect(r) && !task.worktree && repo) {
    const branch = currentBranch(repo.path) ?? '(detached)';
    run('UPDATE tasks SET worktree = ?, branch = ? WHERE id = ?', repo.path, branch, task.id);
    task = { ...task, worktree: repo.path, branch };
  }
  if (task.status === 'waiting-input') setTaskStatus(task.id, 'assigned', 'engine', { agent: target.agent.name });
  const wi = createWorkItemRecord(r.id, task, job.kind, target, prompt, job.packHash);
  run('UPDATE prompt_versions SET template_id = ?, version = ? WHERE id = ?', `${job.kind}/approved`, job.revision + 1, wi.promptVersionId);
  void executeWorkItem(wi, target, prompt.text, job.worktree ?? (isDirect(r) ? repo?.path ?? null : task.worktree ?? null));
}

function escalatePrompt(job: PromptJob, why: string): void {
  const task = getTask(job.taskId);
  if (!task) return;
  escalatedPrompts.set(task.id, job);
  setPromptStage(task, 'escalated', { reason: why });
  setTaskStatus(task.id, 'waiting-input', 'engine', { reason: why });
  requestApproval({
    action: 'prompt.escalate', taskId: task.id, runId: job.runId, requestedBy: 'pm',
    payload: { summary: `Prompt for "${task.title}" needs your decision — ${why}`, prompt: job.draft ?? job.basePrompt, notes: job.notes ?? null,
      hint: 'Approve to send this prompt as-is. Reject with a reason to have the Prompt Creator redraft it using your reason.' },
  });
}

// ---------------------------------------------------------------------------
// Task commits (direct mode; workspace setting commitMode):
//   'approve' (default) — the proposed message and files wait in Needs you;
//   'auto'    — committed right away when checks and review passed and the
//               commit contains only the task's own files;
//   'manual'  — never committed by the office.
// The message comes from the developer's notes / the PM's acceptance (no
// extra model call) and is checked against the actual diff and evidence.
// ---------------------------------------------------------------------------

function taskEvidence(task: Task): { checks: { name: string; status: string }[]; qa: 'pass' | 'fail' | null } {
  const checks = q(`SELECT c.name, cr.status FROM check_runs cr JOIN checks c ON c.id = cr.check_id
                    WHERE cr.task_id = ? AND cr.rowid IN (SELECT MAX(rowid) FROM check_runs WHERE task_id = ? GROUP BY check_id)`, task.id, task.id)
    .map((x) => ({ name: x.name as string, status: x.status as string }));
  const qa = q1(`SELECT payload FROM events WHERE type IN ('qa.decided','review.decided') AND entity_id = ? ORDER BY seq DESC LIMIT 1`, task.id);
  const d = parseJson<{ decision?: string }>(qa?.payload as string, {}).decision;
  return { checks, qa: d === 'pass' || d === 'approve' ? 'pass' : d === 'fail' || d === 'request-changes' ? 'fail' : null };
}

function proposeTaskCommit(task: Task): void {
  const r = getRun(task.runId)!;
  const repo = getRepo(r.repoId)!;
  const cp = taskCheckpoint(task);
  const mode = (getWorkspace(r.workspaceId)?.settings?.commitMode as string) ?? 'approve';
  if (!cp?.afterTree || mode === 'manual') return;
  const plan = planTaskCommit(repo.path, firstTree(task) ?? cp.beforeTree, cp.afterTree);
  if (!plan.paths.length) return;
  const notes = changeNotes(task);
  const fromNotes = notes.match(/^\s*Commit:\s*(.+)$/m)?.[1];
  const proposed = (task.meta?.commitProposal as { title?: string; body?: string } | undefined) ?? (fromNotes ? { title: fromNotes } : null);
  const evidence = taskEvidence(task);
  const msg = buildCommitMessage({ repo: repo.path, taskType: task.type, taskTitle: task.title, files: plan.files, proposed, evidence });
  setTaskMeta(task.id, 'commitProposal', { title: msg.title, body: msg.body, message: msg.message, paths: plan.paths });
  const verified = evidence.checks.every((c) => c.status === 'pass') && evidence.qa !== 'fail';
  if (mode === 'auto' && plan.ok && verified) { commitTask(task.id, msg.message, false); return; }
  const risk = classifyChangeRisk({
    files: plan.files, declaredPaths: task.affectedPaths ?? [],
    checksRan: evidence.checks.length > 0, userFiles: plan.mixed, postTaskEdits: plan.changedSince,
  });
  requestApproval({
    action: 'commit.task', taskId: task.id, runId: r.id, requestedBy: 'engine',
    payload: {
      summary: `Commit "${msg.title}" (${plan.paths.length} file${plan.paths.length === 1 ? '' : 's'})`,
      message: msg.message, files: plan.files, mixed: plan.mixed, changedSince: plan.changedSince, risk,
      why: plan.reason ?? (!verified ? 'checks or review did not pass — it would be committed unverified' : 'approval before commit is on (Routing → Workflow)'),
    },
  });
}

// The tree before the task first touched the repo (a resumed task has several general checkpoints).
function firstTree(task: Task): string | null {
  const ids = (task.meta?.checkpointIds as string[]) ?? [];
  for (const id of ids) { const c = getCheckpoint(id); if (c?.kind === 'general') return c.beforeTree; }
  return null;
}

/** Commit a finished task's files with the given (or proposed) message. */
export function commitTask(taskId: string, message: string, approvedByOwner: boolean): { ok: boolean; sha?: string; error?: string } {
  const task = getTask(taskId);
  if (!task) return { ok: false, error: 'task not found' };
  const r = getRun(task.runId)!;
  const repo = getRepo(r.repoId)!;
  const cp = taskCheckpoint(task);
  if (!cp?.afterTree) return { ok: false, error: 'the task has no finished checkpoint' };
  const plan = planTaskCommit(repo.path, firstTree(task) ?? cp.beforeTree, cp.afterTree);
  // owner approval covers files the user had changed too (they saw the list); later edits never
  if (plan.changedSince.length) {
    const error = `${plan.changedSince.join(', ')} changed after the task finished — commit it yourself or undo those edits`;
    emit('commit.failed', 'engine', { taskId, error }, r.id, taskId);
    return { ok: false, error };
  }
  if (!plan.paths.length) return { ok: false, error: 'the task changed no files — nothing to commit' };
  if (!plan.ok && !approvedByOwner) return { ok: false, error: plan.reason };
  const text = message.trim() || ((task.meta?.commitProposal as { message?: string })?.message ?? task.title);
  const res = commitPaths(repo.path, plan.paths, text);
  if (!res.ok) { emit('commit.failed', 'engine', { taskId, error: res.error }, r.id, taskId); return res; }
  setCheckpointCommit(cp.id, res.sha!);
  setTaskMeta(taskId, 'committedSha', res.sha);
  const agents = q(`SELECT DISTINCT agent_id FROM repo_checkpoints WHERE task_id = ? AND kind = 'agent' AND agent_id IS NOT NULL`, taskId).map((x) => getAgent(x.agent_id as string)?.name).filter(Boolean);
  emit('commit.created', 'engine', { taskId, sha: res.sha, title: text.split('\n')[0], files: plan.paths, agents, checkpointId: cp.id, branch: currentBranch(repo.path) }, r.id, taskId);
  return res;
}

// ---------------------------------------------------------------------------
// Assign sweep (phase 2–4)
// ---------------------------------------------------------------------------

export function assignSweep(runId: string): void {
  const r = getRun(runId);
  if (!r || r.status !== 'running') return;
  const repo = getRepo(r.repoId);
  if (!repo) return;
  const tasks = runTasks(runId);
  const direct = isDirect(r);
  // direct mode: one task holds the working tree at a time (any run), so each
  // change is attributed to exactly one task and agent
  const holding = direct ? q(`SELECT * FROM tasks WHERE status NOT IN ('done','failed','cancelled','blocked') AND json_extract(meta, '$.generalCheckpointId') IS NOT NULL`).map(rowToTask).filter((t) => holdsRepo(t) && t.id) : [];
  const inFlight = direct ? holding : tasks.filter((t) => ACTIVE_TASK.includes(t.status));
  const lockedPaths = new Set(inFlight.flatMap((t) => t.affectedPaths));

  // Resume tasks whose approved prompt parked while the tree was busy
  // (direct-mode read-only lane). Runs before picking new work.
  if (direct) {
    for (const t of tasks.filter((x) => x.status === 'assigned' && x.meta?.promptReady && x.meta?.parkedPrompt)) {
      if (inFlight.some((h) => h.id !== t.id)) continue; // tree still held
      const job = t.meta.parkedPrompt as PromptJob;
      run(`UPDATE tasks SET meta = json_remove(meta, '$.parkedPrompt', '$.promptReady', '$.treeWait') WHERE id = ?`, t.id);
      openTaskCheckpoint(r, repo, getTask(t.id)!);
      dispatchApprovedPrompt(job);
    }
  }

  // Custom workflow: parked writers resume when the tree frees; ready tasks
  // enter the graph instead of the fixed implement step.
  if (graphFor(r)) {
    for (const t of tasks.filter((x) => x.status === 'assigned' && (x.meta?.wf as WfState | undefined)?.held)) {
      if (inFlight.some((h) => h.id !== t.id)) continue;
      graphTaskEntry(r, t);
    }
    for (const t of tasks.filter((x) => x.status === 'ready').sort((a, b) => a.priority - b.priority)) {
      if (!t.dependsOn.every((d) => tasks.find((x) => x.id === d)?.status === 'done')) continue;
      graphTaskEntry(r, t);
    }
    return;
  }

  const readOnlyCap = Math.max(0, Number(r.limits.maxReadOnly ?? 2));
  // lane occupancy, fresh from the DB (the resume loop above already cleared
  // the flags of tasks it dispatched)
  let readOnlyLane = direct
    ? (q1(`SELECT COUNT(*) c FROM tasks WHERE run_id = ? AND status NOT IN ('done','failed','cancelled') AND (json_extract(meta,'$.treeWait') IS NOT NULL OR json_extract(meta,'$.promptReady') IS NOT NULL)`, runId)?.c as number)
    : 0;

  for (const task of tasks.filter((t) => t.status === 'ready').sort((a, b) => a.priority - b.priority)) {
    const held = direct && inFlight.some((t) => t.id !== task.id);
    if (held) {
      // direct mode with a writer on the tree: a ready task may still do its
      // read-only stages (prompt draft/review on a desk) when its paths don't
      // overlap, up to maxReadOnly. The write stage parks until the tree frees.
      if (task.affectedPaths.some((p) => lockedPaths.has(p))) continue;
      if (readOnlyLane >= readOnlyCap || !pmWritesPrompt(r, 'implement')) continue;
      const laneCand = pickAgent(r.workspaceId, roleNameFor('implement', task), task, 'implement', task.difficulty);
      if (!laneCand) continue;
      readOnlyLane++;
      run('UPDATE tasks SET owner_agent_id = ? WHERE id = ?', laneCand.agent.id, task.id);
      setTaskMeta(task.id, 'treeWait', true);
      setTaskStatus(task.id, 'assigned', 'engine', { agent: laneCand.agent.name, lane: 'read-only' });
      emit('task.lane', 'engine', { taskId: task.id, agent: laneCand.agent.name, reason: 'prompt prepared while the repository is in use' }, runId, task.id);
      const fresh = getTask(task.id)!;
      const pack = packFor(repo, fresh, laneCand, 16000);
      const prompt = renderPrompt({
        kind: 'implement', agent: laneCand.agent, role: laneCand.role, task: fresh, goal: r.goal, pack, adapterId: laneCand.provider?.adapterId,
        extra: { handoff: envelopeText(handoffEnvelope(fresh, roleNameFor('implement', fresh))),
          requirementsChanged: takeRequirementNote(fresh), inbox: '', handoffPath: handoffPath(fresh, true),
          kbNotes: lessonNotes(r, fresh) },
      });
      dispatchWork(r, fresh, 'implement', laneCand, prompt, pack.hash, null, true);
      continue;
    }
    if (inFlight.length >= (direct ? 1 : r.limits.maxParallel) && !inFlight.some((t) => t.id === task.id)) break;
    const depsDone = task.dependsOn.every((d) => tasks.find((t) => t.id === d)?.status === 'done');
    if (!depsDone) continue;
    if (task.affectedPaths.some((p) => lockedPaths.has(p))) continue; // path lock

    const roleName = roleNameFor('implement', task);
    const candidate = pickAgent(r.workspaceId, roleName, task, 'implement', task.difficulty);
    if (!candidate) {
      const anyBlocked = candidatesForRole(r.workspaceId, roleName).some((c) => c.blocked?.includes('quota') || c.blocked?.includes('circuit'));
      setTaskStatus(task.id, anyBlocked ? 'blocked-quota' : 'ready', 'engine');
      continue;
    }
    let wt: { worktree: string; branch: string };
    try {
      if (direct) {
        wt = { worktree: repo.path, branch: currentBranch(repo.path) ?? '(detached)' };
        openTaskCheckpoint(r, repo, getTask(task.id)!);
      } else {
        wt = task.worktree ? { worktree: task.worktree, branch: task.branch! } : createWorktree(repo, task.id);
      }
    } catch (e) {
      emit('git.error', 'engine', { taskId: task.id, error: String(e) }, runId, task.id);
      continue;
    }
    run('UPDATE tasks SET worktree = ?, branch = ?, owner_agent_id = ? WHERE id = ?', wt.worktree, wt.branch, candidate.agent.id, task.id);
    setTaskStatus(task.id, 'assigned', 'engine', { agent: candidate.agent.name });
    const deps = task.dependsOn.map((d) => tasks.find((t) => t.id === d)?.title).filter(Boolean);
    pmHandoff(r, task, candidate, `You own "${task.title}" as ${candidate.role.name}.${deps.length ? ` Builds on: ${deps.join(', ')}.` : ''} Validate it against every acceptance criterion and write your change notes before you hand off; it then goes through the checks to review, and back to me for acceptance.`);
    const fresh = getTask(task.id)!;
    const pack = packFor(repo, fresh, candidate, 16000);
    const reviewed = pmWritesPrompt(r, 'implement');
    const prompt = renderPrompt({
      kind: 'implement', agent: candidate.agent, role: candidate.role, task: fresh, goal: r.goal, pack, adapterId: candidate.provider?.adapterId,
      // the target's inbox is attached at approval time when the prompt is reviewed
      extra: { handoff: envelopeText(handoffEnvelope(fresh, roleNameFor('implement', fresh))),
        requirementsChanged: takeRequirementNote(fresh), inbox: reviewed ? '' : inboxText(candidate, runId, fresh.id), handoffPath: handoffPath(fresh, direct),
        kbNotes: lessonNotes(r, fresh) },
    });
    inFlight.push(fresh);
    dispatchWork(r, fresh, 'implement', candidate, prompt, pack.hash, wt.worktree, reviewed);
  }
}

// ---------------------------------------------------------------------------
// DoD evaluation + progress + stop rules (phase 8)
// ---------------------------------------------------------------------------

function dodItems(run: Run): DodItem[] {
  const r = q1('SELECT items FROM dod WHERE id = ?', run.dodId);
  return parseJson<DodItem[]>(r?.items as string, []);
}

function resolveCheck(repo: Repo, ref: string): Check | null {
  const byName = checkByName(repo.id, ref);
  if (byName) return byName;
  const m = ref.match(/^(\w[\w-]*):(.+)$/);
  if (m) {
    const [, kind, rest] = m;
    if (kind === 'errors' || kind === 'review') {
      return { id: `syn:${ref}`, repoId: repo.id, name: ref, kind: 'custom', command: '', parser: '', passRule: ref, timeoutSec: 30, affectedPaths: [], protected: 0 };
    }
    if (kind === 'doc') {
      const pr = rest.startsWith('file-exists') || rest.startsWith('sections') ? rest : `file-exists(${rest})`;
      return { id: `syn:${ref}`, repoId: repo.id, name: ref, kind: 'doc', command: '', parser: '', passRule: pr, timeoutSec: 30, affectedPaths: [], protected: 0 };
    }
    if (kind === 'file') {
      // plans sometimes append prose ("file:foo.txt contains 'x'") — only the
      // first whitespace-separated token is the path
      const p = rest.split(/\s/)[0];
      return { id: `syn:${ref}`, repoId: repo.id, name: ref, kind: 'custom', command: '', parser: '', passRule: `file-exists(${p})`, timeoutSec: 30, affectedPaths: [], protected: 0 };
    }
    if (kind === 'git' && rest === 'diff') {
      return { id: `syn:${ref}`, repoId: repo.id, name: ref, kind: 'custom', command: `git diff --stat ${repo.defaultBranch}...HEAD`, parser: '', passRule: 'output-nonempty', timeoutSec: 60, affectedPaths: [], protected: 0 };
    }
    const named = checkByName(repo.id, ref) ?? q('SELECT * FROM checks WHERE repo_id = ? AND kind = ?', repo.id, kind).map((x) => rowToCheckFromRow(x))[0];
    if (named) return named;
    if (kind === 'build' && repo.buildCmd) return synth(repo, ref, 'build', repo.buildCmd);
    if ((kind === 'unit' || kind === 'integration' || kind === 'e2e') && repo.testCmd) return synth(repo, ref, kind as Check['kind'], repo.testCmd);
    return null; // unresolvable "kind:whatever" ref
  }
  const cov = ref.match(/^coverage>=(.+)$/);
  if (cov) {
    const named = q('SELECT * FROM checks WHERE repo_id = ? AND kind = ?', repo.id, 'coverage').map((x) => rowToCheckFromRow(x))[0];
    if (named) return { ...named, passRule: ref };
    return synth(repo, ref, 'coverage', '', ref);
  }
  return checkByName(repo.id, ref) ?? null; // null when unresolvable — fails closed
}

function rowToCheckFromRow(r: Record<string, unknown>): Check {
  return {
    id: r.id as string, repoId: r.repo_id as string, name: r.name as string, kind: r.kind as Check['kind'],
    command: r.command as string, parser: r.parser as string, passRule: r.pass_rule as string,
    timeoutSec: r.timeout_sec as number, affectedPaths: parseJson(r.affected_paths as string, []), protected: r.protected as number,
  };
}

function synth(repo: Repo, name: string, kind: Check['kind'], command: string, passRule = 'exit0'): Check {
  return { id: `syn:${name}`, repoId: repo.id, name, kind, command, parser: 'exit0', passRule: name.startsWith('coverage') ? name : passRule, timeoutSec: 300, affectedPaths: [], protected: 0 };
}

// DoD command results per repository state (tree or commit): a check is not
// re-run while nothing changed. Bounded; oldest entries drop first.
const dodCache = new Map<string, { status: string; summary: string }>();
const dodCacheSet = dodCache.set.bind(dodCache);
dodCache.set = (k, v) => { if (dodCache.size > 500) dodCache.delete(dodCache.keys().next().value!); return dodCacheSet(k, v); };

// Files this run changed: from its first task checkpoint to the working tree now.
async function runChangedFiles(r: Run, repo: Repo): Promise<string[]> {
  const first = q1(`SELECT before_tree FROM repo_checkpoints WHERE run_id = ? AND kind = 'general' ORDER BY created_at, rowid LIMIT 1`, r.id);
  if (!first) return [];
  try { return changedFilesBetween(repo.path, first.before_tree as string, await snapshotTreeAsync(repo.path)).map((f) => f.path).filter((p) => !p.startsWith('.office/')); }
  catch { return []; }
}

export async function evaluateDodOnIntegration(runId: string): Promise<{ pass: number; total: number; items: DodItem[] }> {
  const r = getRun(runId)!;
  const repo = getRepo(r.repoId)!;
  const direct = isDirect(r);
  const wt = direct ? repo.path : ensureIntegration(repo);
  const ref = direct ? (currentBranch(repo.path) ?? 'HEAD') : repo.integrationBranch;
  const items = dodItems(r);
  // the repository state these results describe: unchanged state → reuse
  const state = direct ? await snapshotTreeAsync(repo.path) : (headSha(wt) ?? '');
  let pass = 0, required = 0;
  for (const item of items) {
    let ok = item.checks.length > 0;
    const evidence: { check: string; status: string; summary: string; cached?: boolean }[] = [];
    for (const checkRef of item.checks) {
      // in direct mode "the branch has changes" means: the work changed the
      // repository since the run started (comparing main...HEAD on main is
      // always empty — that check could never pass and re-planning looped)
      if (direct && checkRef === 'git:diff') {
        const changed = await runChangedFiles(r, repo);
        evidence.push({ check: checkRef, status: changed.length ? 'pass' : 'fail', summary: changed.length ? `${changed.length} file(s) changed by this run` : 'no changes made by this run' });
        if (!changed.length) ok = false;
        continue;
      }
      const check = resolveCheck(repo, checkRef === 'errors:open' ? 'errors:open(severity>=low)==0' : checkRef);
      if (!check) { ok = false; evidence.push({ check: checkRef, status: 'fail', summary: 'unknown check — edit this DoD item' }); continue; }
      const key = `${repo.id}|${checkRef}|${state}`;
      const hit = check.command ? dodCache.get(key) : undefined;
      if (hit) { evidence.push({ check: checkRef, ...hit, cached: true }); if (hit.status !== 'pass') ok = false; continue; }
      const cr = await runCheck({ check, worktree: wt, runId, ref, commitSha: headSha(wt) });
      const res = { status: cr.status, summary: String(cr.summary ?? '').slice(0, 300) };
      if (check.command) dodCache.set(key, res);
      evidence.push({ check: checkRef, ...res });
      if (cr.status !== 'pass') ok = false;
    }
    item.status = ok && item.checks.length ? 'pass' : 'fail';
    (item as DodItem & { evidence?: unknown }).evidence = evidence;
    if (!item.optional) { required++; if (ok) pass++; }
  }
  const score = required ? pass / required : 0;
  run('UPDATE dod SET items = ? WHERE id = ?', JSON.stringify(items), r.dodId);
  run('UPDATE runs SET progress_score = ? WHERE id = ?', score, runId);
  emit('dod.evaluated', 'engine', { pass, required, score }, runId, r.dodId);
  return { pass, total: required, items };
}

export async function maybeAdvanceRun(runId: string): Promise<void> {
  const r0 = getRun(runId);
  if (r0?.status === 'running') retryPendingAdoption(runId);
  const r = getRun(runId);
  if (!r || r.status !== 'running') return;

  // stop rules first — they always beat the loop (spec 5.5)
  const stop = evaluateStopRules(r);
  if (stop) {
    if (stop === 'pause') { pauseRun(runId); return; }
    if (stop.startsWith('CEILING:')) {
      // a ceiling pauses (never kills) and tells the owner once
      notifyOnce(runId, 'run.ceiling', null, stop.slice(8), { hint: 'Adjust the limit under the run controls, then resume.' });
      emit('run.ceiling', 'engine', { reason: stop.slice(8) }, runId, runId);
      pauseRun(runId);
      return;
    }
    stopRun(runId, stop);
    return;
  }

  const items = dodItems(r);
  const required = items.filter((i) => !i.optional);
  // work the owner added mid-run is outside the DoD, but the run is not finished while it is still open
  const ownerWorkOpen = runTasks(runId).some((t) => t.meta?.createdBy === 'owner' && !['done', 'cancelled', 'failed', 'blocked', 'held'].includes(t.status));
  if (!ownerWorkOpen && required.length && required.every((i) => i.status === 'pass')) {
    setRunStatus(runId, 'verifying');
    const res = await evaluateDodOnIntegration(runId);
    const freshRequired = res.items.filter((i) => !i.optional);
    if (freshRequired.every((i) => i.status === 'pass')) {
      closeCycle(runId, res);
      setRunStatus(runId, 'done', { stopReason: 'DONE' });
      emit('run.done', 'engine', { score: 1 }, runId, runId);
      checkpoint(runId);
    } else {
      setRunStatus(runId, 'running', { note: 'DoD check failed on integration HEAD' });
      void maybeAdvanceRun(runId);
    }
    return;
  }

  const tasks = runTasks(runId);
  const anyInFlightWi = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND status IN ('queued','running','waiting')`, runId)?.c as number;

  // tasks approved but not yet merged (waiting on approvals) — nudge merge
  for (const t of tasks.filter((t) => t.status === 'approved')) void proceedMerge(t.id);

  const unfinished = tasks.filter((t) => !['done', 'cancelled', 'failed', 'blocked', 'held'].includes(t.status));
  const onHold = tasks.filter((t) => t.status === 'held');
  if (unfinished.length === 0 && anyInFlightWi === 0 && onHold.length) {
    // everything left is parked by the owner: finish if the DoD already passes, otherwise wait quietly — a new planning
    // cycle would re-plan the very work the owner chose to hold
    const res = await evaluateDodOnIntegration(runId);
    const req = res.items.filter((i) => !i.optional);
    if (req.length && req.every((i) => i.status === 'pass')) { void maybeAdvanceRun(runId); return; }
    notifyOnce(runId, 'run.onhold', null, `All remaining work is on hold (${onHold.length} task${onHold.length === 1 ? '' : 's'}). Move one to Ready to continue, or delete the ones you no longer need.`, { hint: 'Tasks board: drag a held task to Ready.' });
    return;
  }
  if (unfinished.length === 0 && anyInFlightWi === 0) {
    if ((r.limits as { oneShot?: boolean }).oneShot) {
      // one-shot: evaluate once, then finish — never begins another cycle.
      const res = await evaluateDodOnIntegration(runId);
      const req = res.items.filter((i) => !i.optional);
      if (req.length && req.every((i) => i.status === 'pass')) { void maybeAdvanceRun(runId); return; }
      closeCycle(runId, res);
      const failing = req.filter((i) => i.status !== 'pass').map((i) => i.id);
      setRunStatus(runId, 'stopped', { stopReason: 'ONE_SHOT_INCOMPLETE', failingDodItems: failing });
      emit('run.stopped', 'engine', { reason: 'one-shot pass did not satisfy all required DoD items', failing }, runId, runId);
      checkpoint(runId);
      return;
    }
    if (r.currentCycle >= r.limits.maxCycles) { stopRun(runId, 'MAX_CYCLES'); return; }
    if (tasks.length === 0 || tasks.every((t) => ['done', 'cancelled'].includes(t.status))) {
      const res = await evaluateDodOnIntegration(runId);
      const req = res.items.filter((i) => !i.optional);
      if (req.length && req.every((i) => i.status === 'pass')) { void maybeAdvanceRun(runId); return; }
      // Every task is finished but the same DoD items still fail: another
      // plan would re-create the same tasks (seen in practice: three cycles of
      // near-identical work). After one re-plan, ask the owner with the evidence.
      const items = res.items.map((i) => (i.optional || i.status === 'pass' ? { ...i, cycleFails: 0 } : { ...i, cycleFails: ((i as { cycleFails?: number }).cycleFails ?? 0) + 1 }));
      run('UPDATE dod SET items = ? WHERE id = ?', JSON.stringify(items), r.dodId);
      const stuck = items.filter((i) => !i.optional && i.status !== 'pass' && (i.cycleFails ?? 0) >= 2);
      if (tasks.length && stuck.length) {
        requestApproval({
          action: 'dod.unmet', runId, requestedBy: 'engine',
          payload: {
            summary: `All tasks are done, but ${stuck.length} Definition-of-Done item(s) still fail after a re-plan`,
            items: stuck.map((i) => ({ id: i.id, text: i.text, evidence: (i as { evidence?: unknown }).evidence ?? null })),
            hint: 'Approve to let the PM plan again with this evidence; reject to stop the run. If a check itself is wrong, edit the Definition of Done first.',
          },
        });
        emit('run.blocked', 'engine', { reason: 'DoD items still failing after all tasks finished', items: stuck.map((i) => i.id) }, runId, runId);
        pauseRun(runId);
        return;
      }
    }
    beginCycle(runId);
    return;
  }
  assignSweep(runId);
}

// Ceilings pause the run (never kill) and notify once with the exact reason;
// 'pause' alone stays silent — those rules emit their own events already.
function evaluateStopRules(r: Run): string | 'pause' | null {
  if (r.spentUsd >= r.budget.runUsd) return `CEILING:Run budget reached — spent $${r.spentUsd.toFixed(2)} of the $${r.budget.runUsd} cap. Raise the budget or stop the run.`;
  if (r.spentUsd >= r.budget.runUsd * (r.budget.warnPct / 100)) {
    emit('budget.warn', 'engine', { spentUsd: r.spentUsd, budget: r.budget.runUsd }, r.id);
  }
  if (r.startedAt && Date.now() - Date.parse(r.startedAt) > r.limits.maxWallclockMin * 60000)
    return `CEILING:Run time limit reached — ${r.limits.maxWallclockMin} min wallclock. Raise the limit (or resume to continue anyway).`;
  const maxTaskMin = Number((r.limits as { maxTaskMinutes?: number }).maxTaskMinutes) || 0;
  if (maxTaskMin > 0) {
    const over = q1(`SELECT w.task_id FROM work_items w WHERE w.run_id = ? AND w.status = 'running' AND w.started_at < ? LIMIT 1`,
      r.id, new Date(Date.now() - maxTaskMin * 60000).toISOString());
    if (over) return `CEILING:A task exceeded the per-task time limit (${maxTaskMin} min). Raise it, or resume to keep waiting.`;
  }
  // NO_PROGRESS / REGRESSION from cycle history
  const cycles = q('SELECT progress_score FROM cycles WHERE run_id = ? AND ended_at IS NOT NULL ORDER BY n DESC LIMIT 4', r.id)
    .map((c) => c.progress_score as number);
  if (cycles.length >= r.limits.noProgressCycles) {
    const last = cycles.slice(0, r.limits.noProgressCycles);
    if (last.every((s) => s === last[0])) return 'pause'; // NO_PROGRESS → pause
  }
  if (cycles.length >= 2 && cycles[0] < cycles[1] && cycles[1] <= cycles[2]) {
    emit('run.regression', 'engine', { history: cycles }, r.id);
    return 'pause';
  }
  const escalated = q1(`SELECT COUNT(*) c FROM error_reports WHERE run_id = ? AND status = 'escalated'`, r.id)?.c as number;
  const active = q1(`SELECT COUNT(*) c FROM tasks WHERE run_id = ? AND status NOT IN ('done','cancelled','failed','blocked','held')`, r.id)?.c as number;
  if (escalated > 0 && active === 0) return 'pause';
  return null;
}

export function beginCycle(runId: string): void {
  const r = getRun(runId);
  if (!r || r.status !== 'running') return;
  if (r.currentCycle > 0) closeCycle(runId);
  const n = r.currentCycle + 1;
  run('UPDATE runs SET current_cycle = ? WHERE id = ?', n, runId);
  const cid = ulid();
  run(`INSERT INTO cycles (id, run_id, n, phase, started_at, progress_score, spend_usd) VALUES (?,?,?,?,?,?,?)`,
    cid, runId, n, 'plan', now(), r.progressScore, r.spentUsd);
  emit('cycle.started', 'engine', { n }, runId, cid);
  checkpoint(runId);
  void dispatchPlan(runId, false);
}

function closeCycle(runId: string, res?: { pass: number; total: number }): void {
  const r = getRun(runId)!;
  const c = q1('SELECT * FROM cycles WHERE run_id = ? AND n = ?', runId, r.currentCycle);
  if (c && !c.ended_at) {
    const summary = `Cycle ${r.currentCycle}: ${res ? `${res.pass}/${res.total} DoD checks passing` : `progress ${Math.round(r.progressScore * 100)}%`}, spend $${r.spentUsd.toFixed(2)}`;
    run(`UPDATE cycles SET ended_at = ?, progress_score = ?, spend_usd = ?, summary = ? WHERE id = ?`,
      now(), r.progressScore, r.spentUsd, summary, c.id);
    emit('cycle.ended', 'engine', { n: r.currentCycle, summary }, runId, c.id as string);
  }
}

export function checkpoint(runId: string): void {
  const snapshot = {
    run: q1('SELECT * FROM runs WHERE id = ?', runId),
    tasks: q('SELECT * FROM tasks WHERE run_id = ?', runId),
    workItems: q('SELECT * FROM work_items WHERE run_id = ?', runId),
    dod: q1('SELECT * FROM dod WHERE run_id = ?', runId),
  };
  const seq = (q1('SELECT MAX(seq) s FROM events')?.s as number) ?? 0;
  const id = ulid();
  run('INSERT INTO checkpoints (id, run_id, seq, snapshot, created_at) VALUES (?,?,?,?,?)',
    id, runId, seq, JSON.stringify(snapshot), now());
  run('UPDATE runs SET checkpoint_id = ? WHERE id = ?', id, runId);
}

// ---------------------------------------------------------------------------
// Owner edits / approvals / messages
// ---------------------------------------------------------------------------

export function ownerEditTask(taskId: string, edits: Partial<Task>, mode: 'finish' | 'abort' | 'handoff' = 'finish'): void {
  const task = getTask(taskId);
  if (!task) return;
  emit('owner.edit', 'owner', { taskId, edits, mode }, task.runId, taskId);
  const apply = () => {
    if (edits.title != null) run('UPDATE tasks SET title = ? WHERE id = ?', edits.title, taskId);
    if (edits.description != null) run('UPDATE tasks SET description = ? WHERE id = ?', edits.description, taskId);
    if (edits.priority != null) run('UPDATE tasks SET priority = ? WHERE id = ?', edits.priority, taskId);
    if (edits.acceptanceCriteria != null) run('UPDATE tasks SET acceptance_criteria = ? WHERE id = ?', JSON.stringify(edits.acceptanceCriteria), taskId);
    if (edits.status === 'cancelled') setTaskStatus(taskId, 'cancelled', 'owner');
  };
  if (mode === 'abort' || edits.status === 'cancelled') {
    for (const wi of q(`SELECT id FROM work_items WHERE task_id = ? AND status IN ('queued','running','waiting')`, taskId)) {
      run(`UPDATE work_items SET status = 'cancelled', finished_at = ? WHERE id = ?`, now(), wi.id);
    }
    if (task.branch && !isDirect(getRun(task.runId))) {
      const repo = getRepo(getRun(task.runId)!.repoId)!;
      const abandoned = `abandoned/${task.id}-${Date.now()}`;
      try { renameBranch(repo.path, task.branch, abandoned); } catch { /* best-effort */ }
      if (edits.status === 'cancelled') removeWorktree(repo, task.id);
    }
    apply();
    if (edits.status !== 'cancelled' && ['in-progress', 'changes-requested', 'assigned'].includes(task.status)) {
      setTaskStatus(taskId, 'ready', 'owner', { reason: 'aborted for edit' });
    }
  } else {
    apply(); // finish-then-apply: fields update now; in-flight work continues
    if (mode === 'handoff' && edits.ownerAgentId) {
      const wi = q1(`SELECT id FROM work_items WHERE task_id = ? AND status IN ('queued','running') ORDER BY started_at DESC LIMIT 1`, taskId);
      if (wi) run(`UPDATE work_items SET status = 'cancelled', finished_at = ? WHERE id = ?`, now(), wi.id);
      run('UPDATE tasks SET owner_agent_id = ?, status = ? WHERE id = ?', edits.ownerAgentId, 'ready', taskId);
      emit('task.handoff', 'owner', { taskId, to: edits.ownerAgentId }, task.runId, taskId);
    }
  }
  void maybeAdvanceRun(task.runId);
}

export interface RequirementImpact {
  added: string[]; removed: string[]; changed: string[];
  tasks: { id: string; title: string; status: string; action: 'kept' | 'updated' | 'cancelled' }[];
  uncovered: string[]; replanning: boolean;
}

// Requirement change (spec 7): work out which tasks the edit touches, keep
// verified work, update in-flight work at its next prompt, cancel work that
// only served removed requirements, and wake the PM only if new requirements
// have no task yet.
export function ownerEditDod(runId: string, items: DodItem[]): RequirementImpact | null {
  const r = getRun(runId);
  if (!r) return null;
  const before = dodItems(r);
  const old = new Map(before.map((i) => [i.id, i]));
  const added = items.filter((i) => !old.has(i.id)).map((i) => i.id);
  const removed = before.filter((i) => !items.some((n) => n.id === i.id)).map((i) => i.id);
  const changed = items.filter((i) => {
    const o = old.get(i.id);
    return o && (o.text !== i.text || JSON.stringify(o.checks) !== JSON.stringify(i.checks) || !!o.optional !== !!i.optional);
  }).map((i) => i.id);

  const touched = new Set([...removed, ...changed]);
  const impact: RequirementImpact = { added, removed, changed, tasks: [], uncovered: [], replanning: false };
  const tasks = runTasks(runId);
  for (const t of tasks.filter((t) => t.dodItemIds.some((d) => touched.has(d)))) {
    if (t.status === 'cancelled' || t.status === 'failed') continue;
    const remaining = t.dodItemIds.filter((d) => !removed.includes(d));
    if (!remaining.length && !['done', 'approved'].includes(t.status)) {
      ownerEditTask(t.id, { status: 'cancelled' }, 'abort');
      impact.tasks.push({ id: t.id, title: t.title, status: t.status, action: 'cancelled' });
    } else if (['done', 'approved'].includes(t.status)) {
      impact.tasks.push({ id: t.id, title: t.title, status: t.status, action: 'kept' });
    } else {
      const lines = items.filter((i) => t.dodItemIds.includes(i.id) && changed.includes(i.id)).map((i) => `${i.id} is now: ${i.text} (checks: ${i.checks.join(', ')})`);
      if (removed.some((d) => t.dodItemIds.includes(d))) lines.push(`No longer required: ${removed.filter((d) => t.dodItemIds.includes(d)).join(', ')}`);
      setTaskMeta(t.id, 'requirementsChanged', lines.join('\n'));
      impact.tasks.push({ id: t.id, title: t.title, status: t.status, action: 'updated' });
    }
  }
  const live = tasks.filter((t) => !['cancelled', 'failed'].includes(t.status));
  impact.uncovered = added.filter((id) => !live.some((t) => t.dodItemIds.includes(id)));

  const dod = q1('SELECT * FROM dod WHERE id = ?', r.dodId);
  const version = ((dod?.version as number) ?? 0) + 1;
  run('UPDATE dod SET items = ?, version = version + 1 WHERE id = ?', JSON.stringify(items), r.dodId);
  emit('dod.edited', 'owner', { version, items: items.length }, runId, r.dodId as string);
  emit('requirements.changed', 'owner', { version, added, removed, changed, affected: impact.tasks, uncovered: impact.uncovered }, runId, r.dodId as string);

  const planInFlight = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ? AND kind = 'plan' AND status IN ('queued','running')`, runId)?.c as number;
  if (impact.uncovered.length && r.status === 'running' && !planInFlight) {
    impact.replanning = true;
    void dispatchPlan(runId, false);
  }
  void evaluateDodOnIntegration(runId).then(() => void maybeAdvanceRun(runId));
  return impact;
}

export function ownerApproveTask(taskId: string, reason: string): void {
  const task = getTask(taskId);
  if (!task || task.status !== 'in-review') return;
  emit('review.decided', 'owner', { taskId, decision: 'approve', notes: reason }, task.runId, taskId);
  setTaskStatus(taskId, 'approved', 'owner');
  void proceedMerge(taskId);
}

export function messageAgent(agentId: string, text: string): void {
  const a = getAgent(agentId);
  emit('agent.message', 'owner', { agentId, name: a?.name, text });
  const wi = q1(`SELECT id, adapter_ref, run_id FROM work_items WHERE agent_id = ? AND status IN ('running','waiting') ORDER BY started_at DESC LIMIT 1`, agentId);
  // Always queue in the agent's inbox: backends without mid-session messaging
  // still receive the guidance at their next prompt (the next safe point).
  const runId = (wi?.run_id as string) ?? (q1(`SELECT id FROM runs WHERE status IN ('running','pausing','paused','dod-review') ORDER BY rowid DESC LIMIT 1`)?.id as string) ?? null;
  postMessage({ runId, from: 'owner', to: agentId, kind: 'note', text });
  if (wi?.adapter_ref) {
    const agent = getAgent(agentId);
    const acc = getAccount(agent?.accountId);
    if (acc) {
      const provider = q1('SELECT adapter_id FROM providers WHERE id = ?', acc.providerId);
      if (provider) {
        try { getAdapter(provider.adapter_id as string).sendMessage?.(wi.adapter_ref as string, text); }
        catch { /* adapter may not support mid-session messages */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Timers, reconciliation, event wiring
// ---------------------------------------------------------------------------

export function fireDueTimers(): void {
  const due = q(`SELECT * FROM timers WHERE fire_at <= ?`, now());
  for (const t of due) {
    run('DELETE FROM timers WHERE id = ?', t.id);
    const payload = parseJson<Record<string, unknown>>(t.payload as string, {});
    const runId = t.run_id as string | null;
    if (t.type !== 'heartbeat.missed') emit(t.type as string, 'timer', payload, runId, t.id as string);
    if (t.type === 'heartbeat.missed') {
      const wi = getWorkItem(payload.workItemId as string);
      if (wi && wi.status === 'running') {
        const lastBeat = wi.heartbeatAt ? Date.parse(wi.heartbeatAt) : 0;
        const r = wi.runId ? getRun(wi.runId) : null;
        const limitMin = r?.limits.stuckAgentMinApi ?? 10;
        if (Date.now() - lastBeat > limitMin * 60000 - 5000) {
          run(`UPDATE work_items SET status = 'interrupted', finished_at = ? WHERE id = ?`, now(), wi.id);
          emit('agent.stuck', 'engine', { workItemId: wi.id, taskId: wi.taskId, kind: wi.kind, minutes: limitMin }, wi.runId, wi.id);
          // a stuck plan (no task) is retried like any transient failure —
          // before, nothing re-dispatched it and the run waited forever
          if (!wi.taskId) { void handleWorkItemFailure(wi, `timeout: no output from the agent for ${limitMin} min`); continue; }
          if (wi.taskId) {
            const task = getTask(wi.taskId)!;
            if (task.attempts + 1 < (r?.limits.sameErrorAttempts ?? 3)) setTaskStatus(task.id, 'ready', 'engine', { reason: 'stuck agent; retrying' });
            else setTaskStatus(task.id, 'failed', 'engine', { reason: 'stuck agent, retries exhausted' });
          }
        }
      }
    }
    if (t.type === 'timer.cycleMax' && runId) {
      const r = getRun(runId);
      if (r?.status === 'running') {
        const inFlight = q1(`SELECT COUNT(*) c FROM tasks WHERE run_id = ? AND status IN ('assigned','in-progress','verifying','in-review')`, runId)?.c as number;
        if (!inFlight) beginCycle(runId);
        else scheduleTimer(runId, 10, 'timer.cycleMax', {});
      }
    }
    if (t.type === 'quota.reset' && runId) {
      for (const task of runTasks(runId, ['blocked-quota'])) setTaskStatus(task.id, 'ready', 'engine', { reason: 'quota window reset' });
      void maybeAdvanceRun(runId);
    }
    // a message edge with waitForReply waited its timeout — keep moving
    if (t.type === 'wf.reply.timeout' && runId) {
      const task = getTask(payload.taskId as string);
      const rr = task ? getRun(task.runId) : null;
      if (!task || !rr || !graphFor(rr)) continue;
      const s = wfState(task);
      if (s.awaiting?.kind !== 'reply' || s.awaiting.edgeId !== payload.edgeId) continue;
      const node = wfNode(graphFor(rr)!.graph, s.awaiting.nodeId);
      s.awaiting = undefined;
      saveWfState(task, s);
      emit('workflow.timeout', 'timer', { taskId: task.id, edgeId: payload.edgeId }, runId, task.id);
      setTaskStatus(task.id, 'assigned', 'timer', { reason: 'reply wait timed out' });
      graphAdvanceFrom(rr, getTask(task.id)!, node, s.lastOutcome ?? { status: 'success' }, null);
      void maybeAdvanceRun(runId);
    }
  }
}

export function reconcileOnBoot(): void {
  // checkpoints left open by a crash are closed with what is on disk now
  // nothing is running right after a restart — clear stale "planning"/"coding" states
  run(`UPDATE agents SET status = 'idle' WHERE status IN ('planning','coding','testing','reviewing','working','thinking')`);
  const closed = recoverInterruptedCheckpoints();
  if (closed) emit('checkpoint.recovered', 'engine', { count: closed, note: 'closed as interrupted after restart' });
  const stale = q(`SELECT id, task_id, run_id FROM work_items WHERE status IN ('queued','running')`);
  for (const wi of stale) {
    run(`UPDATE work_items SET status = 'interrupted', finished_at = ? WHERE id = ?`, now(), wi.id);
    emit('engine.reconciled', 'engine', { workItemId: wi.id, note: 'daemon restarted; work item re-queued' }, wi.run_id as string, wi.id as string);
    if (wi.task_id) setTaskStatus(wi.task_id as string, 'ready', 'engine', { reason: 'daemon restart' });
  }
  for (const r of q(`SELECT id, status FROM runs WHERE status IN ('running','pausing','verifying')`)) {
    if (r.status === 'pausing') setRunStatus(r.id as string, 'paused');
    else { setRunStatus(r.id as string, 'running', { resumed: 'after restart' }); void maybeAdvanceRun(r.id as string); }
  }
  scheduleTimer(null, 5, 'timer.checkpoint', {});
}

// ---------------------------------------------------------------------------
// Workflow-graph execution (visual-routing phase 2). When a run records a
// custom workflow version, the graph — not the hard-coded switch — decides
// which node runs next after each work item. Verification, commits, error
// reports, messages, budgets and recovery are unchanged: the graph only picks
// WHO runs next and with which config.
// ---------------------------------------------------------------------------

type WfOutcome = {
  status: 'success' | 'failure' | 'reject';
  verdict?: string;                    // approve | reject | fail
  checksPassed?: boolean;
  checkRunId?: string;                 // failing check run, for the analyse step
  checkName?: string;
  files?: string[];
  report?: string;                     // QA/accept text the next prompt may need
  output?: Record<string, unknown>;    // the agent's parsed reply (envelope fields)
};
type WfState = {
  nodes: string[];                     // node ids with work in flight
  fired: string[];                     // nodes that completed this run-through
  loops: Record<string, number>;       // traversals per bounded edge
  arrived: Record<string, string[]>;   // merge node -> arrived edge ids
  awaiting?: { kind: 'human' | 'reply' | 'guard'; nodeId: string; edgeId?: string; approvalId?: string; at: string; guard?: string };
  held?: string;                       // writer node parked while the tree is busy
  queued?: string[];                   // writer nodes waiting on a sibling writer
  deadEndNode?: string;                // node that stalled — owner approval retries it
  draft?: { text: string; approved: boolean; revision: number };
  lastOutcome?: WfOutcome;
  steps?: number;                      // agent dispatches this task has taken (guardrail counter)
  nodeAttempts?: Record<string, number>; // per-node dispatch count — re-entry is a retry of that step
  guardOk?: string[];                  // guardrails the owner let pass for this task
};

const WF_LOOP_KINDS = ['on-failure', 'on-reject'];
const WF_WRITER_KINDS = new Set<WorkItemKind>(['implement', 'fix', 'doc', 'test', 'custom']);

const wfGraphCache = new Map<string, { versionId: string; graph: WfGraph } | null>();
export function graphFor(r: Run | undefined | null): { versionId: string; graph: WfGraph } | null {
  if (!r?.workflowVersionId) return null;
  if (!wfGraphCache.has(r.id)) {
    const v = getWorkflowVersion(r.workflowVersionId);
    wfGraphCache.set(r.id, v ? { versionId: v.version.id, graph: v.graph } : null);
  }
  return wfGraphCache.get(r.id) ?? null;
}

const wfNode = (g: WfGraph, id: string | null | undefined): WfNode | null => (id ? g.nodes.find((n) => n.id === id) ?? null : null);
const wfFlowOut = (g: WfGraph, id: string): WfEdge[] => g.edges.filter((e) => e.from === id && e.kind !== 'message');
const wfMsgOut = (g: WfGraph, id: string): WfEdge[] => g.edges.filter((e) => e.from === id && e.kind === 'message');

function wfState(task: Task): WfState {
  const s = task.meta?.wf as WfState | undefined;
  return s ?? { nodes: [], fired: [], loops: {}, arrived: {} };
}
function saveWfState(task: Task, s: WfState): void { setTaskMeta(task.id, 'wf', s); }

// Condition fields resolve against the step outcome — deterministic, no model.
export function wfFieldValue(field: string, ctx: { outcome: WfOutcome; task: Task }): unknown {
  const { outcome, task } = ctx;
  switch (field) {
    case 'step.status': return outcome.status;
    case 'step.verdict': return outcome.verdict;
    case 'checks': return outcome.checksPassed === true ? 'pass' : outcome.checksPassed === false ? 'fail' : 'none';
    case 'files': return outcome.files ?? [];
    case 'attempts': return task.attempts;
    case 'task.type': return task.type;
    case 'task.difficulty': return task.difficulty;
    case 'task.paths': return task.affectedPaths;
    default:
      if (field.startsWith('output.')) return outcome.output?.[field.slice(7)];
      if (field.startsWith('envelope.')) return outcome.output?.[field.slice(9)];
      return undefined;
  }
}

export function wfEvalCondition(c: WfCondition | undefined, ctx: { outcome: WfOutcome; task: Task }): boolean {
  if (!c) return true;
  if (c.and?.length) return c.and.every((x) => wfEvalCondition(x, ctx));
  if (c.or?.length) return c.or.some((x) => wfEvalCondition(x, ctx));
  if (c.not) return !wfEvalCondition(c.not, ctx);
  const v = wfFieldValue(c.field ?? '', ctx);
  switch (c.op ?? 'truthy') {
    case 'eq': return v === c.value;
    case 'ne': return v !== c.value;
    case 'lt': return Number(v) < Number(c.value);
    case 'le': return Number(v) <= Number(c.value);
    case 'gt': return Number(v) > Number(c.value);
    case 'ge': return Number(v) >= Number(c.value);
    case 'contains': return Array.isArray(v) ? v.includes(c.value) : String(v ?? '').includes(String(c.value ?? ''));
    case 'matches': return Array.isArray(v) ? v.some((f) => anyGlobMatch(String(f), [String(c.value)])) : anyGlobMatch(String(v ?? ''), [String(c.value)]);
    case 'falsy': return !v;
    default: return !!v;
  }
}

// 'next' is the normal (success) path; on-* edges fire on their outcome; an
// edge's own condition must also hold. Every matching edge fires — that is
// the fan-out. The 'else' edge runs only when nothing else matched.
function wfMatchingEdges(g: WfGraph, fromId: string, ctx: { outcome: WfOutcome; task: Task }): { take: WfEdge[]; elseEdge?: WfEdge } {
  const take: WfEdge[] = [];
  let elseEdge: WfEdge | undefined;
  const { outcome } = ctx;
  const positive = outcome.status === 'success' && outcome.verdict !== 'reject';
  const kindOk = (k: WfEdge['kind']): boolean =>
    k === 'next' ? positive
    : k === 'on-success' ? positive
    : k === 'on-failure' ? outcome.status === 'failure'
    : k === 'on-reject' ? (outcome.status === 'reject' || outcome.verdict === 'reject')
    : false;
  for (const e of wfFlowOut(g, fromId)) {
    if (e.else) { elseEdge = e; continue; }
    if (!kindOk(e.kind)) continue;
    if (e.condition && !wfEvalCondition(e.condition, ctx)) continue;
    take.push(e);
  }
  return { take, elseEdge };
}

const wfPurpose = (node: WfNode): WorkItemKind => (node.config?.purpose as WorkItemKind | undefined) ?? 'custom';

// Pinned agent → Candidate through its workspace roles; role node → pickAgent.
function wfCandidate(r: Run, task: Task | null, node: WfNode, kind: WorkItemKind, difficulty: number): Candidate | null {
  if (node.agentId) {
    const roles = q('SELECT DISTINCT role_id FROM memberships WHERE agent_id = ? AND workspace_id = ? AND active = 1', node.agentId, r.workspaceId);
    for (const m of roles) {
      const roleName = (q1('SELECT name FROM roles WHERE id = ?', m.role_id as string)?.name as string) ?? '';
      const c = candidatesForRole(r.workspaceId, roleName).find((x) => x.agent.id === node.agentId && !x.blocked);
      if (c) return c;
    }
    return null;
  }
  if (node.role) return pickAgent(r.workspaceId, node.role, task, kind, difficulty);
  return pickAgent(r.workspaceId, roleNameFor(kind, task), task, kind, difficulty);
}

// A writer node needs the working tree: direct mode assigns the repo itself
// and only one task may hold it; the loser parks and resumes on release.
function wfEnsureTree(r: Run, task: Task, node: WfNode): boolean {
  const repo = getRepo(r.repoId);
  if (!repo) return false;
  if (task.worktree) return true;
  if (isDirect(r)) {
    const other = q(`SELECT t.id FROM tasks t WHERE t.id != ? AND t.status NOT IN ('done','failed','cancelled','blocked')
                     AND json_extract(t.meta, '$.generalCheckpointId') IS NOT NULL`, task.id)
      .some((x) => { const h = getTask(x.id as string); return h ? holdsRepo(h) : false; });
    if (other) {
      const s = wfState(task);
      s.held = node.id;
      saveWfState(task, s);
      setTaskStatus(task.id, 'assigned', 'engine', { parked: node.label });
      emit('workflow.parked', 'engine', { taskId: task.id, nodeId: node.id, reason: 'writer waits for the repository' }, r.id, task.id);
      return false;
    }
    const wt = { worktree: repo.path, branch: currentBranch(repo.path) ?? '(detached)' };
    openTaskCheckpoint(r, repo, task);
    run('UPDATE tasks SET worktree = ?, branch = ? WHERE id = ?', wt.worktree, wt.branch, task.id);
    task.worktree = wt.worktree; task.branch = wt.branch;
    return true;
  }
  const wt = task.worktree ? { worktree: task.worktree, branch: task.branch! } : createWorktree(repo, task.id);
  run('UPDATE tasks SET worktree = ?, branch = ? WHERE id = ?', wt.worktree, wt.branch, task.id);
  task.worktree = wt.worktree; task.branch = wt.branch;
  return true;
}

// What a node receives: envelope only (default), the full previous output, or
// the outputs of named earlier nodes.
function wfInputsText(r: Run, task: Task, node: WfNode): string {
  const inputs = node.config?.inputs ?? 'envelope';
  if (inputs === 'envelope') return envelopeText(handoffEnvelope(task, node.role ?? 'pm'));
  if (inputs === 'full') {
    const last = q1(`SELECT result FROM work_items WHERE task_id = ? AND status = 'delivered' ORDER BY finished_at DESC LIMIT 1`, task.id);
    return last?.result ? `PREVIOUS OUTPUT:\n${String(last.result).slice(0, 6000)}` : '';
  }
  if (Array.isArray(inputs)) {
    return inputs.map((nid) => {
      const wi = q1(`SELECT result FROM work_items WHERE task_id = ? AND workflow_node_id = ? AND status = 'delivered' ORDER BY finished_at DESC LIMIT 1`, task.id, nid);
      const label = wfNode(graphFor(r)!.graph, nid)?.label ?? nid;
      return wi?.result ? `<${label}>\n${String(wi.result).slice(0, 4000)}\n</${label}>` : '';
    }).filter(Boolean).join('\n\n');
  }
  return '';
}

// Guardrail acknowledgements that span a whole run (a task's own acks live in
// its wf state). A restart re-asks — safe default.
const wfRunGuardOk = new Map<string, Set<string>>();

// Phase 4 guardrails — pause dispatching and raise a Needs-you item when a
// workflow's limits are hit. Approving lets the run continue past it.
function wfGuardrailCheck(r: Run, task: Task, node: WfNode, s: WfState): string | null {
  const g = graphFor(r)?.graph.guardrails;
  if (!g) return null;
  const ok = (key: string, scope: 'task' | 'run') =>
    scope === 'task' ? (s.guardOk ?? []).includes(key) : (wfRunGuardOk.get(r.id)?.has(key) ?? false);
  if (g.maxStepsPerTask != null && (s.steps ?? 0) >= g.maxStepsPerTask && !ok('task-steps', 'task'))
    return `task "${task.title}" used its ${g.maxStepsPerTask} graph steps`;
  if (g.maxStepsPerRun != null && !ok('run-steps', 'run')) {
    const used = q1(`SELECT COUNT(*) c FROM work_items WHERE run_id = ?`, r.id)?.c as number ?? 0;
    if (used >= g.maxStepsPerRun) return `the run used its ${g.maxStepsPerRun} agent calls`;
  }
  if (g.costCeilingUsd != null && !ok('cost', 'run')) {
    const spent = q1(`SELECT COALESCE(SUM(cost_usd),0) c FROM usage_records WHERE run_id = ?`, r.id)?.c as number ?? 0;
    if (spent >= g.costCeilingUsd) return `the run passed its $${g.costCeilingUsd} cost ceiling ($${spent.toFixed(2)} spent)`;
  }
  if (g.timeCeilingMin != null && !ok('time', 'run')) {
    const started = r.startedAt ? new Date(r.startedAt).getTime() : Date.now();
    if (Date.now() - started >= g.timeCeilingMin * 60000) return `the run passed its ${g.timeCeilingMin} min time ceiling`;
  }
  return null;
}

function wfGateGuardrail(r: Run, task: Task, node: WfNode, why: string): void {
  const s = wfState(task);
  s.awaiting = { kind: 'guard', nodeId: node.id, at: now(), guard: why };
  saveWfState(task, s);
  emit('workflow.guardrail', 'engine', { taskId: task.id, nodeId: node.id, why }, r.id, task.id);
  const a = requestApproval({ action: 'workflow.guardrail', taskId: task.id, runId: r.id, requestedBy: 'engine',
    payload: { summary: `Guardrail hit: ${why}. Approve to keep going anyway, reject to stop the task.`, nodeId: node.id, guard: why } });
  const fresh = getTask(task.id)!;
  const s2 = wfState(fresh);
  if (s2.awaiting?.nodeId === node.id) {
    s2.awaiting = { ...s2.awaiting, approvalId: a.id };
    saveWfState(fresh, s2);
    setTaskStatus(task.id, 'waiting-input', 'engine', { reason: `guardrail: ${why}` });
  }
}

function dispatchAgentNode(r: Run, task: Task, node: WfNode, viaEdge: WfEdge | null, overrides?: { contract?: string; facts?: string }): void {
  task = getTask(task.id)!;                       // fresh: sibling edges may have saved state
  const s = wfState(task);
  // bypassed node: no dispatch, no message edges — it passes the last outcome
  // through (a skipped review keeps the reviewer's verdict pending, not clean)
  if (node.config?.disabled) {
    s.nodes = s.nodes.filter((id) => id !== node.id);
    saveWfState(task, s);
    emit('workflow.step', 'engine', { taskId: task.id, nodeId: node.id, label: node.label, bypassed: true }, r.id, task.id);
    graphAdvanceFrom(r, task, node, s.lastOutcome ?? { status: 'success' }, null);
    return;
  }
  const kind = wfPurpose(node);
  const writable = node.config?.writable ?? WF_WRITER_KINDS.has(kind);
  // one writer at a time on the same task too — later writers queue
  if (writable && s.nodes.some((id) => id !== node.id && WF_WRITER_KINDS.has((wfNode(graphFor(r)!.graph, id)?.config?.purpose as WorkItemKind) ?? 'custom'))) {
    s.queued = [...(s.queued ?? []), node.id];
    saveWfState(task, s);
    emit('workflow.parked', 'engine', { taskId: task.id, nodeId: node.id, reason: 'another writer step is still running' }, r.id, task.id);
    return;
  }
  // guardrails — a step that trips a ceiling pauses for the owner (checked
  // after the writer queue so a parked node does not consume the budget)
  const guard = wfGuardrailCheck(r, task, node, s);
  if (guard) { wfGateGuardrail(r, task, node, guard); return; }
  const tierDifficulty = node.config?.modelTier === 'strong' ? 5 : node.config?.modelTier === 'fast' ? 1 : task.difficulty;
  const candidate = wfCandidate(r, task, node, kind, tierDifficulty);
  if (!candidate) {
    emit('workflow.deadend', 'engine', { taskId: task.id, nodeId: node.id, reason: `no eligible agent for role "${node.role ?? node.agentId}"` }, r.id, task.id);
    requestApproval({ action: 'workflow.deadend', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `No agent can run "${node.label}" (${node.role ?? node.agentId})` } });
    setTaskStatus(task.id, 'blocked', 'engine', { reason: `no eligible agent for ${node.label}` });
    return;
  }
  if (!roleMayDo(candidate.role.name, kind)) emit('workflow.role.mismatch', 'engine', { taskId: task.id, nodeId: node.id, role: candidate.role.name, kind }, r.id, task.id);
  if (writable && !wfEnsureTree(r, task, node)) return;
  const repo = getRepo(r.repoId);
  // node.config.budgetChars is a char budget; packFor's `wanted` is tokens
  const budgetTokens = node.config?.budgetChars != null ? Math.ceil(node.config.budgetChars / 4) : (writable ? 16000 : 12000);
  const pack = packFor(repo, task, candidate, budgetTokens, kind);
  const s2 = wfState(task);
  const lastReport = s2.lastOutcome?.report;
  const prompt = renderPrompt({
    kind, agent: candidate.agent, role: candidate.role, task, goal: r.goal, pack, adapterId: candidate.provider?.adapterId,
    extra: {
      handoff: wfInputsText(r, task, node),
      nodeInstructions: [node.config?.instructions, overrides?.facts].filter(Boolean).join('\n\n') || undefined,
      contract: overrides?.contract,
      approvedPrompt: approvedPromptFor(task.id),
      changeNotes: writable ? undefined : changeNotes(task).slice(0, 3000),
      checkResults: lastReport,
      qaReport: kind === 'accept' ? lastReport?.slice(0, 4000) : undefined,
      draft: kind === 'prompt-review' ? s2.draft?.text : undefined,
      target: kind === 'prompt' || kind === 'prompt-review' ? `${node.label} (${kind})` : undefined,
      inbox: inboxText(candidate, r.id, task.id),
      handoffPath: writable ? handoffPath(task, isDirect(r)) : undefined,
      kbNotes: writable ? lessonNotes(r, task) : undefined,
      requirementsChanged: takeRequirementNote(task),
      revisionNotes: kind === 'prompt' && (s2.draft?.revision ?? 0) > 0 ? 'The reviewer asked for changes — address them and re-emit the brief.' : undefined,
    },
  });
  // an approved draft replaces the writer's prompt — like dispatchApprovedPrompt
  let record: RenderedPrompt = prompt;
  const packHash = pack.hash;
  if (writable && s2.draft?.approved) {
    const body = s2.draft.text.includes('OUTPUT CONTRACT') ? s2.draft.text : `## Brief (approved)\n${s2.draft.text.trim()}\n\n${prompt.text}`;
    record = finalizeApprovedPrompt(body, kind, candidate.provider?.adapterId, inboxText(candidate, r.id, task.id), candidate.role, handoffPath(task, isDirect(r)), prompt.budgetChars);
  }
  const promptText = record.text;
  // per-node attempt counting: re-entering a node that already delivered is
  // a retry of that step (attempt 2, 3…), which attempt-based behaviour —
  // scripted fail-once, retry policies — depends on. NULL the cache key too:
  // the identical prompt must not replay the old verdict or loops can't
  // make progress.
  const reEntry = s2.fired.includes(node.id);
  s2.nodeAttempts = { ...(s2.nodeAttempts ?? {}), [node.id]: (s2.nodeAttempts?.[node.id] ?? 0) + 1 };
  const nodeAttempt = s2.nodeAttempts[node.id];
  const wi = createWorkItemRecord(r.id, task, kind, candidate, record, packHash);
  if (wi.attempt !== nodeAttempt) { run('UPDATE work_items SET attempt = ? WHERE id = ?', nodeAttempt, wi.id); wi.attempt = nodeAttempt; }
  run('UPDATE work_items SET workflow_node_id = ?, workflow_edge_id = ? WHERE id = ?', node.id, viaEdge?.id ?? null, wi.id);
  wi.workflowNodeId = node.id;
  wi.workflowEdgeId = viaEdge?.id ?? null;
  if (reEntry) { run('UPDATE work_items SET cache_key = NULL WHERE id = ?', wi.id); wi.cacheKey = null; }
  // an analyse step right after a check failure inherits the failing run —
  // its delivery files the analyst-informed report like the fixed pipeline
  if (kind === 'analyse' && s2.lastOutcome?.checkRunId) {
    pendingAnalysis.set(wi.id, { checkRunId: s2.lastOutcome.checkRunId, taskId: task.id, checkName: s2.lastOutcome.checkName ?? '', files: s2.lastOutcome.files ?? [] });
  }
  s2.nodes = [...new Set([...s2.nodes.filter((id) => id !== node.id), node.id])];
  s2.held = s2.held === node.id ? undefined : s2.held;
  s2.steps = (s2.steps ?? 0) + 1;                  // guardrail counter — a dispatch actually happened
  saveWfState(task, s2);
  emit('workflow.step', 'engine', { taskId: task.id, nodeId: node.id, label: node.label, kind, agent: candidate.agent.name, via: viaEdge?.id ?? null }, r.id, task.id);
  if (task.status !== 'verifying' && task.status !== 'in-review') setTaskStatus(task.id, 'assigned', 'engine', { agent: candidate.agent.name, node: node.label });
  void executeWorkItem(wi, candidate, promptText, writable ? task.worktree : null);
}

// 'message' edges deliver a structured message to the target agent's next
// prompt — no extra model call. waitForReply pauses the sender's step.
function wfFireMessageEdges(r: Run, task: Task, node: WfNode, fromAgentId: string, outcome: WfOutcome): { waiting: boolean; s: WfState } {
  const s = wfState(task);
  for (const e of wfMsgOut(graphFor(r)!.graph, node.id)) {
    const target = wfNode(graphFor(r)!.graph, e.to);
    const cand = target ? wfCandidate(r, task, target, 'custom', 1) : null;
    const toAgent = cand?.agent.id ?? target?.agentId;
    if (!toAgent) continue;
    postMessage({
      runId: r.id, taskId: task.id, from: fromAgentId, to: toAgent, kind: 'handoff',
      text: outcome.report ?? outcome.output?.summary as string ?? `Step "${node.label}" finished (${outcome.status}).`,
    });
    emit('workflow.message', 'engine', { taskId: task.id, edgeId: e.id, from: fromAgentId, to: toAgent }, r.id, task.id);
    if (e.waitForReply) {
      s.awaiting = { kind: 'reply', nodeId: node.id, edgeId: e.id, at: now() };
      scheduleTimer(r.id, e.timeoutMin ?? 15, 'wf.reply.timeout', { taskId: task.id, edgeId: e.id });
      setTaskStatus(task.id, 'waiting-input', 'engine', { reason: `waiting for a reply from ${cand?.agent.name ?? toAgent}` });
    }
  }
  return { waiting: !!s.awaiting, s };
}

// ---------------------------------------------------------------------------
// Human approval node. Code gathers the facts, an agent writes the report, the owner decides.
//   1. the engine starts the project's app (services/app-launcher) and watches it;
//   2. the node's connected agent reads the request, the changes and those facts, picks the screens worth testing and
//      writes a report (summary, changes, testing, issues, app status);
//   3. the engine probes every proposed screen itself, so a page that answers 500 can't be reported as fine, opens the
//      first one in the owner's browser and raises a Needs-you item with the whole report;
//   4. the owner approves (the task follows the approve edge) or rejects with feedback (the reject edge; the feedback and
//      the app's own log go to the agents that investigate and fix it, and the task comes back here for another review).
// Every decision is recorded on the task and as a human.decided event.
// ---------------------------------------------------------------------------

const APPROVAL_CONTRACT = `
You are preparing a HUMAN APPROVAL review: the owner will test the running application by hand, then approve or reject it.
The engine has already started the app and gathered the facts below (DATA blocks): trust them over assumptions.
Your job:
1. From the original request and the changes, decide which screens, pages or features the owner should open to test this work.
2. Read the app's state, its log tail and its error lines (open the log file if you need more) and look for runtime errors, crashed or
   missing background processes, failing routes and warnings that matter.
3. Write the report the owner reads before testing.

OUTPUT CONTRACT (mandatory): respond with ONE json code block:
\`\`\`json
{"summary":"2-3 sentences: what changed and what state the app is in",
 "changes":["what was changed, in plain words"],
 "testing":[{"what":"what you actually checked","result":"pass|fail|unknown","notes":"..."}],
 "issues":[{"severity":"low|medium|high","message":"what you saw, and where"}],
 "appStatus":"ready|degraded|failed",
 "routes":[{"label":"Login page","path":"/login","why":"the request was about the login form"}],
 "howToTest":["step the owner should take"]}
\`\`\`
Rules:
- "routes": paths on the app (they start with "/"), the most relevant first, at most 6. If the work has no screen, use "/" and say so in "why".
- "testing" lists only what you really checked (the log, the engine's facts, the changed files). Never claim a test you did not do.
- "issues" lists only what you really saw. An empty list is a valid answer. Never invent a problem to look thorough.
- Do not edit any file and do not start or stop the app.
`.trim();

type ApprovalRoute = { label: string; path: string; why: string };

function approvalFacts(r: Run, task: Task, repo: Repo, info: AppInfo, diag: Diagnostics): string {
  const prior = ((task.meta?.humanDecisions as { decision: string; feedback: string }[] | undefined) ?? []).filter((d) => d.decision === 'rejected').slice(-3);
  // what the developers delivered, from their work items (no new snapshot of the repository while others may be taking one)
  const files = [...new Set(q(`SELECT result FROM work_items WHERE task_id = ? AND kind IN ('implement','fix','doc','test') AND status = 'delivered' ORDER BY rowid`, task.id)
    .flatMap((w) => (parseJson<{ filesChanged?: string[] }>(w.result as string, {}).filesChanged ?? []))
    .filter((f) => f !== 'HANDOFF.md' && !f.startsWith('.office/')))];
  return [
    `ORIGINAL REQUEST: ${r.goal}`,
    `TASK: ${task.title}${task.description ? `\n${task.description.slice(0, 1500)}` : ''}`,
    task.acceptanceCriteria.length ? `ACCEPTANCE CRITERIA:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}` : '',
    prior.length ? `EARLIER REJECTIONS BY THE OWNER (this is a re-review — check they were addressed):\n${prior.map((d, i) => `${i + 1}. ${d.feedback}`).join('\n')}` : '',
    `FILES CHANGED (${files.length}): ${files.slice(0, 40).join(', ') || 'none recorded'}`,
    `(You work in the repository folder: \`git status\` and \`git diff\` show the details.)`,
    `APP (started by the engine): ${diag.summary}`,
    `  command: ${info.command ?? 'none'}   folder: ${info.cwd}   log file: ${info.logFile}`,
    info.note ? `  note: ${info.note}` : '',
    diag.errorLines.length ? `ERROR-LOOKING LOG LINES:\n${diag.errorLines.join('\n')}` : 'ERROR-LOOKING LOG LINES: none',
    `LOG TAIL (last ${diag.logTail.length} lines):\n${diag.logTail.join('\n') || '(no output yet)'}`,
  ].filter(Boolean).join('\n\n');
}

// a node that was in flight when the daemon restarted, or a retried dead end: agent nodes dispatch, approval nodes start over
function dispatchNode(r: Run, task: Task, node: WfNode, viaEdge: WfEdge | null): void {
  if (node.type === 'approval') approvalEnter(r, task, node, viaEdge); else dispatchAgentNode(r, task, node, viaEdge);
}

function approvalEnter(r: Run, task: Task, node: WfNode, viaEdge: WfEdge | null): void {
  task = getTask(task.id)!;
  const difficulty = node.config?.modelTier === 'strong' ? 5 : node.config?.modelTier === 'fast' ? 1 : task.difficulty;
  // no agent to write the report: dispatchAgentNode raises the usual dead-end Needs-you item — and no app is started for nothing
  if (!wfCandidate(r, task, node, 'custom', difficulty)) { dispatchAgentNode(r, task, node, viaEdge); return; }
  const s = wfState(task);
  s.nodes = [...new Set([...s.nodes.filter((id) => id !== node.id), node.id])];
  saveWfState(task, s);
  emit('workflow.step', 'engine', { taskId: task.id, nodeId: node.id, label: node.label, human: true, approval: true }, r.id, task.id);
  setTaskStatus(task.id, 'verifying', 'engine', { reason: `starting the app for your review: ${node.label}`, node: node.label });
  void approvalPrepare(r, task.id, node, viaEdge).catch((e) => {
    emit('approval.failed', 'engine', { taskId: task.id, nodeId: node.id, error: String(e).slice(0, 300) }, r.id, task.id);
    stopApp(task.id);
    const t = getTask(task.id);
    if (t && !TERMINAL_TASK.includes(t.status)) {
      setTaskStatus(task.id, 'blocked', 'engine', { reason: `could not prepare the approval step: ${String(e).slice(0, 160)}` });
      requestApproval({ action: 'workflow.deadend', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `"${node.label}" could not be prepared (${String(e).slice(0, 160)}). Approve to retry.` } });
    }
  });
}

async function approvalPrepare(r: Run, taskId: string, node: WfNode, viaEdge: WfEdge | null): Promise<void> {
  const repo = getRepo(r.repoId);
  if (!repo) throw new Error('the run has no repository');
  const cfg = node.config?.approval ?? {};
  emit('approval.preparing', 'engine', { taskId, nodeId: node.id, command: cfg.command || 'detect' }, r.id, taskId);
  const info = await startApp(taskId, cfg, repo.path);
  const diag = await diagnose(taskId);
  emit('approval.app', 'engine', { taskId, nodeId: node.id, state: info.state, url: info.url, note: info.note, summary: diag.summary }, r.id, taskId);
  const fresh = getTask(taskId);
  const live = getRun(r.id);
  if (!fresh || TERMINAL_TASK.includes(fresh.status) || !live || ['done', 'stopped', 'failed'].includes(live.status)) { stopApp(taskId); return; }   // deleted, finished or stopped while the app was starting
  setTaskMeta(taskId, 'approvalApp', { state: info.state, url: info.url, command: info.command, note: info.note, logFile: info.logFile, startedAt: info.startedAt });
  dispatchAgentNode(live, fresh, node, viaEdge, { contract: APPROVAL_CONTRACT, facts: approvalFacts(live, fresh, repo, info, diag) });
}

const asStr = (x: unknown, n = 600): string => String(x ?? '').trim().slice(0, n);

async function approvalReported(wi: WorkItem, result: NonNullable<WorkItem['result']>, usedAgentId: string, r: Run, task: Task, node: WfNode): Promise<void> {
  const raw = (result.raw ?? {}) as Record<string, any>;
  const j = (raw.json ?? raw) as Record<string, any>;
  const cfg = node.config?.approval ?? {};
  const info = appInfo(task.id);

  // the screens to offer: the owner's own list first, then the agent's picks — plain paths only, never another site
  const routes: ApprovalRoute[] = [];
  const addRoute = (p: unknown, label: unknown, why: unknown) => {
    const path = safeRoutePath(p);
    if (path && !routes.some((x) => x.path === path) && routes.length < 8) routes.push({ path, label: asStr(label, 80) || path, why: asStr(why, 200) });
  };
  for (const p of cfg.routes ?? []) addRoute(p, p, 'always offered for this workflow');
  for (const x of Array.isArray(j.routes) ? j.routes : []) addRoute(x?.path, x?.label, x?.why);
  if (!routes.length) addRoute('/', 'Home', 'the work has no specific screen');

  // facts beat claims: every offered screen is requested by the engine itself
  const base = info && (info.state === 'ready' || info.state === 'starting') ? info.url : null;
  const probes = base ? await probeRoutes(base, routes.map((x) => x.path)) : [];
  if (probes.length) await new Promise((res) => setTimeout(res, 300));   // let the app write what those requests made it log
  const diag = await diagnose(task.id);
  const issues: { severity: string; message: string; source: 'agent' | 'engine' }[] = (Array.isArray(j.issues) ? j.issues : [])
    .map((i: any) => ({ severity: ['low', 'medium', 'high'].includes(i?.severity) ? i.severity : 'medium', message: asStr(i?.message, 400), source: 'agent' as const })).filter((i) => i.message).slice(0, 12);
  for (const p of probes) {
    if (p.status == null) issues.push({ severity: 'high', message: `${p.path} did not answer: ${p.error ?? 'no response'}`, source: 'engine' });
    else if (p.status >= 500) issues.push({ severity: 'high', message: `${p.path} answered with a server error (${p.status})`, source: 'engine' });
    else if (p.status === 404) issues.push({ severity: 'medium', message: `${p.path} answered 404 (not found)`, source: 'engine' });
  }
  const running = !!info && (info.state === 'ready' || info.state === 'starting') && diag.listening === true;
  if (!running) issues.unshift({ severity: 'high', message: info ? `The app is not running or not answering (${info.state}). ${info.note}`.trim() : 'The app was not started.', source: 'engine' });
  const claimed = ['ready', 'degraded', 'failed'].includes(j.appStatus) ? j.appStatus : 'ready';
  const appStatus = !running ? 'failed' : issues.some((i) => i.source === 'engine') || claimed === 'degraded' || claimed === 'failed' ? 'degraded' : 'ready';

  const report = {
    summary: asStr(j.summary || result.summary || raw.text, 1200) || 'No summary was written.',
    changes: (Array.isArray(j.changes) ? j.changes : []).map((c: unknown) => asStr(c, 300)).filter(Boolean).slice(0, 15),
    testing: (Array.isArray(j.testing) ? j.testing : []).map((t: any) => ({ what: asStr(t?.what, 300), result: ['pass', 'fail', 'unknown'].includes(t?.result) ? t.result : 'unknown', notes: asStr(t?.notes, 300) })).filter((t: { what: string }) => t.what).slice(0, 15),
    issues, appStatus,
    howToTest: (Array.isArray(j.howToTest) ? j.howToTest : []).map((c: unknown) => asStr(c, 300)).filter(Boolean).slice(0, 10),
    agent: getAgent(usedAgentId)?.name ?? usedAgentId,
  };
  const offered = routes.map((x, i) => ({ ...x, url: base ? `${base}${x.path}` : null, probe: probes[i] ? { status: probes[i].status, ms: probes[i].ms, error: probes[i].error } : null }));
  const app = { state: info?.state ?? 'none', url: base, command: info?.command ?? null, pid: info?.pid ?? null, note: info?.note ?? '', logFile: info?.logFile ?? null, listening: diag.listening };
  setTaskMeta(task.id, 'approvalReview', { at: now(), report, routes: offered, app, errorLines: diag.errorLines.slice(-8), logFile: info?.logFile ?? null });

  const s = wfState(getTask(task.id)!);
  s.nodes = s.nodes.filter((id) => id !== node.id);
  s.awaiting = { kind: 'human', nodeId: node.id, at: now() };
  saveWfState(task, s);
  emit('human.prepared', report.agent, { taskId: task.id, nodeId: node.id, appStatus, issues: issues.length, routes: offered.length }, r.id, task.id);
  const a = requestApproval({
    action: 'human.approval', taskId: task.id, runId: r.id, requestedBy: usedAgentId,
    payload: { summary: `Review "${task.title}": ${report.summary.slice(0, 200)}`, nodeId: node.id, nodeLabel: node.label, taskTitle: task.title, report, app, routes: offered, logTail: diag.logTail.slice(-30), errorLines: diag.errorLines.slice(-8) },
  });
  const after = getTask(task.id)!;
  const s2 = wfState(after);
  if (s2.awaiting?.nodeId === node.id) {
    s2.awaiting = { ...s2.awaiting, approvalId: a.id };
    saveWfState(after, s2);
    setTaskStatus(task.id, 'waiting-input', 'engine', { reason: `waiting for your approval: ${node.label}` });
  }
  if (cfg.openBrowser !== false && offered[0]?.url) openBrowser(offered[0].url);
}

// What the owner can do with the app while reviewing: start it again (after a crash, or to reset its state), stop it, or open a
// screen in the browser. Only while the review is still pending, and only the app's own address.
export async function reviewAppControl(approvalId: string, action: 'restart' | 'stop' | 'open', url?: string): Promise<{ ok: true; app: AppInfo | null; log: string[] } | { error: string; status: number }> {
  const a = q1('SELECT * FROM approvals WHERE id = ?', approvalId);
  if (!a || a.action !== 'human.approval' || !a.task_id) return { error: 'not an approval with an app to review', status: 404 };
  const taskId = a.task_id as string;
  if (action === 'stop') { stopApp(taskId); return { ok: true, app: appInfo(taskId), log: appLogLines(taskId) }; }
  if (a.status !== 'pending') return { error: 'this review has already been decided — the app was stopped', status: 409 };
  const task = getTask(taskId);
  const r = task ? getRun(task.runId) : null;
  const repo = r ? getRepo(r.repoId) : null;
  if (!task || !r || !repo) return { error: 'the task or its repository no longer exists', status: 404 };
  if (action === 'open') {
    const info = appInfo(taskId);
    if (!info?.url) return { error: 'the app has no address — restart it first', status: 409 };
    const target = url ? url : info.url;
    if (target !== info.url && !target.startsWith(info.url + '/')) return { error: "that address is not part of the app under review", status: 400 };
    if (!openBrowser(target)) return { error: 'could not open the browser from here — use the link instead', status: 409 };
    return { ok: true, app: info, log: appLogLines(taskId) };
  }
  const node = wfNode(graphFor(r)?.graph ?? { nodes: [], edges: [] }, (parseJson<Record<string, unknown>>(a.payload as string, {}).nodeId as string) ?? '');
  const info = await startApp(taskId, node?.config?.approval ?? {}, repo.path);
  setTaskMeta(taskId, 'approvalApp', { state: info.state, url: info.url, command: info.command, note: info.note, logFile: info.logFile, startedAt: info.startedAt });
  emit('approval.app', 'owner', { taskId, nodeId: node?.id, state: info.state, url: info.url, note: info.note, restarted: true }, r.id, taskId);
  return { ok: true, app: info, log: appLogLines(taskId) };
}
const appLogLines = (taskId: string): string[] => appLog(taskId, 120);

// The owner's answer. Approve follows the approve edge; reject follows the reject edge carrying the feedback and what the
// app's own log showed, so the agents that investigate start from facts, not just from "it's broken".
function humanApprovalResume(r: Run, task: Task, approved: boolean, awaiting: WfState['awaiting'], approvalId: string, feedback: string): void {
  const node = wfNode(graphFor(r)!.graph, awaiting?.nodeId ?? '');
  const review = (task.meta?.approvalReview ?? {}) as { report?: { summary?: string; issues?: { message: string }[] }; errorLines?: string[]; logFile?: string | null; routes?: { path: string }[] };
  const prior = (task.meta?.humanDecisions as unknown[] | undefined) ?? [];
  const entry = { at: now(), nodeId: node?.id ?? awaiting?.nodeId ?? '', nodeLabel: node?.label ?? 'Human approval', decision: approved ? 'approved' : 'rejected', feedback, approvalId, round: prior.length + 1 };
  setTaskMeta(task.id, 'humanDecisions', [...prior, entry]);
  emit('human.decided', 'owner', { taskId: task.id, nodeId: entry.nodeId, nodeLabel: entry.nodeLabel, decision: entry.decision, feedback, approvalId, round: entry.round }, r.id, task.id);
  stopApp(task.id);
  const s = wfState(getTask(task.id)!);
  s.awaiting = undefined;
  saveWfState(task, s);
  setTaskStatus(task.id, 'assigned', 'owner', { reason: approved ? 'approved by the owner' : 'rejected by the owner — sent back with feedback' });
  if (approved) {
    graphAdvanceFrom(r, task, node, { status: 'success', verdict: 'approve', report: `HUMAN REVIEW: APPROVED by the owner${feedback ? ` — ${feedback}` : ''}.` }, null);
    return;
  }
  const report = [
    'HUMAN REVIEW: REJECTED by the owner, who tested the running app. Investigate this before changing anything.',
    `OWNER FEEDBACK: ${feedback}`,
    review.report?.summary ? `WHAT WAS REVIEWED: ${review.report.summary}` : '',
    review.report?.issues?.length ? `ISSUES ALREADY FLAGGED: ${review.report.issues.map((i) => i.message).slice(0, 6).join(' | ')}` : '',
    review.errorLines?.length ? `ERRORS IN THE APP LOG WHEN IT WAS REVIEWED:\n${review.errorLines.join('\n')}` : '',
    review.logFile ? `FULL APP LOG: ${review.logFile}` : '',
  ].filter(Boolean).join('\n');
  // everyone working this task hears it, wherever the reject edge sends the task
  if (task.ownerAgentId) postMessage({ runId: r.id, taskId: task.id, from: 'owner', to: task.ownerAgentId, kind: 'finding', text: `The owner rejected "${task.title}" after testing it: ${feedback}` });
  graphAdvanceFrom(r, task, node, { status: 'reject', verdict: 'reject', report }, null);
}

function graphEnter(r: Run, task: Task, node: WfNode, viaEdge: WfEdge | null): void {
  task = getTask(task.id)!;
  const s = wfState(task);
  switch (node.type) {
    case 'agent': dispatchAgentNode(r, task, node, viaEdge); return;
    case 'end': {
      emit('workflow.step', 'engine', { taskId: task.id, nodeId: node.id, label: node.label, done: true }, r.id, task.id);
      setTaskStatus(task.id, 'approved', 'engine', { reason: `workflow reached ${node.label}` });
      s.nodes = s.nodes.filter((id) => id !== node.id);
      saveWfState(task, s);
      void proceedMerge(task.id);
      return;
    }
    case 'human': {
      // record the gate BEFORE asking — requestApproval can auto-approve inline
      s.awaiting = { kind: 'human', nodeId: node.id, at: now() };
      saveWfState(task, s);
      emit('workflow.step', 'engine', { taskId: task.id, nodeId: node.id, label: node.label, human: true }, r.id, task.id);
      const a = requestApproval({ action: 'workflow.human', taskId: task.id, runId: r.id, requestedBy: 'engine',
        payload: { summary: node.config?.instructions || `Owner approval: ${node.label}`, nodeId: node.id, nodeLabel: node.label } });
      const fresh = getTask(task.id)!;
      const s2 = wfState(fresh);
      if (s2.awaiting?.nodeId === node.id) {
        s2.awaiting = { ...s2.awaiting, approvalId: a.id };
        saveWfState(fresh, s2);
        setTaskStatus(task.id, 'waiting-input', 'engine', { reason: `approval gate: ${node.label}` });
      }
      return;
    }
    case 'approval': approvalEnter(r, task, node, viaEdge); return;
    case 'merge': {
      const arrived = s.arrived[node.id] ?? [];
      if (viaEdge && !arrived.includes(viaEdge.id)) s.arrived[node.id] = [...arrived, viaEdge.id];
      const mode = node.config?.mergeMode ?? 'all';
      const expected = graphFor(r)!.graph.edges.filter((e) => e.to === node.id && e.kind !== 'message' && (s.fired.includes(e.from) || s.nodes.includes(e.from))).length;
      const done = mode === 'any' ? s.arrived[node.id]!.length >= 1 : s.arrived[node.id]!.length >= Math.max(1, expected);
      emit('workflow.merge', 'engine', { taskId: task.id, nodeId: node.id, arrived: s.arrived[node.id]!.length, expected, mode }, r.id, task.id);
      if (!done) {
        // nothing else in flight and the merge can't complete — stall guard
        if (!s.nodes.length && !s.awaiting) {
          s.deadEndNode = node.id;
          emit('workflow.deadend', 'engine', { taskId: task.id, nodeId: node.id, reason: `merge "${node.label}" starved (${s.arrived[node.id]!.length}/${expected})` }, r.id, task.id);
          requestApproval({ action: 'workflow.deadend', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `Merge "${node.label}" is waiting for branches that never ran.` } });
          setTaskStatus(task.id, 'blocked', 'engine', { reason: 'workflow merge starved' });
        }
        saveWfState(task, s);
        return;
      }
      saveWfState(task, s);
      graphAdvanceFrom(r, task, node, s.lastOutcome ?? { status: 'success' }, null);
      return;
    }
    case 'condition': {
      emit('workflow.step', 'engine', { taskId: task.id, nodeId: node.id, label: node.label }, r.id, task.id);
      graphAdvanceFrom(r, task, node, s.lastOutcome ?? { status: 'success' }, null);
      return;
    }
    case 'start': {
      graphAdvanceFrom(r, task, node, s.lastOutcome ?? { status: 'success' }, null);
      return;
    }
  }
}

// Traverse from a node: message edges fire, matching edges are followed
// (bounded by maxLoops), else the else-edge, else a dead-end Needs-you.
function graphAdvanceFrom(r: Run, task: Task, node: WfNode | null, outcome: WfOutcome, fromAgentId: string | null): void {
  task = getTask(task.id)!;
  const g = graphFor(r)!;
  const s = wfState(task);
  if (node) {
    s.nodes = s.nodes.filter((id) => id !== node.id);
    if (!s.fired.includes(node.id)) s.fired.push(node.id);
    s.lastOutcome = outcome;
    if (fromAgentId) {
      const { waiting } = wfFireMessageEdges(r, task, node, fromAgentId, outcome);
      if (waiting) { saveWfState(task, s); return; }
    }
  }
  const ctx = { outcome, task };
  let edges: WfEdge[] = [];
  if (node) {
    const { take, elseEdge } = wfMatchingEdges(g.graph, node.id, ctx);
    edges = take.length ? take : elseEdge ? [elseEdge] : [];
    emit('workflow.branch', 'engine', { taskId: task.id, from: node.id, edges: edges.map((e) => e.id), status: outcome.status, verdict: outcome.verdict ?? null }, r.id, task.id);
  }
  for (const e of edges) {
    const cap = e.maxLoops ?? (WF_LOOP_KINDS.includes(e.kind) ? DEFAULT_MAX_LOOPS : undefined);
    const used = s.loops[e.id] ?? 0;
    if (cap != null && used >= cap) {
      s.awaiting = { kind: 'human', nodeId: node?.id ?? '', edgeId: e.id, at: now() };
      saveWfState(task, s);
      emit('workflow.loop', 'engine', { taskId: task.id, edgeId: e.id, loops: used, exhausted: true }, r.id, task.id);
      const a = requestApproval({ action: 'workflow.loop', taskId: task.id, runId: r.id, requestedBy: 'engine',
        payload: { summary: `The retry loop through "${node?.label ?? e.from}" hit its limit (${cap}). Approve to allow one more pass, reject to stop the task.`, edgeId: e.id, nodeId: e.to } });
      const fresh = getTask(task.id)!;
      const s2 = wfState(fresh);
      if (s2.awaiting?.edgeId === e.id) {
        s2.awaiting = { ...s2.awaiting, approvalId: a.id };
        saveWfState(fresh, s2);
        setTaskStatus(task.id, 'waiting-input', 'engine', { reason: 'loop bound reached' });
      }
      return;
    }
    if (WF_LOOP_KINDS.includes(e.kind) || cap != null) s.loops[e.id] = used + 1;
  }
  // a finished writer releases the oldest queued writer node on this task
  const queued = (s.queued ?? []).filter((id) => !s.nodes.includes(id));
  if (queued.length && !s.nodes.some((id) => WF_WRITER_KINDS.has((wfNode(g.graph, id)?.config?.purpose as WorkItemKind) ?? 'custom'))) {
    s.queued = queued.slice(1);
    saveWfState(task, s);
    const next = wfNode(g.graph, queued[0]);
    if (next) graphEnter(r, getTask(task.id)!, next, null);
  } else {
    s.queued = queued;
    saveWfState(task, s);
  }
  if (!edges.length) {
    if (!s.nodes.length && !s.awaiting) {
      const s2 = wfState(task);
      s2.deadEndNode = node?.id;
      saveWfState(task, s2);
      emit('workflow.deadend', 'engine', { taskId: task.id, nodeId: node?.id, reason: 'no edge matched and nothing is in flight' }, r.id, task.id);
      requestApproval({ action: 'workflow.deadend', taskId: task.id, runId: r.id, requestedBy: 'engine', payload: { summary: `"${task.title}" reached a dead end at "${node?.label ?? 'start'}" (${outcome.status}). Approve to retry the step.` } });
      // auto-approve resumes inline and leaves the task 'ready' — only block
      // when the request is actually pending
      if (getTask(task.id)!.status !== 'ready') setTaskStatus(task.id, 'blocked', 'engine', { reason: 'workflow dead end' });
    }
    return;
  }
  const fresh = getTask(task.id)!;
  for (const e of edges) {
    const target = wfNode(g.graph, e.to);
    if (target) graphEnter(r, fresh, target, e);
  }
}

// Walk from start to the first task-scope nodes (run-scope nodes like plan
// execute once per run, not per task). Exported for assignSweep + tests.
export function wfEntryNodes(g: WfGraph, ctx: { outcome: WfOutcome; task: Task }): WfNode[] {
  const start = g.nodes.find((n) => n.type === 'start');
  if (!start) return [];
  const out: WfNode[] = [];
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length && out.length < 16) {
    const n = stack.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    if (n.type === 'agent' && (n.config?.scope ?? 'task') === 'task') { out.push(n); continue; }
    if (n.type === 'human' || n.type === 'approval' || n.type === 'end' || n.type === 'merge') { out.push(n); continue; }
    // start / condition / run-scope agent: walk its outgoing edges
    const { take, elseEdge } = wfMatchingEdges(g, n.id, ctx);
    for (const e of [...take, ...(elseEdge && !take.length ? [elseEdge] : [])]) {
      const t = wfNode(g, e.to);
      if (t) stack.push(t);
    }
  }
  return out;
}

// A ready task enters the graph — or resumes where it left off (retry, parked
// writer, human gate). Exported for assignSweep and tests.
export function graphTaskEntry(r: Run, task: Task): void {
  const g = graphFor(r);
  if (!g) return;
  const s = wfState(task);
  if (s.awaiting) return;                                    // human/reply gates resume elsewhere
  if (s.held) {                                              // parked writer: retry the tree
    const node = wfNode(g.graph, s.held);
    if (node) { s.held = undefined; saveWfState(task, s); dispatchNode(r, getTask(task.id)!, node, null); }
    return;
  }
  if (s.deadEndNode) {                                       // owner approved a retry of the stalled step
    const node = wfNode(g.graph, s.deadEndNode);
    s.deadEndNode = undefined;
    saveWfState(task, s);
    if (node) { dispatchNode(r, getTask(task.id)!, node, null); return; }
  }
  if (s.nodes.length) {                                      // resume in-flight nodes (retry path)
    for (const id of [...s.nodes]) {
      const node = wfNode(g.graph, id);
      if (node) dispatchNode(r, getTask(task.id)!, node, null);
    }
    return;
  }
  const entries = wfEntryNodes(g.graph, { outcome: s.lastOutcome ?? { status: 'success' }, task });
  if (!entries.length) {
    emit('workflow.deadend', 'engine', { taskId: task.id, reason: 'no task-scope entry node after start' }, r.id, task.id);
    setTaskStatus(task.id, 'blocked', 'engine', { reason: 'workflow has no entry for tasks' });
    return;
  }
  emit('workflow.enter', 'engine', { taskId: task.id, nodes: entries.map((n) => n.id) }, r.id, task.id);
  const fresh = getTask(task.id)!;
  for (const n of entries) graphEnter(r, fresh, n, null);
}

// ---------- Phase 4: dry-run simulation (no model calls) ----------

export interface WfSimStep { n: number; nodeId: string; label: string; type: string; viaEdgeId?: string; note?: string }
export interface WfSimResult {
  steps: WfSimStep[]; takenEdges: string[]; calls: number; humanGates: number;
  loopsUsed: Record<string, number>; result: 'end' | 'dead-end' | 'max-steps'; notes: string[];
}

// Walk the graph exactly as the executor would, with scripted per-node
// outcomes. outcomes[nodeId] may be a single outcome or a queue — looped
// nodes pop the next scripted result each visit.
export function simulateWorkflow(graph: WfGraph, opts: {
  outcomes?: Record<string, WfOutcome['status'] | WfOutcome['status'][]>;
  taskType?: string; difficulty?: number; maxSteps?: number;
} = {}): WfSimResult {
  const task = { id: 'sim', title: 'dry run', type: opts.taskType ?? 'task', difficulty: opts.difficulty ?? 1, attempts: 1, affectedPaths: [], meta: {} } as unknown as Task;
  const steps: WfSimStep[] = [];
  const takenEdges = new Set<string>();
  const loopsUsed: Record<string, number> = {};
  const fired = new Set<string>();
  const arrived: Record<string, Set<string>> = {};
  const notes: string[] = [];
  let calls = 0; let humanGates = 0;
  const scripts = new Map<string, WfOutcome['status'][]>();
  for (const [k, v] of Object.entries(opts.outcomes ?? {})) scripts.set(k, Array.isArray(v) ? [...v] : [v]);
  const scripted = (id: string): WfOutcome => {
    const q2 = scripts.get(id);
    const status = q2?.length ? q2.length > 1 ? q2.shift()! : q2[0] : 'success';
    return { status, verdict: status === 'reject' ? 'reject' : status === 'failure' ? 'fail' : 'approve', checksPassed: status === 'failure' ? false : true };
  };
  const step = (n: WfNode, viaEdgeId: string | undefined, note?: string) =>
    steps.push({ n: steps.length + 1, nodeId: n.id, label: n.label, type: n.type, viaEdgeId, note });

  const queue: { node: WfNode; viaEdgeId?: string; outcome: WfOutcome }[] = [];
  const start = graph.nodes.find((n) => n.type === 'start');
  if (!start) return { steps, takenEdges: [], calls, humanGates, loopsUsed, result: 'dead-end', notes: ['no start node'] };
  step(start, undefined);
  const advance = (node: WfNode, outcome: WfOutcome) => {
    const { take, elseEdge } = wfMatchingEdges(graph, node.id, { outcome, task });
    const edges = take.length ? take : elseEdge ? [elseEdge] : [];
    if (!edges.length) { if (!queue.length) notes.push(`dead end after "${node.label}" (${outcome.status})`); return; }
    for (const e of edges) {
      const cap = e.maxLoops ?? (WF_LOOP_KINDS.includes(e.kind) ? DEFAULT_MAX_LOOPS : undefined);
      const used = loopsUsed[e.id] ?? 0;
      if (cap != null && used >= cap) { notes.push(`loop "${e.label ?? e.id}" hit its bound (${cap}) — the owner would be asked`); continue; }
      if (cap != null) loopsUsed[e.id] = used + 1;
      takenEdges.add(e.id);
      const t = wfNode(graph, e.to);
      if (t) queue.push({ node: t, viaEdgeId: e.id, outcome });
    }
  };
  let lastOutcome: WfOutcome = { status: 'success' };
  advance(start, lastOutcome);

  const guardLimit = opts.maxSteps ?? 100;
  while (queue.length && steps.length < guardLimit) {
    const { node, viaEdgeId, outcome } = queue.shift()!;
    switch (node.type) {
      case 'agent': {
        if (node.config?.disabled) {
          fired.add(node.id);
          step(node, viaEdgeId, 'bypassed');
          advance(node, lastOutcome);
          break;
        }
        calls++;
        const o = scripted(node.id);
        fired.add(node.id);
        step(node, viaEdgeId, `${o.status}${scripts.has(node.id) ? '' : ' (mocked)'}`);
        // message edges fire alongside the flow — recorded, no call
        for (const e of graph.edges.filter((x) => x.from === node.id && x.kind === 'message')) {
          takenEdges.add(e.id);
          notes.push(`message → ${wfNode(graph, e.to)?.label ?? e.to}${e.waitForReply ? ' (waits for reply)' : ''}`);
        }
        lastOutcome = o;
        advance(node, o);
        break;
      }
      case 'condition': step(node, viaEdgeId); advance(node, lastOutcome); break;
      case 'human': humanGates++; step(node, viaEdgeId, 'owner gate — simulated approve'); advance(node, { status: 'success', verdict: 'approve' }); break;
      case 'approval': {
        calls++; humanGates++;
        const o = scripted(node.id);
        fired.add(node.id);
        step(node, viaEdgeId, o.status === 'reject' ? 'owner rejects (mocked) — feedback goes to the reject edge' : 'agent prepares the app, owner approves (simulated)');
        lastOutcome = o.status === 'reject' ? o : { status: 'success', verdict: 'approve' };
        advance(node, lastOutcome);
        break;
      }
      case 'merge': {
        const ins = graph.edges.filter((e) => e.to === node.id && e.kind !== 'message');
        const a = arrived[node.id] ?? (arrived[node.id] = new Set());
        if (viaEdgeId) a.add(viaEdgeId);
        const done = (node.config?.mergeMode ?? 'all') === 'any' ? a.size >= 1 : a.size >= ins.length;
        step(node, viaEdgeId, `${a.size}/${ins.length} arrived${done ? '' : ' — waiting'}`);
        if (done) advance(node, lastOutcome);
        break;
      }
      case 'end': step(node, viaEdgeId, 'done'); return { steps, takenEdges: [...takenEdges], calls, humanGates, loopsUsed, result: 'end', notes };
      case 'start': step(node, viaEdgeId); advance(node, lastOutcome); break;
    }
  }
  return { steps, takenEdges: [...takenEdges], calls, humanGates, loopsUsed, result: steps.length >= guardLimit ? 'max-steps' : 'dead-end', notes };
}

// verifyDeliveredTask hands its check outcomes here for graph runs: engine
// checks still decide pass/fail; the graph decides who runs next.
async function graphChecksDone(wi: WorkItem, task: Task, results: { cr: ReturnType<typeof rowToCheckRun>; check: Check }[], files: string[]): Promise<void> {
  const r = getRun(wi.runId)!;
  const node = wfNode(graphFor(r)!.graph, wi.workflowNodeId);
  const failed = results.filter((x) => x.cr.status === 'fail' || x.cr.status === 'error');
  if (!failed.length) {
    const passCr = results.find((x) => x.cr.status === 'pass')?.cr;
    for (const er of q(`SELECT id FROM error_reports WHERE task_id = ? AND status IN ('open','assigned','fixing','verifying','reopened')`, task.id)) {
      resolveError(er.id as string, null, passCr?.id ?? '', `Checks passed (${results.map((x) => `${x.check.name} ${x.cr.status}`).join(', ')})`, r.workspaceId);
    }
    const report = `Checks passed: ${results.map((x) => `${x.check.name} ${x.cr.status}`).join(', ') || 'no checks ran'}`;
    graphAdvanceFrom(r, task, node, { status: 'success', checksPassed: true, files, report }, wi.agentId);
    return;
  }
  const first = failed[0];
  const { report } = fileErrorReport({
    runId: r.id, cycleN: r.currentCycle, task, workItemId: wi.id,
    checkRun: first.cr, checkName: first.check.name, checkCommand: first.check.command,
    affectedFiles: files, workspaceId: r.workspaceId,
  });
  updateReportHistory(report.id, wi.id, first.cr.id, 'still-failing');
  const reportText = `Checks failed: ${failed.map((x) => `${x.check.name} ${x.cr.status} — ${x.cr.summary}`).join('; ')}`;
  graphAdvanceFrom(r, task, node, { status: 'failure', checksPassed: false, checkRunId: first.cr.id, checkName: first.check.name, files, report: reportText }, wi.agentId);
}

// Delivery routing for graph-dispatched work: parse per kind (same shapes as
// the fixed pipeline), keep the useful side-effects, then let the graph's
// edges decide the next step.
async function graphDelivered(wi: WorkItem, result: NonNullable<WorkItem['result']>, usedAgentId: string, r: Run, task: Task): Promise<void> {
  const g = graphFor(r)!;
  const node = wfNode(g.graph, wi.workflowNodeId) ?? wfNode(g.graph, wfState(task).nodes[0]);
  const raw = (result.raw ?? {}) as Record<string, any>;
  const j = (raw.json ?? raw) as Record<string, any>;

  // a Human approval node's agent wrote the review report: the engine verifies it and asks the owner
  if (node?.type === 'approval') { await approvalReported(wi, result, usedAgentId, r, task, node); return; }

  switch (wi.kind) {
    case 'implement': case 'fix': case 'test': case 'doc': case 'custom': {
      await verifyDeliveredTask(wi, task, result);
      return;
    }
    case 'qa': {
      const findings = Array.isArray(j.findings) ? j.findings : [];
      const failed = j.decision === 'fail';
      const report = [`QA ${failed ? 'FAILED' : 'PASSED'}: ${[j.summary ?? result.summary, ...findings.map((f: any) => `- [${f.severity ?? '?'}/${f.kind ?? '?'}] ${f.message ?? ''}`)].join('\n')}`,
        ...(Array.isArray(j.criteria) ? j.criteria.map((c: any) => `- criterion ${c.met ? 'met' : 'NOT met'}: ${c.criterion ?? ''}`) : [])].join('\n');
      run('UPDATE tasks SET reviewer_agent_id = ? WHERE id = ?', usedAgentId, task.id);
      emit('qa.decided', getAgent(usedAgentId)?.name ?? 'qa', { taskId: task.id, decision: failed ? 'fail' : 'pass', findings: findings.length }, r.id, task.id);
      if (failed) setTaskMeta(task.id, 'qaFails', Number(task.meta?.qaFails ?? 0) + 1);
      graphAdvanceFrom(r, task, node, { status: failed ? 'failure' : 'success', verdict: failed ? 'fail' : 'pass', report }, wi.agentId);
      return;
    }
    case 'review': {
      const decision = j.decision === 'request-changes' ? 'request-changes' : 'approve';
      run('UPDATE tasks SET reviewer_agent_id = ? WHERE id = ?', usedAgentId, task.id);
      emit('review.decided', getAgent(usedAgentId)?.name ?? 'reviewer', { taskId: task.id, decision, notes: j.notes }, r.id, task.id);
      if (task.ownerAgentId) {
        postMessage({ runId: r.id, taskId: task.id, workItemId: wi.id, from: usedAgentId, to: task.ownerAgentId, kind: 'handoff',
          text: decision === 'approve' ? `Approved "${task.title}". ${j.notes ?? ''}`.trim() : `Changes requested on "${task.title}": ${j.notes ?? 'see review notes'}` });
      }
      if (decision !== 'approve' && j.notes) recordReviewerFlag({ workspaceId: r.workspaceId, repoId: r.repoId, flag: j.notes, files: task.affectedPaths });
      graphAdvanceFrom(r, task, node, { status: 'success', verdict: decision === 'approve' ? 'approve' : 'reject', report: `REVIEW ${decision === 'approve' ? 'PASSED' : 'FAILED'}: ${j.notes ?? ''}`, output: j }, wi.agentId);
      return;
    }
    case 'accept': {
      const accepted = j.decision === 'accept';
      if (accepted && j.commit?.title) setTaskMeta(task.id, 'commitProposal', { title: String(j.commit.title), body: String(j.commit.body ?? '') });
      emit('accept.decided', getAgent(usedAgentId)?.name ?? 'pm', { taskId: task.id, decision: accepted ? 'accept' : 'rework', notes: j.notes ?? null }, r.id, task.id);
      graphAdvanceFrom(r, task, node, { status: 'success', verdict: accepted ? 'approve' : 'reject', report: j.notes ?? '', output: j }, wi.agentId);
      return;
    }
    case 'prompt': {
      const draft = [j.brief, j.prompt, raw.text].find((x) => typeof x === 'string' && x.trim()) as string | undefined ?? '';
      const s = wfState(task);
      s.draft = { text: draft, approved: false, revision: (s.draft?.revision ?? 0) + 1 };
      saveWfState(task, s);
      emit('prompt.drafted', getAgent(usedAgentId)?.name ?? 'prompt', { taskId: task.id, nodeId: node?.id, revision: s.draft.revision }, r.id, task.id);
      graphAdvanceFrom(r, task, node, { status: 'success', output: j }, wi.agentId);
      return;
    }
    case 'prompt-review': {
      const approved = j.decision === 'approve';
      const s = wfState(task);
      if (approved && s.draft) { s.draft.approved = true; saveWfState(task, s); }
      emit('prompt.reviewed', getAgent(usedAgentId)?.name ?? 'pm', { taskId: task.id, decision: approved ? 'approve' : 'revise', notes: j.notes ?? null }, r.id, task.id);
      graphAdvanceFrom(r, task, node, { status: 'success', verdict: approved ? 'approve' : 'reject', output: j }, wi.agentId);
      return;
    }
    case 'analyse': {
      const pending = pendingAnalysis.get(wi.id);
      pendingAnalysis.delete(wi.id);
      if (pending) {
        const cr = q1('SELECT * FROM check_runs WHERE id = ?', pending.checkRunId);
        if (cr) {
          fileErrorReport({
            runId: r.id, cycleN: r.currentCycle, task, workItemId: wi.id,
            checkRun: { id: cr.id as string, checkId: cr.check_id as string, workItemId: cr.work_item_id as string | null, taskId: cr.task_id as string | null, runId: r.id, commitSha: cr.commit_sha as string | null, ref: cr.ref as string, status: cr.status as never, durationMs: cr.duration_ms as number, evidenceRefs: parseJson(cr.evidence_refs as string, []), summary: cr.summary as string, failures: parseJson(cr.failures as string, []), createdAt: cr.created_at as string },
            checkName: pending.checkName, checkCommand: (q1('SELECT command FROM checks WHERE id = ?', cr.check_id)?.command as string) ?? '',
            affectedFiles: pending.files, workspaceId: r.workspaceId,
            analyst: { title: j.title, suspectedCause: j.suspectedCause, steps: j.steps, suggestedFix: j.suggestedFix },
          });
        }
      }
      emit('task.analysed', getAgent(usedAgentId)?.name ?? 'analyst', { taskId: task.id }, r.id, task.id);
      graphAdvanceFrom(r, task, node, { status: 'success', output: j }, wi.agentId);
      return;
    }
    case 'diagnose': {
      // the strategy answer is advisory under a graph — the edges decide what
      // runs next; the diagnosis still lands on the task record
      emit('task.diagnosed', getAgent(usedAgentId)?.name ?? 'pm', { taskId: task.id, diagnosis: j.diagnosis ?? null, strategy: j.strategy ?? 'graph' }, r.id, task.id);
      graphAdvanceFrom(r, task, node, { status: 'success', output: j }, wi.agentId);
      return;
    }
    default: {
      graphAdvanceFrom(r, task, node, { status: 'success', output: j }, wi.agentId);
      return;
    }
  }
}

// Resume a task parked at a human gate or a spent loop after the owner
// decides. Called from the approval.decided wiring.
function graphResume(r: Run, task: Task, approved: boolean, approval?: { action: string; payload: Record<string, unknown>; id?: string }, feedback = ''): void {
  const s = wfState(task);
  const awaiting = s.awaiting;
  if (approval?.action === 'human.approval') { humanApprovalResume(r, task, approved, awaiting, approval.id ?? awaiting?.approvalId ?? '', feedback); return; }
  s.awaiting = undefined;
  // loop approval: approving allows one more pass on that edge — replay the
  // outcome that exhausted it so the same edge matches again
  if (approval?.action === 'workflow.loop') {
    if (!approved) {          // owner declined the extra pass — the loop stops
      emit('workflow.loop', 'engine', { taskId: task.id, edgeId: approval.payload?.edgeId, exhausted: true, stopped: 'owner' }, r.id, task.id);
      setTaskStatus(task.id, 'blocked', 'owner', { reason: 'loop limit declined by owner' });
      return;
    }
    const edgeId = approval.payload?.edgeId as string | undefined;
    if (edgeId) s.loops[edgeId] = Math.max(0, (s.loops[edgeId] ?? 0) - 1);
    saveWfState(task, s);
    const node = wfNode(graphFor(r)!.graph, awaiting?.nodeId ?? '');
    setTaskStatus(task.id, 'assigned', 'owner', { reason: 'loop bound extended' });
    graphAdvanceFrom(r, task, node, s.lastOutcome ?? { status: 'success' }, null);
    return;
  }
  saveWfState(task, s);
  const node = awaiting ? wfNode(graphFor(r)!.graph, awaiting.nodeId) : null;
  setTaskStatus(task.id, 'assigned', 'owner', { reason: approved ? 'gate approved' : 'gate rejected' });
  graphAdvanceFrom(r, task, node, { status: approved ? 'success' : 'reject', verdict: approved ? 'approve' : 'reject' }, null);
}

// Guardrail gate resume: approving lets the run continue past the limit —
// the task-scoped ceiling acks on the task, run-scoped ceilings on the run.
function graphGuardResume(r: Run, task: Task, approved: boolean): void {
  const s = wfState(task);
  const awaiting = s.awaiting;
  s.awaiting = undefined;
  if (!approved) {
    saveWfState(task, s);
    setTaskStatus(task.id, 'blocked', 'owner', { reason: 'guardrail — owner stopped the task' });
    return;
  }
  const why = awaiting?.guard ?? '';
  if (/graph steps/.test(why)) s.guardOk = [...new Set([...(s.guardOk ?? []), 'task-steps'])];
  else {
    const key = /cost ceiling/.test(why) ? 'cost' : /time ceiling/.test(why) ? 'time' : 'run-steps';
    wfRunGuardOk.set(r.id, new Set([...(wfRunGuardOk.get(r.id) ?? []), key]));
  }
  saveWfState(task, s);
  setTaskStatus(task.id, 'assigned', 'owner', { reason: 'guardrail acknowledged' });
  const node = awaiting ? wfNode(graphFor(r)!.graph, awaiting.nodeId) : null;
  if (node) graphEnter(r, getTask(task.id)!, node, null);
}

export function wireEngineEvents(): void {
  onEvent((e) => {
    // the owner saved a workflow: runs following it switch to the new version without disturbing work in flight
    if (e.type === 'workflow.saved' && e.payload.workflowId && e.payload.versionId) {
      try { adoptSavedVersion(String(e.payload.workflowId), String(e.payload.versionId)); } catch (err) { console.warn('[engine] adopting a saved workflow failed:', String(err).slice(0, 160)); }
      return;
    }
    if (e.type !== 'approval.decided') return;
    const decided = q1('SELECT * FROM approvals WHERE id = ?', e.payload.approvalId as string);
    if (!decided) return;
    const reason = String(e.payload.reason ?? '').trim();
    // The owner's answer to an agent's question goes back as a message.
    if (decided.action === 'agent.question') {
      postMessage({ runId: decided.run_id as string | null, taskId: decided.task_id as string | null, from: 'owner', to: decided.requested_by as string, kind: 'decision',
        text: e.payload.approved ? (reason || 'Approved — go ahead as you proposed.') : `No: ${reason}` });
      return;
    }
    if (decided.action === 'prompt.escalate' && decided.task_id) {
      const taskId = decided.task_id as string;
      const job = escalatedPrompts.get(taskId);
      escalatedPrompts.delete(taskId);
      const task = getTask(taskId);
      if (!task || task.status !== 'waiting-input') return;
      if (!job) { setTaskStatus(taskId, 'ready', 'owner', { reason: 'prompt re-prepared after restart' }); void maybeAdvanceRun(task.runId); return; }
      if (e.payload.approved) dispatchApprovedPrompt(job);
      else { setTaskStatus(taskId, 'assigned', 'owner'); startPromptDraft({ ...job, revision: 0, notes: `Owner: ${reason}` }); }
      return;
    }
    // workflow gates: human nodes, exhausted loops, dead ends, guardrails
    if (['workflow.human', 'human.approval', 'workflow.loop', 'workflow.deadend', 'workflow.guardrail'].includes(decided.action as string) && decided.task_id) {
      const task = getTask(decided.task_id as string);
      const rr = task ? getRun(task.runId) : null;
      if (!task || !rr || !graphFor(rr)) return;
      const s = wfState(task);
      if (s.awaiting?.kind === 'guard') { graphGuardResume(rr, task, !!e.payload.approved); void maybeAdvanceRun(rr.id); return; }
      if (s.awaiting) { graphResume(rr, task, !!e.payload.approved, { action: decided.action as string, payload: parseJson(decided.payload as string, {}), id: decided.id as string }, reason); void maybeAdvanceRun(rr.id); return; }
      if (s.deadEndNode && e.payload.approved) { setTaskStatus(task.id, 'ready', 'owner', { reason: 'dead-end retry approved' }); void maybeAdvanceRun(rr.id); return; }
      if (e.payload.approved && task.status === 'blocked') { setTaskStatus(task.id, 'ready', 'owner'); void maybeAdvanceRun(rr.id); }
      return;
    }
  });
  onEvent((e) => {
    if (e.type === 'approval.decided' && e.payload.approved) {
      const approval = q1('SELECT * FROM approvals WHERE id = ?', e.payload.approvalId as string);
      if (!approval || approval.action === 'agent.question' || approval.action === 'prompt.escalate' || approval.action === 'human.approval') return;
      if (approval.action === 'commit.task' && approval.task_id) {
        const p = parseJson<{ message?: string }>(approval.payload as string, {});
        commitTask(approval.task_id as string, p.message ?? '', true);
        return;
      }
      if (approval.action === 'dod.unmet' && approval.run_id) {
        // plan again with the evidence: reset the streak, resume, re-plan
        const rr = getRun(approval.run_id as string);
        if (rr) {
          run('UPDATE dod SET items = ? WHERE id = ?', JSON.stringify(dodItems(rr).map((i) => ({ ...i, cycleFails: 0 }))), rr.dodId);
          resumeRun(rr.id);
        }
        return;
      }
      if (approval.action === 'dod.approve' && approval.run_id) approveDod(approval.run_id as string);
      else if (approval.action === 'plan.escalate' && approval.run_id) {
        // Approving a failed plan means "retry it" — reset the counter and
        // re-dispatch. Without this the approval decided but the run stayed
        // stuck in draft.
        const runId = approval.run_id as string;
        planFailCount.delete(runId);
        const run = getRun(runId);
        if (run && !['done', 'stopped', 'failed'].includes(run.status)) void dispatchPlan(runId, run.status === 'draft');
      }
      else if (approval.action === 'plan.override' && approval.run_id) {
        const p = pendingPlanDiff.get(approval.run_id as string);
        if (p) { pendingPlanDiff.delete(approval.run_id as string); applyPlanDiff(p.runId, p.diff, 'pm'); void maybeAdvanceRun(p.runId); }
      } else if (approval.task_id) {
        const task = getTask(approval.task_id as string);
        if (task?.status === 'approved') void proceedMerge(task.id);
        else if (task?.status === 'blocked') { setTaskStatus(task.id, 'ready', 'owner'); void maybeAdvanceRun(task.runId); }
      }
    }
    if (e.type === 'approval.decided' && !e.payload.approved) {
      const approval = q1('SELECT * FROM approvals WHERE id = ?', e.payload.approvalId as string);
      if (approval?.action === 'agent.question' || approval?.action === 'prompt.escalate' || approval?.action === 'human.approval') return;
      if (approval?.action === 'commit.task') {
        if (approval.task_id) emit('commit.skipped', 'owner', { taskId: approval.task_id, reason: String(e.payload.reason ?? 'declined') }, approval.run_id as string, approval.task_id as string);
        return;
      }
      if (approval?.action === 'dod.unmet' && approval.run_id) { stopRun(approval.run_id as string, 'DOD_UNMET'); return; }
      if (approval?.action === 'plan.escalate' && approval.run_id) {
        // Owner declined to retry planning — the run can't proceed on its own.
        const run = getRun(approval.run_id as string);
        if (run && !['done', 'stopped', 'failed'].includes(run.status)) stopRun(run.id, 'PLAN_DECLINED');
        return;
      }
      if (approval?.task_id) {
        const task = getTask(approval.task_id as string);
        if (task && ['in-review', 'approved', 'verifying'].includes(task.status)) {
          setTaskStatus(task.id, 'changes-requested', 'owner', { reason: `approval rejected: ${e.payload.reason}` });
          dispatchFix(task, `Owner rejected ${approval.action}: ${e.payload.reason ?? ''}. Adjust the delivery.`, false);
        }
      }
    }
  });
}

export function startTimerLoop(): void {
  setInterval(() => {
    try { fireDueTimers(); } catch (e) { console.error('[engine] timer error', e); }
    try {
      for (const r of q(`SELECT id FROM runs WHERE status = 'running'`)) checkpoint(r.id as string);
    } catch { /* checkpoint best-effort */ }
  }, 15_000);
}
