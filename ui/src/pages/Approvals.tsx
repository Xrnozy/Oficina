import { useOfficeApprovals } from '../office';
import React, { useState } from 'react';
import { post, useQuery } from '../api';
import { Avatar, Drawer, Empty, PageHeader, Skeleton, StatusChip, Tag, act, fmtAgo, toast } from '../components';
import { Check, Inbox, ShieldQuestion, UserCheck, X } from 'lucide-react';
import { HumanReview } from '../humanReview';

// Approval inbox (spec §9, 6.5): batch approve/reject, decisions recorded
// with a reason (required to reject, fed back to the agent); every request
// carries its blast radius in the payload. Pending items group by run, with
// a one-line what/why/risk summary and a low-risk approve-all per group.
const BATCH_ACTIONS = new Set(['commit.task', 'file.write.protected', 'deps.add']);

export default function Approvals() {
  const { data: approvals, reload, loading } = useOfficeApprovals();
  const { data: runs } = useQuery<any[]>('/runs');
  const { data: agents } = useQuery<any[]>('/agents');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<any | null>(null);
  const [reason, setReason] = useState('');
  const [always, setAlways] = useState(false);
  const [reasonErr, setReasonErr] = useState(false);
  const [batchReject, setBatchReject] = useState(false);

  const pending = (approvals ?? []).filter((a) => a.status === 'pending');
  const decided = (approvals ?? []).filter((a) => a.status !== 'pending');
  const runOf = (id: string) => runs?.find((r) => r.id === id);
  const agentOf = (id: string) => agents?.find((a) => a.id === id);

  // grouped by run (spec 5.2): one block per run, approve-all for low-risk
  const groups: { runId: string | null; items: any[] }[] = [];
  for (const a of pending) {
    const g = groups.find((g) => g.runId === (a.run_id ?? null));
    if (g) g.items.push(a); else groups.push({ runId: a.run_id ?? null, items: [a] });
  }
  // mirrors the daemon's approve-all rule: a risk-gated action not flagged risky
  const lowRisk = (a: any) => BATCH_ACTIONS.has(a.action) && a.payload?.risk?.risky !== true;

  const close = () => { setDetail(null); setReason(''); setAlways(false); setReasonErr(false); setBatchReject(false); };

  const decide = async (ids: string[], approve: boolean, alwaysFor?: string) => {
    if (!approve && !reason.trim()) { setReasonErr(true); return; }
    let ok = 0;
    for (const id of ids) {
      const r = await act(post(`/approvals/${id}/decide`, { approve, reason: reason.trim() || 'approved', alwaysAllowForAgent: alwaysFor }));
      if (r) ok++;
    }
    if (ok) toast(`${approve ? 'Approved' : 'Rejected'} ${ok} request${ok > 1 ? 's' : ''}`);
    setSel(new Set()); close(); reload();
  };

  const approveAllLow = async (runId: string | null) => {
    const r = await act(post('/approvals/approve-all', { runId }));
    if (r) toast(`Approved ${r.approved} low-risk item${r.approved === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} still need you` : ''}`);
    reload();
  };

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allSel = pending.length > 0 && pending.every((a) => sel.has(a.id));

  return (
    <div className="max-w-5xl">
      <PageHeader title="Approvals" sub="Actions your policy says need a human. Rejections need a reason — it's sent back to the agent.">
        {sel.size > 0 && (<>
          <span className="text-xs text-fg-3 num">{sel.size} selected</span>
          <button className="btn btn-danger" onClick={() => setBatchReject(true)}><X size={13} /> Reject</button>
          <button className="btn btn-accent" onClick={() => decide([...sel], true)}><Check size={13} /> Approve</button>
        </>)}
      </PageHeader>

      {loading && <Skeleton rows={3} />}
      {!loading && !pending.length && <Empty icon={Inbox} title="Inbox zero" text="Nothing needs your decision right now. You'll see DoD sign-offs, protected-file changes and policy-gated actions here." />}

      {pending.length > 0 && (
        <div className="space-y-5">
          <div className="flex items-center gap-3 text-xs text-fg-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" aria-label="Select all" checked={allSel} onChange={() => setSel(allSel ? new Set() : new Set(pending.map((a) => a.id)))} />
              <span className="num">{pending.length} pending</span>
            </label>
            <button className="btn btn-sm ml-auto" onClick={() => approveAllLow(null)}><Check size={13} /> Approve all low-risk</button>
          </div>
          {groups.map((g) => {
            const r = g.runId ? runOf(g.runId) : null;
            const low = g.items.filter(lowRisk).length;
            return (
              <div key={g.runId ?? 'none'} className="panel overflow-hidden">
                <div className="flex items-center gap-3 px-4 h-10 border-b border-line bg-cream text-xs text-fg-2">
                  <span className="font-medium text-fg truncate">{r ? r.goal : 'No run'}</span>
                  <span className="num text-fg-3 shrink-0">{g.items.length} item{g.items.length > 1 ? 's' : ''}</span>
                  {low > 0 && <button className="btn btn-sm ml-auto shrink-0" onClick={() => approveAllLow(g.runId)}><Check size={12} /> Approve {low} low-risk</button>}
                </div>
                <div className="divide-line">
                  {g.items.map((a) => {
                    const ag = agentOf(a.requested_by);
                    const risk = a.payload?.risk;
                    return (
                      <div key={a.id} className={`flex items-center gap-3 px-4 py-3 transition-colors ${sel.has(a.id) ? 'bg-accent/[0.04]' : 'hover:bg-raised/60'}`}>
                        {a.action === 'human.approval'
                          ? <span className="w-[13px] shrink-0" title="Open it to review the app before deciding"><UserCheck size={13} className="text-fg-3" /></span>
                          : <input type="checkbox" aria-label={`Select ${a.action}`} checked={sel.has(a.id)} onChange={() => toggle(a.id)} />}
                        <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => setDetail(a)}>
                          <Avatar agent={ag ?? { name: a.requested_by }} size="sm" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-fg truncate">{a.payload?.summary ?? a.action}</div>
                            <div className="text-xs text-fg-3 truncate">
                              {ag?.name ?? a.requested_by} · {fmtAgo(a.created_at)}
                              {a.payload?.why ? ` · ${a.payload.why}` : ''}
                            </div>
                          </div>
                          {risk && (
                            <Tag tone={risk.risky ? 'bad' : 'idle'} title={risk.risky ? `Risky: ${(risk.reasons ?? []).join('; ')}` : 'Low risk'}>
                              {risk.risky ? 'risky' : 'low risk'}
                            </Tag>
                          )}
                          <Tag tone="warn" mono>{a.action}</Tag>
                          <BlastRadius p={a.payload} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {decided.length > 0 && (
        <section className="mt-8">
          <h2 className="text-[13px] font-medium text-fg-3 mb-2">Recently decided</h2>
          <div className="panel divide-line overflow-hidden">
            {decided.slice(0, 15).map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <StatusChip value={a.status} />
                <span className="text-fg-2 flex-1 truncate">{a.payload?.summary ?? a.action}</span>
                <span className="text-xs text-fg-4 truncate max-w-[30%] hidden sm:block" title={a.reason}>{a.reason}</span>
                <span className="text-2xs text-fg-4 num w-14 text-right">{fmtAgo(a.decided_at)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {(detail || batchReject) && (() => {
        const ids = detail ? [detail.id] : [...sel];
        const ag = detail ? agentOf(detail.requested_by) : null;
        return (
          <Drawer onClose={close}
            title={detail ? <><ShieldQuestion size={16} className="text-warn" /><span className="mono text-fg text-sm truncate">{detail.action === 'human.approval' ? 'Human approval' : detail.action}</span><BlastRadius p={detail.payload} /></> : <span className="text-sm font-medium text-fg">Reject {ids.length} requests</span>}
            footer={
              <div className="space-y-3">
                <div>
                  <label className="field-label" htmlFor="reason">{detail?.action === 'human.approval' ? 'Your feedback' : 'Reason'} {detail && <span className="text-fg-4 font-normal">— {detail.action === 'human.approval' ? 'required to reject: say what needs to be fixed' : 'required to reject'}</span>}</label>
                  <textarea id="reason" className={`input w-full h-20 ${reasonErr ? '!border-bad' : ''}`} placeholder={detail?.action === 'human.approval' ? 'What did you see? What should be different?' : 'What should the agent do differently?'} value={reason}
                    onChange={(e) => { setReason(e.target.value); setReasonErr(false); }} />
                  {reasonErr && <div className="text-xs text-bad mt-1">{detail?.action === 'human.approval' ? 'Describe what needs to be fixed — the agents work from your feedback.' : 'Add a reason so the agent knows what to change.'}</div>}
                </div>
                {detail && ag && detail.action !== 'human.approval' && (
                  <label className="flex items-start gap-2 text-xs text-fg-3 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={always} onChange={(e) => setAlways(e.target.checked)} />
                    <span>Always allow <span className="mono text-fg-2">{detail.action}</span> for {ag.name}. Creates a policy rule; future requests skip the inbox.</span>
                  </label>
                )}
                <div className="flex justify-end gap-2">
                  <button className="btn btn-danger" onClick={() => decide(ids, false)}><X size={13} /> {detail?.action === 'human.approval' ? 'Reject with feedback' : 'Reject'}</button>
                  {detail && <button className="btn btn-accent" onClick={() => {
                    if (always && !confirm(`Create a policy rule so ${ag?.name} can always ${detail.action} without asking?`)) return;
                    decide(ids, true, always ? detail.requested_by : undefined);
                  }}><Check size={13} /> Approve</button>}
                </div>
              </div>
            }>
            {detail && detail.action === 'human.approval' && <HumanReview approval={detail} onChanged={reload} />}
            {detail && detail.action !== 'human.approval' && (
              <div className="space-y-5">
                <div>
                  <div className="text-[15px] text-fg leading-snug">{detail.payload?.summary}</div>
                  <div className="text-xs text-fg-3 mt-1.5 flex items-center gap-1.5">
                    <Avatar agent={ag ?? { name: detail.requested_by }} size="sm" /> {ag?.name ?? detail.requested_by} · {fmtAgo(detail.created_at)}
                  </div>
                </div>
                {detail.payload?.items && (
                  <div>
                    <div className="eyebrow mb-2">Proposed DoD items</div>
                    <ul className="space-y-2">
                      {detail.payload.items.map((i: any) => (
                        <li key={i.id} className="rounded-lg border border-line bg-sunken/50 p-2.5">
                          <div className="flex gap-2 text-sm text-fg-2"><span className="mono text-fg-4 shrink-0">{i.id}</span>{i.text}</div>
                          <div className="flex flex-wrap gap-1 mt-1.5 pl-7">{(i.checks ?? []).map((c: string) => <span key={c} className="chip font-mono text-info bg-info/[0.08] border-info/20">{c}</span>)}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {detail.payload?.diff && (<div><div className="eyebrow mb-2">Diff</div><Diff text={detail.payload.diff} /></div>)}
                {detail.payload?.files && (
                  <div><div className="eyebrow mb-2">Touched files</div><div className="flex flex-wrap gap-1.5">{detail.payload.files.map((f: any) => { const p = typeof f === 'string' ? f : `${f.status ?? ''} ${f.path}`.trim(); return <Tag key={p} mono>{p}</Tag>; })}</div></div>
                )}
                {detail.payload?.problems && (
                  <div><div className="eyebrow mb-2">Problems</div><ul className="space-y-1">{detail.payload.problems.map((p: string) => <li key={p} className="text-sm text-warn">· {p}</li>)}</ul></div>
                )}
                {detail.action === 'commit.task' && detail.payload?.message && (
                  <div>
                    <div className="eyebrow mb-2">Proposed commit message</div>
                    <pre className="mono text-xs text-fg-2 whitespace-pre-wrap bg-sunken border border-line rounded-lg p-3">{detail.payload.message}</pre>
                    {detail.payload.why && <p className="text-xs text-fg-3 mt-1.5">Why this needs you: {detail.payload.why}</p>}
                    {detail.payload.mixed?.length > 0 && <p className="text-xs text-warn mt-1">Includes files you had changed before the task: {detail.payload.mixed.join(', ')}</p>}
                    {detail.task_id && <a className="text-xs underline mt-1 inline-block" href={`/tasks/${detail.task_id}`}>Edit the message on the task page</a>}
                  </div>
                )}
                {detail.payload?.notes && (<div><div className="eyebrow mb-2">Last PM notes</div><p className="text-sm text-fg-2 whitespace-pre-wrap">{detail.payload.notes}</p></div>)}
                {detail.payload?.prompt && (<div><div className="eyebrow mb-2">Prompt under review</div><pre className="mono text-fg-3 whitespace-pre-wrap bg-sunken border border-line rounded-lg p-3 max-h-80 overflow-auto leading-relaxed">{detail.payload.prompt}</pre></div>)}
                {detail.payload?.hint && <p className="text-xs text-fg-3">{detail.payload.hint}</p>}
                {detail.action === 'agent.question' && <p className="text-xs text-fg-3">Your answer goes back to the agent as a message. Approve with a note to answer “yes, and…”, or reject with your reason.</p>}
              </div>
            )}
            {!detail && <p className="text-sm text-fg-3">The same reason is sent to every requesting agent.</p>}
          </Drawer>
        );
      })()}
    </div>
  );
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="mono bg-sunken border border-line rounded-lg p-3 overflow-auto max-h-80 leading-relaxed">
      {text.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-ok bg-ok/[0.06] -mx-3 px-3' : l.startsWith('-') && !l.startsWith('---') ? 'text-bad bg-bad/[0.06] -mx-3 px-3' : l.startsWith('@@') ? 'text-info' : 'text-fg-3'}>{l || ' '}</div>
      ))}
    </pre>
  );
}

function BlastRadius({ p }: { p?: { files?: string[]; actions?: string[]; problems?: string[] } }) {
  if (!p) return null;
  const n = (p.files?.length ?? 0) + (p.actions?.length ?? 0) + (p.problems?.length ?? 0);
  if (!n) return null;
  return <Tag title="Blast radius: files, actions and problems this request touches">{n} item{n > 1 ? 's' : ''}</Tag>;
}
