import React, { useState } from 'react';
import { del, post, put, useQuery } from './api';
import { Modal, Muted, Panel, Tag, act, fmtAgo, toast } from './components';
import { Select } from './Select';
import { Download, Plus, Trash2 } from 'lucide-react';

// CLI sessions. A headless CLI agent (Claude Code, cursor-agent, Devin) starts a brand-new conversation for every
// run unless it is told to continue one. Each CLI agent can keep using one session across tasks; these are the
// per-agent settings (shown in the agent's settings drawer) and the manager for the sessions themselves.

export interface CliSessionSettings { mode: 'reuse' | 'new' | 'pinned'; pinnedId: string | null; whenBusy: 'new' | 'wait'; rotateAfter: number }
export const DEFAULT_SESSION: CliSessionSettings = { mode: 'reuse', pinnedId: null, whenBusy: 'wait', rotateAfter: 0 };

export interface SessionRow {
  id: string; accountId: string | null; preset: string; agentId: string | null; agentName: string | null; label: string; cwd: string;
  externalId: string | null; started: boolean; status: 'active' | 'archived'; busyItem: string | null; uses: number;
  createdAt: string; lastUsedAt: string | null; note: string;
  nodeKey: string | null; nodeLabel: string | null;
}
export interface BackendInfo { accountId: string; label: string; preset: string; supported: boolean; canImport: boolean; idFrom: string | null }
export interface SessionData { sessions: SessionRow[]; backends: BackendInfo[] }

export function useCliSessions() { return useQuery<SessionData>('/cli-sessions?archived=1'); }

export const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/') || p;
const sessionTitle = (s: SessionRow) => s.label || s.externalId || s.id.slice(-6);

const MODES: { v: CliSessionSettings['mode']; title: string; body: string; tag?: string }[] = [
  { v: 'reuse', title: 'One session per workflow node', tag: 'recommended', body: 'Each node this agent works on keeps its own session across tasks, retries and loops, so the CLI remembers earlier work. A new one starts only for a new node or when you reset it.' },
  { v: 'new', title: 'New session every time', body: 'A fresh session for each task. Nothing carries over, and a session is left behind each time.' },
  { v: 'pinned', title: 'Always one chosen session', body: 'Use one specific session you pick (for example one you started yourself). It then belongs to this agent only.' },
];

