import { q, q1 } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import type { Account, Agent, Membership, ModelRow, Provider, Role, Task, WorkItemKind, Workspace } from '../types.ts';
import { circuitOk, estimatedWindows, rateLimitRetryAfterSec, windowBlocking } from './usage.ts';
import { getAdapter } from '../adapters/index.ts';
import type { AdapterCtx } from '../adapters/types.ts';
import type { WorkItemResult } from '../types.ts';
import { recordUsage, circuitFailure, circuitSuccess, markRateLimited, upsertWindowsFromHeaders } from './usage.ts';
import { modelSettings } from './models.ts';
import { EFFORT_FOR_TIER, estimateWorkItemCost, requiredTier, routeChain } from './routing.ts';
import { run } from '../db.ts';

// Router (spec 8.4): picks an eligible agent for each work item under
// policy, quota and separation-of-duties rules; walks a fallback when the
// first candidate fails; tracks circuits and quota windows.

export function rowToAgent(r: Record<string, unknown>): Agent {
  return {
    id: r.id as string, name: r.name as string, avatar: r.avatar as string,
    accountId: r.account_id as string | null, modelId: r.model_id as string | null,
    settings: parseJson(r.settings as string, {}), instructions: r.instructions as string,
    skillVersionIds: parseJson(r.skill_version_ids as string, []), caps: parseJson(r.caps as string, { perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }),
    observability: r.observability as Agent['observability'], status: r.status as string,
  };
}

export function getAgent(id: string | null | undefined): Agent | undefined {
  if (!id) return undefined;
  const r = q1('SELECT * FROM agents WHERE id = ?', id);
  return r ? rowToAgent(r) : undefined;
}

export function getAccount(id: string | null | undefined): Account | undefined {
  if (!id) return undefined;
  const r = q1('SELECT * FROM accounts WHERE id = ?', id);
  if (!r) return undefined;
  return {
    id: r.id as string, providerId: r.provider_id as string, label: r.label as string,
    secretRef: r.secret_ref as string | null, plan: r.plan as string | null,
    billing: r.billing as Account['billing'], monthlyBudgetUsd: r.monthly_budget_usd as number | null,
    enabled: r.enabled as number, config: parseJson(r.config as string, {}),
  };
}

export function getProvider(id: string | null | undefined): Provider | undefined {
  if (!id) return undefined;
  const r = q1('SELECT * FROM providers WHERE id = ?', id);
  if (!r) return undefined;
  return {
    id: r.id as string, name: r.name as string, kind: r.kind as Provider['kind'],
    adapterId: r.adapter_id as string, adapterVersion: r.adapter_version as string,
    adapterHash: r.adapter_hash as string, tier: r.tier as Provider['tier'], enabled: r.enabled as number,
    capabilities: parseJson(r.capabilities as string, {} as Provider['capabilities']), config: parseJson(r.config as string, {}),
  };
}

export function getModel(id: string | null | undefined): ModelRow | undefined {
  if (!id) return undefined;
  const r = q1('SELECT * FROM models WHERE id = ?', id);
  if (!r) return undefined;
  return {
    id: r.id as string, providerId: r.provider_id as string, name: r.name as string,
    contextTokens: r.context_tokens as number, maxOutputTokens: r.max_output_tokens as number,
    priceIn: r.price_in as number, priceOut: r.price_out as number,
    strengthTier: r.strength_tier as ModelRow['strengthTier'], supports: parseJson(r.supports as string, {}),
  };
}

export function getRole(id: string | null | undefined): Role | undefined {
  if (!id) return undefined;
  const r = q1('SELECT * FROM roles WHERE id = ?', id);
  if (!r) return undefined;
  return {
    id: r.id as string, name: r.name as string, version: r.version as number,
    responsibilities: parseJson(r.responsibilities as string, []), allowedActions: parseJson(r.allowed_actions as string, []),
    defaultInstructions: r.default_instructions as string, defaultSkills: parseJson(r.default_skills as string, []),
  };
}

