import type { Adapter, AdapterCtx } from './types.ts';
import type { WorkItemResult } from '../types.ts';

// Manual adapter (spec tier 3): the Office prepares a prompt card; a human
// runs it in a consumer tool (Cursor IDE, claude.ai, …) and submits the
// result through the API. dispatch() never resolves by itself — the engine
// leaves the work item in `waiting` until POST /workitems/:id/manual-result.

const pending = new Map<string, (r: WorkItemResult) => void>();

export function resolveManual(workItemId: string, result: WorkItemResult): boolean {
  const fn = pending.get(workItemId);
  if (!fn) return false;
  pending.delete(workItemId);
  fn(result);
  return true;
}

export const manualAdapter: Adapter = {
  id: 'manual',
  version: '1.0.0',

  dispatch(ctx: AdapterCtx): Promise<WorkItemResult> {
    ctx.emit('agent.output', { line: '[manual] prompt card ready — waiting for a human' });
    return new Promise<WorkItemResult>((resolve) => {
      pending.set(ctx.workItem.id, resolve);
    });
  },
};
