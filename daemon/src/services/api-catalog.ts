// Live model lists for model-API backends: whatever the provider says this
// key can use — never a hardcoded list.
//   openai-compatible: GET {baseUrl}/models (OpenAI, OpenRouter, LM Studio,
//                      Ollama's /v1); falls back to Ollama's native /api/tags
//   anthropic:         GET {baseUrl}/v1/models (paginated)

export interface ApiCatalogModel {
  uid: string;
  name: string;
  contextTokens?: number;
  maxOutputTokens?: number;
}

export const DEFAULT_BASE_URL: Record<string, string> = {
  'openai-compatible': 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com',
};

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403) throw new Error(`API key rejected by ${new URL(url).host} (${res.status})`);
  if (!res.ok) throw new Error(`${url} → ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);

export async function fetchOpenAiCompatibleCatalog(baseUrl: string, apiKey: string | null): Promise<ApiCatalogModel[]> {
  const base = (baseUrl || DEFAULT_BASE_URL['openai-compatible']).replace(/\/$/, '');
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  let firstError: unknown = null;
  try {
    const body = await getJson(`${base}/models`, headers);
    const list = (Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []) as any[];
    const models = list
      .map((m) => ({
        uid: String(m.id ?? m.name ?? '').replace(/^models\//, ''),
        name: String(m.name ?? m.display_name ?? m.id ?? ''),
        contextTokens: num(m.context_length ?? m.context_window ?? m.max_context_length),
        maxOutputTokens: num(m.top_provider?.max_completion_tokens ?? m.max_output_tokens),
      }))
      .filter((m) => m.uid);
    if (models.length) return models;
  } catch (e) { firstError = e; }
  // Ollama's native listing, for base URLs without the /v1 compatibility path
  try {
    const origin = new URL(base).origin;
    const body = await getJson(`${origin}/api/tags`, headers);
    const models = ((body?.models ?? []) as any[]).map((m) => ({ uid: String(m.name ?? m.model), name: String(m.name ?? m.model) })).filter((m) => m.uid);
    if (models.length) return models;
  } catch { /* not an Ollama server */ }
  if (firstError) throw firstError;
  throw new Error(`${base}/models returned no models`);
}

export async function fetchAnthropicCatalog(baseUrl: string, apiKey: string | null): Promise<ApiCatalogModel[]> {
  if (!apiKey) throw new Error('an API key is required to list Anthropic models');
  const base = (baseUrl || DEFAULT_BASE_URL.anthropic).replace(/\/$/, '');
  const headers = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  const out: ApiCatalogModel[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: '1000', ...(after ? { after_id: after } : {}) });
    const body = await getJson(`${base}/v1/models?${qs}`, headers);
    for (const m of (body?.data ?? []) as any[]) {
      out.push({
        uid: String(m.id), name: String(m.display_name ?? m.id),
        contextTokens: num(m.max_input_tokens ?? m.context_window),
        maxOutputTokens: num(m.max_tokens ?? m.max_output_tokens),
      });
    }
    if (!body?.has_more || !body?.last_id) break;
    after = String(body.last_id);
  }
  if (!out.length) throw new Error('Anthropic returned no models for this key');
  return out;
}
