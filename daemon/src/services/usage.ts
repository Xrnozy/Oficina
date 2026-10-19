import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { now, parseJson, ulid } from '../util.ts';
import type { QuotaWindow, UsageRecord } from '../types.ts';

// Usage accounting + quota windows (spec 4.7, 8.5). Every number carries a
// source label: official-api | response-header | estimate | manual-entry.

export function recordUsage(u: {
  accountId: string; modelId: string | null; workItemId: string | null;
  inputTokens?: number; outputTokens?: number; cacheReadTokens?: number;
  costUsd: number; costSource: string;
}): void {
  run(`INSERT INTO usage_records (id, account_id, model_id, work_item_id, ts, input_tokens, output_tokens, cache_read_tokens, requests, cost_usd, cost_source)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ulid(), u.accountId, u.modelId, u.workItemId, now(), u.inputTokens ?? 0, u.outputTokens ?? 0,
    u.cacheReadTokens ?? 0, 1, u.costUsd, u.costSource);
  emit('usage.recorded', 'router', { accountId: u.accountId, costUsd: u.costUsd });
}

export function usageTotals(accountId?: string): { costUsd: number; requests: number; inputTokens: number; outputTokens: number } {
  const r = accountId
    ? q1('SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM usage_records WHERE account_id = ?', accountId)
    : q1('SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM usage_records');
  return { costUsd: (r?.c as number) ?? 0, requests: (r?.n as number) ?? 0, inputTokens: (r?.i as number) ?? 0, outputTokens: (r?.o as number) ?? 0 };
}

export function spendTodayUsd(accountId: string): number {
  const day = now().slice(0, 10);
  const r = q1(`SELECT COALESCE(SUM(cost_usd),0) c FROM usage_records WHERE account_id = ? AND ts >= ?`, accountId, `${day}T00:00:00`);
  return (r?.c as number) ?? 0;
}

// Parse provider rate-limit headers into quota windows (Anthropic anthropic-ratelimit-*,
// OpenAI-style x-ratelimit-*). Source label: response-header.
export function upsertWindowsFromHeaders(accountId: string, modelId: string | null, headers: Record<string, string>): void {
  const h = headers;
  const pairs: { metric: string; kind: string; limit?: number; remaining?: number; reset?: string }[] = [];
  const grab = (k: string) => h[k] ?? h[k.toLowerCase()];

  const arReq = { limit: grab('anthropic-ratelimit-requests-limit'), rem: grab('anthropic-ratelimit-requests-remaining'), reset: grab('anthropic-ratelimit-requests-reset') };
  const arTok = { limit: grab('anthropic-ratelimit-tokens-limit'), rem: grab('anthropic-ratelimit-tokens-remaining'), reset: grab('anthropic-ratelimit-tokens-reset') };
  if (arReq.limit) pairs.push({ metric: 'requests', kind: 'token-bucket', limit: +arReq.limit, remaining: +(arReq.rem ?? 0), reset: arReq.reset });
  if (arTok.limit) pairs.push({ metric: 'tokens', kind: 'token-bucket', limit: +arTok.limit, remaining: +(arTok.rem ?? 0), reset: arTok.reset });

  const ox = { limit: grab('x-ratelimit-limit-requests'), rem: grab('x-ratelimit-remaining-requests'), reset: grab('x-ratelimit-reset-requests') };
  const ot = { limit: grab('x-ratelimit-limit-tokens'), rem: grab('x-ratelimit-remaining-tokens'), reset: grab('x-ratelimit-reset-tokens') };
  if (ox.limit) pairs.push({ metric: 'requests', kind: 'rolling', limit: +ox.limit, remaining: +(ox.rem ?? 0), reset: ox.reset });
  if (ot.limit) pairs.push({ metric: 'tokens', kind: 'rolling', limit: +ot.limit, remaining: +(ot.rem ?? 0), reset: ot.reset });

  for (const p of pairs) {
    const id = `${accountId}:${modelId ?? ''}:${p.metric}:${p.kind}`;
    const existing = q1('SELECT id FROM quota_windows WHERE id = ?', id);
    const vals = [p.limit ?? null, p.remaining != null && p.limit != null ? p.limit - p.remaining : null, p.remaining ?? null, resetToIso(p.reset), 'response-header', 'exact', now(), id];
    if (existing) {
      run(`UPDATE quota_windows SET lim=?, used=?, remaining=?, resets_at=?, source=?, confidence=?, observed_at=? WHERE id=?`, ...vals);
    } else {
      run(`INSERT INTO quota_windows (lim, used, remaining, resets_at, source, confidence, observed_at, id, account_id, model_id, metric, kind, period)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...vals, accountId, modelId, p.metric, p.kind, 'minute');
    }
  }
}

