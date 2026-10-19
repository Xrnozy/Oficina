import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import ReactFlow, {
  Background, BackgroundVariant, BaseEdge, Connection, ConnectionMode, Controls, Edge,
  EdgeLabelRenderer, EdgeProps, Handle, MarkerType, MiniMap, Node, NodeProps, Panel,
  Position, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
} from 'reactflow';
import {
  ArrowLeftRight, Ban, Bell, BookOpen, Check, CirclePlay, Copy, Download, FilePlus2,
  GitBranch, GitMerge, LayoutDashboard, ListPlus, Lock,
  MessageSquare, Plus, Redo2, Save, Scissors, Trash2, Undo2, Upload, User, Zap,
} from 'lucide-react';
import { get, post, put, del, useFetch, useQuery, useEvents, OfficeEvent } from '../api';
import { Dot, Empty, Modal, PageHeader, StatusChip, Tag, act, fmtAgo, roleLabel, toast, useCurrentRun } from '../components';
import {
  COND_FIELDS, COND_OPS, EDGE_KINDS, NODE_TYPE_LABEL, PURPOSES, PURPOSE_LABEL, WfCondition,
  WfEdge, WfEdgeKind, WfGraph, WfIssue, WfNode, WfNodeType, WorkflowRow, WorkflowVersionRow,
  WfValidation, condText, emptyGraph, insertOnEdge, layoutLR, nearestEdge, spliceOut, uid,
} from '../workflow';

// ---------------------------------------------------------------------------
// data shapes from the API
type WorkflowDetail = { workflow: WorkflowRow; versions: WorkflowVersionRow[]; graph: WfGraph | null; issues: WfValidation | null };
type AgentRow = { id: string; name: string; status?: string; model?: { backend?: string; model?: string }; memberships?: { role?: string; workspace_id: string; active: number }[] };
type RoleRow = { id: string; name: string };

// ---------------------------------------------------------------------------
// reactflow <-> workflow graph conversion
type RfData = { wf: WfNode; live?: { status: string; taskId?: string }; issues?: number };

const toRfNodes = (g: WfGraph): Node<RfData>[] =>
  g.nodes.map((n) => ({ id: n.id, type: 'wf', position: n.position, data: { wf: { ...n, position: undefined as never } } }));

const EDGE_STYLE: Record<WfEdgeKind, { stroke: string; dash?: string; tone: string }> = {
  next: { stroke: 'rgb(var(--line-strong))', tone: 'text-fg-3' },
  'on-success': { stroke: 'rgb(var(--ok))', tone: 'text-ok' },
  'on-failure': { stroke: 'rgb(var(--bad))', tone: 'text-bad' },
  'on-reject': { stroke: 'rgb(var(--warn))', tone: 'text-warn' },
  message: { stroke: 'rgb(var(--accent))', dash: '6 4', tone: 'text-accent' },
};

const toRfEdges = (g: WfGraph): Edge[] =>
  g.edges.map((e) => ({
    id: e.id, source: e.from, target: e.to, type: 'wf', data: { wf: e },
  }));

const toWfGraph = (nodes: Node<RfData>[], edges: Edge[]): WfGraph => ({
  nodes: nodes.map((n) => ({ ...n.data.wf, id: n.id, position: { x: n.position.x, y: n.position.y } })),
  edges: edges.map((e) => ({ ...e.data.wf, id: e.id, from: e.source, to: e.target })),
});

// ---------------------------------------------------------------------------
// custom node — one component renders every type
const NODE_W = 176;

const TYPE_TINT: Record<WfNodeType, string> = {
  start: 'bg-mint', end: 'bg-navy text-white', agent: 'bg-raised',
  condition: 'bg-cream', merge: 'bg-lilac', human: 'bg-pink',
};

const TYPE_ICON: Record<WfNodeType, React.ReactNode> = {
  start: <CirclePlay size={13} />, end: <Check size={13} />, agent: <User size={13} />,
  condition: <GitBranch size={13} />, merge: <GitMerge size={13} />, human: <Bell size={13} />,
};

const WfNodeView = React.memo(function WfNodeView({ data, selected }: NodeProps<RfData>) {
  const n = data.wf;
  const live = data.live;
  const err = (data.issues ?? 0) > 0;
  const isAgent = n.type === 'agent';
  return (
    <div
      className={`group relative rounded-xl border shadow-pop transition-shadow ${TYPE_TINT[n.type]} ${selected ? 'border-fg ring-1 ring-fg' : err ? 'border-bad' : 'border-line-strong'} ${live?.status === 'running' ? 'ring-2 ring-info' : ''} ${live?.status === 'failed' ? 'ring-2 ring-bad' : ''}`}
      style={{ width: n.type === 'start' || n.type === 'end' ? 110 : NODE_W }}
      title={n.label}
    >
      {n.type !== 'start' && <Handle type="target" position={Position.Left} className="!bg-fg-3 !w-2 !h-2 !border-0" />}
      <div className="px-3 py-2">
        <div className="flex items-center gap-1.5 text-2xs text-fg-3">
          {TYPE_ICON[n.type]}
          <span className="uppercase tracking-[0.05em] font-mono">{NODE_TYPE_LABEL[n.type]}</span>
          {live && <span className={`ml-auto flex items-center gap-1 ${live.status === 'failed' ? 'text-bad' : live.status === 'running' ? 'text-info' : 'text-ok'}`}><Dot tone={live.status === 'failed' ? 'bad' : live.status === 'running' ? 'info' : 'ok'} live={live.status === 'running'} />{live.status}</span>}
          {err && !live && <Dot tone="bad" className="ml-auto" />}
        </div>
        <div className="mt-0.5 text-[13px] font-medium leading-4 truncate">{n.label || n.id}</div>
        {isAgent && (
          <div className="mt-1 flex items-center gap-1 flex-wrap">
            <Tag mono>{n.role ?? n.agentId?.slice(0, 8) ?? 'unassigned'}</Tag>
            {n.config?.purpose && <Tag>{PURPOSE_LABEL[n.config.purpose] ?? n.config.purpose}</Tag>}
            {n.config?.writable === false && <Tag title="read-only: does not edit files">ro</Tag>}
          </div>
        )}
        {n.type === 'condition' && <div className="mt-0.5 text-2xs text-fg-3">branches on edges →</div>}
        {n.type === 'merge' && <div className="mt-0.5 text-2xs text-fg-3">waits for {(n.config?.mergeMode ?? 'all') === 'all' ? 'all branches' : 'any branch'}</div>}
      </div>
      {n.type !== 'end' && <Handle type="source" position={Position.Right} className="!bg-fg-3 !w-2 !h-2 !border-0" />}
    </div>
  );
});

