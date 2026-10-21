import { Select } from '../Select';
import { agentInOffice, useOffice } from '../office';
import React, { useState } from 'react';
import { get, post, put, useQuery } from '../api';
import { useProviderCatalog } from './Providers';
import { TierPicker } from '../tier';
import { AgentFiles } from '../attachments';
import { DEFAULT_SESSION, SessionSettings, SessionsPanel, useCliSessions, type CliSessionSettings } from '../cliSessions';
import { Avatar, Drawer, Empty, KV, Modal, ObsBadge, PageHeader, Segmented, Skeleton, StatusChip, Tag, act, fmtUsd, roleLabel, toast } from '../components';
import { ArrowDown, ArrowUp, Cpu, Plus, Send, SlidersHorizontal, Square, UserMinus, UserPlus, X } from 'lucide-react';

function modelLabel(m: any): string {
  return m?.label ?? m?.supports?.displayName ?? m?.name ?? '';
}

function backendName(providers: any, accountId?: string | null, modelId?: string | null): React.ReactNode {
  if (!accountId) return <span className="text-fg-4">no backend</span>;
  const acct = providers?.accounts?.find((x: any) => x.id === accountId);
  const prov = providers?.providers?.find((p: any) => p.id === acct?.provider_id);
  const model = providers?.models?.find((m: any) => m.id === modelId);
  if (!acct) return <span className="text-bad">{accountId} (removed)</span>;
  return <span className="text-xs">{prov?.name ?? acct.provider_id} <span className="text-fg-4">/</span> <span className="mono">{model ? modelLabel(model) : 'provider default'}</span></span>;
}

