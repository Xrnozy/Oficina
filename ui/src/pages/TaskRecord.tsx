import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { post, useEvents, useFetch } from '../api';
import { Muted, Panel, StatusChip, Tag, act, fmtAgo } from '../components';
import { DiffView } from '../diff';
import { GitCommitHorizontal } from 'lucide-react';

// The task's record, kept for good: the request, every prompt draft and the
// PM's review, the approved (authoritative) prompt, the work, the reviewer's
// findings, correction prompts, checks — and the task's changes and commit.

const STEP: Record<string, string> = {
  prompt: 'Prompt Creator draft', 'prompt-review': 'PM review of the prompt', implement: 'Implementation', fix: 'Correction',
  qa: 'Review & validation', review: 'Code review', accept: 'PM acceptance', analyse: 'Failure analysis', doc: 'Documentation', plan: 'Plan',
};

export function TaskRecord({ taskId }: { taskId: string }) {
  const { data: r, reload } = useFetch<any>(`/tasks/${taskId}/record`, [taskId]);
  useEvents((e) => { if (e.entityId === taskId || (e.payload as any)?.taskId === taskId) reload(); });
  if (!r) return <Panel title="Prompt & review record"><Muted>Loading…</Muted></Panel>;
  return (
    <Panel title="Prompt & review record" bodyClass="px-4 pb-4">
      <div className="space-y-3 text-sm">
        <div><div className="eyebrow mb-1">Original request</div><p className="text-fg-2">{r.request}</p></div>
        {r.approvedPrompt && (
          <details className="rounded-lg border border-ok/30 bg-ok/[0.04]">
            <summary className="px-3 py-2 cursor-pointer text-sm"><Tag tone="ok">Approved prompt</Tag> <span className="text-fg-3 text-xs">the authoritative requirements — corrections and reviews are measured against it</span></summary>
            <pre className="px-3 pb-3 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-96 overflow-y-auto">{r.approvedPrompt.text}</pre>
          </details>
        )}
        <ol className="space-y-1.5">
          {r.items.map((w: any) => (
            <li key={w.id}>
              <details className="group">
                <summary className="flex items-center gap-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden text-xs">
                  <StatusChip value={w.status} />
                  <span className="font-medium text-fg-2">{STEP[w.kind] ?? w.kind}</span>
                  {w.template?.endsWith('/approved') && <Tag tone="ok">approved prompt</Tag>}
                  <span className="text-fg-4">{w.agent ?? ''} · {w.at ? fmtAgo(w.at) : ''}</span>
                  {w.decision && <Tag tone={['approve', 'accept', 'pass'].includes(w.decision) ? 'ok' : 'warn'}>{w.decision}</Tag>}
                  {w.notes && <span className="text-fg-3 truncate max-w-[50%]">{String(w.notes)}</span>}
                </summary>
                <div className="pl-6 pt-1 space-y-1">
                  {w.draftedPrompt && <><div className="eyebrow">Draft</div><pre className="text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] p-2 rounded bg-sunken border border-line max-h-72 overflow-y-auto">{w.draftedPrompt}</pre></>}
                  {w.prompt && <><div className="eyebrow">Prompt this agent received</div><pre className="text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] p-2 rounded bg-sunken border border-line max-h-72 overflow-y-auto">{w.prompt}</pre></>}
                  {w.summary && <div className="text-xs text-fg-3">Result: {w.summary}</div>}
                  {w.filesChanged?.length > 0 && <div className="flex flex-wrap gap-1">{w.filesChanged.map((f: string) => <Tag key={f} mono>{f}</Tag>)}</div>}
                </div>
              </details>
            </li>
          ))}
        </ol>
        {r.checks.length > 0 && (
          <div><div className="eyebrow mb-1">Checks</div>
            <ul className="text-xs space-y-0.5">{r.checks.map((c: any, i: number) => <li key={i} className={c.status === 'pass' ? 'text-ok' : 'text-bad'}>{c.name}: {c.status} — {c.summary}</li>)}</ul>
          </div>
        )}
        {r.changeNotes && <details><summary className="cursor-pointer text-xs text-fg-3">Developer's change notes</summary><pre className="mt-1 text-xs whitespace-pre-wrap break-words [overflow-wrap:anywhere] p-2 rounded bg-sunken border border-line max-h-72 overflow-y-auto">{r.changeNotes}</pre></details>}
        {r.checkpoints.length > 0 && <div className="text-xs text-fg-3">{r.checkpoints.length} checkpoint(s) — <Link className="underline" to="/checkpoints">open Checkpoints</Link></div>}
      </div>
    </Panel>
  );
}

export function TaskChanges({ task }: { task: any }) {
  const { data, reload } = useFetch<any>(`/tasks/${task.id}/diff`, [task.id]);
  useEvents((e) => { if ((e.type === 'agent.diff' || e.type.startsWith('checkpoint.')) && ((e.payload as any)?.taskId === task.id)) reload(); });
  const commit = task.meta?.commitProposal;
  const [message, setMessage] = useState<string>(commit?.message ?? '');
  useEffect(() => { setMessage(commit?.message ?? ''); }, [commit?.message]);
  const committed = !!task.meta?.committedSha;
  if (!data?.files?.length && !commit) return null;
  return (
    <Panel title="Changes in the repository">
      <p className="text-xs text-fg-3 mb-2">{data?.status === 'open' ? 'Live — the task is still working.' : 'Written to the working tree.'} Your own uncommitted changes from before the task are not included.</p>
      <DiffView diff={data?.diff ?? ''} empty="No file changes." />
      {commit && !committed && (
        <div className="mt-4 space-y-2">
          <div className="eyebrow flex items-center gap-1.5"><GitCommitHorizontal size={12} /> Proposed commit — {commit.paths?.length ?? 0} file(s), only this task's</div>
          <textarea className="input w-full h-36 mono text-xs" value={message} onChange={(e) => setMessage(e.target.value)} />
          <div className="flex justify-end gap-2">
            <button className="btn btn-primary btn-sm" disabled={!message.trim()} onClick={async () => { if (await act(post(`/tasks/${task.id}/commit`, { message }), 'Committed')) reload(); }}>Commit</button>
          </div>
        </div>
      )}
    </Panel>
  );
}
