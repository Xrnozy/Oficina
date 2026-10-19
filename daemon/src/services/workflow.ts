// Workflow graphs: a per-task directed graph the engine can follow instead of
// the hard-coded pipeline (Phase 1: model + validation + CRUD, no behavior
// change). Stored as immutable versions so editing never rewrites a running
// run — runs record the workflow_version they were created with.
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import type { WorkItemKind } from '../types.ts';

// 'human' is the plain owner gate; 'approval' is Human approval: an agent prepares the app for the owner to test (launches it,
// opens the right screens, reads the logs, writes a report) and the owner then approves or rejects with feedback —
// approve follows the next/on-success edges, reject follows on-reject.
export type NodeType = 'start' | 'agent' | 'condition' | 'merge' | 'human' | 'approval' | 'end';
export type EdgeKind = 'next' | 'on-success' | 'on-failure' | 'on-reject' | 'message';

// Deterministic condition (engine-evaluated, never a model): field/operator/
// value leaf, combined by and/or/not.
export interface WfCondition {
  field?: string;   // e.g. 'step.status', 'checks', 'files', 'verdict', 'attempts', 'task.type', 'task.difficulty', 'envelope.<key>'
  op?: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'matches' | 'truthy' | 'falsy';
  value?: unknown;
  and?: WfCondition[]; or?: WfCondition[]; not?: WfCondition;
}

export interface ApprovalConfig {
  command?: string;           // how to start the app (empty = detect "dev"/"start" from package.json)
  cwd?: string;               // folder to start it in, relative to the repository
  url?: string;               // where it listens (empty = read from the app's output)
  readyTimeoutSec?: number;   // how long to wait for it to answer
  openBrowser?: boolean;      // open the first screen in the default browser (default true)
  routes?: string[];          // screens (paths like /login) the owner always wants offered, besides the agent's picks
}

export interface NodeConfig {
  approval?: ApprovalConfig;         // Human approval nodes only
  purpose?: WorkItemKind | 'custom'; // the work-item kind this agent node dispatches
  scope?: 'task' | 'run';            // run-scope nodes (e.g. plan) execute once per run
  instructions?: string;
  modelTier?: 'fast' | 'standard' | 'strong';
  budgetChars?: number;
  timeoutMin?: number;
  writable?: boolean;                // writer (default true for code kinds) vs read-only
  inputs?: 'envelope' | 'full' | string[]; // what the prompt carries: handoff envelope, full previous output, or listed node outputs
  mergeMode?: 'all' | 'any';         // merge node wait policy
  disabled?: boolean;                // bypassed: the engine passes through without dispatching
  inheritSkills?: boolean;           // 3b: also send agent/role skills (default true)
  skillsOnly?: boolean;              // 3b: send only node-attached skills
  skills?: { skillId: string; name: string; versionId?: string }[]; // 3b: skill refs attached to this node — stored in the version itself, so a run resolves the skills the version had when it was saved
}

export interface WfNode {
  id: string; type: NodeType; label: string;
  agentId?: string; role?: string;   // agent nodes pin an agent or name a role
  config?: NodeConfig;
  position: { x: number; y: number };
}

export interface WfEdge {
  id: string; from: string; to: string; kind: EdgeKind;
  label?: string; condition?: WfCondition; else?: boolean;
  maxLoops?: number;                 // loop-closing edges only (default 3)
  waitForReply?: boolean; timeoutMin?: number; // 'message' edges
}

export interface WfGuardrails {
  maxStepsPerTask?: number;   // agent dispatches one task may take through the graph
  maxStepsPerRun?: number;    // agent dispatches across the whole run
  costCeilingUsd?: number;    // stop dispatching when recorded spend passes this
  timeCeilingMin?: number;    // stop dispatching when the run is older than this
}

export interface WfGraph { nodes: WfNode[]; edges: WfEdge[]; guardrails?: WfGuardrails; }

export interface WfIssue { level: 'error' | 'warning'; nodeId?: string; edgeId?: string; message: string; }

const FLOW: EdgeKind[] = ['next', 'on-success', 'on-failure', 'on-reject'];
const LOOP_KINDS: EdgeKind[] = ['on-failure', 'on-reject'];
const WRITER_PURPOSES = new Set(['implement', 'fix', 'doc', 'custom']);
export const DEFAULT_MAX_LOOPS = 3;

const edge = (id: string, from: string, to: string, kind: EdgeKind, extra: Partial<WfEdge> = {}): WfEdge =>
  ({ id, from, to, kind, ...extra });
const anode = (id: string, label: string, role: string, purpose: NodeConfig['purpose'], x: number, y: number, config: NodeConfig = {}): WfNode =>
  ({ id, type: 'agent', label, role, config: { purpose, ...config }, position: { x, y } });

// The built-in graph reproduces today's fixed pipeline one-to-one: pm plans,
// the Prompt Creator drafts, the PM reviews (send-back loop), the developer
// implements, QA verifies (analyst→fix loop on failure), the reviewer reviews
// (changes-requested loop), the PM accepts (send-back loop), then end.
export function defaultWorkflowGraph(): WfGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Request', position: { x: 0, y: 120 } },
      anode('pm-plan', 'PM · Plan', 'pm', 'plan', 160, 120, { scope: 'run' }),
      anode('pc-draft', 'Prompt Creator · Draft', 'prompt-creator', 'prompt', 340, 120, { writable: false }),
      anode('pm-review', 'PM · Review prompt', 'pm', 'prompt-review', 520, 120, { writable: false }),
      anode('dev', 'Developer · Implement', 'developer', 'implement', 700, 120),
      anode('qa', 'QA · Verify', 'qa', 'qa', 880, 60, { writable: false }),
      anode('analyst', 'Analyst · Diagnose', 'analyst', 'analyse', 880, 240, { writable: false }),
      anode('fixer', 'Developer · Fix', 'developer', 'fix', 1060, 240),
      anode('reviewer', 'Reviewer', 'reviewer', 'review', 1060, 60, { writable: false }),
      anode('pm-accept', 'PM · Accept', 'pm', 'accept', 1240, 120, { writable: false }),
      { id: 'end', type: 'end', label: 'Done', position: { x: 1420, y: 120 } },
    ],
    edges: [
      edge('e-start-plan', 'start', 'pm-plan', 'next'),
      edge('e-plan-draft', 'pm-plan', 'pc-draft', 'next'),
      edge('e-draft-review', 'pc-draft', 'pm-review', 'next'),
      edge('e-review-back', 'pm-review', 'pc-draft', 'on-reject', { label: 'send back', maxLoops: 3 }),
      edge('e-review-dev', 'pm-review', 'dev', 'next'),
      edge('e-dev-qa', 'dev', 'qa', 'next'),
      edge('e-dev-analyst', 'dev', 'analyst', 'on-failure', { label: 'checks failed' }),
      edge('e-qa-analyst', 'qa', 'analyst', 'on-failure', { maxLoops: 3 }),
      edge('e-analyst-fix', 'analyst', 'fixer', 'next'),
      edge('e-fix-qa', 'fixer', 'qa', 'next', { label: 're-verify' }),
      edge('e-fix-analyst', 'fixer', 'analyst', 'on-failure', { maxLoops: 3 }),
      edge('e-qa-rev', 'qa', 'reviewer', 'on-success'),
      edge('e-rev-dev', 'reviewer', 'dev', 'on-reject', { label: 'changes requested', maxLoops: 3 }),
      edge('e-rev-accept', 'reviewer', 'pm-accept', 'next'),
      edge('e-accept-dev', 'pm-accept', 'dev', 'on-reject', { label: 'send back', maxLoops: 2 }),
      edge('e-accept-end', 'pm-accept', 'end', 'on-success'),
    ],
  };
}

