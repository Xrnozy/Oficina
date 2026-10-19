import { Select } from '../Select';
import { WorkflowSelect } from '../workflowPicker';
import { useOffice, useOfficeAgents, useOfficeApprovals, useOfficeQueue } from '../office';
import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { del, post, put, useQuery } from '../api';
import {
  Avatar, Meter, Muted, ObsBadge, PageHeader, Panel, ProgressBar, RunControls, Segmented, SevChip, Skeleton, Stat, StatusChip,
  Tag, act, fmtAgo, fmtIn, fmtNum, fmtUsd, pct, useCurrentRun,
} from '../components';
import { ArrowRight, CheckCircle2, Circle, ListPlus, Plus, Sparkles, X, XCircle, Zap } from 'lucide-react';

// Role colours match the Workflow canvas and the Routing flow.
const ROLE_BAR: Record<string, string> = { pm: 'bg-lilac', 'prompt-creator': 'bg-cream', developer: 'bg-lime', qa: 'bg-mint', reviewer: 'bg-pink', analyst: 'bg-coral', docs: 'bg-cream' };

export default function Dashboard() {
  const { run, loading } = useCurrentRun();
  const { data: detail } = useQuery<any>(run ? `/runs/${run.id}` : null, [run?.id]);
  const { agents } = useOfficeAgents();
  const { office } = useOffice();
  const { data: errors } = useQuery<any[]>(run ? `/errors?runId=${run.id}` : null, [run?.id]);
  const { data: approvals } = useOfficeApprovals();
  const { data: providers } = useQuery<any>('/providers');
  const { data: usage } = useQuery<any>('/usage');
  const { data: tokenReport } = useQuery<any>(run ? `/runs/${run.id}/token-report` : null, [run?.id]);
  const [composing, setComposing] = useState(false);
  const [prefill, setPrefill] = useState<{ goal: string; queueId: string } | null>(null);
  const { data: queue, reload: reloadQueue } = useOfficeQueue();

  const openErrors = errors?.filter((e) => !['resolved', 'wontfix'].includes(e.status)) ?? [];
  const pendingApprovals = approvals?.filter((a) => a.status === 'pending') ?? [];
  const live = run && !['done', 'stopped'].includes(run.status);

  if (loading) return <Skeleton rows={5} />;

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" sub="Is the run healthy — and does it need you?">
        {run && !composing && <button className="btn" onClick={() => { setPrefill(null); setComposing(true); }}><Plus size={14} /> New run</button>}
      </PageHeader>

      {(!run || composing) && <NewRun key={prefill?.queueId ?? 'new'} prefill={prefill} onCancel={run ? () => { setComposing(false); setPrefill(null); } : undefined} onQueued={reloadQueue} />}

      {run && <RunCard run={run} detail={detail} live={!!live} />}

      {office && <QueuePanel office={office} items={queue ?? []} reload={reloadQueue} onStart={(it) => { setPrefill({ goal: it.text, queueId: it.id }); setComposing(true); window.scrollTo?.({ top: 0 }); document.getElementById('main')?.scrollTo?.({ top: 0, behavior: 'smooth' }); }} />}

      <DigestPanel />

      {run && (
        <div className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-5 [&>*]:min-w-0">
          <Panel title="Agents" action={<Link to="/activity" className="text-xs text-fg-3 hover:text-fg">Live activity →</Link>} bodyClass="pb-2">
            <div className="divide-line">
              {(agents ?? []).map((a) => {
                const task = (detail?.tasks ?? []).find((t: any) => t.ownerAgentId === a.id && !['done', 'cancelled', 'failed'].includes(t.status));
                const role = a.memberships?.find((m: any) => m.active)?.role as string | undefined;
                return (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span aria-hidden className={`w-1 h-8 rounded-full shrink-0 ${ROLE_BAR[role ?? ''] ?? 'bg-line-strong'}`} />
                    <Avatar agent={a} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-fg truncate">{a.name}</div>
                      <div className="text-xs text-fg-3 truncate">
                        {task ? <Link to={`/tasks/${task.id}`} className="hover:text-fg">on: {task.title}</Link> : (a.memberships?.filter((m: any) => m.active).map((m: any) => m.role).join(', ') || 'unassigned')}
                      </div>
                    </div>
                    <span className="hidden sm:contents"><ObsBadge level={a.observability} /></span>
                    <StatusChip value={a.status} />
                  </div>
                );
              })}
            </div>
          </Panel>

          <div className="space-y-5">
            <Panel title={<>Needs you{pendingApprovals.length > 0 && <span className="ml-2 chip !bg-warn/15 !text-warn !border-warn/30">{pendingApprovals.length}</span>}</>} action={<Link to="/approvals" className="text-xs text-fg-3 hover:text-fg">Inbox →</Link>} bodyClass="px-2 pb-2">
              {pendingApprovals.length === 0 && <div className="px-2 pb-2"><Muted>Nothing waiting on a decision.</Muted></div>}
              {pendingApprovals.slice(0, 4).map((a) => (
                <Link key={a.id} to="/approvals" className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-raised transition-colors">
                  <Tag tone="warn" mono>{a.action}</Tag>
                  <span className="text-sm text-fg-2 truncate flex-1">{a.payload?.summary}</span>
                  <ArrowRight size={13} className="text-fg-4" />
                </Link>
              ))}
            </Panel>

            <Panel title="Open error reports" action={<Link to="/errors" className="text-xs text-fg-3 hover:text-fg">All →</Link>} bodyClass="px-2 pb-2">
              <div className="flex gap-2 px-2 pb-2">
                {['critical', 'high', 'medium', 'low'].map((s) => {
                  const n = openErrors.filter((e) => e.severity === s).length;
                  return <div key={s} className={`flex-1 rounded-lg border border-line px-2.5 py-2 ${n ? '' : 'opacity-50'}`}><div className="text-lg font-semibold text-fg num leading-none">{n}</div><div className="text-2xs text-fg-3 mt-1">{s}</div></div>;
                })}
              </div>
              {openErrors.slice(0, 4).map((e) => (
                <Link key={e.id} to={`/errors/${e.id}`} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-raised transition-colors">
                  <SevChip sev={e.severity} />
                  <span className="text-sm text-fg-2 truncate flex-1">{e.title}</span>
                  <StatusChip value={e.status} />
                </Link>
              ))}
            </Panel>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <LimitsPanel providers={providers} />
        <Panel title="Cost" action={<Link to="/providers" className="text-xs text-fg-3 hover:text-fg">Providers →</Link>}>
          <div className="flex items-end gap-6 mb-4">
            <Stat label="Total spend" value={fmtUsd(usage?.totals?.costUsd)} />
            <div className="text-xs text-fg-3 num pb-0.5 space-y-0.5">
              <div><span className="text-fg-2">{fmtNum(usage?.totals?.requests)}</span> provider calls</div>
              <div><span className="text-fg-2">{fmtNum(usage?.totals?.inputTokens)}</span> in · <span className="text-fg-2">{fmtNum(usage?.totals?.outputTokens)}</span> out tokens</div>
            </div>
          </div>
          <div className="eyebrow mb-1">By agent</div>
          {(usage?.byAgent ?? []).length === 0 && <Muted>No usage recorded yet.</Muted>}
          {(usage?.byAgent ?? []).map((r: any) => {
            const max = Math.max(...(usage?.byAgent ?? []).map((x: any) => x.calls || 0), 1);
            return (
              <div key={r.id} className="grid grid-cols-[1fr_auto] gap-x-3 items-center py-1.5">
                <span className="text-sm text-fg-2 truncate">{r.name}</span>
                <span className="mono text-fg-3">{fmtUsd(r.cost)} · {r.calls} calls</span>
                <div className="col-span-2 h-[3px] mt-1 rounded-full bg-line overflow-hidden"><div className="h-full bg-fg-4" style={{ width: `${(r.calls / max) * 100}%` }} /></div>
              </div>
            );
          })}
        </Panel>
      </div>

      {run && <TokenReportPanel report={tokenReport} />}
      {run && <RunSummaryPanel runId={run.id} done={['done', 'stopped'].includes(run.status)} />}
    </div>
  );
}

// End-of-run summary (spec 6.6): built on the server from stored data only —
// goal, tasks, commits, checks, tokens per stage, retries, interventions.
// Exportable as Markdown; shows while running too (re-derived live).
function RunSummaryPanel({ runId, done }: { runId: string; done: boolean }) {
  const { data: s } = useQuery<any>(`/runs/${runId}/summary`, [runId]);
  if (!s) return null;
  const doneTasks = (s.tasks ?? []).filter((t: any) => t.status === 'done' || t.status === 'approved').length;
  return (
    <Panel title="Run summary" action={
      <a className="btn btn-ghost btn-sm text-2xs" href={`/api/runs/${runId}/summary?format=md`} download>Export Markdown</a>
    }>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Tasks" value={`${doneTasks}/${s.tasks?.length ?? 0}`} />
        <Stat label="Commits" value={s.commits?.length ?? 0} />
        <Stat label="Checks" value={s.checks ? `${s.checks.passed}/${s.checks.total}` : '0'} hint={s.checks?.failed ? `${s.checks.failed} failed` : undefined} />
        <Stat label="Retries" value={(s.retries?.retriedWorkItems ?? 0) + (s.retries?.repairRetries ?? 0)} />
        <Stat label="Needs you" value={s.humanInterventions?.approvalsDecided ?? 0} hint={s.humanInterventions?.approvalsDecided ? undefined : done ? 'ran unattended' : 'so far'} />
      </div>
      <div className="mt-3 flex items-center gap-4 text-2xs text-fg-3 flex-wrap">
        <span>{fmtNum(s.totals?.tokens)} tokens{!s.totals?.tokens && s.totals?.promptChars ? ` (${fmtNum(s.totals.promptChars)} prompt chars)` : ''}</span>
        {s.totals?.costUsd > 0 && <span>{fmtUsd(s.totals.costUsd)}</span>}
        {s.totals?.cacheHits > 0 && <span className="text-ok">{s.totals.cacheHits} cache hit{s.totals.cacheHits > 1 ? 's' : ''} · ~{fmtNum(s.totals.tokensSaved)} tokens saved</span>}
        {done && <span className="text-fg-4">final</span>}
      </div>
    </Panel>
  );
}

// "Since your last visit" (spec 5.4): what finished, what's stuck and why,
// what it cost, and what still needs a decision. The visit timestamp lives
// in localStorage and is stamped when the dashboard renders.
function DigestPanel() {
  const [since] = useState(() => localStorage.getItem('oc:lastVisit') ?? new Date(Date.now() - 24 * 3600e3).toISOString());
  useEffect(() => { localStorage.setItem('oc:lastVisit', new Date().toISOString()); }, []);
  const { data: raw } = useQuery<any>(`/digest?since=${encodeURIComponent(since)}`);
  const { data: approvals } = useOfficeApprovals();
  if (!raw) return null;
  const mineIds = new Set((approvals ?? []).map((a: any) => a.id));
  const d = { ...raw, needsYou: (raw.needsYou ?? []).filter((a: any) => mineIds.has(a.id)) };
  const quiet = !d.tasksDone.length && !d.tasksBlocked.length && !d.needsYou.length && !d.tokens?.calls;
  return (
    <Panel title="Since your last visit" action={<span className="text-2xs text-fg-4">{quiet ? 'nothing new · ' : ''}{fmtAgo(since)}</span>}>
      <div className="grid grid-cols-2 sm:grid-cols-4 [&>*+*]:border-l [&>*+*]:border-line [&>*]:px-4 [&>*:first-child]:pl-1">
        {[
          { k: 'Tasks done', v: d.tasksDone.length, h: undefined as string | undefined },
          { k: 'Blocked / failed', v: d.tasksBlocked.length, h: d.tasksBlocked.length ? 'see below' : undefined },
          { k: 'Provider calls', v: fmtNum(d.tokens?.calls), h: d.tokens?.promptChars ? `${fmtNum(d.tokens.promptChars)} chars · ${fmtUsd(d.tokens.costUsd)}` : undefined },
          { k: 'Needs you', v: d.needsYou.length, h: d.needsYou.length ? 'pending decisions' : 'inbox zero' },
        ].map((c) => (
          <div key={c.k} className="min-w-0">
            <div className="eyebrow mb-1">{c.k}</div>
            <div className="text-xl font-semibold tracking-[-0.02em] num leading-6 text-fg">{c.v}</div>
            {c.h && <div className="text-2xs text-fg-4 mt-0.5 truncate">{c.h}</div>}
          </div>
        ))}
      </div>
      {(d.tasksDone.length > 0 || d.tasksBlocked.length > 0 || d.needsYou.length > 0) && (
        <div className="mt-4 space-y-1.5">
          {d.tasksDone.slice(0, 4).map((t: any) => (
            <div key={t.id} className="flex items-center gap-2 text-sm"><CheckCircle2 size={13} className="text-ok shrink-0" /><span className="text-fg-2 truncate">{t.title}</span></div>
          ))}
          {d.tasksBlocked.map((t: any) => (
            <div key={t.id} className="flex items-center gap-2 text-sm" title={t.reason ?? ''}>
              <XCircle size={13} className="text-bad shrink-0" />
              <span className="text-fg-2 truncate">{t.title}</span>
              <span className="text-xs text-fg-3 truncate">{t.status}{t.reason ? ` — ${t.reason}` : ''}</span>
            </div>
          ))}
          {d.needsYou.map((a: any) => (
            <Link key={a.id} to="/approvals" className="flex items-center gap-2 text-sm hover:bg-raised rounded -mx-1 px-1 py-0.5">
              <Tag tone="warn" mono>{a.action}</Tag><span className="text-fg-2 truncate">{a.summary}</span>
            </Link>
          ))}
        </div>
      )}
    </Panel>
  );
}

// Per-stage token accounting for the run (prompt size is always known;
// reported tokens are 0 for unmetered backends like the scripted demo).
function TokenReportPanel({ report }: { report: any }) {
  const rows = report?.byKind ?? [];
  const top = report?.top ?? [];
  if (!report || (!rows.length && !top.length)) return null;
  return (
    <Panel title="Token report" action={<span className="text-2xs text-fg-4">prompt chars are exact · reported tokens come from the provider</span>}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-2xs text-fg-4 border-b border-line">
            <th className="font-medium py-2 pr-3">Stage</th>
            <th className="font-medium px-3 text-right">Calls</th>
            <th className="font-medium px-3 text-right">Prompt chars</th>
            <th className="font-medium px-3 text-right">Reported tokens</th>
            <th className="font-medium px-3 text-right">Avg / call</th>
            <th className="font-medium pl-3 text-right">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r: any) => (
            <tr key={r.kind}>
              <td className="py-2 pr-3"><Tag mono>{r.kind}</Tag></td>
              <td className="px-3 py-2 text-right num text-fg-2">{r.calls}</td>
              <td className="px-3 py-2 text-right num text-fg-2">{fmtNum(r.promptChars)}</td>
              <td className="px-3 py-2 text-right num text-fg-2">{r.reportedTokens ? fmtNum(r.reportedTokens) : '—'}</td>
              <td className="px-3 py-2 text-right num text-fg-3">{r.reportedTokens ? fmtNum(r.avgTokensPerCall) : '—'}</td>
              <td className="pl-3 py-2 text-right num text-fg-2">{r.costUsd ? fmtUsd(r.costUsd) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {top.length > 0 && (
        <div className="mt-4">
          <div className="eyebrow mb-1">Most expensive work items</div>
          <div className="divide-line">
            {top.map((t: any) => (
              <div key={t.id} className="flex items-center gap-3 py-1.5">
                <Tag mono>{t.kind}</Tag>
                <span className="text-sm text-fg-2 truncate flex-1">{t.taskTitle ?? t.id}</span>
                <span className="mono text-xs text-fg-3">{t.reportedTokens ? `${fmtNum(t.reportedTokens)} tok · ` : ''}{fmtNum(t.promptChars)} chars{t.costUsd ? ` · ${fmtUsd(t.costUsd)}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function NewRun({ onCancel, prefill, onQueued }: { onCancel?: () => void; prefill?: { goal: string; queueId: string } | null; onQueued?: () => void }) {
  const { office, offices } = useOffice();
  const { data: repos } = useQuery<any[]>('/repos');
  const [goal, setGoal] = useState(prefill?.goal ?? '');
  const [budget, setBudget] = useState('50');
  const [mode, setMode] = useState<'guided' | 'one-shot'>('guided');
  const [repoChoice, setRepoChoice] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const budgetNum = Number(budget);
  const wsRepos = (repos ?? []).filter((r: any) => r.workspaceId === office?.id);
  const custom = repoChoice === '__custom__' || (!repoChoice && wsRepos.length === 0);
  const invalid = !goal.trim() || !(budgetNum > 0) || !office
    || (custom ? !repoPath.trim() : !(repoChoice || wsRepos[0]?.id));
  const oneShot = mode === 'one-shot';
  const confirmPlan = !!office?.settings?.confirmPlan;
  return (
    <form className="pblock block-lilac animate-rise" onSubmit={async (e) => {
      e.preventDefault();
      if (invalid) return;
      setBusy(true);
      let repoId = repoChoice || wsRepos[0]?.id;
      if (custom) {
        const repo = await act(post('/repos', { workspaceId: office!.id, path: repoPath.trim() }), 'Repo registered');
        repoId = repo?.id;
        if (!repoId) { setBusy(false); return; }
      }
      const r = await act(post('/runs', { workspaceId: office!.id, goal: goal.trim(), budgetUsd: budgetNum, oneShot, repoId, workflowId: workflowId || undefined, queueId: prefill?.queueId }),
        oneShot ? 'One-shot started — the PM is on it' : confirmPlan ? 'Run created — review the PM\'s plan' : 'Sent to the PM — hand-offs are automatic from here');
      setBusy(false);
      if (r?.id) onCancel?.();
      if (r?.id && !oneShot && confirmPlan) nav(`/dod/${r.id}`);
    }}>
      <div className="flex items-center gap-3 mb-1 flex-wrap">
        <Sparkles size={15} className="text-fg" />
        <h2 className="text-[15px] font-semibold">{oneShot ? 'Run it once' : 'New request'}{office && <span className="ml-2 text-xs font-normal text-fg-2">in {office.name}</span>}</h2>
        <div className="ml-auto"><Segmented value={mode} options={['guided', 'one-shot'] as const} onChange={setMode} /></div>
      </div>
      <p className="text-sm text-fg-2 mb-5 max-w-[64ch]">
        {oneShot
          ? 'Say what you want in plain words — the PM interprets it, plans the work, and the Office executes a single pass. No approval gate, no fix loop; you get the result and a report.'
          : `Send a feature request to the PM. It writes the requirements and the developer's prompt; the developer implements and documents the change; the tester reviews and validates it; the PM accepts it or sends it back — every hand-off automatic${confirmPlan ? ', after you confirm the plan' : ''}. See Routing for which models each step uses.`}
      </p>
      <div className="grid grid-cols-1 md:grid-cols-[1fr_150px_auto] gap-x-3 gap-y-4 items-end">
        <label className="block">
          <span className="field-label">What do you want?</span>
          <textarea className="input w-full min-h-[3.25rem] resize-y" rows={2} autoFocus placeholder="e.g. Add a --toc flag to the markdown converter, with tests and docs" value={goal} onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit(); } }} />
        </label>
        <label className="block">
          <span className="field-label whitespace-nowrap">Budget (USD)</span>
          <input className="input w-full num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-invalid={!(budgetNum > 0)} />
        </label>
        <div className="flex gap-2">
          {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
          {!prefill && (
            <button type="button" className="btn" disabled={!goal.trim() || !office || busy} title="Keep it in this office's queue to start later"
              onClick={async () => {
                const r = await act(post('/queue', { text: goal, workspaceId: office!.id, source: 'app' }), 'Added to the queue');
                if (r) { setGoal(''); onQueued?.(); }
              }}><ListPlus size={13} /> Queue for later</button>
          )}
          <button className="btn btn-primary" disabled={invalid || busy}>{busy ? 'Starting…' : oneShot ? <><Zap size={13} /> Run once</> : <>{confirmPlan ? 'Draft plan' : 'Send to PM'} <ArrowRight size={14} /></>}</button>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-4 items-start mt-4">
        <label className="block">
          <span className="field-label">Repository</span>
          <Select className="input w-full font-mono" value={repoChoice || wsRepos[0]?.id || '__custom__'} onChange={(e) => setRepoChoice(e.target.value)}>
            {wsRepos.map((r: any) => <option key={r.id} value={r.id}>{r.path}</option>)}
            <option value="__custom__">A different folder on this machine…</option>
          </Select>
        </label>
        <label className="block">
          <span className="field-label">Workflow</span>
          <WorkflowSelect wsId={office?.id} value={workflowId} onChange={setWorkflowId} className="w-full" />
        </label>
        {custom && (
          <label className="block">
            <span className="field-label">Folder path</span>
            <input className="input w-full font-mono" placeholder="C:\path\to\repo" value={repoPath} onChange={(e) => setRepoPath(e.target.value)} />
          </label>
        )}
      </div>
      {custom && <p className="text-xs text-fg-4 mt-2">Git-init'd if it isn't a repo yet. Task branches, worktrees, and the integration branch all live inside it.</p>}
      {!(budgetNum > 0) && <div className="text-xs text-bad mt-2">Budget must be a positive number.</div>}
      {offices && !offices.length && <div className="text-xs text-bad mt-2">No workspace exists yet — run <span className="mono">npm run seed</span> first.</div>}
    </form>
  );
}

// Requests typed in the tray (or queued here) wait per office. Starting one opens the New request form with
// its text, so the repository, budget and workflow are chosen as usual; or let the office start them itself.
function QueuePanel({ office, items, reload, onStart }: { office: { id: string; name: string; settings: Record<string, any> }; items: { id: string; text: string; source: string; createdAt: string }[]; reload: () => void; onStart: (it: { id: string; text: string }) => void }) {
  const { reload: reloadOffices } = useOffice();
  const { data: repos } = useQuery<any[]>(`/repos?workspaceId=${office.id}`, [office.id]);
  const auto = !!office.settings?.autoStartQueue;
  const [budget, setBudget] = useState(String(office.settings?.queueBudgetUsd ?? 50));
  useEffect(() => { setBudget(String(office.settings?.queueBudgetUsd ?? 50)); }, [office.id, office.settings?.queueBudgetUsd]);
  const save = async (patch: Record<string, unknown>, msg: string) => { if (await act(put(`/workspaces/${office.id}/settings`, patch), msg)) reloadOffices(); };
  const noRepo = repos != null && repos.length === 0;
  return (
    <Panel title={<>Queue{items.length > 0 && <span className="ml-2 chip !bg-info/10 !text-info !border-info/30">{items.length}</span>}</>}
      action={<span className="text-2xs text-fg-4 hidden sm:inline">add one from the tray icon, or with Queue for later on the New request form</span>} bodyClass="px-2 pb-3">
      {items.length === 0 && <div className="px-2 pb-1"><Muted>Nothing waiting. Click the Oficina tray icon, type a request, and it lands here for {office.name}.</Muted></div>}
      <ul>
        {items.map((it) => (
          <li key={it.id} className="group flex items-start gap-3 px-2 py-2 rounded-lg hover:bg-raised transition-colors">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-fg-2 line-clamp-2 whitespace-pre-line">{it.text}</div>
              <div className="text-2xs text-fg-4 mt-0.5">{it.source === 'tray' ? 'from the tray' : 'queued here'} · {fmtAgo(it.createdAt)}</div>
            </div>
            <button className="btn btn-xs shrink-0" onClick={() => onStart(it)} title="Open the New request form with this text">Start…</button>
            <button className="btn btn-ghost btn-xs btn-icon shrink-0" aria-label="Remove from the queue" title="Remove"
              onClick={async () => { if (await act(del(`/queue/${it.id}`), 'Removed')) reload(); }}><X size={13} /></button>
          </li>
        ))}
      </ul>
      <div className="mx-2 mt-2 pt-3 border-t border-line flex items-center gap-x-4 gap-y-2 flex-wrap text-xs text-fg-3">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={auto} onChange={(e) => void save({ autoStartQueue: e.target.checked }, e.target.checked ? 'Queued requests will start automatically when this office is idle' : 'Auto-start is off — you start requests yourself')} />
          Start the next one automatically when {office.name} is idle
        </label>
        {auto && (
          <label className="flex items-center gap-1.5">
            budget each $
            <input className="input input-sm w-16 num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)}
              onBlur={() => { const n = Number(budget); if (n > 0 && n !== (office.settings?.queueBudgetUsd ?? 50)) void save({ queueBudgetUsd: n }, 'Budget saved'); else setBudget(String(office.settings?.queueBudgetUsd ?? 50)); }} />
          </label>
        )}
        <span className="text-fg-4">{auto ? "Uses the office's first repository and runs one request at a time." : 'Off: nothing runs until you press Start.'}</span>
        {auto && noRepo && <span className="text-warn">This office has no repository yet, so nothing can start. Start one by hand to add a folder.</span>}
      </div>
    </Panel>
  );
}

// figma rhythm: the run's status owns a pastel block — the rest of the page stays monochrome.
const RUN_BLOCK: Record<string, string> = {
  running: 'block-lime', 'dod-review': 'block-lilac', verifying: 'block-mint', paused: 'block-cream', pausing: 'block-cream',
  done: 'block-mint', blocked: 'block-pink', failed: 'block-pink', stopped: 'block-coral', escalated: 'block-pink',
};

function RunCard({ run, detail, live }: { run: any; detail: any; live: boolean }) {
  const items = detail?.dod?.items ?? [];
  const required = items.filter((i: any) => !i.optional);
  const passed = required.filter((i: any) => i.status === 'pass').length;
  const spendFrac = run.budget?.runUsd ? run.spentUsd / run.budget.runUsd : 0;
  const cycles = detail?.cycles ?? [];
  return (
    <section className="panel overflow-hidden animate-rise">
      <div className={`${RUN_BLOCK[run.status] ?? 'block-cream'} px-5 py-4 lg:px-6 flex items-center gap-4 flex-wrap`}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            <StatusChip value={run.status} />
            {run.limits?.oneShot && <Tag tone="info"><Zap size={10} /> one-shot</Tag>}
            {run.stopReason && run.status !== 'done' && <Tag tone="bad" mono>{run.stopReason}</Tag>}
            <span className="text-xs text-fg-3 mono">run {run.id.slice(-8)} · started {fmtAgo(run.startedAt)}{run.workflow ? ` · ${run.workflow.name} v${run.workflow.n}` : ''}</span>
          </div>
          <h2 className="text-base font-semibold tracking-[-0.01em] leading-snug">{run.goal}</h2>
        </div>
        {run.status === 'dod-review'
          ? <Link to={`/dod/${run.id}`} className="btn btn-accent">Review DoD to start <ArrowRight size={14} /></Link>
          : live && <RunControls run={run} size="" />}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-line border-t border-line [&>*]:min-w-0">
        <div className="bg-surface p-5">
          <Stat label="Definition of Done" value={<>{passed}<span className="text-fg-4 text-lg">/{required.length || '—'}</span></>} hint={`${pct(run.progressScore)} of required items`}>
            <ProgressBar value={run.progressScore} tone="accent" />
          </Stat>
        </div>
        <div className="bg-surface p-5">
          <Stat label="Cycle" value={<>{run.currentCycle}<span className="text-fg-4 text-lg">/{run.limits?.maxCycles ?? '∞'}</span></>} hint={cycles.length ? 'DoD progress per cycle' : 'no completed cycles yet'}>
            <div className="flex items-end gap-[3px] h-6">
              {cycles.slice(-24).map((c: any) => (
                <div key={c.id} title={`cycle ${c.n}: ${pct(c.progressScore)}`} className="flex-1 max-w-3 rounded-sm bg-accent/50 hover:bg-accent transition-colors" style={{ height: `${12 + c.progressScore * 88}%` }} />
              ))}
              {!cycles.length && <div className="h-px flex-1 bg-line self-center" />}
            </div>
          </Stat>
        </div>
        <div className="bg-surface p-5">
          <Stat label="Spend" value={fmtUsd(run.spentUsd)} hint={`of ${fmtUsd(run.budget?.runUsd)} · warns at ${run.budget?.warnPct ?? 80}%`}>
            <Meter value={spendFrac} warnAt={(run.budget?.warnPct ?? 80) / 100} />
          </Stat>
        </div>
        <div className="bg-surface p-5">
          <div className="eyebrow mb-2">Checklist</div>
          <ul className="space-y-1.5">
            {items.slice(0, 5).map((i: any) => (
              <li key={i.id} className="flex items-center gap-2 text-xs text-fg-2">
                {i.status === 'pass' ? <CheckCircle2 size={13} className="text-ok shrink-0" /> : i.status === 'fail' ? <XCircle size={13} className="text-bad shrink-0" /> : <Circle size={13} className="text-fg-4 shrink-0" />}
                <span className="truncate">{i.text}</span>
              </li>
            ))}
            {!items.length && <Muted>Waiting for the PM's draft.</Muted>}
          </ul>
        </div>
      </div>
    </section>
  );
}

function LimitsPanel({ providers }: { providers: any }) {
  // Tightest window per account (spec §9: remaining %, reset countdown + local time, source label).
  const byAcct = new Map<string, any>();
  for (const w of (providers?.windows ?? []).filter((w: any) => w.lim)) {
    const f = (w.used ?? 0) / w.lim;
    const cur = byAcct.get(w.account_id);
    if (!cur || f > (cur.used ?? 0) / cur.lim) byAcct.set(w.account_id, w);
  }
  const rows = [...byAcct.values()].sort((a, b) => (b.used ?? 0) / b.lim - (a.used ?? 0) / a.lim);
  return (
    <Panel title="Limits" action={<span className="text-2xs text-fg-4">tightest window per account</span>}>
      {!rows.length && <Muted>No quota windows observed yet. They appear once providers report headers or you set a monthly budget.</Muted>}
      <div className="space-y-3.5">
        {rows.map((w) => {
          const f = (w.used ?? 0) / w.lim;
          return (
            <div key={w.id}>
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-sm text-fg truncate">{w.account_id}</span>
                <span className="text-xs text-fg-4">{w.metric} / {w.period}</span>
                <span className="ml-auto text-xs num text-fg-2">{Math.max(0, Math.round((1 - f) * 100))}% left</span>
              </div>
              <Meter value={f} />
              <div className="flex gap-2 mt-1.5 text-2xs text-fg-4">
                <Tag tone={w.source === 'estimate' ? 'idle' : 'info'}>{w.source}{w.confidence ? ` · ${w.confidence}` : ''}</Tag>
                {w.resets_at && <span className="self-center">resets {fmtIn(w.resets_at)} · {new Date(w.resets_at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
