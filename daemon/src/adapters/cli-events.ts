// Turns a CLI agent's output stream into readable activity. Only what the CLI
// actually emits is shown — no summaries, no extra model calls:
//   Claude Code  (--output-format stream-json): system/init, assistant
//                messages with text / tool_use / thinking blocks, user
//                messages with tool_result blocks, result, rate_limit_event
//   cursor-agent (--output-format stream-json): system/init, assistant
//                messages, tool_call started/completed, thinking, result
//   anything else (e.g. Devin CLI): each plain-text line is a message
// Technical records (init, heartbeats, rate-limit notices, stream deltas,
// token counters) are classified 'technical' and kept for the debug log.

export type ActivityKind = 'message' | 'tool' | 'tool-result' | 'reasoning' | 'todo' | 'error' | 'result' | 'status' | 'technical';

export interface ActivityItem {
  kind: ActivityKind;
  text: string;                 // what to show
  tool?: string;                // tool name as the CLI reports it
  op?: 'read' | 'edit' | 'write' | 'search' | 'command' | 'web' | 'other';
  file?: string;
  command?: string;
  callId?: string;
  ok?: boolean;
  detail?: string;              // tool output excerpt, error text
  todos?: { text: string; status: string }[];
  costUsd?: number; inputTokens?: number; outputTokens?: number; durationMs?: number;
  sessionId?: string; model?: string;
}

const clip = (s: unknown, n = 600) => { const t = typeof s === 'string' ? s : JSON.stringify(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.text ?? '')).filter(Boolean).join('\n');
  return '';
}

// Claude Code tool_use → readable item
function claudeTool(name: string, input: Record<string, any>, id?: string): ActivityItem {
  const file = input.file_path ?? input.path ?? input.notebook_path;
  switch (name) {
    case 'Read': return { kind: 'tool', tool: name, op: 'read', file, text: `Read ${file}`, callId: id };
    case 'Edit': case 'MultiEdit': return { kind: 'tool', tool: name, op: 'edit', file, text: `Edit ${file}`, callId: id };
    case 'Write': return { kind: 'tool', tool: name, op: 'write', file, text: `Write ${file}`, callId: id };
    case 'NotebookEdit': return { kind: 'tool', tool: name, op: 'edit', file, text: `Edit notebook ${file}`, callId: id };
    case 'Bash': return { kind: 'tool', tool: name, op: 'command', command: input.command, text: input.description ? `${input.description}` : `Run ${clip(input.command, 160)}`, detail: input.command, callId: id };
    case 'Grep': return { kind: 'tool', tool: name, op: 'search', file: input.path, text: `Search for "${clip(input.pattern, 80)}"${input.path ? ` in ${input.path}` : ''}`, callId: id };
    case 'Glob': return { kind: 'tool', tool: name, op: 'search', text: `Find files ${input.pattern}`, callId: id };
    case 'LS': return { kind: 'tool', tool: name, op: 'read', file: input.path, text: `List ${input.path}`, callId: id };
    case 'WebFetch': case 'WebSearch': return { kind: 'tool', tool: name, op: 'web', text: `${name} ${clip(input.url ?? input.query, 160)}`, callId: id };
    case 'TodoWrite': return { kind: 'todo', tool: name, text: 'Updated the plan', todos: (input.todos ?? []).map((t: any) => ({ text: String(t.content ?? t.text ?? ''), status: String(t.status ?? '') })), callId: id };
    case 'Task': return { kind: 'tool', tool: name, op: 'other', text: `Sub-agent: ${clip(input.description ?? input.prompt, 160)}`, callId: id };
    default: return { kind: 'tool', tool: name, op: 'other', text: `${name} ${clip(input, 160)}`, callId: id };
  }
}

// cursor-agent tool_call → readable item
function cursorTool(tc: Record<string, any>, started: boolean, callId?: string): ActivityItem {
  const key = Object.keys(tc ?? {})[0] ?? 'tool';
  const call = tc?.[key] ?? {};
  const args = call.args ?? {};
  const name = key.replace(/ToolCall$/, '');
  const res = call.result;
  const failed = !!(res && (res.error || res.failure || res.rejected));
  const base: ActivityItem = (() => {
    switch (name) {
      case 'read': return { kind: 'tool', tool: name, op: 'read', file: args.path, text: `Read ${args.path}` };
      case 'edit': case 'write': case 'applyPatch': return { kind: 'tool', tool: name, op: name === 'write' ? 'write' : 'edit', file: args.path, text: `${name === 'write' ? 'Write' : 'Edit'} ${args.path ?? ''}`.trim() };
      case 'delete': return { kind: 'tool', tool: name, op: 'edit', file: args.path, text: `Delete ${args.path}` };
      case 'shell': case 'terminal': return { kind: 'tool', tool: name, op: 'command', command: args.command, text: `Run ${clip(args.command, 160)}` };
      case 'grep': case 'search': case 'semSearch': case 'codebaseSearch': return { kind: 'tool', tool: name, op: 'search', text: `Search for "${clip(args.pattern ?? args.query, 80)}"` };
      case 'glob': case 'ls': return { kind: 'tool', tool: name, op: 'search', text: `${name === 'ls' ? 'List' : 'Find files'} ${args.path ?? args.globPattern ?? args.pattern ?? ''}` };
      case 'updateTodos': case 'todo': return { kind: 'todo', tool: name, text: 'Updated the plan', todos: (args.todos ?? []).map((t: any) => ({ text: String(t.content ?? ''), status: String(t.status ?? '') })) };
      default: return { kind: 'tool', tool: name, op: 'other', text: `${name} ${clip(args, 160)}` };
    }
  })();
  if (started) return { ...base, callId };
  const out = res?.success ?? res?.error ?? res;
  return { kind: 'tool-result', tool: name, op: base.op, file: base.file, command: base.command, callId, ok: !failed,
    text: `${failed ? 'Failed' : 'Done'}: ${base.text}`, detail: clip(out?.stdout ?? out?.content ?? out?.message ?? out, 800) };
}

