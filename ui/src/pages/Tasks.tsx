import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '../api';
import { Avatar, Dot, Empty, PageHeader, Skeleton, StatusChip, TONE_BG, fmtUsd, useCurrentRun, type Tone } from '../components';
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

  return (
    <div>
      <PageHeader title="Tasks" sub={<>{tasks.length} task{tasks.length === 1 ? '' : 's'} in <span className="text-fg-2">{run.goal}</span></>} />
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 lg:mx-0 lg:px-0 snap-x">
        {COLUMNS.map((col) => {
          const list = tasks.filter((t: any) => col.statuses.includes(t.status));
          return (
            <section key={col.key} className="snap-start shrink-0 w-[260px] xl:w-auto xl:flex-1 xl:min-w-0 rounded-xl bg-sunken/50 border border-line p-2">
              <h2 className="flex items-center gap-2 px-2 pt-1 pb-2.5 text-xs font-medium text-fg-2">
                <span className={`w-2 h-2 rounded-sm ${TONE_BG[col.tone]}`} />{col.label}
                <span className="ml-auto text-fg-4 num">{list.length}</span>
              </h2>
              <div className="space-y-2 min-h-24">
                {list.map((t: any) => {
                  const owner = agentOf(t.ownerAgentId);
                  return (
                    <Link key={t.id} to={`/tasks/${t.id}`} className="block bg-surface border border-line rounded-lg p-3 hover:border-line-strong hover:-translate-y-px transition-[border-color,transform] animate-rise">
                      <div className="text-sm text-fg leading-snug mb-2.5">{t.title}</div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusChip value={t.status} />
                        <span className="text-2xs text-fg-4 num">P{t.priority} · d{t.difficulty}</span>
                        {t.budgetUsd != null && <span className="text-2xs text-fg-4 num">{fmtUsd(t.spentUsd)}/{fmtUsd(t.budgetUsd)}</span>}
                      </div>
                      {owner && (
                        <div className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t border-line text-xs text-fg-3">
                          <Avatar agent={owner} size="sm" /> <span className="truncate">{owner.name}</span>
                          <Dot tone={owner.status === 'working' ? 'ok' : 'idle'} className="ml-auto" />
                        </div>
                      )}
                    </Link>
                  );
                })}
                {!list.length && <div className="text-xs text-fg-4 text-center py-6 border border-dashed border-line rounded-lg">Empty</div>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
