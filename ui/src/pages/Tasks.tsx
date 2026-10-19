import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../api';
import { Avatar, Dot, Empty, PageHeader, Skeleton, TONE_BG, fmtUsd, toast, useCurrentRun, type Tone } from '../components';
import { useOffice } from '../office';
import { NewTaskModal, uploadFiles, useFileDrop, type Attachment } from '../attachments';
import { ListChecks, ListPlus, Paperclip, UploadCloud } from 'lucide-react';

const COLUMNS: { key: string; label: string; tone: Tone; statuses: string[] }[] = [
  { key: 'ready', label: 'Ready', tone: 'idle', statuses: ['backlog', 'ready', 'assigned', 'blocked-quota'] },
  { key: 'active', label: 'In progress', tone: 'info', statuses: ['in-progress', 'waiting-input', 'verifying', 'changes-requested'] },
  { key: 'review', label: 'In review', tone: 'warn', statuses: ['in-review', 'approved'] },
  { key: 'done', label: 'Done', tone: 'ok', statuses: ['done'] },
  { key: 'stopped', label: 'Failed / blocked', tone: 'bad', statuses: ['failed', 'blocked', 'cancelled'] },
];
const LIVE = ['draft', 'dod-review', 'running', 'pausing', 'paused', 'verifying'];

export default function Tasks() {
  const { run, loading } = useCurrentRun();
  const { office } = useOffice();
  const { data: detail } = useQuery<any>(run ? `/runs/${run.id}` : null, [run?.id]);
  const { data: agents } = useQuery<any[]>('/agents');
  const { data: files, reload: reloadFiles } = useQuery<Attachment[]>(office ? `/attachments?workspaceId=${office.id}&scope=task` : null, [office?.id]);
  const [creating, setCreating] = useState<File[] | null>(null);
  const tasks = detail?.tasks ?? [];
  const agentOf = (id?: string) => agents?.find((a) => a.id === id);
  const filesOf = (taskId: string) => (files ?? []).filter((f) => f.taskId === taskId);
  const canAdd = !!run && !!office && LIVE.includes(run.status);

  if (loading) return <Skeleton rows={4} />;
  if (!run) return <Empty icon={ListChecks} title="No run yet" text="Tasks are created by the PM once a run's Definition of Done is approved. Start a run from the dashboard." ><Link to="/" className="btn">Go to dashboard</Link></Empty>;

  const grouped = COLUMNS.map((col) => ({ ...col, list: tasks.filter((t: any) => col.statuses.includes(t.status)) }));
  const doneCount = grouped.find((c) => c.key === 'done')?.list.length ?? 0;

  return (
    <div>
      <PageHeader title="Tasks" sub={<>{tasks.length} task{tasks.length === 1 ? '' : 's'} in <span className="text-fg-2">{run.goal}</span></>}>
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

      <div className="flex gap-4 overflow-x-auto pb-2 -mx-4 px-4 lg:mx-0 lg:px-0 snap-x">
        {grouped.map((col) => (
          <Column key={col.key} col={col} canDrop={canAdd && col.key === 'ready'} onDropFiles={(f) => setCreating(f)}>
            {col.list.map((t: any) => (
              <TaskCard key={t.id} t={t} owner={agentOf(t.ownerAgentId)} files={filesOf(t.id)} canAttach={!!office && !['done', 'cancelled'].includes(t.status)}
                onFiles={async (f) => { if (office && (await uploadFiles(f, { workspaceId: office.id, scope: 'task', taskId: t.id })).length) reloadFiles(); }} />
            ))}
            {!col.list.length && <div className="text-xs text-fg-4 text-center py-5 border border-dashed border-line rounded-lg">{col.key === 'ready' && canAdd ? 'Drop a file here to create a task from it' : 'None'}</div>}
          </Column>
        ))}
      </div>

      {creating && office && run && (
        <NewTaskModal workspaceId={office.id} runId={run.id} initialFiles={creating} onClose={() => setCreating(null)} onCreated={() => reloadFiles()} />
      )}
    </div>
  );
}

function Column({ col, canDrop, onDropFiles, children }: { col: (typeof COLUMNS)[number] & { list: any[] }; canDrop: boolean; onDropFiles: (f: File[]) => void; children: React.ReactNode }) {
  // dropping onto the Ready column starts a task from the files; dropping onto a card (below) attaches to that card instead
  const { over, props } = useFileDrop(onDropFiles, canDrop);
  return (
    <section {...props} className={`snap-start shrink-0 w-[260px] xl:w-auto xl:flex-1 xl:min-w-0 rounded-xl transition-colors ${over ? 'bg-raised ring-1 ring-fg/30 -m-1.5 p-1.5' : ''}`}>
      <h2 className="flex items-center gap-2 pb-2 mb-2.5 border-b-2 text-xs font-medium text-fg-2" style={{ borderColor: `rgb(var(--${col.tone === 'idle' ? 'fg-4' : col.tone}))` }}>
        {col.label}
        <span className="ml-auto text-fg-4 num">{col.list.length}</span>
      </h2>
      {over && <div className="flex items-center justify-center gap-2 text-xs text-fg-2 border border-dashed border-fg-3 rounded-lg py-4 mb-2"><UploadCloud size={14} /> Drop to create a task</div>}
      <div className="space-y-2 min-h-24">{children}</div>
    </section>
  );
}

function TaskCard({ t, owner, files, canAttach, onFiles }: { t: any; owner: any; files: Attachment[]; canAttach: boolean; onFiles: (f: File[]) => void }) {
  const { over, props } = useFileDrop((f) => { if (!canAttach) { toast('That task is finished — add a new task instead', 'bad'); return; } onFiles(f); }, true);
  return (
    <Link {...props} to={`/tasks/${t.id}`} className={`block bg-surface border rounded-lg p-3 transition-colors ${over ? 'border-fg bg-raised' : 'border-line hover:border-line-strong'}`}>
      <div className="text-sm text-fg leading-snug">{t.title}</div>
      <div className="mt-2 flex items-center gap-x-2.5 gap-y-1 flex-wrap text-2xs text-fg-4">
        <span className="text-fg-3">{String(t.status).replace(/-/g, ' ')}</span>
        <span className="mono">P{t.priority} · d{t.difficulty}</span>
        {t.budgetUsd != null && <span className="num">{fmtUsd(t.spentUsd)} / {fmtUsd(t.budgetUsd)}</span>}
        {files.length > 0 && <span className="inline-flex items-center gap-1 text-fg-3" title={files.map((f) => f.name).join('\n')}><Paperclip size={11} />{files.length}</span>}
      </div>
      {over && <div className="mt-2 text-2xs text-fg-2 flex items-center gap-1.5"><UploadCloud size={12} /> Drop to attach to this task</div>}
      {owner && (
        <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-line text-xs text-fg-3">
          <Avatar agent={owner} size="sm" /> <span className="truncate">{owner.name}</span>
          <Dot tone={owner.status === 'working' ? 'ok' : 'idle'} live={owner.status === 'working'} className="ml-auto" />
        </div>
      )}
    </Link>
  );
}
