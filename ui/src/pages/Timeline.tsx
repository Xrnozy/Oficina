import { Select } from '../Select';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { get, useQuery, type OfficeEvent } from '../api';
import { Empty, PageHeader, StatusChip, TONE_BG, Tag, fmtTime, toneOf } from '../components';
import { Clock, Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { useOffice } from '../office';

// Run timeline & replay (spec §9): one lane per actor, a milestones lane, filterable event list. Drag across the lanes (or press
// play) to scrub: the board below shows every task as it was at that point. Replay is read-only — it never re-executes anything.

const KIND_COLOR: Record<string, string> = {
  'task.': 'bg-info', 'workitem.': 'bg-fg-4', 'checkrun.': 'bg-info/60',
  'error.': 'bg-bad', 'plan.': 'bg-warn', 'merge.': 'bg-ok',
  'approval.': 'bg-warn', 'cycle.': 'bg-fg-3', 'run.': 'bg-accent',
  'agent.': 'bg-fg-4', 'review.': 'bg-ok/60', 'human.': 'bg-pink',
};
const colorFor = (t: string) => KIND_COLOR[Object.keys(KIND_COLOR).find((k) => t.startsWith(k)) ?? ''] ?? 'bg-fg-4';
const KINDS = ['run', 'cycle', 'plan', 'task', 'workitem', 'checkrun', 'review', 'merge', 'error', 'approval', 'human', 'agent'];
const MILESTONES = new Set(['run.started', 'run.done', 'run.stopped', 'cycle.started', 'plan.applied', 'approval.requested', 'human.decided', 'human.prepared', 'merge.completed', 'error.reported']);
const LABEL_W = '9rem';
const SPEEDS = [1, 2, 4] as const;

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
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);

  useEffect(() => {
    if (run) get<OfficeEvent[]>(`/runs/${run.id}/events?limit=2000`).then(setEvents).catch(() => setEvents([]));
  }, [run?.id]);

  const filtered = events.filter((e) =>
    (!kind || e.type.startsWith(`${kind}.`)) &&
    (!text || `${e.type} ${summarizePayload(e)}`.toLowerCase().includes(text.toLowerCase())) &&
    (!actor || e.actor === actor));

  const actors = useMemo(() => [...new Set(events.map((e) => e.actor))], [events]);
  const minSeq = events[0]?.seq ?? 0;
  const maxSeq = events.length ? events[events.length - 1].seq : 0;
  const span = Math.max(1, maxSeq - minSeq);
  const at = replaySeq ?? maxSeq;
  const frac = (q: number) => Math.min(1, Math.max(0, (q - minSeq) / span));
  const atIndex = useMemo(() => {   // the last event at or before the playhead
    let lo = 0, hi = events.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (events[m].seq <= at) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }, [events, at]);
  const current = atIndex >= 0 ? events[atIndex] : null;

  // The board as it was at the playhead, rebuilt from the events already loaded: instant while scrubbing or playing, no request per tick.
  const replayState = useMemo(() => {
    if (replaySeq == null) return null;
    const tasks = new Map<string, { id: string; title: string; status: string }>();
    let runStatus = 'draft';
    for (let i = 0; i <= atIndex; i++) {
      const e = events[i]; const p = e.payload as Record<string, unknown>;
      if (e.type === 'task.created' && e.entityId) tasks.set(e.entityId, { id: e.entityId, title: String(p.title ?? ''), status: p.held ? 'held' : 'backlog' });
      else if (e.type === 'task.status' && e.entityId && tasks.has(e.entityId)) { const t = tasks.get(e.entityId)!; t.status = String(p.status); if (p.title) t.title = String(p.title); }
      else if (e.type === 'task.deleted' && e.entityId) tasks.delete(e.entityId);
      else if (e.type === 'run.status' && p.status) runStatus = String(p.status);
      else if (e.type === 'run.started') runStatus = 'running';
      else if (e.type === 'run.done') runStatus = 'done';
    }
    return { runStatus, tasks: [...tasks.values()] };
  }, [events, atIndex, replaySeq]);

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
  const milestones = useMemo(() => events.filter((e) => MILESTONES.has(e.type)), [events]);
  const errorCount = counts.get('error') ?? 0;
  const durationMs = events.length ? Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts) : 0;

  // play: step the playhead forward until it reaches the end, then drop back to live
  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, Math.round((span / 140) * speed));
    const t = setInterval(() => {
      setReplaySeq((cur) => {
        const next = (cur ?? minSeq) + step;
        if (next >= maxSeq) { setPlaying(false); return null; }
        return next;
      });
    }, 70);
    return () => clearInterval(t);
  }, [playing, span, minSeq, maxSeq, speed]);

  // scrubbing: press and drag anywhere across the lanes
  const tracks = useRef<HTMLDivElement>(null);
  const seekTo = (clientX: number) => {
    const r = tracks.current?.getBoundingClientRect();
    if (!r || !r.width) return;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setPlaying(false);
    const seq = Math.round(minSeq + f * span);
    setReplaySeq(seq >= maxSeq ? null : seq);
  };
  const stepBy = (dir: -1 | 1) => {
    const idx = atIndex + dir;
    if (idx < 0) return;
    setPlaying(false);
    if (idx >= events.length - 1) setReplaySeq(null); else setReplaySeq(events[idx].seq);
  };

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!playing || !current) return;
    // scroll the list itself, never the page (scrollIntoView would drag the whole page along)
    const box = listRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-seq="${current.seq}"]`);
    if (box && row && (row.offsetTop < box.scrollTop + 32 || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)) box.scrollTop = Math.max(0, row.offsetTop - box.clientHeight / 2);
  }, [playing, current?.seq]); // eslint-disable-line react-hooks/exhaustive-deps

  const times = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const e = events[Math.min(events.length - 1, Math.max(0, events.findIndex((x) => x.seq >= minSeq + f * span)))];
    return e ? fmtTime(e.ts) : '';
  });

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
          <div className="px-4 pt-3.5 pb-3 flex items-center gap-x-4 gap-y-2 flex-wrap">
            <h2 className="text-[13px] font-medium text-fg">Replay</h2>
            <span className="text-2xs text-fg-4">drag across the lanes to scrub · click a mark to inspect it</span>
            <div className="ml-auto flex items-center gap-x-3 gap-y-1 flex-wrap">
              {KINDS.filter((k) => counts.has(k)).map((k) => (
                <span key={k} className="flex items-center gap-1.5 text-2xs text-fg-3"><span className={`w-2 h-2 rounded-sm ${colorFor(`${k}.`)}`} />{k}</span>
              ))}
            </div>
          </div>

          {/* lanes */}
          <div className="px-4 pb-3 select-none">
            <div className="grid gap-x-3" style={{ gridTemplateColumns: `${LABEL_W} minmax(0,1fr)` }}>
              <div className="space-y-1.5 pt-px">
                <div className="h-5 flex items-center text-2xs text-fg-4 uppercase tracking-wide">Milestones</div>
                {actors.map((a) => (
                  <button key={a} onClick={() => setActor(actor === a ? '' : a)} title="Filter the event list to this actor"
                    className={`h-7 w-full text-left text-xs flex items-center gap-1.5 min-w-0 rounded ${actor === a ? 'text-fg font-medium' : 'text-fg-3 hover:text-fg'}`}>
                    <span className="truncate">{a}</span>
                    <span className="text-2xs text-fg-4 num">{perActor.get(a)?.length}</span>
                  </button>
                ))}
              </div>
              <div ref={tracks} className="relative space-y-1.5 touch-none cursor-col-resize"
                onPointerDown={(e) => { if ((e.target as HTMLElement).closest('[data-mark]')) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seekTo(e.clientX); }}
                onPointerMove={(e) => { if (e.buttons === 1 && (e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) seekTo(e.clientX); }}>
                <div className="relative h-5">
                  {milestones.map((e) => (
                    <button key={e.seq} data-mark onClick={() => setSel(e)} title={`#${e.seq} ${e.type}`}
                      className={`absolute top-1/2 -mt-[5px] -ml-[5px] w-[10px] h-[10px] rotate-45 rounded-[2px] ${colorFor(e.type)} ${sel?.seq === e.seq ? 'ring-2 ring-fg z-10' : ''} ${e.seq > at ? 'opacity-30' : ''}`}
                      style={{ left: `${frac(e.seq) * 100}%` }} />
                  ))}
                </div>
                {actors.map((a) => (
                  <div key={a} className="relative h-7 rounded-md bg-sunken border border-line overflow-hidden">
                    <div aria-hidden className="absolute inset-y-0 left-0 bg-fg/[0.05] pointer-events-none" style={{ width: `${frac(at) * 100}%` }} />
                    {(perActor.get(a) ?? []).map((e) => (
                      <button key={e.seq} data-mark onClick={() => setSel(e)} title={`#${e.seq} ${e.type}`}
                        className={`absolute top-1 bottom-1 w-1 -ml-[2px] rounded-sm ${colorFor(e.type)} ${sel?.seq === e.seq ? 'ring-2 ring-fg z-10' : 'hover:brightness-125'} ${e.seq > at ? 'opacity-25' : 'opacity-90'}`}
                        style={{ left: `${frac(e.seq) * 100}%` }} />
                    ))}
                  </div>
                ))}
                {/* the playhead */}
                <div aria-hidden className="absolute -top-0.5 -bottom-0.5 w-px bg-fg pointer-events-none" style={{ left: `${frac(at) * 100}%` }}>
                  <span className="absolute -top-1 -left-[5px] w-[11px] h-[11px] rounded-full bg-fg border-2 border-surface" />
                </div>
              </div>
            </div>
            <div className="grid gap-x-3 mt-2" style={{ gridTemplateColumns: `${LABEL_W} minmax(0,1fr)` }}>
              <span />
              <div className="flex justify-between text-2xs text-fg-4 num">{times.map((t, i) => <span key={i}>{t}</span>)}</div>
            </div>
          </div>

          {/* player */}
          <div className="flex items-center gap-2 px-4 py-3 border-t border-line bg-sunken/40 flex-wrap">
            <div className="flex items-center gap-1">
              <button className="btn btn-icon btn-sm" aria-label="Previous event" title="Previous event" onClick={() => stepBy(-1)} disabled={atIndex <= 0}><SkipBack size={13} /></button>
              <button className="btn btn-primary btn-sm w-[5.25rem] justify-center"
                onClick={() => { if (playing) setPlaying(false); else { if (replaySeq == null) setReplaySeq(minSeq); setPlaying(true); } }}>
                {playing ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Play</>}
              </button>
              <button className="btn btn-icon btn-sm" aria-label="Next event" title="Next event" onClick={() => stepBy(1)} disabled={replaySeq == null}><SkipForward size={13} /></button>
            </div>
            <div className="inline-flex p-0.5 rounded-md bg-surface border border-line text-2xs" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => <button key={s} onClick={() => setSpeed(s)} className={`px-2 h-6 rounded num ${speed === s ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg'}`}>{s}×</button>)}
            </div>
            {/* fixed-width slots: nothing here changes size while the playhead moves */}
            <div className="ml-auto flex items-center gap-3 min-w-0">
              <span className="text-xs text-fg-3 min-w-0 truncate hidden md:block">
                {replaySeq == null ? <Tag tone="ok">live</Tag> : current ? <><span className="mono text-fg-2">#{current.seq}</span> · {current.type} · {fmtTime(current.ts)}</> : null}
              </span>
              <span className="mono text-2xs text-fg-4 num w-24 text-right">{Math.max(0, atIndex + 1).toLocaleString()} / {events.length.toLocaleString()}</span>
              <button className={`btn btn-sm w-28 justify-center ${replaySeq == null ? 'invisible' : ''}`} tabIndex={replaySeq == null ? -1 : 0}
                onClick={() => { setPlaying(false); setReplaySeq(null); }}>Back to live</button>
            </div>
          </div>

          {/* the board at the playhead */}
          <div className="px-4 py-3.5 border-t border-line min-h-[4.5rem]">
            {!replayState ? (
              <p className="text-xs text-fg-4 py-1.5">Showing the run as it is now. Press play, step through events, or drag across the lanes to see how the board changed.</p>
            ) : <BoardAt state={replayState} seq={replaySeq ?? maxSeq} />}
          </div>
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
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-4 items-start">
          <div ref={listRef} className="panel max-h-[62vh] overflow-auto">
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
              <button key={e.seq} data-seq={e.seq} onClick={() => setSel(e)}
                className={`w-full text-left px-3.5 h-9 flex items-center gap-3 border-b border-line/60 last:border-0 transition-colors ${sel?.seq === e.seq ? 'bg-raised' : 'hover:bg-raised/60'} ${e.seq > at ? 'opacity-35' : ''} ${replaySeq != null && current?.seq === e.seq ? 'shadow-[inset_3px_0_0_rgb(var(--fg))] bg-raised/70' : ''}`}>
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
            {!sel && <div className="text-sm text-fg-4 py-8 text-center">Select an event — from the lanes or the list — to see what happened.</div>}
            {sel && <EventDetail e={sel} onReplay={() => { setPlaying(false); setReplaySeq(sel.seq >= maxSeq ? null : sel.seq); }} />}
          </aside>
        </div>
      )}
    </div>
  );
}

