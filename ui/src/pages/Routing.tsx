import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { put, useQuery } from '../api';
import { Avatar, Muted, PageHeader, Panel, Segmented, Tag, act, fmtAgo, useCurrentRun, type Tone } from '../components';
import { ArrowDown, ArrowRight, ArrowUp, Plus, X } from 'lucide-react';

// Routing: who does each step of the flow, which models each step may run
// on, and how the router picks between them. Every hand-off is automatic.

const FLOW: { role: string; step: string; does: string }[] = [
  { role: 'pm', step: 'PM', does: 'turns the request into tasks and acceptance criteria' },
  { role: 'prompt-creator', step: 'Prompt Creator', does: 'drafts the implementation prompt; the PM reviews it until approved' },
  { role: 'developer', step: 'Developer', does: 'edits your repository, self-checks, writes change notes' },
  { role: 'qa', step: 'Reviewer / tester', does: 'checks the work against the approved prompt and criteria' },
  { role: 'pm', step: 'PM', does: 'accepts — or the Prompt Creator drafts a correction' },
];
const EXTRA_ROLES = ['docs', 'analyst', 'reviewer', 'prompt-creator'];
const ROLE_LABEL: Record<string, string> = { pm: 'PM', developer: 'Developer', qa: 'Tester (review & validate)', docs: 'Docs', analyst: 'Analyst', reviewer: 'Reviewer', 'prompt-creator': 'Prompt Creator' };

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

export default function Routing() {
  const { run } = useCurrentRun();
  const { data: workspaces, reload: reloadWs } = useQuery<any[]>('/workspaces');
  const { data: agents, reload: reloadAgents } = useQuery<any[]>('/agents');
  const { data: providers, reload: reloadProviders } = useQuery<any>('/providers');
  const { data: decisions } = useQuery<any[]>('/routing/decisions');
  const ws = workspaces?.find((w) => w.id === run?.workspaceId) ?? workspaces?.[0];
  const s = ws?.settings ?? {};
  const strategy: (typeof STRATEGIES)[number] = s.routing === 'fixed' ? 'fixed' : 'smart';
  const prompts: (typeof PROMPTS)[number] = s.promptReview === 'off' ? 'off' : s.promptReview === 'all' ? 'all' : s.promptReview === 'handoffs' || s.promptReview === 'implement' ? 'handoffs' : 'pipeline';
  const workMode: (typeof WORK_MODES)[number] = s.workMode === 'isolated' ? 'isolated' : 'direct';
  const commitMode: (typeof COMMIT_MODES)[number] = s.commitMode === 'auto' ? 'auto' : s.commitMode === 'manual' ? 'manual' : 'approve';
  const approvalMode: (typeof APPROVAL_MODES)[number] = s.approvalMode === 'ask-when-risky' ? 'ask-when-risky' : s.approvalMode === 'auto' ? 'auto' : 'always-ask';
  const setting = (patch: Record<string, unknown>, msg: string) => ws && act(put(`/workspaces/${ws.id}/settings`, patch), msg).then(reloadWs);
  const holders = (role: string) => (agents ?? []).filter((a) => (a.memberships ?? []).some((m: any) => m.role === role && m.active && m.workspace_id === ws?.id));
  const roles = ['pm', 'prompt-creator', 'developer', 'qa', ...EXTRA_ROLES.filter((r) => r !== 'prompt-creator' && holders(r).length)];
  const reload = () => { reloadAgents(); reloadProviders(); };

  return (
    <div className="space-y-5">
      <PageHeader title="Routing" sub="Send a request to the PM; every hand-off after that is automatic. Pick which models each role may use — the router chooses between them per task by what the work needs, what's available and what it costs." />

      <Panel title="Flow">
        <ol className="flex flex-wrap items-stretch gap-2">
          <li className="rounded-xl border border-line px-3 py-2 text-xs min-w-[8rem]"><div className="font-medium text-fg text-sm">You</div><div className="text-fg-3">send a request (and can step in anywhere)</div></li>
          {FLOW.map((f, i) => {
            const who = holders(f.role);
            return (
              <React.Fragment key={i}>
                <li className="self-center text-fg-4"><ArrowRight size={14} /></li>
                <li className="rounded-xl border border-line px-3 py-2 text-xs min-w-[10rem] max-w-[15rem]">
                  <div className="font-medium text-fg text-sm">{f.step}</div>
                  <div className="text-fg-3">{f.does}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {who.length ? who.map((a) => <Tag key={a.id}>{a.name}</Tag>) : <Link to="/office" className="text-warn hover:underline">assign an agent</Link>}
                  </div>
                </li>
              </React.Fragment>
            );
          })}
        </ol>
        <p className="text-xs text-fg-3 mt-3">Build/test checks run after the developer; failures go to the PM and Prompt Creator as a correction (in pipeline mode). Loops are bounded (3 attempts), then you decide. The PM is called only when a decision is needed — planning, prompt approval, acceptance. You can message any agent, edit requirements, change models, or pause at any time; every change can be undone from Checkpoints.</p>
      </Panel>

      <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-5 items-start [&>*]:min-w-0">
        <div className="space-y-5">
          {roles.map((role) => (
            <Panel key={role} title={ROLE_LABEL[role] ?? role}>
              <div className="space-y-3">
                {holders(role).map((a) => <AgentModels key={a.id} agent={a} providers={providers} onSaved={reload} />)}
                {!holders(role).length && <Muted>No agent holds this role — <Link to="/office" className="underline">assign one</Link>.</Muted>}
              </div>
            </Panel>
          ))}
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
