import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.ts';
import { headSha } from '../services/git.ts';
import { buildCliCommand, cliExecutable, effectiveCliCommand, prepareCliCommand, spawnShell } from './cli-resolve.ts';
import { parseJsonFromText } from './llm.ts';
import { CliStream, parseCliLine } from './cli-events.ts';
import { AdapterError, type Adapter, type AdapterCtx } from './types.ts';
import { rateLimitRetryAfterSec } from '../services/usage.ts';
import type { WorkItemResult } from '../types.ts';

// CLI adapter (spec tier 2): runs a headless agent CLI (e.g. `claude -p`,
// `agent -p --output-format stream-json --force`) as a child process inside the task
// worktree. Delivery is detected via the Git boundary: when the process
// exits, HEAD on the task branch is the result. Streams stdout lines as
// agent.output events; hard timeout per account.config.timeoutSec.

export const cliAdapter: Adapter = {
  id: 'cli',
  version: '1.0.0',

  async dispatch(ctx: AdapterCtx): Promise<WorkItemResult> {
    // File-changing work items run inside the task worktree. Review and
    // analysis run in the repo root so the agent can read the code. Planning
    // and prompt work is orchestration — it gets an empty desk outside the
    // repository, so the PM (and Prompt Creator) can never touch code.
    const kind = ctx.workItem.kind;
    const fileWork = ['implement', 'fix', 'test', 'doc'].includes(kind);
    // (acceptance is the PM judging reports — it never needs the code either)
    const orchestration = ['plan', 'prompt', 'prompt-review', 'accept'].includes(kind);
    const desk = orchestration ? path.join(DATA_DIR, 'desks', ctx.agent.id.replace(/[^\w-]+/g, '_')) : null;
    if (desk) fs.mkdirSync(desk, { recursive: true });
    const cwd = desk ?? ctx.worktree ?? (fileWork ? null : ctx.repo?.path);
    if (!cwd) throw new Error('cli adapter requires a worktree (or a repo path for non-file work)');
    const cfg = (ctx.account?.config ?? {}) as Record<string, unknown>;
    const template = effectiveCliCommand(String(cfg.command ?? ''));
    const timeoutSec = Number(cfg.timeoutSec) || 900;
    // {promptFile}: the prompt is written outside the repo and its path passed
    // (CLIs such as `devin -p --prompt-file` that don't read stdin).
    const promptFile = template.includes('{promptFile}')
      ? path.join(DATA_DIR, 'prompts', `${ctx.workItem.id}.md`)
      : null;
    if (promptFile) {
      fs.mkdirSync(path.dirname(promptFile), { recursive: true });
      fs.writeFileSync(promptFile, ctx.prompt);
    }
    const { cmd, stdin } = buildCliCommand(template, { prompt: ctx.prompt, promptFile, worktree: cwd, model: ctx.model?.name });

    const { cmd: spawnCmd, env: spawnEnv } = prepareCliCommand(cmd);
    ctx.emit('agent.output', { line: `[cli] spawn: ${spawnCmd.slice(0, 160)}${stdin ? ' (prompt via stdin)' : ''}` });
    const beforeSha = ctx.worktree ? headSha(ctx.worktree) : null;
    // cwd is set via spawn options — embedding `cd /d "<path>"` into the
    // command line breaks on Windows when the path contains spaces.

    // Every output line (newline- or \r-terminated, ANSI codes stripped) goes
    // to the technical log (agent.output) and, parsed, to the activity view
    // (agent.activity). CLIs that print a line without ending it are flushed
    // after 2 s of quiet, so nothing waits for the process to exit.
    const streams = { stdout: new CliStream(), stderr: new CliStream() };
    // what the agent said in plain text, with when — its final message is the
    // burst of lines printed just before it exits (CLIs without a result event)
    const said: { at: number; text: string }[] = [];
    // streamed reasoning arrives a few words per event; it is joined into one
    // block (and one technical line) instead of thousands of records
    let thinking = '';
    let thinkingParts = 0;
    const flushThinking = () => {
      if (!thinking) return;
      ctx.emit('agent.output', { line: `[thinking] ${thinkingParts} streamed parts, ${thinking.length} chars`, stream: 'stdout' });
      if (thinking.trim()) ctx.emit('agent.activity', { kind: 'reasoning', text: thinking.trim() });
      thinking = ''; thinkingParts = 0;
    };
    const emitLines = (lines: string[], from: 'stdout' | 'stderr') => {
      for (const line of lines) {
        const delta = streamDelta(line);
        if (delta !== null) { thinking += delta; thinkingParts++; continue; }
        flushThinking();
        ctx.emit('agent.output', { line: line.slice(0, 2000), stream: from });
        for (const it of parseCliLine(line)) {
          if (it.kind === 'technical') continue;
          if (from === 'stdout' && it.kind === 'message') said.push({ at: Date.now(), text: it.text });
          ctx.emit('agent.activity', from === 'stderr' && it.kind === 'message' ? { ...it, kind: 'error' } : it);
        }
      }
    };
    const started = Date.now();
    const { code, output } = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawnShell(spawnCmd, { cwd, env: spawnEnv });
      ctx.emit('agent.activity', { kind: 'status', text: `Started ${cliExecutable(template).name}${child.pid ? ` (pid ${child.pid})` : ''} in ${cwd}${ctx.model?.name ? ` · model ${ctx.model.name}` : ''}` });
      let out = '';
      let lastData = Date.now();
      const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutSec * 1000);
      const idle = setInterval(() => {
        if (Date.now() - lastData < 2000) return;
        for (const from of ['stdout', 'stderr'] as const) if (streams[from].pending().trim()) emitLines(streams[from].flushLines(), from);
      }, 1000);
      if (stdin) { child.stdin!.write(ctx.prompt); child.stdin!.end(); }
      const onData = (from: 'stdout' | 'stderr') => (d: Buffer) => {
        const s = String(d);
        out += s;
        lastData = Date.now();
        emitLines(streams[from].pushLines(s), from);
        ctx.emit('agent.heartbeat', {});
      };
      child.stdout!.on('data', onData('stdout'));
      child.stderr!.on('data', onData('stderr'));
      child.on('close', (c) => {
        clearTimeout(killer); clearInterval(idle);
        emitLines(streams.stdout.flushLines(), 'stdout'); emitLines(streams.stderr.flushLines(), 'stderr');
        flushThinking();
        const secs = Math.round((Date.now() - started) / 1000);
        ctx.emit('agent.activity', { kind: c === 0 ? 'status' : 'error', text: `${cliExecutable(template).name} exited with code ${c} after ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}` });
        resolve({ code: c, output: out });
      });
      child.on('error', (e) => { clearTimeout(killer); clearInterval(idle); ctx.emit('agent.activity', { kind: 'error', text: `could not start the CLI: ${String(e)}` }); resolve({ code: -1, output: String(e) }); });
    });

    const afterSha = ctx.worktree ? headSha(ctx.worktree) : null;
    const committed = afterSha && afterSha !== beforeSha;

    // Extract the agent's reply text + real usage. With --output-format
    // stream-json (Claude Code, cursor-agent) the final {"type":"result"}
    // event carries result text, total_cost_usd and token usage.
    let replyText = '';
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    for (const line of output.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'result') {
          replyText = String(ev.result ?? replyText);
          costUsd = Number(ev.total_cost_usd ?? costUsd) || costUsd;
          inputTokens = Number(ev.usage?.input_tokens ?? inputTokens) || inputTokens;
          outputTokens = Number(ev.usage?.output_tokens ?? outputTokens) || outputTokens;
        }
      } catch { /* not a json line */ }
    }
    // plain-text CLIs (e.g. Devin): the reply is the final message, not the
    // first line of the log
    const finalMessage = finalBurst(said);
    if (!replyText) replyText = finalMessage || output.slice(-8000);
    if (promptFile) fs.rmSync(promptFile, { force: true });

    if (code !== 0 && !committed) {
      const wait = rateLimitRetryAfterSec(output);
      if (wait != null) throw new AdapterError(`rate limited: ${output.slice(-500)}`, 'rate-limit', { 'retry-after': String(wait) });
      throw new Error(`cli exited ${code}: ${output.slice(-800)}`);
    }
    return {
      summary: (finalMessage || replyText).slice(0, 4000) || `CLI agent finished (exit ${code})`,
      sha: afterSha ?? undefined,
      raw: { tail: output.slice(-4000), exitCode: code, text: replyText, json: parseJsonFromText(replyText) },
      usage: { costUsd, inputTokens, outputTokens, costSource: costUsd ? 'provider' : 'estimate' },
    };
  },
};

// A streamed reasoning/text fragment (cursor-agent `thinking` deltas, Claude
// `stream_event` deltas): its text, or null for any other line.
function streamDelta(line: string): string | null {
  if (!line.startsWith('{') || !line.includes('delta')) return null;
  try {
    const ev = JSON.parse(line);
    if (ev.type === 'thinking' && ev.subtype === 'delta') return String(ev.text ?? '');
    if (ev.type === 'stream_event') {
      const d = ev.event?.delta;
      return String(d?.thinking ?? d?.text ?? '');
    }
  } catch { /* not json */ }
  return null;
}

// The last burst of messages (lines printed within 3 s of each other at the end).
export function finalBurst(said: { at: number; text: string }[]): string {
  if (!said.length) return '';
  let i = said.length - 1;
  while (i > 0 && said[i].at - said[i - 1].at <= 3000) i--;
  return said.slice(i).map((x) => x.text).join('\n').trim();
}