// ---------- validation ----------

export function validateWorkflow(graph: WfGraph, workspaceId?: string): WfIssue[] {
  const issues: WfIssue[] = [];
  const err = (message: string, nodeId?: string, edgeId?: string) => issues.push({ level: 'error', nodeId, edgeId, message });
  const warn = (message: string, nodeId?: string, edgeId?: string) => issues.push({ level: 'warning', nodeId, edgeId, message });
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return [{ level: 'error', message: 'graph must have nodes and edges' }];

  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (!n.id || ids.has(n.id)) err(`duplicate or missing node id "${n.id}"`, n.id);
    ids.add(n.id);
    if (n.type === 'agent' && !n.agentId && !n.role) err('agent node needs an agentId or a role', n.id);
    if (n.type === 'approval' && !n.agentId && !n.role) err('a Human approval node needs an agent connected to it (pick an agent or a role): it prepares the app and writes the report you review', n.id);
    if (n.type !== 'agent' && n.type !== 'approval' && (n.agentId || n.role)) warn('non-agent node ignores agentId/role', n.id);
    if (n.type === 'approval' && (n.role === 'pm' || n.role === 'prompt-creator')) err('the PM and the Prompt Creator orchestrate only — connect a QA, analyst, reviewer or developer agent to run and inspect the app', n.id);
    if (n.type === 'approval' && n.config?.approval?.url && !/^https?:\/\//i.test(n.config.approval.url)) err('the app URL must start with http:// or https://', n.id);
    if (n.type === 'approval' && n.config?.approval?.readyTimeoutSec != null && !(n.config.approval.readyTimeoutSec >= 3 && n.config.approval.readyTimeoutSec <= 300)) err('the app start timeout must be between 3 and 300 seconds', n.id);
    if (n.config?.disabled && n.type === 'agent') warn(`node "${n.label}" is bypassed — the engine will pass through it without dispatching`, n.id);
    if (n.config?.disabled && n.type !== 'agent') warn(`"disabled" only bypasses agent nodes — "${n.label}" still runs`, n.id);
  }
  const eids = new Set<string>();
  const out = new Map<string, WfEdge[]>();
  const flowOut = new Map<string, WfEdge[]>();
  for (const e of graph.edges) {
    if (!e.id || eids.has(e.id)) err(`duplicate or missing edge id "${e.id}"`, undefined, e.id);
    eids.add(e.id);
    if (!ids.has(e.from)) err(`edge from unknown node "${e.from}"`, undefined, e.id);
    if (!ids.has(e.to)) err(`edge to unknown node "${e.to}"`, undefined, e.id);
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    if (e.kind !== 'message') (flowOut.get(e.from) ?? flowOut.set(e.from, []).get(e.from)!).push(e);
  }
  const flowOutOf = (id: string) => flowOut.get(id) ?? [];

  // exactly one start; ends exist and are reachable
  const starts = graph.nodes.filter((n) => n.type === 'start');
  if (starts.length !== 1) err(`exactly one start node required, found ${starts.length}`);
  const ends = graph.nodes.filter((n) => n.type === 'end');
  if (ends.length === 0) err('at least one end node required');
  const seen = new Set<string>();
  const stack = starts.length ? [starts[0].id] : [];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of flowOutOf(id)) stack.push(e.to);
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) err(`node "${n.id}" is not reachable from start`, n.id);
  if (ends.length && !ends.some((e) => seen.has(e.id))) err('no path from start to any end node');
  for (const n of graph.nodes) {
    if (n.type === 'start' && !flowOutOf(n.id).length) err('start has no outgoing edge', n.id);
    if (n.type === 'end' && flowOutOf(n.id).length) err('end node must not have outgoing edges', n.id);
    if (n.type === 'approval') {
      const outs = flowOutOf(n.id);
      if (!outs.some((e) => e.kind === 'next' || e.kind === 'on-success')) err('a Human approval node needs an approve path: an outgoing next / on-success edge', n.id);
      if (!outs.some((e) => e.kind === 'on-reject')) warn('rejecting has nowhere to go — add an on-reject edge to the agent that should investigate and fix, or a rejection will stop the task', n.id);
    }
    if (n.type === 'merge' && graph.edges.filter((e) => e.to === n.id && e.kind !== 'message').length < 2)
      warn('merge node has fewer than two incoming branches', n.id);
    if (n.type === 'condition') {
      const outs = flowOutOf(n.id);
      const elses = outs.filter((e) => e.else);
      if (elses.length !== 1) err(`condition needs exactly one else edge, found ${elses.length}`, n.id);
      for (const e of outs) if (!e.else && !e.condition) err('conditional edge has no condition and is not else', n.id, e.id);
    }
  }

  // cycles: a loop is legal only when the cycle passes through an
  // on-failure/on-reject edge — that edge's maxLoops is the bound, so a retry
  // loop can never spin forever. A cycle of plain next edges is an error.
  const state = new Map<string, 'open' | 'done'>();
  const nodeStack: string[] = [];
  const edgeStack: WfEdge[] = [];
  const reported = new Set<string>();
  const dfs = (id: string) => {
    state.set(id, 'open');
    nodeStack.push(id);
    for (const e of flowOutOf(id)) {
      edgeStack.push(e);
      const t = e.to;
      if (state.get(t) === 'open') {
        const i = nodeStack.indexOf(t);
        const cycleEdges = [...edgeStack.slice(i), e];
        if (!cycleEdges.some((x) => LOOP_KINDS.includes(x.kind))) {
          const key = cycleEdges.map((x) => x.id).sort().join(',');
          if (!reported.has(key)) { reported.add(key); err(`cycle through "${t}" has no on-failure/on-reject edge — loops must carry a bounded retry edge`, t, e.id); }
        }
      } else if (!state.get(t)) dfs(t);
      edgeStack.pop();
    }
    nodeStack.pop();
    state.set(id, 'done');
  };
  for (const s of starts) dfs(s.id);
  for (const e of graph.edges) if (LOOP_KINDS.includes(e.kind) && e.maxLoops != null && e.maxLoops < 1) err('maxLoops must be at least 1', e.to, e.id);

  // referenced agents / roles exist (and the agent belongs to the workspace)
  const roles = new Set(q('SELECT id, name FROM roles').flatMap((r) => [r.id, r.name] as string[]));
  const members = workspaceId ? new Set(q('SELECT agent_id FROM memberships WHERE workspace_id = ? AND active = 1', workspaceId).map((m) => m.agent_id as string)) : null;
  for (const n of graph.nodes) {
    if (n.agentId) {
      const a = q1('SELECT id, name FROM agents WHERE id = ?', n.agentId);
      // a pinned agent that was deleted is a warning, not an error — the
      // graph stays structurally valid so Routing can flag the broken step
      // (the engine dead-ends on it and asks the owner at run time)
      if (!a) warn(`agent "${n.agentId}" does not exist — was it deleted?`, n.id);
      else if (members && !members.has(n.agentId)) warn(`${a.name} is not a member of this workspace`, n.id);
    }
    if (n.role && !roles.has(n.role)) err(`role "${n.role}" does not exist`, n.id);
  }

  // separation of duties: the same pinned agent must not write and review —
  // matching the runtime rule that a task's reviewer differs from its author.
  const writers = new Set<string>();
  const reviewers = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== 'agent' || !n.agentId) continue;
    const p = n.config?.purpose;
    if (p && WRITER_PURPOSES.has(p) && n.config?.writable !== false) writers.add(n.agentId);
    if (p === 'review') reviewers.add(n.agentId);
  }
  for (const id of writers) if (reviewers.has(id)) err('the same agent cannot be the only writer and the reviewer (separation of duties)', undefined);

  // node skill refs (3b): report unknown / disabled / still-unreviewed skills —
  // warnings, not errors: at dispatch an undeliverable skill is simply skipped
  for (const n of graph.nodes) {
    for (const ref of n.config?.skills ?? []) {
      const s = q1('SELECT id, name, enabled, owner_origin FROM skills WHERE id = ?', ref.skillId);
      if (!s) { warn(`node "${n.label}" references skill "${ref.name || ref.skillId}", which is not in this office — import or create it`, n.id); continue; }
      if (!s.enabled) { warn(`skill "${s.name}" on "${n.label}" is disabled — it will not be delivered`, n.id); continue; }
      if (s.owner_origin === 'imported' && !q1(`SELECT id FROM skill_versions WHERE skill_id = ? AND review_status = 'approved'`, s.id as string)) {
        warn(`imported skill "${s.name}" on "${n.label}" is waiting for approval`, n.id);
      }
    }
  }

  return issues;
}

