import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post, put, useQuery } from '../api';
import { PageHeader, ProgressBar, Skeleton, StatusChip, Tag, act, pct } from '../components';
import { ArrowRight, CheckCircle2, Circle, Plus, Save, Trash2, XCircle } from 'lucide-react';

// Definition of Done editor (spec 5.2): owner edits items; PM proposals show
// as suggested changes in the approval inbox. Each item lists its checks and
// current pass/fail on integration HEAD.

interface Item { id: string; text: string; kind: string; checks: string[]; optional?: boolean; status?: string; checkable?: boolean; checkNote?: string | null }

const KIND_PREFIX: Record<string, string> = { feature: 'F', quality: 'Q', review: 'R', docs: 'D' };

export default function DodEditor() {
  const { runId } = useParams();
  const { data: dod, reload, loading } = useQuery<any>(`/dod/${runId}`, [runId]);
  const { data: run } = useQuery<any>(`/runs/${runId}`, [runId]);
  const { data: approvals } = useQuery<any[]>('/approvals');
  const [items, setItems] = useState<Item[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<any | null>(null);

  // Don't clobber unsaved local edits when the server pushes a refresh.
  useEffect(() => { if (dod?.items && !dirty) setItems(dod.items); }, [dod?.items]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposals = (approvals ?? []).filter((a) => a.run_id === runId && a.action === 'dod.propose' && a.status === 'pending');
  const update = (i: number, patch: Partial<Item>) => { setItems((it) => it.map((x, j) => (j === i ? { ...x, ...patch } : x))); setDirty(true); };
  const invalid = items.filter((i) => !i.text.trim() || !i.checks.length);
  const required = items.filter((i) => !i.optional);
  const passed = required.filter((i) => i.status === 'pass').length;

  const nextId = (kind: string) => {
    const p = KIND_PREFIX[kind] ?? 'X';
    let n = 1;
    while (items.some((i) => i.id === `${p}${n}`)) n++;
    return `${p}${n}`;
  };

  if (loading) return <Skeleton rows={5} />;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Definition of Done"
        sub="The run is finished when every required item's checks pass on the integration branch — measured by the verification service, never by a model's opinion.">
        {dod && <Tag mono>v{dod.version}</Tag>}
        {run && <StatusChip value={run.status} />}
      </PageHeader>

      {run?.status === 'dod-review' && (
        <div className="pblock block-lime !py-4 !px-5 mb-5 flex items-center gap-4 flex-wrap animate-rise">
          <div className="flex-1 min-w-[240px]">
            <div className="text-sm font-medium text-fg">The PM drafted this checklist. Review it, then start the run.</div>
            <div className="text-xs text-fg-3 mt-0.5">Once the run starts, the PM can only propose changes — you approve them.</div>
          </div>
          <button className="btn btn-accent" disabled={busy || dirty || !!invalid.length} title={dirty ? 'Save your edits first' : undefined} onClick={async () => {
            setBusy(true); await act(post(`/runs/${runId}/approve-dod`), 'DoD approved — the run is starting'); setBusy(false); reload();
          }}>Approve & start run <ArrowRight size={14} /></button>
        </div>
      )}

      {proposals.length > 0 && (
        <div className="pblock block-cream !py-4 !px-5 mb-5">
          <div className="text-sm font-medium text-warn mb-1.5">PM proposals awaiting your decision</div>
          {proposals.map((a) => <div key={a.id} className="text-sm text-fg-2 py-0.5">{a.payload?.summary}</div>)}
          <Link to="/approvals" className="btn btn-sm mt-3">Decide in Approvals <ArrowRight size={12} /></Link>
        </div>
      )}

      {impact && <ImpactPanel impact={impact} onClose={() => setImpact(null)} />}

      {required.length > 0 && (
        <div className="flex items-center gap-3 mb-3 text-xs text-fg-3 num">
          <span><span className="text-fg font-medium">{passed}</span> of {required.length} required passing</span>
          <ProgressBar value={required.length ? passed / required.length : 0} tone="accent" className="w-40" />
          <span>{pct(required.length ? passed / required.length : 0)}</span>
        </div>
      )}

      <div className="panel divide-line">
        {items.map((item, i) => {
          const bad = !item.text.trim() || !item.checks.length;
          return (
            <div key={item.id} className={`group p-4 flex items-start gap-3 ${item.optional ? 'opacity-75' : ''}`}>
              <span className="mt-1" title={item.status ?? 'pending'}>
                {item.status === 'pass' ? <CheckCircle2 size={17} className="text-ok" /> : item.status === 'fail' ? <XCircle size={17} className="text-bad" /> : <Circle size={17} className="text-fg-4" />}
              </span>
              <div className="flex-1 min-w-0 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="mono text-fg-4 w-7 shrink-0">{item.id}</span>
                  <input aria-label="Item text" placeholder="Describe a measurable outcome…" className="flex-1 bg-transparent text-sm text-fg outline-none border-b border-transparent hover:border-line focus:border-accent/60 pb-0.5 transition-colors" value={item.text} onChange={(e) => update(i, { text: e.target.value })} />
                </div>
                <div className="flex items-center gap-2 flex-wrap pl-9">
                  <select aria-label="Kind" className="input input-sm !h-6 text-2xs" value={item.kind} onChange={(e) => update(i, { kind: e.target.value })}>
                    {['feature', 'quality', 'review', 'docs'].map((k) => <option key={k}>{k}</option>)}
                  </select>
                  {item.checks.map((c, ci) => (
                    <span key={ci} className="chip font-mono text-info bg-info/[0.08] border-info/20">{c}
                      <button className="opacity-60 hover:opacity-100" aria-label={`Remove check ${c}`} onClick={() => update(i, { checks: item.checks.filter((_, j) => j !== ci) })}>×</button>
                    </span>
                  ))}
                  <input className="input input-sm !h-6 text-2xs w-36 font-mono" placeholder="+ check, Enter" aria-label="Add check" onKeyDown={(e) => {
                    if (e.key === 'Enter') { const el = e.target as HTMLInputElement; const v = el.value.trim(); if (v) update(i, { checks: [...item.checks, v] }); el.value = ''; }
                  }} />
                  <label className="flex items-center gap-1.5 text-2xs text-fg-3 cursor-pointer">
                    <input type="checkbox" checked={!!item.optional} onChange={(e) => update(i, { optional: e.target.checked })} /> optional
                  </label>
                  {bad && <span className="text-2xs text-bad">{!item.text.trim() ? 'needs text' : 'needs at least one check'}</span>}
                  {item.checkable === false && <span className="text-2xs text-warn" title={item.checkNote ?? 'no runnable check covers this item'}>not machine-checkable — judged at review</span>}
                </div>
              </div>
              <button className="btn btn-ghost btn-icon btn-sm opacity-0 group-hover:opacity-100 focus:opacity-100 hover:!text-bad" aria-label="Delete item" onClick={() => { setItems(items.filter((_, j) => j !== i)); setDirty(true); }}><Trash2 size={13} /></button>
            </div>
          );
        })}
        {!items.length && <div className="p-8 text-center text-sm text-fg-4">No items yet. The PM's draft appears here — or add your own.</div>}
      </div>

      <div className="flex items-center gap-2 mt-3 sticky bottom-0 py-3 bg-canvas/90 backdrop-blur">
        <button className="btn" onClick={() => { setItems([...items, { id: nextId('quality'), text: '', kind: 'quality', checks: [], status: 'pending' }]); setDirty(true); }}>
          <Plus size={13} /> Add item
        </button>
        <div className="flex-1" />
        {dirty && <>
          <button className="btn btn-ghost" onClick={() => { setItems(dod?.items ?? []); setDirty(false); }}>Discard</button>
          <button className="btn btn-primary" disabled={!!invalid.length || busy} title={invalid.length ? 'Every item needs text and at least one check' : undefined} onClick={async () => {
            setBusy(true);
            const r = await act(put(`/runs/${runId}/dod`, { items }), 'Requirements saved');
            setBusy(false);
            if (r) { setDirty(false); setImpact(r.impact ?? null); reload(); }
          }}><Save size={13} /> Save changes</button>
        </>}
      </div>
    </div>
  );
}

const ACTION_TEXT: Record<string, string> = {
  kept: 'kept — already verified; re-checked against the new requirements',
  updated: 'updated — the change goes into its next prompt',
  cancelled: 'cancelled — it only served removed requirements',
};

// What a requirement edit touched (spec 7): completed work is kept, in-flight
// work is updated at its next prompt, and the PM re-plans only uncovered items.
function ImpactPanel({ impact, onClose }: { impact: any; onClose: () => void }) {
  const none = !impact.added.length && !impact.removed.length && !impact.changed.length;
  return (
    <div className="panel p-4 mb-5 animate-rise">
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-[13px] font-medium text-fg flex-1">Impact of this change</h2>
        <button className="btn btn-ghost btn-xs" onClick={onClose}>Dismiss</button>
      </div>
      {none ? <p className="text-sm text-fg-3">No requirement changed meaning — nothing else was touched.</p> : (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-1.5">
            {impact.added.map((id: string) => <Tag key={id} tone="info" mono>+ {id}</Tag>)}
            {impact.changed.map((id: string) => <Tag key={id} tone="warn" mono>~ {id}</Tag>)}
            {impact.removed.map((id: string) => <Tag key={id} tone="bad" mono>− {id}</Tag>)}
          </div>
          {impact.tasks.map((t: any) => (
            <div key={t.id} className="flex gap-2 text-fg-2"><Link to={`/tasks/${t.id}`} className="font-medium hover:underline">{t.title}</Link><span className="text-fg-3">{ACTION_TEXT[t.action]}</span></div>
          ))}
          {!impact.tasks.length && <div className="text-fg-3">No existing task was affected.</div>}
          {impact.uncovered.length > 0 && (
            <div className="text-fg-3">{impact.uncovered.join(', ')} {impact.uncovered.length === 1 ? 'has' : 'have'} no task yet — {impact.replanning ? 'the PM is planning it now.' : 'the PM plans it when the run is running.'}</div>
          )}
        </div>
      )}
    </div>
  );
}