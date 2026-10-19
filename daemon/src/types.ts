// Domain types per spec section 4. JSON columns are stored serialized in SQLite.

export type ProviderKind = 'model' | 'agent' | 'manual';
export type Tier = 1 | 2 | 3;

export interface Capabilities {
  models: ModelInfo[];
  settings: Record<string, unknown>;
  reasoningVisibility: 'full' | 'summary' | 'none';
  observability: 'full' | 'actions' | 'status-only' | 'manual';
  midSessionMessages: boolean;
  suspendResume: boolean;
  webhooks: boolean;
  usageData: { perResponse: boolean; accountApi: boolean; resetTimes: 'exact' | 'none' };
  mcp: boolean;
  nativeSkills: boolean;
}

export interface ModelInfo {
  name: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  priceIn?: number;   // $ per 1M input tokens
  priceOut?: number;  // $ per 1M output tokens
  strengthTier?: 'fast' | 'standard' | 'strong';
}

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  adapterId: string;
  adapterVersion: string;
  adapterHash: string;
  tier: Tier;
  enabled: number;
  capabilities: Capabilities;
  config: Record<string, unknown>;
}

export interface Account {
  id: string;
  providerId: string;
  label: string;
  secretRef: string | null;   // "env:VAR" | "local:name" | null
  plan: string | null;
  billing: 'payg' | 'subscription' | 'credits';
  monthlyBudgetUsd: number | null;
  enabled: number;
  config: Record<string, unknown>;
}

export interface ModelRow {
  id: string;
  providerId: string;
  name: string;
  contextTokens: number;
  maxOutputTokens: number;
  priceIn: number;
  priceOut: number;
  strengthTier: 'fast' | 'standard' | 'strong';
  supports: Record<string, unknown>;
}

export interface Role {
  id: string;
  name: string;
  version: number;
  responsibilities: string[];
  allowedActions: string[];
  defaultInstructions: string;
  defaultSkills: string[];
}

export interface AgentCaps { perTaskUsd: number; perDayUsd: number; maxTokensPerCall: number; }

export interface Agent {
  id: string;
  name: string;
  avatar: string;
  accountId: string | null;
  modelId: string | null;
  settings: Record<string, unknown>;
  instructions: string;
  skillVersionIds: string[];
  caps: AgentCaps;
  observability: 'full' | 'actions' | 'status-only' | 'manual';
  status: string; // derived: working|thinking|waiting|reviewing|blocked|idle|done|offline
}

export interface Workspace {
  id: string;
  name: string;
  purpose: string;
  repoIds: string[];
  allowedProviderIds: string[];
  policyId: string | null;
  memoryScope: string;
  settings: Record<string, unknown>;
}

export interface Membership {
  id: string;
  agentId: string;
  workspaceId: string;
  roleId: string;
  team: string | null;
  permissionsOverride: Record<string, unknown> | null;
  contextScope: string;
  activeSince: string;
  maxConcurrentTasks: number;
  active: number;
}

export interface Repo {
  id: string;
  workspaceId: string;
  path: string;
  remoteUrl: string | null;
  defaultBranch: string;
  integrationBranch: string;
  buildCmd: string;
  testCmd: string;
  checkProfileId: string | null;
}

export type CheckKind = 'build' | 'typecheck' | 'lint' | 'unit' | 'integration' | 'e2e' | 'coverage' | 'security' | 'custom' | 'review' | 'doc';

export interface Check {
  id: string;
  repoId: string;
  name: string;
  kind: CheckKind;
  command: string;
  parser: string;
  passRule: string;
  timeoutSec: number;
  affectedPaths: string[];
  protected: number;
}

export type ActionType = string;
export interface PolicyRule { action: ActionType; effect: 'allow' | 'approve' | 'forbid'; condition?: string; }
export interface Policy { id: string; scope: Record<string, string>; rules: PolicyRule[]; }

export type RunStatus = 'draft' | 'dod-review' | 'running' | 'pausing' | 'paused' | 'verifying' | 'done' | 'stopped';

export interface Budget { runUsd: number; taskUsd: number; warnPct: number; }
export interface StopLimits {
  maxCycles: number; maxWallclockMin: number; maxParallel: number;
  sameErrorAttempts: number; noProgressCycles: number; disagreeK: number;
  stuckAgentMinApi: number; stuckAgentMinHosted: number; cycleMaxMinutes: number;
}

