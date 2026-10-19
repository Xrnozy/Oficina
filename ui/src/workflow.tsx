// Shared types + pure helpers for the Workflow page — mirrors
// daemon/src/services/workflow.ts. Keep the shapes identical.

export type WfNodeType = 'start' | 'agent' | 'condition' | 'merge' | 'human' | 'approval' | 'end';
export type WfEdgeKind = 'next' | 'on-success' | 'on-failure' | 'on-reject' | 'message';

export interface WfCondition {
  field?: string;
  op?: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'matches' | 'truthy' | 'falsy';
  value?: unknown;
  and?: WfCondition[]; or?: WfCondition[]; not?: WfCondition;
}

// Human approval: an agent starts the app and writes a report, then you approve or reject it.
export interface WfApprovalConfig {
  command?: string; cwd?: string; url?: string; readyTimeoutSec?: number; openBrowser?: boolean; routes?: string[];
}

export interface WfNodeConfig {
  approval?: WfApprovalConfig;
  purpose?: string;
  scope?: 'task' | 'run';
  instructions?: string;
  modelTier?: 'fast' | 'standard' | 'strong';
  budgetChars?: number;
  timeoutMin?: number;
  writable?: boolean;
  inputs?: 'envelope' | 'full' | string[];
  mergeMode?: 'all' | 'any';
  inheritSkills?: boolean;
  skillsOnly?: boolean;
  skills?: { skillId: string; name: string; versionId?: string }[];
  disabled?: boolean;
}

export interface WfNode {
  id: string; type: WfNodeType; label: string;
  agentId?: string; role?: string;
  config?: WfNodeConfig;
  position: { x: number; y: number };
}

export interface WfEdge {
  id: string; from: string; to: string; kind: WfEdgeKind;
  label?: string; condition?: WfCondition; else?: boolean;
  maxLoops?: number; waitForReply?: boolean; timeoutMin?: number;
}

export interface WfGuardrails {
  maxStepsPerTask?: number; maxStepsPerRun?: number; costCeilingUsd?: number; timeCeilingMin?: number;
}
export interface WfGraph { nodes: WfNode[]; edges: WfEdge[]; guardrails?: WfGuardrails; }

export interface WfEstimate { minCalls: number; maxCalls: number; humanGates: number; skillChars: number; }
export interface WfSimStep { n: number; nodeId: string; label: string; type: string; viaEdgeId?: string; note?: string; }
export interface WfSimResult {
  steps: WfSimStep[]; takenEdges: string[]; calls: number; humanGates: number;
  loopsUsed: Record<string, number>; result: 'end' | 'dead-end' | 'max-steps'; notes: string[];
}
export interface WfTemplate { id: string; name: string; description: string; graph: WfGraph; }
export interface WfAuditRow { ts: string; type: string; actor: string; payload: Record<string, unknown>; }

export interface WfIssue { level: 'error' | 'warning'; nodeId?: string; edgeId?: string; message: string; }

export interface WfValidation { ok: boolean; errors: string[]; warnings: string[]; issues: WfIssue[]; }

// ---------- routing view (Routing page renders this — the same graph) ----------

export interface RoutingEdgeRef { edgeId: string; toNodeId: string; toLabel: string; label: string | null; kind: WfEdgeKind; maxLoops: number | null; }
export interface RoutingStep {
  nodeId: string; type: WfNodeType; label: string;
  purpose: string | null; scope: 'task' | 'run';
  role: string | null; agentId: string | null;
  agents: { id: string; name: string; avatar: string | null; status: string }[];
  modelTier: 'fast' | 'standard' | 'strong' | null; budgetChars: number | null;
  disabled: boolean; warnings: string[];
  loops: RoutingEdgeRef[]; exits: RoutingEdgeRef[]; messages: RoutingEdgeRef[];
}
export type RoutingRow =
  | { kind: 'step'; step: RoutingStep }
  | { kind: 'back'; toNodeId: string; toLabel: string }
  | { kind: 'branches'; viaNodeId: string; lanes: { edgeId: string; label: string; isElse: boolean; rows: RoutingRow[] }[] };
export interface RoutingView {
  workflow: { id: string; name: string; versionN: number | null; builtin: boolean; active: boolean };
  custom: boolean; issues: WfIssue[]; fallback: boolean; preview?: boolean;
  rows: RoutingRow[]; agentNodes: RoutingStep[];
  notInWorkflow: { id: string; name: string; avatar: string | null; status: string; roles: string[] }[];
}

export interface WorkflowRow {
  id: string; workspaceId: string; name: string; description: string;
  builtin: boolean; latestVersionId: string | null; versionN?: number | null; active?: boolean; intakeAgentId?: string | null;
  createdAt: string; updatedAt: string;
}

export interface WorkflowVersionRow { id: string; workflowId: string; n: number; note: string; createdBy: string; createdAt: string; }

// ---------- vocab ----------

