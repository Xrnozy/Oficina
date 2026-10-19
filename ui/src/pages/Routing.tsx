import { Select } from '../Select';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, put, useEvents, useQuery } from '../api';
import { Avatar, Muted, PageHeader, Panel, Segmented, Tag, act, fmtAgo, toast, useCurrentRun, type Tone } from '../components';
import { ArrowDown, ArrowRight, ArrowUp, CornerUpLeft, GitBranch, Mail, Pencil, Plus, X } from 'lucide-react';
import type { WorkflowRow } from '../workflow';
import { useOffice } from '../office';
import { PURPOSE_LABEL, type RoutingRow, type RoutingStep, type RoutingView } from '../workflow';

// Routing: who does each step of the flow, which models each step may run
// on, and how the router picks between them. Every hand-off is automatic.
// The Flow strip and the step panels both render the ACTIVE workflow graph —
// the same source of truth the Workflow editor draws and the engine walks.

const STRATEGIES = ['smart', 'fixed'] as const;
const STRATEGY_HELP: Record<string, string> = {
  smart: 'Each work item runs on the cheapest model option strong enough for it — plan-billed (CLI / subscription) first, then the lowest metered price. Unavailable options (quota, budget, circuit) are skipped.',
  fixed: 'Each agent always starts on its first model option; the others are used only when it fails or is out of quota.',
};
const PROMPTS = ['pipeline', 'handoffs', 'all', 'off'] as const;
const PROMPT_HELP: Record<string, string> = {
  pipeline: 'The Prompt Creator drafts the developer\'s prompt and every correction prompt; the PM reviews each draft (the PM drafts itself if there is no Prompt Creator). Corrections always carry the approved prompt, so nothing is lost. The reviewer gets the developer\'s notes directly.',
  handoffs: 'The PM writes only the developer\'s task prompt; its rework notes and check failures go straight back to the developer. Fewest model calls.',
  all: 'Same as pipeline: reviewer prompts are built from the approved brief, change notes and diff, so re-drafting them added model calls without changing what is checked.',
  off: 'Agents get the engine\'s prompt directly.',
};
const WORK_MODES = ['direct', 'isolated'] as const;
const WORK_HELP: Record<string, string> = {
  direct: 'Agents edit the selected repository itself, on the branch you have checked out — one task at a time, with a General Checkpoint per task and an Agent Checkpoint per agent so either can be undone. Your uncommitted changes are detected and preserved.',
  isolated: 'Each task works in its own git worktree under .office/ and is merged into the integration branch.',
};
const COMMIT_MODES = ['approve', 'auto', 'manual'] as const;
const COMMIT_HELP: Record<string, string> = {
  approve: 'When a task is accepted, a commit of only its files — with a message from the actual change — waits for you under Needs you (edit the message on the task page).',
  auto: 'Committed automatically when checks and review passed and the commit contains only the task\'s own files; anything else still asks you.',
  manual: 'The office never commits; changes stay in the working tree for you.',
};
const APPROVAL_MODES = ['always-ask', 'ask-when-risky', 'auto'] as const;
const APPROVAL_HELP: Record<string, string> = {
  'always-ask': 'Every gated action waits in Needs you.',
  'ask-when-risky': 'Low-risk change gates approve themselves — out-of-scope files, config/CI/secrets/lockfiles, deletions, large diffs and unverified changes still ask.',
  'auto': 'Every change gate self-approves and logs why. Questions, escalations and plan/DoD decisions still need you.',
};
const TIERS = ['fast', 'standard', 'strong'] as const;
const TIER_TONE: Record<string, Tone> = { fast: 'ok', standard: 'info', strong: 'warn' };
const EFFORTS = ['default', 'auto', 'off', 'low', 'medium', 'high'] as const;

type Option = { accountId: string; modelId: string | null };

function modelLabel(m: any): string { return m?.label ?? m?.supports?.displayName ?? m?.name ?? ''; }

