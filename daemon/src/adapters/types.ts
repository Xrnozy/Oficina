import type { Account, Agent, ModelRow, Repo, Task, WorkItem, WorkItemResult } from '../types.ts';

// Spec 8.1: one adapter interface behind which model providers, hosted/CLI
// agent providers and manual (tier-3) providers all sit. The Office executes
// the tool loop for model providers; agent providers run their own loop and
// hand back through Git.

export interface AdapterCtx {
  workItem: WorkItem;
  task: Task | null;
  agent: Agent;
  account: Account | null;
  model: ModelRow | null;
  prompt: string;
  worktree: string | null;
  repo: Repo | null;
  emit: (type: string, payload: Record<string, unknown>) => void; // stream sub-events
  fetchQuotaHeaders?: (headers: Record<string, string>) => void;
}

export interface Adapter {
  id: string;
  version: string;
  dispatch(ctx: AdapterCtx): Promise<WorkItemResult>;
  sendMessage?(ref: string, text: string): Promise<void>;
  cancel?(ref: string): Promise<void>;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly kind: 'auth' | 'rate-limit' | 'server' | 'timeout' | 'network' | 'bad-response',
    public readonly headers?: Record<string, string>,
  ) { super(message); }
}
