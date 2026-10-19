import { q, q1, run } from '../db.ts';
import { getProvider } from './router.ts';
import { inferTier } from './routing.ts';

// A model as the provider reports it. Limits and prices are optional — only
// some providers publish them; unknown values keep the existing row's.
export interface CatalogModel {
  uid: string;
  name: string;
  priceIn?: number;
  priceOut?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
}

function parseCaps(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return {}; }
}

/** Upsert model rows from a provider's live catalog. */
export function upsertProviderCatalog(providerId: string, catalog: CatalogModel[]): { synced: number } {
  const p = getProvider(providerId);
  if (!p) throw new Error('provider not found');
  if (!catalog.length) throw new Error('catalog is empty');

  const caps = parseCaps(p.capabilities);
  const names = new Set<string>();
  const uidField = p.adapterId === 'devin' ? 'devinUid' : p.adapterId === 'cli' ? 'cliUid' : 'providerUid';

  for (const m of catalog) {
    const uid = m.uid;
    names.add(uid);
    const id = `${providerId}:${uid}`;
    const priceIn = Number(m.priceIn) || 0;
    const priceOut = Number(m.priceOut) || 0;
    const tier = inferTier(`${uid} ${m.name}`);
    const existing = q1('SELECT id, price_in, price_out, strength_tier, supports FROM models WHERE id = ?', id);
    if (existing) {
      // keep prices and a routing tier the owner entered
      const tierSet = !!parseCaps(existing.supports).tierSet;
      const supports = JSON.stringify({ displayName: m.name, [uidField]: uid, ...(tierSet ? { tierSet } : {}) });
      run(`UPDATE models SET name = ?, supports = ?, price_in = ?, price_out = ?, strength_tier = ?,
             context_tokens = COALESCE(?, context_tokens), max_output_tokens = COALESCE(?, max_output_tokens) WHERE id = ?`,
        uid, supports, priceIn || (existing.price_in as number), priceOut || (existing.price_out as number),
        tierSet ? existing.strength_tier : tier, m.contextTokens ?? null, m.maxOutputTokens ?? null, id);
    } else {
      const supports = JSON.stringify({ displayName: m.name, [uidField]: uid });
      run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier, supports)
           VALUES (?,?,?,?,?,?,?,?,?)`, id, providerId, uid, m.contextTokens ?? 128000, m.maxOutputTokens ?? 8192, priceIn, priceOut, tier, supports);
    }
  }

  // Rows the provider no longer lists (e.g. bare aliases replaced by versioned
  // IDs) are dropped — unless an agent or past work still points at them.
  for (const old of q('SELECT id FROM models WHERE provider_id = ?', providerId)) {
    const id = old.id as string;
    if (names.has(id.slice(providerId.length + 1))) continue;
    const used = q1(`SELECT 1 FROM agents WHERE model_id = ? OR settings LIKE ? LIMIT 1`, id, `%"modelId":"${id.replace(/[%_]/g, '')}"%`)
      ?? q1('SELECT 1 FROM work_items WHERE model_id = ? LIMIT 1', id);
    if (!used) run('DELETE FROM models WHERE id = ?', id);
  }

  run('UPDATE providers SET capabilities = ? WHERE id = ?', JSON.stringify({ ...caps, models: [...names] }), providerId);
  return { synced: catalog.length };
}