export function validationSummary(issues: WfIssue[]): { ok: boolean; errors: string[]; warnings: string[] } {
  return {
    ok: !issues.some((i) => i.level === 'error'),
    errors: issues.filter((i) => i.level === 'error').map((i) => `${i.nodeId ?? i.edgeId ?? 'graph'}: ${i.message}`),
    warnings: issues.filter((i) => i.level === 'warning').map((i) => `${i.nodeId ?? i.edgeId ?? 'graph'}: ${i.message}`),
  };
}

// ---------- storage ----------

export interface WorkflowRow { id: string; workspaceId: string; name: string; description: string; builtin: boolean; latestVersionId: string | null; createdAt: string; updatedAt: string; }
export interface WorkflowVersionRow { id: string; workflowId: string; n: number; note: string; createdBy: string; createdAt: string; }

const rowToWorkflow = (r: Record<string, unknown>): WorkflowRow => ({
  id: r.id as string, workspaceId: r.workspace_id as string, name: r.name as string,
  description: r.description as string, builtin: !!r.builtin,
  latestVersionId: r.latest_version_id as string | null,
  createdAt: r.created_at as string, updatedAt: r.updated_at as string,
});
export const rowToVersion = (r: Record<string, unknown>): WorkflowVersionRow => ({
  id: r.id as string, workflowId: r.workflow_id as string, n: r.n as number,
  note: r.note as string, createdBy: r.created_by as string, createdAt: r.created_at as string,
});

export function getWorkflow(id: string): { workflow: WorkflowRow; versions: WorkflowVersionRow[]; graph: WfGraph | null } | null {
  const w = q1('SELECT * FROM workflows WHERE id = ?', id);
  if (!w) return null;
  const versions = q('SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY n', id).map(rowToVersion);
  const latest = w.latest_version_id ? q1('SELECT graph FROM workflow_versions WHERE id = ?', w.latest_version_id as string) : null;
  return { workflow: rowToWorkflow(w), versions, graph: latest ? parseJson<WfGraph>(latest.graph as string, { nodes: [], edges: [] }) : null };
}

export function getWorkflowVersion(versionId: string): { version: WorkflowVersionRow; graph: WfGraph } | null {
  const v = q1('SELECT * FROM workflow_versions WHERE id = ?', versionId);
  return v ? { version: rowToVersion(v), graph: parseJson<WfGraph>(v.graph as string, { nodes: [], edges: [] }) } : null;
}

const BUILTIN_ID = (wsId: string) => `wf-builtin-${wsId}`;

// Every workspace gets one read-only builtin workflow mirroring the fixed
// pipeline; the owner clones it to customise. Created lazily on first read.
export function ensureBuiltinWorkflow(wsId: string): void {
  if (q1('SELECT id FROM workflows WHERE id = ?', BUILTIN_ID(wsId))) return;
  const wfId = BUILTIN_ID(wsId);
  const vId = ulid();
  run(`INSERT INTO workflow_versions (id, workflow_id, n, graph, note, created_by, created_at) VALUES (?,?,?,?,?,'system',?)`,
    vId, wfId, 1, JSON.stringify(defaultWorkflowGraph()), 'built-in default pipeline', now());
  run(`INSERT INTO workflows (id, workspace_id, name, description, builtin, latest_version_id, created_at, updated_at) VALUES (?,?,?,?,1,?,?,?)`,
    wfId, wsId, 'Default pipeline', 'The standard office flow — read-only; clone to customise.', vId, now(), now());
}

export function listWorkflows(wsId: string): (WorkflowRow & { versionN: number | null; active: boolean })[] {
  ensureBuiltinWorkflow(wsId);
  const active = activeWorkflowId(wsId);
  return q('SELECT * FROM workflows WHERE workspace_id = ? ORDER BY builtin DESC, updated_at DESC', wsId).map((r) => {
    const w = rowToWorkflow(r);
    const v = w.latestVersionId ? q1('SELECT n FROM workflow_versions WHERE id = ?', w.latestVersionId) : null;
    return { ...w, versionN: (v?.n as number) ?? null, active: w.id === active };
  });
}

export function saveWorkflowVersion(workflowId: string, graph: WfGraph, note: string, createdBy = 'owner'): { version: WorkflowVersionRow; issues: WfIssue[] } | { error: string } {
  const w = q1('SELECT * FROM workflows WHERE id = ?', workflowId);
  if (!w) return { error: 'not found' };
  if (w.builtin) return { error: 'the built-in workflow is read-only — clone it to edit' };
  const issues = validateWorkflow(graph, w.workspace_id as string);
  if (issues.some((i) => i.level === 'error')) return { error: 'validation failed', issues } as never;
  const n = ((q1('SELECT MAX(n) m FROM workflow_versions WHERE workflow_id = ?', workflowId)?.m as number) ?? 0) + 1;
  const vId = ulid();
  run(`INSERT INTO workflow_versions (id, workflow_id, n, graph, note, created_by, created_at) VALUES (?,?,?,?,?,?,?)`, vId, workflowId, n, JSON.stringify(graph), note, createdBy, now());
  run('UPDATE workflows SET latest_version_id = ?, updated_at = ? WHERE id = ?', vId, now(), workflowId);
  const prev = w.latest_version_id ? getWorkflowVersion(w.latest_version_id as string)?.graph : null;
  emit('workflow.saved', createdBy === 'system' ? 'system' : 'owner',
    { workflowId, versionId: vId, n, note, by: createdBy, changes: prev ? graphDiff(prev, graph) : 'initial version' }, null, workflowId);
  return { version: { id: vId, workflowId, n, note, createdBy, createdAt: now() }, issues };
}

