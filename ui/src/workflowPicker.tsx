import { Select } from './Select';
import React from 'react';
import { GitBranch } from 'lucide-react';
import { post, useQuery } from './api';
import { act } from './components';
import type { WorkflowRow } from './workflow';

// Choose which workflow a request (or a run) follows. '' = the workspace
// default (the active workflow), 'builtin' = the standard pipeline.

export function WorkflowSelect({ wsId, value, onChange, disabled, className = '', title }: {
  wsId: string | undefined; value: string; onChange: (v: string) => void; disabled?: boolean; className?: string; title?: string;
}) {
  const { data } = useQuery<WorkflowRow[]>(wsId ? `/workflows?workspaceId=${wsId}` : null, [wsId]);
  const list = data ?? [];
  const active = list.find((w) => w.active && !w.builtin);
  return (
    <Select className={`input ${className}`} value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value)} aria-label="Workflow">
      <option value="">{active ? `Workspace default · ${active.name}` : 'Workspace default · Standard pipeline'}</option>
      {list.map((w) => (
        <option key={w.id} value={w.builtin ? 'builtin' : w.id}>
          {w.builtin ? 'Standard pipeline' : w.name}{w.versionN != null && !w.builtin ? ` · v${w.versionN}` : ''}
        </option>
      ))}
    </Select>
  );
}

// Live control for an existing run: shows the workflow it follows and lets
// the owner switch it while the run is paused or waiting for plan approval.
export function RunWorkflow({ run, onChanged }: { run: any; onChanged?: () => void }) {
  const { data } = useQuery<WorkflowRow[]>(run?.workspaceId ? `/workflows?workspaceId=${run.workspaceId}` : null, [run?.workspaceId]);
  const switchable = ['draft', 'dod-review', 'paused'].includes(run?.status);
  const current = run?.workflow?.id ?? 'builtin';
  const list = data ?? [];
  const pick = async (id: string) => {
    if (!id || id === current) return;
    const r = await act(post(`/runs/${run.id}/workflow`, { workflowId: id }), 'Workflow changed for this run');
    if (r) onChanged?.();
  };
  return (
    <label className="flex items-center gap-2 text-xs text-fg-3" title={switchable ? 'Change the workflow this run follows' : 'Pause the run to change its workflow'}>
      <GitBranch size={13} className="shrink-0" />
      <span className="hidden sm:inline">Workflow</span>
      <Select className="input input-sm !w-auto max-w-[220px]" value={current} disabled={!switchable} onChange={(e) => void pick(e.target.value)} aria-label="Run workflow">
        {list.map((w) => <option key={w.id} value={w.builtin ? 'builtin' : w.id}>{w.builtin ? 'Standard pipeline' : w.name}</option>)}
        {!list.length && <option value="builtin">Standard pipeline</option>}
      </Select>
      {!switchable && <span className="text-2xs text-fg-4">pause to change</span>}
    </label>
  );
}
