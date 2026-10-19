import React, { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { del, post, useQuery } from '../api';
import { Avatar, Dot, Empty, Modal, PageHeader, Skeleton, TONE_BG, act, fmtUsd, goalTitle, toast, useCurrentRun, type Tone } from '../components';
import { useOffice } from '../office';
import { NewTaskModal, uploadFiles, useFileDrop, type Attachment } from '../attachments';
import { ListChecks, ListPlus, Lock, Paperclip, Pause, Play, Trash2, UploadCloud } from 'lucide-react';

// Columns the owner can drop a card into (`drop`) and cards the owner may pick up (MOVABLE). Everything else is the
// workflow's: In progress, In review, Done and Failed reflect what the agents actually did, so they are never a target.
const COLUMNS: { key: string; label: string; tone: Tone; statuses: string[]; drop?: 'held' | 'ready'; hint?: string }[] = [
  { key: 'held', label: 'On hold', tone: 'idle', statuses: ['held'], drop: 'held', hint: 'Kept, but no agent picks these up' },
  { key: 'ready', label: 'Ready', tone: 'idle', statuses: ['backlog', 'ready', 'assigned', 'blocked-quota'], drop: 'ready' },
  { key: 'active', label: 'In progress', tone: 'info', statuses: ['in-progress', 'waiting-input', 'verifying', 'changes-requested'] },
  { key: 'review', label: 'In review', tone: 'warn', statuses: ['in-review', 'approved'] },
  { key: 'done', label: 'Done', tone: 'ok', statuses: ['done'] },
  { key: 'stopped', label: 'Failed / blocked', tone: 'bad', statuses: ['failed', 'blocked', 'cancelled'] },
];
const MOVABLE = ['held', 'backlog', 'ready', 'blocked-quota'];       // nothing has started on these
const BUSY = ['assigned', 'in-progress', 'verifying', 'in-review'];   // an agent may be on it: not deletable
const LIVE = ['draft', 'dod-review', 'running', 'pausing', 'paused', 'verifying'];
const TASK_MIME = 'application/x-oficina-task';

export default function Tasks() {
  const { run, loading } = useCurrentRun();
  const { office } = useOffice();
  const { data: detail, reload: reloadRun } = useQuery<any>(run ? `/runs/${run.id}` : null, [run?.id]);
  const { data: agents } = useQuery<any[]>('/agents');
  const { data: files, reload: reloadFiles } = useQuery<Attachment[]>(office ? `/attachments?workspaceId=${office.id}&scope=task` : null, [office?.id]);
  const [creating, setCreating] = useState<File[] | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [removing, setRemoving] = useState<any | null>(null);
  // a move shows at once and is confirmed by the daemon afterwards; a refusal puts the card back
  const [optimistic, setOptimistic] = useState<Record<string, 'held' | 'ready'>>({});
  const tasks = (detail?.tasks ?? []).map((t: any) => (optimistic[t.id] ? { ...t, status: optimistic[t.id] } : t));
  const agentOf = (id?: string) => agents?.find((a) => a.id === id);
  const filesOf = (taskId: string) => (files ?? []).filter((f) => f.taskId === taskId);
  const canAdd = !!run && !!office && LIVE.includes(run.status);

  const move = async (taskId: string, to: 'held' | 'ready') => {
    const t = (detail?.tasks ?? []).find((x: any) => x.id === taskId);
    if (!t) return;
    if ((to === 'held' && t.status === 'held') || (to === 'ready' && ['ready', 'backlog'].includes(t.status))) return;
    setOptimistic((o) => ({ ...o, [taskId]: to }));
    const ok = await act(post(`/tasks/${taskId}/move`, { to }), to === 'held' ? `“${t.title}” is on hold — no agent will pick it up` : `“${t.title}” is ready — the next free agent takes it`);
    reloadRun();
    // keep the optimistic card until the refreshed board arrives, so it never flickers back
    setTimeout(() => setOptimistic((o) => { const n = { ...o }; delete n[taskId]; return n; }), ok ? 700 : 0);
  };

  if (loading) return <Skeleton rows={4} />;
  if (!run) return <Empty icon={ListChecks} title="No run yet" text="Tasks are created by the PM once a run's Definition of Done is approved. Start a run from the dashboard." ><Link to="/" className="btn">Go to dashboard</Link></Empty>;

  const grouped = COLUMNS.map((col) => ({ ...col, list: tasks.filter((t: any) => col.statuses.includes(t.status)) }));
  const doneCount = grouped.find((c) => c.key === 'done')?.list.length ?? 0;
  const dragged = tasks.find((t: any) => t.id === dragging);

  return (
    <div>
      <PageHeader title="Tasks" sub={<>{tasks.length} task{tasks.length === 1 ? '' : 's'} in <span className="text-fg-2">{goalTitle(run.goal)}</span></>}>
        <button className="btn btn-primary" disabled={!canAdd} title={canAdd ? 'Add work for the agents in this run' : 'This run has finished — start a new one to add work'} onClick={() => setCreating([])}><ListPlus size={14} /> New task</button>
      </PageHeader>

      {tasks.length > 0 && (
        <div className="mb-5">
          <div className="flex h-1.5 rounded-full overflow-hidden bg-line gap-px" role="img" aria-label={`${doneCount} of ${tasks.length} tasks done`}>
            {grouped.filter((c) => c.list.length).map((c) => (
              <div key={c.key} className={TONE_BG[c.tone]} style={{ width: `${(c.list.length / tasks.length) * 100}%` }} title={`${c.label}: ${c.list.length}`} />
            ))}
          </div>
          <div className="mt-2 flex items-center gap-4 flex-wrap text-xs text-fg-3">
            <span><span className="text-fg font-medium num">{doneCount}</span> of {tasks.length} done</span>
            {grouped.filter((c) => c.list.length).map((c) => (
              <span key={c.key} className="flex items-center gap-1.5"><Dot tone={c.tone} />{c.label} <span className="num text-fg-4">{c.list.length}</span></span>
            ))}
          </div>
        </div>
      )}

      {/* columns keep a readable width and the board scrolls sideways, instead of squeezing cards until their text is cut off */}
      <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 lg:mx-0 lg:px-0 items-start">
        {grouped.map((col) => (
          <Column key={col.key} col={col} dragged={dragged ?? null} canAddFiles={canAdd && col.key === 'ready'}
            onMove={(id, to) => { setDragging(null); void move(id, to); }} onDropFiles={(f) => setCreating(f)}>
            {col.list.map((t: any) => (
              <TaskCard key={t.id} t={t} owner={agentOf(t.ownerAgentId)} files={filesOf(t.id)} canAttach={!!office && !['done', 'cancelled'].includes(t.status)}
                onDragState={setDragging} onMove={(to) => void move(t.id, to)} onDelete={() => setRemoving(t)}
                onFiles={async (f) => { if (office && (await uploadFiles(f, { workspaceId: office.id, scope: 'task', taskId: t.id })).length) reloadFiles(); }} />
            ))}
            {!col.list.length && <div className="text-xs text-fg-4 text-center py-5 border border-dashed border-line rounded-lg px-2">
              {col.key === 'ready' && canAdd ? 'Drop a file here to create a task from it' : col.hint ?? 'None'}
            </div>}
          </Column>
        ))}
      </div>
      <p className="mt-2 text-2xs text-fg-4">Drag a card between <b className="font-medium text-fg-3">On hold</b> and <b className="font-medium text-fg-3">Ready</b>. The other columns show what the agents actually did, so they can't be set by hand.</p>

      {creating && office && run && (
        <NewTaskModal workspaceId={office.id} runId={run.id} initialFiles={creating} onClose={() => setCreating(null)} onCreated={() => { reloadFiles(); reloadRun(); }} />
      )}
      {removing && <DeleteTaskModal task={removing} onClose={() => setRemoving(null)} onDeleted={() => { setRemoving(null); reloadRun(); reloadFiles(); }} />}
    </div>
  );
}

export function DeleteTaskModal({ task, onClose, onDeleted }: { task: { id: string; title: string; status: string }; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const finished = ['done', 'failed', 'cancelled', 'blocked'].includes(task.status);
  return (
    <Modal title="Delete this task?" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Keep it</button>
        <button className="btn btn-danger" disabled={busy} onClick={async () => { setBusy(true); if (await act(del(`/tasks/${task.id}`), `“${task.title}” deleted`)) onDeleted(); setBusy(false); }}>{busy ? 'Deleting…' : 'Delete task'}</button></>}>
      <p className="text-sm text-fg-2"><b className="font-medium text-fg">{task.title}</b> is removed from the board together with its attached files, prompts and check results. Other tasks stop waiting for it.</p>
      <p className="text-xs text-fg-3 mt-3">{finished ? 'Changes it already made to your repository stay; undo them from Checkpoints if you want them gone.' : 'Nothing has been changed in your repository for it.'} Deleting can't be undone — to keep it for later, put it on hold instead.</p>
    </Modal>
  );
}

const isTaskDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes(TASK_MIME);

function Column({ col, dragged, canAddFiles, onMove, onDropFiles, children }: {
  col: (typeof COLUMNS)[number] & { list: any[] }; dragged: any | null; canAddFiles: boolean;
  onMove: (taskId: string, to: 'held' | 'ready') => void; onDropFiles: (f: File[]) => void; children: React.ReactNode;
}) {
  // Files from the desktop dropped on Ready start a task; a card dropped on On hold / Ready moves there; any other column refuses.
  // Nothing here changes the column's size or position while a drag is in progress: highlighting is an outline and the hints
  // are overlaid, so the card under the pointer never moves and the drag doesn't flicker between enter and leave.
  const files = useFileDrop(onDropFiles, canAddFiles);
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const allowed = !!col.drop && !!dragged && dragged.status !== col.drop && !(col.drop === 'ready' && ['ready', 'backlog'].includes(dragged.status));
  const locked = !!dragged && !col.drop;
  return (
    <section
      {...files.props}
      onDragEnter={(e) => { if (isTaskDrag(e)) { depth.current++; if (allowed) setOver(true); return; } files.props.onDragEnter?.(e); }}
      onDragOver={(e) => {
        if (isTaskDrag(e)) { if (allowed) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } else e.dataTransfer.dropEffect = 'none'; return; }
        files.props.onDragOver?.(e);
      }}
      onDragLeave={(e) => { if (isTaskDrag(e)) { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setOver(false); return; } files.props.onDragLeave?.(e); }}
      onDrop={(e) => {
        if (isTaskDrag(e)) {
          e.preventDefault(); depth.current = 0; setOver(false);
          const id = e.dataTransfer.getData(TASK_MIME);
          if (id && col.drop && allowed) onMove(id, col.drop);
          return;
        }
        files.props.onDrop?.(e);
      }}
      className={`relative shrink-0 w-[250px] xl:w-auto xl:flex-1 xl:min-w-[215px] rounded-xl p-1.5 transition-colors ${over || files.over ? 'bg-raised outline outline-2 outline-fg/40 -outline-offset-2' : 'bg-transparent'} ${locked ? 'opacity-55' : ''}`}>
      <h2 className="flex items-center gap-2 px-1 pb-2 mb-2.5 border-b-2 text-xs font-medium text-fg-2" style={{ borderColor: `rgb(var(--${col.tone === 'idle' ? 'fg-4' : col.tone}))` }}>
        {col.label}
        {locked && <span title="Set by the workflow from what the agents actually do" className="text-fg-4"><Lock size={11} /></span>}
        <span className="ml-auto text-fg-4 num">{col.list.length}</span>
      </h2>
      <div className="space-y-2 min-h-24">{children}</div>
      {(over || files.over) && (
        <div aria-hidden className="pointer-events-none absolute inset-x-1.5 top-1.5 z-10 h-8 rounded-lg border border-dashed border-fg-3 bg-surface text-xs text-fg-2 flex items-center justify-center gap-2">
          {files.over ? <><UploadCloud size={14} /> Drop to create a task</> : col.drop === 'held' ? 'Drop to put on hold' : 'Drop to hand it to the agents'}
        </div>
      )}
      {locked && <div aria-hidden className="pointer-events-none absolute inset-x-3 bottom-2 text-center text-2xs text-fg-4">Set by the workflow</div>}
    </section>
  );
}