export function roleIdByName(name: string): string | null {
  const r = q1('SELECT id FROM roles WHERE name = ?', name);
  return (r?.id as string) ?? null;
}

export interface Candidate {
  agent: Agent; membership: Membership; account: Account | null;
  provider: Provider | null; model: ModelRow | null; role: Role;
  blocked?: string;
  substituted?: string; // primary model unusable — candidate starts on a fallback model
}

function blockReason(provider: Provider | undefined | null, account: Account | undefined | null, model: ModelRow | undefined | null, allowedProviders: string[]): string | undefined {
  if (!provider) return 'no provider';
  if (!provider.enabled) return 'provider disabled';
  if (allowedProviders.length && !allowedProviders.includes(provider.id)) return 'provider not allowed in workspace';
  if (account && !account.enabled) return 'account disabled';
  if (account && !circuitOk(account.id, model?.id)) return 'circuit open';
  if (account && windowBlocking(account.id, 0, model?.id ?? null)) return 'quota exhausted';
  // monthly budget is a hard stop: the router moves on to the next option
  if (account?.monthlyBudgetUsd && estimatedWindows(account.id, account.monthlyBudgetUsd).some((w) => (w.remaining ?? 1) <= 0)) return 'monthly budget reached';
  return undefined;
}

// 'smart' (default) routes per work item (services/routing.ts); 'fixed' keeps
// the agent's own model first and only falls back on failure.
export function routingStrategy(workspaceId: string | null | undefined): 'smart' | 'fixed' {
  if (!workspaceId) return 'smart';
  const ws = q1('SELECT settings FROM workspaces WHERE id = ?', workspaceId);
  return parseJson<Record<string, unknown>>(ws?.settings as string, {}).routing === 'fixed' ? 'fixed' : 'smart';
}

const TIER_RANK = { fast: 0, standard: 1, strong: 2 } as const;

function modelsOn(providerId: string): ModelRow[] {
  return q('SELECT * FROM models WHERE provider_id = ? ORDER BY name', providerId).map((r) => getModel(r.id as string)!).filter(Boolean);
}

// When every configured option is blocked (rate limit, quota), keep working
// on another model of the same backend, then one model from each other backend.
function autoAlternates(c: Candidate, allowedProviders: string[], already: Candidate[]): Candidate[] {
  const tier = c.model?.strengthTier ?? 'standard';
  const seen = new Set(already.map((x) => `${x.account?.id}|${x.model?.id ?? ''}`));
  const accounts = q('SELECT id FROM accounts WHERE enabled = 1').map((r) => getAccount(r.id as string)!).filter(Boolean);
  const ordered = [...accounts.filter((a) => a.id === c.account?.id), ...accounts.filter((a) => a.id !== c.account?.id)];
  const out: Candidate[] = [];
  for (const account of ordered) {
    const provider = getProvider(account.providerId);
    if (!provider) continue;
    const take = account.id === c.account?.id ? 3 : 1;
    const models = modelsOn(provider.id)
      .filter((m) => !seen.has(`${account.id}|${m.id}`) && !windowBlocking(account.id, 0, m.id))
      .sort((a, b) => Math.abs(TIER_RANK[a.strengthTier] - TIER_RANK[tier]) - Math.abs(TIER_RANK[b.strengthTier] - TIER_RANK[tier])
        || TIER_RANK[b.strengthTier] - TIER_RANK[a.strengthTier]);
    let n = 0;
    for (const model of models) {
      const blocked = blockReason(provider, account, model, allowedProviders);
      if (blocked) continue;
      seen.add(`${account.id}|${model.id}`);
      out.push({ ...c, account, provider, model, blocked: undefined, substituted: 'quota exhausted' });
      if (++n >= take) break;
    }
  }
  return out;
}