export function createWorkflow(wsId: string, name: string, description: string, graph?: WfGraph): { workflowId: string } | { error: string } {
  const g = graph ?? defaultWorkflowGraph();
  const issues = validateWorkflow(g, wsId);
  if (issues.some((i) => i.level === 'error')) return { error: 'validation failed: ' + issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ') };
  const id = ulid(), vId = ulid();
  run(`INSERT INTO workflow_versions (id, workflow_id, n, graph, note, created_by, created_at) VALUES (?,?,1,?,?,'owner',?)`, vId, id, JSON.stringify(g), 'initial version', now());
  run(`INSERT INTO workflows (id, workspace_id, name, description, builtin, latest_version_id, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?)`, id, wsId, name, description, vId, now(), now());
  emit('workflow.saved', 'owner', { workflowId: id, versionId: vId, n: 1, note: 'created', by: 'owner', changes: 'created' }, null, id);
  return { workflowId: id };
}

export function cloneWorkflow(workflowId: string, name?: string): { workflowId: string } | { error: string } {
  const src = getWorkflow(workflowId);
  if (!src) return { error: 'not found' };
  return createWorkflow(src.workflow.workspaceId, name ?? `${src.workflow.name} (copy)`, src.workflow.description, src.graph ?? undefined);
}

export function deleteWorkflow(workflowId: string): { ok: true } | { error: string } {
  const w = q1('SELECT * FROM workflows WHERE id = ?', workflowId);
  if (!w) return { error: 'not found' };
  if (w.builtin) return { error: 'the built-in workflow cannot be deleted' };
  if (activeWorkflowId(w.workspace_id as string) === workflowId) return { error: 'deactivate the workflow before deleting it' };
  const used = q1(`SELECT r.id FROM runs r JOIN workflow_versions v ON v.id = r.workflow_version_id WHERE v.workflow_id = ? LIMIT 1`, workflowId);
  if (used) return { error: 'a run was created with this workflow — keep it for the record' };
  run('DELETE FROM workflow_versions WHERE workflow_id = ?', workflowId);
  run('DELETE FROM workflows WHERE id = ?', workflowId);
  emit('workflow.deleted', 'owner', { workflowId, name: w.name }, null, workflowId);
  return { ok: true };
}

// The active workflow pointer lives in workspace settings — like approvalMode.
export function activeWorkflowId(wsId: string): string | null {
  const s = q1('SELECT settings FROM workspaces WHERE id = ?', wsId);
  const id = parseJson<Record<string, unknown>>(s?.settings as string, {}).activeWorkflowId;
  return typeof id === 'string' ? id : null;
}

export function setActiveWorkflow(wsId: string, workflowId: string | null): { ok: true } | { error: string } {
  const w = q1('SELECT * FROM workspaces WHERE id = ?', wsId);
  if (!w) return { error: 'workspace not found' };
  if (workflowId && !q1('SELECT id FROM workflows WHERE id = ? AND workspace_id = ?', workflowId, wsId)) return { error: 'workflow not found in this workspace' };
  const settings = parseJson<Record<string, unknown>>(w.settings as string, {});
  if (workflowId) settings.activeWorkflowId = workflowId; else delete settings.activeWorkflowId;
  run('UPDATE workspaces SET settings = ? WHERE id = ?', JSON.stringify(settings), wsId);
  emit('workflow.activated', 'owner', { workflowId, workspaceId: wsId, name: workflowId ? (q1('SELECT name FROM workflows WHERE id = ?', workflowId)?.name ?? null) : null }, null, workflowId);
  return { ok: true };
}

// What the engine asks for at run creation: the active workflow's latest
// graph + the immutable version id the run will record.
export function activeWorkflowFor(wsId: string): { workflowId: string; versionId: string; graph: WfGraph } | null {
  const id = activeWorkflowId(wsId);
  if (!id) return null;
  const w = q1('SELECT latest_version_id FROM workflows WHERE id = ?', id);
  if (!w?.latest_version_id) return null;
  const v = getWorkflowVersion(w.latest_version_id as string);
  return v ? { workflowId: id, versionId: v.version.id, graph: v.graph } : null;
}

// Latest saved version of one workflow (for pinning a run to a chosen workflow).
export function latestVersionOf(workflowId: string): { workflowId: string; versionId: string; graph: WfGraph } | null {
  const w = q1('SELECT latest_version_id FROM workflows WHERE id = ?', workflowId);
  if (!w?.latest_version_id) return null;
  const v = getWorkflowVersion(w.latest_version_id as string);
  return v ? { workflowId, versionId: v.version.id, graph: v.graph } : null;
}

// ---------- Phase 4: templates, estimates, referenced-by, audit ----------

// What changed between two versions — recorded on the audit event.
function graphDiff(a: WfGraph, b: WfGraph): string {
  const an = new Map(a.nodes.map((n) => [n.id, n])); const bn = new Map(b.nodes.map((n) => [n.id, n]));
  const added = [...bn.keys()].filter((id) => !an.has(id));
  const removed = [...an.keys()].filter((id) => !bn.has(id));
  const changed = [...bn.keys()].filter((id) => an.has(id) && JSON.stringify({ ...an.get(id)!, position: undefined }) !== JSON.stringify({ ...bn.get(id)!, position: undefined }));
  const ae = new Set(a.edges.map((e) => e.id)); const be = new Set(b.edges.map((e) => e.id));
  const eAdded = [...be].filter((id) => !ae.has(id)).length; const eRemoved = [...ae].filter((id) => !be.has(id)).length;
  const parts = [
    added.length && `+${added.length} node${added.length > 1 ? 's' : ''} (${added.join(', ')})`,
    removed.length && `-${removed.length} node${removed.length > 1 ? 's' : ''} (${removed.join(', ')})`,
    changed.length && `${changed.length} changed`,
    (eAdded || eRemoved) && `edges +${eAdded}/-${eRemoved}`,
  ].filter(Boolean);
  return parts.join('; ') || 'positions only';
}

// ---------- ready-made templates ----------

const snode = (id: string, label: string, type: WfNode['type'], x: number, y: number): WfNode => ({ id, type, label, position: { x, y } });

export function workflowTemplates(): { id: string; name: string; description: string; graph: WfGraph }[] {
  const fast: WfGraph = {
    nodes: [snode('start', 'Request', 'start', 0, 120), anode('dev', 'Developer', 'developer', 'implement', 180, 120),
      anode('rev', 'Reviewer', 'reviewer', 'review', 400, 120, { writable: false }),
      anode('accept', 'PM · Accept', 'pm', 'accept', 620, 120, { writable: false }), snode('end', 'Done', 'end', 840, 120)],
    edges: [edge('e1', 'start', 'dev', 'next'), edge('e2', 'dev', 'rev', 'on-success'), edge('e3', 'rev', 'dev', 'on-reject', { maxLoops: 2 }),
      edge('e4', 'rev', 'accept', 'on-success'), edge('e5', 'accept', 'dev', 'on-reject', { maxLoops: 2 }), edge('e6', 'accept', 'end', 'on-success')],
  };
  const strict: WfGraph = {
    nodes: [snode('start', 'Request', 'start', 0, 120), anode('dev', 'Developer', 'developer', 'implement', 180, 120),
      anode('qa', 'QA', 'qa', 'qa', 400, 60, { writable: false }),
      anode('sec', 'Security review', 'reviewer', 'review', 620, 120, { writable: false, instructions: 'Review for security issues only: injection, secrets, unsafe dependencies, auth gaps.' }),
      anode('rev', 'Code review', 'reviewer', 'review', 840, 60, { writable: false }),
      anode('accept', 'PM · Accept', 'pm', 'accept', 1060, 120, { writable: false }), snode('end', 'Done', 'end', 1280, 120)],
    edges: [edge('e1', 'start', 'dev', 'next'), edge('e2', 'dev', 'qa', 'on-success'), edge('e3', 'qa', 'dev', 'on-failure', { maxLoops: 3 }),
      edge('e4', 'qa', 'sec', 'on-success'), edge('e5', 'sec', 'dev', 'on-reject', { maxLoops: 2 }),
      edge('e6', 'sec', 'rev', 'on-success'), edge('e7', 'rev', 'dev', 'on-reject', { maxLoops: 2 }),
      edge('e8', 'rev', 'accept', 'on-success'), edge('e9', 'accept', 'dev', 'on-reject', { maxLoops: 2 }), edge('e10', 'accept', 'end', 'on-success')],
  };
  const docs: WfGraph = {
    nodes: [snode('start', 'Request', 'start', 0, 120), anode('docs', 'Docs writer', 'docs', 'doc', 180, 120),
      anode('accept', 'PM · Accept', 'pm', 'accept', 400, 120, { writable: false }), snode('end', 'Done', 'end', 620, 120)],
    edges: [edge('e1', 'start', 'docs', 'next'), edge('e2', 'docs', 'accept', 'on-success'),
      edge('e3', 'accept', 'docs', 'on-reject', { maxLoops: 2 }), edge('e4', 'accept', 'end', 'on-success')],
  };
  const bugfix: WfGraph = {
    nodes: [snode('start', 'Request', 'start', 0, 120), anode('an', 'Analyst · Diagnose', 'analyst', 'analyse', 180, 120, { writable: false }),
      anode('dev', 'Developer · Fix', 'developer', 'fix', 400, 120), anode('qa', 'QA', 'qa', 'qa', 620, 120, { writable: false }),
      anode('accept', 'PM · Accept', 'pm', 'accept', 840, 120, { writable: false }), snode('end', 'Done', 'end', 1060, 120)],
    edges: [edge('e1', 'start', 'an', 'next'), edge('e2', 'an', 'dev', 'next'), edge('e3', 'dev', 'qa', 'on-success'),
      edge('e4', 'qa', 'an', 'on-failure', { maxLoops: 3 }), edge('e5', 'qa', 'accept', 'on-success'),
      edge('e6', 'accept', 'dev', 'on-reject', { maxLoops: 2 }), edge('e7', 'accept', 'end', 'on-success')],
  };
  const parallel: WfGraph = {
    nodes: [snode('start', 'Request', 'start', 0, 120), anode('dev', 'Developer', 'developer', 'implement', 180, 120),
      anode('rev-a', 'Reviewer A', 'reviewer', 'review', 400, 40, { writable: false }),
      anode('rev-b', 'Reviewer B (security)', 'reviewer', 'review', 400, 200, { writable: false, instructions: 'Focus on security and edge cases.' }),
      snode('join', 'Both reviews', 'merge', 620, 120),
      anode('accept', 'PM · Accept', 'pm', 'accept', 840, 120, { writable: false }), snode('end', 'Done', 'end', 1060, 120)],
    edges: [edge('e1', 'start', 'dev', 'next'), edge('e2', 'dev', 'rev-a', 'on-success'), edge('e3', 'dev', 'rev-b', 'on-success'),
      edge('e4', 'rev-a', 'join', 'next'), edge('e5', 'rev-b', 'join', 'next'),
      edge('e6', 'rev-a', 'dev', 'on-reject', { maxLoops: 2 }), edge('e7', 'rev-b', 'dev', 'on-reject', { maxLoops: 2 }),
      edge('e8', 'join', 'accept', 'next'), edge('e9', 'accept', 'dev', 'on-reject', { maxLoops: 2 }), edge('e10', 'accept', 'end', 'on-success')],
    guardrails: {},
  };
  // the default pipeline with the owner's hands-on test before the PM accepts: an agent launches the app and prepares a report,
  // the owner approves or rejects; a rejection goes to the analyst (with the owner's feedback and the app's logs), then the
  // developer fixes it and it comes back through QA and review to the owner again.
  const approvalGraph = defaultWorkflowGraph();
  approvalGraph.nodes = approvalGraph.nodes.map((n) => (n.id === 'pm-accept' ? { ...n, position: { x: 1600, y: 120 } } : n.id === 'end' ? { ...n, position: { x: 1780, y: 120 } } : n));
  approvalGraph.nodes.push({ id: 'human-approval', type: 'approval', label: 'Human approval', role: 'qa', config: { approval: { openBrowser: true } }, position: { x: 1420, y: 120 } });
  approvalGraph.edges = approvalGraph.edges.filter((e) => e.id !== 'e-rev-accept');
  approvalGraph.edges.push(
    edge('e-rev-approval', 'reviewer', 'human-approval', 'next'),
    edge('e-approval-accept', 'human-approval', 'pm-accept', 'on-success', { label: 'approved' }),
    edge('e-approval-reject', 'human-approval', 'analyst', 'on-reject', { label: 'rejected — investigate', maxLoops: 3 }),
  );
  return [
    { id: 'default', name: 'Default pipeline', description: 'The full office flow: plan, prompt draft + review, implement, verify, review, accept.', graph: defaultWorkflowGraph() },
    { id: 'human-approval', name: 'With human approval', description: 'The default pipeline plus a test-it-yourself step: an agent launches the app on the right screen and reports; you approve or reject with feedback, and a rejection is investigated and fixed.', graph: approvalGraph },
    { id: 'fast', name: 'Fast path', description: 'Developer then reviewer — no plan or QA stage. For small, clear tasks.', graph: fast },
    { id: 'strict', name: 'Strict', description: 'Implement, QA, a security reviewer, a code reviewer, then accept. For risky changes.', graph: strict },
    { id: 'docs', name: 'Docs only', description: 'Docs writer then PM accept. For documentation tasks.', graph: docs },
    { id: 'bugfix', name: 'Bug-fix', description: 'Analyst diagnoses, developer fixes, QA verifies, PM accepts.', graph: bugfix },
    { id: 'parallel', name: 'Parallel review', description: 'Two reviewers run side by side and merge before the PM accepts.', graph: parallel },
  ];
}

// ---------- worst-case call estimate ----------

// Upper bound of model calls per task: every agent node once, plus each
// loop edge letting its cycle body re-run up to its bound. Parallel
// branches add, they don't multiply. Human gates are approvals, not calls.
export function estimateWorkflowCalls(graph: WfGraph): { minCalls: number; maxCalls: number; humanGates: number; skillChars: number } {
  const g = graph;
  const reachable = new Set<string>();
  {
    const start = g.nodes.find((n) => n.type === 'start');
    const stack = start ? [start.id] : [];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const e of g.edges) if (e.from === id && e.kind !== 'message') stack.push(e.to);
    }
  }
  const agentNodes = g.nodes.filter((n) => (n.type === 'agent' || n.type === 'approval') && reachable.has(n.id) && !n.config?.disabled && (n.config?.scope ?? 'task') === 'task');
  const taskScoped = agentNodes.length;
  const runScoped = g.nodes.filter((n) => n.type === 'agent' && reachable.has(n.id) && !n.config?.disabled && n.config?.scope === 'run').length;
  const humans = g.nodes.filter((n) => (n.type === 'human' || n.type === 'approval') && reachable.has(n.id)).length;
  // each loop edge's cycle body can re-run up to its bound. The body is the
  // nodes reachable from e.to that can also reach e.from — both endpoints
  // included, since each pass re-enters e.to and re-arrives at e.from.
  let loopExtra = 0;
  for (const e of g.edges.filter((x) => x.kind === 'on-failure' || x.kind === 'on-reject')) {
    const cap = e.maxLoops ?? DEFAULT_MAX_LOOPS;
    const fwd = new Set<string>(); const stack = [e.to];
    while (stack.length) {
      const id = stack.pop()!;
      if (fwd.has(id)) continue;
      fwd.add(id);
      for (const x of g.edges) if (x.from === id && x.kind !== 'message') stack.push(x.to);
    }
    const rev = new Set<string>(); const back = [e.from];
    while (back.length) {
      const id = back.pop()!;
      if (rev.has(id)) continue;
      rev.add(id);
      for (const x of g.edges) if (x.to === id && x.kind !== 'message') back.push(x.from);
    }
    loopExtra += cap * [...fwd].filter((id) => rev.has(id) && reachable.has(id) && ['agent', 'approval'].includes(g.nodes.find((x) => x.id === id)?.type ?? '') && !g.nodes.find((x) => x.id === id)?.config?.disabled).length;
  }
  // node skill text the prompts may carry (approved version sizes)
  let skillChars = 0;
  for (const n of agentNodes) {
    for (const ref of n.config?.skills ?? []) {
      const v = ref.versionId
        ? q1(`SELECT LENGTH(content) c FROM skill_versions WHERE id = ? AND review_status = 'approved'`, ref.versionId)
        : q1(`SELECT LENGTH(content) c FROM skill_versions WHERE skill_id = ? AND review_status = 'approved' ORDER BY created_at DESC LIMIT 1`, ref.skillId);
      skillChars += (v?.c as number) ?? 0;
    }
  }
  return { minCalls: Math.min(taskScoped + runScoped, Math.max(1, taskScoped + runScoped)), maxCalls: taskScoped + runScoped + loopExtra, humanGates: humans, skillChars };
}

