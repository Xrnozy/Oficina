import { Select } from '../Select';
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, useEvents, useFetch, useQuery } from '../api';
import { Drawer, Empty, Modal, Muted, PageHeader, Panel, StatusChip, Tag, act, fmtAgo, useCurrentRun, type Tone } from '../components';
import { DiffView } from '../diff';
import {
  AlertTriangle, Bookmark, CheckCircle2, GitBranch, GitCommitHorizontal, GitCompare, History as HistoryIcon, ListChecks,
  Redo2, RotateCcw, Save, Undo2, User, XCircle,
} from 'lucide-react';

// Checkpoints (general = a whole task, agent = one agent's work, manual =
// a save point) with Undo / Redo / Restore / Compare, and the Repository
// Timeline built from git history, checkpoints, undo/redo operations and
// task events. Every operation is previewed — exact files and lines, any
// conflicts or dependent work — before it is confirmed.

const KIND_LABEL: Record<string, string> = { general: 'General Checkpoint', agent: 'Agent Checkpoint', manual: 'Manual Checkpoint' };
const KIND_TONE: Record<string, Tone> = { general: 'info', agent: 'ok', manual: 'idle' };

function useRepo() {
  const { run } = useCurrentRun();
  const { data: repos } = useQuery<any[]>('/repos');
  const [repoId, setRepoId] = useState<string>('');
  useEffect(() => { if (!repoId && repos?.length) setRepoId(run?.repoId ?? repos[0].id); }, [repos, run?.repoId]); // eslint-disable-line react-hooks/exhaustive-deps
  const picker = (
    <Select className="input input-sm max-w-[22rem]" value={repoId} onChange={(e) => setRepoId(e.target.value)} aria-label="Repository">
      {(repos ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.path}</option>)}
    </Select>
  );
  return { repoId, picker };
}

// ------------------------------------------------------------ preview + confirm