export const PURPOSES = ['plan', 'prompt', 'prompt-review', 'implement', 'qa', 'review', 'analyse', 'fix', 'doc', 'test', 'accept', 'diagnose', 'custom'] as const;
export const EDGE_KINDS: { kind: WfEdgeKind; hint: string }[] = [
  { kind: 'next', hint: 'always continue' },
  { kind: 'on-success', hint: 'only on a successful step' },
  { kind: 'on-failure', hint: 'only after failure — a bounded loop edge' },
  { kind: 'on-reject', hint: 'only on reject/changes-requested — a bounded loop edge' },
  { kind: 'message', hint: 'deliver a message, no work item' },
];

// short names for the legend and for lines without a label of their own
export const EDGE_SHORT: Record<WfEdgeKind, string> = {
  next: 'Continue', 'on-success': 'If it succeeds', 'on-failure': 'If it fails', 'on-reject': 'Send back', message: 'Message',
};

export const COND_FIELDS: { field: string; label: string }[] = [
  { field: 'step.status', label: 'step status' },
  { field: 'step.verdict', label: 'reviewer verdict' },
  { field: 'checks', label: 'checks' },
  { field: 'files', label: 'files changed' },
  { field: 'attempts', label: 'attempts' },
  { field: 'task.type', label: 'task type' },
  { field: 'task.difficulty', label: 'task difficulty' },
  { field: 'task.paths', label: 'task paths' },
];

export const COND_OPS: { op: NonNullable<WfCondition['op']>; label: string }[] = [
  { op: 'eq', label: '=' }, { op: 'ne', label: '≠' },
  { op: 'lt', label: '<' }, { op: 'le', label: '≤' },
  { op: 'gt', label: '>' }, { op: 'ge', label: '≥' },
  { op: 'contains', label: 'contains' }, { op: 'matches', label: 'matches' },
  { op: 'truthy', label: 'is set' }, { op: 'falsy', label: 'is empty' },
];

// ---------- plain-language condition preview ----------

function leafText(c: WfCondition): string {
  const field = COND_FIELDS.find((f) => f.field === c.field)?.label ?? c.field ?? '?';
  if (c.op === 'truthy') return `${field} is set`;
  if (c.op === 'falsy') return `${field} is empty`;
  const op = COND_OPS.find((o) => o.op === c.op)?.label ?? c.op ?? '=';
  return `${field} ${op} ${String(c.value ?? '?')}`;
}

export function condText(c: WfCondition | undefined): string {
  if (!c) return '';
  const inner = (x: WfCondition): string => {
    if (x.and?.length) return x.and.map(inner).join(' and ');
    if (x.or?.length) return x.or.map(inner).join(' or ');
    if (x.not) return `not (${inner(x.not)})`;
    return leafText(x);
  };
  return inner(c);
}

// ---------- graph helpers ----------

export const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;

export function emptyGraph(): WfGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', label: 'Request', position: { x: 40, y: 140 } },
      { id: 'end', type: 'end', label: 'Done', position: { x: 460, y: 140 } },
    ],
    edges: [{ id: uid('e'), from: 'start', to: 'end', kind: 'next' }],
  };
}

// Split an edge in the middle: a→new keeps the original kind/condition/else,
// new→b continues as 'next'. Returns the new graph.
export function insertOnEdge(g: WfGraph, edgeId: string, node: WfNode): WfGraph {
  const e = g.edges.find((x) => x.id === edgeId);
  if (!e) return g;
  const half: WfEdge = { id: uid('e'), from: node.id, to: e.to, kind: 'next' };
  return {
    nodes: [...g.nodes, node],
    edges: [...g.edges.filter((x) => x.id !== edgeId), { ...e, to: node.id }, half],
  };
}

// Delete a node; when it sat mid-chain (one flow edge in, one out) splice the
// neighbours together so dragging a node out re-links the pipeline.
export function spliceOut(g: WfGraph, nodeId: string): WfGraph {
  const ins = g.edges.filter((e) => e.to === nodeId && e.kind !== 'message');
  const outs = g.edges.filter((e) => e.from === nodeId && e.kind !== 'message');
  const others = g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  // only a simple chain node (one in, one out) gets a bridge — for a node
  // with several in/out edges any re-link is a guess, so neighbours are
  // left disconnected for the owner (and validation) to see
  const bridged = ins.length === 1 && outs.length === 1
    ? [...others, { id: uid('e'), from: ins[0].from, to: outs[0].to, kind: ins[0].kind, condition: ins[0].condition, else: ins[0].else, label: ins[0].label }]
    : others;
  return { nodes: g.nodes.filter((n) => n.id !== nodeId), edges: bridged };
}

