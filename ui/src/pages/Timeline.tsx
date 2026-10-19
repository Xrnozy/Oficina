import React, { useEffect, useMemo, useState } from 'react';
import { get, useQuery, type OfficeEvent } from '../api';
import { Empty, PageHeader, StatusChip, Tag, fmtTime } from '../components';
import { Clock, History, X } from 'lucide-react';

// Run timeline & replay (spec §9): lanes per actor, filterable event list;
// clicking an event shows its payload; a replay slider reconstructs the
// task board as of that event (read-only — never re-executes).

const KIND_COLOR: Record<string, string> = {
  'task.': 'bg-info', 'workitem.': 'bg-fg-4', 'checkrun.': 'bg-info/60',
  'error.': 'bg-bad', 'plan.': 'bg-warn', 'merge.': 'bg-ok',
  'approval.': 'bg-warn', 'cycle.': 'bg-fg-3', 'run.': 'bg-accent',
  'agent.': 'bg-fg-4', 'review.': 'bg-ok/60',
};
const colorFor = (t: string) => KIND_COLOR[Object.keys(KIND_COLOR).find((k) => t.startsWith(k)) ?? ''] ?? 'bg-fg-4';
const KINDS = ['run', 'cycle', 'plan', 'task', 'workitem', 'checkrun', 'review', 'merge', 'error', 'approval', 'agent'];

