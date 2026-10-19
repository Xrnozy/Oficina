// Workflow graphs: a per-task directed graph the engine can follow instead of
// the hard-coded pipeline (Phase 1: model + validation + CRUD, no behavior
// change). Stored as immutable versions so editing never rewrites a running
// run — runs record the workflow_version they were created with.
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import type { WorkItemKind } from '../types.ts';

export type NodeType = 'start' | 'agent' | 'condition' | 'merge' | 'human' | 'end';
export type EdgeKind = 'next' | 'on-success' | 'on-failure' | 'on-reject' | 'message';

// Deterministic condition (engine-evaluated, never a model): field/operator/
// value leaf, combined by and/or/not.
export interface WfCondition {
  field?: string;   // e.g. 'step.status', 'checks', 'files', 'verdict', 'attempts', 'task.type', 'task.difficulty', 'envelope.<key>'
  op?: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'matches' | 'truthy' | 'falsy';
  value?: unknown;
  and?: WfCondition[]; or?: WfCondition[]; not?: WfCondition;
}

export interface NodeConfig {
  purpose?: WorkItemKind | 'custom'; // the work-item kind this agent node dispatches
  scope?: 'task' | 'run';            // run-scope nodes (e.g. plan) execute once per run
  instructions?: string;
  modelTier?: 'fast' | 'standard' | 'strong';
  budgetChars?: number;
  timeoutMin?: number;
  writable?: boolean;                // writer (default true for code kinds) vs read-only
  inputs?: 'envelope' | 'full' | string[]; // what the prompt carries: handoff envelope, full previous output, or listed node outputs
  mergeMode?: 'all' | 'any';         // merge node wait policy
  inheritSkills?: boolean;           // 3b: also send agent/role skills (default true)
  skillsOnly?: boolean;              // 3b: send only node-attached skills
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

export interface WfGraph { nodes: WfNode[]; edges: WfEdge[]; }

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
      edge('e-qa-analyst', 'qa', 'analyst', 'on-failure'),
      edge('e-analyst-fix', 'analyst', 'fixer', 'next'),
      edge('e-fix-qa', 'fixer', 'qa', 'on-reject', { label: 're-verify', maxLoops: 3 }),
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
    if (n.type !== 'agent' && (n.agentId || n.role)) warn('non-agent node ignores agentId/role', n.id);
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
    if (n.type === 'merge' && graph.edges.filter((e) => e.to === n.id && e.kind !== 'message').length < 2)
      warn('merge node has fewer than two incoming branches', n.id);
    if (n.type === 'condition') {
      const outs = flowOutOf(n.id);
      const elses = outs.filter((e) => e.else);
      if (elses.length !== 1) err(`condition needs exactly one else edge, found ${elses.length}`, n.id);
      for (const e of outs) if (!e.else && !e.condition) err('conditional edge has no condition and is not else', n.id, e.id);
    }
  }

  // cycles: a back-edge (to a DFS ancestor) is legal only as on-failure /
  // on-reject — otherwise retries could loop forever. maxLoops defaults.
  const state = new Map<string, 'open' | 'done'>();
  const dfs = (id: string) => {
    state.set(id, 'open');
    for (const e of flowOutOf(id)) {
      const t = e.to;
      if (state.get(t) === 'open') {
        if (!LOOP_KINDS.includes(e.kind)) err(`cycle closed by "${e.kind}" edge — loops must close through on-failure/on-reject`, t, e.id);
        else if (e.maxLoops != null && e.maxLoops < 1) err('maxLoops must be at least 1', t, e.id);
      } else if (!state.get(t)) dfs(t);
    }
    state.set(id, 'done');
  };
  for (const s of starts) dfs(s.id);

  // referenced agents / roles exist (and the agent belongs to the workspace)
  const roles = new Set(q('SELECT id, name FROM roles').flatMap((r) => [r.id, r.name] as string[]));
  const members = workspaceId ? new Set(q('SELECT agent_id FROM memberships WHERE workspace_id = ? AND active = 1', workspaceId).map((m) => m.agent_id as string)) : null;
  for (const n of graph.nodes) {
    if (n.agentId) {
      const a = q1('SELECT id, name FROM agents WHERE id = ?', n.agentId);
      if (!a) err(`agent "${n.agentId}" does not exist`, n.id);
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
  emit('workflow.saved', 'owner', { workflowId, versionId: vId, n, note });
  return { version: { id: vId, workflowId, n, note, createdBy, createdAt: now() }, issues };
}

export function createWorkflow(wsId: string, name: string, description: string, graph?: WfGraph): { workflowId: string } | { error: string } {
  const g = graph ?? defaultWorkflowGraph();
  const issues = validateWorkflow(g, wsId);
  if (issues.some((i) => i.level === 'error')) return { error: 'validation failed: ' + issues.filter((i) => i.level === 'error').map((i) => i.message).join('; ') };
  const id = ulid(), vId = ulid();
  run(`INSERT INTO workflow_versions (id, workflow_id, n, graph, note, created_by, created_at) VALUES (?,?,1,?,?,'owner',?)`, vId, id, JSON.stringify(g), 'initial version', now());
  run(`INSERT INTO workflows (id, workspace_id, name, description, builtin, latest_version_id, created_at, updated_at) VALUES (?,?,?,?,0,?,?,?)`, id, wsId, name, description, vId, now(), now());
  emit('workflow.saved', 'owner', { workflowId: id, versionId: vId, n: 1, note: 'created' });
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
  emit('workflow.deleted', 'owner', { workflowId });
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
  emit('workflow.activated', 'owner', { workflowId, workspaceId: wsId });
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
