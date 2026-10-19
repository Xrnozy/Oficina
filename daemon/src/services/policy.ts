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
  return a;
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
