import React, { useEffect, useState } from 'react';
import { del, get, post, put, useQuery } from '../api';
import { Empty, Meter, Modal, PageHeader, Panel, Skeleton, Tag, act, fmtIn, fmtNum, fmtUsd, type Tone } from '../components';
import { KeyRound, Plug, Plus, ShieldCheck, Trash2 } from 'lucide-react';

const SUPPORT_LABEL: Record<string, string> = { yes: 'sent', model: 'some models', engine: 'by Office', no: '—' };
const SETTING_NAMES: [string, string][] = [['modelSelect', 'model'], ['reasoningEffort', 'reasoning'], ['temperature', 'temperature'], ['maxOutputTokens', 'max output'], ['contextTokens', 'context'], ['fallbacks', 'fallbacks']];

export function SupportList({ s }: { s?: Record<string, string> }) {
  if (!s) return <span className="text-fg-4">—</span>;
  return (
    <div className="flex flex-wrap gap-1 max-w-[280px]" title={s.note}>
      {SETTING_NAMES.map(([k, l]) => (
        <span key={k} className={`chip ${s[k] === 'no' ? 'opacity-50 line-through' : s[k] === 'yes' ? 'text-ok bg-ok/[0.08] border-ok/20' : ''}`}>{l}{s[k] !== 'no' && s[k] !== 'yes' ? ` · ${SUPPORT_LABEL[s[k]]}` : ''}</span>
      ))}
    </div>
  );
}

// Providers / backends (spec §9, 8): providers, accounts, capabilities,
// quota bars per metric+period, circuit state, cost guardrails.

const KIND_HELP: Record<string, string> = {
  'openai-compatible': 'OpenAI, Ollama, LM Studio — anything speaking the OpenAI API',
  anthropic: 'Claude via the Messages API and an API key',
  cli: 'A headless coding agent already on this machine — Claude Code, Cursor agent, or Devin CLI is detected for you',
  devin: 'Devin — hosted agent in Cognition\'s cloud, driven over its API',
  manual: 'A human relays the work (Tier 3)',
  scripted: 'Deterministic demo agent',
};

const NEEDS_KEY = ['anthropic', 'devin'];
// backend ID suggested for each CLI preset
const PRESET_IDS: Record<string, string> = { claude: 'claude-code', cursor: 'cursor-agent', devin: 'devin-cli' };

// Backends whose model list is fetched live from the provider — never hardcoded.
export const CATALOG_KINDS = ['openai-compatible', 'anthropic', 'cli', 'devin'];
export type RemoteModel = { uid: string; name: string };
type Catalog = { models: RemoteModel[]; loading: boolean; error: string };

// Model list of a saved backend, straight from the provider.
export function useProviderCatalog(providerId: string | null | undefined, adapterId: string | null | undefined): Catalog & { reload: () => void } {
  const [state, setState] = useState<Catalog>({ models: [], loading: false, error: '' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!providerId || !adapterId || !CATALOG_KINDS.includes(adapterId)) { setState({ models: [], loading: false, error: '' }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: '' }));
    get<{ models: RemoteModel[] }>(`/providers/${providerId}/catalog`)
      .then((d) => live && setState({ models: d.models ?? [], loading: false, error: '' }))
      .catch((e) => live && setState({ models: [], loading: false, error: String(e?.message ?? e) }));
    return () => { live = false; };
  }, [providerId, adapterId, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// Model list for a backend still being configured in the "add backend" form.
// CLIs are asked through their own command (e.g. the preset's `claude` or `agent`).
function usePreviewCatalog(form: { kind: string; baseUrl: string; apiKey: string; command: string; orgId: string }): Catalog {
  const [state, setState] = useState<Catalog>({ models: [], loading: false, error: '' });
  const ready = form.kind === 'openai-compatible' ? !!form.baseUrl.trim()
    : form.kind === 'anthropic' || form.kind === 'devin' ? !!form.apiKey.trim()
      : form.kind === 'cli' ? !!form.command.trim() : false;
  useEffect(() => {
    if (!ready) { setState({ models: [], loading: false, error: '' }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true, error: '' }));
    const t = setTimeout(() => {
      post<{ models: RemoteModel[] }>('/providers/catalog-preview', { kind: form.kind, baseUrl: form.baseUrl, apiKey: form.apiKey, command: form.command, orgId: form.orgId })
        .then((d) => live && setState({ models: d.models ?? [], loading: false, error: '' }))
        .catch((e) => live && setState({ models: [], loading: false, error: String(e?.message ?? e) }));
    }, form.kind === 'cli' ? 1200 : 600); // spawning a CLI is slow — wait for typing to settle
    return () => { live = false; clearTimeout(t); };
  }, [form.kind, form.baseUrl, form.apiKey, form.command, form.orgId, ready]);
  return state;
}

