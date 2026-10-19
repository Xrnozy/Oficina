import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useQuery } from '../api';
import { Avatar, Empty, Muted, PageHeader, Panel, StatusChip, Tag, act, fmtAgo, useCurrentRun, type Tone } from '../components';
import { ArrowRight, MessagesSquare, Send } from 'lucide-react';

// Collaboration (spec 1, 2, 8): what agents say to each other, prompts moving
// through Prompt Creator → PM review, and automatic model switches.

const KIND_TONE: Record<string, Tone> = { question: 'warn', help: 'warn', challenge: 'bad', finding: 'info', decision: 'ok', handoff: 'idle', note: 'idle' };
const KINDS = ['all', 'question', 'finding', 'help', 'challenge', 'handoff', 'decision', 'note'] as const;
const STAGE_TONE: Record<string, Tone> = { drafting: 'info', revising: 'warn', 'pm-review': 'warn', approved: 'ok', escalated: 'bad' };
const STAGE_LABEL: Record<string, string> = { drafting: 'Prompt Creator drafting', revising: 'revising per PM notes', 'pm-review': 'awaiting PM review', approved: 'approved — sent to agent', escalated: 'needs your decision' };

export default function Team() {
  const { run } = useCurrentRun();
  const { data: msgs } = useQuery<any[]>(run ? `/runs/${run.id}/messages` : null, [run?.id]);
  const { data: detail } = useQuery<any>(run ? `/runs/${run.id}` : null, [run?.id]);
  const { data: evs } = useQuery<any[]>(run ? `/runs/${run.id}/events?types=prompt.drafted,prompt.reviewed,prompt.review.skipped,model.switched,fallback.exhausted,quota.blocked&limit=400` : null, [run?.id]);
  const { data: agents } = useQuery<any[]>('/agents');
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all');
  const [who, setWho] = useState('');
  const [to, setTo] = useState('');
  const [text, setText] = useState('');

  const byName = useMemo(() => new Map((agents ?? []).map((a) => [a.name, a])), [agents]);
  const byId = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const filtered = (msgs ?? []).filter((m) => (kind === 'all' || m.kind === kind) && (!who || m.fromAgent === who || m.toAgent === who));
  const tasks: any[] = detail?.tasks ?? [];
  const inPrep = tasks.filter((t) => t.meta?.promptStage && t.meta.promptStage !== 'approved');
  const reviews = (evs ?? []).filter((e) => e.type.startsWith('prompt.')).reverse();
  const switches = (evs ?? []).filter((e) => ['model.switched', 'fallback.exhausted', 'quota.blocked'].includes(e.type)).reverse();
  const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;

  if (!run) return <Empty icon={MessagesSquare} title="No run yet" text="Start a run from the dashboard; agent conversations and prompt reviews show up here." />;

  return (
    <div className="space-y-5">
      <PageHeader title="Messages" sub="What agents pass each other — hand-offs, findings, questions — each delivered with the recipient's next prompt. Send your own instructions to any agent here." />

      <div className="grid grid-cols-1 xl:grid-cols-[1.5fr_1fr] gap-5 items-start [&>*]:min-w-0">
        <Panel title={<>Team conversation <span className="text-fg-4 font-normal num">· {msgs?.length ?? 0}</span></>} bodyClass="pb-2"
          action={<select className="input input-sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by agent">
            <option value="">everyone</option>{(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>}>
          <div className="px-4 pb-2 flex flex-wrap gap-1">
            {KINDS.map((k) => <button key={k} onClick={() => setKind(k)} className={`chip cursor-pointer ${kind === k ? '!bg-fg !text-canvas !border-fg' : ''}`}>{k}</button>)}
          </div>
          <ol className="divide-line max-h-[60vh] overflow-auto">
            {filtered.map((m) => {
              const from = byId.get(m.fromAgent);
              return (
                <li key={m.id} className="px-4 py-3 flex gap-3">
                  {from ? <Avatar agent={from} size="sm" /> : <span className="w-6 h-6 rounded-md bg-fg text-canvas text-2xs grid place-items-center font-semibold shrink-0">You</span>}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap text-xs">
                      <span className="font-medium text-fg">{m.fromName === 'owner' ? 'You' : m.fromName}</span>
                      <ArrowRight size={11} className="text-fg-4" />
                      <span className="text-fg-2">{m.toName === 'all' ? 'everyone' : m.toName === 'owner' ? 'you' : m.toName}</span>
                      <Tag tone={KIND_TONE[m.kind] ?? 'idle'}>{m.kind}</Tag>
                      {m.taskId && <Link to={`/tasks/${m.taskId}`} className="text-fg-4 hover:text-fg truncate max-w-[24ch]">{title(m.taskId)}</Link>}
                      <span className="ml-auto text-fg-4 num">{fmtAgo(m.createdAt)}</span>
                    </div>
                    <p className="text-sm text-fg-2 mt-1 whitespace-pre-wrap break-words">{m.text}</p>
                    <div className="text-2xs text-fg-4 mt-0.5">{m.readAt ? `delivered ${fmtAgo(m.readAt)}` : m.toRole === 'all' ? 'shared with every agent' : 'waiting for the recipient\'s next prompt'}</div>
                  </div>
                </li>
              );
            })}
            {!filtered.length && <li className="px-4 py-6"><Muted>No messages{kind !== 'all' || who ? ' match these filters' : ' yet — they appear as agents hand off, review and ask each other things'}.</Muted></li>}
          </ol>
          <form className="mx-4 mt-2 pt-3 border-t border-line flex gap-2 flex-wrap" onSubmit={async (e) => {
            e.preventDefault();
            if (!to || !text.trim()) return;
            const r = await act(post(`/agents/${to}/message`, { text: text.trim() }), 'Queued for the agent\'s next prompt');
            if (r) setText('');
          }}>
            <select className="input input-sm w-40" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Recipient">
              <option value="">Message…</option>{(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <input className="input input-sm flex-1 min-w-[12rem]" placeholder="Guidance, a correction, an answer…" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn btn-sm btn-primary" disabled={!to || !text.trim()}><Send size={12} /> Send</button>
          </form>
        </Panel>

        <div className="space-y-5">
          <Panel title="PM prompts" action={<Link to="/routing" className="text-xs text-fg-3 hover:text-fg">workflow settings →</Link>}>
            <div className="eyebrow mb-1.5">In preparation</div>
            {!inPrep.length && <Muted>No prompts waiting.</Muted>}
            {inPrep.map((t) => (
              <Link key={t.id} to={`/tasks/${t.id}`} className="flex items-center gap-2 py-1.5 text-sm hover:text-fg">
                <span className="truncate flex-1">{t.title}</span>
                <Tag tone={STAGE_TONE[t.meta.promptStage] ?? 'idle'}>{STAGE_LABEL[t.meta.promptStage] ?? t.meta.promptStage}</Tag>
              </Link>
            ))}
            <div className="eyebrow mt-4 mb-1.5">History</div>
            <ol className="space-y-2 max-h-72 overflow-auto">
              {reviews.slice(0, 40).map((e) => (
                <li key={e.seq} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    {byName.get(e.actor) && <Avatar agent={byName.get(e.actor)} size="sm" />}
                    <span className="text-fg-2 font-medium">{e.actor}</span>
                    {e.type === 'prompt.reviewed' && <StatusChip value={e.payload.decision === 'approve' ? 'approved' : 'changes-requested'} />}
                    {e.type === 'prompt.drafted' && <Tag>draft {Number(e.payload.revision) + 1}</Tag>}
                    {e.type === 'prompt.review.skipped' && <Tag tone="warn">review skipped</Tag>}
                    <span className="ml-auto text-fg-4 num">{fmtAgo(e.ts)}</span>
                  </div>
                  <div className="text-fg-3 mt-0.5 pl-7">
                    <Link to={`/tasks/${e.payload.taskId}`} className="hover:text-fg">{title(e.payload.taskId)}</Link>
                    {e.payload.notes ? <> — {e.payload.notes}</> : e.payload.rationale ? <> — {e.payload.rationale}</> : e.payload.reason ? <> — {e.payload.reason}</> : null}
                  </div>
                </li>
              ))}
              {!reviews.length && <Muted>No prompt reviews yet.</Muted>}
            </ol>
          </Panel>

          <Panel title="Model switches & fallbacks">
            <ol className="space-y-2 max-h-64 overflow-auto">
              {switches.slice(0, 40).map((e) => (
                <li key={e.seq} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <Tag tone={e.type === 'fallback.exhausted' ? 'bad' : e.type === 'quota.blocked' ? 'warn' : 'info'}>{e.type === 'model.switched' ? 'switched' : e.type === 'quota.blocked' ? 'quota' : 'all failed'}</Tag>
                    <span className="text-fg-2">{e.payload.agent ?? e.payload.accountId}</span>
                    <span className="ml-auto text-fg-4 num">{fmtAgo(e.ts)}</span>
                  </div>
                  <div className="text-fg-3 mt-0.5 break-words">
                    {e.type === 'model.switched' && <><span className="mono">{e.payload.from}</span> → <span className="mono">{e.payload.to}</span> · {e.payload.reason}</>}
                    {e.type === 'fallback.exhausted' && (e.payload.tried ?? []).join('; ')}
                    {e.type === 'quota.blocked' && <>{e.payload.metric} exhausted{e.payload.resetsAt ? ` · resets ${new Date(e.payload.resetsAt).toLocaleTimeString()}` : ' · reset time unknown'}{e.payload.estimated ? ' (estimate)' : ''}</>}
                  </div>
                </li>
              ))}
              {!switches.length && <Muted>No switches — every call ran on the agent's primary model.</Muted>}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}
