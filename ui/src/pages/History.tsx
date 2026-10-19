import { Select } from '../Select';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, useEvents, useFetch, useQuery } from '../api';
import { Drawer, Empty, Modal, Muted, PageHeader, Panel, StatusChip, Tag, act, fmtAgo, toast, useCurrentRun, type Tone } from '../components';
import { DiffView } from '../diff';
import {
  AlertTriangle, ArrowDown, ArrowUp, Bookmark, CheckCircle2, FileEdit, GitBranch, GitCommitHorizontal, GitCompare, GitMerge, History as HistoryIcon, ListChecks,
  Redo2, RotateCcw, Save, Search, Sparkles, Undo2, User, XCircle,
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
  const run = async (partial: boolean) => {
    setBusy(true);
    try {
      const r = await post(`/checkpoints/${checkpointId}/${op}`, { partial });
      toast(r.message, r.partial ? 'warn' : 'ok');
      onDone();
    } catch (e) { toast(String((e as Error).message ?? e), 'bad'); }
    setBusy(false);
  };
  return (
    <Modal width="max-w-4xl" title={`${verb}: ${pv?.checkpoint?.label ?? ''}`} onClose={onClose} footer={<>
      <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
      {pv && !pv.allowed && pv.partialAllowed && (
        <button className="btn" disabled={busy} title="Changes the files that can be changed safely and leaves the ones that overlap your later edits exactly as they are" onClick={() => run(true)}>
          {busy ? 'Working…' : `${verb} the ${pv.files.length} safe file${pv.files.length === 1 ? '' : 's'} only`}
        </button>
      )}
      <button className="btn btn-primary" disabled={!pv?.allowed || busy} onClick={() => run(false)}>{busy ? 'Working…' : `${verb} ${pv?.files?.length ?? 0} file(s)`}</button>
    </>}>
      {error && <div className="text-sm text-bad">{error}</div>}
      {!pv && !error && <Muted>Checking what this would change…</Muted>}
      {pv && (
        <div className="space-y-3 text-sm">
          <p className="text-fg-3">
            {op === 'undo' && 'Reverses exactly the changes recorded in this checkpoint. Everything else in the working tree — your own edits, other agents\' work — stays as it is; edits you made nearby in the same file are merged, not lost.'}
            {op === 'redo' && 'Re-applies the recorded result. Nothing is re-run and no model is called.'}
            {op === 'restore' && 'Makes the working tree match this checkpoint. The current state is saved as a checkpoint first, so you can come back.'}
          </p>
          {pv.allowed ? <div className="flex items-center gap-2 text-ok"><CheckCircle2 size={15} /> Safe — {(pv.plan ?? []).some((p: any) => p.state === 'merge') ? 'applies, merging with your later edits.' : 'applies cleanly.'}</div>
            : <div className="rounded-lg border border-bad/30 bg-bad/[0.06] p-3 text-bad">
              <div className="flex items-center gap-2 font-medium"><XCircle size={15} /> Not possible as a whole: {pv.reason ?? pv.check?.message}</div>
              {(pv.check?.conflicts ?? []).length > 0 && <ul className="mt-1.5 ml-6 text-xs space-y-0.5">{pv.check.conflicts.map((c: any, i: number) => <li key={i}><span className="mono">{c.path}</span> — {c.reason}</li>)}</ul>}
              <div className="mt-1.5 text-xs text-fg-3">Nothing has been changed.{pv.partialAllowed ? ' You can still change just the files that are safe, and leave these ones exactly as they are.' : ' Undo later work first (see below), or edit the files yourself.'}</div>
            </div>}
          {(pv.plan ?? []).length > 0 && (
            <ul className="rounded-lg border border-line divide-line text-xs overflow-hidden max-h-40 overflow-auto">
              {pv.plan.map((p: any) => (
                <li key={p.path} className="flex items-center gap-2 px-3 py-1.5">
                  <span className={`w-16 shrink-0 text-2xs uppercase tracking-wide ${p.state === 'conflict' ? 'text-bad' : p.state === 'merge' ? 'text-info' : p.state === 'already' ? 'text-fg-4' : 'text-ok'}`}>{p.state === 'clean' || p.state === 'overwrite' ? 'replace' : p.state === 'merge' ? 'merge' : p.state === 'already' ? 'done' : 'blocked'}</span>
                  <span className="mono truncate flex-1" title={p.path}>{p.path}</span>
                  {p.reason && <span className="text-fg-4 truncate max-w-[55%]" title={p.reason}>{p.reason}</span>}
                </li>
              ))}
            </ul>
          )}
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
            {(cp.branch || cp.headSha) && <><dt className="text-fg-4">Taken on</dt><dd className="mono text-fg-3">{cp.branch ?? '(detached)'}{cp.headSha ? ` @ ${cp.headSha.slice(0, 7)}` : ''}{cp.fileCount != null ? ` · ${cp.fileCount} files` : ''}</dd></>}
            {(cp.skipped ?? []).length > 0 && <><dt className="text-fg-4">Not stored</dt><dd className="text-warn text-xs" title={cp.skipped.join('\n')}>{cp.skipped.length} file(s) were too large or could not be indexed by git: {cp.skipped.slice(0, 3).join(', ')}{cp.skipped.length > 3 ? '…' : ''}. Undo and restore never touch them.</dd></>}
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
  undo: Undo2, redo: Redo2, restore: RotateCcw, task: ListChecks, request: User, event: HistoryIcon, activity: GitBranch,
};
const ENTRY_LABEL: Record<string, string> = {
  commit: 'Git commit', 'general-checkpoint': 'General Checkpoint', 'agent-checkpoint': 'Agent Checkpoint', 'manual-checkpoint': 'Manual Checkpoint',
  undo: 'Undo', redo: 'Redo', restore: 'Restore', task: 'Task', request: 'Request', event: 'Event', activity: 'Git',
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

const FILTERS: { key: string; label: string; kinds: string; test?: (e: any) => boolean }[] = [
  { key: 'all', label: 'Everything', kinds: 'commit,checkpoint,event,activity' },
  { key: 'commits', label: 'Commits', kinds: 'commit' },
  { key: 'ai', label: 'AI', kinds: 'commit', test: (e) => e.origin === 'ai' },
  { key: 'you', label: 'You', kinds: 'commit', test: (e) => e.origin !== 'ai' },
  { key: 'checkpoints', label: 'Checkpoints', kinds: 'checkpoint' },
  { key: 'git', label: 'Branches & history', kinds: 'activity' },
  { key: 'tasks', label: 'Tasks & reviews', kinds: 'event' },
];

const dayLabel = (ts: string): string => {
  const d = new Date(ts); const t = new Date();
  const days = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: d.getFullYear() === t.getFullYear() ? undefined : 'numeric' });
};
const initials = (name: string) => (name || '?').split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';

function EntryNode({ e }: { e: any }) {
  const bad = e.ok === false || e.status === 'interrupted' || e.event === 'commit.failed';
  if (e.type === 'commit') {
    return e.origin === 'ai'
      ? <span className="absolute -left-[13px] top-3 w-[25px] h-[25px] rounded-full bg-lilac text-fg grid place-items-center ring-4 ring-canvas"><Sparkles size={12} /></span>
      : <span className="absolute -left-[13px] top-3 w-[25px] h-[25px] rounded-full bg-raised border border-line-strong text-fg-2 grid place-items-center text-[9px] font-semibold ring-4 ring-canvas" title={e.author}>{e.merge ? <GitMerge size={12} /> : initials(e.author)}</span>;
  }
  const Icon = e.type === 'activity' ? GitBranch : ENTRY_ICON[e.type] ?? HistoryIcon;
  const tone = bad ? 'bg-bad/15 text-bad border-bad/30' : e.type.endsWith('checkpoint') ? 'bg-info/10 text-info border-info/30' : e.type === 'activity' ? 'bg-warn/10 text-warn border-warn/30' : 'bg-surface text-fg-3 border-line';
  return <span className={`absolute -left-[11px] top-3.5 w-[21px] h-[21px] rounded-full border grid place-items-center ring-4 ring-canvas ${tone}`}><Icon size={11} /></span>;
}

export function RepoTimeline() {
  const { repoId, picker } = useRepo();
  const [entries, setEntries] = useState<any[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [working, setWorking] = useState<any>(null);
  const [filter, setFilter] = useState('all');
  const [text, setText] = useState('');
  const [author, setAuthor] = useState('');
  const [open, setOpen] = useState<any>(null);
  const [pick, setPick] = useState<any[]>([]);
  const [compare, setCompare] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [outside, setOutside] = useState(0);
  const seen = useRef<Set<string>>(new Set());
  const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
  const qs = (before?: string) => `limit=40&kinds=${active.kinds}${text.trim() ? `&q=${encodeURIComponent(text.trim())}` : ''}${author ? `&author=${encodeURIComponent(author)}` : ''}${before ? `&before=${encodeURIComponent(before)}` : ''}`;

  const load = async (before?: string) => {
    if (!repoId) return;
    setLoading(true);
    try {
      const r = await get<any>(`/repos/${repoId}/timeline?${qs(before)}`);
      if (!before) setWorking(r.working);
      setEntries((prev) => {
        if (before) return [...prev, ...r.entries.filter((e: any) => !prev.some((p) => p.id === e.id))];
        // refresh: the newest page replaces the top; older pages the user already opened stay
        const oldest = r.entries.length ? r.entries[r.entries.length - 1].ts : '';
        return [...r.entries, ...prev.filter((p) => p.ts < oldest && !r.entries.some((e: any) => e.id === p.id))];
      });
      if (!before) setNext(r.next);
      else setNext(r.next);
      // entries that were not on screen before this refresh are marked "new" for a few seconds
      const ids: string[] = r.entries.map((e: any) => e.id);
      if (seen.current.size && !before) {
        const added = ids.filter((i) => !seen.current.has(i));
        if (added.length) { setFresh(new Set(added)); setTimeout(() => setFresh(new Set()), 9000); }
      }
      ids.forEach((i) => seen.current.add(i));
    } finally { setLoading(false); }
  };
  useEffect(() => { seen.current = new Set(); setEntries([]); setOutside(0); }, [repoId]);
  useEffect(() => { const t = setTimeout(() => void load(), text ? 250 : 0); return () => clearTimeout(t); }, [repoId, filter, text, author]); // eslint-disable-line react-hooks/exhaustive-deps
  // the daemon watches the repository: anything that changes it (even outside the app) triggers a refresh
  useEvents((e) => {
    if (e.type === 'repo.commit.external') setOutside((n) => n + 1);
    if (['repo.changed', 'repo.commit.external', 'commit.created', 'checkpoint.completed', 'checkpoint.undo', 'checkpoint.redo', 'checkpoint.restore', 'commit.reverted', 'commit.reapplied', 'task.status', 'human.decided'].includes(e.type)) void load();
  });
  useEffect(() => { const t = setInterval(() => void load(), 30000); return () => clearInterval(t); }, [repoId, filter, text, author]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = entries.filter((e) => !active.test || active.test(e));
  const days = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const e of shown) { const d = dayLabel(e.ts); m.set(d, [...(m.get(d) ?? []), e]); }
    return [...m.entries()];
  }, [shown]);
  const commits = entries.filter((e) => e.type === 'commit');
  const authors = useMemo(() => [...new Set(commits.filter((c) => c.origin !== 'ai').map((c) => c.author))], [commits.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const chart = useMemo(() => {
    const out: { day: string; ai: number; you: number }[] = [];
    for (let i = 13; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); out.push({ day: d.toDateString(), ai: 0, you: 0 }); }
    for (const c of commits) { const slot = out.find((o) => o.day === new Date(c.ts).toDateString()); if (slot) { if (c.origin === 'ai') slot.ai++; else slot.you++; } }
    return out;
  }, [commits.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const max = Math.max(1, ...chart.map((c) => c.ai + c.you));
  const branches = useMemo(() => { const m = new Map<string, number>(); for (const c of commits) for (const b of c.branches ?? []) m.set(b, (m.get(b) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8); }, [commits.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const comparable = (e: any) => e.type === 'commit' || e.type.endsWith('checkpoint');
  const togglePick = (e: any) => setPick((p) => p.some((x) => x.id === e.id) ? p.filter((x) => x.id !== e.id) : [...p.slice(-1), e]);
  const copy = (sha: string) => { void navigator.clipboard?.writeText(sha).then(() => toast(`Copied ${sha.slice(0, 7)}`)).catch(() => undefined); };

  return (
    <div className="space-y-5">
      <PageHeader title="Repository timeline" sub="Everything that happens to the repository, from any tool: the AI's commits, yours (including from VS Code), checkpoints, undo and redo, branch changes and task results. It updates by itself.">
        {picker}
      </PageHeader>

      {/* where the repository is right now */}
      {working && (
        <div className="panel px-4 py-3 flex items-center gap-x-5 gap-y-2 flex-wrap text-sm">
          <span className="flex items-center gap-2 min-w-0"><GitBranch size={14} className="text-fg-3 shrink-0" /><span className="mono text-fg truncate">{working.branch ?? '(detached HEAD)'}</span></span>
          {working.head && (
            <span className="flex items-center gap-2 min-w-0 text-fg-3">
              <button className="mono text-fg-2 hover:text-fg" title="Copy the commit id" onClick={() => copy(working.head.sha)}>{working.head.sha.slice(0, 7)}</button>
              <span className="truncate max-w-[24rem]">{working.head.subject}</span>
              <span className="text-fg-4 shrink-0">{working.head.author} · {fmtAgo(working.head.at)}</span>
            </span>
          )}
          {working.upstream && <span className="text-xs text-fg-3 num flex items-center gap-2">{working.ahead ? <span className="flex items-center gap-0.5"><ArrowUp size={11} />{working.ahead} to push</span> : null}{working.behind ? <span className="flex items-center gap-0.5"><ArrowDown size={11} />{working.behind} behind</span> : null}{!working.ahead && !working.behind ? 'in sync with the remote' : null}</span>}
          <span className={`text-xs ${working.dirty.count ? 'text-warn' : 'text-fg-4'}`} title={working.dirty.files.join('\n')}>{working.dirty.count ? `${working.dirty.count} uncommitted file${working.dirty.count === 1 ? '' : 's'}` : 'working tree clean'}</span>
          {working.task && <span className="text-xs text-info">task working now: {working.task.label}</span>}
          <span className="ml-auto flex items-center gap-1.5 text-2xs text-fg-4"><span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse2" />watching — updates within seconds</span>
        </div>
      )}
      {outside > 0 && (
        <div className="rounded-xl border border-info/30 bg-info/[0.06] px-4 py-2.5 text-sm flex items-center gap-3">
          <GitCommitHorizontal size={15} className="text-info shrink-0" />
          <span className="text-fg-2">{outside} commit{outside === 1 ? '' : 's'} made outside the app (VS Code or a terminal) since you opened this page{outside === 1 ? ' is' : ' are'} in the timeline below.</span>
          <button className="btn btn-ghost btn-xs ml-auto" onClick={() => setOutside(0)}>Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_19rem] gap-5 items-start">
        <section className="panel overflow-hidden">
          <div className="px-4 pt-3.5 pb-3 border-b border-line space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="relative flex-1 min-w-[12rem] max-w-sm">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-4" />
                <input className="input input-sm w-full !pl-8" placeholder="Search commits, checkpoints, tasks…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search the timeline" />
              </div>
              {authors.length > 1 && (
                <Select className="input input-sm" value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author">
                  <option value="">all authors</option>{authors.map((a) => <option key={a} value={a}>{a}</option>)}
                </Select>
              )}
              {pick.length === 2 && <button className="btn btn-sm ml-auto" onClick={() => setCompare(true)}><GitCompare size={13} /> Compare the two selected</button>}
            </div>
            <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter the timeline">
              {FILTERS.map((f) => (
                <button key={f.key} role="tab" aria-selected={filter === f.key} onClick={() => setFilter(f.key)}
                  className={`h-7 px-3 rounded-full text-xs border transition-colors ${filter === f.key ? 'bg-fg text-canvas border-fg' : 'border-line text-fg-3 hover:text-fg hover:border-line-strong'}`}>{f.label}</button>
              ))}
            </div>
          </div>

          {!shown.length && !loading && <div className="px-4 py-8"><Muted>{text || author || filter !== 'all' ? 'Nothing matches these filters.' : 'Nothing recorded for this repository yet.'}</Muted></div>}
          {working?.dirty?.count > 0 && filter === 'all' && !text && (
            <div className="px-4 pt-3">
              <div className="relative ml-[17px] pl-7 pb-1 border-l-2 border-dashed border-warn/50">
                <span className="absolute -left-[11px] top-1 w-[21px] h-[21px] rounded-full border border-warn/40 bg-warn/10 text-warn grid place-items-center ring-4 ring-canvas"><FileEdit size={11} /></span>
                <div className="text-sm text-fg">Uncommitted changes <span className="text-fg-4 font-normal">· {working.dirty.count} file{working.dirty.count === 1 ? '' : 's'}</span></div>
                <div className="text-xs text-fg-4 mono truncate">{working.dirty.files.slice(0, 4).join(', ')}{working.dirty.count > 4 ? '…' : ''}</div>
              </div>
            </div>
          )}
          {days.map(([day, list]) => (
            <div key={day}>
              <div className="sticky top-0 z-[5] px-4 py-1.5 bg-surface/95 border-b border-line/60 flex items-baseline gap-2">
                <span className="text-xs font-medium text-fg-2">{day}</span><span className="text-2xs text-fg-4 num">{list.length}</span>
              </div>
              <ol className="relative ml-[29px] mr-4 my-2 border-l-2 border-line-strong/60">
                {list.map((e) => <TimelineRow key={e.id} e={e} isNew={fresh.has(e.id)} picked={pick.some((p) => p.id === e.id)} canPick={comparable(e)} onPick={() => togglePick(e)} onOpen={() => setOpen(e)} onCopy={copy} />)}
              </ol>
            </div>
          ))}
          {next && <div className="px-4 py-3 border-t border-line"><button className="btn btn-sm" disabled={loading} onClick={() => load(next)}>{loading ? 'Loading…' : 'Load earlier'}</button></div>}
        </section>

        <aside className="space-y-5 xl:sticky xl:top-4">
          <Panel title="Commits, last 14 days" action={<span className="text-2xs text-fg-4">{commits.length} loaded</span>}>
            <div className="flex items-end gap-[3px] h-16" role="img" aria-label="Commits per day">
              {chart.map((c) => (
                <div key={c.day} className="flex-1 flex flex-col justify-end gap-px h-full" title={`${new Date(c.day).toLocaleDateString()}: ${c.ai} AI, ${c.you} yours`}>
                  {c.you > 0 && <div className="bg-fg-3 rounded-sm" style={{ height: `${(c.you / max) * 100}%`, minHeight: 3 }} />}
                  {c.ai > 0 && <div className="bg-lilac rounded-sm" style={{ height: `${(c.ai / max) * 100}%`, minHeight: 3 }} />}
                  {c.ai + c.you === 0 && <div className="bg-line rounded-sm h-[2px]" />}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3 mt-2.5 text-2xs text-fg-3"><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-lilac" />AI {commits.filter((c) => c.origin === 'ai').length}</span><span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-fg-3" />You {commits.filter((c) => c.origin !== 'ai').length}</span></div>
          </Panel>
          {branches.length > 0 && (
            <Panel title="Branches">
              <ul className="space-y-1.5">{branches.map(([b, n]) => <li key={b} className="flex items-center gap-2 text-xs min-w-0"><GitBranch size={12} className="text-fg-4 shrink-0" /><span className="mono truncate text-fg-2">{b}</span><span className="ml-auto text-fg-4 num">{n}</span></li>)}</ul>
            </Panel>
          )}
          <Panel title="What shows up here">
            <ul className="text-xs text-fg-3 space-y-1.5 leading-relaxed">
              <li><span className="text-fg-2">Commits</span> from every local branch and tag, whatever made them — an agent, VS Code, a terminal.</li>
              <li><span className="text-fg-2">Checkpoints</span> and each undo, redo and restore.</li>
              <li><span className="text-fg-2">Branch switches, amends, resets</span> and new or deleted branches.</li>
            </ul>
          </Panel>
        </aside>
      </div>

      {open && (open.type === 'commit'
        ? <CommitDrawer repoId={repoId} sha={open.sha} onClose={() => setOpen(null)} onChanged={() => load()} />
        : open.checkpointId
          ? <CheckpointDrawer id={open.checkpointId} onClose={() => setOpen(null)} onChanged={() => load()} />
          : <Drawer title={<span className="text-[15px] font-semibold">{open.title}</span>} onClose={() => setOpen(null)}>
            <div className="space-y-2 text-sm">
              <div className="text-xs text-fg-4">{new Date(open.ts).toLocaleString()} · {open.actor} · {ENTRY_LABEL[open.type] ?? open.event ?? open.activity}</div>
              {open.activity && <p className="text-fg-3 text-sm">{open.activity === 'history-rewritten' ? 'The branch now points somewhere that does not contain its previous commit: an amend, a reset or a rebase. The earlier commits are still in git\'s reflog.' : open.activity === 'branch-switch' ? 'The checked-out branch changed outside the app.' : 'A branch or tag changed outside the app.'}</p>}
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

function TimelineRow({ e, isNew, picked, canPick, onPick, onOpen, onCopy }: { e: any; isNew: boolean; picked: boolean; canPick: boolean; onPick: () => void; onOpen: () => void; onCopy: (sha: string) => void }) {
  const commit = e.type === 'commit';
  const label = commit ? null : (e.type === 'activity' ? 'Git' : ENTRY_LABEL[e.type] ?? e.type);
  return (
    <li className={`relative pl-7 pr-2 py-2 group rounded-lg transition-colors ${isNew ? 'bg-info/[0.07]' : 'hover:bg-raised/50'}`}>
      <EntryNode e={e} />
      <div className="flex items-start gap-2">
        {canPick ? <input type="checkbox" className="mt-1 shrink-0 opacity-0 group-hover:opacity-100 checked:opacity-100 focus:opacity-100 transition-opacity" checked={picked} onChange={onPick} aria-label="Select to compare" /> : <span aria-hidden className="w-3.5 shrink-0" />}
        <button className="flex-1 min-w-0 text-left" onClick={onOpen}>
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap">
            <span className="text-sm text-fg font-medium break-words [overflow-wrap:anywhere] group-hover:underline underline-offset-2">{e.title}</span>
            {isNew && <Tag tone="info">new</Tag>}
            {commit && e.origin === 'ai' && <Tag tone="info">AI</Tag>}
            {commit && e.merge && <Tag>merge</Tag>}
            {commit && e.head && <Tag tone="ok">HEAD</Tag>}
            {commit && (e.branches ?? []).filter((b: string) => !b.startsWith('origin/') || true).slice(0, 3).map((b: string) => <span key={b} className="chip mono !text-2xs"><GitBranch size={9} />{b}</span>)}
            {commit && (e.tags ?? []).map((t: string) => <span key={t} className="chip !text-2xs">{t}</span>)}
            {label && <Tag tone={e.type.endsWith('checkpoint') ? 'info' : 'idle'}>{label}</Tag>}
            {e.status && <StatusChip value={e.status} />}
            {e.ok === false && <Tag tone="bad">refused</Tag>}
          </div>
          <div className="text-xs text-fg-4 mt-0.5 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
            <span className="text-fg-3">{commit ? (e.origin === 'ai' ? 'AI' : e.author) : e.actor}</span>
            <span title={new Date(e.ts).toLocaleString()}>{fmtAgo(e.ts)}</span>
            {commit && e.stat && <span className="num"><span className="text-ok">+{e.stat.added}</span> <span className="text-bad">−{e.stat.removed}</span> · {e.stat.files} file{e.stat.files === 1 ? '' : 's'}</span>}
            {!commit && Array.isArray(e.files) && e.files.length > 0 && <span>{e.files.length} file{e.files.length === 1 ? '' : 's'}</span>}
            {e.type.endsWith('checkpoint') && e.fileCount != null && <span title={`Snapshot of ${e.fileCount} files${e.branch ? ` on ${e.branch}` : ''}${e.headSha ? ` at ${String(e.headSha).slice(0, 7)}` : ''}`}>snapshot · {e.fileCount} files</span>}
            {e.type.endsWith('checkpoint') && (e.skipped ?? []).length > 0 && <span className="text-warn" title={e.skipped.join('\n')}>{e.skipped.length} not stored</span>}
          </div>
        </button>
        {e.sha && <button className="mono text-2xs text-fg-3 hover:text-fg shrink-0 mt-0.5 px-1.5 h-5 rounded border border-line hover:border-line-strong" title="Copy the commit id" onClick={() => onCopy(String(e.sha))}>{String(e.sha).slice(0, 7)}</button>}
      </div>
    </li>
  );
}