// A select over the provider's live model list plus an explicit "custom…" input.
function ModelPicker({ value, onChange, required, catalog, hint }: { value: string; onChange: (v: string) => void; required?: boolean; catalog: Catalog; hint?: string }) {
  const uids = catalog.models.map((m) => m.uid);
  const labelOf = (uid: string) => catalog.models.find((m) => m.uid === uid)?.name ?? uid;
  const [custom, setCustom] = useState(false);
  const isCustom = custom || (value !== '' && !catalog.loading && !uids.includes(value));
  return (
    <span className="block space-y-2">
      <select className="input w-full" disabled={catalog.loading} value={isCustom ? '__custom' : value} onChange={(e) => {
        if (e.target.value === '__custom') { setCustom(true); onChange(''); }
        else { setCustom(false); onChange(e.target.value); }
      }}>
        <option value="">{catalog.loading ? 'loading models from provider…' : required ? (uids.length ? 'pick a model' : '— no models listed —') : 'provider default'}</option>
        {uids.map((m) => <option key={m} value={m}>{labelOf(m) === m ? m : `${labelOf(m)} (${m})`}</option>)}
        <option value="__custom">custom…</option>
      </select>
      {isCustom && <input className="input w-full font-mono" autoFocus placeholder="exact model name" value={value} onChange={(e) => onChange(e.target.value)} />}
      {catalog.error
        ? <span className="text-xs text-warn block">Couldn't list models: {catalog.error}</span>
        : hint && !uids.length && !catalog.loading && <span className="text-xs text-fg-4 block">{hint}</span>}
    </span>
  );
}

