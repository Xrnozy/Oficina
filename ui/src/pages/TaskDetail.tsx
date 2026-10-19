import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post, put, useQuery } from '../api';
import { Empty, KV, Meter, Muted, PageHeader, Panel, Segmented, SevChip, Skeleton, StatusChip, Tag, act, fmtAgo, fmtTime, fmtUsd } from '../components';
import { ChevronRight, FileQuestion, GitBranch, GitMerge, Pencil } from 'lucide-react';
import { TaskChanges, TaskRecord } from './TaskRecord';
import { TaskFiles } from '../attachments';
import { useOffice, useOfficeAgents } from '../office';

const PROMPT_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'info'> = { drafting: 'info', revising: 'warn', 'pm-review': 'warn', approved: 'ok', escalated: 'bad' };
const KIND_LABEL: Record<string, string> = { prompt: 'prompt draft', 'prompt-review': 'PM prompt review' };

export default function TaskDetail() {
  const { id } = useParams();
  const { data: t, reload, loading, error } = useQuery<any>(`/tasks/${id}`, [id]);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<{ title?: string; priority?: number; description?: string }>({});
  const [mode, setMode] = useState<'finish' | 'abort' | 'handoff'>('finish');
  const { office } = useOffice();
  const { agents } = useOfficeAgents();

  if (loading) return <Skeleton rows={5} />;
  if (!t) return <Empty icon={FileQuestion} title="Task not found" text={error ?? 'This task does not exist.'}><Link to="/tasks" className="btn">Back to tasks</Link></Empty>;

  const promptByWi = Object.fromEntries((t.prompts ?? []).map((p: any) => [p.work_item_id, p]));

  return (
    <div className="space-y-5 min-w-0">
      <PageHeader back={{ to: '/tasks', label: 'Tasks' }} title={t.title}
        sub={<span className="flex items-center gap-2 flex-wrap"><StatusChip value={t.status} /><Tag>{t.type}</Tag>{t.meta?.promptStage && <Tag tone={PROMPT_TONE[t.meta.promptStage] ?? 'idle'}>prompt {t.meta.promptStage.replace('-', ' ')}</Tag>}<span className="text-xs num">P{t.priority} · difficulty {t.difficulty}/5 · {t.attempts} attempt{t.attempts === 1 ? '' : 's'}</span></span>}>
        {t.status === 'in-review' && (
          <button className="btn btn-accent" onClick={async () => { await act(post(`/tasks/${t.id}/approve`, { reason: 'owner override' }), 'Approved as owner'); reload(); }}>Approve as owner</button>
        )}
        <button className={`btn ${editMode ? 'btn-primary' : ''}`} onClick={() => { setEditMode((v) => !v); setDraft({}); }}><Pencil size={13} /> {editMode ? 'Close editor' : 'Edit'}</button>
      </PageHeader>

      {editMode && (
        <Panel title="Edit task" className="animate-rise border-accent/30">
          <div className="space-y-3">
            <label className="block"><span className="field-label">Title</span><input className="input w-full" defaultValue={t.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} /></label>
            <label className="block"><span className="field-label">Description</span><textarea className="input w-full h-28" defaultValue={t.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} /></label>
            <div className="flex items-end gap-4 flex-wrap">
              <label className="block"><span className="field-label">Priority</span><input className="input w-20 num" type="number" defaultValue={t.priority} onChange={(e) => setDraft((d) => ({ ...d, priority: +e.target.value }))} /></label>
              <div><span className="field-label">If work is in flight</span><Segmented value={mode} options={['finish', 'handoff', 'abort'] as const} onChange={setMode} /></div>
              <button className="btn btn-accent ml-auto" disabled={!Object.keys(draft).length} onClick={async () => {
                const r = await act(put(`/tasks/${t.id}`, { ...draft, mode }), 'Edit queued for the next safe point');
                if (r) { setEditMode(false); reload(); }
              }}>Apply at next safe point</button>
            </div>
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-5 items-start">
        <div className="space-y-5 min-w-0">
          <Panel title="Description">
            <p className="text-sm text-fg-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed max-w-[72ch]">{t.description || <span className="text-fg-4">No description.</span>}</p>
            {(t.acceptanceCriteria ?? []).length > 0 && (<>
              <div className="eyebrow mt-5 mb-2">Acceptance criteria</div>
              <ul className="space-y-1.5">
                {t.acceptanceCriteria.map((c: string, i: number) => <li key={i} className="flex gap-2 text-sm text-fg-2 min-w-0"><span className="text-fg-4 mono pt-px shrink-0">{String(i + 1).padStart(2, '0')}</span><span className="min-w-0 break-words [overflow-wrap:anywhere]">{c}</span></li>)}
              </ul>
            </>)}
          </Panel>

          {office && (
            <Panel title="Files" action={<span className="text-2xs text-fg-4 hidden sm:inline">only agents on this task see them</span>}>
              <TaskFiles taskId={t.id} workspaceId={office.id} readOnly={['done', 'cancelled'].includes(t.status)} />
            </Panel>
          )}
        </div>

        <div className="space-y-5 min-w-0 lg:col-span-2">
          <TaskChanges task={t} />
          <TaskRecord taskId={t.id} />

          <Panel title="Work items & prompts" bodyClass="px-2 pb-2">
            {(t.workItems ?? []).length === 0 && <div className="px-2"><Muted>No work dispatched yet.</Muted></div>}
            {(t.workItems ?? []).map((w: any) => (
              <details key={w.id} className="group rounded-lg hover:bg-raised/50 open:bg-raised/50 transition-colors">
                <summary className="px-2.5 min-h-10 py-2 cursor-pointer flex items-center gap-3 text-sm list-none min-w-0 [&::-webkit-details-marker]:hidden">
                  <ChevronRight size={13} className="text-fg-4 group-open:rotate-90 transition-transform" />
                  <StatusChip value={w.status} />
                  <span className="font-medium text-fg">{KIND_LABEL[w.kind] ?? w.kind}</span>
                  <span className="text-xs text-fg-4">attempt {w.attempt} · {fmtAgo(w.startedAt)}</span>
                  <span className="ml-auto text-xs text-fg-3 truncate max-w-[40%] hidden sm:block">{w.result?.summary}</span>
                </summary>
                <div className="px-3 pb-3 pl-9">
                  {promptByWi[w.id]?.rendered_text && (<>
                    <div className="eyebrow mt-1 mb-1.5">{w.kind === 'prompt' ? 'Draft for the agent' : w.kind === 'prompt-review' ? 'Prompt the PM reviewed' : String(promptByWi[w.id].template_id ?? '').endsWith('/approved') ? 'PM-approved prompt' : 'Rendered prompt'} · v{promptByWi[w.id].version}{promptByWi[w.id].edited_by_user ? ' · edited by owner' : ''}</div>
                    <pre className="mono text-fg-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere] bg-sunken border border-line rounded-lg p-3 max-h-56 overflow-y-auto leading-relaxed">{promptByWi[w.id].rendered_text}</pre>
                  </>)}
                  {w.result?.filesChanged?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 items-center text-xs text-fg-3">
                      {w.result.filesChanged.map((f: string) => <Tag key={f} mono>{f}</Tag>)}
                      <span className="mono text-fg-4">@ {w.result.sha?.slice(0, 10)}</span>
                    </div>
                  )}
                </div>
              </details>
            ))}
          </Panel>
        </div>

        <div className="space-y-5 min-w-0">
          <Panel title="Details">
            <dl className="divide-line">
              <KV k="Handled by">{t.ownerAgentId ? <span>{(agents ?? []).find((a: any) => a.id === t.ownerAgentId)?.name ?? t.ownerAgentId}</span> : <span className="text-fg-4">{t.meta?.createdBy === 'owner' ? 'waiting for a free agent' : 'not assigned yet'}</span>}</KV>
              {t.meta?.createdBy === 'owner' && <KV k="Added by"><span>you</span></KV>}
              <KV k="Branch"><span className="mono flex items-center gap-1.5 min-w-0 break-all"><GitBranch size={12} className="text-fg-4 shrink-0" />{t.branch ?? '—'}</span></KV>
              <KV k="Result"><span className="flex items-center gap-1.5"><GitMerge size={12} className={t.status === 'done' ? 'text-ok' : 'text-fg-4'} />{t.meta?.committedSha ? `committed ${String(t.meta.committedSha).slice(0, 8)}` : t.meta?.generalCheckpointId ? (t.status === 'done' ? 'in the working tree (not committed)' : 'in progress') : t.status === 'done' ? 'merged to integration' : 'not merged'}</span></KV>
              <KV k="Budget"><div className="flex items-center gap-2 num"><Meter value={t.budgetUsd ? t.spentUsd / t.budgetUsd : 0} /><span className="text-xs whitespace-nowrap">{fmtUsd(t.spentUsd)} / {fmtUsd(t.budgetUsd)}</span></div></KV>
              <KV k="Depends on">
                {(t.dependencies ?? []).length === 0 && <span className="text-fg-4">nothing</span>}
                {(t.dependencies ?? []).map((d: any) => (
                  <Link key={d.id} to={`/tasks/${d.id}`} className="flex items-center gap-2 hover:text-fg py-0.5"><StatusChip value={d.status} /><span className="truncate">{d.title}</span></Link>
                ))}
              </KV>
            </dl>
          </Panel>

          <Panel title="Check runs" bodyClass="px-2 pb-2">
            <div className="max-h-64 overflow-auto">
              {(t.checkRuns ?? []).map((c: any) => (
                <div key={c.id} className="flex items-center gap-2.5 px-2 py-1.5 text-sm">
                  <StatusChip value={c.status} />
                  <span className="text-fg-2 truncate flex-1" title={c.summary}>{c.summary}</span>
                  <span className="mono text-fg-4">{c.ref || c.commit_sha?.slice(0, 7)}</span>
                  <span className="text-2xs text-fg-4 num">{fmtTime(c.created_at)}</span>
                </div>
              ))}
              {!(t.checkRuns ?? []).length && <div className="px-2"><Muted>No checks have run.</Muted></div>}
            </div>
          </Panel>

          <Panel title="Error reports" bodyClass="px-2 pb-2">
            {(t.errorReports ?? []).length === 0 && <div className="px-2"><Muted>None for this task.</Muted></div>}
            {(t.errorReports ?? []).map((e: any) => (
              <Link key={e.id} to={`/errors/${e.id}`} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-raised transition-colors">
                <SevChip sev={e.severity} />
                <span className="text-sm text-fg-2 truncate flex-1">{e.title}</span>
                <StatusChip value={e.status} />
              </Link>
            ))}
          </Panel>
        </div>
      </div>
    </div>
  );
}
