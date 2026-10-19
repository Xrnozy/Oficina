// Shared types + pure helpers for the Workflow page — mirrors
// daemon/src/services/workflow.ts. Keep the shapes identical.

export type WfNodeType = 'start' | 'agent' | 'condition' | 'merge' | 'human' | 'end';
export type WfEdgeKind = 'next' | 'on-success' | 'on-failure' | 'on-reject' | 'message';

export interface WfCondition {
  field?: string;
  op?: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'contains' | 'matches' | 'truthy' | 'falsy';
  value?: unknown;
  and?: WfCondition[]; or?: WfCondition[]; not?: WfCondition;
}

export interface WfNodeConfig {
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
  workflow: { id: string; name: string; versionN: number | null; builtin: boolean };
  custom: boolean; issues: WfIssue[]; fallback: boolean;
  rows: RoutingRow[]; agentNodes: RoutingStep[];
  notInWorkflow: { id: string; name: string; avatar: string | null; status: string; roles: string[] }[];
}

export interface WorkflowRow {
  id: string; workspaceId: string; name: string; description: string;
  builtin: boolean; latestVersionId: string | null; versionN?: number | null; active?: boolean;
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
  const flowIn = g.edges.find((e) => e.to === nodeId && e.kind !== 'message');
  const flowOut = g.edges.find((e) => e.from === nodeId && e.kind !== 'message');
  const others = g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  const bridged = flowIn && flowOut
    ? [...others, { id: uid('e'), from: flowIn.from, to: flowOut.to, kind: flowIn.kind, condition: flowIn.condition, else: flowIn.else, label: flowIn.label }]
    : others;
  return { nodes: g.nodes.filter((n) => n.id !== nodeId), edges: bridged };
}

// Layered left-to-right layout: longest-path layering from start, ordered
// within a layer by the average row of their sources. No dependencies.
export function layoutLR(g: WfGraph): WfGraph {
  const flow = (id: string) => g.edges.filter((e) => e.from === id && e.kind !== 'message');
  const layer = new Map<string, number>();
  const start = g.nodes.find((n) => n.type === 'start') ?? g.nodes[0];
  if (!start) return g;
  const depth = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ins = g.edges.filter((e) => e.to === id && e.kind !== 'message' && e.from !== id);
    const d = ins.length ? Math.max(...ins.map((e) => depth(e.from, seen))) + 1 : 0;
    layer.set(id, d);
    return d;
  };
  for (const n of g.nodes) depth(n.id, new Set());
  const layers = new Map<number, WfNode[]>();
  for (const n of g.nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(n);
  }
  const pos = new Map<string, { x: number; y: number }>();
  const GX = 230; const GY = 150;
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
        const ins = g.edges.filter((e) => e.to === id && e.kind !== 'message');
        const b = ins.length ? ins.reduce((a, e) => a + (rowOf.get(e.from) ?? 0), 0) / ins.length : rowOf.get(id) ?? 0;
        return { id, b };
      });
      scored.sort((a, b2) => a.b - b2.b);
      order.set(l, scored.map((s) => s.id));
      scored.forEach((s, i) => rowOf.set(s.id, i));
    }
  }
  for (const [l, ids] of order) {
    const total = ids.length;
    ids.forEach((id, i) => pos.set(id, { x: l * GX + 40, y: i * GY + 40 - (total - 1) * (GY / 2) + 140 }));
  }
  return { ...g, nodes: g.nodes.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })) };
}

// Edge midpoint in flow coords — used for drop-onto-edge hit testing.
export function edgeMid(g: WfGraph, e: WfEdge): { x: number; y: number } | null {
  const a = g.nodes.find((n) => n.id === e.from); const b = g.nodes.find((n) => n.id === e.to);
  if (!a || !b) return null;
  return { x: (a.position.x + b.position.x) / 2 + 90, y: (a.position.y + b.position.y) / 2 + 30 };
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
  start: 'Start', agent: 'Agent', condition: 'Condition', merge: 'Merge', human: 'Human gate', end: 'End',
};

export const PURPOSE_LABEL: Record<string, string> = {
  plan: 'plan', prompt: 'write prompt', 'prompt-review': 'review prompt', implement: 'implement',
  qa: 'verify', review: 'review', analyse: 'analyse', fix: 'fix', doc: 'document', test: 'test',
  accept: 'accept', diagnose: 'diagnose', custom: 'custom step',
};
