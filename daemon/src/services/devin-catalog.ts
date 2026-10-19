// What a Devin session can run on, straight from the Devin API. Sessions take
// a `devin_mode` (normal, fast, lite, ultra, fusion, swe-2-*, research
// previews…), and the organization reports which ones it may use right now
// as `available_devin_modes`. This is the same API and cog_ service-user key
// the adapter uses for sessions — no Devin Desktop permission needed.
// https://docs.devin.ai/v3-openapi.json

export interface DevinCatalogModel {
  uid: string;
  name: string;
  priceIn: number;
  priceOut: number;
}

const DEFAULT_BASE = 'https://api.devin.ai';

const MODE_LABELS: Record<string, string> = {
  normal: 'Agent (normal)', fast: 'Fast', lite: 'Devin Lite', ultra: 'Devin Ultra', fusion: 'Fusion',
  'swe-2-medium': 'SWE-2 Medium', 'swe-2-high': 'SWE-2 High', 'swe-2-max': 'SWE-2 Max',
};

async function devinGet(base: string, apiKey: string, pathName: string): Promise<any> {
  const res = await fetch(`${base}${pathName}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(45_000),
  });
  if (res.status === 401) throw new Error('Devin rejected this API key (401) — use a service-user key from app.devin.ai → Settings → Service users (starts with cog_)');
  if (res.status === 403) throw new Error(`this key's service user may not read ${pathName} (403) — check its role in app.devin.ai → Settings → Service users`);
  if (!res.ok) throw new Error(`Devin API ${res.status} on ${pathName}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

// The organization this key acts in: the configured one, else the service
// user's own org, else the only org an enterprise key can see.
async function resolveOrgId(base: string, apiKey: string, configured?: string | null): Promise<string> {
  if (configured?.trim()) return configured.trim();
  // a rejected key is reported as such, not as "organization not found"
  const self = await devinGet(base, apiKey, '/v3/self').catch((e) => { if (String(e).includes('(401)')) throw e; return null; });
  if (self?.org_id) return String(self.org_id);
  const orgs = await devinGet(base, apiKey, '/v3/enterprise/organizations?first=5').catch(() => null);
  const items = Array.isArray(orgs?.items) ? orgs.items : [];
  if (items.length === 1 && items[0]?.org_id) return String(items[0].org_id);
  throw new Error(items.length > 1
    ? 'this key sees several Devin organizations — enter the Organization ID (Settings → Devin API) to list its modes'
    : 'could not find the Devin organization for this key — enter the Organization ID (Settings → Devin API)');
}

export async function fetchDevinCatalog(apiKey: string, opts: { orgId?: string | null; baseUrl?: string | null } = {}): Promise<DevinCatalogModel[]> {
  const base = (opts.baseUrl?.trim() || DEFAULT_BASE).replace(/\/$/, '');
  const orgId = await resolveOrgId(base, apiKey, opts.orgId);
  const body = await devinGet(base, apiKey, `/v3/organizations/${encodeURIComponent(orgId)}/automations/schemas`);
  const modes = (Array.isArray(body?.available_devin_modes) ? body.available_devin_modes : []) as string[];
  if (!modes.length) throw new Error('Devin reported no agent modes available to this organization');
  return modes.map((m) => ({ uid: m, name: MODE_LABELS[m] ?? m, priceIn: 0, priceOut: 0 }));
}
