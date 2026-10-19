import { parseJson } from './util.ts';
import type { Budget, Cycle, Run, StopLimits, Task, WorkItem } from './types.ts';

const DEFAULT_LIMITS: StopLimits = {
  maxCycles: 30, maxWallclockMin: 2880, maxParallel: 3,
  sameErrorAttempts: 3, noProgressCycles: 3, disagreeK: 3,
  stuckAgentMinApi: 10, stuckAgentMinHosted: 45, cycleMaxMinutes: 60,
};

export function rowToRun(r: Record<string, unknown>): Run {
  return {
    id: r.id as string, workspaceId: r.workspace_id as string, repoId: r.repo_id as string,
    goal: r.goal as string, status: r.status as Run['status'], dodId: r.dod_id as string | null,
    budget: parseJson<Budget>(r.budget as string, { runUsd: 50, taskUsd: 10, warnPct: 80 }),
    limits: parseJson<StopLimits>(r.limits as string, DEFAULT_LIMITS), currentCycle: r.current_cycle as number,
    planVersion: r.plan_version as number, startedAt: r.started_at as string | null,
    checkpointId: r.checkpoint_id as string | null, stopReason: r.stop_reason as string | null,
    progressScore: r.progress_score as number, spentUsd: r.spent_usd as number,
    workflowVersionId: (r.workflow_version_id as string | null) ?? null,
  };
}

export function rowToTask(r: Record<string, unknown>): Task {
  return {
    id: r.id as string, runId: r.run_id as string, parentId: r.parent_id as string | null,
    title: r.title as string, description: r.description as string, type: r.type as Task['type'],
    status: r.status as Task['status'], priority: r.priority as number, deadline: r.deadline as string | null,
    dependsOn: parseJson(r.depends_on as string, []), acceptanceCriteria: parseJson(r.acceptance_criteria as string, []),
    deliverables: parseJson(r.deliverables as string, []), ownerAgentId: r.owner_agent_id as string | null,
    reviewerAgentId: r.reviewer_agent_id as string | null, plannedBy: r.planned_by as string | null,
    branch: r.branch as string | null, worktree: r.worktree as string | null,
    difficulty: r.difficulty as number, attempts: r.attempts as number,
    budgetUsd: r.budget_usd as number, spentUsd: r.spent_usd as number,
    dodItemIds: parseJson(r.dod_item_ids as string, []), affectedPaths: parseJson(r.affected_paths as string, []),
    meta: parseJson(r.meta as string, {}),
  };
}

export function rowToWorkItem(r: Record<string, unknown>): WorkItem {
  return {
    id: r.id as string, taskId: r.task_id as string | null, runId: r.run_id as string,
    kind: r.kind as WorkItem['kind'], agentId: (r.agent_id as string) ?? '',
    accountId: r.account_id as string | null, modelId: r.model_id as string | null,
    promptVersionId: r.prompt_version_id as string | null, idempotencyKey: (r.idempotency_key as string) ?? '',
    cacheKey: r.cache_key as string | null,
    status: r.status as WorkItem['status'], startedAt: (r.started_at as string) ?? null,
    heartbeatAt: r.heartbeat_at as string | null, finishedAt: r.finished_at as string | null,
    result: r.result ? parseJson(r.result as string, null) : null,
    adapterRef: r.adapter_ref as string | null, errorSignature: r.error_signature as string | null,
    attempt: r.attempt as number,
    workflowNodeId: (r.workflow_node_id as string | null) ?? null,
    workflowEdgeId: (r.workflow_edge_id as string | null) ?? null,
  };
}

export function rowToCycle(r: Record<string, unknown>): Cycle {
  return {
    id: r.id as string, runId: r.run_id as string, n: r.n as number, phase: r.phase as string,
    startedAt: r.started_at as string, endedAt: r.ended_at as string | null,
    progressScore: r.progress_score as number, spendUsd: r.spend_usd as number, summary: r.summary as string,
  };
}