function AgentModels({ agent, providers, onSaved }: { agent: any; providers: any; onSaved: () => void }) {
  const accounts: any[] = providers?.accounts ?? [];
  const models: any[] = providers?.models ?? [];
  const provOf = (accountId: string) => providers?.providers?.find((p: any) => p.id === accounts.find((a) => a.id === accountId)?.provider_id);
  const initial = (): Option[] => [
    ...(agent.accountId ? [{ accountId: agent.accountId, modelId: agent.modelId ?? null }] : []),
    ...(agent.model?.fallbacks ?? []),
  ];
  const [opts, setOpts] = useState<Option[]>(initial);
  const [effort, setEffort] = useState<string>(agent.model?.reasoningEffort ?? 'default');
  const [adding, setAdding] = useState<Option | null>(null);
  useEffect(() => { setOpts(initial()); setEffort(agent.model?.reasoningEffort ?? 'default'); }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(opts) !== JSON.stringify(initial()) || effort !== (agent.model?.reasoningEffort ?? 'default');

  const move = (i: number, d: number) => setOpts((o) => { const n = [...o]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const save = async () => {
    const [first, ...rest] = opts;
    const r = await act(put(`/agents/${agent.id}`, {
      accountId: first?.accountId ?? null, modelId: first?.modelId ?? null,
      settings: { fallbacks: rest, reasoningEffort: effort === 'default' ? null : effort },
    }), `${agent.name}: model options saved`);
    if (r) onSaved();
  };
  const setTier = async (modelId: string, tier: string) => {
    if (await act(put(`/models/${encodeURIComponent(modelId)}`, { strengthTier: tier }), `Tier set to ${tier}`)) onSaved();
  };

  return (
    <div className="rounded-xl border border-line p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Avatar agent={agent} size="sm" />
        <span className="font-medium text-sm text-fg">{agent.name}</span>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-fg-3">reasoning
          <Select className="input input-sm" value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Reasoning effort">
            {EFFORTS.map((e) => <option key={e} value={e}>{e === 'auto' ? 'auto (by task)' : e}</option>)}
          </Select>
        </label>
      </div>
      <ol className="space-y-1">
        {opts.map((o, i) => {
          const prov = provOf(o.accountId);
          const acct = accounts.find((a) => a.id === o.accountId);
          const m = models.find((x) => x.id === o.modelId);
          const plan = acct?.billing === 'subscription' || acct?.billing === 'credits' || ['cli', 'scripted', 'manual'].includes(prov?.adapter_id);
          return (
            <li key={`${o.accountId}|${o.modelId}|${i}`} className="flex items-center gap-2 text-xs flex-wrap">
              <span className="num text-fg-4 w-4">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">{prov?.name ?? o.accountId} <span className="text-fg-4">/</span> <span className="mono">{m ? modelLabel(m) : 'provider default'}</span></span>
              {m ? (
                <Select className="input input-sm" value={m.strength_tier} onChange={(e) => setTier(m.id, e.target.value)} aria-label="Model tier" title="What this model is strong enough for">
                  {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              ) : <Tag>standard</Tag>}
              <Tag tone={plan ? 'ok' : 'idle'} title={plan ? 'No per-call cost (plan / subscription)' : 'Metered: input / output per 1M tokens'}>
                {plan ? 'plan' : m && (m.price_in || m.price_out) ? `$${m.price_in}/$${m.price_out}` : 'metered'}
              </Tag>
              <button className="btn btn-ghost btn-icon btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={12} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" disabled={i === opts.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={12} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setOpts((x) => x.filter((_, j) => j !== i))} aria-label="Remove"><X size={12} /></button>
            </li>
          );
        })}
        {!opts.length && <Muted>No model — add one below.</Muted>}
      </ol>
      {adding ? (
        <div className="flex items-center gap-2 flex-wrap">
          <Select className="input input-sm" value={adding.accountId} onChange={(e) => setAdding({ accountId: e.target.value, modelId: null })} aria-label="Backend">
            <option value="">backend…</option>
            {accounts.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{providers.providers.find((p: any) => p.id === a.provider_id)?.name ?? a.label}</option>)}
          </Select>
          <Select className="input input-sm flex-1 min-w-[10rem]" value={adding.modelId ?? ''} disabled={!adding.accountId} onChange={(e) => setAdding({ ...adding, modelId: e.target.value || null })} aria-label="Model">
            <option value="">provider default</option>
            {models.filter((m) => m.provider_id === accounts.find((a) => a.id === adding.accountId)?.provider_id).map((m) => <option key={m.id} value={m.id}>{modelLabel(m)} · {m.strength_tier}</option>)}
          </Select>
          <button className="btn btn-sm btn-primary" disabled={!adding.accountId} onClick={() => { setOpts((o) => [...o, adding]); setAdding(null); }}>Add</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setAdding(null)}>Cancel</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button className="btn btn-sm btn-ghost" onClick={() => setAdding({ accountId: '', modelId: null })}><Plus size={12} /> Add model option</button>
          <div className="flex-1" />
          {dirty && <button className="btn btn-sm btn-ghost" onClick={() => { setOpts(initial()); setEffort(agent.model?.reasoningEffort ?? 'default'); }}>Reset</button>}
          <button className="btn btn-sm btn-primary" disabled={!dirty} onClick={save}>Save</button>
        </div>
      )}
    </div>
  );
}

// One agent node's routing panel: the node's model-tier override and prompt
// budget (node.config — the same fields the Workflow inspector edits), then
// the ordered model options of every agent the node can dispatch to.
function NodeRouting({ step, rv, agentFor, providers, onSaved }: { step: RoutingStep; rv: RoutingView; agentFor: (id: string) => any; providers: any; onSaved: () => void }) {
  const editable = rv.custom && !rv.preview;
  const [tier, setTier] = useState(step.modelTier ?? '');
  const [budget, setBudget] = useState(step.budgetChars != null ? String(step.budgetChars) : '');
  useEffect(() => { setTier(step.modelTier ?? ''); setBudget(step.budgetChars != null ? String(step.budgetChars) : ''); }, [step.nodeId, step.modelTier, step.budgetChars]);
  const dirty = tier !== (step.modelTier ?? '') || budget !== (step.budgetChars != null ? String(step.budgetChars) : '');
  const save = async () => {
    const r = await act(put(`/workflows/${rv.workflow.id}/nodes/${step.nodeId}`, {
      modelTier: tier || null,
      budgetChars: budget ? Number(budget) : null,
    }), `${step.label}: routing saved — a new workflow version`);
    if (r) onSaved();
  };
  const full = (id: string) => agentFor(id);
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap rounded-lg border border-line/70 bg-raised/40 px-3 py-2">
        <label className="text-xs text-fg-3">model tier override
          <Select className="input input-sm block mt-0.5" value={tier} disabled={!editable} onChange={(e) => setTier(e.target.value)}
            title={editable ? 'Force the tier the router requires for this step' : 'The default pipeline is read-only — clone it in Workflow'}>
            <option value="">auto — by kind &amp; difficulty</option>
            <option value="fast">fast</option>
            <option value="standard">standard</option>
            <option value="strong">strong</option>
          </Select>
        </label>
        <label className="text-xs text-fg-3">token budget
          <input className="input input-sm block mt-0.5 w-28" type="number" min={0} value={budget} disabled={!editable} placeholder="auto"
            onChange={(e) => setBudget(e.target.value)} title="Prompt + context-pack budget in chars (~4 chars per token)" />
        </label>
        {dirty && editable && <button className="btn btn-sm btn-primary" onClick={save}>Save</button>}
        {dirty && editable && <button className="btn btn-sm btn-ghost" onClick={() => { setTier(step.modelTier ?? ''); setBudget(step.budgetChars != null ? String(step.budgetChars) : ''); }}>Reset</button>}
        {!editable && <Muted>read-only — clone the workflow in Workflow to tune per-step</Muted>}
        {step.warnings.map((w, k) => <Tag key={k} tone="warn" title={w}>! {w}</Tag>)}
      </div>
      {step.agents.map((a) => {
        const fa = full(a.id);
        return fa ? <AgentModels key={a.id} agent={fa} providers={providers} onSaved={onSaved} /> : null;
      })}
      {!step.agents.length && (
        <Muted>
          {step.agentId ? 'The pinned agent is gone — pick another in ' : step.role ? `No agent holds the "${step.role}" role — ` : 'This node names no agent or role — '}
          <Link to={step.agentId || step.role ? `/workflow?node=${step.nodeId}` : '/office'} className="underline">{step.agentId || step.role ? 'the editor' : 'assign one'}</Link>.
        </Muted>
      )}
    </div>
  );
}

// Same role colours as the Workflow canvas; a step falls back to its purpose when it has no role.
const ROLE_TINT: Record<string, string> = { pm: 'bg-lilac', 'prompt-creator': 'bg-cream', developer: 'bg-lime', qa: 'bg-mint', reviewer: 'bg-pink', analyst: 'bg-coral', docs: 'bg-cream' };
const PURPOSE_TINT: Record<string, string> = {
  plan: 'bg-lilac', accept: 'bg-lilac', 'prompt-review': 'bg-lilac', prompt: 'bg-cream', doc: 'bg-cream', implement: 'bg-lime', fix: 'bg-lime',
  qa: 'bg-mint', test: 'bg-mint', review: 'bg-pink', analyse: 'bg-coral', diagnose: 'bg-coral',
};
function stepTint(s: RoutingStep): string {
  if (s.type === 'start') return 'bg-mint';
  if (s.type === 'end') return 'bg-navy';
  if (s.type === 'condition') return 'bg-cream';
  if (s.type === 'merge') return 'bg-lilac';
  if (s.type === 'human') return 'bg-pink';
  return ROLE_TINT[s.role ?? ''] ?? PURPOSE_TINT[s.purpose ?? ''] ?? 'bg-raised';
}

// One step on the flow — a workflow node. Click opens it in the editor.
function StepCard({ s }: { s: RoutingStep }) {
  const what =
    s.type === 'start' ? 'the request enters here'
    : s.type === 'end' ? 'task completes here'
    : s.type === 'condition' ? 'branches on a check'
    : s.type === 'merge' ? 'waits for its branches'
    : s.type === 'human' ? 'pauses for you'
    : (PURPOSE_LABEL[s.purpose ?? ''] ?? s.purpose ?? 'step');
  const names = s.agents.map((a) => a.name).join(', ');
  const problem = s.type !== 'agent' ? null
    : s.agentId ? (s.agents.length ? null : 'agent deleted')
    : s.role ? (s.agents.length ? null : `any ${s.role} — none assigned`)
    : 'no agent or role';
  const note = 'flex items-center gap-1.5';
  return (
    <Link
      to={`/workflow?node=${s.nodeId}`}
      className={`block rounded-lg border bg-surface px-3 py-2 hover:border-line-strong ${s.disabled ? 'border-line/50 opacity-55' : 'border-line'} ${s.warnings.length ? 'border-warn/60' : ''}`}
      title={`${s.label}${s.warnings.length ? ` — ${s.warnings.join('; ')}` : ''}`}
    >
      <div className="flex items-baseline gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-medium text-fg">{s.label}</span>
          <span className="ml-2 text-xs text-fg-3">{what}{s.scope === 'run' && ' · once per run'}{s.disabled && ' · bypassed'}{s.type === 'merge' && ' · merge'}{s.type === 'human' && ' · approval'}</span>
        </div>
        <div className="shrink-0 text-xs text-fg-2">
          {names}
          {problem && <span className="text-warn">{problem}</span>}
          {s.modelTier && <span className="ml-2 font-mono text-2xs text-fg-4">{s.modelTier}</span>}
          {s.warnings.length > 0 && <span className="ml-2 text-warn" title={s.warnings.join('; ')}>!</span>}
        </div>
      </div>
      {(s.loops.length > 0 || s.exits.length > 0 || s.messages.length > 0) && (
        <ul className="mt-1 space-y-0.5 text-xs text-fg-3">
          {s.loops.map((e) => (
            <li key={e.edgeId} className={note}><CornerUpLeft size={11} className="shrink-0" /> {e.label ?? 'back'} → {e.toLabel}{e.maxLoops ? ` ×${e.maxLoops}` : ''}</li>
          ))}
          {s.exits.map((e) => (
            <li key={e.edgeId} className={note}><ArrowRight size={11} className="shrink-0" /> {e.label ?? e.kind} → {e.toLabel}</li>
          ))}
          {s.messages.map((e) => (
            <li key={e.edgeId} className={`${note} text-info`}><Mail size={11} className="shrink-0" /> {e.label ?? 'message'} → {e.toLabel}</li>
          ))}
        </ul>
      )}
    </Link>
  );
}

// The flow reads top to bottom along a rail. Every marker's centre sits 18px below the top of its
// row, and each row's line runs from its own marker centre to the next row's — so they always meet.
// A fan-out splits into side-by-side lanes, each headed by its condition.
function FlowRows({ rows, nested = false }: { rows: RoutingRow[]; nested?: boolean }) {
  let n = 0;
  return (
    <ol>
      {rows.map((r, i) => {
        const last = i === rows.length - 1;
        const tint = r.kind === 'step' ? stepTint(r.step) : 'bg-line-strong';
        const num = r.kind === 'step' && !nested ? ++n : null;
        return (
          <li key={i} className={`relative ${nested ? 'pl-5' : 'pl-9'} ${last ? '' : 'pb-2.5'}`}>
            {!last && <span aria-hidden className={`absolute w-px -bottom-[18px] top-[18px] bg-line-strong ${nested ? 'left-[3.5px]' : 'left-[11.5px]'}`} />}
            {nested
              ? <span aria-hidden className={`absolute left-0 top-[14px] h-2 w-2 rounded-full ${tint}`} />
              : (
                <span aria-hidden className={`absolute left-0 top-1.5 grid h-6 w-6 place-items-center rounded-full text-2xs font-mono ${r.kind === 'step' ? `${tint} ${tint === 'bg-navy' ? 'text-white' : 'text-fg'}` : 'border border-line-strong bg-surface text-fg-3'}`}>
                  {r.kind === 'back' ? <CornerUpLeft size={11} /> : r.kind === 'branches' ? <GitBranch size={11} /> : num}
                </span>
              )}
            {r.kind === 'step' && <StepCard s={r.step} />}
            {r.kind === 'back' && <div className="py-1.5 text-xs text-fg-3">back to <span className="font-medium text-fg-2">{r.toLabel}</span></div>}
            {r.kind === 'branches' && (
              <div className={`grid gap-3 ${r.lanes.length > 1 && !nested ? 'lg:grid-cols-2' : ''}`}>
                {r.lanes.map((l) => (
                  <div key={l.edgeId} className="min-w-0 rounded-lg border border-line p-3">
                    <div className="mb-2.5 text-2xs font-mono uppercase tracking-wide text-fg-3">{l.label}</div>
                    <FlowRows rows={l.rows} nested />
                  </div>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default function Routing() {
  const { run } = useCurrentRun();
  const { data: workspaces, reload: reloadWs } = useQuery<any[]>('/workspaces');
  const { data: agents, reload: reloadAgents } = useQuery<any[]>('/agents');
  const { data: providers, reload: reloadProviders } = useQuery<any>('/providers');
  const { data: decisions } = useQuery<any[]>('/routing/decisions');
  const { office } = useOffice();
  const ws = workspaces?.find((w) => w.id === (office?.id ?? run?.workspaceId)) ?? workspaces?.[0];
  // which workflow to show: '' = the active one. Remembered, and shared with the Workflow editor's last pick.
  // the pick is remembered per office: a workflow id means nothing in another office
  const [views, setViews] = useState<Record<string, string>>(() => { try { return JSON.parse(localStorage.getItem('routing-wf-by-office') ?? '{}'); } catch { return {}; } });
  const viewId = (ws?.id && views[ws.id]) || '';
  const pickView = (id: string) => {
    if (!ws?.id) return;
    const next = { ...views, [ws.id]: id };
    setViews(next);
    try { localStorage.setItem('routing-wf-by-office', JSON.stringify(next)); } catch { /* private mode */ }
  };
  const { data: wfList } = useQuery<WorkflowRow[]>(ws?.id ? `/workflows?workspaceId=${ws.id}` : null, [ws?.id]);
  const knownView = !viewId || (wfList ?? []).some((w) => w.id === viewId);
  const { data: saved, reload: reloadRv } = useQuery<RoutingView>(
    ws?.id ? `/workflows/active/routing?workspaceId=${ws.id}${viewId && knownView ? `&workflowId=${viewId}` : ''}` : null, [ws?.id, viewId, knownView]);
  // the editor keeps unsaved edits in localStorage; show them here as a live preview so Routing
  // follows the canvas without waiting for a save (read-only: saving happens in the editor)
  const [draftTick, setDraftTick] = useState(0);
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key?.startsWith('wf-draft:')) setDraftTick((t) => t + 1); };
    window.addEventListener('storage', on);
    const t = setInterval(() => setDraftTick((x) => x + 1), 4000);   // same-tab edits don't fire 'storage'
    return () => { window.removeEventListener('storage', on); clearInterval(t); };
  }, []);
  const [draftRv, setDraftRv] = useState<{ key: string; rv: RoutingView } | null>(null);
  const draftRaw = (() => { try { return saved ? localStorage.getItem(`wf-draft:${saved.workflow.id}`) : null; } catch { return null; } })();
  useEffect(() => {
    if (!saved || !ws?.id || !draftRaw || saved.workflow.builtin) { setDraftRv(null); return; }
    if (draftRv?.key === draftRaw) return;
    let dead = false;
    try {
      const graph = JSON.parse(draftRaw).graph;
      post<RoutingView>('/workflows/routing-preview', { workspaceId: ws.id, workflowId: saved.workflow.id, graph })
        .then((r) => { if (!dead) setDraftRv({ key: draftRaw, rv: r }); }).catch(() => { if (!dead) setDraftRv(null); });
    } catch { setDraftRv(null); }
    return () => { dead = true; };
  }, [saved?.workflow.id, ws?.id, draftRaw, draftTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const rv: RoutingView | null = draftRaw && draftRv ? draftRv.rv : saved;
  const discardDraft = () => { try { if (saved) localStorage.removeItem(`wf-draft:${saved.workflow.id}`); } catch { /* ignore */ } setDraftRv(null); setDraftTick((t) => t + 1); };
  // workflow.saved / .activated / .deleted already flow over the event stream
  // and useQuery's throttled tick refetches the view — the toast just says so.
  const lastWfToast = useRef(0);
  useEvents(useCallback((e) => {
    if (!e.type.startsWith('workflow.')) return;
    const t = Date.now();
    if (t - lastWfToast.current < 1500) return;   // save+activate bursts coalesce
    lastWfToast.current = t;
    toast('Workflow changed — Routing updated');
  }, []));
  const s = ws?.settings ?? {};
  const strategy: (typeof STRATEGIES)[number] = s.routing === 'fixed' ? 'fixed' : 'smart';
  const prompts: (typeof PROMPTS)[number] = s.promptReview === 'off' ? 'off' : s.promptReview === 'all' ? 'all' : s.promptReview === 'handoffs' || s.promptReview === 'implement' ? 'handoffs' : 'pipeline';
  const workMode: (typeof WORK_MODES)[number] = s.workMode === 'isolated' ? 'isolated' : 'direct';
  const commitMode: (typeof COMMIT_MODES)[number] = s.commitMode === 'auto' ? 'auto' : s.commitMode === 'manual' ? 'manual' : 'approve';
  const approvalMode: (typeof APPROVAL_MODES)[number] = s.approvalMode === 'ask-when-risky' ? 'ask-when-risky' : s.approvalMode === 'auto' ? 'auto' : 'always-ask';
  const setting = (patch: Record<string, unknown>, msg: string) => ws && act(put(`/workspaces/${ws.id}/settings`, patch), msg).then(reloadWs);
  const reload = () => { reloadAgents(); reloadProviders(); };
  // agents/providers refetch on every (throttled) ws tick — keep object
  // identity stable for unchanged rows so an in-flight option edit isn't
  // reset by an unrelated event
  const stableAgents = useRef(new Map<string, any>());
  const agentFor = (id: string) => {
    const next = (agents ?? []).find((a) => a.id === id);
    if (!next) return null;
    const prev = stableAgents.current.get(id);
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return prev;
    stableAgents.current.set(id, next);
    return next;
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Routing" sub="Send a request to the PM; every hand-off after that is automatic. Pick which models each role may use — the router chooses between them per task by what the work needs, what's available and what it costs." />

      <Panel title="Flow"
        action={
          <div className="flex items-center gap-2">
            <Select className="input input-sm !w-auto max-w-[240px]" value={knownView ? viewId : ''} onChange={(e) => pickView(e.target.value)} aria-label="Workflow to show">
              <option value="">Active workflow{(wfList ?? []).find((w) => w.active) ? ` · ${(wfList ?? []).find((w) => w.active)!.builtin ? 'Standard pipeline' : (wfList ?? []).find((w) => w.active)!.name}` : ''}</option>
              {(wfList ?? []).map((w) => <option key={w.id} value={w.id}>{w.builtin ? 'Standard pipeline' : w.name}{w.active ? ' (active)' : ''}</option>)}
            </Select>
            {rv && <Tag tone={rv.custom ? 'info' : 'idle'} title={rv.workflow.builtin ? 'the read-only standard pipeline' : 'a custom workflow'}>{rv.workflow.name} · v{rv.workflow.versionN ?? '—'}</Tag>}
            {rv && !rv.workflow.active && !rv.workflow.builtin && !rv.preview && (
              <button className="btn btn-xs" onClick={async () => { const r = await act(post(`/workflows/${rv.workflow.id}/activate`), 'Now the default for new runs'); if (r) { pickView(''); reloadRv(); } }}>Make active</button>
            )}
            <Link to="/workflow" className="btn btn-ghost btn-xs"><Pencil size={11} /> Edit in Workflow</Link>
          </div>
        }>
        {rv?.preview && (
          <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn mb-3 flex items-center gap-3">
            <span className="flex-1">Showing your <b>unsaved changes</b> from the Workflow editor. Save them there to make this final; per-step settings here are read-only until then.</span>
            <Link to="/workflow" className="underline">Open editor</Link>
            <button className="underline" onClick={discardDraft}>Discard draft</button>
          </div>
        )}
        {!rv?.custom && <p className="text-xs text-fg-3 mb-3">Default pipeline. <Link to="/workflow" className="underline">Clone it in Workflow</Link> to customize.</p>}
        {rv?.fallback && (
          <div className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad mb-3">
            The active workflow has problems — showing the default pipeline below.
            <ul className="mt-1 space-y-0.5">
              {rv.issues.filter((i) => i.level === 'error').map((i, k) => (
                <li key={k}>· {i.nodeId ? <Link className="underline" to={`/workflow?node=${i.nodeId}`}>{i.nodeId}</Link> : 'graph'}: {i.message}</li>
              ))}
            </ul>
          </div>
        )}
        <FlowRows rows={rv?.rows ?? []} />
        {rv?.issues?.some((i) => i.level === 'warning') && (
          <ul className="mt-3 space-y-0.5">
            {rv.issues.filter((i) => i.level === 'warning').map((i, k) => (
              <li key={k} className="text-2xs text-warn">! {i.nodeId ? <Link className="underline" to={`/workflow?node=${i.nodeId}`}>{i.nodeId}</Link> : 'graph'}: {i.message}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-fg-3 mt-3">Every step is a node of the workflow shown above. Click one to open it in the editor. Routing updates as you edit it there (unsaved edits show as a preview) and when you switch or activate a workflow.</p>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-5 items-start [&>*]:min-w-0">
        <div className="space-y-5">
          {(rv?.agentNodes ?? []).map((step) => (
            <Panel key={step.nodeId}
              title={
                <span className="flex items-center gap-2 flex-wrap">
                  <Link to={`/workflow?node=${step.nodeId}`} className="hover:underline">{step.label}</Link>
                  {step.purpose && <Tag tone="idle">{PURPOSE_LABEL[step.purpose] ?? step.purpose}</Tag>}
                  {step.scope === 'run' && <Tag tone="idle">once per run</Tag>}
                  {step.disabled && <Tag tone="idle">bypassed</Tag>}
                </span>
              }>
              <NodeRouting step={step} rv={rv!} agentFor={agentFor} providers={providers} onSaved={() => { reloadRv(); reload(); }} />
            </Panel>
          ))}
          {rv && rv.notInWorkflow.length > 0 && (
            <details className="panel">
              <summary className="px-4 py-3 text-[13px] font-medium text-fg-3 cursor-pointer select-none">
                Not in the workflow ({rv.notInWorkflow.length})
              </summary>
              <div className="px-4 pb-4 space-y-1.5">
                {rv.notInWorkflow.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 text-xs rounded-lg border border-line px-3 py-2">
                    <Avatar agent={{ name: a.name, avatar: a.avatar ?? undefined }} size="sm" />
                    <span className="font-medium text-fg">{a.name}</span>
                    <span className="text-fg-4">{a.roles.join(', ')}</span>
                    <button
                      className="btn btn-ghost btn-xs ml-auto"
                      disabled={!rv.custom}
                      title={rv.custom ? 'Pin this agent on a new node before Done' : 'Clone the workflow in Workflow to customise the default pipeline'}
                      onClick={() => void act(post(`/workflows/${rv.workflow.id}/add-node`, { agentId: a.id }), `${a.name} added to the workflow`).then((r) => r && reloadRv())}
                    ><Plus size={11} /> Add to workflow</button>
                  </div>
                ))}
                {!rv.custom && <Muted>These agents are off the canvas — the default pipeline is read-only; clone it in Workflow to customise.</Muted>}
              </div>
            </details>
          )}
        </div>

        <div className="space-y-5">
          <Panel title="How models are chosen">
            <Segmented value={strategy} options={STRATEGIES} onChange={(v) => setting({ routing: v }, v === 'smart' ? 'Routing per task' : 'Fixed model order')} />
            <p className="text-xs text-fg-3 mt-1.5">{STRATEGY_HELP[strategy]}</p>
            <p className="text-xs text-fg-3 mt-2">Tiers: <Tag tone={TIER_TONE.fast}>fast</Tag> docs, analysis, easy tasks · <Tag tone={TIER_TONE.standard}>standard</Tag> most work, testing, acceptance · <Tag tone={TIER_TONE.strong}>strong</Tag> hard tasks (difficulty 4–5). Synced models get a tier from their name; change it per model. Reasoning <span className="mono">auto</span> sets effort from the tier.</p>
          </Panel>

          <Panel title="Workflow">
            <div className="field-label">Where agents work</div>
            <Segmented value={workMode} options={WORK_MODES} onChange={(v) => setting({ workMode: v }, v === 'direct' ? 'Agents edit the repository directly' : 'Agents work in isolated worktrees')} />
            <p className="text-xs text-fg-3 mt-1.5 mb-4">{WORK_HELP[workMode]}</p>
            <div className="field-label">Commits</div>
            <Segmented value={commitMode} options={COMMIT_MODES} onChange={(v) => setting({ commitMode: v }, `Commits: ${v}`)} />
            <p className="text-xs text-fg-3 mt-1.5 mb-4">{COMMIT_HELP[commitMode]}</p>
            <div className="field-label">Approvals</div>
            <Segmented value={approvalMode} options={APPROVAL_MODES} onChange={(v) => setting({ approvalMode: v }, `Approvals: ${v}`)} />
            <p className="text-xs text-fg-3 mt-1.5 mb-4">{APPROVAL_HELP[approvalMode]}</p>
            <div className="field-label">Prompt preparation</div>
            <Segmented value={prompts} options={PROMPTS} onChange={(v) => setting({ promptReview: v }, `PM prompts: ${v}`)} />
            <p className="text-xs text-fg-3 mt-1.5">{PROMPT_HELP[prompts]}</p>
            {rv?.custom && <p className="text-2xs text-info mt-1.5">A custom workflow is active — its own prompt/review nodes control this flow; the setting still applies to the default pipeline.</p>}
            <label className="flex items-start gap-2 text-sm cursor-pointer mt-4">
              <input type="checkbox" className="mt-1" checked={!!s.confirmPlan} onChange={(e) => setting({ confirmPlan: e.target.checked }, e.target.checked ? 'Plans wait for your approval' : 'Runs start automatically')} />
              <span>Confirm the PM's plan before work starts<span className="block text-xs text-fg-3 mt-0.5">Off: the run starts as soon as the PM has planned it. You can still edit the plan or pause.</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer mt-3">
              <input type="checkbox" className="mt-1" checked={!!s.selfReview} onChange={(e) => setting({ selfReview: e.target.checked }, e.target.checked ? 'Author may review own work' : 'Independent review required')} />
              <span>Without a tester, let the developer do the review pass<span className="block text-xs text-fg-3 mt-0.5">Only used when no agent holds the tester role.{rv?.custom ? ' Inert while a custom workflow is active — the graph decides who reviews.' : ''}</span></span>
            </label>
          </Panel>

          <Panel title="Recent routing decisions">
            <ol className="space-y-2 max-h-96 overflow-auto">
              {(decisions ?? []).map((d) => (
                <li key={d.seq} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <Tag tone={TIER_TONE[d.required] ?? 'idle'}>{d.kind}</Tag>
                    <span className="text-fg-2">{d.agent}</span>
                    {d.node && <Tag tone="idle" title={`workflow node ${d.nodeId}`}>{d.node}</Tag>}
                    <span className="ml-auto text-fg-4 num">{fmtAgo(d.ts)}</span>
                  </div>
                  <div className="text-fg-3 mt-0.5 break-words">{d.reason}{d.options > 1 ? ` · ${d.options} options` : ''}</div>
                </li>
              ))}
              {!decisions?.length && <Muted>No routing decisions yet — they appear as work is dispatched.</Muted>}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}
