import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../api';
import { Avatar, Dot, Empty, PageHeader, Skeleton, TONE_BG, fmtUsd, useCurrentRun, type Tone } from '../components';
import { ListChecks } from 'lucide-react';

const COLUMNS: { key: string; label: string; tone: Tone; statuses: string[] }[] = [
  { key: 'ready', label: 'Ready', tone: 'idle', statuses: ['backlog', 'ready', 'assigned', 'blocked-quota'] },
  { key: 'active', label: 'In progress', tone: 'info', statuses: ['in-progress', 'waiting-input', 'verifying', 'changes-requested'] },
  { key: 'review', label: 'In review', tone: 'warn', statuses: ['in-review', 'approved'] },
  { key: 'done', label: 'Done', tone: 'ok', statuses: ['done'] },
  { key: 'stopped', label: 'Failed / blocked', tone: 'bad', statuses: ['failed', 'blocked', 'cancelled'] },
];

export default function Tasks() {
  const { run, loading } = useCurrentRun();
  const { data: detail } = useQuery<any>(run ? `/runs/${run.id}` : null, [run?.id]);
  const { data: agents } = useQuery<any[]>('/agents');
  const tasks = detail?.tasks ?? [];
  const agentOf = (id?: string) => agents?.find((a) => a.id === id);

  if (loading) return <Skeleton rows={4} />;
  if (!run) return <Empty icon={ListChecks} title="No run yet" text="Tasks are created by the PM once a run's Definition of Done is approved. Start a run from the dashboard." ><Link to="/" className="btn">Go to dashboard</Link></Empty>;

  const grouped = COLUMNS.map((col) => ({ ...col, list: tasks.filter((t: any) => col.statuses.includes(t.status)) }));
  const doneCount = grouped.find((c) => c.key === 'done')?.list.length ?? 0;

  return (
    <div>
      <PageHeader title="Tasks" sub={<>{tasks.length} task{tasks.length === 1 ? '' : 's'} in <span className="text-fg-2">{run.goal}</span></>} />

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
          <section key={col.key} className="snap-start shrink-0 w-[260px] xl:w-auto xl:flex-1 xl:min-w-0">
            <h2 className="flex items-center gap-2 pb-2 mb-2.5 border-b-2 text-xs font-medium text-fg-2" style={{ borderColor: `rgb(var(--${col.tone === 'idle' ? 'fg-4' : col.tone}))` }}>
              {col.label}
              <span className="ml-auto text-fg-4 num">{col.list.length}</span>
            </h2>
            <div className="space-y-2 min-h-24">
              {col.list.map((t: any) => {
                const owner = agentOf(t.ownerAgentId);
                return (
                  <Link key={t.id} to={`/tasks/${t.id}`} className="block bg-surface border border-line rounded-lg p-3 hover:border-line-strong transition-colors">
                    <div className="text-sm text-fg leading-snug">{t.title}</div>
                    <div className="mt-2 flex items-center gap-x-2.5 gap-y-1 flex-wrap text-2xs text-fg-4">
                      <span className="text-fg-3">{String(t.status).replace(/-/g, ' ')}</span>
                      <span className="mono">P{t.priority} · d{t.difficulty}</span>
                      {t.budgetUsd != null && <span className="num">{fmtUsd(t.spentUsd)} / {fmtUsd(t.budgetUsd)}</span>}
                    </div>
                    {owner && (
                      <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-line text-xs text-fg-3">
                        <Avatar agent={owner} size="sm" /> <span className="truncate">{owner.name}</span>
                        <Dot tone={owner.status === 'working' ? 'ok' : 'idle'} live={owner.status === 'working'} className="ml-auto" />
                      </div>
                    )}
                  </Link>
                );
              })}
              {!col.list.length && <div className="text-xs text-fg-4 text-center py-5 border border-dashed border-line rounded-lg">None</div>}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