export interface Run {
  id: string;
  workspaceId: string;
  repoId: string;
  goal: string;
  status: RunStatus;
  dodId: string | null;
  budget: Budget;
  limits: StopLimits;
  currentCycle: number;
  planVersion: number;
  startedAt: string | null;
  checkpointId: string | null;
  stopReason: string | null;
  progressScore: number;
  spentUsd: number;
}

export interface Cycle {
  id: string;
  runId: string;
  n: number;
  phase: string;
  startedAt: string;
  endedAt: string | null;
  progressScore: number;
  spendUsd: number;
  summary: string;
}

export type TaskStatus =
  | 'backlog' | 'ready' | 'assigned' | 'in-progress' | 'waiting-input'
  | 'blocked-quota' | 'verifying' | 'in-review' | 'changes-requested'
  | 'approved' | 'done' | 'failed' | 'cancelled' | 'blocked';

export type TaskType = 'feature' | 'infra' | 'refactor' | 'test' | 'docs' | 'fix' | 'review';

export interface Task {
  id: string;
  runId: string;
  parentId: string | null;
  title: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  deadline: string | null;
  dependsOn: string[];
  acceptanceCriteria: string[];
  deliverables: string[];
  ownerAgentId: string | null;
  reviewerAgentId: string | null;
  plannedBy: string | null;
  branch: string | null;
  worktree: string | null;
  difficulty: number;
  attempts: number;
  budgetUsd: number;
  spentUsd: number;
  dodItemIds: string[];
  affectedPaths: string[];
  meta: Record<string, unknown>;
}

export type WorkItemKind = 'plan' | 'implement' | 'review' | 'test' | 'analyse' | 'fix' | 'doc' | 'prompt' | 'prompt-review' | 'qa' | 'accept' | 'diagnose';

// Per-agent model configuration (kept in agents.settings). Which fields a
// backend honours is described by settingsSupport() in services/models.ts.
export interface AgentModelSettings {
  reasoningEffort?: 'auto' | 'off' | 'low' | 'medium' | 'high'; // auto: sized per work item by the router
  temperature?: number;
  maxOutputTokens?: number;
  contextTokens?: number;
  fallbacks?: { accountId: string; modelId: string | null }[];
}

export type MessageKind = 'question' | 'finding' | 'help' | 'challenge' | 'handoff' | 'decision' | 'note';
export interface AgentMessage {
  id: string; runId: string | null; taskId: string | null; workItemId: string | null;
  fromAgent: string; toAgent: string | null; toRole: string | null;
  kind: MessageKind; text: string; createdAt: string; readAt: string | null;
}
export type WorkItemStatus = 'queued' | 'running' | 'waiting' | 'delivered' | 'failed' | 'cancelled' | 'interrupted';

export interface WorkItemResult {
  summary: string;
  branch?: string;
  sha?: string;
  prUrl?: string;
  filesChanged?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd: number; costSource: 'provider' | 'computed' | 'estimate' };
  raw?: unknown;
}

export interface WorkItem {
  id: string;
  taskId: string | null;
  runId: string;
  kind: WorkItemKind;
  agentId: string;
  accountId: string | null;
  modelId: string | null;
  promptVersionId: string | null;
  idempotencyKey: string;
  status: WorkItemStatus;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  result: WorkItemResult | null;
  adapterRef: string | null;
  errorSignature: string | null;
  attempt: number;
}

export interface PromptVersion {
  id: string;
  workItemId: string | null;
  templateId: string;
  version: number;
  renderedText: string;
  contextPackHash: string;
  editedByUser: number;
  createdAt: string;
}

export interface CheckRun {
  id: string;
  checkId: string;
  workItemId: string | null;
  taskId: string | null;
  runId: string;
  commitSha: string | null;
  ref: string;
  status: 'pass' | 'fail' | 'error' | 'flaky';
  durationMs: number;
  evidenceRefs: string[];
  summary: string;
  failures: { name: string; file?: string; message?: string }[];
  createdAt: string;
}