// ---------- referenced-by warnings ----------

// The effective graph each workspace runs: its active custom workflow, else
// the built-in. Used to warn before firing/editing a referenced agent/role.
export function workflowRefsFor(opts: { agentId?: string; roleName?: string }): { workflowId: string; workflowName: string; nodes: { id: string; label: string }[] }[] {
  const out: { workflowId: string; workflowName: string; nodes: { id: string; label: string }[] }[] = [];
  for (const ws of q('SELECT id FROM workspaces')) {
    const eff = activeWorkflowFor(ws.id as string) ?? (() => {
      ensureBuiltinWorkflow(ws.id as string);
      const w = q1('SELECT id, latest_version_id FROM workflows WHERE id = ?', BUILTIN_ID(ws.id as string));
      const v = w?.latest_version_id ? getWorkflowVersion(w.latest_version_id as string) : null;
      return v ? { workflowId: w!.id as string, graph: v.graph } : null;
    })();
    if (!eff) continue;
    const name = (q1('SELECT name FROM workflows WHERE id = ?', eff.workflowId)?.name as string) ?? eff.workflowId;
    const nodes = eff.graph.nodes.filter((n) =>
      (opts.agentId && n.agentId === opts.agentId) || (opts.roleName && n.role === opts.roleName));
    if (nodes.length) out.push({ workflowId: eff.workflowId, workflowName: name, nodes: nodes.map((n) => ({ id: n.id, label: n.label })) });
  }
  return out;
}

