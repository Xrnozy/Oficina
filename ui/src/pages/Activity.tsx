import { Select } from '../Select';
import { useOffice, useOfficeAgents } from '../office';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, useEvents, useFetch, useQuery, type OfficeEvent } from '../api';
import { Avatar, Empty, PageHeader, StatusChip, Tag, act, fmtAgo, fmtTime } from '../components';
import { DiffStat, DiffView } from '../diff';
import { RunWorkflow } from '../workflowPicker';
import { AddMenu, UploadDock } from '../attachments';
import {
  AlertTriangle, ArrowDown, CheckCircle2, ChevronDown, ChevronRight, CircleDot, FileEdit, FileSearch, FileText, Globe,
  ListTodo, MessageSquare, Radio, Send, Sparkles, SquareTerminal, Trash2, UserCheck, Users, Wrench, XCircle,
} from 'lucide-react';

// Live activity: what each agent is actually doing, from what its CLI or API
// reports — the prompt it got, its messages, tool calls, commands and results
// — plus hand-offs between agents and a live view of its file changes.
// Covers every active run. Raw output, heartbeats and process metadata are in
// the Technical log tab. Reasoning appears only when the CLI emits it.

const READABLE = new Set(['agent.activity', 'workitem.started', 'workitem.delivered', 'workitem.failed', 'agent.msg', 'checkrun.completed',
  'task.status', 'review.decided', 'qa.decided', 'accept.decided', 'error.reported', 'error.resolved', 'merge.completed', 'prompt.drafted',
  'prompt.reviewed', 'model.switched', 'skill.applied', 'readonly.violation', 'commit.created', 'agent.stuck', 'checkpoint.error', 'prompt.retry', 'run.blocked', 'plan.started', 'plan.validated',
  'cache.hit', 'scope.violation', 'dod.flagged', 'lessons.injected', 'human.prepared', 'human.decided', 'approval.app', 'task.deleted']);
const TECHNICAL = new Set(['agent.output', 'agent.heartbeat', 'agent.thinking', 'agent.status', 'model.routed', 'checkpoint.created', 'checkpoint.completed', 'quota.blocked', 'adapter.failed', 'engine.reconciled']);
const ALL = new Set([...READABLE, ...TECHNICAL, 'agent.diff']);
const ACTIVE_RUN = ['draft', 'dod-review', 'running', 'pausing', 'paused', 'verifying'];
const WORKING = ['planning', 'coding', 'testing', 'reviewing', 'working', 'thinking'];

function belongsTo(e: OfficeEvent, a: any): boolean {
  const p = e.payload as Record<string, unknown>;
  if (e.type === 'agent.msg') return p.to === a.id || p.from === a.id;
  if (e.type === 'model.switched' || e.type === 'model.routed') return p.agent === a.name;
  return e.actor === a.name || e.actor === a.id || p.agentId === a.id;
}

// The agent's current (or last) work item, from the event stream.
function workState(events: OfficeEvent[]) {
  let current: OfficeEvent | null = null; let finished = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'workitem.started') { current = e; break; }
  }
  if (current) finished = events.some((e) => e.seq > current!.seq && e.entityId === current!.entityId && ['workitem.delivered', 'workitem.failed', 'agent.stuck'].includes(e.type));
  const output = [...events].reverse().find((e) => (e.type === 'agent.output' || e.type === 'agent.activity' || e.type === 'agent.heartbeat') && (!current || e.seq > current.seq));
  const diff = [...events].reverse().find((e) => e.type === 'agent.diff' && (!current || e.entityId === current.entityId));
  const last = [...events].reverse().find((e) => e.type === 'agent.activity' && !['prompt', 'status'].includes(String((e.payload as any).kind)));
  return { current, running: !!current && !finished, lastOutputAt: output?.ts ?? null, diff, last };
}