// Estimated windows: e.g. account monthly budget → usd/month computed from our
// own usage log. Source label: estimate.
export function estimatedWindows(accountId: string, monthlyBudgetUsd: number | null): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  if (monthlyBudgetUsd != null) {
    const monthStart = now().slice(0, 7) + '-01T00:00:00';
    const used = (q1(`SELECT COALESCE(SUM(cost_usd),0) c FROM usage_records WHERE account_id = ? AND ts >= ?`, accountId, monthStart)?.c as number) ?? 0;
    out.push({
      id: `${accountId}::usd:month-est`, accountId, modelId: null, metric: 'usd', kind: 'fixed', period: 'month',
      lim: monthlyBudgetUsd, used, remaining: Math.max(0, monthlyBudgetUsd - used), resetsAt: null,
      source: 'estimate', confidence: 'approximate', observedAt: now(),
    });
  }
  return out;
}

// Reset values arrive as ISO timestamps (Anthropic) or durations like "6m0s"
// / "120ms" (OpenAI). Normalise to ISO so the UI and the router agree.
export function resetToIso(v: string | undefined | null): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let ms = 0; let m: RegExpExecArray | null; let hit = false;
  while ((m = re.exec(v))) { hit = true; const n = parseFloat(m[1]); ms += m[2] === 'h' ? n * 3600e3 : m[2] === 'm' ? n * 60e3 : m[2] === 's' ? n * 1e3 : n; }
  if (!hit && /^\d+$/.test(v)) ms = +v * 1000; // bare seconds (retry-after)
  else if (!hit) return null;
  return new Date(Date.now() + ms).toISOString();
}

const LIMIT_TEXT = /rate[- ]limit|usage limit|hit your limit|out of (?:extra )?usage|too many requests|\b429\b|quota exceeded|limit reached/i;

