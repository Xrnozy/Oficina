import path from 'node:path';
import { writeFileEnsured } from '../util.ts';
import { resolveSecret } from '../config.ts';
import { THINKING_BUDGET, effectiveMaxOutput, modelSettings } from '../services/models.ts';
import type { Adapter, AdapterCtx } from './types.ts';
import { AdapterError } from './types.ts';
import type { WorkItemResult } from '../types.ts';

// Model-provider adapter (spec tier 1): the Office runs the tool loop, so this
// adapter sends the rendered prompt and parses the model's output contract.
// Supports OpenAI-compatible endpoints (/chat/completions — incl. Ollama, LM
// Studio, OpenRouter, Gemini-compat, etc.) and the Anthropic Messages API.

interface LlmReply {
  text: string;
  inputTokens: number;
  outputTokens: number;
  headers: Record<string, string>;
}

function headersToObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { o[k.toLowerCase()] = v; });
  return o;
}

async function chatCompletions(ctx: AdapterCtx, baseUrl: string, apiKey: string | null): Promise<LlmReply> {
  const model = ctx.model?.name ?? 'default';
  const s = modelSettings(ctx.agent.settings);
  const maxOut = effectiveMaxOutput(s, ctx.model, 4096);
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOut,
      ...(s.temperature != null ? { temperature: s.temperature } : {}),
      ...(s.reasoningEffort && s.reasoningEffort !== 'off' ? { reasoning_effort: s.reasoningEffort } : {}),
      messages: [
        { role: 'system', content: ctx.agent.instructions || 'You are an agent inside the AI Agent Office. Follow the output contract exactly.' },
        { role: 'user', content: ctx.prompt },
      ],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  const hdrs = headersToObj(res.headers);
  if (res.status === 401 || res.status === 403) throw new AdapterError(`auth failed (${res.status})`, 'auth', hdrs);
  if (res.status === 429) throw new AdapterError('rate limited', 'rate-limit', hdrs);
  if (res.status >= 500) throw new AdapterError(`provider ${res.status}`, 'server', hdrs);
  if (!res.ok) throw new AdapterError(`provider error ${res.status}: ${await res.text().catch(() => '')}`, 'bad-response', hdrs);
  const body = await res.json() as any;
  const text = body.choices?.[0]?.message?.content ?? '';
  return {
    text,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
    headers: hdrs,
  };
}

async function anthropicMessages(ctx: AdapterCtx, baseUrl: string, apiKey: string | null): Promise<LlmReply> {
  const s = modelSettings(ctx.agent.settings);
  const thinking = s.reasoningEffort && s.reasoningEffort !== 'off' ? THINKING_BUDGET[s.reasoningEffort] : 0;
  // the output budget must leave room above the thinking budget
  const maxOut = Math.max(effectiveMaxOutput(s, ctx.model, 8192), thinking + 1024);
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify({
      model: ctx.model?.name ?? 'claude-sonnet-4-5',
      max_tokens: maxOut,
      ...(thinking ? { thinking: { type: 'enabled', budget_tokens: thinking } } : s.temperature != null ? { temperature: s.temperature } : {}),
      system: ctx.agent.instructions || 'You are an agent inside the AI Agent Office. Follow the output contract exactly.',
      messages: [{ role: 'user', content: ctx.prompt }],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const hdrs = headersToObj(res.headers);
  if (res.status === 401 || res.status === 403) throw new AdapterError(`auth failed (${res.status})`, 'auth', hdrs);
  if (res.status === 429) throw new AdapterError('rate limited', 'rate-limit', hdrs);
  if (res.status >= 500) throw new AdapterError(`provider ${res.status}`, 'server', hdrs);
  if (!res.ok) throw new AdapterError(`provider error ${res.status}: ${await res.text().catch(() => '')}`, 'bad-response', hdrs);
  const body = await res.json() as any;
  const text = (body.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  return {
    text,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    headers: hdrs,
  };
}

export function parseFileBlocks(text: string): { path: string; content: string }[] {
  const out: { path: string; content: string }[] = [];
  const re = /={3,}\s*FILE:\s*(\S+)\s*={3,}\r?\n([\s\S]*?)(?:={3,}\s*END\s*={3,}|(?=={3,}\s*FILE:)|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ path: m[1].trim(), content: m[2].replace(/\n?={3,}\s*END\s*={3,}\s*$/, '') });
  return out;
}

export function parseJsonFromText<T>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as T; } catch { return null; }
}

export function makeLlmAdapter(id: 'openai-compatible' | 'anthropic'): Adapter {
  return {
    id,
    version: '1.0.0',

    async dispatch(ctx: AdapterCtx): Promise<WorkItemResult> {
      const cfg = (ctx.account?.config ?? {}) as Record<string, unknown>;
      const baseUrl = (String(cfg.baseUrl ?? '').trim())
        || (id === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:11434/v1');
      const apiKey = resolveSecret(ctx.account?.secretRef);
      ctx.emit('agent.output', { line: `[${id}] ${ctx.model?.name ?? 'model'} thinking…` });
      const eff = modelSettings(ctx.agent.settings).reasoningEffort;
      ctx.emit('agent.thinking', { phase: 'request', effort: eff ?? 'default', note: 'reasoning not exposed by this transport' });

      let reply: LlmReply;
      try {
        reply = id === 'anthropic'
          ? await anthropicMessages(ctx, baseUrl, apiKey)
          : await chatCompletions(ctx, baseUrl, apiKey);
      } catch (e) {
        if (e instanceof AdapterError) { ctx.fetchQuotaHeaders?.(e.headers ?? {}); throw e; }
        throw new AdapterError(String(e), 'network');
      }
      ctx.fetchQuotaHeaders?.(reply.headers);
      ctx.emit('agent.output', { line: `[${id}] received ${reply.outputTokens} tokens` });

      const priceIn = ctx.model?.priceIn ?? 0;
      const priceOut = ctx.model?.priceOut ?? 0;
      const costUsd = (reply.inputTokens / 1e6) * priceIn + (reply.outputTokens / 1e6) * priceOut;
      const usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, costUsd, costSource: priceIn || priceOut ? 'computed' as const : 'estimate' as const };

      const kind = ctx.workItem.kind;
      if (kind === 'implement' || kind === 'fix' || kind === 'test' || kind === 'doc') {
        const files = parseFileBlocks(reply.text);
        const changed: string[] = [];
        if (ctx.worktree) {
          for (const f of files) {
            if (f.path.includes('..')) continue;
            writeFileEnsured(path.join(ctx.worktree, f.path), f.content);
            changed.push(f.path);
          }
        }
        return { summary: `Model returned ${files.length} file block(s)`, filesChanged: changed, raw: { text: reply.text.slice(0, 4000), files }, usage };
      }
      return { summary: reply.text.slice(0, 300), raw: { text: reply.text, json: parseJsonFromText(reply.text) }, usage };
    },
  };
}

export const openaiCompatAdapter = makeLlmAdapter('openai-compatible');
export const anthropicAdapter = makeLlmAdapter('anthropic');
