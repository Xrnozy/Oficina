import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { anyGlobMatch, now, parseJson, ulid } from '../util.ts';
import type { ApprovalRequest, Policy, PolicyRule } from '../types.ts';

// Policy engine (spec 2.4, 6.3): policies attach to workspace/role/agent;
// forbid beats approve beats allow. Enforcement happens at dispatch/merge
// boundaries; risky actions become ApprovalRequests.

const PROTECTED_GLOBS = [
  '.github/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile',
  'tests/acceptance/**', 'office.checks.*', '.office/**', '.claude/**', '.cursor/**',
];
const DEPENDENCY_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'requirements.txt', 'Cargo.toml', 'go.mod'];

// ---------------------------------------------------------------------------
// Change-risk classifier (spec stage 5.1): decides whether an approval request
// is "risky" — files outside the task's declared paths, config/CI/secret or
// lockfile changes, deletions, a large diff, or checks that never ran.
// ---------------------------------------------------------------------------

const CI_GLOBS = ['.github/**', '.gitlab-ci.yml', 'azure-pipelines.yml', 'Jenkinsfile', '.circleci/**', '.buildkite/**', 'Dockerfile', 'docker-compose*.yml', 'docker-compose*.yaml'];
const CONFIG_GLOBS = ['*.config.js', '*.config.ts', '*.config.cjs', '*.config.mjs', '*.config.json', 'tsconfig*.json', '.npmrc', '.nvmrc', '.eslintrc*', '.prettierrc*'];
const SECRET_GLOBS = ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*credential*', '*secret*', 'id_rsa*', '*.keystore'];
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'go.sum', 'poetry.lock', 'composer.lock', 'Gemfile.lock', 'bun.lockb'];
const RISKY_GLOBS = [...CI_GLOBS, ...CONFIG_GLOBS, ...SECRET_GLOBS, ...LOCKFILES];
const LARGE_DIFF_CHARS = 60_000; // ~1.5k diff lines

export interface ChangeRisk { risky: boolean; reasons: string[] }

