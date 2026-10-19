import React, { useEffect, useRef, useState } from 'react';
import { Select } from './Select';
import { del, post, useQuery } from './api';
import { Tag, act } from './components';
import { fmtSize } from './attachments';
import {
  AlertTriangle, ArrowRight, Check, CheckCheck, Code2, Cpu, FileText, HelpCircle, Loader2, Lock, Paperclip, Pencil, Plus, RotateCcw, Sparkles, Undo2, Wrench, X,
} from 'lucide-react';

const Spinner = () => <Loader2 size={12} className="animate-spin" />;

// The Request step of a workflow: an agent turns what the owner wrote into a summary they review before any run exists.

export type ItemKind = 'feature' | 'technology' | 'issue' | 'reference' | 'constraint';
export interface IntakeItem { id: string; kind: ItemKind; text: string; detail?: string; state: 'proposed' | 'accepted' | 'removed'; source: 'agent' | 'owner'; round: number }
export interface IntakeDraft {
  id: string; agentId: string; agentName: string; request: string; summary: string; items: IntakeItem[];
  concerns: { id: string; type: string; text: string }[]; notes: { round: number; text: string }[]; ready: boolean; attachmentIds: string[];
  status: 'analyzing' | 'review' | 'failed' | 'approved' | 'discarded'; round: number; error: string; costUsd: number; runId: string | null;
  sessions?: { id: string; label: string; status: string; uses: number }[];
}
export interface IntakeAgent { id: string; name: string; provider: string; roles: string[]; available: boolean; reason?: string }

const KINDS: { kind: ItemKind; title: string; one: string; icon: React.ReactNode; hint: string }[] = [
  { kind: 'feature', title: 'Features', one: 'Feature', icon: <Sparkles size={13} />, hint: 'what to build or change' },
  { kind: 'technology', title: 'Technologies', one: 'Technology', icon: <Cpu size={13} />, hint: 'libraries, frameworks, tools' },
  { kind: 'issue', title: 'Issues to fix', one: 'Issue', icon: <Wrench size={13} />, hint: 'bugs and problems' },
  { kind: 'reference', title: 'References', one: 'Reference', icon: <FileText size={13} />, hint: 'files, links, examples to follow' },
  { kind: 'constraint', title: 'Constraints', one: 'Constraint', icon: <Lock size={13} />, hint: 'rules and things to avoid' },
];

/** The two steps of New run, shown in both so the owner always knows where they are. */
export function Steps({ at }: { at: 1 | 2 }) {
  const step = (n: number, label: string) => (
    <span className={`flex items-center gap-1.5 text-xs ${at === n ? 'text-fg font-medium' : at > n ? 'text-fg-3' : 'text-fg-4'}`}>
      <span style={at === n ? { background: 'rgb(var(--fg))', color: 'rgb(var(--canvas))', borderColor: 'rgb(var(--fg))' } : undefined} className={`w-5 h-5 rounded-full grid place-items-center text-2xs border ${at === n ? '' : at > n ? 'bg-ok/15 text-ok border-ok/30' : 'border-line'}`}>{at > n ? <Check size={11} /> : n}</span>{label}
    </span>
  );
  return <div className="flex items-center gap-2">{step(1, 'Describe')}<span className="w-4 h-px bg-line" />{step(2, 'Review')}<span className="w-4 h-px bg-line" />{step(3, 'Run')}</div>;
}

export function useIntakeAgents(workspaceId: string | undefined) {
  return useQuery<IntakeAgent[]>(workspaceId ? `/intake/agents?workspaceId=${workspaceId}` : null, [workspaceId]);
}