// ---------------------------------------------------------------------------
// custom edge — label + midpoint "+" insert button
function WfEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps) {
  const e: WfEdge = data.wf;
  const taken: boolean = !!data.taken;
  const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.next;
  const [path, labelX, labelY] = edgePath(sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition);
  const label = e.else ? 'else' : e.label ?? (e.condition ? condText(e.condition) : '');
  return (
    <>
      <BaseEdge
        id={id} path={path} markerEnd={markerEnd}
        style={{
          stroke: taken ? 'rgb(var(--info))' : style.stroke,
          strokeWidth: selected ? 2.5 : taken ? 2 : 1.5,
          strokeDasharray: style.dash,
        }}
      />
      <EdgeLabelRenderer>
        <div className="absolute pointer-events-auto" style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
          <div className="group flex items-center gap-1">
            {(e.kind !== 'next' || label) && (
              <span className={`chip !h-5 text-2xs max-w-[190px] truncate ${selected ? 'border-fg' : 'border-line'} ${taken ? 'border-info text-info' : style.tone} bg-canvas`} title={e.else ? 'fallback branch' : label}>
                {e.kind === 'message' && <MessageSquare size={10} />}
                {e.kind === 'on-failure' && <Ban size={10} />}
                {e.kind === 'on-reject' && <Undo2 size={10} />}
                {e.kind === 'on-success' && <Check size={10} />}
                {label || EDGE_KINDS.find((k) => k.kind === e.kind)?.hint}
                {e.maxLoops != null && ` ·${e.maxLoops}`}
              </span>
            )}
            <button
              className="nodrag nopan hidden group-hover:inline-flex items-center justify-center w-4 h-4 rounded-full bg-fg text-canvas hover:bg-fg-2"
              title="Insert a node here"
              onClick={(ev) => { ev.stopPropagation(); insertOnEdgeOp(id); }}
            >
              <Plus size={10} />
            </button>
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// The page registers its insert op here — keeps edge data free of callbacks.
let insertOnEdgeOp: (edgeId: string) => void = () => undefined;

// left-to-right orthogonal-ish path: horizontal out, soft curve into target
function edgePath(sx: number, sy: number, tx: number, ty: number, _sp: Position, _tp: Position): [string, number, number] {
  const mx = sx + Math.max(48, (tx - sx) / 2);
  const p = `M ${sx} ${sy} C ${mx} ${sy}, ${tx - Math.max(48, (tx - sx) / 2)} ${ty}, ${tx} ${ty}`;
  return [p, (sx + tx) / 2, (sy + ty) / 2];
}

const nodeTypes = { wf: WfNodeView };
const edgeTypes = { wf: WfEdgeView };

// ---------------------------------------------------------------------------
// palette
function Palette({ agents, roles, wsId }: { agents: AgentRow[]; roles: RoleRow[]; wsId: string }) {
  const [open, setOpen] = useState(true);
  const byRole = useMemo(() => {
    const m = new Map<string, AgentRow[]>();
    for (const a of agents) {
      const mem = (a.memberships ?? []).filter((x) => x.active && x.workspace_id === wsId);
      for (const mm of mem) {
        const r = mm.role ?? 'unassigned';
        if (!m.has(r)) m.set(r, []);
        m.get(r)!.push(a);
      }
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [agents, wsId]);
  const drag = (payload: object) => (ev: React.DragEvent) => {
    ev.dataTransfer.setData('application/x-officechain-node', JSON.stringify(payload));
    ev.dataTransfer.effectAllowed = 'move';
  };
  const GENERIC: { type: WfNodeType; label: string; icon: React.ReactNode; hint: string }[] = [
    { type: 'condition', label: 'Condition', icon: <GitBranch size={13} />, hint: 'branch on step outcome' },
    { type: 'merge', label: 'Merge', icon: <GitMerge size={13} />, hint: 'join parallel branches' },
    { type: 'human', label: 'Human approval', icon: <Bell size={13} />, hint: 'pause for the owner' },
    { type: 'end', label: 'End', icon: <Check size={13} />, hint: 'task completes here' },
  ];
  if (!open) return <button className="btn btn-ghost btn-sm w-full" onClick={() => setOpen(true)}><ListPlus size={13} /> Show palette</button>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="field-label !mb-0">Agents</div>
        <button className="text-2xs text-fg-4 hover:text-fg" onClick={() => setOpen(false)}>hide</button>
      </div>
      {byRole.map(([role, list]) => (
        <div key={role}>
          <div className="px-1 text-2xs font-mono text-fg-4 mb-1">{roleLabel(role)}</div>
          <div className="space-y-1">
            {list.map((a) => (
              <div
                key={a.id} draggable
                onDragStart={drag({ type: 'agent', agentId: a.id, role, label: `${a.name}` })}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-line bg-raised cursor-grab active:cursor-grabbing hover:border-line-strong transition-colors"
                title="Drag onto the canvas — drop on an edge to insert"
              >
                <Dot tone={a.status === 'working' ? 'ok' : 'idle'} live={a.status === 'working'} />
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{a.name}</div>
                  <div className="text-2xs text-fg-4 truncate">{a.model?.backend ?? '—'}{a.model?.model ? ` · ${a.model.model}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {byRole.length === 0 && <div className="px-1 text-2xs text-fg-4">No agents in this workspace yet.</div>}
      <div>
        <div className="field-label">Steps</div>
        <div className="space-y-1">
          {GENERIC.map((g) => (
            <div
              key={g.type} draggable
              onDragStart={drag({ type: g.type, label: g.label })}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-dashed border-line bg-raised/50 cursor-grab active:cursor-grabbing hover:border-line-strong transition-colors"
              title={g.hint}
            >
              <span className="text-fg-3">{g.icon}</span>
              <div className="min-w-0">
                <div className="text-xs font-medium">{g.label}</div>
                <div className="text-2xs text-fg-4">{g.hint}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="px-1 text-2xs text-fg-4 leading-4">Drag onto the canvas. Drop on an edge to insert between its ends.</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// condition builder
function ConditionBuilder({ value, onChange }: { value: WfCondition | undefined; onChange: (c: WfCondition | undefined) => void }) {
  const leaves: WfCondition[] = useMemo(() => {
    if (!value) return [{ field: 'step.status', op: 'eq', value: 'success' }];
    if (value.and?.length) return value.and;
    if (value.or?.length) return value.or;
    return [value];
  }, [value]);
  const joiner: 'and' | 'or' = value?.or?.length ? 'or' : 'and';
  const setLeaves = (ls: WfCondition[], join: 'and' | 'or' = joiner) => {
    const clean = ls.filter((l) => l.field);
    onChange(clean.length === 0 ? undefined : clean.length === 1 ? clean[0] : { [join]: clean });
  };
  const update = (i: number, patch: Partial<WfCondition>) => setLeaves(leaves.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {leaves.map((l, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && (
            <button className="chip !h-5 shrink-0" onClick={() => setLeaves(leaves, joiner === 'and' ? 'or' : 'and')} title="Toggle and/or">{joiner}</button>
          )}
          <select className="inp !h-6 !text-2xs flex-1 min-w-0" value={l.field ?? 'step.status'} onChange={(e) => update(i, { field: e.target.value })}>
            {COND_FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
          </select>
          <select className="inp !h-6 !text-2xs w-[74px] shrink-0" value={l.op ?? 'eq'} onChange={(e) => update(i, { op: e.target.value as WfCondition['op'] })}>
            {COND_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </select>
          {!['truthy', 'falsy'].includes(l.op ?? 'eq') && (
            <input className="inp !h-6 !text-2xs w-[86px] shrink-0" value={String(l.value ?? '')} placeholder="value"
              onChange={(e) => update(i, { value: /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value })} />
          )}
          <button className="btn btn-ghost btn-icon !h-5 !w-5 shrink-0" onClick={() => setLeaves(leaves.filter((_, j) => j !== i))} title="Remove"><Trash2 size={10} /></button>
        </div>
      ))}
      <button className="btn btn-ghost btn-xs" onClick={() => setLeaves([...leaves, { field: 'checks', op: 'eq', value: 'fail' }])}><Plus size={11} /> Add rule ({joiner})</button>
      <div className="text-2xs text-fg-3 leading-4">If {condText({ [joiner]: leaves } as WfCondition) || '…'}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// inspectors (right panel)
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="mb-3"><span className="field-label">{label}</span>{children}</div>;
}

function NodeInspector({ node, agents, roles, wsId, allNodes, onChange, onDelete, onOpenTask }: {
  node: Node<RfData>; agents: AgentRow[]; roles: RoleRow[]; wsId: string;
  allNodes: Node<RfData>[]; onChange: (wf: WfNode) => void; onDelete: () => void; onOpenTask: () => void;
}) {
  const n = node.data.wf;
  const cfg = n.config ?? {};
  const set = (patch: Partial<WfNode>) => onChange({ ...n, ...patch });
  const setCfg = (patch: Partial<NonNullable<WfNode['config']>>) => onChange({ ...n, config: { ...cfg, ...patch } });
  const wsAgents = agents.filter((a) => (a.memberships ?? []).some((m) => m.active && m.workspace_id === wsId));
  const inputsMode = Array.isArray(cfg.inputs) ? 'named' : (cfg.inputs ?? 'envelope');
  const live = node.data.live;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="chip">{NODE_TYPE_LABEL[n.type]}</span>
        {live && <span className="chip border-info text-info">{live.status}</span>}
        <div className="ml-auto flex gap-1">
          {live?.taskId && <button className="btn btn-xs" onClick={onOpenTask}><BookOpen size={11} /> Open task</button>}
          <button className="btn btn-ghost btn-xs" onClick={onDelete}><Trash2 size={11} /> Delete</button>
        </div>
      </div>
      <Field label="Label"><input className="inp" value={n.label} onChange={(e) => set({ label: e.target.value })} /></Field>
      {n.type === 'agent' && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Role">
              <select className="inp" value={n.role ?? ''} onChange={(e) => set({ role: e.target.value || undefined, agentId: undefined })}>
                <option value="">— pick —</option>
                {roles.map((r) => <option key={r.id} value={r.name}>{roleLabel(r.name)}</option>)}
              </select>
            </Field>
            <Field label="Pinned agent (optional)">
              <select className="inp" value={n.agentId ?? ''} onChange={(e) => set({ agentId: e.target.value || undefined })}>
                <option value="">any in role</option>
                {wsAgents.filter((a) => !n.role || (a.memberships ?? []).some((m) => m.role === n.role && m.workspace_id === wsId)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Purpose">
              <select className="inp" value={cfg.purpose ?? 'custom'} onChange={(e) => setCfg({ purpose: e.target.value })}>
                {PURPOSES.map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p] ?? p}</option>)}
              </select>
            </Field>
            <Field label="Scope">
              <select className="inp" value={cfg.scope ?? 'task'} onChange={(e) => setCfg({ scope: e.target.value as 'task' | 'run' })}>
                <option value="task">per task</option>
                <option value="run">once per run</option>
              </select>
            </Field>
          </div>
          <Field label="Instructions (added to the prompt)">
            <textarea className="inp min-h-[64px] text-xs" value={cfg.instructions ?? ''} placeholder="e.g. only touch files under src/" onChange={(e) => setCfg({ instructions: e.target.value || undefined })} />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Model tier">
              <select className="inp" value={cfg.modelTier ?? ''} onChange={(e) => setCfg({ modelTier: (e.target.value || undefined) as 'fast' | 'standard' | 'strong' | undefined })}>
                <option value="">auto</option><option value="fast">fast</option><option value="standard">standard</option><option value="strong">strong</option>
              </select>
            </Field>
            <Field label="Budget (chars)"><input className="inp" type="number" min={0} value={cfg.budgetChars ?? ''} placeholder="auto" onChange={(e) => setCfg({ budgetChars: e.target.value ? Number(e.target.value) : undefined })} /></Field>
            <Field label="Timeout (min)"><input className="inp" type="number" min={0} value={cfg.timeoutMin ?? ''} placeholder="auto" onChange={(e) => setCfg({ timeoutMin: e.target.value ? Number(e.target.value) : undefined })} /></Field>
          </div>
          <Field label="Inputs — what the prompt carries">
            <select className="inp" value={inputsMode} onChange={(e) => {
              const v = e.target.value;
              setCfg({ inputs: v === 'named' ? [] : (v as 'envelope' | 'full') });
            }}>
              <option value="envelope">hand-off envelope (default)</option>
              <option value="full">full previous output</option>
              <option value="named">outputs of specific earlier nodes</option>
            </select>
          </Field>
          {inputsMode === 'named' && (
            <Field label="Include outputs of">
              <div className="space-y-1 max-h-32 overflow-auto">
                {allNodes.filter((x) => x.id !== n.id && x.data.wf.type === 'agent').map((x) => {
                  const sel = Array.isArray(cfg.inputs) && cfg.inputs.includes(x.id);
                  return (
                    <label key={x.id} className="flex items-center gap-2 text-xs px-1 py-0.5 rounded hover:bg-raised cursor-pointer">
                      <input type="checkbox" checked={sel} onChange={(e2) => {
                        const cur = Array.isArray(cfg.inputs) ? cfg.inputs : [];
                        setCfg({ inputs: e2.target.checked ? [...cur, x.id] : cur.filter((i) => i !== x.id) });
                      }} />
                      {x.data.wf.label || x.id}
                    </label>
                  );
                })}
              </div>
            </Field>
          )}
          <label className="flex items-center gap-2 text-xs mb-3 cursor-pointer">
            <input type="checkbox" checked={cfg.writable !== false} onChange={(e) => setCfg({ writable: e.target.checked ? undefined : false })} />
            May edit files (writer). Read-only steps never hold the repo.
          </label>
        </>
      )}
      {n.type === 'merge' && (
        <Field label="Wait for">
          <select className="inp" value={cfg.mergeMode ?? 'all'} onChange={(e) => setCfg({ mergeMode: e.target.value as 'all' | 'any' })}>
            <option value="all">all incoming branches</option>
            <option value="any">the first branch to arrive</option>
          </select>
        </Field>
      )}
      {n.type === 'human' && (
        <Field label="What the owner is asked">
          <textarea className="inp min-h-[64px] text-xs" value={cfg.instructions ?? ''} placeholder="Approve to continue" onChange={(e) => setCfg({ instructions: e.target.value || undefined })} />
        </Field>
      )}
      {(n.type === 'start' || n.type === 'end' || n.type === 'condition') && (
        <div className="text-2xs text-fg-4 leading-4">
          {n.type === 'condition' ? 'Branch logic lives on the outgoing edges — click an edge to set its condition. Exactly one must be else.' :
            n.type === 'start' ? 'The run enters here. Exactly one start per workflow.' :
            'The task completes when it reaches an end node.'}
        </div>
      )}
    </div>
  );
}

function EdgeInspector({ edge, fromNode, onChange, onDelete }: { edge: Edge; fromNode: Node<RfData> | undefined; onChange: (wf: WfEdge) => void; onDelete: () => void }) {
  const e = edge.data.wf as WfEdge;
  const set = (patch: Partial<WfEdge>) => onChange({ ...e, ...patch });
  const fromCondition = fromNode?.data.wf.type === 'condition';
  const loopKind = e.kind === 'on-failure' || e.kind === 'on-reject';
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="chip">{e.kind}</span>
        <span className="text-2xs text-fg-4 truncate">{edge.source} → {edge.target}</span>
        <button className="btn btn-ghost btn-xs ml-auto" onClick={onDelete}><Trash2 size={11} /> Delete</button>
      </div>
      <Field label="Kind">
        <select className="inp" value={e.kind} onChange={(ev) => set({ kind: ev.target.value as WfEdgeKind })}>
          {EDGE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.kind} — {k.hint}</option>)}
        </select>
      </Field>
      <Field label="Label"><input className="inp" value={e.label ?? ''} placeholder="shown on the edge" onChange={(ev) => set({ label: ev.target.value || undefined })} /></Field>
      {fromCondition && (
        <label className="flex items-center gap-2 text-xs mb-3 cursor-pointer">
          <input type="checkbox" checked={!!e.else} onChange={(ev) => set({ else: ev.target.checked || undefined, condition: ev.target.checked ? undefined : e.condition })} />
          This is the else path (taken when no condition matches)
        </label>
      )}
      {!e.else && e.kind !== 'message' && (
        <Field label="Condition (optional — evaluated by the engine)">
          <ConditionBuilder value={e.condition} onChange={(c) => set({ condition: c })} />
        </Field>
      )}
      {loopKind && (
        <Field label="Max loops — the loop bound (default 3)">
          <input className="inp" type="number" min={1} value={e.maxLoops ?? ''} placeholder="3" onChange={(ev) => set({ maxLoops: ev.target.value ? Number(ev.target.value) : undefined })} />
        </Field>
      )}
      {e.kind === 'message' && (
        <>
          <label className="flex items-center gap-2 text-xs mb-3 cursor-pointer">
            <input type="checkbox" checked={!!e.waitForReply} onChange={(ev) => set({ waitForReply: ev.target.checked || undefined })} />
            Wait for a reply before continuing
          </label>
          {e.waitForReply && (
            <Field label="Reply timeout (min)">
              <input className="inp" type="number" min={1} value={e.timeoutMin ?? ''} placeholder="15" onChange={(ev) => set({ timeoutMin: ev.target.value ? Number(ev.target.value) : undefined })} />
            </Field>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the page
function WorkflowEditor() {
  const nav = useNavigate();
  const { run } = useCurrentRun();
  const { data: workspaces } = useQuery<any[]>('/workspaces');
  const ws = workspaces?.find((w) => w.id === run?.workspaceId) ?? workspaces?.[0];
  const wsId = ws?.id ?? '';
  const { data: wflist, reload: reloadList } = useQuery<WorkflowRow[]>(wsId ? `/workflows?workspaceId=${wsId}` : null);
  const { data: agents } = useQuery<AgentRow[]>('/agents');
  const { data: roles } = useQuery<RoleRow[]>('/roles');

  const [wfId, setWfId] = useState<string | null>(null);
  const { data: detail, reload: reloadDetail } = useFetch<WorkflowDetail>(wfId ? `/workflows/${wfId}` : null, [wfId]);
  const builtin = !!detail?.workflow.builtin;
  const readOnly = builtin;

  const [nodes, setNodes, onNodesChange] = useNodesState<RfData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const [issues, setIssues] = useState<WfIssue[]>([]);
  const [dirty, setDirty] = useState(false);
  const [draftBanner, setDraftBanner] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [note, setNote] = useState('');

  const { screenToFlowPosition } = useReactFlow();

  // ---- history ----
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const snapshot = useCallback(() => JSON.stringify({ n: nodes, e: edges }), [nodes, edges]);
  const pushHistory = useCallback(() => {
    past.current.push(snapshot());
    if (past.current.length > 60) past.current.shift();
    future.current = [];
  }, [snapshot]);
  const restore = useCallback((json: string) => {
    const { n, e } = JSON.parse(json);
    setNodes(n); setEdges(e); setDirty(true);
  }, [setNodes, setEdges]);
  const undo = useCallback(() => {
    if (!past.current.length) return;
    future.current.push(snapshot());
    restore(past.current.pop()!);
  }, [snapshot, restore]);
  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(snapshot());
    restore(future.current.pop()!);
  }, [snapshot, restore]);

  // ---- graph helpers operating on the RF state ----
  const currentGraph = useCallback((): WfGraph => toWfGraph(nodes, edges), [nodes, edges]);
  const applyGraph = useCallback((g: WfGraph, markDirty = true) => {
    setNodes(toRfNodes(g)); setEdges(toRfEdges(g));
    if (markDirty) setDirty(true);
  }, [setNodes, setEdges]);
  const mutate = useCallback((f: (g: WfGraph) => WfGraph) => { pushHistory(); applyGraph(f(currentGraph())); }, [pushHistory, applyGraph, currentGraph]);

  // ---- load workflow detail into canvas ----
  useEffect(() => {
    if (!detail) return;
    past.current = []; future.current = [];
    const draftKey = `wf-draft:${detail.workflow.id}`;
    const draft = !builtin ? localStorage.getItem(draftKey) : null;
    if (draft) {
      try { applyGraph(JSON.parse(draft).graph as WfGraph, false); setDraftBanner(true); setDirty(true); return; } catch { /* fall through */ }
    }
    applyGraph(detail.graph ?? emptyGraph(), false);
    setDraftBanner(false); setDirty(false); setIssues(detail.issues?.issues ?? []);
  }, [detail, builtin]); // eslint-disable-line react-hooks/exhaustive-deps

  // auto-select first workflow
  useEffect(() => { if (!wfId && wflist?.length) setWfId(wflist.find((w) => w.active)?.id ?? wflist[0].id); }, [wflist, wfId]);

  // ---- live validation (debounced) ----
  useEffect(() => {
    if (!nodes.length || !wsId) return;
    const t = setTimeout(() => {
      post<WfValidation>('/workflows/validate', { graph: currentGraph(), workspaceId: wsId })
        .then((v) => setIssues(v.issues ?? []))
        .catch(() => undefined);
    }, 450);
    return () => clearTimeout(t);
  }, [nodes, edges, wsId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- autosave draft ----
  useEffect(() => {
    if (!dirty || !wfId || builtin) return;
    const t = setTimeout(() => localStorage.setItem(`wf-draft:${wfId}`, JSON.stringify({ graph: currentGraph(), at: Date.now() })), 800);
    return () => clearTimeout(t);
  }, [dirty, wfId, builtin, nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live view ----
  const versionIds = useMemo(() => new Set((detail?.versions ?? []).map((v) => v.id)), [detail]);
  const { data: runs } = useQuery<any[]>('/runs');
  const wfRuns = useMemo(() => (runs ?? []).filter((r) => r.workflowVersionId && versionIds.has(r.workflowVersionId)), [runs, versionIds]);
  const liveRunId = wfRuns.find((r) => r.id === run?.id)?.id ?? wfRuns[0]?.id ?? null;
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  const liveRun = pickedRun ?? liveRunId;
  const { data: runEvents } = useFetch<OfficeEvent[]>(
    liveRun ? `/runs/${liveRun}/events?types=${encodeURIComponent('workflow.step,workflow.branch,workflow.loop,workflow.enter')}` : null, [liveRun]);

  const [liveWs, setLiveWs] = useState<OfficeEvent[]>([]);
  useEffect(() => { setLiveWs([]); }, [liveRun]);
  useEvents(useCallback((e: OfficeEvent) => {
    if (!e.type.startsWith('workflow.') || e.runId !== liveRun) return;
    if (['workflow.step', 'workflow.branch', 'workflow.loop', 'workflow.enter'].includes(e.type)) {
      setLiveWs((xs) => (xs.length > 300 ? [...xs.slice(-200), e] : [...xs, e]));
    }
  }, [liveRun]));

  const live = useMemo(() => {
    const nodeStatus = new Map<string, { status: string; taskId?: string; at: number }>();
    const taken = new Set<string>();
    const mark = (evs: OfficeEvent[]) => {
      for (const e of evs) {
        const p = e.payload as Record<string, unknown>;
        if (e.type === 'workflow.step' && p.nodeId) {
          const cur = nodeStatus.get(String(p.nodeId));
          const status = p.done ? 'done' : 'running';
          if (!cur || cur.status !== 'running' || status === 'done') nodeStatus.set(String(p.nodeId), { status, taskId: p.taskId as string | undefined, at: e.seq });
        }
        if (e.type === 'workflow.branch') {
          for (const eid of (p.edges as string[] | undefined) ?? []) taken.add(eid);
          if (p.from) { const cur = nodeStatus.get(String(p.from)); if (cur?.status === 'running') nodeStatus.set(String(p.from), { ...cur, status: 'done' }); }
        }
        if (e.type === 'workflow.loop' && p.taskId) {
          // a loop edge exhausted or fired — mark the source node as retrying
          if (p.edgeId) taken.add(String(p.edgeId));
        }
        if (e.type === 'workflow.enter' && Array.isArray(p.nodes)) {
          for (const nid of p.nodes as string[]) if (!nodeStatus.has(nid)) nodeStatus.set(nid, { status: 'running', taskId: p.taskId as string | undefined, at: e.seq });
        }
      }
    };
    mark(runEvents ?? []);
    mark(liveWs);
    return { nodeStatus, taken };
  }, [runEvents, liveWs]);

  // decorate nodes/edges with live + issue overlays (stable refs for memo)
  const issueMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of issues) {
      const key = i.nodeId ?? i.edgeId;
      if (key) m.set(key, (m.get(key) ?? 0) + (i.level === 'error' ? 1 : 0.5));
    }
    return m;
  }, [issues]);
  const liveStable = useRef(new Map<string, { status: string; taskId?: string }>());
  const dNodes = useMemo(() => {
    const prev = liveStable.current;
    const next = new Map<string, { status: string; taskId?: string }>();
    for (const [id, l] of live.nodeStatus) {
      const p = prev.get(id);
      next.set(id, p && p.status === l.status && p.taskId === l.taskId ? p : l);
    }
    liveStable.current = next;
    return nodes.map((n) => {
      const l = next.get(n.id); const iss = issueMap.get(n.id) ?? 0;
      if (n.data.live === l && n.data.issues === iss) return n;
      return { ...n, data: { ...n.data, live: l, issues: iss } };
    });
  }, [nodes, live, issueMap]);
  const dEdges = useMemo(() => edges.map((e) => {
    const taken = live.taken.has(e.id) || undefined;
    if (e.data.taken === taken) return e;
    return { ...e, data: { ...e.data, taken } };
  }), [edges, live]);

  // ---- selection ----
  const selNode = dNodes.find((n) => selNodes.includes(n.id));
  const selEdge = dEdges.find((e) => selEdges.includes(e.id));

  // ---- ops ----
  const insertOn = useCallback((edgeId: string, node?: WfNode) => {
    mutate((g) => {
      const m = g.edges.find((x) => x.id === edgeId);
      if (!m) return g;
      const a = g.nodes.find((n) => n.id === m.from); const b = g.nodes.find((n) => n.id === m.to);
      const mid = a && b ? { x: (a.position.x + b.position.x) / 2, y: (a.position.y + b.position.y) / 2 } : { x: 200, y: 200 };
      const nn: WfNode = node ?? { id: uid('n'), type: 'agent', label: 'New step', config: { purpose: 'custom' }, position: { x: mid.x - 60, y: mid.y - 30 } };
      return insertOnEdge(g, edgeId, nn);
    });
  }, [mutate]);
  useEffect(() => { insertOnEdgeOp = (edgeId) => insertOn(edgeId); return () => { insertOnEdgeOp = () => undefined; }; }, [insertOn]);

  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target) return;
    mutate((g) => {
      const src = g.nodes.find((n) => n.id === c.source);
      const e: WfEdge = { id: uid('e'), from: c.source!, to: c.target!, kind: 'next' };
      if (src?.type === 'condition') {
        const hasElse = g.edges.some((x) => x.from === src.id && x.else);
        if (!hasElse) e.else = true;
        else e.condition = { field: 'step.status', op: 'eq', value: 'success' };
      }
      return { ...g, edges: [...g.edges, e] };
    });
  }, [mutate]);

  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    const raw = ev.dataTransfer.getData('application/x-officechain-node');
    if (!raw || readOnly) return;
    const p = JSON.parse(raw) as { type: WfNodeType; agentId?: string; role?: string; label: string };
    const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    pos.x = Math.round(pos.x / 20) * 20 - 80; pos.y = Math.round(pos.y / 20) * 20 - 30;
    mutate((g) => {
      const node: WfNode = {
        id: uid('n'), type: p.type, label: p.label,
        agentId: p.agentId, role: p.role,
        config: p.type === 'agent' ? { purpose: 'custom' } : p.type === 'merge' ? { mergeMode: 'all' } : undefined,
        position: pos,
      };
      const near = nearestEdge(g, { x: pos.x + 88, y: pos.y + 30 }, 80);
      return near ? insertOnEdge(g, near.id, node) : { ...g, nodes: [...g.nodes, node] };
    });
  }, [readOnly, screenToFlowPosition, mutate]);

  const dragSnapshot = useRef<string | null>(null);
  const onNodeDragStart = useCallback(() => { dragSnapshot.current = snapshot(); }, [snapshot]);
  const onNodeDragStop = useCallback((_e: React.MouseEvent, node: Node<RfData>) => {
    if (readOnly) return;
    const g = currentGraph();
    const near = nearestEdge(g, { x: node.position.x + 88, y: node.position.y + 30 }, 70, node.id);
    if (near) {
      mutate((g2) => {
        const wn = g2.nodes.find((n) => n.id === node.id);
        return wn ? insertOnEdge(spliceOut(g2, node.id), near.id, { ...wn, position: node.position }) : g2;
      });
    } else if (dragSnapshot.current) {
      past.current.push(dragSnapshot.current);   // pre-drag state — undo restores it
      future.current = [];
    }
    dragSnapshot.current = null;
  }, [readOnly, currentGraph, mutate]);

  const deleteSelection = useCallback(() => {
    if (readOnly || (!selNodes.length && !selEdges.length)) return;
    mutate((g) => {
      let gg = g;
      for (const id of selNodes) if (g.nodes.find((n) => n.id === id)?.type !== 'start') gg = spliceOut(gg, id);
      const doomedEdges = new Set(selEdges);
      // edges attached to deleted nodes are already gone via spliceOut
      gg = { ...gg, edges: gg.edges.filter((e) => !doomedEdges.has(e.id)) };
      return gg;
    });
    setSelNodes([]); setSelEdges([]);
  }, [readOnly, selNodes, selEdges, mutate]);

  // ---- clipboard ----
  const clipboard = useRef<{ nodes: WfNode[]; edges: WfEdge[] } | null>(null);
  const copySelection = useCallback(() => {
    const g = currentGraph();
    const ns = g.nodes.filter((n) => selNodes.includes(n.id));
    if (!ns.length) return;
    clipboard.current = { nodes: ns, edges: g.edges.filter((e) => selNodes.includes(e.from) && selNodes.includes(e.to)) };
    toast(`Copied ${ns.length} node${ns.length > 1 ? 's' : ''}`);
  }, [currentGraph, selNodes]);
  const paste = useCallback(() => {
    const c = clipboard.current;
    if (!c?.nodes.length || readOnly) return;
    mutate((g) => {
      const remap = new Map<string, string>();
      const newNodes = c.nodes.map((n) => {
        const id = n.type === 'start' || n.type === 'end' ? uid(n.type) : uid('n');
        remap.set(n.id, id);
        return { ...n, id, position: { x: n.position.x + 60, y: n.position.y + 60 } };
      });
      const newEdges = c.edges.map((e) => ({ ...e, id: uid('e'), from: remap.get(e.from)!, to: remap.get(e.to)! }));
      return { nodes: [...g.nodes, ...newNodes], edges: [...g.edges, ...newEdges] };
    });
  }, [readOnly, mutate]);

  // ---- keyboard ----
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if ((ev.key === 'Delete' || ev.key === 'Backspace')) { ev.preventDefault(); deleteSelection(); }
      else if (mod && ev.key.toLowerCase() === 'z' && ev.shiftKey) { ev.preventDefault(); redo(); }
      else if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); undo(); }
      else if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); }
      else if (mod && ev.key.toLowerCase() === 'c') copySelection();
      else if (mod && ev.key.toLowerCase() === 'v') { ev.preventDefault(); paste(); }
      else if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); void save(); }
      else if (ev.key === 'Escape') { setSelNodes([]); setSelEdges([]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---- save / activate / clone ----
  const hasErrors = issues.some((i) => i.level === 'error');
  const save = useCallback(async () => {
    if (!detail || builtin) return;
    if (hasErrors) { toast('Fix validation errors before saving', 'bad'); return; }
    const r = await act(put<{ version: WorkflowVersionRow }>(`/workflows/${detail.workflow.id}`, { graph: currentGraph(), note }), 'Saved as a new version');
    if (r) { localStorage.removeItem(`wf-draft:${detail.workflow.id}`); setDirty(false); setNote(''); setDraftBanner(false); reloadDetail(); reloadList(); }
  }, [detail, builtin, hasErrors, currentGraph, note, reloadDetail, reloadList]);

  const createNew = async () => {
    if (!wsId) return;
    const name = prompt('Name for the new workflow', 'Custom pipeline');
    if (!name) return;
    const r = await act(post<{ id: string }>('/workflows', { workspaceId: wsId, name, description: '', graph: emptyGraph() }));
    if (r) { reloadList(); setWfId(r.id); }
  };
  const cloneWf = async () => {
    if (!detail) return;
    const name = prompt('Name for the copy', `${detail.workflow.name} copy`);
    if (!name) return;
    const r = await act(post<{ id: string }>(`/workflows/${detail.workflow.id}/clone`, { name }));
    if (r) { reloadList(); setWfId(r.id); }
  };
  const removeWf = async () => {
    if (!detail || builtin) return;
    if (!confirm(`Delete "${detail.workflow.name}"?`)) return;
    const r = await act(del(`/workflows/${detail.workflow.id}`));
    if (r) { setWfId(null); reloadList(); }
  };
  const setActive = async (on: boolean) => {
    if (!detail) return;
    if (on && hasErrors) { toast('Fix validation errors before activating', 'bad'); return; }
    const r = await act(post(`/workflows/${detail.workflow.id}/${on ? 'activate' : 'deactivate'}`), on ? 'Workflow is now active for this workspace' : 'Deactivated — runs use the built-in pipeline');
    if (r) reloadList();
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ name: detail?.workflow.name, graph: currentGraph() }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(detail?.workflow.name ?? 'workflow').replace(/\s+/g, '-').toLowerCase()}.json`;
    a.click();
  };
  const importJson = (ev: React.ChangeEvent<HTMLInputElement>) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    f.text().then((txt) => {
      const j = JSON.parse(txt);
      const g: WfGraph = j.graph ?? j;
      if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) throw new Error('not a workflow graph');
      pushHistory(); applyGraph(g); toast('Imported — review, then save as a new version');
    }).catch((e) => toast(String(e?.message ?? e), 'bad'));
    ev.target.value = '';
  };

  const errorsList = issues.filter((i) => i.level === 'error');
  const warnsList = issues.filter((i) => i.level === 'warning');

  // ---- render ----
  return (
    <div className="flex flex-col h-[calc(100dvh-9.5rem)] min-h-[540px]">
      <PageHeader
        title="Workflow"
        sub="Draw the routing graph agents follow for each task. Drag agents onto the canvas; drop on an edge to insert between its ends."
      >
        <button className="btn btn-sm" onClick={createNew}><FilePlus2 size={14} /> New workflow</button>
      </PageHeader>

      <div className="flex flex-1 min-h-0 gap-3">
        {/* left rail: workflow list + palette */}
        <aside className="w-56 shrink-0 flex flex-col gap-3 min-h-0">
          <div className="card overflow-hidden shrink-0 max-h-44 flex flex-col">
            <div className="px-3 py-2 border-b border-line text-2xs font-mono text-fg-3 uppercase tracking-[0.05em]">Workflows</div>
            <div className="overflow-auto">
              {(wflist ?? []).map((w) => (
                <button key={w.id} onClick={() => setWfId(w.id)}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs hover:bg-raised transition-colors ${w.id === wfId ? 'bg-raised' : ''}`}>
                  {w.builtin ? <Lock size={11} className="text-fg-4 shrink-0" /> : <GitBranch size={11} className="text-fg-4 shrink-0" />}
                  <span className="truncate flex-1">{w.name}</span>
                  {w.active && <span className="chip !h-4 !px-1 text-[9px] border-ok/30 text-ok">active</span>}
                  {w.versionN != null && <span className="text-2xs text-fg-4">v{w.versionN}</span>}
                </button>
              ))}
              {!wflist?.length && <div className="px-3 py-3 text-2xs text-fg-4">{wflist ? 'No workflows yet — create one.' : '…'}</div>}
            </div>
          </div>
          <div className="card flex-1 min-h-0 overflow-auto p-3">
            <Palette agents={agents ?? []} roles={roles ?? []} wsId={wsId} />
          </div>
        </aside>

        {/* canvas */}
        <div className="flex-1 min-w-0 card overflow-hidden relative">
          <ReactFlow
            nodes={dNodes} edges={dEdges}
            onNodesChange={readOnly ? ((chs) => onNodesChange(chs.filter((c) => c.type === 'select'))) : onNodesChange}
            onEdgesChange={readOnly ? ((chs) => onEdgesChange(chs.filter((c) => c.type === 'select'))) : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onSelectionChange={useCallback(({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }) => { setSelNodes(ns.map((x) => x.id)); setSelEdges(es.map((x) => x.id)); }, [])}
            onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            defaultEdgeOptions={{ type: 'wf', markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } }}
            connectionMode={ConnectionMode.Loose}
            snapToGrid snapGrid={[20, 20]}
            fitView minZoom={0.2} maxZoom={2}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable
            multiSelectionKeyCode="Shift" selectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgb(var(--line))" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!bg-raised !border !border-line !rounded-lg" nodeColor="rgb(var(--line-strong))" maskColor="rgb(var(--canvas) / 0.7)" />
            <Panel position="top-left" className="flex flex-col gap-1.5 !m-3 max-w-[60%]">
              {detail && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="chip !h-6 text-xs font-medium">{detail.workflow.name}{detail.versions.length ? ` · v${detail.versions[detail.versions.length - 1]?.n ?? '?'}` : ''}</span>
                  {detail.workflow.builtin && <span className="chip !h-6 border-line text-fg-3"><Lock size={10} /> built-in · read-only</span>}
                  {detail.workflow.active && <span className="chip !h-6 border-ok/30 text-ok">active</span>}
                  {dirty && !readOnly && <span className="chip !h-6 border-warn/30 text-warn">unsaved draft</span>}
                </div>
              )}
              {draftBanner && (
                <div className="card !border-warn/40 px-3 py-1.5 text-2xs flex items-center gap-2">
                  Autosaved draft restored.
                  <button className="underline hover:text-fg" onClick={() => { localStorage.removeItem(`wf-draft:${wfId}`); if (detail?.graph) { pushHistory(); applyGraph(detail.graph); } setDraftBanner(false); setDirty(false); }}>discard it</button>
                </div>
              )}
              {errorsList.length > 0 && (
                <div className="card !border-bad/40 px-3 py-1.5 text-2xs text-bad max-w-full">
                  {errorsList.length} error{errorsList.length > 1 ? 's' : ''} — save and activate are blocked.
                </div>
              )}
            </Panel>
            <Panel position="bottom-left" className="!m-3">
              <div className="flex items-center gap-1.5">
                {wfRuns.length > 0 && (
                  <select className="inp !h-6 !text-2xs !w-auto" value={liveRun ?? ''} onChange={(e) => setPickedRun(e.target.value || null)} title="Overlay a run's actual path">
                    {wfRuns.map((r) => <option key={r.id} value={r.id}>{r.id === run?.id ? '● ' : ''}run {r.id.slice(0, 8)} · {r.status}</option>)}
                  </select>
                )}
                {!readOnly && (
                  <>
                    <button className="btn btn-xs" onClick={() => mutate((g) => layoutLR(g))} title="Arrange the graph left to right"><ArrowLeftRight size={11} /> Auto-layout</button>
                    <button className="btn btn-xs" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)"><Undo2 size={11} /></button>
                    <button className="btn btn-xs" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)"><Redo2 size={11} /></button>
                    <button className="btn btn-xs" onClick={copySelection} disabled={!selNodes.length} title="Copy (Ctrl+C)"><Copy size={11} /></button>
                    <button className="btn btn-xs" onClick={deleteSelection} disabled={!selNodes.length && !selEdges.length} title="Delete selection"><Scissors size={11} /></button>
                  </>
                )}
              </div>
            </Panel>
          </ReactFlow>
        </div>

        {/* right rail: inspector */}
        <aside className="w-72 shrink-0 card p-3 overflow-auto min-h-0">
          {selNode ? (
            <NodeInspector
              node={selNode} agents={agents ?? []} roles={roles ?? []} wsId={wsId} allNodes={dNodes}
              onChange={(wf) => { pushHistory(); setNodes((ns) => ns.map((n) => (n.id === wf.id ? { ...n, data: { ...n.data, wf } } : n))); setDirty(true); }}
              onDelete={deleteSelection}
              onOpenTask={() => selNode.data.live?.taskId && nav(`/tasks/${selNode.data.live.taskId}`)}
            />
          ) : selEdge ? (
            <EdgeInspector
              edge={selEdge} fromNode={dNodes.find((n) => n.id === selEdge.source)}
              onChange={(wf) => { pushHistory(); setEdges((es) => es.map((x) => (x.id === wf.id ? { ...x, data: { ...x.data, wf } } : x))); setDirty(true); }}
              onDelete={deleteSelection}
            />
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="field-label !mb-0">Workflow</span>
                {detail && !builtin && <button className="btn btn-ghost btn-xs ml-auto" onClick={removeWf}><Trash2 size={11} /> Delete</button>}
              </div>
              {detail ? (
                <>
                  <div className="text-xs text-fg-3 mb-3">{detail.workflow.description || 'No description.'}</div>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {!readOnly && <button className="btn btn-primary btn-xs" onClick={() => void save()} disabled={hasErrors || !dirty}><Save size={11} /> Save version</button>}
                    {builtin ? (
                      <button className="btn btn-accent btn-xs" onClick={cloneWf}><Copy size={11} /> Clone to edit</button>
                    ) : (
                      <>
                        <button className="btn btn-xs" onClick={cloneWf}><Copy size={11} /> Clone</button>
                        {detail.workflow.active
                          ? <button className="btn btn-danger btn-xs" onClick={() => void setActive(false)}><Ban size={11} /> Deactivate</button>
                          : <button className="btn btn-accent btn-xs" onClick={() => void setActive(true)} disabled={hasErrors}><Zap size={11} /> Set active</button>}
                      </>
                    )}
                    <button className="btn btn-ghost btn-xs" onClick={() => setShowVersions(true)}>v{detail.versions.length} · history</button>
                  </div>
                  {!readOnly && (
                    <Field label="Version note (saved with the version)">
                      <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed" />
                    </Field>
                  )}
                  <div className="flex gap-1.5 mb-4">
                    <button className="btn btn-ghost btn-xs" onClick={exportJson}><Download size={11} /> Export</button>
                    {!readOnly && (
                      <label className="btn btn-ghost btn-xs cursor-pointer"><Upload size={11} /> Import
                        <input type="file" accept=".json,application/json" className="hidden" onChange={importJson} />
                      </label>
                    )}
                  </div>
                  <div className="border-t border-line pt-3">
                    <div className="field-label">Validation</div>
                    {issues.length === 0 && <div className="text-2xs text-ok flex items-center gap-1.5"><Check size={11} /> Graph is valid.</div>}
                    <div className="space-y-1 max-h-56 overflow-auto">
                      {issues.map((i, k) => (
                        <button key={k} className={`w-full text-left text-2xs px-2 py-1 rounded-md flex items-start gap-1.5 hover:bg-raised ${i.level === 'error' ? 'text-bad' : 'text-warn'}`}
                          onClick={() => { if (i.nodeId) { setSelNodes([i.nodeId]); setSelEdges([]); } else if (i.edgeId) { setSelEdges([i.edgeId]); setSelNodes([]); } }}
                          title={i.nodeId ?? i.edgeId}>
                          <Dot tone={i.level === 'error' ? 'bad' : 'warn'} className="mt-1" />
                          <span className="flex-1"><span className="font-mono text-fg-4">{i.nodeId ?? i.edgeId ?? 'graph'}:</span> {i.message}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <Empty icon={LayoutDashboard} title="Pick a workflow" text="Select a workflow on the left, or create a new one to start drawing." />
              )}
            </div>
          )}
        </aside>
      </div>

      {/* versions modal */}
      {showVersions && detail && (
        <Modal title={`Version history — ${detail.workflow.name}`} onClose={() => setShowVersions(false)} width="max-w-xl">
          <div className="space-y-1 max-h-[50vh] overflow-auto">
            {[...detail.versions].sort((a, b) => b.n - a.n).map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-line">
                <span className="font-mono text-xs">v{v.n}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs truncate">{v.note || '—'}</div>
                  <div className="text-2xs text-fg-4">{v.createdBy} · {fmtAgo(v.createdAt)}</div>
                </div>
                {v.id === detail.workflow.latestVersionId && <Tag tone="ok">latest</Tag>}
                {!readOnly && v.id !== detail.workflow.latestVersionId && (
                  <button className="btn btn-xs" onClick={async () => {
                    const ver = await act(get<{ graph: WfGraph }>(`/workflows/${detail.workflow.id}/versions/${v.n}`));
                    if (ver?.graph) { pushHistory(); applyGraph(ver.graph); setShowVersions(false); toast(`Loaded v${v.n} as a draft — save to make it latest`); }
                  }}>Restore</button>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function Workflow() {
  return <ReactFlowProvider><WorkflowEditor /></ReactFlowProvider>;
}