export default function Activity() {
  const { agents } = useOfficeAgents();
  const { office } = useOffice();
  const { data: allRuns, reload: reloadRuns } = useQuery<any[]>('/runs');
  const runs = useMemo(() => (allRuns && office ? allRuns.filter((r) => r.workspaceId === office.id) : allRuns), [allRuns, office?.id]);
  const active = useMemo(() => (runs ?? []).filter((r) => ACTIVE_RUN.includes(r.status)), [runs]);
  const activeKey = active.map((r) => r.id).join(',');
  const [events, setEvents] = useState<OfficeEvent[]>([]);
  const [params, setParams] = useSearchParams();
  const focus = params.get('agent');
  const [tab, setTab] = useState<'activity' | 'technical'>('activity');
  const [now, setNow] = useState(Date.now());
  const [dock, setDock] = useState<null | 'documents' | 'task'>(null);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  // every active run's recent events, merged in order
  useEffect(() => {
    const ids = activeKey ? activeKey.split(',') : (runs?.[0] ? [runs[0].id] : []);
    if (!ids.length) return;
    Promise.all(ids.map((id) => get<OfficeEvent[]>(`/runs/${id}/events?limit=1200&latest=1`).catch(() => [] as OfficeEvent[])))
      .then((lists) => setEvents(lists.flat().sort((a, b) => a.seq - b.seq)));
  }, [activeKey, runs?.[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // events stream in one message per WS frame — batch them so a busy run
  // re-renders at ~4fps instead of once per event
  const buf = useRef<OfficeEvent[]>([]);
  const bufTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEvents((e) => {
    if (e.runId && activeRef.current.length && !activeRef.current.some((r) => r.id === e.runId)) return;
    if (!ALL.has(e.type)) return;
    buf.current.push(e);
    if (!bufTimer.current) {
      bufTimer.current = setTimeout(() => {
        bufTimer.current = null;
        const batch = buf.current; buf.current = [];
        setEvents((prev) => [...prev, ...batch].slice(-4000));
      }, 250);
    }
  });

  const members = (agents ?? []).filter((a) => (a.memberships ?? []).some((m: any) => m.active));
  const byAgent = useMemo(() => new Map(members.map((a) => [a.id, events.filter((e) => belongsTo(e, a))])), [members, events]);
  const states = useMemo(() => new Map(members.map((a) => [a.id, workState(byAgent.get(a.id) ?? [])])), [members, byAgent]);
  const selected = focus ? members.find((a) => a.id === focus) ?? null : null;
  const feed = selected ? byAgent.get(selected.id) ?? [] : events;
  const shown = feed.filter((e) => (tab === 'activity' ? READABLE.has(e.type) : TECHNICAL.has(e.type) || e.type === 'agent.activity'));
  // the changes pane follows the selected agent, or whoever is changing files
  const changesFor = selected ?? members.find((a) => states.get(a.id)?.running && states.get(a.id)?.diff) ?? members.find((a) => states.get(a.id)?.diff) ?? null;
  const agentOf = (e: OfficeEvent) => members.find((a) => belongsTo(e, a));

  return (
    <div className="flex flex-col h-[calc(100dvh-3.5rem-4rem)] min-h-[560px]">
      <PageHeader title="Live activity" sub={`What each agent is doing, as its CLI reports it — across ${active.length || 'no'} active run${active.length === 1 ? '' : 's'}.`}>
        {(active[0] ?? runs?.[0]) && <RunWorkflow run={active[0] ?? runs![0]} onChanged={reloadRuns} />}
        {office && <AddMenu workspaceId={office.id} runId={active[0]?.id ?? null} onChanged={reloadRuns} onUpload={setDock} />}
      </PageHeader>
      {!members.length && <Empty icon={Radio} title="No active agents" text="Agents appear here once they hold a role. Assign one under Roles." />}
      {members.length > 0 && (
        <div className="grid gap-4 flex-1 min-h-0 grid-cols-1 lg:grid-cols-[16rem_minmax(0,1fr)] xl:grid-cols-[16rem_minmax(0,1fr)_24rem]">
          {/* agents */}
          <nav className="panel overflow-auto min-h-0 p-1.5 space-y-0.5" aria-label="Agents">
            <button onClick={() => setParams({})} className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-sm ${!selected ? 'bg-raised' : 'hover:bg-raised/60'}`}>
              <span className="w-6 h-6 rounded-md bg-sunken border border-line grid place-items-center"><Users size={13} /></span>
              <span className="font-medium text-fg">All agents</span>
              <span className="ml-auto text-2xs text-fg-4">{members.filter((a) => states.get(a.id)?.running).length} working</span>
            </button>
            {members.map((a) => {
              const st = states.get(a.id)!;
              const kind = st.current ? String((st.current.payload as any).kind) : null;
              const quiet = st.running && st.lastOutputAt ? Math.round((now - Date.parse(st.lastOutputAt)) / 1000) : null;
              return (
                <button key={a.id} onClick={() => setParams({ agent: a.id })} className={`w-full flex gap-2.5 px-2.5 py-2 rounded-lg text-left ${selected?.id === a.id ? 'bg-raised' : 'hover:bg-raised/60'}`}>
                  <span className="relative shrink-0"><Avatar agent={a} size="sm" />{st.running && <span className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full bg-ok ring-2 ring-canvas animate-pulse" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5"><span className="text-sm font-medium text-fg truncate">{a.name}</span></span>
                    <span className="flex items-center gap-1.5 mt-0.5"><StatusChip value={st.running ? a.status : (WORKING.includes(a.status) ? 'idle' : a.status)} />{st.running && kind && <span className="text-2xs text-fg-3">{kind}</span>}</span>
                    {st.last && <span className="block text-2xs text-fg-4 truncate mt-0.5">{String((st.last.payload as any).text ?? '').slice(0, 80)}</span>}
                    {quiet != null && quiet > 20 && <span className="block text-2xs text-warn mt-0.5">no output for {quiet >= 60 ? `${Math.floor(quiet / 60)}m` : `${quiet}s`}</span>}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* feed */}
          <div className="flex flex-col gap-3 min-h-0 min-w-0">
            <Feed key={selected?.id ?? 'all'} agent={selected} members={members} shown={shown} tab={tab} setTab={setTab} state={selected ? states.get(selected.id)! : null} agentOf={agentOf} now={now} />
            {/* the upload panel opens right under the chat input */}
            {dock && office && <UploadDock key={dock} workspaceId={office.id} runId={active[0]?.id ?? null} mode={dock} onClose={() => setDock(null)} onDone={reloadRuns} />}
          </div>

          {/* changes */}
          <ChangesPane agent={changesFor} state={changesFor ? states.get(changesFor.id)! : null} />
        </div>
      )}
    </div>
  );
}

function Feed({ agent, members, shown, tab, setTab, state, agentOf, now }: {
  agent: any | null; members: any[]; shown: OfficeEvent[]; tab: 'activity' | 'technical'; setTab: (t: 'activity' | 'technical') => void;
  state: ReturnType<typeof workState> | null; agentOf: (e: OfficeEvent) => any; now: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [limit, setLimit] = useState(300);
  const [msg, setMsg] = useState('');
  const [to, setTo] = useState('');
  const recipient = agent?.id ?? to;
  useEffect(() => { if (pinned) ref.current?.scrollTo({ top: ref.current.scrollHeight }); }, [shown.length, pinned, tab]);
  const quiet = state?.running && state.lastOutputAt ? Math.round((now - Date.parse(state.lastOutputAt)) / 1000) : null;
  return (
    <section className="panel flex flex-col flex-1 min-h-[200px] overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 h-12 border-b border-line shrink-0">
        {agent ? <><Avatar agent={agent} size="sm" /><span className="text-sm font-medium text-fg truncate">{agent.name}</span><StatusChip value={state?.running ? agent.status : 'idle'} /></>
          : <><Users size={15} className="text-fg-3" /><span className="text-sm font-medium text-fg">All agents</span></>}
        {state?.current && state.running && <Tag tone="info">{String((state.current.payload as any).kind)} · since {fmtTime(state.current.ts)}</Tag>}
        <div className="ml-auto inline-flex p-0.5 rounded-md bg-sunken border border-line text-2xs">
          {(['activity', 'technical'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-2.5 h-6 rounded ${tab === t ? 'bg-raised text-fg' : 'text-fg-3 hover:text-fg'}`}>{t === 'activity' ? 'Activity' : 'Technical log'}</button>
          ))}
        </div>
      </div>
      {quiet != null && quiet > 20 && tab === 'activity' && (
        <div className="px-4 py-1.5 text-xs border-b border-line bg-warn/[0.06] text-fg-3 flex items-center gap-2">
          <CircleDot size={12} className="text-warn" />
          Running — no output from the CLI for {quiet >= 60 ? `${Math.floor(quiet / 60)}m ${quiet % 60}s` : `${quiet}s`}. Some CLIs (e.g. Devin) print only when they finish; file changes appear on the right as they happen.
        </div>
      )}
      <div className="relative flex-1 min-h-0">
        <div ref={ref} onScroll={(e) => { const el = e.currentTarget; setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 24); }}
          className={`absolute inset-0 overflow-auto px-4 py-3 ${tab === 'technical' ? 'font-mono text-[11px] leading-[17px] bg-sunken/30 space-y-0.5' : 'space-y-2 text-[13px]'}`}>
          {/* paginate: render the latest 300; earlier history on demand — a long
              run used to mount every row at once */}
          {shown.length > limit && (
            <button className="w-full btn btn-ghost btn-sm text-2xs" onClick={() => setLimit((n) => n + 500)}>
              Show earlier events ({shown.length - limit} hidden)
            </button>
          )}
          {tab === 'activity'
            ? shown.slice(-limit).map((e) => {
              const who = !agent ? agentOf(e) : null;
              return (
                <div key={e.seq} className={who ? 'flex gap-2' : ''}>
                  {who && <span className="shrink-0 mt-0.5" title={who.name}><Avatar agent={who} size="sm" /></span>}
                  <div className="min-w-0 flex-1"><ActivityRow e={e} wide /></div>
                </div>
              );
            })
            : shown.slice(-limit).map((e) => (
              <div key={e.seq} className="flex gap-2">
                <span className="text-fg-4 shrink-0 num">{fmtTime(e.ts)}</span>
                {!agent && <span className="text-fg-4 shrink-0 w-20 truncate">{e.actor}</span>}
                <span className="break-all min-w-0 text-fg-3"><span className="text-fg-4">{e.type}</span> {technicalText(e)}</span>
              </div>
            ))}
          {!shown.length && <div className="text-fg-4 py-10 text-center text-xs">{tab === 'activity' ? 'Nothing yet. Activity appears here as soon as an agent starts.' : 'No technical records yet.'}</div>}
          {shown.length > limit && <div className="text-2xs text-fg-4 text-center pt-1">latest {limit} of {shown.length}</div>}
        </div>
        {!pinned && <button onClick={() => setPinned(true)} className="absolute bottom-3 left-1/2 -translate-x-1/2 btn btn-xs shadow-pop"><ArrowDown size={11} /> Jump to latest</button>}
      </div>
      <form className="flex gap-2 p-2.5 border-t border-line" onSubmit={async (e) => {
        e.preventDefault();
        if (!msg.trim() || !recipient) return;
        if (await act(post(`/agents/${recipient}/message`, { text: msg.trim() }), 'Delivered with the agent\'s next prompt')) setMsg('');
      }}>
        {!agent && (
          <Select className="input input-sm w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient">
            <option value="">Message…</option>{members.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        )}
        <input className="input input-sm flex-1" aria-label="Message" placeholder={agent ? `Instruct ${agent.name} — delivered with its next prompt` : 'Pick an agent, then type an instruction'} value={msg} onChange={(e) => setMsg(e.target.value)} />
        <button className="btn btn-sm btn-icon !w-7" disabled={!msg.trim() || !recipient} aria-label="Send"><Send size={12} /></button>
      </form>
    </section>
  );
}

function ChangesPane({ agent, state }: { agent: any | null; state: ReturnType<typeof workState> | null }) {
  const diffEv = state?.diff ?? null;
  const wid = diffEv?.entityId ?? null;
  const [file, setFile] = useState<string | null>(null);
  useEffect(() => { setFile(null); }, [wid]);
  const files: any[] = (diffEv?.payload as any)?.files ?? [];
  const total = (diffEv?.payload as any)?.total ?? files.length;
  const { data, reload } = useFetch<any>(wid && file ? `/workitems/${wid}/diff?file=${encodeURIComponent(file)}` : null, [wid, file]);
  useEvents((e) => { if (e.type === 'agent.diff' && e.entityId === wid && file) reload(); });
  return (
    <aside className="panel flex flex-col min-h-[240px] overflow-hidden lg:col-span-2 xl:col-span-1">
      <div className="flex items-center gap-2 px-4 h-12 border-b border-line shrink-0">
        <FileEdit size={14} className="text-fg-3" />
        <span className="text-sm font-medium text-fg">Changes</span>
        {agent && <span className="text-xs text-fg-4 truncate">· {agent.name}</span>}
        {total > 0 && <span className="ml-auto text-2xs text-fg-4">{total} file{total === 1 ? '' : 's'}{state?.running ? ' · live' : ''}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!files.length && <div className="px-4 py-8 text-xs text-fg-4 text-center">No file changes yet. When a developer edits your repository, its changes show here as they are written.</div>}
        {files.length > 0 && !file && (
          <ul className="py-1">
            {files.map((f) => (
              <li key={f.path}>
                <button onClick={() => setFile(f.path)} className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-raised/60 text-xs">
                  <span className={`mono w-3 ${f.status === 'A' ? 'text-ok' : f.status === 'D' ? 'text-bad' : 'text-fg-4'}`}>{f.status}</span>
                  <span className="mono truncate flex-1 text-fg-2" title={f.path}>{f.path}</span>
                  {f.added != null && f.added >= 0 ? <DiffStat added={f.added} removed={f.removed} /> : <span className="text-2xs text-fg-4">binary</span>}
                </button>
              </li>
            ))}
            {total > files.length && <li className="px-4 py-1 text-2xs text-fg-4">…and {total - files.length} more</li>}
          </ul>
        )}
        {file && (
          <div className="p-3 space-y-2">
            <button className="btn btn-xs" onClick={() => setFile(null)}>← all files</button>
            {!data ? <div className="text-xs text-fg-4">Loading…</div> : <DiffView diff={data.diff ?? ''} maxOpen={1} empty="No textual changes (binary, or reverted since)." />}
          </div>
        )}
      </div>
      <div className="px-4 py-2 border-t border-line text-2xs text-fg-4">Written to the repository, not committed. Undo from Checkpoints.</div>
    </aside>
  );
}

// ------------------------------------------------------------ rows

const OP_ICON: Record<string, React.ElementType> = { read: FileText, edit: FileEdit, write: FileEdit, search: FileSearch, command: SquareTerminal, web: Globe, other: Wrench };

function Expand({ label, children, tone = '' }: { label: React.ReactNode; children: React.ReactNode; tone?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(!open)} className={`flex items-center gap-1 text-left ${tone}`}>{open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{label}</button>
      {open && <pre className="mt-1 ml-4 p-2 rounded-md bg-sunken border border-line text-[11px] leading-[16px] whitespace-pre-wrap break-words max-h-80 overflow-auto font-mono text-fg-2">{children}</pre>}
    </div>
  );
}

// The agent's final result: shown in full (long ones collapse to a preview).
function Result({ text, open }: { text: string; open: boolean }) {
  const [more, setMore] = useState(false);
  const clean = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const long = clean.length > 600 || clean.split('\n').length > 10;
  const shown = !long || more ? clean : clean.split('\n').slice(0, 8).join('\n').slice(0, 600);
  if (!open) return <div className="text-xs text-fg-3 truncate mt-0.5">{clean.split('\n')[0]}</div>;
  return (
    <div className="mt-1">
      <div className="text-[12.5px] text-fg-2 whitespace-pre-wrap break-words">{shown}{long && !more ? '…' : ''}</div>
      {long && <button className="text-2xs text-fg-3 hover:text-fg mt-1" onClick={() => setMore(!more)}>{more ? 'show less' : 'show full result'}</button>}
    </div>
  );
}

function Row({ icon: Icon, tone = 'text-fg-3', time, children }: { icon: React.ElementType; tone?: string; time: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 items-start">
      <Icon size={13} className={`mt-[3px] shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      <span className="text-2xs text-fg-4 num shrink-0 mt-[2px]">{fmtTime(time)}</span>
    </div>
  );
}

function ActivityRow({ e, wide }: { e: OfficeEvent; wide: boolean }) {
  const p = e.payload as Record<string, any>;
  if (e.type === 'agent.activity') {
    switch (p.kind) {
      case 'prompt': return <Row icon={MessageSquare} tone="text-accent" time={e.ts}><Expand label={<span className="text-fg-2 font-medium">{p.text}</span>}>{p.detailTruncated ? <FullDetail seq={e.seq} preview={p.detail} /> : p.detail}</Expand></Row>;
      case 'status': return <Row icon={CircleDot} tone="text-fg-4" time={e.ts}><span className="text-fg-4 text-xs">{p.text}</span></Row>;
      case 'message': return <Row icon={MessageSquare} tone="text-fg-2" time={e.ts}><div className="text-fg whitespace-pre-wrap">{p.text}</div></Row>;
      case 'reasoning': return <Row icon={Sparkles} tone="text-fg-4" time={e.ts}><Expand label={<span className="text-fg-3 italic">Reasoning (as emitted by the CLI)</span>}>{p.text}</Expand></Row>;
      case 'todo': return (
        <Row icon={ListTodo} tone="text-info" time={e.ts}>
          <div className="text-fg-2">{p.text}</div>
          <ul className="mt-0.5 space-y-0.5 text-xs">{(p.todos ?? []).map((t: any, i: number) => (
            <li key={i} className={t.status === 'completed' ? 'text-fg-4 line-through' : t.status === 'in_progress' ? 'text-fg' : 'text-fg-3'}>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▸' : '○'} {t.text}</li>
          ))}</ul>
        </Row>
      );
      case 'tool': {
        const Icon = OP_ICON[p.op] ?? Wrench;
        return <Row icon={Icon} tone={p.op === 'edit' || p.op === 'write' ? 'text-warn' : p.op === 'command' ? 'text-info' : 'text-fg-3'} time={e.ts}>
          <span className="text-fg-2">{p.text}</span>
          {p.command && p.text !== `Run ${p.command}` && <div className="mono text-2xs text-fg-3 truncate">$ {p.command}</div>}
        </Row>;
      }
      case 'tool-result': return <Row icon={p.ok === false ? XCircle : CheckCircle2} tone={p.ok === false ? 'text-bad' : 'text-ok'} time={e.ts}>
        {p.detail ? <Expand label={<span className={p.ok === false ? 'text-bad' : 'text-fg-3'}>{p.text}</span>}>{p.detail}</Expand> : <span className="text-fg-3">{p.text}</span>}
      </Row>;
      case 'error': return <Row icon={AlertTriangle} tone="text-bad" time={e.ts}><span className="text-bad whitespace-pre-wrap">{p.text}</span></Row>;
      case 'result': return <Row icon={CheckCircle2} tone="text-ok" time={e.ts}>
        <span className="text-fg-2">{p.text}</span>
        <span className="text-2xs text-fg-4 ml-2">{[p.costUsd != null && `$${Number(p.costUsd).toFixed(3)}`, p.inputTokens && `${p.inputTokens} in`, p.outputTokens && `${p.outputTokens} out`, p.durationMs && `${Math.round(p.durationMs / 1000)}s`].filter(Boolean).join(' · ')}</span>
      </Row>;
      default: return null;
    }
  }
  // lifecycle and hand-offs
  const line = (icon: React.ElementType, tone: string, text: React.ReactNode) => <Row icon={icon} tone={tone} time={e.ts}><span className="text-fg-3">{text}</span></Row>;
  switch (e.type) {
    case 'prompt.retry': return line(AlertTriangle, 'text-warn', <>Provider error during {p.stage} — retrying (attempt {p.attempt}): {p.error}</>);
    case 'run.blocked': return line(AlertTriangle, 'text-bad', <>Run needs you: {p.reason} ({(p.items ?? []).join(', ')}) — see Needs you</>);
    case 'checkpoint.error': return line(AlertTriangle, 'text-warn', <>Could not record the repository state for “{p.label}” — {p.error}</>);
    case 'agent.stuck': return line(AlertTriangle, 'text-warn', <>No output for {p.minutes} min — the {p.kind} step is being retried</>);
    case 'plan.started': return line(ListTodo, 'text-fg-3', <>Planning {p.bootstrap ? 'the request' : 'the next cycle'}</>);
    case 'plan.validated': return p.ok ? line(CheckCircle2, 'text-ok', 'Plan accepted by the engine') : line(AlertTriangle, 'text-warn', <>Plan rejected: {(p.problems ?? []).join('; ')}</>);
    case 'workitem.started': return <div className="flex items-center gap-2 pt-2 text-2xs uppercase tracking-wide text-fg-4"><span className="h-px flex-1 bg-line" />{p.kind} started<span className="h-px flex-1 bg-line" /></div>;
    case 'workitem.delivered': return (
      <Row icon={CheckCircle2} tone="text-ok" time={e.ts}>
        <div className="rounded-lg border border-ok/25 bg-ok/[0.05] px-3 py-2">
          <div className="text-xs font-medium text-ok">Finished {p.kind}{p.backend ? <span className="text-fg-4 font-normal"> on {p.backend}</span> : null}{p.costUsd ? <span className="text-fg-4 font-normal"> · ${Number(p.costUsd).toFixed(3)}</span> : null}</div>
          {p.summary && <Result text={String(p.summary)} open={wide} />}
        </div>
      </Row>
    );
    case 'workitem.failed': return line(XCircle, 'text-bad', <span className="text-bad">{p.kind} failed — {p.error}</span>);
    case 'agent.msg': return line(Send, 'text-accent', <><span className="text-fg-2">{p.fromName} → {p.toName}</span> <Tag>{p.kind}</Tag> {String(p.text).slice(0, wide ? 1200 : 300)}</>);
    case 'checkrun.completed': return line(p.status === 'pass' ? CheckCircle2 : XCircle, p.status === 'pass' ? 'text-ok' : 'text-bad', <>Check {p.check}: {p.status} — {p.summary}</>);
    case 'task.status': return line(ListTodo, 'text-fg-4', <>{p.title ?? p.taskId} → {p.status}{p.reason ? ` (${p.reason})` : ''}</>);
    case 'qa.decided': return line(p.decision === 'pass' ? CheckCircle2 : XCircle, p.decision === 'pass' ? 'text-ok' : 'text-bad', <>Review & validation: {p.decision}{p.summary ? ` — ${p.summary}` : ''}</>);
    case 'review.decided': return line(p.decision === 'approve' ? CheckCircle2 : XCircle, p.decision === 'approve' ? 'text-ok' : 'text-warn', <>Review: {p.decision}{p.notes ? ` — ${p.notes}` : ''}</>);
    case 'accept.decided': return line(p.decision === 'accept' ? CheckCircle2 : AlertTriangle, p.decision === 'accept' ? 'text-ok' : 'text-warn', <>PM {p.decision === 'accept' ? 'accepted the task' : 'sent it back'}{p.notes ? ` — ${p.notes}` : ''}</>);
    case 'prompt.drafted': return line(MessageSquare, 'text-fg-3', <>Drafted the prompt for {p.target} (draft {Number(p.revision) + 1}){p.rationale ? ` — ${p.rationale}` : ''}</>);
    case 'prompt.reviewed': return line(p.decision === 'approve' ? CheckCircle2 : AlertTriangle, p.decision === 'approve' ? 'text-ok' : 'text-warn', p.decision === 'approve' ? 'Approved the prompt' : `Sent the prompt back: ${p.notes}`);
    case 'model.switched': return line(Wrench, 'text-warn', <>Model {p.from} → {p.to} ({p.reason})</>);
    case 'skill.applied': return line(Sparkles, 'text-info', <>Skills: {(p.applied ?? []).map((s: any) => s.name).join(', ') || 'none applied'}{(p.skipped ?? []).length ? <span className="text-fg-4"> · skipped {(p.skipped as any[]).map((s) => `${s.name} (${s.reason})`).join(', ')}</span> : null}</>);
    case 'readonly.violation': return line(AlertTriangle, 'text-warn', <>Changed files during read-only {p.kind}: {(p.files ?? []).join(', ')} — undo it from Checkpoints if unwanted</>);
    case 'commit.created': return line(CheckCircle2, 'text-ok', <>Committed {String(p.sha).slice(0, 8)} — {p.title}</>);
    case 'cache.hit': return line(CheckCircle2, 'text-ok', <>Cache hit — reused the identical {p.kind} result{Number(p.savedPromptChars) ? ` (saved ~${Number(p.savedPromptChars).toLocaleString()} prompt chars)` : ''}</>);
    case 'scope.violation': return line(AlertTriangle, 'text-warn', <>Scope check: {(p.files ?? []).slice(0, 5).join(', ')} outside the declared paths — asked the PM</>);
    case 'dod.flagged': return line(AlertTriangle, 'text-warn', <>{(p.items ?? []).length} DoD item(s) have no runnable check — judged at review</>);
    case 'lessons.injected': return line(Sparkles, 'text-info', <>Lessons from this repo: {p.count} injected into the prompt</>);
    case 'human.prepared': return line(UserCheck, 'text-warn', <>Report ready for your review — app {String(p.appStatus)}{Number(p.issues) ? `, ${p.issues} issue(s)` : ''}; {String(p.routes)} screen(s) to test</>);
    case 'human.decided': return line(p.decision === 'approved' ? CheckCircle2 : XCircle, p.decision === 'approved' ? 'text-ok' : 'text-bad', <>You {String(p.decision)} “{String(p.nodeLabel)}”{p.feedback ? <> — {String(p.feedback)}</> : null}</>);
    case 'approval.app': return line(CircleDot, 'text-fg-4', <>App for review: {String(p.state)}{p.url ? ` on ${p.url}` : ''}{p.restarted ? ' (restarted by you)' : ''}</>);
    case 'task.deleted': return line(Trash2, 'text-fg-4', <>Task “{String(p.title)}” deleted</>);
    case 'error.reported': return line(AlertTriangle, 'text-bad', <>{p.errorId} [{p.severity}] {p.title}</>);
    case 'error.resolved': return line(CheckCircle2, 'text-ok', <>{p.errorId} resolved</>);
    case 'merge.completed': return line(CheckCircle2, 'text-ok', 'Merged');
    default: return null;
  }
}

// The WS broadcast caps long fields at ~2k chars; fetch the stored event on demand.
function FullDetail({ seq, preview }: { seq: number; preview: string }) {
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => { let dead = false; get<any>(`/events/${seq}`).then((ev) => { if (!dead) setFull(String(ev?.payload?.detail ?? preview)); }).catch(() => {}); return () => { dead = true; }; }, [seq, preview]);
  return <>{full ?? preview}</>;
}

function technicalText(e: OfficeEvent): string {
  const p = e.payload as Record<string, any>;
  if (e.type === 'agent.output') return `${p.stream === 'stderr' ? '[stderr] ' : ''}${p.line ?? ''}`;
  if (e.type === 'agent.activity') return `${p.kind}: ${String(p.text ?? '').slice(0, 300)}`;
  if (e.type === 'model.routed') return String(p.reason ?? '');
  return JSON.stringify(p).slice(0, 400);
}
