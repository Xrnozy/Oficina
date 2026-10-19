import { Select } from '../Select';
import React, { useEffect, useMemo, useState } from 'react';
import { get, useQuery, type OfficeEvent } from '../api';
import { Empty, PageHeader, StatusChip, Tag, fmtTime } from '../components';
import { Clock, Pause, Play, X } from 'lucide-react';
import { useOffice } from '../office';

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
const LABEL_COL = '8.75rem'; // actor column (8rem) + gap — the playhead is positioned against this

export default function Timeline() {
  const { data: allRuns } = useQuery<any[]>('/runs');
  const { office } = useOffice();
  const runs = useMemo(() => (allRuns && office ? allRuns.filter((r) => r.workspaceId === office.id) : allRuns), [allRuns, office?.id]);
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
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (run) get<OfficeEvent[]>(`/runs/${run.id}/events?limit=2000`).then(setEvents).catch(() => setEvents([]));
  }, [run?.id]);

  // debounce the state fetch while dragging and drop stale answers, so the
  // panel below the slider doesn't flicker (and resize the page) on every tick
  useEffect(() => {
    if (replaySeq == null || !run) { setReplayState(null); return; }
    let dead = false;
    const t = setTimeout(() => {
      get(`/runs/${run.id}/state-at?seq=${replaySeq}`).then((st) => { if (!dead) setReplayState(st); }).catch(() => {});
    }, 120);
    return () => { dead = true; clearTimeout(t); };
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
  const frac = (q: number) => (q - minSeq) / span;

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) { const k = e.type.split('.')[0]; m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [events]);
  const perActor = useMemo(() => {
    const m = new Map<string, OfficeEvent[]>();
    for (const e of events) { const l = m.get(e.actor); if (l) l.push(e); else m.set(e.actor, [e]); }
    return m;
  }, [events]);
  const errorCount = counts.get('error') ?? 0;
  const durationMs = events.length ? Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts) : 0;

  // play: step the playhead forward until it reaches the end, then drop back to live
  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, Math.round(span / 140));
    const t = setInterval(() => {
      setReplaySeq((cur) => {
        const next = (cur ?? minSeq) + step;
        if (next >= maxSeq) { setPlaying(false); return null; }
        return next;
      });
    }, 70);
    return () => clearInterval(t);
  }, [playing, span, minSeq, maxSeq]);

  return (
    <div>
      <PageHeader title="Timeline & replay" sub="Every event in the run's hash-chained log. Scrub or play to see the task board as it was at any point — replay never re-executes anything.">
        <Select className="input max-w-[280px]" value={run?.id ?? ''} onChange={(e) => { setRunId(e.target.value); setSel(null); setReplaySeq(null); setPlaying(false); }} aria-label="Run">
          {(runs ?? []).map((r) => <option key={r.id} value={r.id}>{r.goal.length > 44 ? `${r.goal.slice(0, 44)}…` : r.goal}</option>)}
        </Select>
      </PageHeader>

      {!events.length && <Empty icon={Clock} title="No events yet" text="Events appear here as soon as the run starts doing work." />}

      {events.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 mb-5 rounded-2xl border border-line bg-surface [&>*+*]:border-l [&>*+*]:border-line overflow-hidden">
          {[
            { k: 'Run', v: run ? <StatusChip value={run.status} /> : '—' },
            { k: 'Events', v: events.length.toLocaleString() },
            { k: 'Duration', v: fmtDuration(durationMs) },
            { k: 'Errors', v: <span className={errorCount ? 'text-bad' : ''}>{errorCount}</span> },
          ].map((c) => (
            <div key={c.k} className="px-4 py-3 min-w-0">
              <div className="eyebrow mb-1">{c.k}</div>
              <div className="text-lg font-semibold tracking-[-0.02em] num leading-6">{c.v}</div>
            </div>
          ))}
        </div>
      )}

      {events.length > 0 && (
        <section className="panel mb-5 overflow-hidden">
          <div className="px-4 pt-3.5 pb-3 flex items-center gap-3 flex-wrap">
            <h2 className="text-[13px] font-medium text-fg">Replay</h2>
            <span className="text-2xs text-fg-4">click a mark to inspect it</span>
            <div className="ml-auto flex items-center gap-3 flex-wrap">
              {KINDS.filter((k) => counts.has(k)).map((k) => (
                <span key={k} className="flex items-center gap-1.5 text-2xs text-fg-3"><span className={`w-2 h-2 rounded-sm ${colorFor(`${k}.`)}`} />{k}</span>
              ))}
            </div>
          </div>

          <div className="px-4 pb-3">
            <div className="relative">
              <div className="space-y-1">
                {actors.map((a) => (
                  <div key={a} className="grid grid-cols-[8rem_1fr] gap-3 items-center">
                    <button onClick={() => setActor(actor === a ? '' : a)} title="Filter the list to this actor"
                      className={`text-left text-xs flex items-baseline gap-1.5 min-w-0 ${actor === a ? 'text-fg font-medium' : 'text-fg-3 hover:text-fg'}`}>
                      <span className="truncate">{a}</span>
                      <span className="text-2xs text-fg-4 num">{perActor.get(a)?.length}</span>
                    </button>
                    <div className="relative h-6 rounded-md bg-sunken border border-line">
                      {(perActor.get(a) ?? []).map((e) => (
                        <button key={e.seq} onClick={() => setSel(e)} title={`#${e.seq} ${e.type}`}
                          className={`absolute top-1 bottom-1 w-[3px] -ml-px rounded-sm ${colorFor(e.type)} ${sel?.seq === e.seq ? 'ring-2 ring-fg scale-y-125 z-10' : 'opacity-85 hover:opacity-100'} ${e.seq > at ? '!opacity-15' : ''}`}
                          style={{ left: `${frac(e.seq) * 100}%` }} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div aria-hidden className="absolute top-0 bottom-0 w-px bg-fg/70 pointer-events-none" style={{ left: `calc(${LABEL_COL} + (100% - ${LABEL_COL}) * ${frac(at)})` }}>
                <span className="absolute -top-1 -left-[3px] w-[7px] h-[7px] rounded-full bg-fg" />
              </div>
            </div>
            <div className="grid grid-cols-[8rem_1fr] gap-3 mt-1.5 text-2xs text-fg-4 num">
              <span />
              <div className="flex justify-between"><span>{fmtTime(events[0].ts)}</span><span>{fmtTime(events[events.length - 1].ts)}</span></div>
            </div>
          </div>

          <div className="grid grid-cols-[8rem_1fr_auto] gap-3 items-center px-4 py-3 border-t border-line bg-sunken/40">
            <div>
              <button className="btn btn-xs w-[4.5rem] justify-center"
                onClick={() => { if (playing) setPlaying(false); else { if (replaySeq == null) setReplaySeq(minSeq); setPlaying(true); } }}>
                {playing ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Play</>}
              </button>
            </div>
            <input type="range" min={minSeq} max={maxSeq} value={at} aria-label="Replay position"
              onChange={(e) => { setPlaying(false); setReplaySeq(+e.target.value >= maxSeq ? null : +e.target.value); }} className="min-w-0 w-full" />
            {/* fixed-width slots: the label and button never change size, so the slider doesn't move under the cursor */}
            <div className="flex items-center gap-2">
              <span className="mono text-fg-3 w-20 text-right tabular-nums">{replaySeq == null ? <Tag tone="ok">live</Tag> : `seq ${replaySeq}`}</span>
              <button className={`btn btn-xs w-24 justify-center ${replaySeq == null ? 'invisible' : ''}`} tabIndex={replaySeq == null ? -1 : 0}
                onClick={() => { setPlaying(false); setReplaySeq(null); }}>Back to live</button>
            </div>
          </div>
          {replayState && (
            <div className="px-4 py-3 border-t border-line flex flex-wrap items-center gap-2 min-h-[3.25rem]">
              <span className="text-xs text-fg-3 mr-1">Board as of #{replaySeq}:</span>
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
            {KINDS.filter((k) => counts.has(k)).map((k) => (
              <button key={k} onClick={() => setKind(kind === k ? '' : k)} className={`h-7 px-2 rounded-md text-xs border transition-colors flex items-center gap-1.5 ${kind === k ? 'bg-raised border-line-strong text-fg' : 'border-transparent text-fg-3 hover:text-fg'}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${colorFor(`${k}.`)}`} />{k}<span className="text-fg-4 num">{counts.get(k)}</span>
              </button>
            ))}
          </div>
          {(kind || text || actor) && <button className="btn btn-ghost btn-xs" onClick={() => { setKind(''); setText(''); setActor(''); }}><X size={11} /> Clear</button>}
          <span className="ml-auto text-xs text-fg-4 num">{filtered.length} shown</span>
        </div>
      )}

      {events.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 items-start">
          <div className="panel max-h-[62vh] overflow-auto">
            <div className="sticky top-0 z-10 flex items-center gap-3 px-3.5 h-8 bg-surface border-b border-line eyebrow">
              <span className="w-10 shrink-0">Seq</span>
              <span className="w-1.5 shrink-0" />
              <span className="w-24 shrink-0">Actor</span>
              <span className="w-40 shrink-0">Event</span>
              <span className="hidden sm:block">Summary</span>
              <span className="ml-auto shrink-0">Time</span>
            </div>
            {/* cap rendered rows — a long run mounts the latest 600, earlier on demand */}
            {filtered.length > cap && (
              <button className="w-full text-center py-2 text-2xs text-fg-3 hover:text-fg hover:bg-raised/60" onClick={() => setCap((n) => n + 800)}>
                {filtered.length - cap} earlier events — show more
              </button>
            )}
            {filtered.slice(-cap).map((e) => (
              <button key={e.seq} onClick={() => setSel(e)} className={`w-full text-left px-3.5 h-9 flex items-center gap-3 border-b border-line/60 last:border-0 transition-colors ${sel?.seq === e.seq ? 'bg-raised' : 'hover:bg-raised/60'} ${e.seq > at ? 'opacity-35' : ''}`}>
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

function fmtDuration(ms: number): string {
  if (!(ms > 0)) return '—';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
