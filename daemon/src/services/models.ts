import type { AgentModelSettings, CliSessionSettings, ModelRow } from '../types.ts';

export const DEFAULT_CLI_SESSION: CliSessionSettings = { mode: 'reuse', pinnedId: null, whenBusy: 'new', rotateAfter: 30 };

/** An agent's CLI-session settings with defaults filled in: reuse its session, add one if it is busy, rotate after 30 work items. */
export function cliSessionSettings(settings: Record<string, unknown> | undefined): CliSessionSettings {
  const c = ((settings ?? {}).cliSession ?? {}) as Partial<CliSessionSettings>;
  return {
    mode: c.mode === 'new' || c.mode === 'pinned' ? c.mode : 'reuse',
    pinnedId: typeof c.pinnedId === 'string' && c.pinnedId ? c.pinnedId : null,
    whenBusy: c.whenBusy === 'wait' ? 'wait' : 'new',
    rotateAfter: Number.isInteger(c.rotateAfter) && (c.rotateAfter as number) >= 0 ? (c.rotateAfter as number) : DEFAULT_CLI_SESSION.rotateAfter,
  };
}

// Which per-agent model settings each integration can actually apply (spec:
// distinguish provider-level, model-specific and unsupported settings).
//   'yes'    — sent to the provider on every call
//   'model'  — sent, but only some models honour it (provider ignores or rejects otherwise)
//   'engine' — applied by the Office itself (e.g. context budget), not by the provider
//   'no'     — this integration has no way to apply it
export type Support = 'yes' | 'model' | 'engine' | 'no';
export interface SettingsSupport {
  modelSelect: Support; reasoningEffort: Support; temperature: Support;
  maxOutputTokens: Support; contextTokens: Support; fallbacks: Support; note: string;
}

export function settingsSupport(adapterId: string | undefined): SettingsSupport {
  switch (adapterId) {
    case 'anthropic':
      return { modelSelect: 'yes', reasoningEffort: 'model', temperature: 'yes', maxOutputTokens: 'yes', contextTokens: 'engine', fallbacks: 'engine',
        note: 'Models are listed live from the Anthropic models API (Sync from provider). Reasoning effort maps to an extended-thinking budget; temperature is ignored while thinking is on.' };
    case 'openai-compatible':
      return { modelSelect: 'yes', reasoningEffort: 'model', temperature: 'yes', maxOutputTokens: 'yes', contextTokens: 'engine', fallbacks: 'engine',
        note: 'Models are listed live from the server /models endpoint (Sync from provider). Reasoning effort is sent as reasoning_effort; only reasoning models accept it.' };
    case 'cli':
      return { modelSelect: 'model', reasoningEffort: 'no', temperature: 'no', maxOutputTokens: 'no', contextTokens: 'engine', fallbacks: 'engine',
        note: 'Models are synced from the CLI (`agent --list-models` or Claude `/model`). Pick one here; it is passed as --model unless the command template contains {model}.' };
    case 'devin':
      return { modelSelect: 'yes', reasoningEffort: 'no', temperature: 'no', maxOutputTokens: 'no', contextTokens: 'no', fallbacks: 'engine',
        note: 'Models are synced from Devin (list-models API). Pick one here; it is sent as devin_mode on session create. Set organization ID on the Devin backend if auto-detect fails.' };
    case 'manual':
      return { modelSelect: 'no', reasoningEffort: 'no', temperature: 'no', maxOutputTokens: 'no', contextTokens: 'no', fallbacks: 'engine',
        note: 'A person does the work; there is no model to configure.' };
    default:
      return { modelSelect: 'no', reasoningEffort: 'no', temperature: 'no', maxOutputTokens: 'no', contextTokens: 'engine', fallbacks: 'engine',
        note: 'Scripted demo backend: deterministic, no real model.' };
  }
}

export function modelSettings(settings: Record<string, unknown> | undefined): AgentModelSettings {
  const s = (settings ?? {}) as AgentModelSettings;
  return {
    reasoningEffort: s.reasoningEffort,
    temperature: typeof s.temperature === 'number' ? s.temperature : undefined,
    maxOutputTokens: typeof s.maxOutputTokens === 'number' ? s.maxOutputTokens : undefined,
    contextTokens: typeof s.contextTokens === 'number' ? s.contextTokens : undefined,
    fallbacks: Array.isArray(s.fallbacks) ? s.fallbacks : [],
    tierOverride: s.tierOverride === 'fast' || s.tierOverride === 'standard' || s.tierOverride === 'strong' ? s.tierOverride : null,
    cliSession: cliSessionSettings(settings),
  };
}

// Output budget: agent override capped by what the model can emit.
export function effectiveMaxOutput(settings: AgentModelSettings, model: ModelRow | null, dflt: number): number {
  const cap = model?.maxOutputTokens ?? dflt;
  return Math.min(settings.maxOutputTokens ?? cap, cap);
}

// Context budget the engine packs into a prompt for this agent.
export function contextBudget(settings: Record<string, unknown> | undefined, model: ModelRow | null, wanted: number): number {
  const s = modelSettings(settings);
  const modelCap = model?.contextTokens ? Math.floor(model.contextTokens * 0.6) : wanted;
  return Math.max(2000, Math.min(wanted, s.contextTokens ?? wanted, modelCap));
}

export const THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 24576 };

// Validate an owner-supplied settings patch; returns problems for the UI.
export function validateModelSettings(s: AgentModelSettings): string[] {
  const p: string[] = [];
  if (s.reasoningEffort && !['auto', 'off', 'low', 'medium', 'high'].includes(s.reasoningEffort)) p.push('reasoningEffort must be auto|off|low|medium|high');
  if (s.temperature != null && (s.temperature < 0 || s.temperature > 2)) p.push('temperature must be between 0 and 2');
  if (s.maxOutputTokens != null && (s.maxOutputTokens < 256 || !Number.isInteger(s.maxOutputTokens))) p.push('maxOutputTokens must be an integer ≥ 256');
  if (s.contextTokens != null && (s.contextTokens < 2000 || !Number.isInteger(s.contextTokens))) p.push('contextTokens must be an integer ≥ 2000');
  if (s.tierOverride != null && !['fast', 'standard', 'strong'].includes(s.tierOverride)) p.push('tierOverride must be fast|standard|strong');
  if (s.cliSession != null) {
    const c = s.cliSession as Partial<CliSessionSettings>;
    if (c.mode != null && !['reuse', 'new', 'pinned'].includes(c.mode)) p.push('cliSession.mode must be reuse|new|pinned');
    if (c.whenBusy != null && !['new', 'wait'].includes(c.whenBusy)) p.push('cliSession.whenBusy must be new|wait');
    if (c.rotateAfter != null && !(Number.isInteger(c.rotateAfter) && c.rotateAfter >= 0 && c.rotateAfter <= 1000)) p.push('cliSession.rotateAfter must be a whole number from 0 to 1000');
    if (c.mode === 'pinned' && !c.pinnedId) p.push('choose the session to pin');
  }
  return p;
}
