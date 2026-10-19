import { cliExecutable, cliPresetOf, effectiveCliCommand, prepareCliCommand, spawnShell, type CliPresetId } from '../adapters/cli-resolve.ts';

export interface CliCatalogModel {
  uid: string;
  name: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  priceIn?: number;
  priceOut?: number;
}

/** Devin CLI: `devin models list --format json` → families[].variants[]. */
export function parseDevinModelsJson(text: string): CliCatalogModel[] {
  const start = text.indexOf('{');
  if (start < 0) return [];
  let data: any;
  try { data = JSON.parse(text.slice(start)); } catch { return []; }
  const price = (summary: unknown, label: string): number | undefined => {
    const m = String(summary ?? '').match(new RegExp(`\\$([\\d.]+)\\s*/\\s*1M ${label}`, 'i'));
    return m ? Number(m[1]) : undefined;
  };
  const models: CliCatalogModel[] = [];
  for (const fam of Array.isArray(data?.families) ? data.families : []) {
    for (const v of Array.isArray(fam?.variants) ? fam.variants : []) {
      if (!v?.model_uid) continue;
      models.push({
        uid: String(v.model_uid), name: String(v.label ?? v.model_uid),
        contextTokens: Number(v.max_context_tokens) || undefined, maxOutputTokens: Number(v.max_output_tokens) || undefined,
        priceIn: price(v.cost_summary, 'Input'), priceOut: price(v.cost_summary, 'Output'),
      });
    }
  }
  return models;
}

function runCapture(cmd: string, env: NodeJS.ProcessEnv, timeoutMs = 90_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawnShell(cmd, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout!.on('data', (d) => { out += String(d); });
    child.stderr!.on('data', (d) => { out += String(d); });
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, out }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ code: -1, out: String(e) }); });
  });
}

/** Cursor agent / cursor-agent: `uid - display name` lines after "Available models". */
export function parseAgentListModels(text: string): CliCatalogModel[] {
  const models: CliCatalogModel[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Tip:')) break;
    const m = line.match(/^([^\s]+)\s+-\s+(.+)$/);
    if (!m) continue;
    const uid = m[1].trim();
    const name = m[2].trim();
    if (uid && name) models.push({ uid, name });
  }
  return models;
}

/** Claude Code local `/model` command: `Available: sonnet, opus, …`. */
export function parseClaudeModelSlash(text: string): CliCatalogModel[] {
  const line = text.split(/\r?\n/).find((l) => /Available:/i.test(l));
  if (!line) return [];
  const part = line.replace(/^.*Available:\s*/i, '').replace(/\.\s*$/, '');
  // "sonnet, opus, …, default, or a full model ID." — keep only the aliases
  const tokens = part.split(',').map((t) => t.trim()).filter((t) => t && !/\s/.test(t));
  return tokens.map((uid) => ({ uid, name: uid }));
}

// Claude Code's `/model` lists only aliases (sonnet, opus, …). Each alias is
// resolved to its full, versioned model ID by the CLI itself: `/model` is a
// local command (no model call, $0) and the stream-json init event names the
// model the alias maps to; the reply gives its display name.
const NOT_A_MODEL = new Set(['opusplan']); // a mode: Opus in plan mode, else Sonnet

/** Parse one `claude -p --model <alias> --output-format stream-json --verbose /model` run. */
export function parseClaudeResolution(text: string): { id: string; label: string | null } | null {
  let id: string | null = null; let label: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'system' && ev.subtype === 'init' && ev.model) id = String(ev.model);
      if (ev.type === 'result') label = String(ev.result ?? '').match(/Current model:\s*`([^`]+)`/)?.[1] ?? label;
    } catch { /* not json */ }
  }
  return id ? { id, label } : null;
}

async function resolveClaudeAliases(token: string, aliases: CliCatalogModel[]): Promise<CliCatalogModel[]> {
  const wanted = aliases.filter((a) => !NOT_A_MODEL.has(a.uid));
  const resolved = await Promise.all(wanted.map(async (a) => {
    const { cmd, env } = prepareCliCommand(`${token} -p --model "${a.uid}" --output-format stream-json --verbose /model`);
    const { out } = await runCapture(cmd, env, 60_000);
    return parseClaudeResolution(out);
  }));
  const byId = new Map<string, CliCatalogModel>();
  for (const r of resolved) {
    if (!r || byId.has(r.id)) continue; // 'default' / 'best' point at a model already listed
    const long = /\[1m\]$/i.test(r.id);
    const label = r.label ?? r.id;
    byId.set(r.id, { uid: r.id, name: long && !/1M/i.test(label) ? `${label} (1M context)` : label, ...(long ? { contextTokens: 1_000_000 } : {}) });
  }
  // keep the order the CLI listed; aliases that didn't resolve are left out
  return [...byId.values()];
}

// Each preset's own output format; an unknown CLI gets every parser.
const PARSERS: Record<CliPresetId | 'other', ((text: string) => CliCatalogModel[])[]> = {
  claude: [parseClaudeModelSlash, parseAgentListModels],
  cursor: [parseAgentListModels],
  devin: [parseDevinModelsJson],
  other: [parseDevinModelsJson, parseAgentListModels, parseClaudeModelSlash],
};

/** The model-listing commands for a command template, in the order to try them. */
export function listCommandsFor(commandTemplate: string): string[] {
  const template = effectiveCliCommand(commandTemplate);
  const { token } = cliExecutable(template);
  const args = cliPresetOf(template)?.listArgs ?? ['--list-models', 'models list --format json', 'models'];
  return args.map((a) => `${token} ${a}`);
}

async function tryListCommand(fullCmd: string, parsers: ((text: string) => CliCatalogModel[])[]): Promise<CliCatalogModel[]> {
  const { cmd, env } = prepareCliCommand(fullCmd);
  const { code, out } = await runCapture(cmd, env);
  if (code !== 0 && !out.trim()) return [];
  for (const parse of parsers) {
    const models = parse(out);
    if (models.length) return models;
  }
  return [];
}

/** List models from the configured headless CLI (Claude Code, cursor-agent, Devin CLI or another CLI). */
export async function fetchCliCatalog(commandTemplate: string): Promise<CliCatalogModel[]> {
  const template = effectiveCliCommand(commandTemplate);
  const preset = cliPresetOf(template);
  for (const attempt of listCommandsFor(template)) {
    const models = await tryListCommand(attempt, PARSERS[preset?.id ?? 'other']);
    if (!models.length) continue;
    if (preset?.id === 'claude' && models.every((m) => !/^claude-/.test(m.uid))) {
      const versioned = await resolveClaudeAliases(cliExecutable(template).token, models);
      if (versioned.length) return versioned;
    }
    return models;
  }
  throw new Error(preset?.loginHint
    ?? `\`${cliExecutable(template).name}\` did not list any models (tried --list-models and models) — pick "provider default" or type one with custom…`);
}