// Audit log for one workflow — events are already hash-chained.
export function workflowAudit(workflowId: string, limit = 20): { ts: string; type: string; actor: string; payload: Record<string, unknown> }[] {
  return q(`SELECT ts, type, actor, payload FROM events WHERE entity_id = ? ORDER BY seq DESC LIMIT ?`, workflowId, limit)
    .map((e) => ({ ts: e.ts as string, type: e.type as string, actor: e.actor as string, payload: parseJson(e.payload as string, {}) }));
}

// ---------- routing view ---------------------------------------------------
// The Routing page renders exactly what the active workflow graph says — the
// same graph the engine walks, flattened into ordered rows: steps in flow
// order, fan-outs as labeled lanes, back-edges as loop chips, message edges as
// envelope links. Editing a node here writes the graph (a new version), so
// Routing and the Workflow inspector can never disagree.

export interface RoutingEdgeRef { edgeId: string; toNodeId: string; toLabel: string; label: string | null; kind: EdgeKind; maxLoops: number | null }
export interface RoutingStep {
  nodeId: string; type: NodeType; label: string;
  purpose: string | null; scope: 'task' | 'run';
  role: string | null; agentId: string | null;
  agents: { id: string; name: string; avatar: string | null; status: string }[];
  modelTier: 'fast' | 'standard' | 'strong' | null; budgetChars: number | null;
  disabled: boolean; warnings: string[];
  loops: RoutingEdgeRef[];     // edges back to an already-rendered step (retry loops, rejoins)
  exits: RoutingEdgeRef[];     // edges into a sibling lane's territory (cross-references)
  messages: RoutingEdgeRef[];  // message edges leaving this step
}
export type RoutingRow =
  | { kind: 'step'; step: RoutingStep }
  | { kind: 'back'; toNodeId: string; toLabel: string }
  | { kind: 'branches'; viaNodeId: string; lanes: { edgeId: string; label: string; isElse: boolean; rows: RoutingRow[] }[] };

export interface RoutingView {
  workflow: { id: string; name: string; versionN: number | null; builtin: boolean; active: boolean };
  preview?: boolean;        // showing an unsaved editor draft, not the saved version
  custom: boolean;          // a non-builtin workflow is active
  issues: WfIssue[];
  fallback: boolean;        // the active graph has errors — rows show the default pipeline
  rows: RoutingRow[];       // the flow strip
  agentNodes: RoutingStep[];// the ACTIVE graph's agent nodes, flow order — the model panels
  notInWorkflow: { id: string; name: string; avatar: string | null; status: string; roles: string[] }[];
}

const COND_FIELD_LABEL: Record<string, string> = {
  'step.status': 'step status', 'step.verdict': 'reviewer verdict', 'checks': 'checks', 'files': 'files changed',
  'attempts': 'attempts', 'task.type': 'task type', 'task.difficulty': 'task difficulty', 'task.paths': 'task paths',
};
const COND_OP_LABEL: Record<string, string> = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥', contains: 'contains', matches: 'matches', truthy: 'is set', falsy: 'is empty' };

export function wfCondText(c: WfCondition | undefined): string {
  if (!c) return '';
  if (c.and?.length) return c.and.map(wfCondText).join(' and ');
  if (c.or?.length) return c.or.map(wfCondText).join(' or ');
  if (c.not) return `not (${wfCondText(c.not)})`;
  const f = COND_FIELD_LABEL[c.field ?? ''] ?? c.field ?? '?';
  if (c.op === 'truthy') return `${f} is set`;
  if (c.op === 'falsy') return `${f} is empty`;
  return `${f} ${COND_OP_LABEL[c.op ?? 'eq'] ?? c.op ?? '='} ${String(c.value ?? '?')}`;
}