export type ErrorSeverity = 'critical' | 'high' | 'medium' | 'low';
export type ErrorStatus = 'open' | 'assigned' | 'fixing' | 'verifying' | 'resolved' | 'reopened' | 'escalated' | 'wontfix';

export interface ErrorReport {
  id: string;
  seqNo: number;
  runId: string;
  cycleN: number;
  taskId: string | null;
  workItemId: string | null;
  severity: ErrorSeverity;
  status: ErrorStatus;
  failingCheck: { checkId: string; checkRunId: string; commitSha: string | null; command: string; exitCode: number | null };
  title: string;
  evidence: { logExcerpt: string; stackTrace?: string; fullLogRef?: string; failingTests?: { name: string; file?: string; message?: string }[] };
  reproduction: { steps: string[]; command: string; env: Record<string, string> };
  affectedFiles: { path: string; lines?: [number, number] }[];
  suspectedCause: { summary: string; confidence: 'low' | 'medium' | 'high'; reasoningSource: 'analyst' | 'rules' };
  signature: string;
  relatedErrors: { id: string; similarity: number; resolution?: string }[];
  suggestedFix: { approach: string; difficulty: number; suggestedRole: string; avoid?: string[] };
  assignment: { fixerAgentId: string | null; assignedAt: string | null; attempt: number; maxAttempts: number };
  history: { attempt: number; agentId: string; commitSha: string | null; checkRunId: string; outcome: string }[];
  escalation: { to: string; reason: string; at: string } | null;
  resolution: { commitSha: string | null; summary: string; verifiedByCheckRunId: string; resolvedAt: string; kbEntryId: string } | null;
}

export interface ApprovalRequest {
  id: string;
  workItemId: string | null;
  taskId: string | null;
  runId: string | null;
  action: string;
  payload: Record<string, unknown>;
  requestedBy: string;
  status: 'pending' | 'approved' | 'rejected';
  reason: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface OfficeEvent {
  seq: number;
  runId: string | null;
  ts: string;
  actor: string;
  type: string;
  entityId: string | null;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface UsageRecord {
  id: string; accountId: string; modelId: string | null; workItemId: string | null; ts: string;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; requests: number;
  costUsd: number; costSource: string;
}

export interface QuotaWindow {
  id: string; accountId: string; modelId: string | null; metric: string; kind: string; period: string;
  lim: number | null; used: number | null; remaining: number | null; resetsAt: string | null;
  source: 'official-api' | 'response-header' | 'estimate' | 'manual-entry';
  confidence: 'exact' | 'approximate' | 'unknown'; observedAt: string;
}

export interface Handoff {
  id: string; runId: string; taskId: string; fromAgent: string; toAgent: string;
  kind: 'deliver' | 'review' | 'fix' | 'question' | 'reassign';
  summary: string; artifacts: Record<string, unknown>; createdAt: string;
}

export interface Timer { id: string; runId: string | null; fireAt: string; type: string; payload: Record<string, unknown>; }

export interface SkillRow { id: string; name: string; description: string; ownerOrigin: 'local' | 'imported'; sourceUrl: string | null; latestVersionId: string | null; enabled: number; }
export interface SkillVersionRow {
  id: string; skillId: string; semver: string; contentHash: string; manifest: Record<string, unknown>;
  reviewStatus: 'unreviewed' | 'approved' | 'rejected'; reviewedAt: string | null; reviewNotes: string | null;
  createdAt: string; files: { path: string; sha256: string; size: number }[];
}

export interface PlanTaskSpec {
  key: string; title: string; description: string; type: TaskType;
  priority: number; difficulty: number; dependsOn: string[];
  acceptanceCriteria: string[]; deliverables?: string[];
  affectedPaths: string[]; dodItemIds: string[];
  budgetUsd: number; meta?: Record<string, unknown>;
}

export interface PlanDiff {
  add?: PlanTaskSpec[];
  cancel?: string[];
  reprioritize?: { taskId: string; priority: number }[];
  notes?: string;
}

export interface DodItem {
  id: string; text: string; kind: 'feature' | 'quality' | 'review' | 'docs';
  checks: string[]; optional?: boolean; status?: 'pass' | 'fail' | 'pending';
}

export interface Dod {
  id: string; runId: string; version: number; items: DodItem[]; status: 'draft' | 'approved' | 'superseded';
}
