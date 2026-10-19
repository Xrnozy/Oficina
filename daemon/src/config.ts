import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { DATA_DIR } from './db.ts';

export interface OfficeConfig {
  port: number;
  uiDir: string;
  providers: ProviderCfg[];
}

export interface ProviderCfg {
  id: string;
  name: string;
  kind: 'model' | 'agent' | 'manual';
  adapter: 'scripted' | 'openai-compatible' | 'anthropic' | 'cli' | 'manual' | 'devin';
  tier?: 1 | 2 | 3;
  baseUrl?: string;
  apiKeyEnv?: string;
  command?: string;          // for cli adapter
  models?: { name: string; priceIn?: number; priceOut?: number; strengthTier?: 'fast' | 'standard' | 'strong'; contextTokens?: number; maxOutputTokens?: number }[];
  config?: Record<string, unknown>;
}

const DEFAULT_CONFIG: OfficeConfig = {
  port: 4780,
  uiDir: '../ui/dist',
  providers: [
    { id: 'local-office', name: 'Scripted Demo Agent', kind: 'agent', adapter: 'scripted', tier: 1 },
    {
      id: 'ollama', name: 'Local Ollama (OpenAI-compatible)', kind: 'model', adapter: 'openai-compatible', tier: 1,
      baseUrl: 'http://localhost:11434/v1', models: [{ name: 'qwen2.5-coder:7b', strengthTier: 'standard' }],
    },
  ],
};

export function loadConfig(): OfficeConfig {
  const p = path.resolve(process.cwd(), 'office.yaml');
  if (fs.existsSync(p)) {
    const parsed = YAML.parse(fs.readFileSync(p, 'utf8')) as Partial<OfficeConfig>;
    return { ...DEFAULT_CONFIG, ...parsed, providers: parsed.providers ?? DEFAULT_CONFIG.providers };
  }
  fs.writeFileSync(p, YAML.stringify(DEFAULT_CONFIG));
  return DEFAULT_CONFIG;
}

// ---- secrets -----------------------------------------------------------
// Secret refs: "env:VAR_NAME" reads process.env; "local:name" reads the
// gitignored data/secrets.json file (local-app stand-in for the OS keychain).

function secretsPath(): string { return path.join(DATA_DIR, 'secrets.json'); }

export function resolveSecret(ref: string | null | undefined): string | null {
  if (!ref) return null;
  if (ref.startsWith('env:')) return process.env[ref.slice(4)] ?? null;
  if (ref.startsWith('local:')) {
    const file = secretsPath();
    if (!fs.existsSync(file)) return null;
    try { return (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>)[ref.slice(6)] ?? null; }
    catch { return null; }
  }
  return null;
}

export function storeSecret(name: string, value: string): string {
  const file = secretsPath();
  let obj: Record<string, string> = {};
  if (fs.existsSync(file)) { try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ } }
  obj[name] = value;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  return `local:${name}`;
}

// Removes a locally stored secret. env: refs live outside the Office and can
// only be removed by the owner, so they report false.
export function deleteSecret(ref: string | null | undefined): boolean {
  if (!ref?.startsWith('local:')) return false;
  const file = secretsPath();
  if (!fs.existsSync(file)) return false;
  let obj: Record<string, string> = {};
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const name = ref.slice(6);
  if (!(name in obj)) return false;
  delete obj[name];
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
  secretCache = null;
  return true;
}

// Every secret value the Office knows about — used to scrub events, prompts
// and agent messages so credentials never leak into logs (spec 9).
let secretCache: { mtime: number; values: string[] } | null = null;
function secretValues(): string[] {
  const file = secretsPath();
  const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  if (!secretCache || secretCache.mtime !== mtime) {
    let local: string[] = [];
    if (mtime) { try { local = Object.values(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>); } catch { /* unreadable */ } }
    secretCache = { mtime, values: local };
  }
  const env = Object.entries(process.env)
    .filter(([k, v]) => v && /KEY|TOKEN|SECRET|PASSWORD/i.test(k))
    .map(([, v]) => v as string);
  return [...secretCache.values, ...env].filter((v) => v && v.length >= 8);
}

export function redact(text: string): string {
  let out = text;
  for (const v of secretValues()) if (out.includes(v)) out = out.split(v).join('[redacted]');
  return out;
}

export function adapterHash(adapterId: string, version: string): string {
  return crypto.createHash('sha256').update(`${adapterId}@${version}`).digest('hex').slice(0, 16);
}