const EDGE_KIND_HINT: Record<EdgeKind, string> = { next: 'then', 'on-success': 'on success', 'on-failure': 'on failure', 'on-reject': 'on reject', message: 'message' };

// Flatten the flow rows into the ordered list of agent steps (panels).
export function flattenAgentSteps(rows: RoutingRow[]): RoutingStep[] {
  const out: RoutingStep[] = [];
  const walk = (rs: RoutingRow[]) => {
    for (const r of rs) {
      if (r.kind === 'step' && (r.step.type === 'agent' || r.step.type === 'approval')) out.push(r.step);
      if (r.kind === 'branches') for (const l of r.lanes) walk(l.rows);
    }
  };
  walk(rows);
  return out;
}

// Rendered graph → rows. `stop` nodes are lane heads reserved by sibling
// lanes (plus the block's join) — an edge into one is a cross-reference, not
// a path this lane follows. A lane ends where it rejoins a rendered node.
export function flowRowsFor(g: WfGraph, decorate?: (n: WfNode) => Pick<RoutingStep, 'agents' | 'warnings'>): { rows: RoutingRow[]; rendered: Set<string> } {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const flowOut = (id: string) => g.edges.filter((e) => e.from === id && e.kind !== 'message');
  const rendered = new Set<string>();
  const rows: RoutingRow[] = [];

  const laneLabel = (e: WfEdge) => e.else ? 'otherwise' : e.label ?? (e.condition ? `if ${wfCondText(e.condition)}` : EDGE_KIND_HINT[e.kind]);

  // The merge point all lanes of a fan-out reach: the shallowest unrendered
  // node in every lane's lane-local reachable set (lanes don't cross into
  // rendered nodes, stop nodes or sibling heads — reachability mirrors that).
  const joinFor = (edges: WfEdge[], stop: Set<string>): string | null => {
    const heads = new Set(edges.map((e) => e.to));
    const reach = (from: string): Map<string, number> => {
      const d = new Map<string, number>([[from, 0]]);
      const stack = [from];
      while (stack.length) {
        const id = stack.pop()!;
        for (const e of flowOut(id)) {
          if (d.has(e.to) || rendered.has(e.to) || stop.has(e.to)) continue;
          if (heads.has(e.to) && e.to !== from) continue;
          d.set(e.to, d.get(id)! + 1);
          stack.push(e.to);
        }
      }
      return d;
    };
    const maps = edges.map((e) => reach(e.to));
    let best: string | null = null; let score = Infinity;
    for (const id of maps[0]?.keys() ?? []) {
      if (rendered.has(id) || stop.has(id) || heads.has(id)) continue;
      if (!maps.every((m) => m.has(id))) continue;
      const s = Math.max(...maps.map((m) => m.get(id)!));
      if (s < score) { score = s; best = id; }
    }
    return best;
  };

  const stepFor = (n: WfNode, stop: Set<string>): RoutingStep => {
    const ref = (e: WfEdge): RoutingEdgeRef => ({
      edgeId: e.id, toNodeId: e.to, toLabel: byId.get(e.to)?.label ?? e.to, kind: e.kind,
      label: e.label ?? (e.condition ? `if ${wfCondText(e.condition)}` : null),
      maxLoops: e.maxLoops ?? (LOOP_KINDS.includes(e.kind) ? DEFAULT_MAX_LOOPS : null),
    });
    const loops: RoutingEdgeRef[] = []; const exits: RoutingEdgeRef[] = []; const messages: RoutingEdgeRef[] = [];
    for (const e of g.edges.filter((x) => x.from === n.id)) {
      if (e.kind === 'message') messages.push(ref(e));
      else if (rendered.has(e.to)) loops.push(ref(e));
      else if (stop.has(e.to)) exits.push(ref(e));
    }
    const deco = decorate?.(n) ?? { agents: [], warnings: [] };
    return {
      nodeId: n.id, type: n.type, label: n.label,
      purpose: n.config?.purpose ?? null, scope: n.config?.scope ?? 'task',
      role: n.role ?? null, agentId: n.agentId ?? null, agents: deco.agents,
      modelTier: n.config?.modelTier ?? null, budgetChars: n.config?.budgetChars ?? null,
      disabled: !!n.config?.disabled, warnings: deco.warnings, loops, exits, messages,
    };
  };

  const walk = (firstId: string, stop: Set<string>, out: RoutingRow[]): void => {
    let cur: string | null = firstId;
    while (cur && !rendered.has(cur) && !stop.has(cur)) {
      const n = byId.get(cur);
      if (!n) return;
      rendered.add(cur);
      out.push({ kind: 'step', step: stepFor(n, stop) });
      const uniq = [...new Map(flowOut(n.id).filter((e) => !rendered.has(e.to) && !stop.has(e.to)).map((e) => [e.to, e] as const)).values()];
      if (!uniq.length) return;
      if (uniq.length === 1) { cur = uniq[0].to; continue; }
      const join = joinFor(uniq, stop);
      const heads = new Set(uniq.map((e) => e.to));
      const lanes = uniq.map((e) => {
        const laneRows: RoutingRow[] = [];
        walk(e.to, new Set([...stop, ...heads, ...(join ? [join] : [])].filter((id) => id !== e.to)), laneRows);
        if (!laneRows.length) laneRows.push({ kind: 'back', toNodeId: e.to, toLabel: byId.get(e.to)?.label ?? e.to });
        return { edgeId: e.id, label: laneLabel(e), isElse: !!e.else, rows: laneRows };
      });
      out.push({ kind: 'branches', viaNodeId: n.id, lanes });
      cur = join;
    }
    // the lane ran into an earlier step — show the rejoin arrow
    if (cur && rendered.has(cur)) out.push({ kind: 'back', toNodeId: cur, toLabel: byId.get(cur)?.label ?? cur });
  };

  const start = g.nodes.find((n) => n.type === 'start');
  if (start) walk(start.id, new Set(), rows);
  return { rows, rendered };
}

