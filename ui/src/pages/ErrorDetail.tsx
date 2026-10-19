import React, { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { post, useQuery } from '../api';
import { Empty, KV, Muted, PageHeader, Panel, Segmented, SevChip, Skeleton, StatusChip, Tag, act, fmtAgo } from '../components';
import { CheckCircle2, FileQuestion, Lightbulb, Terminal } from 'lucide-react';

export default function ErrorDetail() {
  const { id } = useParams();
  const { data: e, reload, loading, error } = useQuery<any>(`/errors/${id}`, [id]);
  const [view, setView] = useState<'excerpt' | 'full log'>('excerpt');
  if (loading) return <Skeleton rows={5} />;
  if (!e) return <Empty icon={FileQuestion} title="Error report not found" text={error ?? ''}><Link to="/errors" className="btn">Back to error reports</Link></Empty>;

  const log = (view === 'full log' ? e.fullLog : e.evidence?.logExcerpt) ?? '';

  return (
    <div className="space-y-5">
      <PageHeader back={{ to: '/errors', label: 'Error reports' }} title={e.title}
        sub={<span className="flex items-center gap-2 flex-wrap"><SevChip sev={e.severity} /><StatusChip value={e.status} /><span className="mono text-fg-4">{e.id} · sig {e.signature}</span></span>}>
        {!['resolved', 'wontfix'].includes(e.status) && (
          <button className="btn btn-ghost" onClick={async () => {
            if (!confirm("Mark as won't fix? The Office stops trying to fix it, and it no longer blocks a 'no open errors' DoD check.")) return;
            await act(post(`/errors/${e.id}/wontfix`), "Marked won't fix"); reload();
          }}>Won't fix</button>
        )}
      </PageHeader>

      {e.suspectedCause?.summary && (
        <div className="panel p-4 flex gap-3">
          <Lightbulb size={16} className="text-warn shrink-0 mt-0.5" />
          <div>
            <div className="text-sm text-fg-2 leading-relaxed max-w-[80ch]">{e.suspectedCause.summary}</div>
            <div className="text-2xs text-fg-4 mt-1">Analyst's interpretation · {e.suspectedCause.confidence} confidence · source: {e.suspectedCause.reasoningSource}</div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.25fr] gap-5 items-start">
        <div className="space-y-5">
          <Panel title="Failing check">
            <div className="mono text-fg bg-sunken border border-line rounded-lg px-3 py-2 flex items-center gap-2 overflow-x-auto"><Terminal size={12} className="text-fg-4 shrink-0" />{e.failingCheck?.command || '(non-command check)'}</div>
            <dl className="mt-2 divide-line">
              <KV k="Commit"><span className="mono">{e.failingCheck?.commitSha?.slice(0, 10) ?? '—'}</span></KV>
              <KV k="Check run"><span className="mono">{e.failingCheck?.checkRunId?.slice(0, 10) ?? '—'}</span></KV>
              {e.failingCheck?.exitCode != null && <KV k="Exit code"><span className="mono text-bad">{e.failingCheck.exitCode}</span></KV>}
            </dl>
          </Panel>

          <Panel title="Suggested fix">
            <p className="text-sm text-fg-2 leading-relaxed">{e.suggestedFix?.approach ?? <span className="text-fg-4">None yet.</span>}</p>
            <div className="flex gap-2 mt-3">
              {e.suggestedFix?.suggestedRole && <Tag>role: {e.suggestedFix.suggestedRole}</Tag>}
              {e.suggestedFix?.difficulty != null && <Tag>difficulty {e.suggestedFix.difficulty}/5</Tag>}
            </div>
            {(e.affectedFiles ?? []).length > 0 && (<>
              <div className="eyebrow mt-4 mb-1.5">Affected files</div>
              <div className="flex flex-wrap gap-1.5">{e.affectedFiles.map((f: any) => <Tag key={f.path} mono>{f.path}</Tag>)}</div>
            </>)}
            {e.relatedErrors?.length > 0 && (<>
              <div className="eyebrow mt-4 mb-1.5">Knowledge-base matches</div>
              {e.relatedErrors.map((r: any) => (
                <div key={r.id} className="flex gap-2 text-sm text-fg-2 py-1"><span className="mono text-info shrink-0">{Math.round((r.similarity ?? 0) * 100)}%</span>{r.resolution ?? <span className="text-fg-4">no fix recorded</span>}</div>
              ))}
            </>)}
          </Panel>
        </div>

        <Panel title="Evidence" action={<Segmented value={view} options={['excerpt', 'full log'] as const} onChange={setView} />}>
          <pre className="mono text-fg-2 whitespace-pre-wrap break-all bg-sunken border border-line rounded-lg p-3 max-h-[420px] overflow-auto leading-relaxed">
            {log ? log.split('\n').map((l: string, i: number) => (
              <div key={i} className={/error|fail|assert|expected|✗|not ok/i.test(l) ? 'text-bad bg-bad/[0.06] -mx-3 px-3' : ''}>{l || ' '}</div>
            )) : <span className="text-fg-4">No log captured.</span>}
          </pre>
        </Panel>
      </div>

      <Panel title="Attempts" action={<span className="text-xs text-fg-3 num">fixer <span className="mono">{e.assignment?.fixerAgentId ?? '—'}</span> · {e.assignment?.attempt ?? 0}/{e.assignment?.maxAttempts ?? 3}</span>}>
        {(e.history ?? []).length === 0 && <Muted>No fix attempts yet.</Muted>}
        <ol className="relative border-l border-line ml-1.5 space-y-3">
          {(e.history ?? []).map((h: any, i: number) => (
            <li key={i} className="pl-4 relative">
              <span className={`absolute -left-[5px] top-1.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${h.outcome === 'fixed' ? 'bg-ok' : 'bg-bad'}`} />
              <div className="flex items-center gap-2 text-sm">
                <span className="mono text-fg">#{h.attempt}</span><span className="text-fg-2">{h.agentId}</span>
                <span className="mono text-fg-4">{h.commitSha?.slice(0, 8)}</span>
                <StatusChip value={h.outcome === 'fixed' ? 'pass' : 'fail'} />
                <span className="text-xs text-fg-4">{h.outcome}</span>
              </div>
            </li>
          ))}
        </ol>
        {e.resolution && (
          <div className="mt-4 p-3 rounded-lg bg-ok/[0.06] border border-ok/20 text-sm text-ok flex gap-2">
            <CheckCircle2 size={15} className="shrink-0 mt-0.5" />
            <span>Resolved {fmtAgo(e.resolution.resolvedAt)} — {e.resolution.summary} <span className="text-ok/60 mono text-xs">KB {e.resolution.kbEntryId?.slice(0, 8)}</span></span>
          </div>
        )}
      </Panel>
    </div>
  );
}
