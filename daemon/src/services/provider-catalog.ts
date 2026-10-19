import { resolveSecret } from '../config.ts';
import { q1 } from '../db.ts';
import { parseJson } from '../util.ts';
import { getProvider } from './router.ts';
import { fetchCliCatalog } from './cli-catalog.ts';
import { fetchDevinCatalog } from './devin-catalog.ts';
import { DEFAULT_BASE_URL, fetchAnthropicCatalog, fetchOpenAiCompatibleCatalog } from './api-catalog.ts';
import { upsertProviderCatalog, type CatalogModel } from './model-catalog-sync.ts';

// One entry point for "which models does this backend offer?" — every
// integration that can list its models asks the provider itself.

export const CATALOG_ADAPTERS = ['openai-compatible', 'anthropic', 'cli', 'devin'];

export interface CatalogSource { apiKey?: string | null; baseUrl?: string | null; command?: string | null; orgId?: string | null }

export async function fetchCatalog(adapterId: string, src: CatalogSource): Promise<CatalogModel[]> {
  switch (adapterId) {
    case 'openai-compatible': return fetchOpenAiCompatibleCatalog(src.baseUrl ?? '', src.apiKey ?? null);
    case 'anthropic': return fetchAnthropicCatalog(src.baseUrl ?? '', src.apiKey ?? null);
    case 'cli': return fetchCliCatalog(String(src.command ?? ''));
    case 'devin': {
      if (!src.apiKey) throw new Error('no API key stored for this Devin backend');
      return fetchDevinCatalog(src.apiKey, { orgId: src.orgId, baseUrl: src.baseUrl });
    }
    default: throw new Error(`${adapterId} backends have no model list to fetch`);
  }
}

// Credentials and endpoint for a registered provider, from its account.
export function catalogSource(providerId: string): CatalogSource {
  const p = getProvider(providerId);
  const acct = q1('SELECT secret_ref, config FROM accounts WHERE provider_id = ? LIMIT 1', providerId) as { secret_ref?: string; config?: string } | undefined;
  const cfg = parseJson<Record<string, unknown>>(acct?.config ?? '{}', {});
  const provCfg = (p?.config ?? {}) as Record<string, unknown>;
  const baseUrl = String(cfg.baseUrl ?? provCfg.baseUrl ?? '').trim() || DEFAULT_BASE_URL[p?.adapterId ?? ''] || '';
  return { apiKey: resolveSecret(acct?.secret_ref), baseUrl, command: String(cfg.command ?? '').trim(), orgId: String(cfg.orgId ?? '').trim() || null };
}

export async function fetchProviderCatalog(providerId: string): Promise<CatalogModel[]> {
  const p = getProvider(providerId);
  if (!p) throw new Error('provider not found');
  return fetchCatalog(p.adapterId, catalogSource(providerId));
}

export async function syncProviderModels(providerId: string): Promise<{ synced: number }> {
  const catalog = await fetchProviderCatalog(providerId);
  if (!catalog.length) throw new Error('the provider returned no models');
  return upsertProviderCatalog(providerId, catalog);
}