function settingsSummary(m: any): string {
  if (!m) return 'provider defaults';
  const parts = [
    m.reasoningEffort && `reasoning ${m.reasoningEffort}`,
    m.temperature != null && `temp ${m.temperature}`,
    m.maxOutputTokens && `≤${m.maxOutputTokens.toLocaleString()} out`,
    m.contextTokens && `${m.contextTokens.toLocaleString()} ctx`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'provider defaults';
}

function sessionSummary(agent: any, sessions: { agentId: string | null; status: string }[]): string {
  const mode = agent.model?.cliSession?.mode ?? 'reuse';
  const n = sessions.filter((x) => x.agentId === agent.id && x.status === 'active').length;
  const label = mode === 'new' ? 'new session each time' : mode === 'pinned' ? 'one pinned session' : 'reuses its session';
  return mode === 'new' ? label : `${label} · ${n} session${n === 1 ? '' : 's'}`;
}

const EFFORTS = ['default', 'auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] as const; // auto: the router sizes it per task
const CLI_EFFORTS = ['default', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'] as const; // Claude Code's --effort levels; there is no off
const API_EFFORTS = ['default', 'auto', 'off', 'low', 'medium', 'high'] as const;
const SUPPORT_NOTE: Record<string, string> = { model: 'Only some models or tools accept this (Claude Code takes effort and max output; no CLI takes a temperature).', engine: 'Applied by the Office, not the provider.' };

// Per-agent model configuration (spec 3): provider/account, actual model,
// reasoning effort, parameters, fallback chain and spend caps. Fields the
// integration can't apply are disabled and say why.
function ModelSettings({ agent, providers, onClose, onSaved }: { agent: any; providers: any; onClose: () => void; onSaved: () => void }) {
  const accounts: any[] = providers?.accounts ?? [];
  const models: any[] = providers?.models ?? [];
  const provOf = (accountId: string | null) => providers?.providers?.find((p: any) => p.id === accounts.find((a) => a.id === accountId)?.provider_id);
  const modelsFor = (accountId: string | null) => models.filter((m) => m.provider_id === accounts.find((a) => a.id === accountId)?.provider_id);
  const m = agent.model ?? {};
  const [name, setName] = useState<string>(agent.name);
  const [avatar, setAvatar] = useState<string>(agent.avatar ?? '');
  const [accountId, setAccountId] = useState<string | null>(agent.accountId);
  const [modelId, setModelId] = useState<string | null>(agent.modelId);
  const [effort, setEffort] = useState<(typeof EFFORTS)[number]>(m.reasoningEffort ?? 'default');
  const [temp, setTemp] = useState<string>(m.temperature != null ? String(m.temperature) : '');
  const [maxOut, setMaxOut] = useState<string>(m.maxOutputTokens ? String(m.maxOutputTokens) : '');
  const [ctx, setCtx] = useState<string>(m.contextTokens ? String(m.contextTokens) : '');
  const [fallbacks, setFallbacks] = useState<{ accountId: string; modelId: string | null }[]>(m.fallbacks ?? []);
  const [tier, setTier] = useState<string>(m.tierOverride ?? '');
  const [cliSession, setCliSession] = useState<CliSessionSettings>({ ...DEFAULT_SESSION, ...(m.cliSession ?? {}) });
  const { data: sessData } = useCliSessions();
  const [perTask, setPerTask] = useState<string>(String(agent.caps?.perTaskUsd ?? 10));
  const [perDay, setPerDay] = useState<string>(String(agent.caps?.perDayUsd ?? 50));
  const [problem, setProblem] = useState('');
  const prov = provOf(accountId);
  const sup = prov?.settingsSupport ?? {};
  const isCli = prov?.adapter_id === 'cli';
  const { office: refOffice } = useOffice();
  const cliBackend = sessData?.backends.find((b) => b.accountId === accountId);
  const off = (k: string) => sup[k] === 'no';
  // models the backend itself says it offers (live, not a hardcoded list)
  const { models: remoteCatalog, loading: catalogLoading, error: catalogError } = useProviderCatalog(prov?.id, prov?.adapter_id);

  const field = (k: string, label: string, child: React.ReactNode) => (
    <label className={`block ${off(k) ? 'opacity-50' : ''}`}>
      <span className="field-label">{label}</span>
      {child}
      <span className="text-2xs text-fg-4 mt-1 block">{off(k) ? `Not supported by ${prov?.name ?? 'this integration'}.` : SUPPORT_NOTE[sup[k]] ?? (sup[k] === 'yes' ? 'Sent on every call.' : '')}</span>
    </label>
  );

  const save = async () => {
    const num = (s: string) => (s.trim() === '' ? null : Number(s));
    const t = num(temp), mo = num(maxOut), cx = num(ctx);
    if (t != null && (Number.isNaN(t) || t < 0 || t > 2)) return setProblem('Temperature must be between 0 and 2.');
    if (mo != null && (!Number.isInteger(mo) || mo < 256)) return setProblem('Max output tokens must be a whole number ≥ 256.');
    if (cx != null && (!Number.isInteger(cx) || cx < 2000)) return setProblem('Context limit must be a whole number ≥ 2000.');
    if (fallbacks.some((f) => !f.accountId)) return setProblem('Pick a backend for every fallback, or remove the empty row.');
    if (isCli && cliSession.mode === 'pinned' && !cliSession.pinnedId) return setProblem('Choose the session to pin, or pick another session mode.');
    if (fallbacks.some((f) => f.accountId === accountId && f.modelId === modelId)) return setProblem('A fallback repeats the primary model.');
    setProblem('');
    // A catalog model that isn't registered on the provider yet — register it
    // first so the agent references a real model row.
    let finalModelId = modelId;
    if (modelId?.startsWith('new:')) {
      if (!prov) return setProblem('Pick a backend before choosing a catalog model.');
      const modelName = modelId.slice(4);
      const displayName = remoteCatalog.find((m) => m.uid === modelName)?.name;
      const reg = await act(post(`/providers/${prov.id}/models`, { name: modelName, displayName }), `${displayName ?? modelName} registered on ${prov.id}`);
      if (!reg) return;
      finalModelId = `${prov.id}:${modelName}`;
    }
    const r = await act(put(`/agents/${agent.id}`, {
      name: name.trim() || agent.name, avatar,
      accountId, modelId: finalModelId,
      settings: { reasoningEffort: effort === 'default' ? null : effort, temperature: t, maxOutputTokens: mo, contextTokens: cx, fallbacks, tierOverride: tier || null, ...(isCli ? { cliSession } : {}) },
      caps: { perTaskUsd: Number(perTask) || 0, perDayUsd: Number(perDay) || 0 },
    }), `${agent.name} updated — applies from the next call`);
    if (r) onSaved();
  };

  const move = (i: number, d: number) => setFallbacks((f) => { const n = [...f]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });

  return (
    <Drawer title={<><Avatar agent={agent} size="sm" /><span className="text-[15px] font-semibold truncate">{agent.name} · model settings</span></>} onClose={onClose}
      footer={<div className="flex items-center gap-2">
        {problem && <span className="text-xs text-bad flex-1">{problem}</span>}
        <div className="flex-1" />
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>}>
      <div className="space-y-6">
        <section className="grid grid-cols-[1fr_88px] gap-3">
          <label className="block"><span className="field-label">Name</span>
            <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block"><span className="field-label">Avatar</span>
            <input className="input w-full text-center" value={avatar} onChange={(e) => setAvatar(e.target.value)} />
          </label>
        </section>

        <section className="space-y-3.5">
          <h3 className="eyebrow">Provider & model</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="field-label">Backend</span>
              <Select className="input w-full" value={accountId ?? ''} onChange={(e) => { const v = e.target.value || null; setAccountId(v); setModelId(modelsFor(v)[0]?.id ?? null); }}>
                <option value="">— none —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label ?? a.id}</option>)}
              </Select>
            </label>
            {field('modelSelect', 'Model',
              <Select className="input w-full" disabled={off('modelSelect')} value={modelId ?? ''} onChange={(e) => setModelId(e.target.value || null)}>
                <option value="">provider default</option>
                {modelsFor(accountId).map((x) => <option key={x.id} value={x.id}>{modelLabel(x)}</option>)}
                {remoteCatalog.filter((m) => !modelsFor(accountId).some((x) => x.name === m.uid)).map((m) => <option key={m.uid} value={`new:${m.uid}`}>{m.name}</option>)}
              </Select>)}
          </div>
          {catalogLoading && <p className="text-xs text-fg-4">Loading models from {prov?.name ?? 'the provider'}…</p>}
          {catalogError && <p className="text-xs text-warn">Couldn't list models from {prov?.name ?? 'the provider'}: {catalogError}. Registered models are still shown.</p>}
          {sup.note && <p className="text-xs text-fg-3 rounded-lg border border-line bg-sunken/50 px-3 py-2">{sup.note}</p>}
        </section>

        <section className="space-y-3">
          <h3 className="eyebrow">Model tier</h3>
          <TierPicker value={tier} onChange={setTier}
            note="Forces the tier for everything this agent does, in any workflow, including the default pipeline. A workflow step that sets its own tier still wins." />
        </section>

        {refOffice && (
          <section className="space-y-3">
            <h3 className="eyebrow">Reference files</h3>
            <p className="text-xs text-fg-3">Files only {agent.name} is told about, on top of the office-wide references. Listed in its prompts; opened only when relevant.</p>
            <AgentFiles agentId={agent.id} workspaceId={refOffice.id} />
          </section>
        )}

        {isCli && <SessionSettings value={cliSession} onChange={setCliSession} backend={cliBackend} accountId={accountId} data={sessData} />}

        <section className="space-y-3.5">
          <h3 className="eyebrow">Model parameters</h3>
          {field('reasoningEffort', 'Reasoning effort', <div className={off('reasoningEffort') ? 'pointer-events-none' : ''}><Segmented value={effort} options={isCli ? CLI_EFFORTS : API_EFFORTS} onChange={setEffort} /></div>)}
          <div className="grid grid-cols-3 gap-3">
            {field('temperature', 'Temperature', <input className="input w-full num" placeholder="default" disabled={off('temperature')} value={temp} onChange={(e) => setTemp(e.target.value)} />)}
            {field('maxOutputTokens', 'Max output', <input className="input w-full num" placeholder="model max" disabled={off('maxOutputTokens')} value={maxOut} onChange={(e) => setMaxOut(e.target.value)} />)}
            {field('contextTokens', 'Context limit', <input className="input w-full num" placeholder="auto" disabled={off('contextTokens')} value={ctx} onChange={(e) => setCtx(e.target.value)} />)}
          </div>
        </section>

        <section className="space-y-2.5">
          <div className="flex items-center"><h3 className="eyebrow flex-1">Fallback models, in priority order</h3>
            <button className="btn btn-xs" onClick={() => setFallbacks((f) => [...f, { accountId: '', modelId: null }])}><Plus size={11} /> Add</button>
          </div>
          <p className="text-xs text-fg-3">When this agent's model hits a rate limit, runs out of quota or is unavailable, the same agent continues on the next model here with the same prompt, task state and pending decisions. Each model is tried once per step; if all fail, the work moves to another agent in the same role.</p>
          {fallbacks.map((f, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-2xs text-fg-4 num w-4">{i + 1}.</span>
              <Select className="input input-sm flex-1 min-w-0" value={f.accountId} onChange={(e) => setFallbacks((all) => all.map((x, j) => j === i ? { accountId: e.target.value, modelId: modelsFor(e.target.value)[0]?.id ?? null } : x))}>
                <option value="">backend…</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label ?? a.id}</option>)}
              </Select>
              <Select className="input input-sm flex-1 min-w-0" value={f.modelId ?? ''} onChange={(e) => setFallbacks((all) => all.map((x, j) => j === i ? { ...x, modelId: e.target.value || null } : x))}>
                <option value="">provider default</option>
                {modelsFor(f.accountId).map((x) => <option key={x.id} value={x.id}>{modelLabel(x)}</option>)}
              </Select>
              <button className="btn btn-ghost btn-icon btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={12} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" disabled={i === fallbacks.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={12} /></button>
              <button className="btn btn-ghost btn-icon btn-sm hover:!text-bad" onClick={() => setFallbacks((all) => all.filter((_, j) => j !== i))} aria-label="Remove fallback"><X size={12} /></button>
            </div>
          ))}
          {!fallbacks.length && <div className="text-xs text-fg-4">No fallback models.</div>}
        </section>

        <section className="space-y-3">
          <h3 className="eyebrow">Usage limits</h3>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="field-label">Per task (USD)</span><input className="input w-full num" type="number" min={0} value={perTask} onChange={(e) => setPerTask(e.target.value)} /></label>
            <label className="block"><span className="field-label">Per day (USD)</span><input className="input w-full num" type="number" min={0} value={perDay} onChange={(e) => setPerDay(e.target.value)} /></label>
          </div>
          <p className="text-2xs text-fg-4">Account-wide monthly budgets are set per backend on the Providers page.</p>
        </section>
      </div>
    </Drawer>
  );
}