// The agent's own model first, then its configured fallback models in
// priority order (spec 4). The agent — and so its role, instructions and the
// prompt carrying task state — stays the same; only the backend changes.
// If all of those are unavailable, other models on this machine are appended.
export function modelChain(c: Candidate, allowedProviders: string[] = []): Candidate[] {
  const out: Candidate[] = [{ ...c, blocked: blockReason(c.provider, c.account, c.model, allowedProviders) }];
  for (const fb of modelSettings(c.agent.settings).fallbacks ?? []) {
    const account = getAccount(fb.accountId);
    if (!account) continue;
    const provider = getProvider(account.providerId);
    const model = getModel(fb.modelId) ?? null;
    if (model && model.providerId !== account.providerId) continue; // incompatible pair
    out.push({ ...c, account, provider: provider ?? null, model, blocked: blockReason(provider, account, model, allowedProviders), substituted: undefined });
  }
  if (out.some((x) => !x.blocked && x.provider)) return out;
  return [...out, ...autoAlternates(c, allowedProviders, out)];
}

function workspaceAllowed(workspaceId: string | null | undefined): string[] {
  if (!workspaceId) return [];
  const ws = q1('SELECT allowed_provider_ids FROM workspaces WHERE id = ?', workspaceId);
  return parseJson<string[]>(ws?.allowed_provider_ids as string, []);
}

export function backendLabel(c: { provider: Provider | null; model: ModelRow | null; account: Account | null }): string {
  return `${c.provider?.name ?? c.account?.providerId ?? '?'} / ${c.model?.name ?? 'default'}`;
}

// Per-agent spend caps (agents.caps): perDayUsd across all work, perTaskUsd on one task.
export function capBlock(agent: Agent, taskId: string | null): string | undefined {
  const spent = (sql: string, ...p: unknown[]) => (q1(sql, ...p)?.c as number) ?? 0;
  const day = new Date().toISOString().slice(0, 10);
  if (agent.caps?.perDayUsd > 0 && spent(`SELECT COALESCE(SUM(u.cost_usd),0) c FROM usage_records u JOIN work_items w ON w.id = u.work_item_id WHERE w.agent_id = ? AND u.ts >= ?`, agent.id, `${day}T00:00:00`) >= agent.caps.perDayUsd) return 'daily spend cap reached';
  if (taskId && agent.caps?.perTaskUsd > 0 && spent(`SELECT COALESCE(SUM(u.cost_usd),0) c FROM usage_records u JOIN work_items w ON w.id = u.work_item_id WHERE w.agent_id = ? AND w.task_id = ?`, agent.id, taskId) >= agent.caps.perTaskUsd) return 'per-task spend cap reached';
  return undefined;
}

const PM_COMPATIBLE_ROLES = ['pm', 'docs', 'prompt-creator'];

/** One specific agent as a candidate, through any role it holds in this office (the owner chose it; no role restriction applies). */
export function candidateForAgent(workspaceId: string, agentId: string): Candidate | null {
  const roles = q('SELECT DISTINCT role_id FROM memberships WHERE agent_id = ? AND workspace_id = ? AND active = 1', agentId, workspaceId);
  let blocked: Candidate | null = null;
  for (const m of roles) {
    const name = q1('SELECT name FROM roles WHERE id = ?', m.role_id as string)?.name as string | undefined;
    const c = name ? candidatesForRole(workspaceId, name).find((x) => x.agent.id === agentId) : undefined;
    if (c && !c.blocked) return c;
    if (c) blocked = c;
  }
  return blocked;
}