export function IntakeReview({ draftId, files, onDiscard, onApprove, busy, aside, approveLabel }: {
  draftId: string; files: { id: string; name: string; size: number }[];
  onDiscard: () => void; onApprove: () => void; busy: boolean; aside: React.ReactNode; approveLabel: string;
}) {
  const { data: d, reload } = useQuery<IntakeDraft>(`/intake/drafts/${draftId}`, [draftId]);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [adding, setAdding] = useState<{ kind: ItemKind; text: string }>({ kind: 'feature', text: '' });
  const [working, setWorking] = useState(false);
  const [editReq, setEditReq] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const analysing = d?.status === 'analyzing';

  // while the agent works, the page also asks for itself (events can be missed on a reconnect)
  useEffect(() => { if (!analysing) return; const t = setInterval(reload, 2000); return () => clearInterval(t); }, [analysing, reload]);

  const send = async (body: Record<string, unknown>, ok?: string) => {
    setWorking(true);
    const r = await act(post(`/intake/drafts/${draftId}/refine`, body), ok);
    setWorking(false);
    if (r) reload();
    return !!r;
  };
  const items = d?.items ?? [];
  const open = items.filter((i) => i.state === 'proposed');
  const kept = items.filter((i) => i.state === 'accepted');
  const removed = items.filter((i) => i.state === 'removed');
  const locked = !d || analysing || working;
  const approveOk = !!d && !analysing && !working && (d.status === 'review' || d.status === 'failed');

  const rowFor = (i: IntakeItem) => {
    const isNew = i.state === 'proposed' && d!.round > 1 && i.round === d!.round && i.source === 'agent';
    return (
      <li key={i.id} className={`group flex items-start gap-2.5 px-3 py-2 ${i.state === 'accepted' ? 'bg-ok/[0.05]' : ''}`}>
        <button type="button" disabled={locked} aria-label={i.state === 'accepted' ? 'Stop keeping this item' : 'Keep this item as it is'} aria-pressed={i.state === 'accepted'}
          title={i.state === 'accepted' ? 'Kept — it will not change. Click to leave it open again' : 'Keep as it is: later passes will not change it'}
          className={`mt-0.5 w-[18px] h-[18px] shrink-0 rounded-full border grid place-items-center transition-colors ${i.state === 'accepted' ? 'bg-ok border-ok text-white' : 'border-line-strong text-transparent hover:text-fg-4 hover:border-fg-3'}`}
          onClick={() => void send({ edits: [{ id: i.id, state: i.state === 'accepted' ? 'proposed' : 'accepted' }] })}><Check size={11} /></button>
        <div className="min-w-0 flex-1">
          {editing === i.id ? (
            <input className="input input-sm w-full" autoFocus value={editText} maxLength={400} onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditing(null);
                if (e.key === 'Enter') { e.preventDefault(); const t = editText.trim(); setEditing(null); if (t && t !== i.text) void send({ edits: [{ id: i.id, text: t }] }); }
              }}
              onBlur={() => setEditing(null)} />
          ) : (
            <button type="button" disabled={locked} className="text-left text-sm text-fg-2 hover:text-fg w-full disabled:cursor-default" title="Click to edit — what you write is kept as you wrote it"
              onClick={() => { setEditing(i.id); setEditText(i.text); }}>
              {i.text}
              {i.source === 'owner' && <span className="ml-1.5 text-2xs text-fg-4 align-middle">· yours</span>}
              {isNew && <span className="ml-1.5 chip !h-4 !bg-info/10 !text-info !border-info/30 align-middle">updated</span>}
            </button>
          )}
          {i.detail && editing !== i.id && <div className="text-xs text-fg-4 mt-0.5">{i.detail}</div>}
        </div>
        <button type="button" disabled={locked} className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-fg-4 hover:text-bad shrink-0 mt-0.5 transition-opacity" aria-label={`Remove ${i.text}`} title="Remove — the agent will not suggest it again"
          onClick={() => void send({ edits: [{ id: i.id, state: 'removed' }] })}><X size={14} /></button>
      </li>
    );
  };

  const ask = (c: string) => { setNote((n) => `${n}${n && !n.endsWith('\n') ? '\n' : ''}Re: ${c} — `); noteRef.current?.focus(); };

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] [&>*]:min-w-0">
        <div className="p-5 space-y-5">
          {/* what the agent understood */}
          <section className="rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line">
              <Sparkles size={14} className="text-fg-3" />
              <span className="text-sm font-medium">What {d?.agentName ?? 'the agent'} understood</span>
              {d && <span className="text-2xs text-fg-4">pass {d.round}</span>}
              <span className="ml-auto flex items-center gap-2">
                {analysing && <span className="flex items-center gap-1.5 text-xs text-info"><Spinner /> analysing…</span>}
                {d?.status === 'review' && (d.ready ? <Tag tone="ok">looks complete</Tag> : <Tag tone="warn">needs your input</Tag>)}
              </span>
            </div>
            <div className="px-4 py-3 text-sm">
              {!d && <div className="text-fg-4">Loading…</div>}
              {d && !d.summary && analysing && <div className="text-fg-4">Reading your request{d.attachmentIds.length ? ' and the attached files' : ''}, checking it against the project…</div>}
              {d?.summary && <p className="text-fg-2 leading-6">{d.summary}</p>}
              {d?.status === 'failed' && (
                <div className="mt-2 rounded-lg border border-bad/30 bg-bad/[0.06] p-3 text-bad text-sm">
                  <div className="flex items-center gap-2 font-medium"><AlertTriangle size={14} /> The analysis did not finish</div>
                  <div className="text-xs mt-1">{d.error}</div>
                  <div className="text-xs text-fg-3 mt-1.5">Nothing is lost. Try again, or approve your request exactly as you typed it.</div>
                  <button type="button" className="btn btn-sm mt-2" disabled={working} onClick={() => void send({ reanalyze: true })}><RotateCcw size={12} /> Try again</button>
                </div>
              )}
            </div>
          </section>

          {/* things to check */}
          {d && d.concerns.length > 0 && !analysing && (
            <section className="rounded-xl border border-warn/30 bg-warn/[0.05]">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-warn/20 text-sm font-medium"><HelpCircle size={14} className="text-warn" /> Worth checking before work starts <span className="text-2xs font-normal text-fg-4">{d.concerns.length}</span></div>
              <ul className="divide-line">
                {d.concerns.map((c) => (
                  <li key={c.id} className="flex items-start gap-2.5 px-4 py-2 text-sm">
                    <span className="chip !h-4 shrink-0 mt-0.5">{c.type}</span>
                    <span className="flex-1 text-fg-2">{c.text}</span>
                    <button type="button" className="btn btn-ghost btn-xs shrink-0" onClick={() => ask(c.text)}>Answer</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* the items */}
          <section className={analysing ? 'opacity-60 pointer-events-none' : ''} aria-busy={analysing}>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h3 className="text-sm font-semibold">Summary</h3>
              <span className="text-xs text-fg-4">{kept.length} kept · {open.length} open · {removed.length} removed</span>
              {open.length > 0 && <button type="button" className="btn btn-ghost btn-xs ml-auto" disabled={locked} onClick={() => void send({ edits: open.map((i) => ({ id: i.id, state: 'accepted' })) }, 'All open items kept')}><CheckCheck size={12} /> Keep all open items</button>}
            </div>
            <p className="text-xs text-fg-4 mb-3">Tick what is right — kept items never change. Remove what you do not want, edit any wording, or add more below. Open items are the only ones the agent will touch when you ask it to update.</p>
            {items.length === 0 && d && !analysing && <div className="text-sm text-fg-4 rounded-lg border border-dashed border-line px-4 py-6 text-center">Nothing was found yet. Add what you want below, or ask the agent to look again.</div>}
            <div className="space-y-3">
              {KINDS.map((k) => {
                const list = items.filter((i) => i.kind === k.kind && i.state !== 'removed');
                if (!list.length) return null;
                return (
                  <div key={k.kind} className="rounded-xl border border-line overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-raised/60 border-b border-line text-xs font-medium text-fg-3">{k.icon}{k.title}<span className="text-fg-4 font-normal">{list.length} · {k.hint}</span></div>
                    <ul className="divide-line">{list.map(rowFor)}</ul>
                  </div>
                );
              })}
            </div>
            {removed.length > 0 && (
              <details className="mt-3 rounded-xl border border-line">
                <summary className="px-3 py-2 text-xs text-fg-3 cursor-pointer select-none">Removed ({removed.length}) — the agent will not bring these back</summary>
                <ul className="divide-line">
                  {removed.map((i) => (
                    <li key={i.id} className="flex items-center gap-2.5 px-3 py-1.5 text-sm">
                      <span className="text-fg-4 line-through flex-1 min-w-0 truncate" title={i.text}>{i.text}</span>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={locked} onClick={() => void send({ edits: [{ id: i.id, state: 'proposed' }] })}><Undo2 size={12} /> Restore</button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <form className="mt-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); const t = adding.text.trim(); if (!t) return; void send({ add: [{ kind: adding.kind, text: t }] }).then((ok) => ok && setAdding({ ...adding, text: '' })); }}>
              <Select className="input input-sm !w-36 shrink-0" value={adding.kind} onChange={(e) => setAdding({ ...adding, kind: e.target.value as ItemKind })} aria-label="Kind of item">
                {KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.one}</option>)}
              </Select>
              <input className="input input-sm flex-1 min-w-0" placeholder="Add something the agent missed…" maxLength={400} value={adding.text} onChange={(e) => setAdding({ ...adding, text: e.target.value })} disabled={locked} />
              <button className="btn btn-sm" disabled={locked || !adding.text.trim()}><Plus size={13} /> Add</button>
            </form>
          </section>

          {/* refine */}
          <section className="rounded-xl border border-line p-4 bg-surface">
            <label className="block">
              <span className="field-label">Add details or ask for changes</span>
              <textarea ref={noteRef} className="input w-full min-h-[4.5rem] resize-y text-sm" rows={3} maxLength={4000} disabled={locked} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. It should also work on mobile. Use the existing Button component. Skip the settings page."
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && note.trim()) { e.preventDefault(); void send({ note: note.trim(), reanalyze: true }).then((ok) => ok && setNote('')); } }} />
            </label>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <button type="button" className="btn btn-sm" disabled={locked || !note.trim()} onClick={() => void send({ note: note.trim(), reanalyze: true }).then((ok) => ok && setNote(''))}>
                <RotateCcw size={12} /> Update the summary
              </button>
              <span className="text-2xs text-fg-4">Kept items stay exactly as they are; {d?.agentName ?? 'the agent'} only adjusts the open ones and adds what is new. <kbd className="mono">Ctrl</kbd>+<kbd className="mono">Enter</kbd></span>
            </div>
          </section>
        </div>

        <aside className="p-5 space-y-4 bg-raised/40 border-t lg:border-t-0 lg:border-l border-line">
          <div>
            <div className="flex items-center gap-2 mb-1.5"><span className="field-label !mb-0">Your request</span>
              {d && editReq === null && !locked && <button type="button" className="text-fg-4 hover:text-fg ml-auto" aria-label="Edit the request" onClick={() => setEditReq(d.request)}><Pencil size={12} /></button>}
            </div>
            {editReq !== null ? (
              <div className="space-y-1.5">
                <textarea className="input w-full text-sm min-h-[7rem]" value={editReq} maxLength={20000} onChange={(e) => setEditReq(e.target.value)} autoFocus />
                <div className="flex gap-1.5"><button type="button" className="btn btn-xs btn-primary" disabled={!editReq.trim()} onClick={async () => { if (await send({ request: editReq.trim() }, 'Request updated — press Update the summary to apply it')) setEditReq(null); }}>Save</button><button type="button" className="btn btn-xs btn-ghost" onClick={() => setEditReq(null)}>Cancel</button></div>
              </div>
            ) : (
              <p className="text-sm text-fg-2 whitespace-pre-wrap max-h-48 overflow-auto leading-5">{d?.request}</p>
            )}
            {d && d.notes.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-fg-3">{d.notes.map((n, i) => <li key={i} className="border-l-2 border-line pl-2 whitespace-pre-wrap">{n.text}</li>)}</ul>
            )}
          </div>
          {files.length > 0 && (
            <div>
              <span className="field-label">Files the agent can read</span>
              <ul className="space-y-1">{files.map((f) => <li key={f.id} className="flex items-center gap-1.5 text-xs text-fg-3 min-w-0"><Paperclip size={11} className="shrink-0" /><span className="truncate flex-1">{f.name}</span><span className="text-fg-4">{fmtSize(f.size)}</span></li>)}</ul>
            </div>
          )}
          <div>
            <span className="field-label">Analysed by</span>
            <div className="text-sm text-fg-2 flex items-center gap-1.5"><Code2 size={13} className="text-fg-3" />{d?.agentName}</div>
            <div className="text-2xs text-fg-4 mt-1 leading-4">
              {d?.sessions?.length ? `Its own CLI session for this request (${d.sessions[0].uses} earlier pass${d.sessions[0].uses === 1 ? '' : 'es'}) — separate from its other work.` : 'It works in a session of its own, separate from its other work.'}
              {d && d.costUsd > 0 ? ` $${d.costUsd.toFixed(3)} so far.` : ''}
            </div>
          </div>
          <div className="border-t border-line pt-4 space-y-4">{aside}</div>
        </aside>
      </div>

      <div className="flex items-center gap-2 px-5 py-3 border-t border-line bg-raised/40 flex-wrap">
        <span className="text-xs text-fg-4 mr-auto">
          {analysing ? 'Waiting for the agent…' : d?.status === 'failed' ? 'You can still start the run with your request as typed.' : `${kept.length + open.length} item${kept.length + open.length === 1 ? '' : 's'} will be sent to the PM${removed.length ? `, ${removed.length} ruled out` : ''}.`}
        </span>
        <button type="button" className="btn btn-ghost" disabled={working || busy} onClick={() => {
          if (kept.length + removed.length + (d?.notes.length ?? 0) > 0 && !confirm('Discard this review? Your decisions on the items will be lost.')) return;
          void del(`/intake/drafts/${draftId}`).catch(() => undefined).then(onDiscard);
        }}>Discard</button>
        <button type="button" className="btn btn-primary" disabled={!approveOk || busy} onClick={onApprove}>{busy ? 'Starting…' : <>{approveLabel} <ArrowRight size={14} /></>}</button>
      </div>
    </>
  );
}