// Layered left-to-right layout: longest-path layering from start, ordered
// within a layer by the average row of their sources. No dependencies.
export function layoutLR(g: WfGraph): WfGraph {
  const layer = new Map<string, number>();
  const start = g.nodes.find((n) => n.type === 'start') ?? g.nodes[0];
  if (!start) return g;
  // A retry / send-back line points backwards in the flow: it must not push its target to the right.
  // Rank nodes by shortest path from Start, then drop loop lines that return to an earlier-or-equal rank.
  const rank = new Map<string, number>([[start.id, 0]]);
  for (let queue = [start.id]; queue.length;) {
    const id = queue.shift()!;
    for (const e of g.edges) if (e.from === id && e.kind !== 'message' && !rank.has(e.to)) { rank.set(e.to, rank.get(id)! + 1); queue.push(e.to); }
  }
  const isBack = (e: WfEdge) => (e.kind === 'on-reject' || e.kind === 'on-failure') && (rank.get(e.to) ?? 1e9) <= (rank.get(e.from) ?? -1);
  const fwd = g.edges.filter((e) => e.kind !== 'message' && e.from !== e.to && !isBack(e));
  // longest path over the remaining (acyclic) lines
  for (const n of g.nodes) layer.set(n.id, 0);
  for (let pass = 0; pass < g.nodes.length; pass++) {
    let changed = false;
    for (const e of fwd) {
      const want = (layer.get(e.from) ?? 0) + 1;
      if (want > (layer.get(e.to) ?? 0)) { layer.set(e.to, want); changed = true; }
    }
    if (!changed) break;
  }
  const layers = new Map<number, WfNode[]>();
  for (const n of g.nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const GX = 300; const GY = 190;
  const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
  // initial order within each layer, then two barycenter sweeps
  const order = new Map<number, string[]>();
  for (const [l, ns] of sortedLayers) order.set(l, ns.map((n) => n.id));
  const rowOf = new Map<string, number>();
  for (const [, ids] of order) ids.forEach((id, i) => rowOf.set(id, i));
  for (let sweep = 0; sweep < 3; sweep++) {
    for (const [l, ids] of order) {
      if (!ids.length) continue;
      const scored = ids.map((id) => {
        const ins = fwd.filter((e) => e.to === id);
        const b = ins.length ? ins.reduce((a, e) => a + (rowOf.get(e.from) ?? 0), 0) / ins.length : rowOf.get(id) ?? 0;
        return { id, b };
      });
      scored.sort((a, b2) => a.b - b2.b);
      order.set(l, scored.map((s) => s.id));
      scored.forEach((s, i) => rowOf.set(s.id, i));
    }
  }
  // A long flow folds into rows (left to right, then right to left) so the whole thing fits on screen
  // instead of stretching into one line that has to be zoomed out until nothing is readable.
  const cols = sortedLayers.length <= 6 ? sortedLayers.length : 5;
  const rowsOf: number[][] = [];
  sortedLayers.forEach(([l], i) => { (rowsOf[Math.floor(i / cols)] ??= []).push(l); });
  let top = 40;
  rowsOf.forEach((layersInRow, r) => {
    const tallest = Math.max(...layersInRow.map((l) => order.get(l)?.length ?? 1));
    layersInRow.forEach((l, c) => {
      const ids = order.get(l) ?? [];
      const col = r % 2 ? cols - 1 - c : c;
      ids.forEach((id, i) => pos.set(id, { x: col * GX + 40, y: top + (i + (tallest - ids.length) / 2) * GY }));
    });
    top += tallest * GY + (r < rowsOf.length - 1 ? 70 : 0);
  });
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
}

// Edge midpoint in flow coords — used for drop-onto-edge hit testing.
export function edgeMid(g: WfGraph, e: WfEdge): { x: number; y: number } | null {
  const a = g.nodes.find((n) => n.id === e.from); const b = g.nodes.find((n) => n.id === e.to);
  if (!a || !b) return null;
  return { x: (a.position.x + b.position.x) / 2 + 100, y: (a.position.y + b.position.y) / 2 + 40 };
}

// Nearest edge within `radius` px of a flow point (excluding edges touching a node).
export function nearestEdge(g: WfGraph, p: { x: number; y: number }, radius = 70, excludeNode?: string): WfEdge | null {
  let best: WfEdge | null = null; let bd = radius;
  for (const e of g.edges) {
    if (excludeNode && (e.from === excludeNode || e.to === excludeNode)) continue;
    const m = edgeMid(g, e);
    if (!m) continue;
    const d = Math.hypot(m.x - p.x, m.y - p.y);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

export const NODE_TYPE_LABEL: Record<WfNodeType, string> = {
  start: 'Start', agent: 'Agent', condition: 'Condition', merge: 'Merge', human: 'Owner gate', approval: 'Human approval', end: 'End',
};

export const PURPOSE_LABEL: Record<string, string> = {
  plan: 'plan', prompt: 'write prompt', 'prompt-review': 'review prompt', implement: 'implement',
  qa: 'verify', review: 'review', analyse: 'analyse', fix: 'fix', doc: 'document', test: 'test',
  accept: 'accept', diagnose: 'diagnose', custom: 'custom step',
};