export function candidatesForRole(workspaceId: string, roleName: string): Candidate[] {
  const roleId = roleIdByName(roleName);
  if (!roleId) return [];
  const allowedProviders = workspaceAllowed(workspaceId);
  // The PM never codes: an agent that holds the PM role is not a candidate
  // for coding, review, testing or analysis work. It may also write docs and
  // prompts — those are not code.
  const pmRoleId = roleIdByName('pm');
  const pmMayAlso = PM_COMPATIBLE_ROLES.includes(roleName);
  const rows = q(`SELECT m.*, a.id AS aid FROM memberships m JOIN agents a ON a.id = m.agent_id
                  WHERE m.workspace_id = ? AND m.role_id = ? AND m.active = 1
                    AND (? = 1 OR a.id NOT IN (SELECT agent_id FROM memberships WHERE workspace_id = ? AND role_id = ? AND active = 1))`,
    workspaceId, roleId, pmMayAlso ? 1 : 0, workspaceId, pmRoleId);
  const out: Candidate[] = [];
  for (const r of rows) {
    const agent = getAgent(r.agent_id as string)!;
    const account = getAccount(agent.accountId);
    const provider = getProvider(account?.providerId);
    const model = getModel(agent.modelId);
    const role = getRole(roleId)!;
    const membership: Membership = {
      id: r.id as string, agentId: r.agent_id as string, workspaceId: r.workspace_id as string,
      roleId: r.role_id as string, team: r.team as string | null,
      permissionsOverride: r.permissions_override ? parseJson(r.permissions_override as string, {}) : null,
      contextScope: r.context_scope as string, activeSince: r.active_since as string,
      maxConcurrentTasks: r.max_concurrent_tasks as number, active: r.active as number,
    };
    const c: Candidate = { agent, membership, account: account ?? null, provider: provider ?? null, model: model ?? null, role };
    // an agent is only unavailable when its own model AND every fallback is
    const capped = capBlock(agent, null);
    if (capped) { out.push({ ...c, blocked: capped }); continue; }
    const chain = modelChain(c, allowedProviders);
    const usable = chain.find((x) => !x.blocked);
    if (!usable) out.push({ ...c, blocked: chain[0].blocked });
    else if (usable === chain[0]) out.push({ ...c });
    else out.push({ ...usable, substituted: chain[0].blocked });
  }
  return out;
}

// Separation of duties (spec 6.4): author != reviewer; reviewer excluded from
// fixer candidates on tasks they reviewed.
export function sodOk(candidate: Candidate, task: Task | null, kind: WorkItemKind): { ok: boolean; reason?: string } {
  if (!task) return { ok: true };
  if (kind === 'review') {
    if (task.ownerAgentId === candidate.agent.id) return { ok: false, reason: 'author cannot review own work' };
    const fixers = q(`SELECT DISTINCT agent_id FROM work_items WHERE task_id = ? AND kind = 'fix'`, task.id);
    if (fixers.some((f) => f.agent_id === candidate.agent.id)) return { ok: false, reason: 'fixer cannot review own fix' };
  }
  if ((kind === 'fix' || kind === 'implement') && task.reviewerAgentId === candidate.agent.id) {
    return { ok: false, reason: 'reviewer cannot fix what they review' };
  }
  return { ok: true };
}

export function pickAgent(workspaceId: string, roleName: string, task: Task | null, kind: WorkItemKind, difficulty = 2): Candidate | null {
  const cands = candidatesForRole(workspaceId, roleName).filter((c) => !c.blocked);
  const eligible = cands.filter((c) => sodOk(c, task, kind).ok && !capBlock(c.agent, task?.id ?? null));
  if (!eligible.length) return null;
  const tierFor = (d: number) => d <= 2 ? 0 : d <= 3 ? 1 : 2; // fast|standard|strong order idx
  const tierRank = { fast: 0, standard: 1, strong: 2 } as const;
  eligible.sort((a, b) => {
    const ta = a.model ? Math.abs(tierRank[a.model.strengthTier] - tierFor(difficulty)) : 1;
    const tb = b.model ? Math.abs(tierRank[b.model.strengthTier] - tierFor(difficulty)) : 1;
    if (ta !== tb) return ta - tb;
    // prefer agents with fewer in-flight items (respect maxConcurrentTasks)
    const load = (id: string) => (q1(`SELECT COUNT(*) c FROM work_items WHERE agent_id = ? AND status IN ('running','queued','waiting')`, id)?.c as number) ?? 0;
    return load(a.agent.id) - load(b.agent.id);
  });
  for (const c of eligible) {
    const inFlight = (q1(`SELECT COUNT(*) c FROM work_items WHERE agent_id = ? AND status IN ('running','queued','waiting')`, c.agent.id)?.c as number) ?? 0;
    if (inFlight < c.membership.maxConcurrentTasks) return c;
  }
  return null;
}

export { estimateWorkItemCost };