/** Every task as it was at the playhead: a status bar, then the tasks. */
function BoardAt({ state, seq }: { state: any; seq: number }) {
  const tasks: any[] = state.tasks ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return [...m.entries()];
  }, [tasks]);
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5 flex-wrap">
        <span className="text-xs text-fg-3">Board as of <span className="mono text-fg-2">#{seq}</span></span>
        <StatusChip value={state.runStatus} />
        <span className="text-2xs text-fg-4 num">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
      </div>
      {tasks.length > 0 && (
        <div className="flex h-1.5 rounded-full overflow-hidden bg-line gap-px mb-3" role="img" aria-label="Tasks by status">
          {groups.map(([s, n]) => <div key={s} className={TONE_BG[toneOf(s)]} style={{ width: `${(n / tasks.length) * 100}%` }} title={`${s.replace(/-/g, ' ')}: ${n}`} />)}
        </div>
      )}
      <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-center gap-2 min-w-0 rounded-lg border border-line px-2.5 py-1.5" title={t.title}>
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_BG[toneOf(t.status)]}`} />
            <span className="text-xs text-fg-2 truncate min-w-0 flex-1">{t.title || t.id}</span>
            <span className="text-2xs text-fg-4 shrink-0">{t.status === 'held' ? 'on hold' : String(t.status).replace(/-/g, ' ')}</span>
          </li>
        ))}
        {!tasks.length && <li className="text-xs text-fg-4">No tasks existed yet.</li>}
      </ul>
    </div>
  );
}

function EventDetail({ e, onReplay }: { e: OfficeEvent; onReplay: () => void }) {
  const entries = Object.entries(e.payload as Record<string, unknown>).slice(0, 30);
  return (
    <div className="animate-rise">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${colorFor(e.type)}`} />
        <span className="mono text-fg">{e.type}</span>
        <span className="mono text-fg-4 ml-auto">#{e.seq}</span>
      </div>
      <div className="text-xs text-fg-3 mb-3">{e.actor} · {new Date(e.ts).toLocaleString()}</div>
      <button className="btn btn-sm w-full mb-3" onClick={onReplay}><Play size={12} /> Replay from here</button>
      <dl className="space-y-1.5">
        {entries.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 text-xs">
            <dt className="mono text-fg-4 truncate" title={k}>{k}</dt>
            <dd className="text-fg-2 break-words [overflow-wrap:anywhere] min-w-0">
              {typeof v === 'object' && v !== null ? <code className="mono text-[11px] text-fg-3 whitespace-pre-wrap">{JSON.stringify(v)}</code> : String(v)}
            </dd>
          </div>
        ))}
        {!entries.length && <div className="text-xs text-fg-4">No details.</div>}
      </dl>
      <details className="mt-3 group">
        <summary className="text-2xs text-fg-3 cursor-pointer hover:text-fg">Raw payload and hash</summary>
        <pre className="mono text-fg-2 whitespace-pre-wrap break-all bg-sunken border border-line rounded-lg p-3 leading-relaxed mt-2 max-h-64 overflow-auto">{JSON.stringify(e.payload, null, 2)}</pre>
        <dl className="mt-2 space-y-1 text-2xs text-fg-4 mono break-all">
          <div>hash {e.hash.slice(0, 24)}…</div>
          <div>prev {e.prevHash?.slice(0, 24)}…</div>
          {e.entityId && <div>entity {e.entityId}</div>}
        </dl>
      </details>
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
