import { scriptedAdapter } from './scripted.ts';
import { openaiCompatAdapter, anthropicAdapter } from './llm.ts';
import { cliAdapter } from './cli.ts';
import { manualAdapter } from './manual.ts';
import { devinAdapter } from './devin.ts';
import type { Adapter } from './types.ts';

const registry = new Map<string, Adapter>([
  ['scripted', scriptedAdapter],
  ['openai-compatible', openaiCompatAdapter],
  ['anthropic', anthropicAdapter],
  ['cli', cliAdapter],
  ['manual', manualAdapter],
  ['devin', devinAdapter],
]);

export function getAdapter(id: string): Adapter {
  const a = registry.get(id);
  if (!a) throw new Error(`no adapter registered for '${id}'`);
  return a;
}

export function listAdapters(): { id: string; version: string }[] {
  return [...registry.values()].map((a) => ({ id: a.id, version: a.version }));
}