function OperationModal({ checkpointId, op, onClose, onDone }: { checkpointId: string; op: 'undo' | 'redo' | 'restore'; onClose: () => void; onDone: () => void }) {
  const { data: pv, error } = useFetch<any>(`/checkpoints/${checkpointId}/preview?op=${op}`, [checkpointId, op]);
  const [busy, setBusy] = useState(false);
  const verb = op === 'undo' ? 'Undo' : op === 'redo' ? 'Redo' : 'Restore';
  return (
    <Modal width="max-w-4xl" title={`${verb}: ${pv?.checkpoint?.label ?? ''}`} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!pv?.allowed || busy} onClick={async () => {
        setBusy(true);
        try {
          const r = await post(`/checkpoints/${checkpointId}/${op}`, {});
          act(Promise.resolve(r), r.message);
          onDone();
        } catch (e) { act(Promise.reject(e), ''); }
        setBusy(false);
      }}>{busy ? 'Working…' : `${verb} ${pv?.files?.length ?? 0} file(s)`}</button>
    </>}>
      {error && <div className="text-sm text-bad">{error}</div>}
      {!pv && !error && <Muted>Checking what this would change…</Muted>}
      {pv && (
        <div className="space-y-3 text-sm">
          <p className="text-fg-3">
            {op === 'undo' && 'Reverses exactly the changes recorded in this checkpoint. Everything else in the working tree — your own edits, other agents\' work — stays as it is.'}
            {op === 'redo' && 'Re-applies the recorded result. Nothing is re-run and no model is called.'}
            {op === 'restore' && 'Makes the working tree match this checkpoint. The current state is saved as a checkpoint first, so you can come back.'}
          </p>
          {pv.allowed ? <div className="flex items-center gap-2 text-ok"><CheckCircle2 size={15} /> Safe — applies cleanly.</div>
            : <div className="rounded-lg border border-bad/30 bg-bad/[0.06] p-3 text-bad">
              <div className="flex items-center gap-2 font-medium"><XCircle size={15} /> Not possible: {pv.reason ?? pv.check?.message}</div>
              {(pv.check?.conflicts ?? []).length > 0 && <ul className="mt-1.5 ml-6 text-xs space-y-0.5">{pv.check.conflicts.map((c: any, i: number) => <li key={i}><span className="mono">{c.path}</span> — {c.reason}</li>)}</ul>}
              <div className="mt-1.5 text-xs text-fg-3">Nothing was changed. Undo later work first (see below), or edit the files yourself.</div>
            </div>}
          {(pv.dependents ?? []).length > 0 && (
            <div className="rounded-lg border border-warn/30 bg-warn/[0.06] p-3 text-xs">
              <div className="flex items-center gap-2 text-warn font-medium"><AlertTriangle size={14} /> Later work touches the same files</div>
              <ul className="mt-1 ml-6 space-y-0.5">{pv.dependents.map((d: any) => <li key={d.id}>{d.label} — <span className="mono">{d.files.join(', ')}</span></li>)}</ul>
            </div>
          )}
          <div className="eyebrow">Files and lines affected</div>
          <DiffView diff={pv.diff} empty="No file changes." />
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------ checkpoint detail

export function CheckpointDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged?: () => void }) {
  const { data, reload } = useFetch<any>(`/checkpoints/${id}`, [id]);
  const [op, setOp] = useState<'undo' | 'redo' | 'restore' | null>(null);
  const cp = data?.checkpoint;
  return (
    <Drawer title={<><Bookmark size={15} /><span className="text-[15px] font-semibold truncate">{cp?.label ?? 'Checkpoint'}</span></>} onClose={onClose}
      footer={cp && <div className="flex items-center gap-2 flex-wrap">
        <Tag tone={KIND_TONE[cp.kind]}>{KIND_LABEL[cp.kind]}</Tag><StatusChip value={cp.status} />
        <div className="flex-1" />
        {cp.kind !== 'manual' && cp.status !== 'undone' && <button className="btn btn-sm" onClick={() => setOp('undo')}><Undo2 size={13} /> Undo</button>}
        {cp.kind !== 'manual' && cp.status === 'undone' && <button className="btn btn-sm" onClick={() => setOp('redo')}><Redo2 size={13} /> Redo</button>}
        <button className="btn btn-sm" onClick={() => setOp('restore')}><RotateCcw size={13} /> Restore</button>
      </div>}>
      {!data && <Muted>Loading…</Muted>}
      {cp && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
            <dt className="text-fg-4">Type</dt><dd>{KIND_LABEL[cp.kind]}{cp.kind === 'general' ? ' — the whole task result' : cp.kind === 'agent' ? ' — one agent\'s work' : ''}</dd>
            {cp.taskTitle && <><dt className="text-fg-4">Task</dt><dd><Link className="underline" to={`/tasks/${cp.taskId}`}>{cp.taskTitle}</Link></dd></>}
            {cp.agentName && <><dt className="text-fg-4">Agent</dt><dd>{cp.agentName}</dd></>}
            <dt className="text-fg-4">Created</dt><dd>{new Date(cp.createdAt).toLocaleString()}</dd>
            {cp.completedAt && <><dt className="text-fg-4">Finished</dt><dd>{new Date(cp.completedAt).toLocaleString()}</dd></>}
            {cp.commitSha && <><dt className="text-fg-4">Commit</dt><dd className="mono">{cp.commitSha.slice(0, 10)}</dd></>}
            <dt className="text-fg-4">Snapshot</dt><dd className="mono text-fg-3">{cp.beforeTree.slice(0, 10)} → {(cp.afterTree ?? 'open').slice(0, 10)}</dd>
          </dl>
          {data.parent && <div className="text-xs">Part of <button className="underline" onClick={() => onClose()}>{data.parent.label}</button> (General Checkpoint)</div>}
          {(data.dependents ?? []).length > 0 && <div className="text-xs text-warn flex gap-1.5"><AlertTriangle size={13} className="shrink-0 mt-0.5" /> Later work depends on these files: {data.dependents.map((d: any) => d.label).join('; ')}</div>}
          {data.prompt && <details className="text-xs"><summary className="cursor-pointer text-fg-3">Originating prompt / request</summary><pre className="mt-1 p-2 rounded-md bg-sunken border border-line whitespace-pre-wrap max-h-72 overflow-auto">{data.prompt}</pre></details>}
          {(data.children ?? []).length > 0 && (
            <div>
              <div className="eyebrow mb-1">Agent checkpoints in this task</div>
              <ul className="space-y-1">{data.children.map((c: any) => (
                <li key={c.id} className="flex items-center gap-2 text-xs"><StatusChip value={c.status} /><span className="truncate">{c.label}</span><span className="ml-auto text-fg-4">{c.files.length} file(s)</span></li>
              ))}</ul>
            </div>
          )}
          <div>
            <div className="eyebrow mb-1">What changed</div>
            <DiffView diff={data.diff} empty="This checkpoint changed no files." />
          </div>
          {(data.ops ?? []).length > 0 && (
            <div>
              <div className="eyebrow mb-1">History</div>
              <ul className="space-y-0.5 text-xs">{data.ops.map((o: any) => <li key={o.id} className={o.ok ? 'text-fg-3' : 'text-bad'}>{new Date(o.at).toLocaleString()} · {o.op} {o.ok ? 'done' : 'refused'} — {o.detail}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {op && <OperationModal checkpointId={id} op={op} onClose={() => setOp(null)} onDone={() => { setOp(null); reload(); onChanged?.(); }} />}
    </Drawer>
  );
}

function CompareModal({ a, b, onClose }: { a: string; b: string; onClose: () => void }) {
  const [as, setAs] = useState<'before' | 'after'>('after');
  const [bs, setBs] = useState<'before' | 'after'>('after');
  const { data, error } = useFetch<any>(`/checkpoints/compare?a=${a}&as=${as}&b=${b}&bs=${bs}`, [a, b, as, bs]);
  const side = (v: string, set: (s: any) => void) => <Select className="input input-sm" value={v} onChange={(e) => set(e.target.value)}><option value="before">before</option><option value="after">after</option></Select>;
  return (
    <Modal width="max-w-4xl" title="Compare checkpoints" onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <div className="flex items-center gap-2 text-xs mb-3 flex-wrap">First {side(as, setAs)} <GitCompare size={13} /> second {side(bs, setBs)}</div>
      {error ? <div className="text-bad text-sm">{error}</div> : <DiffView diff={data?.diff ?? ''} empty="The two states are identical." />}
    </Modal>
  );
}

// ------------------------------------------------------------ Checkpoints page

export function Checkpoints() {
  const { repoId, picker } = useRepo();
  const { data: agents } = useQuery<any[]>('/agents');
  const [kind, setKind] = useState('');
  const [agentId, setAgentId] = useState('');
  const [file, setFile] = useState('');
  const [since, setSince] = useState('');
  const qs = new URLSearchParams({ repoId, limit: '200', ...(kind ? { kind } : {}), ...(agentId ? { agentId } : {}), ...(file ? { file } : {}), ...(since ? { since } : {}) }).toString();
  const { data: cps, reload } = useQuery<any[]>(repoId ? `/checkpoints?${qs}` : null, [qs]);
  const { data: ur, reload: reloadUr } = useQuery<any>(repoId ? `/repos/${repoId}/undo-redo` : null, [repoId]);
  const { data: status } = useFetch<any>(repoId ? `/repos/${repoId}/status` : null, [repoId]);
  const [open, setOpen] = useState<string | null>(null);
  const [op, setOp] = useState<{ id: string; op: 'undo' | 'redo' } | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [label, setLabel] = useState('');
  const [task, setTask] = useState('');
  useEvents((e) => { if (e.type.startsWith('checkpoint.')) { reload(); reloadUr(); } });
  const refresh = () => { reload(); reloadUr(); };
  const tasks = useMemo(() => [...new Map((cps ?? []).filter((c) => c.taskId).map((c) => [c.taskId, c.taskTitle])).entries()], [cps]);
  const rows = (cps ?? []).filter((c) => !task || c.taskId === task);
  const generals = rows.filter((c) => c.kind !== 'agent' || !rows.some((g) => g.id === c.parentId));
  const togglePick = (id: string) => setPick((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]);

  return (
    <div className="space-y-5">
      <PageHeader title="Checkpoints" sub="Every task records a General Checkpoint (its whole result) and an Agent Checkpoint for each agent's work. Undo or redo either — your own edits and other agents' work are kept.">
        {picker}
      </PageHeader>
      {status && !status.git && <Empty icon={GitBranch} title="Not a git repository" text="Checkpoints need git; the folder is initialised when you add it as a repository." />}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_20rem] gap-5 items-start [&>*]:min-w-0">
        <Panel title={<>History <span className="text-fg-4 font-normal num">· {rows.length}</span></>} bodyClass="pb-3"
          action={pick.length === 2 ? <button className="btn btn-sm" onClick={() => setComparing(true)}><GitCompare size={13} /> Compare</button> : <span className="text-2xs text-fg-4">tick two to compare</span>}>
          <div className="px-4 pb-3 flex flex-wrap gap-2">
            <Select className="input input-sm" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type"><option value="">all types</option><option value="general">General</option><option value="agent">Agent</option><option value="manual">Manual</option></Select>
            <Select className="input input-sm" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task"><option value="">all tasks</option>{tasks.map(([id, t]) => <option key={id} value={id}>{t ?? id}</option>)}</Select>
            <Select className="input input-sm" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent"><option value="">all agents</option>{(agents ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>
            <input className="input input-sm w-40" placeholder="file path…" value={file} onChange={(e) => setFile(e.target.value)} />
            <input className="input input-sm" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Since" />
          </div>
          {!rows.length && <div className="px-4"><Muted>No checkpoints yet — they are recorded as tasks work in this repository, or create one manually.</Muted></div>}
          <ol className="divide-line">
            {generals.map((c) => (
              <li key={c.id}>
                <CheckpointRow c={c} picked={pick.includes(c.id)} onPick={togglePick} onOpen={setOpen} />
                {rows.filter((k) => k.parentId === c.id).map((k) => <div key={k.id} className="pl-7 border-l border-line ml-6"><CheckpointRow c={k} picked={pick.includes(k.id)} onPick={togglePick} onOpen={setOpen} /></div>)}
              </li>
            ))}
          </ol>
        </Panel>

        <div className="space-y-5">
          <Panel title="Undo / Redo a task">
            <div className="space-y-2 text-sm">
              <button className="btn w-full justify-start" disabled={!ur?.undo} onClick={() => ur?.undo && setOp({ id: ur.undo.id, op: 'undo' })}><Undo2 size={14} /> Undo {ur?.undo ? <span className="truncate text-fg-3">“{ur.undo.label}”</span> : <span className="text-fg-4">— nothing to undo</span>}</button>
              <button className="btn w-full justify-start" disabled={!ur?.redo} onClick={() => ur?.redo && setOp({ id: ur.redo.id, op: 'redo' })}><Redo2 size={14} /> Redo {ur?.redo ? <span className="truncate text-fg-3">“{ur.redo.label}”</span> : <span className="text-fg-4">— nothing to redo</span>}</button>
              <p className="text-xs text-fg-4">Works across tasks: undo repeatedly to step back through earlier task results.</p>
            </div>
          </Panel>
          <Panel title="Save a checkpoint">
            <form className="flex gap-2" onSubmit={async (e) => {
              e.preventDefault();
              if (await act(post(`/repos/${repoId}/checkpoints`, { label: label.trim() }), 'Checkpoint saved')) { setLabel(''); refresh(); }
            }}>
              <input className="input input-sm flex-1" placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button className="btn btn-sm btn-primary" disabled={!repoId}><Save size={13} /> Save</button>
            </form>
            <p className="text-xs text-fg-4 mt-2">Captures the whole working tree now, including untracked files (not ignored ones). Restore it any time.</p>
          </Panel>
          {status?.git && (
            <Panel title="Working tree">
              <div className="text-xs space-y-1">
                <div>Branch <span className="mono">{status.branch ?? '(detached)'}</span></div>
                {status.working && <div className="text-info">Task working now: {status.working.label}</div>}
                <div className="text-fg-3">{status.dirty.length ? `${status.dirty.length} uncommitted file(s)` : 'clean'}</div>
              </div>
            </Panel>
          )}
        </div>
      </div>
      {open && <CheckpointDrawer id={open} onClose={() => setOpen(null)} onChanged={refresh} />}
      {op && <OperationModal checkpointId={op.id} op={op.op} onClose={() => setOp(null)} onDone={() => { setOp(null); refresh(); }} />}
      {comparing && pick.length === 2 && <CompareModal a={pick[0]} b={pick[1]} onClose={() => setComparing(false)} />}
    </div>
  );
}

function CheckpointRow({ c, picked, onPick, onOpen }: { c: any; picked: boolean; onPick: (id: string) => void; onOpen: (id: string) => void }) {
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 hover:bg-raised/40">
      <input type="checkbox" checked={picked} onChange={() => onPick(c.id)} aria-label="Select to compare" />
      <button className="flex-1 min-w-0 text-left" onClick={() => onOpen(c.id)}>
        <div className="flex items-center gap-2 flex-wrap">
          <Tag tone={KIND_TONE[c.kind]}>{KIND_LABEL[c.kind]}</Tag>
          <span className="text-sm text-fg truncate">{c.label}</span>
          <StatusChip value={c.status} />
        </div>
        <div className="text-xs text-fg-4 mt-0.5 truncate">
          {fmtAgo(c.createdAt)}{c.agentName ? ` · ${c.agentName}` : ''} · {c.files.length} file(s){c.files.length ? `: ${c.files.slice(0, 4).map((f: any) => f.path).join(', ')}${c.files.length > 4 ? '…' : ''}` : ''}{c.commitSha ? ` · commit ${c.commitSha.slice(0, 7)}` : ''}
        </div>
      </button>
    </div>
  );
}

// ------------------------------------------------------------ Repository Timeline

const ENTRY_ICON: Record<string, React.ElementType> = {
  commit: GitCommitHorizontal, 'general-checkpoint': Bookmark, 'agent-checkpoint': Bookmark, 'manual-checkpoint': Save,
  undo: Undo2, redo: Redo2, restore: RotateCcw, task: ListChecks, request: User, event: HistoryIcon,
};
const ENTRY_LABEL: Record<string, string> = {
  commit: 'Git commit', 'general-checkpoint': 'General Checkpoint', 'agent-checkpoint': 'Agent Checkpoint', 'manual-checkpoint': 'Manual Checkpoint',
  undo: 'Undo', redo: 'Redo', restore: 'Restore', task: 'Task', request: 'Request', event: 'Event',
};

function CommitDrawer({ repoId, sha, onClose, onChanged }: { repoId: string; sha: string; onClose: () => void; onChanged: () => void }) {
  const [against, setAgainst] = useState('');
  const { data, error } = useFetch<any>(`/repos/${repoId}/commits/${sha}${against ? `?against=${against}` : ''}`, [sha, against]);
  const [confirm, setConfirm] = useState<null | 'revert' | 'reapply'>(null);
  const [check, setCheck] = useState<any>(null);
  const open = async (kind: 'revert' | 'reapply') => {
    setConfirm(kind); setCheck(null);
    try { setCheck(await post(`/repos/${repoId}/commits/${sha}/revert`, { dryRun: true, reapply: kind === 'reapply' })); }
    catch (e) { setCheck({ ok: false, message: String((e as Error).message ?? e) }); }
  };
  return (
    <Drawer title={<><GitCommitHorizontal size={15} /><span className="text-[15px] font-semibold truncate">{data?.subject ?? sha.slice(0, 10)}</span></>} onClose={onClose}
      footer={<div className="flex gap-2 justify-end">
        <button className="btn btn-sm" onClick={() => open('revert')}><Undo2 size={13} /> Revert</button>
        <button className="btn btn-sm" onClick={() => open('reapply')}><Redo2 size={13} /> Reapply</button>
      </div>}>
      {error && <div className="text-sm text-bad">{error}</div>}
      {data && (
        <div className="space-y-4 text-sm">
          <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-xs">
            <dt className="text-fg-4">Commit</dt><dd className="mono">{data.sha.slice(0, 12)}</dd>
            <dt className="text-fg-4">By</dt><dd>{data.origin === 'ai' ? `AI${data.agents?.length ? ` (${data.agents.join(', ')})` : ''} — as ${data.author}` : data.author}</dd>
            <dt className="text-fg-4">Date</dt><dd>{new Date(data.date).toLocaleString()}</dd>
            {data.task && <><dt className="text-fg-4">Task</dt><dd><Link className="underline" to={`/tasks/${data.task.id}`}>{data.task.title}</Link></dd></>}
            {data.checkpointId && <><dt className="text-fg-4">Checkpoint</dt><dd className="mono">{data.checkpointId.slice(0, 10)}</dd></>}
          </dl>
          {data.body && <pre className="text-xs whitespace-pre-wrap p-2 rounded-md bg-sunken border border-line">{data.body}</pre>}
          <div className="flex items-center gap-2 text-xs">Compare with <input className="input input-sm mono w-48" placeholder="parent (default) or a sha" value={against} onChange={(e) => setAgainst(e.target.value.trim())} /></div>
          <DiffView diff={data.diff} />
        </div>
      )}
      {confirm && (
        <Modal title={`${confirm === 'revert' ? 'Revert' : 'Reapply'} ${sha.slice(0, 8)}`} onClose={() => setConfirm(null)} footer={<>
          <button className="btn btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={!check?.ok} onClick={async () => {
            const r = await act(post(`/repos/${repoId}/commits/${sha}/revert`, { reapply: confirm === 'reapply' }), confirm === 'revert' ? 'Reverted as a new commit' : 'Reapplied as a new commit');
            if (r) { setConfirm(null); onChanged(); }
          }}>Confirm</button>
        </>}>
          <p className="text-sm text-fg-3 mb-2">{confirm === 'revert' ? 'Adds a new commit that undoes this one. History is not rewritten; nothing is force-pushed.' : 'Adds a new commit that applies this change again.'}</p>
          {!check ? <Muted>Checking…</Muted> : check.ok ? <div className="text-ok text-sm flex items-center gap-2"><CheckCircle2 size={14} /> Applies cleanly to {check.files?.length ?? 0} file(s).</div>
            : <div className="text-bad text-sm">{check.message}{(check.conflicts ?? []).map((c: any, i: number) => <div key={i} className="text-xs mono">{c.path} — {c.reason}</div>)}</div>}
        </Modal>
      )}
    </Drawer>
  );
}

export function RepoTimeline() {
  const { repoId, picker } = useRepo();
  const [entries, setEntries] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [type, setType] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [pick, setPick] = useState<any[]>([]);
  const [compare, setCompare] = useState(false);
  const load = async (before?: string) => {
    if (!repoId) return;
    const r = await get<any>(`/repos/${repoId}/timeline?limit=40${before ? `&before=${encodeURIComponent(before)}` : ''}`);
    setEntries((prev) => (before ? [...prev, ...r.entries.filter((e: any) => !prev.some((p) => p.id === e.id))] : r.entries));
    setNext(r.next);
  };
  useEffect(() => { void load(); }, [repoId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEvents((e) => { if (['commit.created', 'checkpoint.completed', 'checkpoint.undo', 'checkpoint.redo', 'checkpoint.restore', 'commit.reverted', 'commit.reapplied', 'task.status'].includes(e.type)) void load(); });
  const shown = entries.filter((e) => !type || e.type === type || (type === 'checkpoint' && e.type.endsWith('checkpoint')));
  const days = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const e of shown) { const d = new Date(e.ts).toLocaleDateString(); m.set(d, [...(m.get(d) ?? []), e]); }
    return [...m.entries()];
  }, [shown]);
  const comparable = (e: any) => e.type === 'commit' || e.type.endsWith('checkpoint');
  const togglePick = (e: any) => setPick((p) => p.some((x) => x.id === e.id) ? p.filter((x) => x.id !== e.id) : [...p.slice(-1), e]);

  return (
    <div className="space-y-5">
      <PageHeader title="Repository timeline" sub="Everything that happened to the repository: commits (yours and the AI's), checkpoints, each agent's changes, undo/redo, task results and reviews. Click an entry to see the actual change.">
        {picker}
      </PageHeader>
      <Panel title="Timeline" bodyClass="pb-3" action={<div className="flex items-center gap-2">
        {pick.length === 2 && <button className="btn btn-sm" onClick={() => setCompare(true)}><GitCompare size={13} /> Compare</button>}
        <Select className="input input-sm" value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">everything</option><option value="commit">commits</option><option value="checkpoint">checkpoints</option>
          <option value="undo">undo</option><option value="redo">redo</option><option value="task">tasks</option><option value="event">reviews & events</option>
        </Select>
      </div>}>
        {!shown.length && <div className="px-4"><Muted>Nothing recorded for this repository yet.</Muted></div>}
        {days.map(([day, list]) => (
          <div key={day}>
            <div className="px-4 pt-3 pb-1 eyebrow">{day}</div>
            <ol className="relative ml-6 border-l border-line">
              {list.map((e) => {
                const Icon = ENTRY_ICON[e.type] ?? HistoryIcon;
                const tone = e.ok === false || e.status === 'interrupted' ? 'text-bad' : e.type === 'commit' ? (e.origin === 'ai' ? 'text-accent' : 'text-fg-2') : e.type.endsWith('checkpoint') ? 'text-info' : 'text-fg-3';
                return (
                  <li key={e.id} className="relative pl-5 pr-4 py-1.5 group">
                    <span className="absolute -left-[9px] top-2.5 w-[17px] h-[17px] rounded-full bg-canvas border border-line grid place-items-center"><Icon size={10} className={tone} /></span>
                    <div className="flex items-start gap-2">
                      {comparable(e) && <input type="checkbox" className="mt-1" checked={pick.some((p) => p.id === e.id)} onChange={() => togglePick(e)} aria-label="Select to compare" />}
                      <button className="flex-1 min-w-0 text-left" onClick={() => setOpen(e)}>
                        <div className="flex items-center gap-2 flex-wrap text-sm">
                          <Tag tone={e.type === 'commit' && e.origin === 'ai' ? 'info' : 'idle'}>{e.type === 'commit' ? (e.origin === 'ai' ? 'AI commit' : 'Commit') : ENTRY_LABEL[e.type] ?? e.type}</Tag>
                          <span className="text-fg truncate group-hover:underline">{e.title}</span>
                          {e.status && <StatusChip value={e.status} />}
                        </div>
                        <div className="text-xs text-fg-4 mt-0.5">{new Date(e.ts).toLocaleTimeString()} · {e.actor}{Array.isArray(e.files) && e.files.length ? ` · ${e.files.length} file(s)` : ''}{e.sha ? ` · ${String(e.sha).slice(0, 7)}` : ''}</div>
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
        {next && <div className="px-4 pt-3"><button className="btn btn-sm" onClick={() => load(next)}>Load earlier</button></div>}
      </Panel>

      {open && (open.type === 'commit'
        ? <CommitDrawer repoId={repoId} sha={open.sha} onClose={() => setOpen(null)} onChanged={() => load()} />
        : open.checkpointId
          ? <CheckpointDrawer id={open.checkpointId} onClose={() => setOpen(null)} onChanged={() => load()} />
          : <Drawer title={<span className="text-[15px] font-semibold">{open.title}</span>} onClose={() => setOpen(null)}>
            <div className="space-y-2 text-sm">
              <div className="text-xs text-fg-4">{new Date(open.ts).toLocaleString()} · {open.actor} · {ENTRY_LABEL[open.type] ?? open.event}</div>
              {open.taskId && <Link className="btn btn-sm" to={`/tasks/${open.taskId}`}>Open the task's record</Link>}
              {open.sha && <button className="btn btn-sm" onClick={() => setOpen({ type: 'commit', sha: open.sha })}>Open commit {String(open.sha).slice(0, 7)}</button>}
              {Array.isArray(open.files) && open.files.length > 0 && <ul className="text-xs mono">{open.files.map((f: any, i: number) => <li key={i}>{typeof f === 'string' ? f : `${f.status ?? ''} ${f.path}`}</li>)}</ul>}
            </div>
          </Drawer>)}
      {compare && pick.length === 2 && (pick.every((p) => p.checkpointId && p.type !== 'commit')
        ? <CompareModal a={pick[0].checkpointId} b={pick[1].checkpointId} onClose={() => setCompare(false)} />
        : pick.every((p) => p.type === 'commit')
          ? <CommitDrawer repoId={repoId} sha={pick[0].ts > pick[1].ts ? pick[0].sha : pick[1].sha} onClose={() => setCompare(false)} onChanged={() => load()} />
          : <Modal title="Compare" onClose={() => setCompare(false)} footer={<button className="btn" onClick={() => setCompare(false)}>Close</button>}>
            <p className="text-sm text-fg-3">Pick two commits, or two checkpoints. A commit and a checkpoint are different kinds of state and are compared from their own detail views.</p>
          </Modal>)}
    </div>
  );
}
