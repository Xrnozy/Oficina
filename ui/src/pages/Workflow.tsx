import { Select } from '../Select';
import { downloadJson, fileSlug, readJsonFile, useOffice } from '../office';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import ReactFlow, {
  applyNodeChanges, Background, BackgroundVariant, BaseEdge, Connection, ConnectionMode, Controls, Edge,
  EdgeLabelRenderer, EdgeProps, Handle, MarkerType, MiniMap, Node, NodeProps, Panel,
  Position, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
} from 'reactflow';
import { layoutEdges, type EdgeGeo } from '../wfEdges';
import {
  ArrowDown, ArrowLeftRight, ArrowUp, Ban, Bell, BookMarked, BookOpen, Check, CirclePlay, Copy, Download, FilePlus2, FlaskConical,
  Cpu, GitBranch, GitMerge, History as HistoryIcon, LayoutDashboard, ListPlus, Lock, Maximize2, PanelLeft, PanelRight,
  MessageSquare, Plus, Redo2, Save, Scissors, Shield, Trash2, Undo2, Upload, User, Zap,
} from 'lucide-react';
import { get, post, put, del, useFetch, useQuery, useEvents, OfficeEvent } from '../api';
import { Dot, Empty, Modal, PageHeader, StatusChip, Tag, act, fmtAgo, roleLabel, toast, useCurrentRun } from '../components';
import {
  COND_FIELDS, COND_OPS, EDGE_KINDS, EDGE_SHORT, NODE_TYPE_LABEL, PURPOSES, PURPOSE_LABEL, WfAuditRow, WfCondition,
  WfEdge, WfEdgeKind, WfEstimate, WfGraph, WfGuardrails, WfIssue, WfNode, WfNodeType, WfSimResult, WfTemplate,
  WorkflowRow, WorkflowVersionRow,
  WfValidation, condText, emptyGraph, insertOnEdge, layoutLR, nearestEdge, spliceOut, uid,
} from '../workflow';

// ---------------------------------------------------------------------------
// data shapes from the API
type WorkflowDetail = { workflow: WorkflowRow; versions: WorkflowVersionRow[]; graph: WfGraph | null; issues: WfValidation | null; estimate: WfEstimate | null; audit: WfAuditRow[] };
type AgentRow = { id: string; name: string; status?: string; accountId?: string; modelId?: string; model?: { backend?: string; model?: string; fallbacks?: unknown[] }; memberships?: { role?: string; workspace_id: string; active: number }[] };
type RoleRow = { id: string; name: string };
type SkillRow = { id: string; name: string; description?: string; enabled: number; owner_origin: string; latest_version_id?: string | null };
type SkillVersionRow = { id: string; skill_id: string; review_status: string; content?: string | null; hasContent?: boolean };
type SkillsData = { skills: SkillRow[]; versions: SkillVersionRow[] };
type SkillPreview = { applied: { skillId: string; name: string; chars: number; via: string }[]; skipped: { name: string; reason: string; via?: string }[]; used: number; budget: number };

// ---------------------------------------------------------------------------
// reactflow <-> workflow graph conversion
type RfData = { wf: WfNode; live?: { status: string; taskId?: string; agent?: string; since?: string; human?: boolean }; issues?: number; simVisited?: boolean; step?: number; prov?: string[]; provTitle?: string };

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
const NODE_W = 200;
const PILL_W = 120;

// Role colours reuse the app's pastel blocks so a step reads at a glance.
const ROLE_TINT: Record<string, string> = {
  pm: 'bg-lilac', 'prompt-creator': 'bg-cream', developer: 'bg-lime', qa: 'bg-mint',
  reviewer: 'bg-pink', analyst: 'bg-coral', docs: 'bg-cream',
};

// Palette entries: a soft wash of the same colours, so the list matches the nodes it creates.
const ROLE_SOFT: Record<string, string> = {
  pm: 'bg-lilac/30', 'prompt-creator': 'bg-cream/60', developer: 'bg-lime/30', qa: 'bg-mint/30',
  reviewer: 'bg-pink/40', analyst: 'bg-coral/30', docs: 'bg-cream/60',
};
const STEP_SOFT: Record<string, string> = { condition: 'bg-cream/60', merge: 'bg-lilac/30', human: 'bg-pink/40', end: 'bg-navy/10' };

const TYPE_ICON: Record<WfNodeType, React.ReactNode> = {
  start: <CirclePlay size={14} />, end: <Check size={14} />, agent: <User size={14} />,
  condition: <GitBranch size={14} />, merge: <GitMerge size={14} />, human: <Bell size={14} />,
};

// Plain-language one-liner under each step's name.
const TYPE_HINT: Partial<Record<WfNodeType, string>> = {
  start: 'The request comes in here',
  end: 'The work is accepted',
  condition: 'Chooses a path',
  human: 'Waits for you',
};

const SIDES: { id: string; pos: Position }[] = [
  { id: 'top', pos: Position.Top }, { id: 'right', pos: Position.Right },
  { id: 'bottom', pos: Position.Bottom }, { id: 'left', pos: Position.Left },
];
const HANDLE_CLS = 'wf-handle !w-3 !h-3 !bg-canvas !border-2 !border-fg-3 hover:!border-accent hover:!bg-accent !transition-colors';

// "Provider · model" for each agent a step can run on, from the agent's account and model.
type ProvData = { providers?: { id: string; name: string }[]; accounts?: { id: string; provider_id: string; label?: string }[]; models?: { id: string; name: string; label?: string }[] };
function providerInfo(wf: WfNode, agents: AgentRow[], wsId: string, pd: ProvData | null): { prov: string[]; provTitle: string } | null {
  if (wf.type !== 'agent') return null;
  const who = wf.agentId ? agents.filter((a) => a.id === wf.agentId)
    : wf.role ? agents.filter((a) => (a.memberships ?? []).some((m) => m.role === wf.role && m.active && m.workspace_id === wsId)) : [];
  if (!who.length) return { prov: [], provTitle: wf.role ? `No agent holds the "${wf.role}" role` : 'No agent chosen' };
  const lines: string[] = []; const detail: string[] = [];
  for (const a of who) {
    const acct = pd?.accounts?.find((x) => x.id === a.accountId);
    const prov = pd?.providers?.find((x) => x.id === acct?.provider_id)?.name ?? acct?.label ?? '';
    const m = pd?.models?.find((x) => x.id === a.modelId);
    const model = m?.label ?? m?.name ?? a.modelId?.split(':').pop() ?? '';
    const line = [prov, model].filter(Boolean).join(' · ') || 'no provider set';
    if (!lines.includes(line)) lines.push(line);
    const fb = a.model?.fallbacks?.length ?? 0;
    detail.push(`${a.name}: ${line}${fb ? ` (+${fb} fallback${fb > 1 ? 's' : ''})` : ''}`);
  }
  return { prov: lines, provTitle: detail.join('\n') };
}