// Spec §8.6 observability levels.
const OBS_OPTIONS = [
  { v: 'full', l: 'Full — every model call, tool call and diff (API models)' },
  { v: 'actions', l: 'Actions — streamed tool calls and output (CLI agents)' },
  { v: 'status-only', l: 'Status only — session state, commits, CI (hosted agents)' },
  { v: 'manual', l: 'Manual — whatever you paste or commit' },
];

export default function Agents() {
  const { office } = useOffice();
  const { data: everyone, reload, loading } = useQuery<any[]>('/agents');
  // only the agents of the current office; the others belong to their own offices
  const agents = everyone ? everyone.filter((a) => agentInOffice(a, office?.id)) : null;
  const { data: workspaces } = useQuery<any[]>('/workspaces');
  const { data: roles } = useQuery<any[]>('/roles');
  const { data: providers } = useQuery<any>('/providers');
  const { data: sessData, reload: reloadSessions } = useCliSessions();
  const { data: officeRepos } = useQuery<any[]>(office ? `/repos?workspaceId=${office.id}` : null, [office?.id]);
  const [hire, setHire] = useState(false);
  const [form, setForm] = useState({ name: '', role: '', workspace: '', avatar: '', observability: 'actions' });
  const [tried, setTried] = useState(false);
  const [msgAgent, setMsgAgent] = useState<any | null>(null);
  const [config, setConfig] = useState<any | null>(null);
  const [text, setText] = useState('');

  const openHire = () => {
    setForm({ name: '', avatar: '', observability: 'actions', workspace: office?.id ?? workspaces?.[0]?.id ?? '', role: roles?.find((r) => r.name === 'developer')?.id ?? roles?.[0]?.id ?? '' });
    setTried(false); setHire(true);
  };

  return (
    <div>
      <PageHeader title="Agents" sub={<>Who works in {office ? <span className="text-fg-2">{office.name}</span> : 'the office'}, which backend each one runs on, and what they're allowed to do.</>}>
        <button className="btn btn-primary" onClick={openHire}><UserPlus size={14} /> Hire agent</button>
      </PageHeader>

      {loading && <Skeleton rows={4} />}
      {!loading && !agents?.length && <Empty icon={Cpu} title="No agents in this office" text="Hire an agent, give it a role here, and point it at a backend — or add existing agents from another office under Roles." />}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {(agents ?? []).map((a) => {
          const active = (a.memberships ?? []).filter((m: any) => m.active);
          return (
            <article key={a.id} className="panel p-4 flex flex-col animate-rise">
              <div className="flex items-start gap-3">
                <Avatar agent={a} size="lg" />
                <div className="flex-1 min-w-0">
                  <h2 className="text-[15px] font-semibold truncate">{a.name}</h2>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {active.map((m: any) => <Tag key={m.id}>{roleLabel(m.role)}</Tag>)}
                    {!active.length && <span className="text-xs text-fg-4">no desk</span>}
                  </div>
                </div>
                <StatusChip value={a.status} />
              </div>
              <dl className="mt-3 divide-line flex-1">
                <KV k="Observability"><ObsBadge level={a.observability} /></KV>
                <KV k="Skills"><span className="num">{a.skillVersionIds?.length ?? 0} attached</span></KV>
                {a.caps?.perTaskUsd != null && <KV k="Caps"><span className="num text-xs">{fmtUsd(a.caps.perTaskUsd)}/task · {fmtUsd(a.caps.perDayUsd)}/day</span></KV>}
                <KV k="Model">{backendName(providers, a.accountId, a.modelId)}</KV>
                <KV k="Settings"><span className="text-xs">{settingsSummary(a.model)}</span></KV>
                {a.model?.tierOverride && <KV k="Tier"><span className="text-xs">{a.model.tierOverride} <span className="text-fg-4">(forced)</span></span></KV>}
                {sessData?.backends.some((b) => b.accountId === a.accountId) && (
                  <KV k="CLI session"><span className="text-xs">{sessionSummary(a, sessData.sessions)}</span></KV>
                )}
                <KV k="Fallbacks">{a.model?.fallbacks?.length
                  ? <ol className="text-xs space-y-0.5">{a.model.fallbacks.map((f: any, i: number) => <li key={i} className="truncate"><span className="text-fg-4 num">{i + 1}.</span> {backendName(providers, f.accountId, f.modelId)}</li>)}</ol>
                  : <span className="text-xs text-fg-4">none — work moves to another agent in the role</span>}</KV>
              </dl>
              <div className="mt-3 pt-3 border-t border-line flex flex-wrap gap-2">
                <button className="btn btn-sm flex-1" onClick={() => setConfig(a)}><SlidersHorizontal size={12} /> Model settings</button>
                {a.status && a.status !== 'idle' && (
                  <button className="btn btn-sm hover:!text-bad" title="Cancel what this agent is doing now; its task goes on hold" onClick={async () => {
                    if (!confirm(`Stop ${a.name}? Its current work is cancelled and its task goes on hold.`)) return;
                    if (await act(post(`/agents/${a.id}/stop`, {}), `${a.name} stopped`)) reload();
                  }}><Square size={12} /> Stop</button>
                )}
                <button className="btn btn-sm" onClick={() => setMsgAgent(a)}><Send size={12} /> Message{a.unread ? <span className="num text-2xs text-fg-4">· {a.unread} queued</span> : null}</button>
                {active.length > 0 && (
                  <button className="btn btn-ghost btn-sm btn-icon hover:!text-bad ml-auto" title="Unassign — remove from all desks" aria-label="Unassign" onClick={async () => {
                    const refs = await get<{ workflowName: string; nodes: { label: string }[] }[]>(`/workflows/refs?agentId=${a.id}`).catch(() => []);
                    const affected = (refs ?? []).flatMap((r) => r.nodes.map((n) => `${r.workflowName}: ${n.label}`));
                    const extra = affected.length ? `\n\nIt is referenced by workflow node(s):\n${affected.map((x) => `  - ${x}`).join('\n')}` : '';
                    if (!confirm(`Remove ${a.name} from all desks? They keep their config but stop receiving work.${extra}`)) return;
                    const r = await act<{ workflowWarnings?: string[] }>(post(`/agents/${a.id}/fire`, {}), `${a.name} removed from all desks`);
                    if (r?.workflowWarnings?.length) toast(`Still referenced: ${r.workflowWarnings.join('; ')}`, 'warn');
                    reload();
                  }}><UserMinus size={13} /></button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <SessionsPanel agents={agents ?? []} repoPath={officeRepos?.[0]?.path ?? null} data={sessData} reload={reloadSessions} />

      {hire && (
        <Modal title="Hire agent" onClose={() => setHire(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setHire(false)}>Cancel</button>
          <button className="btn btn-accent" onClick={async () => {
            setTried(true);
            if (!form.name.trim()) return;
            const r = await act(post('/agents', { ...form, name: form.name.trim(), role: form.workspace ? form.role : undefined }), `${form.name.trim()} hired`);
            if (r) { setHire(false); reload(); }
          }}>Hire</button>
        </>}>
          <div className="space-y-3.5">
            <div className="grid grid-cols-[1fr_96px] gap-3">
              <label className="block"><span className="field-label">Name</span>
                <input className={`input w-full ${tried && !form.name.trim() ? '!border-bad' : ''}`} autoFocus placeholder="e.g. Kofi (QA)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                {tried && !form.name.trim() && <span className="text-xs text-bad mt-1 block">Name is required.</span>}
              </label>
              <label className="block"><span className="field-label">Avatar</span><input className="input w-full text-center" placeholder="🧪" maxLength={4} value={form.avatar} onChange={(e) => setForm({ ...form, avatar: e.target.value })} /></label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="field-label">Workspace</span>
                <Select className="input w-full" value={form.workspace} onChange={(e) => setForm({ ...form, workspace: e.target.value })}>
                  <option value="">None yet</option>
                  {(workspaces ?? []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </label>
              <label className="block"><span className="field-label">Role</span>
                <Select className="input w-full" disabled={!form.workspace} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {(roles ?? []).map((r) => <option key={r.id} value={r.id}>{roleLabel(r.name)}</option>)}
                </Select>
              </label>
            </div>
            <label className="block"><span className="field-label">Observability</span>
              <Select className="input w-full" value={form.observability} onChange={(e) => setForm({ ...form, observability: e.target.value })}>
                {OBS_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
              </Select>
            </label>
            <p className="text-xs text-fg-4">The new agent starts on the first enabled backend. Change it from the agent's card.</p>
          </div>
        </Modal>
      )}

      {config && <ModelSettings agent={config} providers={providers} onClose={() => setConfig(null)} onSaved={() => { setConfig(null); reload(); }} />}

      {msgAgent && (
        <Modal title={`Message ${msgAgent.name}`} onClose={() => setMsgAgent(null)} footer={<>
          <button className="btn btn-ghost" onClick={() => setMsgAgent(null)}>Cancel</button>
          <button className="btn btn-accent" disabled={!text.trim()} onClick={async () => {
            const r = await act(post(`/agents/${msgAgent.id}/message`, { text: text.trim() }), 'Queued — delivered with the agent\'s next prompt');
            if (r) { setMsgAgent(null); setText(''); }
          }}><Send size={13} /> Send</button>
        </>}>
          <textarea className="input w-full h-32" autoFocus placeholder="Guidance for the agent…" value={text} onChange={(e) => setText(e.target.value)} />
          <p className="text-xs text-fg-4 mt-2">The message goes into the agent's inbox and is included in its next prompt. Backends that accept mid-session messages also get it right away.</p>
        </Modal>
      )}
    </div>
  );
}