export default function Timeline() {
  const { data: runs } = useQuery<any[]>('/runs');
  const [runId, setRunId] = useState<string>('');
  const run = runs?.find((r) => r.id === (runId || runs[0]?.id));
  const [events, setEvents] = useState<OfficeEvent[]>([]);
  const [kind, setKind] = useState('');
  const [text, setText] = useState('');
  const [actor, setActor] = useState('');
  const [sel, setSel] = useState<OfficeEvent | null>(null);
  const [cap, setCap] = useState(600);
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const [replayState, setReplayState] = useState<any>(null);

  useEffect(() => {
    if (run) get<OfficeEvent[]>(`/runs/${run.id}/events?limit=2000`).then(setEvents).catch(() => setEvents([]));
  }, [run?.id]);

  useEffect(() => {
    if (replaySeq != null && run) get(`/runs/${run.id}/state-at?seq=${replaySeq}`).then(setReplayState).catch(() => {});
    else setReplayState(null);
  }, [replaySeq, run?.id]);

  const filtered = events.filter((e) =>
    (!kind || e.type.startsWith(`${kind}.`)) &&
    (!text || `${e.type} ${summarizePayload(e)}`.toLowerCase().includes(text.toLowerCase())) &&
    (!actor || e.actor === actor));

  const actors = useMemo(() => [...new Set(events.map((e) => e.actor))], [events]);
  const minSeq = events[0]?.seq ?? 0;
  const maxSeq = events.length ? events[events.length - 1].seq : 0;
  const span = Math.max(1, maxSeq - minSeq);
  const at = replaySeq ?? maxSeq;

  return (
    <div>
      <PageHeader title="Timeline & replay" sub="Every event in the run's hash-chained log. Scrub to see the task board as it was at any point — replay never re-executes anything.">
        <select className="input max-w-[280px]" value={run?.id ?? ''} onChange={(e) => { setRunId(e.target.value); setSel(null); setReplaySeq(null); }} aria-label="Run">
          {(runs ?? []).map((r) => <option key={r.id} value={r.id}>{r.goal.length > 44 ? `${r.goal.slice(0, 44)}…` : r.goal}</option>)}
        </select>
      </PageHeader>

      {!events.length && <Empty icon={Clock} title="No events yet" text="Events appear here as soon as the run starts doing work." />}

      {events.length > 0 && (
        <section className="panel mb-5 overflow-hidden">
          <div className="px-4 pt-3.5 pb-2 flex items-center gap-3">
            <h2 className="text-[13px] font-medium text-fg">Lanes</h2>
            <span className="text-2xs text-fg-4">click a mark to inspect · {events.length} events</span>
          </div>
          <div className="px-4 pb-3 space-y-1.5">
            {actors.map((a) => (
              <div key={a} className="flex items-center gap-3">
                <button onClick={() => setActor(actor === a ? '' : a)} className={`w-28 shrink-0 text-left text-xs truncate ${actor === a ? 'text-accent' : 'text-fg-3 hover:text-fg'}`}>{a}</button>
                <div className="relative flex-1 h-5 rounded bg-sunken border border-line">
                  {events.filter((e) => e.actor === a).map((e) => (
                    <button key={e.seq} onClick={() => setSel(e)} title={`#${e.seq} ${e.type}`}
                      className={`absolute top-1 bottom-1 w-[3px] -ml-px rounded-sm ${colorFor(e.type)} ${sel?.seq === e.seq ? 'ring-2 ring-fg scale-y-125' : 'opacity-80 hover:opacity-100'} ${e.seq > at ? '!opacity-15' : ''}`}
                      style={{ left: `${((e.seq - minSeq) / span) * 100}%` }} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-3 px-4 py-3 border-t border-line bg-sunken/40">
            <History size={14} className="text-fg-3 shrink-0" />
            <input type="range" min={minSeq} max={maxSeq} value={at} aria-label="Replay position"
              onChange={(e) => setReplaySeq(+e.target.value === maxSeq ? null : +e.target.value)} className="flex-1 sm:ml-[98px]" />
            <span className="mono text-fg-3 w-20 text-right">{replaySeq == null ? <Tag tone="ok">live</Tag> : `seq ${replaySeq}`}</span>
            {replaySeq != null && <button className="btn btn-xs" onClick={() => setReplaySeq(null)}>Back to live</button>}
          </div>
          {replayState && (
            <div className="px-4 py-3 border-t border-line flex flex-wrap items-center gap-2 animate-rise">
              <span className="text-xs text-fg-3 mr-1">As of #{replaySeq}:</span>
              <StatusChip value={replayState.runStatus} />
              {replayState.tasks.map((t: any) => (
                <span key={t.id} className="chip" title={t.title}><span className="max-w-[22ch] truncate text-fg-2">{t.title || t.id}</span> → {t.status}</span>
              ))}
            </div>
          )}
        </section>
      )}

      {events.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <input className="input input-sm w-52" placeholder="Search events…" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {KINDS.map((k) => (
              <button key={k} onClick={() => setKind(kind === k ? '' : k)} className={`h-7 px-2 rounded-md text-xs border transition-colors flex items-center gap-1.5 ${kind === k ? 'bg-raised border-line-strong text-fg' : 'border-transparent text-fg-3 hover:text-fg'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${colorFor(`${k}.`)}`} />{k}
              </button>
            ))}
          </div>
          {(kind || text || actor) && <button className="btn btn-ghost btn-xs" onClick={() => { setKind(''); setText(''); setActor(''); }}><X size={11} /> Clear</button>}
          <span className="ml-auto text-xs text-fg-4 num">{filtered.length} shown</span>
        </div>
      )}

      {events.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 items-start">
          <div className="panel max-h-[62vh] overflow-auto divide-line">
            {/* cap rendered rows — a long run mounts the latest 600, earlier on demand */}
            {filtered.length > cap && (
              <button className="w-full text-center py-2 text-2xs text-fg-3 hover:text-fg hover:bg-raised/60" onClick={() => setCap((n) => n + 800)}>
                {filtered.length - cap} earlier events — show more
              </button>
            )}
            {filtered.slice(-cap).map((e) => (
              <button key={e.seq} onClick={() => setSel(e)} className={`w-full text-left px-3.5 h-9 flex items-center gap-3 transition-colors ${sel?.seq === e.seq ? 'bg-raised' : 'hover:bg-raised/60'} ${e.seq > at ? 'opacity-35' : ''}`}>
                <span className="mono text-2xs text-fg-4 w-10 shrink-0">#{e.seq}</span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${colorFor(e.type)}`} />
                <span className="text-xs text-fg-3 w-24 shrink-0 truncate">{e.actor}</span>
                <span className="mono text-fg-2 w-40 shrink-0 truncate">{e.type}</span>
                <span className="text-xs text-fg-3 truncate hidden sm:block">{summarizePayload(e)}</span>
                <span className="ml-auto text-2xs text-fg-4 shrink-0 num">{fmtTime(e.ts)}</span>
              </button>
            ))}
            {!filtered.length && <div className="p-6 text-center text-sm text-fg-4">No events match these filters.</div>}
          </div>
          <aside className="panel p-4 lg:sticky lg:top-4 max-h-[62vh] overflow-auto">
            {!sel && <div className="text-sm text-fg-4 py-8 text-center">Select an event to see its payload and hash.</div>}
            {sel && (
              <div className="animate-rise">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`w-2 h-2 rounded-full ${colorFor(sel.type)}`} />
                  <span className="mono text-fg">{sel.type}</span>
                  <span className="mono text-fg-4 ml-auto">#{sel.seq}</span>
                </div>
                <div className="text-xs text-fg-3 mb-3">{sel.actor} · {new Date(sel.ts).toLocaleString()}</div>
                <pre className="mono text-fg-2 whitespace-pre-wrap break-all bg-sunken border border-line rounded-lg p-3 leading-relaxed">{JSON.stringify(sel.payload, null, 2)}</pre>
                <dl className="mt-3 space-y-1 text-2xs text-fg-4 mono break-all">
                  <div>hash {sel.hash.slice(0, 24)}…</div>
                  <div>prev {sel.prevHash?.slice(0, 24)}…</div>
                  {sel.entityId && <div>entity {sel.entityId}</div>}
                </dl>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function summarizePayload(e: OfficeEvent): string {
  const p = e.payload as Record<string, unknown>;
  return String(p.summary ?? p.title ?? p.line ?? p.status ?? p.decision ?? p.reason ?? p.goal ?? Object.values(p)[0] ?? '').slice(0, 90);
}