const WfNodeView = React.memo(function WfNodeView({ data, selected }: NodeProps<RfData>) {
  const n = data.wf;
  const live = data.live;
  const err = (data.issues ?? 0) > 0;
  const isAgent = n.type === 'agent';
  const pill = n.type === 'start' || n.type === 'end';
  const [skillOver, setSkillOver] = useState(false);
  const tint = isAgent ? ROLE_TINT[n.role ?? ''] ?? 'bg-raised' : n.type === 'condition' ? 'bg-cream' : n.type === 'merge' ? 'bg-lilac' : n.type === 'human' ? 'bg-pink' : n.type === 'start' ? 'bg-mint' : 'bg-navy text-white';
  const ring = selected ? 'border-fg ring-2 ring-fg/20' : err ? 'border-bad' : 'border-line-strong';
  const liveCls = live?.status === 'running' ? 'ring-2 ring-info/40 border-info' : live?.status === 'failed' ? 'border-bad' : live?.status === 'done' ? 'border-ok' : '';
  const tone = live?.status === 'failed' ? 'bad' : live?.status === 'running' ? 'info' : 'ok';
  return (
    <div
      className={`group relative rounded-2xl border bg-surface shadow-pop transition-shadow ${ring} ${liveCls} ${n.config?.disabled ? 'opacity-55' : ''} ${data.simVisited ? 'outline outline-2 outline-accent/50' : ''} ${skillOver ? 'ring-2 ring-accent' : ''}`}
      style={{ width: pill ? PILL_W : NODE_W }}
      title={n.label}
      onDragOver={isAgent ? (ev) => { if (ev.dataTransfer.types.includes('application/x-officechain-skill')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; setSkillOver(true); } } : undefined}
      onDragLeave={isAgent ? () => setSkillOver(false) : undefined}
      onDrop={isAgent ? (ev) => {
        const raw = ev.dataTransfer.getData('application/x-officechain-skill');
        setSkillOver(false);
        if (!raw) return;
        ev.preventDefault(); ev.stopPropagation();
        const ref = JSON.parse(raw) as { skillId: string; name: string };
        skillDropOp(n.id, ref);
      } : undefined}
    >
      {SIDES.map((s) => <Handle key={s.id} id={s.id} type="source" position={s.pos} className={HANDLE_CLS} />)}
      {/* header strip: step number, kind of step, live state */}
      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-t-2xl ${tint} ${pill ? 'rounded-b-2xl justify-center' : ''}`}>
        {data.step != null && !pill && (
          <span className="grid place-items-center w-5 h-5 rounded-full bg-fg text-canvas text-[10px] font-semibold tabular-nums shrink-0" title={`Step ${data.step} in the flow`}>{data.step}</span>
        )}
        {TYPE_ICON[n.type]}
        <span className="text-[11px] font-medium truncate">{pill ? n.label : isAgent ? (n.role ? roleLabel(n.role) : 'Agent') : NODE_TYPE_LABEL[n.type]}</span>
        {live && <span className={`ml-auto flex items-center gap-1 text-2xs ${live.status === 'failed' ? 'text-bad' : live.status === 'running' ? 'text-info' : 'text-ok'}`}><Dot tone={tone} live={live.status === 'running'} />{live.status}</span>}
        {err && !live && <Dot tone="bad" className="ml-auto" />}
      </div>
      {!pill && (
        <div className="px-3 py-2.5">
          <div className="text-[13px] font-semibold leading-4 text-fg break-words line-clamp-2">{n.label || n.id}</div>
          {isAgent && data.prov && (
            <div className="mt-1 flex items-center gap-1 text-2xs text-fg-3 min-w-0" title={data.provTitle}>
              <Cpu size={10} className="shrink-0" />
              {data.prov.length ? <span className="truncate">{data.prov[0]}</span> : <span className="text-warn">no agent</span>}
              {data.prov.length > 1 && <span className="shrink-0 text-fg-4">+{data.prov.length - 1}</span>}
            </div>
          )}
          {isAgent ? (
            <div className="mt-1.5 flex items-center gap-1 flex-wrap">
              {n.config?.purpose && <Tag>{PURPOSE_LABEL[n.config.purpose] ?? n.config.purpose}</Tag>}
              {n.config?.writable === false && <Tag title="Read-only: this step never edits files">read-only</Tag>}
              {n.config?.disabled && <Tag title="Bypassed: the engine passes straight through this step">bypassed</Tag>}
              {(n.config?.skills?.length ?? 0) > 0 && <Tag title={`${n.config!.skills!.length} skill(s) attached to this step`}><BookMarked size={9} />{n.config!.skills!.length}</Tag>}
            </div>
          ) : (
            <div className="mt-0.5 text-2xs text-fg-3">
              {n.type === 'merge' ? `Waits for ${(n.config?.mergeMode ?? 'all') === 'all' ? 'all branches' : 'any branch'}` : TYPE_HINT[n.type]}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// custom edge — drawn from geometry the editor computes for the whole graph
// (see wfEdges.ts), with its label and an "insert a step here" button
function WfEdgeView({ id, data, selected, markerEnd }: EdgeProps) {
  const e: WfEdge = data.wf;
  const geo: EdgeGeo | undefined = data.geo;
  const taken: boolean = !!data.taken;
  const simTaken: boolean = !!data.simTaken;
  const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.next;
  if (!geo) return null;
  const label = e.else ? 'otherwise' : e.label ?? (e.condition ? condText(e.condition) : '');
  const showChip = e.kind !== 'next' || !!label;
  return (
    <>
      {/* wide invisible stroke: an easy target to click */}
      <path d={geo.path} fill="none" stroke="transparent" strokeWidth={18} className="react-flow__edge-interaction" />
      <g className={data.flowing ? 'wf-flowing' : undefined}>
      <BaseEdge
        id={id} path={geo.path} markerEnd={markerEnd}
        style={{
          stroke: taken ? 'rgb(var(--info))' : simTaken ? 'rgb(var(--accent))' : selected ? 'rgb(var(--fg))' : style.stroke,
          strokeWidth: selected ? 2.5 : taken || simTaken ? 2.25 : 1.75,
          strokeDasharray: data.flowing ? '8 5' : style.dash,
        }}
      />
      </g>
      <EdgeLabelRenderer>
        <div className="absolute pointer-events-auto" style={{ transform: `translate(-50%,-50%) translate(${geo.mx}px,${geo.my}px)` }}>
          <div className="group flex items-center gap-1">
            {showChip && (
              <span className={`chip !h-5 text-2xs max-w-[190px] truncate ${selected ? 'border-fg' : 'border-line'} ${taken ? 'border-info text-info' : style.tone} bg-canvas`} title={e.else ? 'Used when no other path matches' : label}>
                {e.kind === 'message' && <MessageSquare size={10} />}
                {e.kind === 'on-failure' && <Ban size={10} />}
                {e.kind === 'on-reject' && <Undo2 size={10} />}
                {e.kind === 'on-success' && <Check size={10} />}
                {label || EDGE_SHORT[e.kind]}
                {e.maxLoops != null && ` · up to ${e.maxLoops}×`}
              </span>
            )}
            {!data.ro && <button
              className="nodrag nopan hidden group-hover:inline-flex items-center justify-center w-5 h-5 rounded-full bg-fg text-canvas hover:bg-fg-2 shadow-pop"
              title="Insert a step on this line"
              onClick={(ev) => { ev.stopPropagation(); insertOnEdgeOp(id); }}
            >
              <Plus size={11} />
            </button>}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// The page registers its insert op here — keeps edge data free of callbacks.
let insertOnEdgeOp: (edgeId: string) => void = () => undefined;
// Same for a skill dropped onto a node.
let skillDropOp: (nodeId: string, ref: { skillId: string; name: string }) => void = () => undefined;

const nodeTypes = { wf: WfNodeView };
const edgeTypes = { wf: WfEdgeView };

// ---------------------------------------------------------------------------
// palette
function Palette({ agents, roles, wsId, skills }: { agents: AgentRow[]; roles: RoleRow[]; wsId: string; skills: SkillRow[] }) {
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
          <div className="px-1 text-2xs font-mono text-fg-4 mb-1 flex items-center gap-1.5"><span className={`h-2 w-2 rounded-sm ${ROLE_TINT[role] ?? 'bg-raised'}`} />{roleLabel(role)}</div>
          <div className="space-y-1">
            {list.map((a) => (
              <div
                key={a.id} draggable
                onDragStart={drag({ type: 'agent', agentId: a.id, role, label: `${a.name}` })}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border border-line ${ROLE_SOFT[role] ?? 'bg-raised'} cursor-grab active:cursor-grabbing hover:border-line-strong transition-colors`}
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
              className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border border-dashed border-line ${STEP_SOFT[g.type] ?? 'bg-raised/50'} cursor-grab active:cursor-grabbing hover:border-line-strong transition-colors`}
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
      {skills.length > 0 && (
        <div>
          <div className="field-label">Skills</div>
          <div className="space-y-1">
            {skills.map((s) => (
              <div
                key={s.id} draggable={!!s.enabled}
                onDragStart={(ev) => { ev.dataTransfer.setData('application/x-officechain-skill', JSON.stringify({ skillId: s.id, name: s.name })); ev.dataTransfer.effectAllowed = 'copy'; }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-lg border bg-raised transition-colors ${s.enabled ? 'border-line cursor-grab active:cursor-grabbing hover:border-line-strong' : 'border-line/50 opacity-50'}`}
                title={s.enabled ? 'Drag onto an agent node to attach' : 'Disabled — enable it on the Skills page'}
              >
                <BookMarked size={12} className="text-fg-3 shrink-0" />
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{s.name}</div>
                  {s.description && <div className="text-2xs text-fg-4 truncate">{s.description}</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="px-1 text-2xs text-fg-4 leading-4">Drag onto the canvas. Drop on an edge to insert between its ends. Drop a skill on an agent node to attach it.</div>
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
          <Select className="inp !h-6 !text-2xs flex-1 min-w-0" value={l.field ?? 'step.status'} onChange={(e) => update(i, { field: e.target.value })}>
            {COND_FIELDS.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
          </Select>
          <Select className="inp !h-6 !text-2xs w-[74px] shrink-0" value={l.op ?? 'eq'} onChange={(e) => update(i, { op: e.target.value as WfCondition['op'] })}>
            {COND_OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
          </Select>
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
  return <div className="mb-3 min-w-0"><span className="field-label truncate" title={label}>{label}</span>{children}</div>;
}

// ---------------------------------------------------------------------------
// node skills (Phase 3b) — attached refs live in the version's graph
function NodeSkills({ n, cfg, setCfg, roles, skillsData, reloadSkills, onApplyToRole }: {
  n: WfNode; cfg: NonNullable<WfNode['config']>; setCfg: (p: Partial<NonNullable<WfNode['config']>>) => void;
  roles: RoleRow[]; skillsData: SkillsData | null | undefined; reloadSkills: () => void; onApplyToRole: () => void;
}) {
  const nodeSkills = cfg.skills ?? [];
  const inherited = cfg.inheritSkills !== false && !cfg.skillsOnly;
  const roleId = roles.find((r) => r.name === n.role)?.id ?? null;
  const [prev, setPrev] = useState<SkillPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [q2, setQ2] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      post<SkillPreview>('/skills/node-preview', {
        skills: nodeSkills, agentId: n.agentId ?? '', roleId, kind: cfg.purpose ?? 'implement', taskText: '', inheritSkills: inherited,
      }).then(setPrev).catch(() => setPrev(null));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(nodeSkills), n.agentId, roleId, cfg.purpose, inherited]);

  const approvedVersion = (skillId: string) => skillsData?.versions.find((v) => v.skill_id === skillId && v.review_status === 'approved');
  const approvalOf = (s: SkillRow) => {
    const v = approvedVersion(s.id);
    if (v) return { state: 'approved' as const, versionId: v.id, size: v.content?.length ?? 0 };
    if (s.owner_origin === 'imported') return { state: 'waiting' as const, versionId: undefined, size: 0 };
    return { state: 'none' as const, versionId: undefined, size: 0 };
  };
  const attach = (s: SkillRow) => {
    const ap = approvalOf(s);
    setCfg({ skills: [...nodeSkills, { skillId: s.id, name: s.name, versionId: ap.versionId }] });
    setAdding(false); setQ2('');
    if (ap.state === 'waiting') toast(`"${s.name}" is imported but not approved yet — it won't be delivered until then`, 'warn');
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= nodeSkills.length) return;
    const next = [...nodeSkills];
    [next[i], next[j]] = [next[j], next[i]];
    setCfg({ skills: next });
  };
  const createHere = async () => {
    const name = prompt('Skill name', 'my-skill');
    if (!name) return;
    const instructions = prompt(`Instructions for "${name}" (one line is fine)`, '');
    if (!instructions) return;
    const r = await act(post<{ skillId: string; versionId: string }>('/skills', { name, instructions }), 'Skill created and attached to this node');
    if (r) { setCfg({ skills: [...nodeSkills, { skillId: r.skillId, name, versionId: r.versionId }] }); reloadSkills(); }
  };
  const importHere = async () => {
    const dir = prompt('Folder containing a SKILL.md (or a folder of skill folders)', '');
    if (!dir) return;
    const r = await post<{ imported: { skillId: string; name: string; findings: string[] }[]; errors: string[] }>('/skills/import', { path: dir }).catch((e) => { toast(String(e?.message ?? e), 'bad'); return null; });
    if (!r) return;
    reloadSkills();
    if (r.imported.length) setCfg({ skills: [...nodeSkills, ...r.imported.map((imp) => ({ skillId: imp.skillId, name: imp.name }))] });
    for (const imp of r.imported) {
      toast(`Imported "${imp.name}"${imp.findings.length ? ` — ${imp.findings.length} scan finding(s)` : ''}. Review and approve it on the Skills page; until then it shows "waiting for approval".`, imp.findings.length ? 'warn' : 'info');
    }
    if (r.errors.length) toast(`${r.errors.length} folder(s) failed to import`, 'bad');
  };

  const estTokens = (chars: number) => `~${Math.ceil(chars / 4)} tok`;
  const attachable = (skillsData?.skills ?? []).filter((s) => !nodeSkills.some((x) => x.skillId === s.id))
    .filter((s) => !q2 || s.name.toLowerCase().includes(q2.toLowerCase()) || (s.description ?? '').toLowerCase().includes(q2.toLowerCase()));
  const applied = prev?.applied ?? [];
  const inheritedRows = [
    ...applied.filter((a) => a.via !== 'node').map((a) => ({ name: a.name, via: a.via, note: estTokens(a.chars), dim: false })),
    ...(prev?.skipped ?? []).filter((s) => s.via && s.via !== 'node').map((s) => ({ name: s.name, via: s.via, note: s.reason, dim: true })),
  ];

  return (
    <div className="border-t border-line pt-3 mt-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="field-label !mb-0">Skills</span>
        <span className="text-2xs text-fg-4">{nodeSkills.length} attached</span>
        <button className="btn btn-ghost btn-xs ml-auto" onClick={() => setAdding((x) => !x)}><Plus size={11} /> Add</button>
      </div>

      {nodeSkills.length === 0 && <div className="text-2xs text-fg-4 mb-2">No node skills — the agent's role and own attachments apply.</div>}
      <div className="space-y-1 mb-2">
        {nodeSkills.map((ref, i) => {
          const s = skillsData?.skills.find((x) => x.id === ref.skillId);
          const ap = applied.find((a) => a.skillId === ref.skillId);
          const skip = (prev?.skipped ?? []).find((x) => x.name === ref.name && x.via === 'node');
          const waiting = s && approvalOf(s).state === 'waiting';
          return (
            <div key={ref.skillId} className="flex items-center gap-1.5 px-2 py-1 rounded-lg border border-line bg-raised">
              <BookMarked size={11} className="text-accent shrink-0" />
              <span className="text-xs font-medium truncate flex-1" title={s?.description ?? ref.name}>{ref.name}</span>
              <span className="chip !h-4 !px-1 text-[9px] border-accent/30 text-accent">node</span>
              {waiting && <span className="chip !h-4 !px-1 text-[9px] border-warn/30 text-warn" title="Imported — not approved yet">waiting</span>}
              {ap && <span className="text-2xs text-fg-4" title={`${ap.chars} chars`}>{estTokens(ap.chars)}</span>}
              {skip && <span className="text-2xs text-warn truncate max-w-[90px]" title={skip.reason}>{skip.reason}</span>}
              <button className="btn btn-ghost btn-icon !h-5 !w-5" disabled={i === 0} onClick={() => move(i, -1)} title="Earlier — wins the budget"><ArrowUp size={10} /></button>
              <button className="btn btn-ghost btn-icon !h-5 !w-5" disabled={i === nodeSkills.length - 1} onClick={() => move(i, 1)} title="Later"><ArrowDown size={10} /></button>
              <button className="btn btn-ghost btn-icon !h-5 !w-5" onClick={() => setCfg({ skills: nodeSkills.filter((x) => x.skillId !== ref.skillId) })} title="Remove"><Trash2 size={10} /></button>
            </div>
          );
        })}
      </div>

      {adding && (
        <div className="card !bg-canvas p-2 mb-2 space-y-1">
          <input className="inp !h-6 !text-2xs" placeholder="search skills…" value={q2} onChange={(e) => setQ2(e.target.value)} autoFocus />
          <div className="max-h-36 overflow-auto space-y-0.5">
            {attachable.map((s) => {
              const ap = approvalOf(s);
              return (
                <button key={s.id} className="w-full text-left px-2 py-1 rounded hover:bg-raised flex items-center gap-2" onClick={() => attach(s)}>
                  <span className="text-xs truncate flex-1">{s.name}</span>
                  {!s.enabled && <span className="chip !h-4 !px-1 text-[9px] border-line text-fg-4">disabled</span>}
                  {ap.state === 'waiting' && <span className="chip !h-4 !px-1 text-[9px] border-warn/30 text-warn">needs approval</span>}
                  {ap.state === 'approved' && <span className="text-2xs text-fg-4">{estTokens(ap.size)}</span>}
                </button>
              );
            })}
            {!attachable.length && <div className="px-2 py-1 text-2xs text-fg-4">No other skills.</div>}
          </div>
          <div className="flex gap-1.5 pt-1">
            <button className="btn btn-ghost btn-xs" onClick={() => void createHere()}><Plus size={10} /> New skill</button>
            <button className="btn btn-ghost btn-xs" onClick={() => void importHere()}><Upload size={10} /> Import folder…</button>
          </div>
        </div>
      )}

      {prev && (
        <div className="mb-2" title="Skill text budget for one prompt">
          <div className="flex justify-between text-2xs text-fg-4 mb-0.5">
            <span>skill budget</span><span>{Math.round((prev.used / prev.budget) * 100)}% · {prev.used.toLocaleString()}/{prev.budget.toLocaleString()} chars</span>
          </div>
          <div className="h-1.5 rounded bg-line overflow-hidden"><div className={`h-full ${prev.used / prev.budget > 0.9 ? 'bg-bad' : 'bg-accent'}`} style={{ width: `${Math.min(100, (prev.used / prev.budget) * 100)}%` }} /></div>
        </div>
      )}

      {inheritedRows.length > 0 && (
        <div className="mb-2">
          <div className="text-2xs text-fg-4 mb-1">From the agent / role</div>
          <div className="space-y-0.5">
            {inheritedRows.map((r, i) => (
              <div key={i} className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-2xs ${r.dim ? 'opacity-50' : 'opacity-70'}`}>
                <BookMarked size={10} className="text-fg-4 shrink-0" />
                <span className="truncate flex-1">{r.name}</span>
                <span className="chip !h-4 !px-1 text-[9px] border-line text-fg-4">{r.via}</span>
                <span className="text-fg-4 truncate max-w-[110px]" title={r.note}>{r.note}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-xs mb-1.5 cursor-pointer">
        <input type="checkbox" checked={cfg.inheritSkills !== false} onChange={(e) => setCfg({ inheritSkills: e.target.checked ? undefined : false })} />
        Inherit the agent's and role's skills
      </label>
      <label className="flex items-center gap-2 text-xs mb-2 cursor-pointer">
        <input type="checkbox" checked={!!cfg.skillsOnly} onChange={(e) => setCfg({ skillsOnly: e.target.checked || undefined })} />
        Skills only — send only this node's skills
      </label>
      {n.role && nodeSkills.length > 0 && (
        <button className="btn btn-ghost btn-xs" onClick={onApplyToRole} title="Copy this node's skill list to every node with the same role">
          Apply to all {roleLabel(n.role)} nodes
        </button>
      )}
    </div>
  );
}

function NodeInspector({ node, agents, roles, wsId, allNodes, onChange, onDelete, onOpenTask, skillsData, reloadSkills, onApplyToRole }: {
  node: Node<RfData>; agents: AgentRow[]; roles: RoleRow[]; wsId: string;
  allNodes: Node<RfData>[]; onChange: (wf: WfNode) => void; onDelete: () => void; onOpenTask: () => void;
  skillsData: SkillsData | null | undefined; reloadSkills: () => void; onApplyToRole: () => void;
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
              <Select className="inp" value={n.role ?? ''} onChange={(e) => set({ role: e.target.value || undefined, agentId: undefined })}>
                <option value="">— pick —</option>
                {roles.map((r) => <option key={r.id} value={r.name}>{roleLabel(r.name)}</option>)}
              </Select>
            </Field>
            <Field label="Pinned agent">
              <Select className="inp" value={n.agentId ?? ''} onChange={(e) => set({ agentId: e.target.value || undefined })}>
                <option value="">any in role</option>
                {wsAgents.filter((a) => !n.role || (a.memberships ?? []).some((m) => m.role === n.role && m.workspace_id === wsId)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Purpose">
              <Select className="inp" value={cfg.purpose ?? 'custom'} onChange={(e) => setCfg({ purpose: e.target.value })}>
                {PURPOSES.map((p) => <option key={p} value={p}>{PURPOSE_LABEL[p] ?? p}</option>)}
              </Select>
            </Field>
            <Field label="Scope">
              <Select className="inp" value={cfg.scope ?? 'task'} onChange={(e) => setCfg({ scope: e.target.value as 'task' | 'run' })}>
                <option value="task">per task</option>
                <option value="run">once per run</option>
              </Select>
            </Field>
          </div>
          <Field label="Instructions (added to the prompt)">
            <textarea className="inp min-h-[64px] text-xs" value={cfg.instructions ?? ''} placeholder="e.g. only touch files under src/" onChange={(e) => setCfg({ instructions: e.target.value || undefined })} />
          </Field>
          <div className="grid grid-cols-2 gap-x-2">
            <Field label="Model tier">
              <Select className="inp" value={cfg.modelTier ?? ''} onChange={(e) => setCfg({ modelTier: (e.target.value || undefined) as 'fast' | 'standard' | 'strong' | undefined })}>
                <option value="">auto</option><option value="fast">fast</option><option value="standard">standard</option><option value="strong">strong</option>
              </Select>
            </Field>
            <Field label="Budget (chars)"><input className="inp" type="number" min={0} value={cfg.budgetChars ?? ''} placeholder="auto" onChange={(e) => setCfg({ budgetChars: e.target.value ? Number(e.target.value) : undefined })} /></Field>
            <Field label="Timeout (min)"><input className="inp" type="number" min={0} value={cfg.timeoutMin ?? ''} placeholder="auto" onChange={(e) => setCfg({ timeoutMin: e.target.value ? Number(e.target.value) : undefined })} /></Field>
          </div>
          <label className="flex items-start gap-2 text-xs cursor-pointer mb-3">
            <input type="checkbox" className="mt-0.5" checked={!!cfg.disabled} onChange={(e) => setCfg({ disabled: e.target.checked || undefined })} />
            <span>Bypassed — the engine passes through this step without dispatching<span className="block text-fg-4 mt-0.5">The step stays on the canvas, greyed on Routing, and still counts for structure (merge arrivals, edges).</span></span>
          </label>
          <Field label="Inputs — what the prompt carries">
            <Select className="inp" value={inputsMode} onChange={(e) => {
              const v = e.target.value;
              setCfg({ inputs: v === 'named' ? [] : (v as 'envelope' | 'full') });
            }}>
              <option value="envelope">hand-off envelope (default)</option>
              <option value="full">full previous output</option>
              <option value="named">outputs of specific earlier nodes</option>
            </Select>
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
          <NodeSkills
            n={n} cfg={cfg} setCfg={setCfg} roles={roles}
            skillsData={skillsData} reloadSkills={reloadSkills} onApplyToRole={onApplyToRole}
          />
        </>
      )}
      {n.type === 'merge' && (
        <Field label="Wait for">
          <Select className="inp" value={cfg.mergeMode ?? 'all'} onChange={(e) => setCfg({ mergeMode: e.target.value as 'all' | 'any' })}>
            <option value="all">all incoming branches</option>
            <option value="any">the first branch to arrive</option>
          </Select>
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
        <Select className="inp" value={e.kind} onChange={(ev) => set({ kind: ev.target.value as WfEdgeKind })}>
          {EDGE_KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.kind} — {k.hint}</option>)}
        </Select>
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
  const { office } = useOffice();
  const ws = workspaces?.find((w) => w.id === (office?.id ?? run?.workspaceId)) ?? workspaces?.[0];
  const wsId = ws?.id ?? '';
  const { data: wflist, reload: reloadList } = useQuery<WorkflowRow[]>(wsId ? `/workflows?workspaceId=${wsId}` : null);
  const { data: agents } = useQuery<AgentRow[]>('/agents');
  const { data: provData } = useQuery<ProvData>('/providers');
  const { data: roles } = useQuery<RoleRow[]>('/roles');
  const { data: skillsData, reload: reloadSkills } = useQuery<SkillsData>('/skills');

  const [wfId, setWfId] = useState<string | null>(null);
  const { data: detail, reload: reloadDetail } = useFetch<WorkflowDetail>(wfId ? `/workflows/${wfId}` : null, [wfId]);
  const builtin = !!detail?.workflow.builtin;
  const readOnly = builtin;

  const [nodes, setNodes, onNodesChange] = useNodesState<RfData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selEdges, setSelEdges] = useState<string[]>([]);
  const [issues, setIssues] = useState<WfIssue[]>([]);
  const [estimate, setEstimate] = useState<WfEstimate | null>(null);
  const [guardrails, setGuardrails] = useState<WfGuardrails>({});
  const [dirty, setDirty] = useState(false);
  const [draftBanner, setDraftBanner] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showSim, setShowSim] = useState(false);
  const [sim, setSim] = useState<WfSimResult | null>(null);
  const [simOutcomes, setSimOutcomes] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const { data: templates } = useQuery<WfTemplate[]>('/workflows/templates');

  const { screenToFlowPosition, fitView } = useReactFlow();
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth >= 1100);
  const [rightOpen, setRightOpen] = useState(() => window.innerWidth >= 1400);
  const [legendOpen, setLegendOpen] = useState(() => window.innerWidth >= 1500);
  const [hintOpen, setHintOpen] = useState(() => { try { return localStorage.getItem('wf-hint-dismissed') !== '1'; } catch { return true; } });
  // the canvas changes size when a side panel opens or closes: refit so the graph uses the room
  useEffect(() => { const t = setTimeout(() => fitView({ padding: 0.14, maxZoom: 1, duration: 200 }), 60); return () => clearTimeout(t); }, [leftOpen, rightOpen, fitView]);
  // switching workflows (or the first load of one): show the whole flow
  useEffect(() => {
    if (!detail?.workflow.id) return;
    const t = setTimeout(() => fitView({ padding: 0.14, maxZoom: 1, duration: 200 }), 220);
    return () => clearTimeout(t);
  }, [detail?.workflow.id, fitView]);
  const dismissHint = () => { setHintOpen(false); try { localStorage.setItem('wf-hint-dismissed', '1'); } catch { /* private mode */ } };

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
  const currentGraph = useCallback((): WfGraph => ({ ...toWfGraph(nodes, edges), guardrails: Object.keys(guardrails).length ? guardrails : undefined }), [nodes, edges, guardrails]);
  const applyGraph = useCallback((g: WfGraph, markDirty = true) => {
    setNodes(toRfNodes(g)); setEdges(toRfEdges(g)); setGuardrails(g.guardrails ?? {});
    if (markDirty) setDirty(true);
  }, [setNodes, setEdges]);
  const mutate = useCallback((f: (g: WfGraph) => WfGraph) => {
    if (readOnly) { toast('The standard pipeline is read-only. Clone it to change it.'); return; }
    pushHistory(); applyGraph(f(currentGraph()));
  }, [readOnly, pushHistory, applyGraph, currentGraph]);

  // ---- load workflow detail into canvas ----
  // detail refetches on every ws tick — re-applying the same graph would
  // wipe selection and in-progress layout, so only re-apply when the
  // graph content actually changed
  const loadedGraph = useRef<string>('');
  useEffect(() => {
    if (!detail) return;
    const json = JSON.stringify(detail.graph ?? emptyGraph());
    if (json === loadedGraph.current) return;
    loadedGraph.current = json;
    past.current = []; future.current = [];
    const draftKey = `wf-draft:${detail.workflow.id}`;
    const draft = !builtin ? localStorage.getItem(draftKey) : null;
    if (draft) {
      try { applyGraph(JSON.parse(draft).graph as WfGraph, false); setDraftBanner(true); setDirty(true); return; } catch { /* fall through */ }
    }
    if (builtin && detail.graph) {
      // read-only graph: arrange it for reading, then apply the layout you last left it in (kept in this browser only)
      let laid = layoutLR(detail.graph);
      try {
        const saved = JSON.parse(localStorage.getItem(`wf-view:${detail.workflow.id}`) ?? 'null') as Record<string, { x: number; y: number }> | null;
        if (saved) laid = { ...laid, nodes: laid.nodes.map((n) => (saved[n.id] ? { ...n, position: saved[n.id] } : n)) };
      } catch { /* ignore a corrupt view */ }
      applyGraph(laid, false);
    } else applyGraph(detail.graph ?? emptyGraph(), false);
    setDraftBanner(false); setDirty(false); setIssues(detail.issues?.issues ?? []); setEstimate(detail.estimate ?? null);
    setSim(null);
  }, [detail, builtin]); // eslint-disable-line react-hooks/exhaustive-deps


  // deep link: /workflow?node=<id> (from Routing's step cards) selects the
  // node — switching to the active workflow first when another is open
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const wanted = searchParams.get('node');
    if (!wanted || !detail || !wflist) return;
    if (!nodes.length) return;   // canvas still loading — wait for the next render
    // apply a real select change — ReactFlow owns the selected flag, so a
    // bare setSelNodes would be cleared by the next onSelectionChange
    if (nodes.some((n) => n.id === wanted)) {
      setNodes((ns) => applyNodeChanges([{ id: wanted, type: 'select', selected: true }], ns));
      setSearchParams({}, { replace: true }); return;
    }
    const activeWf = wflist.find((w) => w.active);
    if (activeWf && activeWf.id !== wfId) setWfId(activeWf.id);   // keep the param — retry once it loads
    else setSearchParams({}, { replace: true });
  }, [searchParams, detail, nodes, wflist, wfId, setSearchParams, setNodes]);

  // ---- live validation (debounced) ----
  useEffect(() => {
    if (!nodes.length || !wsId) return;
    const t = setTimeout(() => {
      post<WfValidation & { estimate?: WfEstimate }>('/workflows/validate', { graph: currentGraph(), workspaceId: wsId })
        .then((v) => { setIssues(v.issues ?? []); setEstimate(v.estimate ?? null); })
        .catch(() => undefined);
    }, 450);
    return () => clearTimeout(t);
  }, [nodes, edges, wsId, guardrails]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- autosave draft ----
  useEffect(() => {
    if (!dirty || !wfId || builtin) return;
    const t = setTimeout(() => localStorage.setItem(`wf-draft:${wfId}`, JSON.stringify({ graph: currentGraph(), at: Date.now() })), 800);
    return () => clearTimeout(t);
  }, [dirty, wfId, builtin, nodes, edges]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live view ----
  const versionIds = useMemo(() => new Set((detail?.versions ?? []).map((v) => v.id)), [detail]);
  const { data: runs } = useQuery<any[]>('/runs');
  // first open: show the workflow the current (or any running) request picked, else the active one
  useEffect(() => { setWfId(null); }, [wsId]);
  useEffect(() => {
    if (wfId || !wflist?.length || runs == null) return;
    if (wflist[0].workspaceId !== wsId) return;   // still the previous office's list
    const going = (r: any) => ['running', 'verifying', 'pausing', 'paused', 'dod-review', 'draft'].includes(r.status) && r.workflow?.id && wflist.some((w) => w.id === r.workflow.id);
    const pick = runs.find((r) => r.id === run?.id && going(r)) ?? runs.find(going);
    setWfId(pick?.workflow?.id ?? wflist.find((w) => w.active)?.id ?? wflist[0].id);
  }, [wflist, wfId, runs, run?.id, wsId]);
  // Only an ongoing run of the picked workflow drives the live bar and the node states; finished runs
  // are replayed from Run replay, so a flow nobody is running shows as a plain graph.
  const ONGOING = ['running', 'verifying', 'pausing', 'paused', 'dod-review', 'draft'];
  const wfRuns = useMemo(() => (runs ?? []).filter((r) => ONGOING.includes(r.status) && (r.workflow ? r.workflow.id === wfId : !!r.workflowVersionId && versionIds.has(r.workflowVersionId))), [runs, versionIds, wfId]);
  const liveRunId = wfRuns.find((r) => r.id === run?.id)?.id ?? wfRuns[0]?.id ?? null;
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  useEffect(() => { setPickedRun(null); }, [wfId]);
  const liveRun = pickedRun && wfRuns.some((r) => r.id === pickedRun) ? pickedRun : liveRunId;
  const { data: runEvents } = useFetch<OfficeEvent[]>(
    liveRun ? `/runs/${liveRun}/events?types=${encodeURIComponent('workflow.step,workflow.branch,workflow.loop,workflow.enter')}` : null, [liveRun]);

  const liveRunObj = (runs ?? []).find((r) => r.id === liveRun) ?? null;
  const runGoing = !!liveRunObj && ONGOING.includes(liveRunObj.status);
  const { data: runDetail } = useQuery<any>(liveRun ? `/runs/${liveRun}` : null, [liveRun]);
  const [liveWs, setLiveWs] = useState<OfficeEvent[]>([]);
  useEffect(() => { setLiveWs([]); }, [liveRun]);
  useEvents(useCallback((e: OfficeEvent) => {
    if (!e.type.startsWith('workflow.') || e.runId !== liveRun) return;
    if (['workflow.step', 'workflow.branch', 'workflow.loop', 'workflow.enter'].includes(e.type)) {
      setLiveWs((xs) => (xs.length > 300 ? [...xs.slice(-200), e] : [...xs, e]));
    }
  }, [liveRun]));

  const live = useMemo(() => {
    const nodeStatus = new Map<string, { status: string; taskId?: string; at: number; agent?: string; since?: string; human?: boolean }>();
    const taken = new Set<string>();
    const mark = (evs: OfficeEvent[]) => {
      for (const e of evs) {
        const p = e.payload as Record<string, unknown>;
        if (e.type === 'workflow.step' && p.nodeId) {
          const cur = nodeStatus.get(String(p.nodeId));
          const status = p.done ? 'done' : 'running';
          if (!cur || cur.status !== 'running' || status === 'done') {
            nodeStatus.set(String(p.nodeId), {
              status, taskId: p.taskId as string | undefined, at: e.seq,
              agent: (p.agent as string | undefined) ?? cur?.agent,
              since: status === 'running' ? e.ts : cur?.since,
              human: !!p.human,
            });
          }
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
          for (const nid of p.nodes as string[]) if (!nodeStatus.has(nid)) nodeStatus.set(nid, { status: 'running', taskId: p.taskId as string | undefined, at: e.seq, since: e.ts });
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
  // order in which the flow reaches each step (breadth-first from Start, message lines excluded)
  const flowRank = useMemo(() => {
    const rank = new Map<string, number>();
    const start = nodes.find((n) => n.data.wf.type === 'start') ?? nodes[0];
    if (!start) return rank;
    const out = new Map<string, string[]>();
    for (const e of edges) {
      if (e.data.wf.kind === 'message') continue;
      const l = out.get(e.source); if (l) l.push(e.target); else out.set(e.source, [e.target]);
    }
    const q = [start.id]; rank.set(start.id, 0);
    while (q.length) {
      const id = q.shift()!;
      for (const t of out.get(id) ?? []) if (!rank.has(t)) { rank.set(t, rank.size); q.push(t); }
    }
    return rank;
  }, [nodes, edges]);
  const liveStable = useRef(new Map<string, { status: string; taskId?: string; agent?: string; since?: string; human?: boolean }>());
  const dNodes = useMemo(() => {
    const prev = liveStable.current;
    const next = new Map<string, { status: string; taskId?: string; agent?: string; since?: string; human?: boolean }>();
    for (const [id, l0] of live.nodeStatus) {
      const l = l0.status === 'running' && !runGoing ? { ...l0, status: 'stopped' } : l0;
      const p = prev.get(id);
      next.set(id, p && p.status === l.status && p.taskId === l.taskId && p.agent === l.agent && p.human === l.human ? p : l);
    }
    liveStable.current = next;
    const simVisited = new Set(sim?.steps.map((s) => s.nodeId) ?? []);
    return nodes.map((n) => {
      const l = next.get(n.id); const iss = issueMap.get(n.id) ?? 0;
      const sv = simVisited.has(n.id) || undefined;
      const step = n.data.wf.type === 'start' || n.data.wf.type === 'end' ? undefined : flowRank.get(n.id);
      const pi = providerInfo(n.data.wf, agents ?? [], wsId, provData);
      const prov = pi ? (n.data.prov && n.data.provTitle === pi.provTitle && n.data.prov.join('|') === pi.prov.join('|') ? n.data.prov : pi.prov) : undefined;
      if (n.data.live === l && n.data.issues === iss && n.data.simVisited === sv && n.data.step === step && n.data.prov === prov && n.data.provTitle === pi?.provTitle) return n;
      return { ...n, data: { ...n.data, live: l, issues: iss, simVisited: sv, step, prov, provTitle: pi?.provTitle } };
    });
  }, [nodes, live, issueMap, sim, flowRank, runGoing, agents, provData, wsId]);
  // where each line attaches (side of each node), computed for the whole graph so lines fan out instead of tangling
  const geoPrev = useRef(new Map<string, EdgeGeo>());
  const edgeGeo = useMemo(() => {
    const rects = new Map<string, { x: number; y: number; w: number; h: number }>();
    for (const n of nodes) {
      const pill = n.data.wf.type === 'start' || n.data.wf.type === 'end';
      rects.set(n.id, { x: n.position.x, y: n.position.y, w: n.width ?? (pill ? PILL_W : NODE_W), h: n.height ?? (pill ? 32 : 78) });
    }
    const fresh = layoutEdges(rects, edges.map((e) => {
      const kind = e.data.wf.kind;
      const back = (kind === 'on-reject' || kind === 'on-failure') && (flowRank.get(e.target) ?? 1e9) <= (flowRank.get(e.source) ?? -1);
      return { id: e.id, source: e.source, target: e.target, back };
    }));
    const prev = geoPrev.current;
    for (const [id, g] of fresh) {   // keep identity when nothing moved, so untouched lines don't re-render
      const o = prev.get(id);
      if (o && o.path === g.path && o.mx === g.mx && o.my === g.my) fresh.set(id, o);
    }
    geoPrev.current = fresh;
    return fresh;
  }, [nodes, edges, flowRank]);
  const dEdges = useMemo(() => edges.map((e) => {
    const taken = live.taken.has(e.id) || undefined;
    const simTaken = (sim ? new Set(sim.takenEdges) : new Set()).has(e.id) || undefined;
    const geo = edgeGeo.get(e.id);
    const flowing = (taken && runGoing && live.nodeStatus.get(e.target)?.status === 'running') || undefined;
    const ro = readOnly || undefined;
    if (e.data.taken === taken && e.data.simTaken === simTaken && e.data.geo === geo && e.data.flowing === flowing && e.data.ro === ro) return e;
    return { ...e, data: { ...e.data, taken, simTaken, geo, flowing, ro } };
  }), [edges, live, sim, edgeGeo, runGoing, readOnly]);

  const focusNode = useCallback((id: string) => {
    setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
    setSelNodes([id]); setSelEdges([]);
    fitView({ nodes: [{ id }], duration: 300, maxZoom: 1, padding: 1.2 });
  }, [setNodes, fitView]);
  const [clock, setClock] = useState(() => Date.now());
  const working = useMemo(() => dNodes.filter((n) => n.data.live?.status === 'running'), [dNodes]);
  useEffect(() => {
    if (!working.length) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working.length]);
  const lastDone = useMemo(() => {
    let best: { label: string; at: number } | null = null;
    for (const [id, l] of live.nodeStatus) {
      if (l.status !== 'done') continue;
      const n = nodes.find((x) => x.id === id);
      if (n && (!best || l.at > best.at)) best = { label: n.data.wf.label, at: l.at };
    }
    return best;
  }, [live, nodes]);
  const taskTitle = (id?: string) => (id ? (runDetail?.tasks ?? []).find((t: any) => t.id === id)?.title as string | undefined : undefined);
  const elapsed = (since?: string) => {
    if (!since) return '';
    const sec = Math.max(0, Math.round((clock - Date.parse(since)) / 1000));
    return sec >= 3600 ? `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m` : sec >= 60 ? `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s` : `${sec}s`;
  };
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

  // skill dropped onto a node — append the ref to that node's config
  useEffect(() => {
    skillDropOp = (nodeId, ref) => {
      if (readOnly) return;
      pushHistory();
      setNodes((ns) => ns.map((x) => {
        if (x.id !== nodeId) return x;
        const wf = x.data.wf;
        const cur = wf.config?.skills ?? [];
        if (cur.some((s) => s.skillId === ref.skillId)) return x;
        const sv = skillsData?.skills.find((s) => s.id === ref.skillId);
        const versionId = skillsData?.versions.find((v) => v.skill_id === ref.skillId && v.review_status === 'approved')?.id;
        if (sv && sv.owner_origin === 'imported' && !versionId) toast(`"${ref.name}" is waiting for approval`, 'warn');
        return { ...x, data: { ...x.data, wf: { ...wf, config: { ...wf.config, skills: [...cur, { skillId: ref.skillId, name: ref.name, versionId }] } } } };
      }));
      setDirty(true);
      setSelNodes([nodeId]); setSelEdges([]);
    };
    return () => { skillDropOp = () => undefined; };
  }, [readOnly, pushHistory, setNodes, skillsData]);

  // "apply to all nodes with this role" — copies the source node's skill config
  const applySkillsToRole = useCallback((sourceNodeId: string) => {
    const src = nodes.find((x) => x.id === sourceNodeId)?.data.wf;
    if (!src?.role) return;
    const skCfg = { skills: src.config?.skills, inheritSkills: src.config?.inheritSkills, skillsOnly: src.config?.skillsOnly };
    pushHistory();
    setNodes((ns) => ns.map((x) => (x.data.wf.role === src.role && x.data.wf.type === 'agent'
      ? { ...x, data: { ...x.data, wf: { ...x.data.wf, config: { ...x.data.wf.config, ...skCfg } } } } : x)));
    setDirty(true);
    toast(`Skill config applied to all ${roleLabel(src.role)} nodes`);
  }, [nodes, pushHistory, setNodes]);

  // loose mode lets a line start from any of a node's four dots; the direction is still start -> end
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const isValidConnection = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return false;
    const type = (id: string) => nodesRef.current.find((n) => n.id === id)?.data.wf.type;
    return type(c.source) !== 'end' && type(c.target) !== 'start';
  }, []);
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || !isValidConnection(c)) return;
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
  }, [mutate, isValidConnection]);

  const onDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    const raw = ev.dataTransfer.getData('application/x-officechain-node');
    if (raw && readOnly) { toast('The standard pipeline is read-only. Clone it to add steps.'); return; }
    if (!raw) return;
    const p = JSON.parse(raw) as { type: WfNodeType; agentId?: string; role?: string; label: string };
    const pos = screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    pos.x = Math.round(pos.x / 20) * 20 - 100; pos.y = Math.round(pos.y / 20) * 20 - 40;
    mutate((g) => {
      const node: WfNode = {
        id: uid('n'), type: p.type, label: p.label,
        agentId: p.agentId, role: p.role,
        config: p.type === 'agent' ? { purpose: 'custom' } : p.type === 'merge' ? { mergeMode: 'all' } : undefined,
        position: pos,
      };
      const near = nearestEdge(g, { x: pos.x + 100, y: pos.y + 40 }, 80);
      return near ? insertOnEdge(g, near.id, node) : { ...g, nodes: [...g.nodes, node] };
    });
  }, [readOnly, screenToFlowPosition, mutate]);

  const dragSnapshot = useRef<string | null>(null);
  const onNodeDragStart = useCallback(() => { dragSnapshot.current = snapshot(); }, [snapshot]);
  const onNodeDragStop = useCallback((_e: React.MouseEvent, node: Node<RfData>) => {
    if (readOnly) {
      // moving steps on the standard pipeline only changes how you see it: remember it here, don't touch the workflow
      dragSnapshot.current = null;
      if (wfId) {
        try {
          const cur = JSON.parse(localStorage.getItem(`wf-view:${wfId}`) ?? '{}') as Record<string, { x: number; y: number }>;
          cur[node.id] = { x: node.position.x, y: node.position.y };
          localStorage.setItem(`wf-view:${wfId}`, JSON.stringify(cur));
        } catch { /* private mode */ }
      }
      return;
    }
    // a click reports as a drag with no real movement — without this guard a
    // click near an edge splices the node out of the graph by accident
    const before = dragSnapshot.current ? (JSON.parse(dragSnapshot.current) as { n: Node<RfData>[] }) : null;
    const prev = before?.n.find((n) => n.id === node.id)?.position;
    if (prev && Math.abs(prev.x - node.position.x) < 6 && Math.abs(prev.y - node.position.y) < 6) { dragSnapshot.current = null; return; }
    const g = currentGraph();
    const near = nearestEdge(g, { x: node.position.x + 100, y: node.position.y + 40 }, 70, node.id);
    // splicing is only unambiguous on a chain node — a node with several
    // in/out edges gets a plain move instead of losing its other links
    const multiDegree = g.edges.filter((e) => e.to === node.id && e.kind !== 'message').length > 1
      || g.edges.filter((e) => e.from === node.id && e.kind !== 'message').length > 1;
    if (near && !multiDegree) {
      mutate((g2) => {
        const wn = g2.nodes.find((n) => n.id === node.id);
        return wn ? insertOnEdge(spliceOut(g2, node.id), near.id, { ...wn, position: node.position }) : g2;
      });
    } else if (dragSnapshot.current) {
      past.current.push(dragSnapshot.current);   // pre-drag state — undo restores it
      future.current = [];
    }
    dragSnapshot.current = null;
  }, [readOnly, wfId, currentGraph, mutate]);

  const tidyUp = useCallback(() => {
    if (readOnly) {
      // view only: re-arrange, forget any positions you had saved, nothing is marked as a change
      try { if (wfId) localStorage.removeItem(`wf-view:${wfId}`); } catch { /* ignore */ }
      applyGraph(layoutLR(currentGraph()), false);
    } else mutate((g) => layoutLR(g));
    setTimeout(() => fitView({ padding: 0.14, maxZoom: 1, duration: 250 }), 80);
  }, [readOnly, wfId, applyGraph, currentGraph, mutate, fitView]);
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

  const createNew = async () => setShowTemplates(true);
  const createFromTemplate = async (t: WfTemplate) => {
    const name = prompt(`Name for the new workflow (from "${t.name}")`, t.id === 'default' ? 'My pipeline' : t.name);
    if (!name) return;
    const r = await act(post<{ id: string }>('/workflows', { workspaceId: wsId, name, description: t.description, graph: t.id === 'blank' ? emptyGraph() : t.graph }));
    if (r) { setShowTemplates(false); reloadList(); setWfId(r.id); }
  };
  const runSim = async () => {
    const outcomes: Record<string, string> = {};
    for (const [k, v] of Object.entries(simOutcomes)) if (v && v !== 'success') outcomes[k] = v;
    const r = await post<WfSimResult>('/workflows/simulate', { graph: currentGraph(), outcomes }).catch((e) => { toast(String(e?.message ?? e), 'bad'); return null; });
    if (r) setSim(r);
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
  // Export names agents instead of ids, so the file works in any office; import resolves those names
  // in the open office (falling back to each step's role) and adds the result as a new workflow.
  const exportFlow = async () => {
    if (!detail) return;
    const file = await act(get(`/workflows/${detail.workflow.id}/export`));
    if (!file) return;
    downloadJson(`${fileSlug(detail.workflow.name)}.workflow.json`, file);
    if (dirty) toast('Exported the saved version — unsaved changes are not in the file', 'warn');
  };
  const importFlow = async (f: File | undefined) => {
    if (!f || !wsId) return;
    try {
      const bundle = await readJsonFile(f);
      const r = await act(post<{ workflowId: string; warnings: string[] }>('/workflows/import', { workspaceId: wsId, bundle }));
      if (!r) return;
      reloadList();
      setWfId(r.workflowId);
      toast(r.warnings.length ? `Imported — ${r.warnings[0]}${r.warnings.length > 1 ? ` (+${r.warnings.length - 1} more)` : ''}` : 'Imported as a new workflow', r.warnings.length ? 'warn' : 'ok');
    } catch (e) { toast(String((e as Error).message), 'bad'); }
  };

  const errorsList = issues.filter((i) => i.level === 'error');
  const warnsList = issues.filter((i) => i.level === 'warning');

  // ---- render ----
  return (
    <div className="h-full min-h-0 flex flex-col bg-canvas">
      {/* toolbar: pick a workflow, then the few things you do to it */}
      <div className="h-12 shrink-0 border-b border-line bg-surface px-3 flex items-center gap-2 overflow-x-auto">
        <button className="btn btn-ghost btn-xs" onClick={() => setLeftOpen((o) => !o)} title={leftOpen ? 'Hide the agent list' : 'Show the agent list'} aria-pressed={leftOpen}><PanelLeft size={15} /></button>
        <GitBranch size={15} className="text-fg-3 shrink-0" />
        <Select className="input input-sm !w-auto min-w-[11rem] max-w-[190px] 2xl:max-w-[340px] font-medium" value={wfId ?? ''} onChange={(e) => setWfId(e.target.value)} aria-label="Workflow">
          {(wflist ?? []).map((w) => <option key={w.id} value={w.id}>{w.builtin ? 'Standard pipeline (read-only)' : w.name}{w.active ? '  ● active' : ''}</option>)}
          {!wflist?.length && <option value="">No workflows yet</option>}
        </Select>
        <button className="btn btn-sm shrink-0" onClick={createNew}><FilePlus2 size={14} /><span className="hidden 2xl:inline">New</span></button>
        {detail && (
          <div className="hidden md:flex items-center gap-1.5 shrink-0">
            {detail.versions.length > 0 && <span className="chip">v{detail.versions[detail.versions.length - 1]?.n ?? '?'}</span>}
            {detail.workflow.builtin && <span className="chip"><Lock size={10} /> read-only</span>}
            {detail.workflow.active && <span className="chip !border-ok/30 !text-ok">active</span>}
            {dirty && !readOnly && <span className="chip !border-warn/30 !text-warn">unsaved</span>}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {!readOnly && (
            <>
              <button className="btn btn-xs" onClick={undo} disabled={!past.current.length} title="Undo (Ctrl+Z)"><Undo2 size={13} /></button>
              <button className="btn btn-xs" onClick={redo} disabled={!future.current.length} title="Redo (Ctrl+Y)"><Redo2 size={13} /></button>
              <button className="btn btn-xs" onClick={copySelection} disabled={!selNodes.length} title="Copy the selected steps (Ctrl+C)"><Copy size={13} /></button>
              <button className="btn btn-xs" onClick={deleteSelection} disabled={!selNodes.length && !selEdges.length} title="Delete the selection (Del)"><Scissors size={13} /></button>
            </>
          )}
          <button className="btn btn-xs" onClick={tidyUp} title={readOnly ? 'Rearrange the steps left to right (only changes your view)' : 'Tidy the layout, left to right'}><ArrowLeftRight size={13} /><span className="hidden 2xl:inline">Tidy up</span></button>
          <button className="btn btn-xs" onClick={() => fitView({ padding: 0.14, maxZoom: 1, duration: 250 })} title="Zoom to show the whole flow"><Maximize2 size={13} /><span className="hidden 2xl:inline">Fit</span></button>
          <button className="btn btn-xs" onClick={() => { setShowSim(true); setSimOutcomes({}); }} title="Dry run: walk through the flow with pretend results. No model calls."><FlaskConical size={13} /><span className="hidden 2xl:inline">Dry run</span></button>
          {detail && <button className="btn btn-xs" onClick={() => setShowVersions(true)} title="Saved versions and who changed what"><HistoryIcon size={13} /><span className="hidden 2xl:inline">History</span></button>}
          {detail && <button className="btn btn-xs" onClick={() => void exportFlow()} title="Download this workflow as a file that works in any office"><Download size={13} /><span className="hidden 2xl:inline">Export</span></button>}
          <label className="btn btn-xs cursor-pointer" title="Add a workflow from a file to this office">
            <Upload size={13} /><span className="hidden 2xl:inline">Import</span>
            <input type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void importFlow(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <span className="w-px h-5 bg-line mx-1" />
          {detail && builtin && <button className="btn btn-accent btn-xs" onClick={cloneWf}><Copy size={13} /> Clone to edit</button>}
          {detail && !builtin && (
            <>
              <button className="btn btn-xs" onClick={cloneWf} title="Make a copy"><Copy size={13} /><span className="hidden 2xl:inline">Clone</span></button>
              <button className="btn btn-primary btn-xs" onClick={() => void save()} disabled={hasErrors || !dirty} title={hasErrors ? 'Fix the problems first' : 'Save as a new version (Ctrl+S)'}><Save size={13} /> Save</button>
              {detail.workflow.active
                ? <button className="btn btn-danger btn-xs" onClick={() => void setActive(false)}><Ban size={13} /> Deactivate</button>
                : <button className="btn btn-accent btn-xs" onClick={() => void setActive(true)} disabled={hasErrors} title="New runs use this workflow by default"><Zap size={13} /> Set active</button>}
            </>
          )}
          <button className="btn btn-ghost btn-xs" onClick={() => setRightOpen((o) => !o)} title={rightOpen ? 'Hide the details panel' : 'Show the details panel'} aria-pressed={rightOpen}><PanelRight size={15} /></button>
        </div>
      </div>

      {liveRunObj && (
        <div className="shrink-0 border-b border-line bg-surface px-3 h-10 flex items-center gap-3 text-xs overflow-x-auto" aria-live="polite">
          <span className="flex items-center gap-2 shrink-0 min-w-0">
            <Dot tone={working.length ? 'info' : runGoing ? 'warn' : 'idle'} live={working.length > 0} />
            <span className="font-medium text-fg">{working.length ? 'Working now' : runGoing ? (liveRunObj.status === 'paused' ? 'Paused' : 'Waiting') : 'Run finished'}</span>
            <span className="text-fg-3 max-w-[22ch] truncate" title={liveRunObj.goal}>{liveRunObj.goal}</span>
            <StatusChip value={liveRunObj.status} />
          </span>
          <span className="w-px h-4 bg-line shrink-0" />
          {working.map((n) => {
            const l = n.data.live!;
            const t = taskTitle(l.taskId);
            return (
              <button key={n.id} onClick={() => focusNode(n.id)} title="Show this step on the canvas"
                className={`chip !h-6 !px-2 shrink-0 gap-1.5 text-fg ${l.human ? 'border-warn/50' : 'border-info/50'} hover:bg-raised`}>
                <Dot tone={l.human ? 'warn' : 'info'} live />
                <b className="font-medium">{n.data.wf.label}</b>
                {l.human ? <span className="text-warn">waiting for you</span> : l.agent && <span className="text-fg-3">{l.agent}</span>}
                {t && <span className="text-fg-4 max-w-[26ch] truncate">· {t}</span>}
                <span className="mono tabular-nums text-fg-3">{elapsed(l.since)}</span>
              </button>
            );
          })}
          {!working.length && (
            <span className="text-fg-3 shrink-0">
              {runGoing ? 'No step is running at the moment.' : 'No step is running.'}
              {lastDone && <> Last finished: <button className="underline hover:text-fg" onClick={() => { const n = nodes.find((x) => x.data.wf.label === lastDone.label); if (n) focusNode(n.id); }}>{lastDone.label}</button></>}
            </span>
          )}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* left rail: palette */}
        {leftOpen && (
          <aside className="w-64 shrink-0 min-h-0 overflow-auto p-3 border-r border-line bg-surface">
            <Palette agents={agents ?? []} roles={roles ?? []} wsId={wsId} skills={(skillsData?.skills ?? []).filter((s) => s.enabled)} />
          </aside>
        )}

        {/* canvas */}
        <div className="flex-1 min-w-0 relative">
          <ReactFlow
            nodes={dNodes} edges={dEdges}
            onNodesChange={readOnly ? ((chs) => onNodesChange(chs.filter((c) => c.type === 'select' || c.type === 'position' || c.type === 'dimensions'))) : onNodesChange}
            onEdgesChange={readOnly ? ((chs) => onEdgesChange(chs.filter((c) => c.type === 'select'))) : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onSelectionChange={useCallback(({ nodes: ns, edges: es }: { nodes: Node[]; edges: Edge[] }) => { setSelNodes(ns.map((x) => x.id)); setSelEdges(es.map((x) => x.id)); }, [])}
            onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
            onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop}
            nodeTypes={nodeTypes} edgeTypes={edgeTypes}
            defaultEdgeOptions={{ type: 'wf', markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 } }}
            connectionMode={ConnectionMode.Loose} connectionRadius={36} isValidConnection={isValidConnection}
            snapToGrid snapGrid={[20, 20]}
            fitView fitViewOptions={{ padding: 0.14, maxZoom: 1 }} minZoom={0.2} maxZoom={2}
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            nodesDraggable nodesConnectable={!readOnly} elementsSelectable
            multiSelectionKeyCode="Shift" selectionKeyCode="Shift"
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="rgb(var(--line))" />
            <Controls showInteractive={false} position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" className="!bg-raised !border !border-line !rounded-lg" nodeColor="rgb(var(--line-strong))" maskColor="rgb(var(--canvas) / 0.7)" />
            <Panel position="top-left" className="flex flex-col gap-1.5 !m-3 max-w-[60%]">
              {draftBanner && (
                <div className="card !border-warn/40 px-3 py-1.5 text-2xs flex items-center gap-2">
                  Autosaved draft restored.
                  <button className="underline hover:text-fg" onClick={() => { localStorage.removeItem(`wf-draft:${wfId}`); if (detail?.graph) { pushHistory(); applyGraph(detail.graph); } setDraftBanner(false); setDirty(false); }}>discard it</button>
                </div>
              )}
              {errorsList.length > 0 && (
                <div className="card !border-bad/40 px-3 py-1.5 text-2xs text-bad max-w-full">
                  {errorsList.length} problem{errorsList.length > 1 ? 's' : ''} to fix before you can save or activate. See the Details panel.
                </div>
              )}
              {readOnly && (
                <div className="card px-3 py-1.5 text-2xs text-fg-2 flex items-center gap-2"><Lock size={11} /> This is the standard pipeline: its steps can't be edited, but you can drag them around to read it. Use <b>Clone to edit</b> to make your own.</div>
              )}
            </Panel>
            {hintOpen && !readOnly && (
              <Panel position="bottom-center" className="!m-3 !mb-4 max-w-[min(560px,50%)]">
                <div className="card px-3.5 py-2 text-xs text-fg-2 flex items-center gap-x-3 gap-y-1 flex-wrap shadow-pop">
                  <span><b className="text-fg">1</b> Drag an agent in</span>
                  <span><b className="text-fg">2</b> Pull from a dot to connect</span>
                  <span><b className="text-fg">3</b> Drop on a line to insert</span>
                  <button className="btn btn-ghost btn-xs ml-auto" onClick={dismissHint} aria-label="Dismiss tips">Got it</button>
                </div>
              </Panel>
            )}
            <Panel position="top-right" className="!m-3 flex flex-col items-end gap-1.5">
              {wfRuns.length > 0 && (
                <Select className="input input-sm !w-auto" value={liveRun ?? ''} onChange={(e) => setPickedRun(e.target.value || null)} title="Show where a run actually went on this workflow">
                  {wfRuns.map((r) => <option key={r.id} value={r.id}>{r.id === run?.id ? '● ' : ''}run {r.id.slice(0, 8)} · {r.status}</option>)}
                </Select>
              )}
              <div className="card px-2.5 py-2 text-2xs text-fg-3 space-y-1">
                <button className="flex w-full items-center justify-between gap-3 font-medium text-fg-2" onClick={() => setLegendOpen((o) => !o)} aria-expanded={legendOpen} title="Show or hide what each line colour means">
                  Lines <span className="text-fg-4 font-normal">{legendOpen ? 'hide' : 'show'}</span>
                </button>
                {legendOpen && EDGE_KINDS.map((k) => (
                  <div key={k.kind} className="flex items-center gap-2">
                    <svg width="26" height="6" aria-hidden><line x1="0" y1="3" x2="26" y2="3" stroke={EDGE_STYLE[k.kind].stroke} strokeWidth="2" strokeDasharray={EDGE_STYLE[k.kind].dash} /></svg>
                    <span>{EDGE_SHORT[k.kind]}</span>
                  </div>
                ))}
              </div>
            </Panel>
          </ReactFlow>
        </div>

        {/* right rail: inspector */}
        {rightOpen && <aside className="w-80 shrink-0 p-3 overflow-auto min-h-0 border-l border-line bg-surface">
          {readOnly && (selNode || selEdge) && <div className="flex items-center gap-1.5 text-2xs text-fg-3 mb-3"><Lock size={11} /> Read-only. Clone the workflow to change this.</div>}
          <fieldset disabled={readOnly && !!(selNode || selEdge)} className="min-w-0 border-0 p-0 m-0">
          {selNode ? (
            <NodeInspector
              node={selNode} agents={agents ?? []} roles={roles ?? []} wsId={wsId} allNodes={dNodes}
              onChange={(wf) => { pushHistory(); setNodes((ns) => ns.map((n) => (n.id === wf.id ? { ...n, data: { ...n.data, wf } } : n))); setDirty(true); }}
              onDelete={deleteSelection}
              onOpenTask={() => selNode.data.live?.taskId && nav(`/tasks/${selNode.data.live.taskId}`)}
              skillsData={skillsData} reloadSkills={reloadSkills}
              onApplyToRole={() => applySkillsToRole(selNode.id)}
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
                  <div className="text-2xs text-fg-4 mb-3">Save, clone, export, import and history are in the bar above.</div>
                  {!readOnly && (
                    <Field label="Version note (saved with the version)">
                      <input className="inp" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed" />
                    </Field>
                  )}
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
                  {estimate && (
                    <div className="border-t border-line pt-3 mt-3">
                      <div className="field-label">Worst case per task</div>
                      <div className="text-2xs text-fg-3 leading-4">
                        up to <b className="text-fg">{estimate.maxCalls}</b> agent calls
                        {estimate.humanGates > 0 && `, ${estimate.humanGates} human gate${estimate.humanGates > 1 ? 's' : ''}`}
                        {estimate.skillChars > 0 && `, ~${estimate.skillChars.toLocaleString()} skill chars`}
                      </div>
                    </div>
                  )}
                  {!builtin && (
                    <div className="border-t border-line pt-3 mt-3">
                      <div className="field-label">Guardrails — pause for the owner when hit</div>
                      <div className="grid grid-cols-2 gap-2">
                        {([
                          ['maxStepsPerTask', 'steps / task'],
                          ['maxStepsPerRun', 'steps / run'],
                          ['costCeilingUsd', 'cost $'],
                          ['timeCeilingMin', 'minutes'],
                        ] as const).map(([key, label]) => (
                          <Field key={key} label={label}>
                            <input className="inp" type="number" min={key === 'costCeilingUsd' ? 0.01 : 1} step={key === 'costCeilingUsd' ? 0.01 : 1}
                              value={guardrails[key] ?? ''} placeholder="off"
                              onChange={(e) => {
                                const v = e.target.value ? Number(e.target.value) : undefined;
                                setGuardrails((g2) => { const n2 = { ...g2 }; if (v == null) delete n2[key]; else n2[key] = v; return n2; });
                                setDirty(true);
                              }} />
                          </Field>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <Empty icon={LayoutDashboard} title="Pick a workflow" text="Select a workflow on the left, or create a new one to start drawing." />
              )}
            </div>
          )}
          </fieldset>
        </aside>}
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
          {detail.audit?.length > 0 && (
            <div className="border-t border-line mt-3 pt-3">
              <div className="field-label">Audit — hash-chained event log</div>
              <div className="space-y-1 max-h-40 overflow-auto">
                {detail.audit.map((a, i) => (
                  <div key={i} className="text-2xs flex items-baseline gap-2">
                    <span className="text-fg-4 shrink-0">{fmtAgo(a.ts)}</span>
                    <span className="font-mono shrink-0">{a.type.replace('workflow.', '')}</span>
                    <span className="text-fg-3 truncate">{String(a.payload.changes ?? a.payload.note ?? a.payload.name ?? '')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* templates modal */}
      {showTemplates && (
        <Modal title="New workflow from a template" onClose={() => setShowTemplates(false)} width="max-w-lg">
          <div className="space-y-1.5 max-h-[60vh] overflow-auto">
            {(templates ?? []).map((t) => (
              <button key={t.id} className="w-full text-left px-3 py-2.5 rounded-lg border border-line hover:border-line-strong hover:bg-raised transition-colors"
                onClick={() => void createFromTemplate(t)}>
                <div className="text-xs font-medium flex items-center gap-2">
                  {t.id === 'default' && <Lock size={11} className="text-fg-4" />}
                  {t.id === 'strict' && <Shield size={11} className="text-fg-4" />}
                  {t.name}
                </div>
                <div className="text-2xs text-fg-3 mt-0.5 leading-4">{t.description}</div>
              </button>
            ))}
            <button className="w-full text-left px-3 py-2.5 rounded-lg border border-dashed border-line hover:border-line-strong transition-colors"
              onClick={() => void createFromTemplate({ id: 'blank', name: 'Blank', description: '', graph: emptyGraph() })}>
              <div className="text-xs font-medium text-fg-3">Start blank — start → end only</div>
            </button>
          </div>
        </Modal>
      )}

      {/* dry-run modal */}
      {showSim && (
        <Modal title="Dry run — simulate the graph, no model calls" onClose={() => setShowSim(false)} width="max-w-lg">
          <div className="text-2xs text-fg-3 mb-3 leading-4">
            Pick an outcome for any agent step; the rest default to success. The path highlights on the canvas.
          </div>
          <div className="space-y-1 max-h-44 overflow-auto mb-3">
            {nodes.filter((n) => n.data.wf.type === 'agent').map((n) => (
              <div key={n.id} className="flex items-center gap-2 text-xs">
                <span className="truncate flex-1">{n.data.wf.label}</span>
                <Select className="inp !h-6 !text-2xs !w-32" value={simOutcomes[n.id] ?? 'success'}
                  onChange={(e) => setSimOutcomes((o) => ({ ...o, [n.id]: e.target.value }))}>
                  <option value="success">succeeds</option>
                  <option value="failure">fails</option>
                  <option value="reject">rejects</option>
                </Select>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-primary btn-xs" onClick={() => void runSim()}><FlaskConical size={11} /> Simulate</button>
            {sim && (
              <span className="text-2xs text-fg-3">
                {sim.result === 'end' ? 'reached the end' : sim.result === 'max-steps' ? 'stopped at the step cap' : 'dead end'} · {sim.calls} agent call{sim.calls === 1 ? '' : 's'}{sim.humanGates ? ` · ${sim.humanGates} gate(s)` : ''}
              </span>
            )}
          </div>
          {sim && (
            <div className="border-t border-line mt-3 pt-3 max-h-[40vh] overflow-auto">
              <div className="space-y-0.5">
                {sim.steps.map((s) => (
                  <button key={s.n} className="w-full text-left text-2xs flex items-baseline gap-2 px-1 py-0.5 rounded hover:bg-raised"
                    onClick={() => { setSelNodes([s.nodeId]); setSelEdges(s.viaEdgeId ? [s.viaEdgeId] : []); }}>
                    <span className="font-mono text-fg-4 w-6 shrink-0">{s.n}</span>
                    <span className="truncate flex-1">{s.label}</span>
                    <span className="text-fg-4 shrink-0">{s.type}{s.note ? ` · ${s.note}` : ''}</span>
                  </button>
                ))}
              </div>
              {sim.notes.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {sim.notes.map((n2, i) => <div key={i} className="text-2xs text-warn">{n2}</div>)}
                </div>
              )}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

export default function Workflow() {
  return <ReactFlowProvider><WorkflowEditor /></ReactFlowProvider>;
}