/** Seconds until a rate-limited model may be used again, parsed from CLI or API text. Null when the text is not a limit. */
export function rateLimitRetryAfterSec(text: string, nowMs = Date.now()): number | null {
  const slice = text.slice(-4000);
  if (!LIMIT_TEXT.test(slice)) return null;
  const iso = slice.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/);
  if (iso) {
    const t = Date.parse(iso[0]);
    if (!Number.isNaN(t) && t > nowMs) return Math.max(30, Math.ceil((t - nowMs) / 1000));
  }
  const rel = slice.match(/(?:resets?|try again|available|retry(?:\s|-)?after)[^\d]{0,40}(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i);
  if (rel) {
    const n = Number(rel[1]);
    const u = rel[2].toLowerCase();
    const sec = u.startsWith('h') ? n * 3600 : u.startsWith('m') ? n * 60 : n;
    return Math.max(30, sec);
  }
  const clock = slice.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    ?? slice.match(/resets?\s+(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i);
  if (clock) {
    let h = Number(clock[1]);
    const min = Number(clock[2] ?? 0);
    const ap = clock[3]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    const at = new Date(nowMs);
    at.setHours(h, min, 0, 0);
    if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
    return Math.max(30, Math.ceil((at.getTime() - nowMs) / 1000));
  }
  // ponytail: unknown reset holds the model for an hour; a parsed time above replaces this
  return 3600;
}

// A 429 marks that model exhausted until the provider's stated reset. With
// no reset information the model stays out for an hour instead of being retried immediately.
export function markRateLimited(accountId: string, modelId: string | null, headers: Record<string, string>): void {
  const retry = headers['retry-after'];
  const known = resetToIso(retry);
  const id = `${accountId}:${modelId ?? ''}:requests:rate-limit`;
  run(`INSERT INTO quota_windows (id, account_id, model_id, metric, kind, period, lim, used, remaining, resets_at, source, confidence, observed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET remaining = 0, resets_at = excluded.resets_at, source = excluded.source, confidence = excluded.confidence, observed_at = excluded.observed_at`,
    id, accountId, modelId, 'requests', 'rate-limit', 'minute', null, null, 0,
    known ?? new Date(Date.now() + 3_600_000).toISOString(),
    known ? 'response-header' : 'estimate', known ? 'exact' : 'approximate', now());
}

// Account-wide windows (no model) block every model; model windows block only that model.
export function windowBlocking(accountId: string, estimatedCost: number, modelId?: string | null): QuotaWindow | null {
  const rows = q('SELECT * FROM quota_windows WHERE account_id = ? AND remaining IS NOT NULL', accountId);
  for (const r of rows) {
    if (r.model_id && modelId !== undefined && r.model_id !== modelId) continue;
    // a window whose reset time has passed no longer blocks
    const reset = r.resets_at ? Date.parse(r.resets_at as string) : NaN;
    if (!Number.isNaN(reset) && reset <= Date.now()) continue;
    const rem = r.remaining as number;
    const metric = r.metric as string;
    if ((metric === 'usd' && rem < estimatedCost) || (metric !== 'usd' && rem <= 0)) {
      return { ...(r as unknown as QuotaWindow), resetsAt: r.resets_at as string | null };
    }
  }
  return null;
}

// ---- circuit breakers (spec 8.4) ----

export function circuitState(accountId: string, modelId?: string | null): 'closed' | 'open' | 'half-open' {
  const r = q1('SELECT * FROM circuits WHERE account_id = ? AND model_id = ?', accountId, modelId ?? '');
  if (!r) return 'closed';
  const state = r.state as 'closed' | 'open' | 'half-open';
  if (state === 'open' && r.next_probe_at && (r.next_probe_at as string) <= now()) return 'half-open';
  return state;
}

export function circuitOk(accountId: string, modelId?: string | null): boolean {
  return circuitState(accountId, modelId) !== 'open';
}

export function circuitFailure(accountId: string, modelId: string | null | undefined, reason: string, auth = false): void {
  const mid = modelId ?? '';
  const r = q1('SELECT * FROM circuits WHERE account_id = ? AND model_id = ?', accountId, mid);
  const fails = ((r?.fails as number) ?? 0) + 1;
  const shouldOpen = auth || fails >= 3;
  if (shouldOpen) {
    const opened = (r?.opened_at as string) ?? now();
    const backoffMin = r?.opened_at ? Math.min(10, 0.5 * Math.pow(2, fails - 3)) : 0.5;
    run(`INSERT INTO circuits (account_id, model_id, state, opened_at, reason, next_probe_at, fails) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(account_id, model_id) DO UPDATE SET state='open', opened_at=?, reason=?, next_probe_at=?, fails=?`,
      accountId, mid, 'open', opened, reason, new Date(Date.now() + backoffMin * 60000).toISOString(), fails,
      opened, reason, new Date(Date.now() + backoffMin * 60000).toISOString(), fails);
    emit('circuit.opened', 'router', { accountId, modelId, reason });
  } else {
    run(`INSERT INTO circuits (account_id, model_id, state, fails) VALUES (?,?,'closed',?)
         ON CONFLICT(account_id, model_id) DO UPDATE SET fails=?`,
      accountId, mid, fails, fails);
  }
}

export function circuitSuccess(accountId: string, modelId?: string | null): void {
  run(`INSERT INTO circuits (account_id, model_id, state, fails) VALUES (?,?,'closed',0)
       ON CONFLICT(account_id, model_id) DO UPDATE SET state='closed', fails=0, opened_at=NULL, next_probe_at=NULL`,
    accountId, modelId ?? '');
}
