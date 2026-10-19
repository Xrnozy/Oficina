import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, put, useQuery } from '../api';
import { Avatar, Muted, PageHeader, Panel, Segmented, Tag, act, fmtAgo, useCurrentRun, type Tone } from '../components';
import { ArrowDown, ArrowRight, ArrowUp, CornerUpLeft, Mail, Pencil, Plus, X } from 'lucide-react';
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
          <select className="input input-sm" value={effort} onChange={(e) => setEffort(e.target.value)} aria-label="Reasoning effort">
            {EFFORTS.map((e) => <option key={e} value={e}>{e === 'auto' ? 'auto (by task)' : e}</option>)}
          </select>
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
                <select className="input input-sm" value={m.strength_tier} onChange={(e) => setTier(m.id, e.target.value)} aria-label="Model tier" title="What this model is strong enough for">
                  {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
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
          <select className="input input-sm" value={adding.accountId} onChange={(e) => setAdding({ accountId: e.target.value, modelId: null })} aria-label="Backend">
            <option value="">backend…</option>
            {accounts.filter((a) => a.enabled).map((a) => <option key={a.id} value={a.id}>{providers.providers.find((p: any) => p.id === a.provider_id)?.name ?? a.label}</option>)}
          </select>
          <select className="input input-sm flex-1 min-w-[10rem]" value={adding.modelId ?? ''} disabled={!adding.accountId} onChange={(e) => setAdding({ ...adding, modelId: e.target.value || null })} aria-label="Model">
            <option value="">provider default</option>
            {models.filter((m) => m.provider_id === accounts.find((a) => a.id === adding.accountId)?.provider_id).map((m) => <option key={m.id} value={m.id}>{modelLabel(m)} · {m.strength_tier}</option>)}
          </select>
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
function NodeRouting({ step, rv, agents, providers, onSaved }: { step: RoutingStep; rv: RoutingView; agents: any[]; providers: any; onSaved: () => void }) {
  const editable = rv.custom;
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
  const full = (id: string) => agents.find((a) => a.id === id);
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap rounded-lg border border-line/70 bg-raised/40 px-3 py-2">
        <label className="text-xs text-fg-3">model tier override
          <select className="input input-sm block mt-0.5" value={tier} disabled={!editable} onChange={(e) => setTier(e.target.value)}
            title={editable ? 'Force the tier the router requires for this step' : 'The default pipeline is read-only — clone it in Workflow'}>
            <option value="">auto — by kind &amp; difficulty</option>
            <option value="fast">fast</option>
            <option value="standard">standard</option>
            <option value="strong">strong</option>
          </select>
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

// One step on the flow strip — a workflow node. Click opens it in the editor.
function StepCard({ s }: { s: RoutingStep }) {
  return (
    <Link
      to={`/workflow?node=${s.nodeId}`}
      className={`rounded-xl border px-3 py-2 text-xs min-w-[10rem] max-w-[15rem] block hover:border-line-strong transition-colors ${s.disabled ? 'border-line/50 opacity-55' : 'border-line'} ${s.warnings.length ? 'border-warn/60' : ''}`}
      title={`${s.label}${s.warnings.length ? ` — ${s.warnings.join('; ')}` : ''}`}
    >
      <div className="font-medium text-fg text-sm flex items-center gap-1.5 flex-wrap">
        {s.label}
        {s.disabled && <Tag tone="idle">bypassed</Tag>}
        {s.type === 'merge' && <Tag tone="idle">merge</Tag>}
        {s.type === 'human' && <Tag tone="warn">approval</Tag>}
      </div>
      <div className="text-fg-3 mt-0.5">
        {s.type === 'start' && 'the request enters here'}
        {s.type === 'end' && 'task completes here'}
        {s.type === 'condition' && 'branches on a check'}
        {s.type === 'merge' && 'waits for its branches'}
        {s.type === 'human' && 'pauses for you'}
        {s.type === 'agent' && (PURPOSE_LABEL[s.purpose ?? ''] ?? s.purpose ?? 'step')}
        {s.scope === 'run' && ' · once per run'}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {s.type === 'agent' && (
          s.agentId
            ? (s.agents.length ? s.agents.map((a) => <Tag key={a.id}>{a.name}</Tag>) : <Tag tone="bad">agent deleted</Tag>)
            : s.role
              ? (s.agents.length ? s.agents.map((a) => <Tag key={a.id}>{a.name}</Tag>) : <Tag tone="warn">any {s.role} — none assigned</Tag>)
              : <Tag tone="warn">no agent or role</Tag>
        )}
        {s.modelTier && <Tag tone={TIER_TONE[s.modelTier]}>{s.modelTier}</Tag>}
        {s.warnings.map((w, k) => <Tag key={k} tone="warn" title={w}>!</Tag>)}
      </div>
      {(s.loops.length > 0 || s.exits.length > 0 || s.messages.length > 0) && (
        <div className="mt-1.5 space-y-0.5 border-t border-line/60 pt-1">
          {s.loops.map((e) => (
            <div key={e.edgeId} className="flex items-center gap-1 text-2xs text-fg-3">
              <CornerUpLeft size={10} className="shrink-0" /> {e.label ?? 'back'} → {e.toLabel}{e.maxLoops ? ` ×${e.maxLoops}` : ''}
            </div>
          ))}
          {s.exits.map((e) => (
            <div key={e.edgeId} className="flex items-center gap-1 text-2xs text-fg-3">
              <ArrowRight size={10} className="shrink-0" /> {e.label ?? e.kind} → {e.toLabel}
            </div>
          ))}
          {s.messages.map((e) => (
            <div key={e.edgeId} className="flex items-center gap-1 text-2xs text-info">
              <Mail size={10} className="shrink-0" /> {e.label ?? 'message'} → {e.toLabel}
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}

function FlowRows({ rows }: { rows: RoutingRow[] }) {
  return (
    <ol className="flex flex-wrap items-stretch gap-2">
      {rows.map((r, i) => <FlowRowView key={i} row={r} arrow={i > 0} />)}
    </ol>
  );
}

function FlowRowView({ row, arrow = true }: { row: RoutingRow; arrow?: boolean }) {
  if (row.kind === 'step') {
    return (
      <>
        {arrow && <li className="self-center text-fg-4"><ArrowRight size={14} /></li>}
        <li><StepCard s={row.step} /></li>
      </>
    );
  }
  if (row.kind === 'back') {
    return (
      <li className="self-center flex items-center gap-1 text-2xs text-fg-3 rounded-lg border border-dashed border-line px-2 py-1">
        <CornerUpLeft size={11} /> back to {row.toLabel}
      </li>
    );
  }
  // a fan-out: each lane is a stacked row labeled by its condition
  return (
    <li className="w-full mt-1 space-y-1.5">
      {row.lanes.map((l) => (
        <div key={l.edgeId} className="flex items-start gap-2">
          <Tag tone={l.isElse ? 'idle' : 'info'}>{l.label}</Tag>
          <ArrowRight size={12} className="mt-1 text-fg-4 shrink-0" />
          <ol className="flex flex-wrap items-stretch gap-2 min-w-0">
            {l.rows.map((r, i) => <FlowRowView key={i} row={r} arrow={i > 0} />)}
          </ol>
        </div>
      ))}
    </li>
  );
}

export default function Routing() {
  const { run } = useCurrentRun();
  const { data: workspaces, reload: reloadWs } = useQuery<any[]>('/workspaces');
  const { data: agents, reload: reloadAgents } = useQuery<any[]>('/agents');
  const { data: providers, reload: reloadProviders } = useQuery<any>('/providers');
  const { data: decisions } = useQuery<any[]>('/routing/decisions');
  const ws = workspaces?.find((w) => w.id === run?.workspaceId) ?? workspaces?.[0];
  const { data: rv, reload: reloadRv } = useQuery<RoutingView>(ws?.id ? `/workflows/active/routing?workspaceId=${ws.id}` : null, [ws?.id]);
  const s = ws?.settings ?? {};
  const strategy: (typeof STRATEGIES)[number] = s.routing === 'fixed' ? 'fixed' : 'smart';
  const prompts: (typeof PROMPTS)[number] = s.promptReview === 'off' ? 'off' : s.promptReview === 'all' ? 'all' : s.promptReview === 'handoffs' || s.promptReview === 'implement' ? 'handoffs' : 'pipeline';
  const workMode: (typeof WORK_MODES)[number] = s.workMode === 'isolated' ? 'isolated' : 'direct';
  const commitMode: (typeof COMMIT_MODES)[number] = s.commitMode === 'auto' ? 'auto' : s.commitMode === 'manual' ? 'manual' : 'approve';
  const approvalMode: (typeof APPROVAL_MODES)[number] = s.approvalMode === 'ask-when-risky' ? 'ask-when-risky' : s.approvalMode === 'auto' ? 'auto' : 'always-ask';
  const setting = (patch: Record<string, unknown>, msg: string) => ws && act(put(`/workspaces/${ws.id}/settings`, patch), msg).then(reloadWs);
  const reload = () => { reloadAgents(); reloadProviders(); };

  return (
    <div className="space-y-5">
      <PageHeader title="Routing" sub="Send a request to the PM; every hand-off after that is automatic. Pick which models each role may use — the router chooses between them per task by what the work needs, what's available and what it costs." />

      <Panel title="Flow"
        action={
          <div className="flex items-center gap-2">
            {rv && <Tag tone={rv.custom ? 'info' : 'idle'} title={rv.workflow.builtin ? 'the read-only built-in pipeline' : 'a custom workflow is active'}>{rv.workflow.name} · v{rv.workflow.versionN ?? '—'}</Tag>}
            <Link to="/workflow" className="btn btn-ghost btn-xs"><Pencil size={11} /> Edit in Workflow</Link>
          </div>
        }>
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
        <p className="text-xs text-fg-3 mt-3">Every step is a node on the active workflow — click one to open it in the editor. Loops are bounded, then you decide. You can message any agent, edit requirements, change models, or pause at any time; every change can be undone from Checkpoints.</p>
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
              <NodeRouting step={step} rv={rv!} agents={agents ?? []} providers={providers} onSaved={() => { reloadRv(); reload(); }} />
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
            <label className="flex items-start gap-2 text-sm cursor-pointer mt-4">
              <input type="checkbox" className="mt-1" checked={!!s.confirmPlan} onChange={(e) => setting({ confirmPlan: e.target.checked }, e.target.checked ? 'Plans wait for your approval' : 'Runs start automatically')} />
              <span>Confirm the PM's plan before work starts<span className="block text-xs text-fg-3 mt-0.5">Off: the run starts as soon as the PM has planned it. You can still edit the plan or pause.</span></span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer mt-3">
              <input type="checkbox" className="mt-1" checked={!!s.selfReview} onChange={(e) => setting({ selfReview: e.target.checked }, e.target.checked ? 'Author may review own work' : 'Independent review required')} />
              <span>Without a tester, let the developer do the review pass<span className="block text-xs text-fg-3 mt-0.5">Only used when no agent holds the tester role.</span></span>
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