const TECHNICAL_TYPES = new Set(['rate_limit_event', 'stream_event', 'ping', 'heartbeat', 'keep_alive', 'connection', 'usage', 'thinking_tokens']);

/** Parse one complete output line. */
export function parseCliLine(line: string): ActivityItem[] {
  const t = line.trim();
  if (!t) return [];
  if (!t.startsWith('{')) return [{ kind: 'message', text: clip(t, 2000) }];
  let ev: any;
  try { ev = JSON.parse(t); } catch { return [{ kind: 'technical', text: clip(t, 500) }]; }
  const type = String(ev.type ?? '');
  if (TECHNICAL_TYPES.has(type)) return [{ kind: 'technical', text: clip(t, 500) }];
  if (type === 'system') {
    return [{ kind: 'technical', text: `${ev.subtype ?? 'system'}${ev.model ? ` · model ${ev.model}` : ''}${ev.session_id ? ` · session ${ev.session_id}` : ''}`, sessionId: ev.session_id, model: ev.model }];
  }
  if (type === 'assistant' || type === 'user') {
    const content = ev.message?.content;
    if (typeof content === 'string') return type === 'assistant' && content.trim() ? [{ kind: 'message', text: content }] : [];
    const out: ActivityItem[] = [];
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && type === 'assistant' && String(b.text ?? '').trim()) out.push({ kind: 'message', text: String(b.text) });
      else if (b?.type === 'thinking' && String(b.thinking ?? '').trim()) out.push({ kind: 'reasoning', text: String(b.thinking) });
      else if (b?.type === 'tool_use') out.push(claudeTool(String(b.name), b.input ?? {}, b.id));
      else if (b?.type === 'tool_result') {
        const text = contentText(b.content);
        out.push({ kind: 'tool-result', callId: b.tool_use_id, ok: !b.is_error, text: b.is_error ? 'Tool error' : 'Tool result', detail: clip(text, 800) });
      }
    }
    return out;
  }
  if (type === 'tool_call') return [cursorTool(ev.tool_call ?? {}, ev.subtype === 'started', ev.call_id)];
  if (type === 'thinking') {
    // cursor streams reasoning as deltas; only completed text is worth showing
    return ev.subtype === 'completed' && ev.text ? [{ kind: 'reasoning', text: String(ev.text) }] : [{ kind: 'technical', text: `thinking ${ev.subtype ?? ''}`.trim() }];
  }
  if (type === 'result') {
    return [{ kind: ev.is_error || (ev.subtype && ev.subtype !== 'success') ? 'error' : 'result', text: ev.is_error ? `Finished with an error: ${clip(ev.result ?? ev.subtype, 400)}` : `Finished${ev.num_turns ? ` after ${ev.num_turns} turns` : ''}`,
      costUsd: Number(ev.total_cost_usd) || undefined, inputTokens: Number(ev.usage?.input_tokens) || undefined, outputTokens: Number(ev.usage?.output_tokens) || undefined,
      durationMs: Number(ev.duration_ms) || undefined, sessionId: ev.session_id }];
  }
  if (type === 'error' || ev.error) return [{ kind: 'error', text: clip(ev.error?.message ?? ev.message ?? ev.error ?? t, 800) }];
  return [{ kind: 'technical', text: clip(t, 500) }];
}

/** Line-buffered stream parser: feed chunks, get items for complete lines. */
// Terminal control sequences (colours, cursor moves, OSC titles) that TUI-style
// CLIs write between their text.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
export function stripAnsi(s: string): string { return s.replace(ANSI, ''); }

export class CliStream {
  private buf = '';
  private last = '';
  /** Complete lines as raw text (ANSI stripped; \r redraws count as lines). */
  pushLines(chunk: string): string[] {
    this.buf += stripAnsi(chunk);
    const lines = this.buf.split(/\r\n|\n|\r/);
    this.buf = lines.pop() ?? '';
    // a redrawn status line repeats itself — keep it once
    return lines.map((l) => l.trimEnd()).filter((l) => { if (!l.trim() || l === this.last) return false; this.last = l; return true; });
  }
  push(chunk: string): ActivityItem[] {
    return this.pushLines(chunk).flatMap(parseCliLine);
  }
  /** The unfinished line, if any (for CLIs that print without newlines). */
  pending(): string { return this.buf; }
  flushLines(): string[] {
    const rest = this.buf.trimEnd(); this.buf = '';
    if (!rest.trim() || rest === this.last) return [];
    this.last = rest;
    return [rest];
  }
  flush(): ActivityItem[] { return this.flushLines().flatMap(parseCliLine); }
}