/** The agent-level controls: how it uses sessions, what to do when its session is busy, and when to rotate. */
export function SessionSettings({ value, onChange, backend, accountId, data }: {
  value: CliSessionSettings; onChange: (v: CliSessionSettings) => void; backend?: BackendInfo; accountId: string | null; data: SessionData | null;
}) {
  const set = (p: Partial<CliSessionSettings>) => onChange({ ...value, ...p });
  const supported = backend?.supported ?? false;
  const pinnable = (data?.sessions ?? []).filter((s) => s.status === 'active' && s.accountId === accountId);
  return (
    <section className="space-y-3.5">
      <h3 className="eyebrow">CLI sessions</h3>
      <p className="text-xs text-fg-3">The CLI starts a new conversation on every run unless told to continue one. Choose how this agent uses sessions.</p>
      {!supported && (
        <p className="text-xs text-fg-3 rounded-lg border border-line bg-sunken/50 px-3 py-2">
          {backend ? `Oficina doesn't know how to continue a session with this backend yet, so every task starts fresh. Add resume arguments to it on the Providers page to turn session reuse on.` : 'Pick a CLI backend first.'}
        </p>
      )}
      <div role="radiogroup" aria-label="Session mode" className={`grid gap-2 ${supported ? '' : 'opacity-50 pointer-events-none'}`}>
        {MODES.map((m) => (
          <button key={m.v} type="button" role="radio" aria-checked={value.mode === m.v} onClick={() => set({ mode: m.v })}
            className={`text-left rounded-xl border px-3.5 py-2.5 transition-colors ${value.mode === m.v ? 'border-fg bg-raised' : 'border-line hover:border-line-strong'}`}>
            <span className="flex items-center gap-2 text-sm font-medium text-fg">{m.title}{m.tag && <Tag tone="ok">{m.tag}</Tag>}</span>
            <span className="block text-xs text-fg-3 mt-0.5">{m.body}</span>
          </button>
        ))}
      </div>

      {supported && value.mode === 'pinned' && (
        <label className="block">
          <span className="field-label">Session to use</span>
          <Select className="input w-full" value={value.pinnedId ?? ''} onChange={(e) => set({ pinnedId: e.target.value || null })}>
            <option value="">choose a session…</option>
            {pinnable.map((s) => <option key={s.id} value={s.id}>{sessionTitle(s)} · {shortPath(s.cwd)}{s.agentName ? ` · ${s.agentName}` : ''}</option>)}
          </Select>
          {!pinnable.length && <span className="text-2xs text-fg-4 mt-1 block">No sessions on this backend yet. Create one in the CLI sessions list below, or let an agent start one first.</span>}
        </label>
      )}

      {supported && value.mode !== 'new' && (
        <>
          <p className="text-2xs text-fg-4">When the session is busy (another task of this node, or you have it open in a terminal) the task waits its turn: there is never a second conversation for the same node.</p>
          {value.mode === 'reuse' && (
            <label className="block">
              <span className="field-label">Start a fresh session after</span>
              <div className="flex items-center gap-2">
                <input className="input w-24 num" type="number" min={0} max={1000} value={value.rotateAfter} onChange={(e) => set({ rotateAfter: Math.max(0, Math.min(1000, Math.round(Number(e.target.value) || 0))) })} />
                <span className="text-xs text-fg-3">tasks {value.rotateAfter === 0 && <span className="text-fg-4">(never — recommended)</span>}</span>
              </div>
              <span className="text-2xs text-fg-4 mt-1 block">Leave at 0 to keep one conversation per node. Set a number only if you want the session retired after that many tasks.</span>
            </label>
          )}
          <p className="text-2xs text-fg-4">Sessions are kept per folder: tasks that run in their own isolated worktree can't continue an earlier session, so they start fresh.</p>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------

export function SessionsPanel({ agents, repoPath, data, reload }: {
  agents: any[]; repoPath: string | null; data: SessionData | null; reload: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const ids = new Set(agents.map((a) => a.id));
  const cliAgentIds = new Set(agents.filter((a) => data?.backends.some((b) => b.accountId === a.accountId)).map((a) => a.id));
  const rows = (data?.sessions ?? []).filter((s) => (s.agentId ? ids.has(s.agentId) : true) && (showArchived || s.status === 'active'));
  const archivedCount = (data?.sessions ?? []).filter((s) => s.status === 'archived' && (s.agentId ? ids.has(s.agentId) : true)).length;
  const canImport = (data?.backends ?? []).some((b) => b.canImport);
  if (!data?.backends.length) return null;

  const chip = (s: SessionRow) => s.status === 'archived' ? <Tag tone="idle">archived</Tag> : s.busyItem?.startsWith('terminal:') ? <Tag tone="warn">open in terminal</Tag> : s.busyItem ? <Tag tone="info">in use</Tag> : s.started ? <Tag tone="ok">ready</Tag> : <Tag tone="idle">not started</Tag>;
  const patch = async (id: string, body: Record<string, unknown>, msg?: string) => { if (await act(put(`/cli-sessions/${id}`, body), msg)) reload(); };

  return (
    <div className="mt-8">
      <Panel title={<>CLI sessions{rows.length > 0 && <span className="ml-2 text-fg-4 num">{rows.length}</span>}</>}
        action={<div className="flex items-center gap-1.5">
          {canImport && <button className="btn btn-xs" onClick={() => setImporting(true)}><Download size={11} /> Import</button>}
          <button className="btn btn-xs" onClick={() => setCreating(true)} disabled={!cliAgentIds.size}><Plus size={11} /> New session</button>
        </div>}
        bodyClass="px-4 pb-4">
        <p className="text-xs text-fg-3 mb-3 max-w-[78ch]">
          The conversations your CLI agents work in: one per workflow node and agent, continued across tasks, retries and loops. Click a session to see its work and conversation, or open it in a terminal to continue it yourself.
          Removing one here only forgets it in Oficina; the CLI keeps its own copy.
        </p>
        {rows.length === 0 && <Muted>No sessions yet. An agent's first task creates one, or press New session.</Muted>}
        {rows.length > 0 && (
          <div className="overflow-x-auto -mx-1 px-1">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="text-left text-2xs text-fg-4 border-b border-line">
                  <th className="font-medium py-2 pr-3">Session</th>
                  <th className="font-medium px-3">Node</th>
                  <th className="font-medium px-3">Assigned to</th>
                  <th className="font-medium px-3 text-right">Tasks</th>
                  <th className="font-medium px-3">Last used</th>
                  <th className="font-medium px-3">State</th>
                  <th className="w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((s) => (
                  <tr key={s.id} className={s.status === 'archived' ? 'opacity-60' : ''}>
                    <td className="py-2 pr-3 min-w-0">
                      <input className="bg-transparent text-fg font-medium w-full max-w-[24ch] rounded px-1 -mx-1 hover:bg-raised focus:bg-raised outline-none truncate" defaultValue={sessionTitle(s)} aria-label="Session name"
                        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== sessionTitle(s)) void patch(s.id, { label: v }); }} />
                      <button type="button" className="block text-2xs text-fg-4 mono truncate max-w-[34ch] hover:text-fg-2 hover:underline text-left" onClick={() => setOpen(s.id)}
                        title={`Show this session\n${s.cwd}${s.externalId ? `\n${s.externalId}` : ''}${s.note ? `\n${s.note}` : ''}`}>{s.preset} · {shortPath(s.cwd)}{s.externalId ? ` · ${s.externalId.slice(0, 8)}` : ''}</button>
                    </td>
                    <td className="px-3 text-xs text-fg-2 whitespace-nowrap">{s.nodeLabel ?? <span className="text-fg-4">—</span>}</td>
                    <td className="px-3">
                      <Select className="input input-sm !w-44" value={s.agentId ?? ''} disabled={!!s.busyItem || s.status === 'archived'} aria-label="Assign to agent"
                        title={s.busyItem ? 'In use right now' : 'Which agent uses this session'}
                        onChange={(e) => void patch(s.id, { agentId: e.target.value || null }, e.target.value ? 'Session assigned' : 'Session unassigned')}>
                        <option value="">Unassigned</option>
                        {/* the assigned agent is always listed, even after it moved to a non-CLI backend, so the choice never shows blank */}
                        {agents.filter((a) => cliAgentIds.has(a.id) || a.id === s.agentId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </Select>
                    </td>
                    <td className="px-3 text-right num text-fg-2">{s.uses}</td>
                    <td className="px-3 text-xs text-fg-3 whitespace-nowrap">{s.lastUsedAt ? fmtAgo(s.lastUsedAt) : 'never'}</td>
                    <td className="px-3">{chip(s)}</td>
                    <td className="text-right whitespace-nowrap">
                      <button className="btn btn-ghost btn-xs" onClick={() => setOpen(s.id)}>Details</button>
                      <button className="btn btn-ghost btn-xs" disabled={!!s.busyItem} onClick={() => void patch(s.id, { status: s.status === 'archived' ? 'active' : 'archived' })}>{s.status === 'archived' ? 'Restore' : 'Archive'}</button>
                      <button className="btn btn-ghost btn-xs btn-icon hover:!text-bad" disabled={!!s.busyItem} aria-label="Remove" title="Forget this session in Oficina"
                        onClick={async () => { if (confirm(`Forget “${sessionTitle(s)}” in Oficina? The CLI keeps its own copy.`) && (await act(del(`/cli-sessions/${s.id}`), 'Session removed'))) reload(); }}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {archivedCount > 0 && (
          <label className="mt-3 flex items-center gap-2 text-xs text-fg-3 cursor-pointer">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show {archivedCount} archived (retired after their task limit, or no longer known to the CLI)
          </label>
        )}
      </Panel>

      {open && <SessionDetailsDialog id={open} onClose={() => { setOpen(null); reload(); }} />}
      {creating && <NewSessionDialog agents={agents.filter((a) => cliAgentIds.has(a.id))} repoPath={repoPath} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {importing && <ImportDialog backends={(data?.backends ?? []).filter((b) => b.canImport)} repoPath={repoPath} onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
    </div>
  );
}

function NewSessionDialog({ agents, repoPath, onClose, onDone }: { agents: any[]; repoPath: string | null; onClose: () => void; onDone: () => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [cwd, setCwd] = useState(repoPath ?? '');
  return (
    <Modal title="New session" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!agentId || !cwd.trim()} onClick={async () => { if (await act(post('/cli-sessions', { agentId, label: label.trim() || undefined, cwd: cwd.trim() }), 'Session created')) onDone(); }}>Create session</button>
    </>}>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">A session for an agent, ready ahead of time. It starts a fresh conversation the first time it is used, and the agent's next node that has no session yet takes it. To start an existing node over, use Reset in that session's details instead.</p>
        <label className="block"><span className="field-label">Assign to</span>
          <Select className="input w-full" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        </label>
        <label className="block"><span className="field-label">Name <span className="text-fg-4 font-normal normal-case tracking-normal">(optional)</span></span>
          <input className="input w-full" placeholder="e.g. Docs work" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="block"><span className="field-label">Folder it works in</span>
          <input className="input w-full font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          <span className="text-2xs text-fg-4 mt-1 block">A CLI can only continue a session from the folder that started it, so use the repository the agent works on.</span>
        </label>
      </div>
    </Modal>
  );
}

function ImportDialog({ backends, repoPath, onClose, onDone }: { backends: BackendInfo[]; repoPath: string | null; onClose: () => void; onDone: () => void }) {
  const [accountId, setAccountId] = useState(backends[0]?.accountId ?? '');
  const [cwd, setCwd] = useState(repoPath ?? '');
  return (
    <Modal title="Import existing sessions" onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!accountId || !cwd.trim()} onClick={async () => {
        const r = await act(post<{ added: number; skipped: number }>('/cli-sessions/import', { accountId, cwd: cwd.trim() }));
        if (r) { toastImported(r.added); onDone(); }
      }}>Import</button>
    </>}>
      <div className="space-y-4">
        <p className="text-sm text-fg-2">Add the sessions this CLI already has for a folder, for example ones you started yourself. They arrive unassigned: give them to an agent, or let the first agent that needs one claim it.</p>
        <label className="block"><span className="field-label">Backend</span>
          <Select className="input w-full" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {backends.map((b) => <option key={b.accountId} value={b.accountId}>{b.label}</option>)}
          </Select>
        </label>
        <label className="block"><span className="field-label">Folder</span>
          <input className="input w-full font-mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

interface SessionDetails {
  session: SessionRow & { backend: string | null; provider: string | null };
  resumeCommand: string | null; canOpen: boolean; whyNot: string | null;
  work: { id: string; kind: string; status: string; task: string | null; startedAt: string | null; prompt: string; reply: string }[];
  transcript: { source: string; turns: { role: string; text: string; at: string | null }[]; total: number } | null;
}

/** One session: who uses it for which node, what it did, its conversation, and a way into it from a terminal. */
function SessionDetailsDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { data: d, reload } = useQuery<SessionDetails>(`/cli-sessions/${id}`, [id]);
  const [tab, setTab] = useState<'conversation' | 'work'>('conversation');
  const s = d?.session;
  const row = (k: string, v: React.ReactNode) => <div className="flex gap-3 py-1 text-sm"><span className="w-28 shrink-0 text-fg-4 text-xs pt-0.5">{k}</span><span className="min-w-0 break-words text-fg-2">{v}</span></div>;
  return (
    <Modal title={s ? sessionTitle(s) : 'Session'} onClose={onClose} width="max-w-3xl" footer={<>
      {s && s.status === 'active' && <button className="btn btn-ghost" disabled={!!s.busyItem}
        title={s.busyItem ? 'In use right now' : 'Archive this conversation; the node starts a new one next time'}
        onClick={async () => { if (confirm(`Start “${sessionTitle(s)}” over? Its node's next work begins a new conversation; this one is kept, archived.`) && await act(post(`/cli-sessions/${id}/reset`, {}), 'Session reset')) reload(); }}>Reset</button>}
      <button className="btn btn-ghost" onClick={onClose}>Close</button>
      <button className="btn btn-primary" disabled={!d?.canOpen} title={d?.whyNot ?? 'Continue this exact conversation in a terminal window'}
        onClick={async () => { if (await act(post(`/cli-sessions/${id}/open`, {}), 'Opened in a terminal — the agent waits until you close it')) reload(); }}>Open in terminal</button>
    </>}>
      {!d || !s ? <Muted>Loading…</Muted> : (
        <div className="space-y-4">
          <div className="rounded-xl border border-line px-3.5 py-2">
            {row('Node', s.nodeLabel ?? 'standard pipeline')}
            {row('Agent', s.agentName ?? 'unassigned')}
            {row('Backend', `${s.backend ?? s.accountId ?? '?'}${s.provider && s.provider !== s.backend ? ` (${s.provider})` : ''} · ${s.preset}`)}
            {row('Session id', <span className="mono text-xs">{s.externalId ?? 'not known yet'}</span>)}
            {row('Folder', <span className="mono text-xs">{s.cwd}</span>)}
            {row('Status', <>{s.status}{s.busyItem ? (s.busyItem.startsWith('terminal:') ? ' · open in a terminal' : ' · in use by a work item') : ''} · {s.uses} task{s.uses === 1 ? '' : 's'} · last used {s.lastUsedAt ? fmtAgo(s.lastUsedAt) : 'never'}{s.note ? ` · ${s.note}` : ''}</>)}
            {d.resumeCommand && row('Resume', <span className="mono text-xs select-all">{d.resumeCommand}</span>)}
            {!d.canOpen && d.whyNot && row('Terminal', <span className="text-fg-3">{d.whyNot}</span>)}
          </div>
          <div className="flex gap-1.5">
            {(['conversation', 'work'] as const).map((t) => <button key={t} className={`btn btn-xs ${tab === t ? 'btn-primary' : ''}`} onClick={() => setTab(t)}>{t === 'conversation' ? 'Conversation' : `Work (${d.work.length})`}</button>)}
          </div>
          {tab === 'conversation' && (d.transcript ? (
            <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
              {d.transcript.total > d.transcript.turns.length && <Muted>Showing the last {d.transcript.turns.length} of {d.transcript.total} messages.</Muted>}
              {d.transcript.turns.map((t, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 text-xs whitespace-pre-wrap break-words ${t.role === 'user' ? 'bg-sunken/60' : 'border border-line'}`}>
                  <div className="text-2xs text-fg-4 mb-0.5">{t.role}{t.at ? ` · ${fmtAgo(t.at)}` : ''}</div>{t.text}
                </div>
              ))}
            </div>
          ) : <Muted>{s.preset === 'claude' ? "Claude Code's transcript for this session isn't on this machine yet." : 'This CLI keeps its conversation in its own format; the Work tab shows what Oficina sent and what came back.'}</Muted>)}
          {tab === 'work' && (d.work.length ? (
            <div className="space-y-2 max-h-[46vh] overflow-y-auto pr-1">
              {d.work.map((w) => (
                <details key={w.id} className="rounded-lg border border-line px-3 py-2 text-xs">
                  <summary className="cursor-pointer text-fg-2"><span className="font-medium">{w.kind}</span>{w.task ? ` · ${w.task}` : ''} · {w.status}{w.startedAt ? ` · ${fmtAgo(w.startedAt)}` : ''}</summary>
                  <div className="mt-2 text-2xs text-fg-4">Prompt</div><pre className="whitespace-pre-wrap break-words text-fg-3">{w.prompt || '—'}</pre>
                  <div className="mt-2 text-2xs text-fg-4">Reply</div><pre className="whitespace-pre-wrap break-words text-fg-3">{w.reply || '—'}</pre>
                </details>
              ))}
            </div>
          ) : <Muted>No work recorded in this session yet.</Muted>)}
        </div>
      )}
    </Modal>
  );
}

const toastImported = (n: number) => toast(n ? `Imported ${n} session${n === 1 ? '' : 's'}` : 'Nothing new to import', n ? 'ok' : 'info');
