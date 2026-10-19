import type { Account, ModelRow, Provider, WorkItemKind } from '../types.ts';

// ---------------------------------------------------------------------------
// Model routing: each work item runs on the best of the agent's model options
// (its own model plus its alternatives) for what the work needs — the
// cheapest option whose tier is strong enough, plan-billed backends first.
// Unavailable options (circuit open, quota or budget exhausted) are skipped.
// Pure functions — the router applies them (services/router.ts).
// ---------------------------------------------------------------------------

export type Tier = ModelRow['strengthTier'];
const TIER_RANK: Record<Tier, number> = { fast: 0, standard: 1, strong: 2 };

// What a kind of work needs, scaled by task difficulty (1–5).
export function requiredTier(kind: WorkItemKind, difficulty = 3): Tier {
  switch (kind) {
    case 'analyse': case 'doc': return difficulty >= 4 ? 'standard' : 'fast';
    // judging a short brief or a report is light work on easy tasks
    case 'prompt-review': case 'accept': return difficulty <= 2 ? 'fast' : difficulty >= 4 ? 'strong' : 'standard';
    case 'prompt': case 'qa': case 'review': case 'plan':
      return difficulty >= 4 ? 'strong' : 'standard';
    default: return difficulty <= 1 ? 'fast' : difficulty <= 3 ? 'standard' : 'strong';
  }
}

export const EFFORT_FOR_TIER: Record<Tier, 'low' | 'medium' | 'high'> = { fast: 'low', standard: 'medium', strong: 'high' };

const EST_COST: Record<WorkItemKind, number> = {
  plan: 0.5, implement: 1.5, review: 0.4, test: 0.8, analyse: 0.4, fix: 1.0, doc: 0.6,
  prompt: 0.2, 'prompt-review': 0.15, qa: 0.4, accept: 0.15, diagnose: 0.3, custom: 0.6,
};

export function estimateWorkItemCost(kind: WorkItemKind): number {
  return EST_COST[kind] ?? 0.5;
}

// Rough prompt/reply sizes per kind, for comparing metered prices.
const EST_TOKENS: Partial<Record<WorkItemKind, [number, number]>> = {
  plan: [20000, 4000], implement: [16000, 8000], fix: [16000, 6000], qa: [14000, 2000], review: [14000, 2000],
  accept: [6000, 1500], prompt: [8000, 3000], analyse: [12000, 1500], doc: [10000, 4000],
};

interface RouteOption { account: Account | null; provider: Provider | null; model: ModelRow | null; blocked?: string }

// Subscription and credit plans (and CLI logins, which run on a plan) add no
// per-call cost, so they are used first.
export function planBilled(c: Pick<RouteOption, 'account' | 'provider'>): boolean {
  return c.account?.billing === 'subscription' || c.account?.billing === 'credits'
    || c.provider?.adapterId === 'cli' || c.provider?.adapterId === 'scripted' || c.provider?.adapterId === 'manual';
}

export function marginalCost(c: RouteOption, kind: WorkItemKind): number {
  if (planBilled(c)) return 0;
  if (!c.model || (!c.model.priceIn && !c.model.priceOut)) return estimateWorkItemCost(kind);
  const [tin, tout] = EST_TOKENS[kind] ?? [12000, 3000];
  return (c.model.priceIn * tin + c.model.priceOut * tout) / 1e6;
}

export interface RouteDecision<C> { ordered: C[]; required: Tier; reason: string }

export function routeChain<C extends RouteOption>(chain: C[], kind: WorkItemKind, difficulty = 3): RouteDecision<C> {
  const required = requiredTier(kind, difficulty);
  const usable = chain.filter((c) => !c.blocked && c.provider);
  const tierOf = (c: C) => TIER_RANK[c.model?.strengthTier ?? 'standard'];
  const need = TIER_RANK[required];
  // the agent's own provider (its first option) is kept when costs are equal:
  // the router steps down to a lighter model there, but doesn't hop to a
  // fallback provider just because its model is rated a tier lower
  const home = chain[0]?.provider?.id;
  const ranked = usable.map((c, i) => ({ c, i, gap: tierOf(c) - need, cost: marginalCost(c, kind), away: c.provider?.id === home ? 0 : 1 }));
  ranked.sort((a, b) => {
    const okA = a.gap >= 0; const okB = b.gap >= 0;
    if (okA !== okB) return okA ? -1 : 1;
    if (okA) return a.cost - b.cost || a.away - b.away || a.gap - b.gap || a.i - b.i;  // cheapest sufficient, own provider, least overpowered
    return b.gap - a.gap || a.cost - b.cost || a.i - b.i;            // nothing is strong enough: the strongest
  });
  const ordered = [...ranked.map((x) => x.c), ...chain.filter((c) => !usable.includes(c))];
  const top = ranked[0];
  const reason = !top ? 'no option available'
    : `${required} work → ${top.c.model?.name ?? 'default'} (${top.c.model?.strengthTier ?? 'standard'}, ${top.cost === 0 ? 'plan-billed' : `~$${top.cost.toFixed(3)}`})${top.gap < 0 ? ' — no stronger option available' : ''}`;
  return { ordered, required, reason };
}

// Model names hint at their tier; used for models whose tier the owner never set.
export function inferTier(name: string): Tier {
  const n = name.toLowerCase();
  if (/haiku|mini|nano|flash|lite|fast|small|tiny|instant|\b[1-9]b\b/.test(n)) return 'fast';
  if (/opus|ultra|fusion|max|high|\bpro\b|\bo1\b|\bo3\b|thinking|large|\b(70|72|405)b\b/.test(n)) return 'strong';
  return 'standard';
}