// The effective workflow for a workspace: the active custom one, else the
// built-in default pipeline. Routing follows the saved version only — a
// Workflow draft is localStorage until it is saved.
// graphOverride: an unsaved draft from the editor, shown as a preview (Routing stays in step with the canvas before it is saved)
export function routingView(wsId: string, forWorkflowId?: string | null, graphOverride?: WfGraph | null): RoutingView {
  ensureBuiltinWorkflow(wsId);
  const activeId = activeWorkflowId(wsId);
  // any saved workflow can be viewed (the page's selector, or the one a run is pinned to)
  const picked = forWorkflowId ? getWorkflow(forWorkflowId) : null;
  const active = picked && picked.workflow.workspaceId === wsId ? picked : activeId ? getWorkflow(activeId) : null;
  const shown = active ?? getWorkflow(BUILTIN_ID(wsId))!;
  const graph = graphOverride ?? shown?.graph ?? defaultWorkflowGraph();
  const wf = shown!.workflow;
  const versionN = wf.latestVersionId ? ((q1('SELECT n FROM workflow_versions WHERE id = ?', wf.latestVersionId)?.n as number) ?? null) : null;
  const custom = !!active && !wf.builtin;

  const membersByAgent = new Map<string, { id: string; name: string; avatar: string | null; status: string; roles: string[] }>();
  for (const m of q(`SELECT a.id, a.name, a.avatar, a.status, r.name AS rname FROM memberships m
                    JOIN agents a ON a.id = m.agent_id JOIN roles r ON r.id = m.role_id
                    WHERE m.workspace_id = ? AND m.active = 1`, wsId)) {
    const a = membersByAgent.get(m.id as string) ?? { id: m.id as string, name: m.name as string, avatar: m.avatar as string | null, status: m.status as string, roles: [] };
    a.roles.push(m.rname as string);
    membersByAgent.set(m.id as string, a);
  }

  const decorate = (n: WfNode): Pick<RoutingStep, 'agents' | 'warnings'> => {
    const warnings: string[] = [];
    let agents: RoutingStep['agents'] = [];
    if (n.type !== 'agent' && n.type !== 'approval') return { agents, warnings };
    if (n.agentId) {
      const a = q1('SELECT id, name, avatar, status FROM agents WHERE id = ?', n.agentId);
      if (!a) warnings.push('the pinned agent was deleted');
      else {
        agents = [{ id: a.id as string, name: a.name as string, avatar: a.avatar as string | null, status: a.status as string }];
        if (!membersByAgent.has(a.id as string)) warnings.push(`${a.name} is not an active member of this workspace`);
      }
    } else if (n.role) {
      agents = [...membersByAgent.values()].filter((x) => x.roles.includes(n.role!)).map(({ id, name, avatar, status }) => ({ id, name, avatar, status }));
      if (!agents.length) warnings.push(`no agent holds the "${n.role}" role`);
    }
    return { agents, warnings };
  };

  const issues = validateWorkflow(graph, wsId);
  const broken = issues.some((i) => i.level === 'error');
  // the flow strip falls back to the default pipeline when the active graph
  // can't run; the model panels below still track the active graph itself so
  // the broken nodes stay editable
  const display = flowRowsFor(broken ? (getWorkflow(BUILTIN_ID(wsId))!.graph ?? defaultWorkflowGraph()) : graph, decorate);
  const live = flowRowsFor(graph, decorate);

  const agentNodes = flattenAgentSteps(live.rows);
  // nodes nothing can reach stay visible — the warning names the problem
  for (const n of graph.nodes) {
    if ((n.type === 'agent' || n.type === 'approval') && !live.rendered.has(n.id)) {
      const s = decorate(n);
      agentNodes.push({
        nodeId: n.id, type: n.type, label: n.label, purpose: n.config?.purpose ?? null, scope: n.config?.scope ?? 'task',
        role: n.role ?? null, agentId: n.agentId ?? null, agents: s.agents,
        modelTier: n.config?.modelTier ?? null, budgetChars: n.config?.budgetChars ?? null, disabled: !!n.config?.disabled,
        warnings: [...s.warnings, 'not reachable from start'], loops: [], exits: [], messages: [],
      });
    }
  }
  const inWorkflow = (agentId: string, roles: string[]) =>
    agentNodes.some((n) => n.agentId === agentId || (n.role && roles.includes(n.role)));
  return {
    workflow: { id: wf.id, name: wf.name, versionN, builtin: wf.builtin, active: wf.id === activeId || (!activeId && wf.builtin) },
    custom, issues, fallback: broken, preview: !!graphOverride,
    rows: display.rows,
    agentNodes,
    notInWorkflow: [...membersByAgent.values()].filter((a) => !inWorkflow(a.id, a.roles)),
  };
}

// Routing writes node routing config the same place the inspector does —
// node.config inside a new immutable version.
export function patchNodeRouting(workflowId: string, nodeId: string, patch: { modelTier?: 'fast' | 'standard' | 'strong' | null; budgetChars?: number | null; disabled?: boolean | null }): { ok: true } | { error: string } {
  const w = getWorkflow(workflowId);
  if (!w?.graph) return { error: 'not found' };
  if (w.workflow.builtin) return { error: 'the built-in workflow is read-only — clone it to edit' };
  const node = w.graph.nodes.find((n) => n.id === nodeId);
  if (!node) return { error: 'node not found' };
  const cfg: NodeConfig = { ...(node.config ?? {}) };
  if ('modelTier' in patch) { if (patch.modelTier) cfg.modelTier = patch.modelTier; else delete cfg.modelTier; }
  if ('budgetChars' in patch) { if (patch.budgetChars) cfg.budgetChars = patch.budgetChars; else delete cfg.budgetChars; }
  if ('disabled' in patch) { if (patch.disabled) cfg.disabled = true; else delete cfg.disabled; }
  const graph: WfGraph = { ...w.graph, nodes: w.graph.nodes.map((n) => (n.id === nodeId ? { ...n, config: cfg } : n)) };
  const r = saveWorkflowVersion(workflowId, graph, `routing: ${node.label}`, 'owner');
  return 'error' in r ? r : { ok: true };
}

// "Add to workflow" from Routing: pin the agent on a node spliced onto the
// last flow edge into `end` (or after the last reachable agent node when no
// such edge exists — validation names anything still unreachable).
export function addNodeForAgent(workflowId: string, agentId: string): { ok: true; nodeId: string } | { error: string } {
  const w = getWorkflow(workflowId);
  if (!w?.graph) return { error: 'not found' };
  if (w.workflow.builtin) return { error: 'the built-in workflow is read-only — clone it to edit' };
  const a = q1('SELECT id, name FROM agents WHERE id = ?', agentId);
  if (!a) return { error: 'agent not found' };
  const role = q1(`SELECT r.name FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.agent_id = ? AND m.workspace_id = ? AND m.active = 1`, agentId, w.workflow.workspaceId)?.name as string | undefined;
  const g: WfGraph = JSON.parse(JSON.stringify(w.graph));
  const id = `n-${ulid().toLowerCase().slice(-10)}`;
  const ends = g.nodes.filter((n) => n.type === 'end');
  const intoEnd = g.edges.filter((e) => e.kind !== 'message' && ends.some((x) => x.id === e.to));
  const host = intoEnd[intoEnd.length - 1];
  const from = host ? g.nodes.find((n) => n.id === host.from) : [...g.nodes].reverse().find((n) => n.type === 'agent');
  const to = host ? ends.find((n) => n.id === host.to)! : ends[0];
  if (!from || !to) return { error: 'no step to attach to — place the node in Workflow' };
  const node: WfNode = {
    id, type: 'agent', label: a.name as string, agentId, role,
    config: { purpose: 'custom' },
    position: { x: Math.round(((from.position?.x ?? 0) + (to.position?.x ?? 400)) / 2), y: Math.round(((from.position?.y ?? 0) + (to.position?.y ?? 0)) / 2) + 60 },
  };
  g.nodes.push(node);
  if (host) host.to = id;
  else g.edges.push({ id: `e-${id}`, from: from.id, to: id, kind: 'next' });
  g.edges.push({ id: `e-${id}-out`, from: id, to: to.id, kind: 'next' });
  const r = saveWorkflowVersion(workflowId, g, `add ${a.name} to the flow`, 'owner');
  return 'error' in r ? r : { ok: true, nodeId: id };
}