function TaskCard({ t, owner, files, canAttach, onFiles, onDragState, onMove, onDelete }: {
  t: any; owner: any; files: Attachment[]; canAttach: boolean; onFiles: (f: File[]) => void;
  onDragState: (id: string | null) => void; onMove: (to: 'held' | 'ready') => void; onDelete: () => void;
}) {
  const { over, props } = useFileDrop((f) => { if (!canAttach) { toast('That task is finished — add a new task instead', 'bad'); return; } onFiles(f); }, true);
  const movable = MOVABLE.includes(t.status);
  const busy = BUSY.includes(t.status);
  const [lifted, setLifted] = useState(false);
  return (
    <Link {...props} to={`/tasks/${t.id}`} draggable={movable}
      onDragStart={(e) => {
        if (!movable) { e.preventDefault(); return; }
        e.dataTransfer.setData(TASK_MIME, t.id); e.dataTransfer.effectAllowed = 'move';
        // let the browser capture the drag image first: re-rendering the board inside dragstart makes Chrome drop the drag
        setTimeout(() => { setLifted(true); onDragState(t.id); }, 0);
      }}
      onDragEnd={() => { setLifted(false); onDragState(null); }}
      className={`block min-w-0 bg-surface border rounded-lg p-3 transition-colors ${movable ? 'cursor-grab active:cursor-grabbing' : ''} ${lifted ? 'opacity-40' : ''} ${over ? 'border-fg bg-raised' : 'border-line hover:border-line-strong'}`}>
      <div className="text-sm text-fg leading-snug break-words [overflow-wrap:anywhere]">{t.title}</div>
      <div className="mt-2 flex items-center gap-x-2.5 gap-y-1 flex-wrap text-2xs text-fg-4">
        <span className="text-fg-3">{t.status === 'held' ? 'on hold' : String(t.status).replace(/-/g, ' ')}</span>
        <span className="mono">P{t.priority} · d{t.difficulty}</span>
        {t.budgetUsd != null && <span className="num">{fmtUsd(t.spentUsd)} / {fmtUsd(t.budgetUsd)}</span>}
        {files.length > 0 && <span className="inline-flex items-center gap-1 text-fg-3" title={files.map((f) => f.name).join('\n')}><Paperclip size={11} />{files.length}</span>}
      </div>
      {over && <div className="mt-2 text-2xs text-fg-2 flex items-center gap-1.5"><UploadCloud size={12} /> Drop to attach to this task</div>}
      <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-line text-xs text-fg-3 min-w-0">
        {owner ? (
          <>
            <Avatar agent={owner} size="sm" /> <span className="truncate min-w-0">{owner.name}</span>
            <Dot tone={owner.status === 'working' ? 'ok' : 'idle'} live={owner.status === 'working'} />
          </>
        ) : <span className="text-fg-4 truncate">{t.status === 'held' ? 'not for the agents' : 'not assigned yet'}</span>}
        {/* in the card's own footer, so they never cover its text */}
        <span className="ml-auto flex shrink-0 -mr-1">
          {t.status === 'held'
            ? <button type="button" className="btn btn-ghost btn-xs btn-icon" title="Release: hand it to the agents" aria-label="Move to Ready" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMove('ready'); }}><Play size={12} /></button>
            : movable && <button type="button" className="btn btn-ghost btn-xs btn-icon" title="Put on hold: keep it, but no agent works on it" aria-label="Put on hold" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMove('held'); }}><Pause size={12} /></button>}
          <button type="button" className="btn btn-ghost btn-xs btn-icon" disabled={busy} title={busy ? 'An agent is on it — wait or stop the run first' : 'Delete this task'} aria-label="Delete task"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}><Trash2 size={12} /></button>
        </span>
      </div>
    </Link>
  );
}