// Dispatch a work item through its adapter with quota pre-check and fallback.
// `node` is the workflow node the item came from — its modelTier overrides the
// kind/difficulty-derived required tier, and the routing decision records it.
export async function dispatchThroughAdapter(
  baseCtx: Omit<AdapterCtx, 'agent' | 'account' | 'model'>,
  candidate: Candidate,
  fallbacks: Candidate[],
  node?: { id: string; label: string; requiredTier?: 'fast' | 'standard' | 'strong' },
  // work that has no run yet (request intake) names its office itself
  workspaceOverride?: string,
): Promise<{ result: WorkItemResult; usedAgent: Agent; usedBackend: string }> {
  const wi = baseCtx.workItem;
  const workspaceId = workspaceOverride ?? q1('SELECT workspace_id FROM runs WHERE id = ?', wi.runId)?.workspace_id as string;
  const allowed = workspaceAllowed(workspaceId);
  // Order: this agent's model options (routed per work item, or own model
  // first when routing is 'fixed') → other agents in the same role (their
  // primary backend). Each entry is tried at most once per work item, so an
  // unavailable provider can't cause a retry loop.
  let ownChain = modelChain(candidate.substituted ? { ...candidate, ...pickPrimary(candidate) } : candidate, allowed);
  // precedence: the workflow node's tier, then this agent's own override, then kind + difficulty
  const agentTier = modelSettings(candidate.agent.settings).tierOverride ?? undefined;
  const forcedTier = node?.requiredTier ?? agentTier;
  const tierSource: 'node' | 'agent' = node?.requiredTier ? 'node' : 'agent';
  const required = forcedTier ?? requiredTier(wi.kind, baseCtx.task?.difficulty ?? 3);
  if (routingStrategy(workspaceId) === 'smart') {
    const d = routeChain(ownChain, wi.kind, baseCtx.task?.difficulty ?? 3, forcedTier, tierSource);
    ownChain = d.ordered;
    emit('model.routed', 'router', { agent: candidate.agent.name, kind: wi.kind, required: d.required, chosen: ownChain[0] ? backendLabel(ownChain[0]) : null, reason: d.reason, tierSource: forcedTier ? tierSource : 'auto', options: ownChain.length, ...(node ? { nodeId: node.id, node: node.label } : {}) }, wi.runId, wi.id);
  }
  const others = fallbacks.filter((f) => f.agent.id !== candidate.agent.id && !f.blocked);
  const chain = [...ownChain, ...others];
  let lastErr: unknown = null;
  let prev: Candidate | null = null;
  let pending: string[] = []; // why each backend since the last attempt was passed over
  const tried: string[] = [];
  const switchTo = (c: Candidate) => {
    if (!prev) return;
    emit('model.switched', 'router', {
      agent: c.agent.name, fromAgent: prev.agent.name, from: backendLabel(prev), to: backendLabel(c),
      reason: pending.join('; '), sameAgent: prev.agent.id === c.agent.id,
    }, wi.runId, wi.id);
    pending = [];
  };
  for (const c of chain) {
    const provider = c.provider;
    const label = backendLabel(c);
    if (!provider || c.blocked) {
      tried.push(`${label}: ${c.blocked ?? 'no provider'}`);
      if (!prev) prev = c;
      pending.push(`${c.model?.name ?? label}: ${c.blocked ?? 'no provider'}`);
      continue;
    }
    const adapter = getAdapter(provider.adapterId);
    const estCost = estimateWorkItemCost(wi.kind);
    if (c.account) {
      const win = windowBlocking(c.account.id, estCost, c.model?.id ?? null);
      if (win) {
        emit('quota.blocked', 'router', { accountId: c.account.id, metric: win.metric, resetsAt: win.resetsAt, source: win.source }, wi.runId, wi.id);
        tried.push(`${label}: quota exhausted`);
        if (!prev) prev = c;
        pending.push(`${c.model?.name ?? label}: quota exhausted (${win.metric})`);
        continue;
      }
      for (const w of estimatedWindows(c.account.id, c.account.monthlyBudgetUsd)) {
        if (w.remaining != null && w.remaining < estCost) { emit('quota.blocked', 'router', { accountId: c.account.id, metric: 'usd', estimated: true }, wi.runId, wi.id); }
      }
    }
    switchTo(c);
    prev = c;
    // reasoning effort 'auto': sized to the work's tier
    const agent = c.agent.settings?.reasoningEffort === 'auto'
      ? { ...c.agent, settings: { ...c.agent.settings, reasoningEffort: EFFORT_FOR_TIER[required] } } : c.agent;
    const ctx: AdapterCtx = {
      ...baseCtx, agent, account: c.account, model: c.model,
      fetchQuotaHeaders: c.account
        ? (h) => upsertWindowsFromHeaders(c.account!.id, c.model?.id ?? null, h)
        : undefined,
    };
    try {
      const result = await adapter.dispatch(ctx);
      if (c.account) {
        circuitSuccess(c.account.id, c.model?.id);
        recordUsage({
          accountId: c.account.id, modelId: c.model?.id ?? null, workItemId: baseCtx.workItem.id,
          inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens,
          costUsd: result.usage?.costUsd ?? 0, costSource: result.usage?.costSource ?? 'estimate',
        });
      }
      if (c.agent.id !== candidate.agent.id || c.account?.id !== candidate.account?.id || c.model?.id !== candidate.model?.id) {
        run('UPDATE work_items SET agent_id = ?, account_id = ?, model_id = ? WHERE id = ?', c.agent.id, c.account?.id ?? null, c.model?.id ?? null, wi.id);
      }
      return { result, usedAgent: c.agent, usedBackend: label };
    } catch (e: any) {
      lastErr = e;
      const headers = (e as { headers?: Record<string, string> }).headers;
      if (c.account && headers) upsertWindowsFromHeaders(c.account.id, c.model?.id ?? null, headers);
      const limitSec = e?.kind === 'rate-limit' || rateLimitRetryAfterSec(String(e?.message ?? '')) != null
        ? (headers?.['retry-after'] ? null : rateLimitRetryAfterSec(String(e?.message ?? '')))
        : undefined;
      const limited = e?.kind === 'rate-limit' || limitSec !== undefined;
      if (c.account && limited) {
        const retry = { ...(headers ?? {}) };
        if (!retry['retry-after'] && limitSec) retry['retry-after'] = String(limitSec);
        markRateLimited(c.account.id, c.model?.id ?? null, retry);
        // this model stays out until resets_at; keep going on another model now
        if (!chain.slice(chain.indexOf(c) + 1).some((x) => !x.blocked && x.provider)) {
          for (const n of autoAlternates(c, allowed, chain)) chain.push(n);
        }
      } else if (c.account) circuitFailure(c.account.id, c.model?.id, String(e?.message ?? e), e?.kind === 'auth');
      const kind = limited ? 'rate-limit' : (e?.kind ?? 'error');
      const why = kind === 'rate-limit' ? 'rate limited' : kind === 'auth' ? 'authentication failed' : kind === 'server' || kind === 'network' || kind === 'timeout' ? 'provider unavailable' : `failed (${kind})`;
      pending = [`${c.model?.name ?? label}: ${why}`];
      tried.push(`${label}: ${why}`);
      emit('adapter.failed', 'router', { agent: c.agent.name, backend: label, adapter: provider.adapterId, kind, error: String(e?.message ?? e).slice(0, 300), fallback: chain.indexOf(c) < chain.length - 1 }, wi.runId, wi.id);
    }
  }
  if (tried.length > 1) emit('fallback.exhausted', 'router', { agent: candidate.agent.name, tried }, wi.runId, wi.id);
  const err = lastErr instanceof Error ? lastErr : new Error(`no usable backend — ${tried.join('; ') || 'no eligible adapter candidate'}`);
  throw err;
}

function pickPrimary(c: Candidate): Partial<Candidate> {
  const account = getAccount(c.agent.accountId) ?? null;
  return { account, provider: getProvider(account?.providerId) ?? null, model: getModel(c.agent.modelId) ?? null };
}