// Long model lists are cut short with a "+N more" toggle; hover shows them all.
const MODELS_SHOWN = 4;
function ModelNames({ names }: { names: string[] }) {
  const [open, setOpen] = useState(false);
  if (!names.length) return <div className="text-xs">—</div>;
  const hidden = names.length - MODELS_SHOWN;
  return (
    <div className="text-xs max-w-[220px]" title={hidden > 0 && !open ? names.join(', ') : undefined}>
      {(open || hidden <= 0 ? names : names.slice(0, MODELS_SHOWN)).join(', ')}
      {hidden > 0 && (
        <button type="button" className="ml-1 text-fg-4 hover:text-fg underline underline-offset-2 whitespace-nowrap" onClick={() => setOpen(!open)}>
          {open ? 'show less' : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

const circuitTone = (s: string): Tone => (s === 'closed' ? 'ok' : s === 'open' ? 'bad' : 'warn');

export default function Providers() {
  const { data: providers, reload, loading } = useQuery<any>('/providers');
  const { data: usage } = useQuery<any>('/usage');
  const [adding, setAdding] = useState(false);
  const blank = { kind: 'openai-compatible', id: '', baseUrl: '', model: '', apiKey: '', monthlyBudgetUsd: 25, command: '', timeoutSec: 900, orgId: '', preset: 'claude' };
  const [form, setForm] = useState(blank);
  const [formErr, setFormErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<any | null>(null);
  const [removed, setRemoved] = useState<any | null>(null);
  const [addModel, setAddModel] = useState<any | null>(null);
  // CLI presets come from the daemon, so their commands can't drift from it.
  const { data: cliPresets, loading: presetsLoading } = useQuery<{ id: string; label: string; command: string; installed: boolean; path: string | null }[]>('/cli-presets');
  const installed = (cliPresets ?? []).filter((p) => p.installed);
  const preset = installed.find((p) => p.id === form.preset) ?? (cliPresets ?? []).find((p) => p.id === form.preset) ?? null;
  // fill the command from whichever CLI is actually installed — no preset to pick
  useEffect(() => {
    if (!adding || form.kind !== 'cli' || form.command.trim()) return;
    const pick = (cliPresets ?? []).find((p) => p.installed);
    if (!pick) return;
    setForm((f) => (f.kind === 'cli' && !f.command.trim()
      ? { ...f, preset: pick.id, id: f.id.trim() ? f.id : (PRESET_IDS[pick.id] ?? `${pick.id}-cli`), command: pick.command }
      : f));
  }, [adding, form.kind, form.command, cliPresets]);
  // an empty command means the selected preset's default command
  const effectiveForm = form.kind === 'cli' && !form.command.trim() && preset ? { ...form, command: preset.command } : form;
  const formCatalog = usePreviewCatalog(effectiveForm);
  const addModelProvider = (providers?.providers ?? []).find((p: any) => p.id === addModel?.providerId);
  const addModelCatalog = useProviderCatalog(addModelProvider?.id, addModelProvider?.adapter_id);

  const provs = providers?.providers ?? [];
  const accounts = providers?.accounts ?? [];
  const windows = providers?.windows ?? [];
  const circuits = providers?.circuits ?? [];

  const byAccount = new Map<string, { calls: number; cost: number; inTok: number; outTok: number }>();
  for (const r of usage?.records ?? []) {
    const k = r.account_id ?? '?';
    const agg = byAccount.get(k) ?? { calls: 0, cost: 0, inTok: 0, outTok: 0 };
    agg.calls += r.requests ?? 1; agg.cost += r.cost_usd ?? 0; agg.inTok += r.input_tokens ?? 0; agg.outTok += r.output_tokens ?? 0;
    byAccount.set(k, agg);
  }

  const validate = () => {
    if ((form.kind === 'openai-compatible') && !form.baseUrl.trim()) return 'Base URL is required.';
    if ((form.kind === 'openai-compatible' || form.kind === 'anthropic') && !form.model.trim() && !formCatalog.models.length) return 'Pick a model, or enter one with custom… if the provider could not list its models.';
    if (NEEDS_KEY.includes(form.kind) && !form.apiKey.trim()) return `An API key is required for ${form.kind}.`;
    if (!(form.monthlyBudgetUsd >= 0)) return 'Budget must be zero or more.';
    return '';
  };

  if (loading) return <Skeleton rows={4} />;

  return (
    <div className="space-y-5">
      <PageHeader title="Providers & usage" sub="Backends are opt-in per workspace. Keys stay on this machine, referenced from the OS secret store — never written to the repo.">
        <button className="btn btn-primary" onClick={() => { setForm(blank); setFormErr(''); setAdding(true); }}><Plus size={14} /> Add backend</button>
      </PageHeader>

      {!accounts.length && <Empty icon={Plug} title="No backends" text="Add a model API, a local model server, or a headless CLI agent." />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {accounts.map((a: any) => {
          const prov = provs.find((p: any) => p.id === a.provider_id);
          const wins = windows.filter((w: any) => w.account_id === a.id && w.lim);
          const circ = circuits.filter((c: any) => c.account_id === a.id);
          const use = byAccount.get(a.id);
          return (
            <article key={a.id} className="panel p-4 flex flex-col">
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg bg-raised border border-line grid place-items-center shrink-0"><Plug size={15} strokeWidth={1.75} className="text-fg-3" /></div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-[15px] font-semibold truncate">{a.label ?? a.id}</h2>
                  <div className="text-xs text-fg-3 truncate">{prov?.name ?? a.provider_id}{a.config?.baseUrl ? <> · <span className="mono">{a.config.baseUrl}</span></> : null}</div>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  <Tag>{prov?.kind ?? '?'}</Tag>
                  {prov?.tier != null && <Tag>tier {prov.tier}</Tag>}
                </div>
              </div>

              {circ.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {circ.map((c: any) => <Tag key={c.model_id ?? 'acct'} tone={circuitTone(c.state)} title={c.reason ?? ''}>circuit {c.state}{c.model_id ? ` · ${c.model_id}` : ''}</Tag>)}
                </div>
              )}

              <div className="mt-4 space-y-3 flex-1">
                {wins.map((w: any) => (
                  <div key={w.id}>
                    <div className="flex items-baseline gap-2 text-xs mb-1.5">
                      <span className="text-fg-2">{w.metric} / {w.period}</span>
                      <span className="text-fg-4">{w.source}{w.confidence ? ` · ${w.confidence}` : ''}</span>
                      <span className="ml-auto num text-fg-2">{w.metric === 'usd' ? `${fmtUsd(w.used)} / ${fmtUsd(w.lim)}` : `${Math.round(((w.used ?? 0) / w.lim) * 100)}%`}</span>
                    </div>
                    <Meter value={(w.used ?? 0) / w.lim} />
                    {w.resets_at && <div className="text-2xs text-fg-4 mt-1">resets {fmtIn(w.resets_at)} · {new Date(w.resets_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
                  </div>
                ))}
                {!wins.length && <div className="text-xs text-fg-4">This provider doesn't report limits.</div>}
              </div>

              <div className="mt-4 pt-3 border-t border-line grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-fg-4">Budget</div><div className="text-fg-2 num">{fmtUsd(a.monthly_budget_usd)}/mo</div></div>
                <div><div className="text-fg-4">Usage</div><div className="text-fg-2 num">{use ? `${fmtNum(use.calls)} calls · ${fmtUsd(use.cost)}` : '—'}</div></div>
                <div className="text-right"><div className="text-fg-4">Key</div><div className={`flex items-center justify-end gap-1 ${a.hasSecret ? 'text-ok' : 'text-fg-3'}`}><KeyRound size={11} />{a.hasSecret ? 'stored' : 'none'}</div></div>
              </div>
            </article>
          );
        })}
      </div>

      <Panel title="Provider registry" bodyClass="pb-1">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-2xs text-fg-4 border-b border-line">
              <th className="font-medium px-4 py-2">Provider</th><th className="font-medium px-2">Kind</th><th className="font-medium px-2">Adapter</th>
              <th className="font-medium px-2">Models</th><th className="font-medium px-2">Per-agent settings</th><th className="font-medium px-4 text-right">State</th>
            </tr></thead>
            <tbody className="divide-y divide-line">
              {provs.map((p: any) => {
                const models = (providers?.models ?? []).filter((m: any) => m.provider_id === p.id);
                return (
                  <tr key={p.id} className="hover:bg-raised/50 align-top">
                    <td className="px-4 py-2.5 text-fg">{p.name}<div className="text-2xs text-fg-4">tier {p.tier} · reasoning {p.capabilities?.reasoningVisibility ?? '—'}</div></td>
                    <td className="px-2 py-2.5"><Tag>{p.kind}</Tag></td>
                    <td className="px-2 py-2.5 mono text-fg-3 whitespace-nowrap" title={`hash ${p.adapter_hash}`}>{p.adapter_id}@{p.adapter_version}</td>
                    <td className="px-2 py-2.5 text-fg-3">
                      <ModelNames names={models.map((m: any) => m.label ?? m.name)} />
                      <div className="flex gap-2.5 mt-0.5">
                        {CATALOG_KINDS.includes(p.adapter_id) && <button type="button" className="text-2xs text-fg-3 hover:text-fg underline underline-offset-2" onClick={() => act(post(`/providers/${p.id}/sync-models`, {}), `Models synced from ${p.name}`).then(reload)}>Sync from provider</button>}
                        {p.adapter_id !== 'devin' && p.adapter_id !== 'cli' && <button type="button" className="text-2xs text-fg-3 hover:text-fg underline underline-offset-2" onClick={() => setAddModel({ providerId: p.id, name: '', contextTokens: 128000, maxOutputTokens: 8192, priceIn: 0, priceOut: 0, strengthTier: 'standard' })}>+ add model</button>}
                      </div>
                    </td>
                    <td className="px-2 py-2.5"><SupportList s={p.settingsSupport} /></td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <button className={`chip cursor-pointer ${p.enabled ? 'text-ok bg-ok/[0.08] border-ok/20' : ''}`} title={p.enabled ? 'Click to disable — agents fall back to other backends' : 'Click to enable'}
                          onClick={() => act(put(`/providers/${p.id}`, { enabled: !p.enabled }), `${p.name} ${p.enabled ? 'disabled' : 'enabled'}`).then(reload)}>
                          {p.enabled ? 'enabled' : 'disabled'}
                        </button>
                        <button className="btn btn-ghost btn-icon btn-sm hover:!text-bad" aria-label={`Remove ${p.name}`} title="Remove provider" onClick={() => { setRemoving(p); setRemoved(null); }}><Trash2 size={13} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-2 text-2xs text-fg-4">Settings: <b className="text-fg-3">sent</b> = applied on every call · <b className="text-fg-3">some models</b> = sent, only some models honour it · <b className="text-fg-3">by Office</b> = enforced by the Office, not the provider · <b className="text-fg-3">—</b> = not supported by this integration.</p>
      </Panel>

      {removing && (
        <Modal title={removed ? `${removing.name} removed` : `Remove ${removing.name}?`} onClose={() => { setRemoving(null); setRemoved(null); }} footer={removed
          ? <button className="btn btn-primary" onClick={() => { setRemoving(null); setRemoved(null); }}>Done</button>
          : <>
            <button className="btn btn-ghost" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={busy} onClick={async () => {
              setBusy(true);
              const r = await act(del(`/providers/${removing.id}`));
              setBusy(false);
              if (r) { setRemoved(r); reload(); }
            }}>{busy ? 'Removing…' : 'Remove provider'}</button>
          </>}>
          {!removed ? (() => {
            const accts = accounts.filter((a: any) => a.provider_id === removing.id);
            return (
              <div className="space-y-3 text-sm text-fg-2">
                <p>This deletes from the Office:</p>
                <ul className="list-disc pl-5 space-y-1 text-fg-3">
                  <li>{accts.length} account(s){accts.some((a: any) => a.hasSecret) ? ' and their stored API keys' : ''}</li>
                  <li>its models, quota windows and circuit state</li>
                  <li>it as a primary or fallback backend on any agent — the agent's next fallback takes over</li>
                </ul>
                <p className="text-fg-3">Kept: usage records, work items, prompts and the event log. Other providers' keys are untouched.</p>
                <p className="text-xs text-fg-4">If <span className="mono">office.yaml</span> lists this provider it stays removed after a restart.</p>
              </div>
            );
          })() : (
            <div className="space-y-2.5 text-sm">
              <div className="flex gap-2 items-center text-ok"><ShieldCheck size={15} /> {removed.accountsRemoved} account(s) removed · {removed.secretsDeleted} stored key(s) deleted</div>
              {removed.affectedAgents?.length > 0 && <div className="text-fg-3">Agents updated: {removed.affectedAgents.join(', ')}</div>}
              {removed.envVarsToRemove?.length > 0 && <div className="text-warn">Keys read from environment variables can't be deleted by the Office — remove {removed.envVarsToRemove.join(', ')} yourself.</div>}
              <div className="rounded-lg border border-line bg-sunken/50 p-3 text-xs text-fg-3"><b className="text-fg-2">Remote revocation:</b> {removed.remoteRevocation}.</div>
            </div>
          )}
        </Modal>
      )}

      {addModel && (
        <Modal title={`Add model to ${addModel.providerId}`} onClose={() => setAddModel(null)} footer={<>
          <button className="btn btn-ghost" onClick={() => setAddModel(null)}>Cancel</button>
          <button className="btn btn-accent" disabled={!addModel.name.trim()} onClick={async () => {
            const r = await act(post(`/providers/${addModel.providerId}/models`, addModel), `${addModel.name} added`);
            if (r) { setAddModel(null); reload(); }
          }}>Add model</button>
        </>}>
          <div className="space-y-3.5">
            <label className="block"><span className="field-label">Model name <span className="text-fg-4 font-normal">— exactly as the provider's API expects it</span></span>
              <ModelPicker catalog={addModelCatalog} value={addModel.name} onChange={(v) => setAddModel({ ...addModel, name: v })} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="field-label">Context tokens</span><input className="input w-full num" type="number" value={addModel.contextTokens} onChange={(e) => setAddModel({ ...addModel, contextTokens: +e.target.value })} /></label>
              <label className="block"><span className="field-label">Max output tokens</span><input className="input w-full num" type="number" value={addModel.maxOutputTokens} onChange={(e) => setAddModel({ ...addModel, maxOutputTokens: +e.target.value })} /></label>
              <label className="block"><span className="field-label">$ / 1M input</span><input className="input w-full num" type="number" step="0.01" min={0} value={addModel.priceIn} onChange={(e) => setAddModel({ ...addModel, priceIn: +e.target.value })} /></label>
              <label className="block"><span className="field-label">$ / 1M output</span><input className="input w-full num" type="number" step="0.01" min={0} value={addModel.priceOut} onChange={(e) => setAddModel({ ...addModel, priceOut: +e.target.value })} /></label>
            </div>
            <label className="block"><span className="field-label">Strength</span>
              <select className="input w-full" value={addModel.strengthTier} onChange={(e) => setAddModel({ ...addModel, strengthTier: e.target.value })}>
                <option value="fast">fast — cheap, simple tasks</option><option value="standard">standard</option><option value="strong">strong — hard tasks</option>
              </select>
            </label>
            <p className="text-xs text-fg-4">Prices let the Office compute cost per call; leave 0 if unknown (costs then show as estimates).</p>
          </div>
        </Modal>
      )}

      {adding && (
        <Modal title="Add backend" onClose={() => setAdding(false)} footer={<>
          <button className="btn btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
          <button className="btn btn-accent" disabled={busy} onClick={async () => {
            const v = validate(); setFormErr(v); if (v) return;
            setBusy(true);
            const r = await act(post('/providers', effectiveForm), 'Backend added') as { syncWarning?: string } | null;
            setBusy(false);
            if (r?.syncWarning) setFormErr(`Backend added, but model sync failed: ${r.syncWarning}`);
            else if (r) { setAdding(false); reload(); }
          }}>{busy ? 'Adding…' : 'Add backend'}</button>
        </>}>
          <div className="space-y-3.5">
            <label className="block"><span className="field-label">Kind</span>
              <select className="input w-full" value={form.kind} onChange={(e) => {
                const kind = e.target.value; setFormErr('');
                if (kind !== 'cli') { setForm({ ...form, kind, id: kind === 'devin' ? 'devin' : form.id, timeoutSec: kind === 'devin' ? 3600 : form.timeoutSec }); return; }
                const pick = installed[0];
                setForm({ ...form, kind, model: '', ...(pick ? { preset: pick.id, id: PRESET_IDS[pick.id] ?? `${pick.id}-cli`, command: pick.command } : { command: '' }) });
              }}>
                {Object.keys(KIND_HELP).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <span className="text-xs text-fg-4 mt-1 block">{KIND_HELP[form.kind]}</span>
            </label>
            {form.kind === 'cli' && (
              presetsLoading && !cliPresets ? <p className="text-xs text-fg-4">Looking for CLIs on this machine…</p>
                : installed.length > 1 ? (
                  <div className="space-y-1.5">
                    <span className="field-label">Detected on this machine</span>
                    <div className="flex flex-wrap gap-2">
                      {installed.map((p) => (
                        <button key={p.id} type="button" className={`btn btn-sm ${form.preset === p.id ? 'btn-primary' : ''}`}
                          title={p.path ?? ''}
                          onClick={() => setForm({ ...form, preset: p.id, id: PRESET_IDS[p.id] ?? `${p.id}-cli`, model: '', command: p.command })}>
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : installed.length === 1 ? (
                  <p className="text-xs text-fg-3 truncate" title={installed[0].path ?? ''}>
                    Found <span className="text-fg-2">{installed[0].label}</span>
                    {installed[0].path ? <> · <span className="mono text-fg-4">{installed[0].path}</span></> : null}
                  </p>
                ) : (
                  <p className="text-xs text-warn">No CLI found on this machine. Install Claude Code, cursor-agent, or Devin CLI, or paste a command below.</p>
                )
            )}
            {form.kind === 'devin' && (
              <div className="rounded-lg border border-line bg-sunken/50 p-3 text-xs text-fg-3 leading-relaxed space-y-1.5">
                <p>Devin has no CLI — it runs in Cognition's cloud and talks to this app over its API.</p>
                <p><span className="text-fg-2 font-medium">Get a key:</span> app.devin.ai → Settings → API Keys → create one (starts with <span className="mono">cog_</span>). Paste it below.</p>
                <p><span className="text-fg-2 font-medium">Models</span> are the agent modes your organization can use (normal, fast, fusion, SWE-2…), listed live from the Devin API once you paste the key. Use <span className="text-fg-2">Sync from provider</span> in the registry to refresh. <span className="text-fg-2 font-medium">Organization ID</span> (Settings → Devin API) is needed for sessions with a chosen model.</p>
                <p>Devin returns work by pushing a <span className="mono">devin/…</span> branch to your repo's <span className="mono">origin</span> remote — so this only delivers code for repos that have a remote Devin can reach (e.g. GitHub). For local-only repos you still get its report, not files.</p>
              </div>
            )}
            <label className="block"><span className="field-label">ID <span className="text-fg-4 font-normal">— optional, a name you pick</span></span>
              <input className="input w-full" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
            </label>
            {form.kind === 'openai-compatible' && (
              <label className="block"><span className="field-label">Base URL</span><input className="input w-full font-mono" placeholder="http://localhost:11434/v1" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
            )}
            {CATALOG_KINDS.includes(form.kind) && (
              <label className="block"><span className="field-label">Model <span className="text-fg-4 font-normal">— listed live by the provider; the first one is used if you leave it empty</span></span>
                <ModelPicker catalog={formCatalog} value={form.model} onChange={(v) => setForm({ ...form, model: v })}
                  hint={form.kind === 'cli' ? (installed.length ? 'Models are read from the detected CLI.' : 'Enter a command below to load models from that CLI.')
                    : form.kind === 'openai-compatible' ? 'Enter the base URL to load the models the server offers.'
                      : 'Enter the API key below to load the models it can use.'} />
              </label>
            )}
            {(form.kind === 'openai-compatible' || NEEDS_KEY.includes(form.kind)) && (
              <label className="block"><span className="field-label">API key {form.kind === 'openai-compatible' && <span className="text-fg-4 font-normal">— optional for local servers</span>}</span>
                <input className="input w-full font-mono" type="password" autoComplete="off" placeholder={form.kind === 'devin' ? 'cog_…' : ''} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
                <span className="text-xs text-fg-4 mt-1 block">Stored in .office/secrets.json on this machine, never in the repo.</span>
              </label>
            )}
            {form.kind === 'devin' && (
              <>
                <label className="block"><span className="field-label">Organization ID <span className="text-fg-4 font-normal">— from Settings → Devin API; optional if the key can list orgs</span></span>
                  <input className="input w-full font-mono text-xs" placeholder="org_…" value={form.orgId} onChange={(e) => setForm({ ...form, orgId: e.target.value })} />
                </label>
                <label className="block"><span className="field-label">Session timeout (seconds)</span><input className="input w-32 num" type="number" value={form.timeoutSec} onChange={(e) => setForm({ ...form, timeoutSec: +e.target.value })} /></label>
              </>
            )}
            {form.kind === 'cli' && (<>
              <label className="block"><span className="field-label">Command <span className="text-fg-4 font-normal">{installed.length ? `— filled from ${preset?.label ?? 'the detected CLI'}` : '— paste one if nothing was detected'}</span></span>
                <input className="input w-full font-mono text-xs" placeholder={preset?.command ?? 'claude -p …'} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              </label>
              <label className="block"><span className="field-label">Timeout (seconds)</span><input className="input w-32 num" type="number" value={form.timeoutSec} onChange={(e) => setForm({ ...form, timeoutSec: +e.target.value })} /></label>
              <p className="text-xs text-fg-3 leading-relaxed">Uses the CLI's own login, so no API key is needed. Without a <span className="mono">{'{prompt}'}</span> placeholder the prompt is piped through stdin (safest); <span className="mono">{'{promptFile}'}</span> passes it as a file path instead, for CLIs that don't read stdin (Devin CLI). <span className="mono">{'{worktree}'}</span> and <span className="mono">{'{model}'}</span> (the agent's selected model) are also available.</p>
            </>)}
            <label className="block"><span className="field-label">Monthly budget (USD)</span><input className="input w-32 num" type="number" min={0} value={form.monthlyBudgetUsd} onChange={(e) => setForm({ ...form, monthlyBudgetUsd: +e.target.value })} /></label>
            {formErr && <div className="text-sm text-bad">{formErr}</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}