export function classifyChangeRisk(o: {
  files: (string | { path: string; status?: string; from?: string })[];
  declaredPaths?: string[];
  diffChars?: number;
  checksRan?: boolean;
  userFiles?: string[];       // paths the owner had already modified
  postTaskEdits?: string[];   // paths edited after the task finished
}): ChangeRisk {
  const reasons: string[] = [];
  const norm = o.files.map((f) => (typeof f === 'string' ? { path: f, status: undefined as string | undefined } : { path: f.path, status: f.status }));
  const declared = (o.declaredPaths ?? []).filter(Boolean);
  if (declared.length) {
    const outside = norm.map((f) => f.path).filter((p) => !anyGlobMatch(p, declared));
    if (outside.length) reasons.push(`files outside the task's declared paths: ${outside.slice(0, 6).join(', ')}${outside.length > 6 ? ` +${outside.length - 6} more` : ''}`);
  }
  const riskyFiles = norm.map((f) => f.path).filter((p) => anyGlobMatch(p, RISKY_GLOBS));
  if (riskyFiles.length) reasons.push(`config/CI/secret or lockfile changes: ${riskyFiles.slice(0, 6).join(', ')}${riskyFiles.length > 6 ? ` +${riskyFiles.length - 6} more` : ''}`);
  const deleted = norm.filter((f) => f.status === 'D').map((f) => f.path);
  if (deleted.length) reasons.push(`deletes ${deleted.length} file${deleted.length > 1 ? 's' : ''}: ${deleted.slice(0, 4).join(', ')}${deleted.length > 4 ? '…' : ''}`);
  if ((o.diffChars ?? 0) > LARGE_DIFF_CHARS) reasons.push(`large diff (~${Math.round((o.diffChars ?? 0) / 1000)}k chars)`);
  if (o.checksRan === false) reasons.push('no checks ran for this change');
  if (o.userFiles?.length) reasons.push(`includes files you had already modified: ${o.userFiles.slice(0, 4).join(', ')}${o.userFiles.length > 4 ? '…' : ''}`);
  if (o.postTaskEdits?.length) reasons.push(`edited after the task finished: ${o.postTaskEdits.slice(0, 4).join(', ')}${o.postTaskEdits.length > 4 ? '…' : ''}`);
  return { risky: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Approval policy modes (spec stage 5.1): workspace setting `approvalMode`.
//   always-ask      (default) every request waits in the inbox — as before
//   ask-when-risky  auto-approves low-risk change gates; risky + real
//                   decisions still ask
//   auto            auto-approves every risk-gate; genuine decisions
//                   (questions, escalations, plan/DoD content) still ask —
//                   a machine cannot answer them
// Auto-approved items are logged via `approval.auto` with the reasons.
// ---------------------------------------------------------------------------

export type ApprovalMode = 'always-ask' | 'ask-when-risky' | 'auto';

// Only risk-gated change approvals may self-resolve. Everything else is a
// question or a judgment call that needs a human, whatever the mode.
const AUTO_APPROVABLE = new Set(['commit.task', 'file.write.protected', 'deps.add']);

export function approvalModeForRun(runId: string | null): ApprovalMode {
  if (!runId) return 'always-ask';
  const ws = q1(`SELECT w.settings s FROM runs r JOIN workspaces w ON w.id = r.workspace_id WHERE r.id = ?`, runId)?.s;
  const m = parseJson<Record<string, unknown>>(ws as string, {}).approvalMode;
  return m === 'ask-when-risky' || m === 'auto' ? m : 'always-ask';
}

function maybeAutoApprove(a: ApprovalRequest): void {
  const mode = approvalModeForRun(a.runId);
  if (mode === 'always-ask' || !AUTO_APPROVABLE.has(a.action)) return;
  const risk = (a.payload as { risk?: ChangeRisk }).risk;
  const risky = !!risk?.risky;
  if (mode === 'ask-when-risky' && risky) return;
  const reason = mode === 'auto'
    ? `auto-approved (policy: auto)${risky ? ` despite risk: ${risk!.reasons.join('; ')}` : ''}`
    : 'auto-approved (policy: ask-when-risky): no risky changes';
  emit('approval.auto', 'engine', { approvalId: a.id, action: a.action, mode, risky, reasons: risk?.reasons ?? [] }, a.runId, a.id);
  decideApproval(a.id, true, reason);
}

export function rowToPolicy(r: Record<string, unknown>): Policy {
  return { id: r.id as string, scope: parseJson(r.scope as string, {}), rules: parseJson(r.rules as string, []) };
}

export function allPolicies(): Policy[] {
  return q('SELECT * FROM policies').map(rowToPolicy);
}

export function resolveAction(workspaceId: string, roleId: string | null, agentId: string | null, action: string): 'allow' | 'approve' | 'forbid' {
  let effect: 'allow' | 'approve' | 'forbid' | null = null;
  const rank = { allow: 0, approve: 1, forbid: 2 } as const;
  for (const p of allPolicies()) {
    const s = p.scope as Record<string, string>;
    const applies =
      (s.workspaceId && s.workspaceId === workspaceId) ||
      (s.roleId && roleId && s.roleId === roleId) ||
      (s.agentId && agentId && s.agentId === agentId) ||
      Object.keys(s).length === 0; // global default policy
    if (!applies) continue;
    for (const rule of p.rules as PolicyRule[]) {
      if (rule.action === action || rule.action === '*' || (rule.action.endsWith('*') && action.startsWith(rule.action.slice(0, -1)))) {
        if (effect === null || rank[rule.effect] > rank[effect]) effect = rule.effect;
      }
    }
  }
  return effect ?? 'allow';
}

export function requestApproval(opts: {
  action: string; payload: Record<string, unknown>; requestedBy: string;
  workItemId?: string | null; taskId?: string | null; runId?: string | null; expiresMin?: number;
}): ApprovalRequest {
  const id = ulid();
  const a: ApprovalRequest = {
    id, workItemId: opts.workItemId ?? null, taskId: opts.taskId ?? null, runId: opts.runId ?? null,
    action: opts.action, payload: opts.payload, requestedBy: opts.requestedBy, status: 'pending',
    reason: null, decidedAt: null,
    expiresAt: opts.expiresMin ? new Date(Date.now() + opts.expiresMin * 60000).toISOString() : null,
    createdAt: now(),
  };
  run(`INSERT INTO approvals (id, work_item_id, task_id, run_id, action, payload, requested_by, status, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, a.workItemId, a.taskId, a.runId, a.action, JSON.stringify(a.payload), a.requestedBy, 'pending', a.createdAt, a.expiresAt);
  // requested_by keeps the agent id (always-allow policies key on it); the event names the agent
  const actor = (q1('SELECT name FROM agents WHERE id = ?', opts.requestedBy)?.name as string) ?? opts.requestedBy;
  emit('approval.requested', actor, { approvalId: id, action: a.action, summary: payloadSummary(a) }, a.runId, id);
  maybeAutoApprove(a);
  const after = q1('SELECT status, reason FROM approvals WHERE id = ?', id);
  return { ...a, status: (after?.status as ApprovalRequest['status']) ?? a.status, reason: (after?.reason as string | null) ?? null };
}

function payloadSummary(a: ApprovalRequest): string {
  const p = a.payload as Record<string, unknown>;
  return (p.summary as string) ?? (p.title as string) ?? a.action;
}

export function decideApproval(id: string, approve: boolean, reason: string, alwaysAllowForAgent?: string): ApprovalRequest | null {
  const r = q1('SELECT * FROM approvals WHERE id = ?', id);
  if (!r) return null;
  run(`UPDATE approvals SET status = ?, reason = ?, decided_at = ? WHERE id = ?`,
    approve ? 'approved' : 'rejected', reason, now(), id);
  if (approve && alwaysAllowForAgent) {
    const existing = q1(`SELECT id FROM policies WHERE scope LIKE ?`, `%"agentId":"${alwaysAllowForAgent}"%`);
    const rule: PolicyRule = { action: r.action as string, effect: 'allow' };
    if (existing) {
      const p = rowToPolicy(existing);
      p.rules.push(rule);
      run(`UPDATE policies SET rules = ? WHERE id = ?`, JSON.stringify(p.rules), p.id);
    } else {
      run(`INSERT INTO policies (id, scope, rules) VALUES (?,?,?)`,
        ulid(), JSON.stringify({ agentId: alwaysAllowForAgent }), JSON.stringify([rule]));
    }
  }
  emit('approval.decided', 'owner', { approvalId: id, approved: approve, reason, action: r.action }, r.run_id as string | null, id);
  return { ...(r as unknown as ApprovalRequest), status: approve ? 'approved' : 'rejected', reason };
}

// --- delivery-time enforcement ------------------------------------------------

export function scanDeliveredFiles(files: string[]): { protectedHits: string[]; depChanges: string[] } {
  const protectedHits = files.filter((f) => anyGlobMatch(f, PROTECTED_GLOBS) && f !== 'HANDOFF.md');
  const depChanges = files.filter((f) => DEPENDENCY_FILES.includes(f));
  return { protectedHits, depChanges };
}
