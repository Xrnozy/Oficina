import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../db.ts';
import { headSha } from '../services/git.ts';
import { buildCliCommand, cliExecutable, cliPresetOf, cliSessionSupport, effectiveCliCommand, killProcessTree, prepareCliCommand, spawnShell, withSessionArgs, type CliSessionSupport } from './cli-resolve.ts';
import { getSession } from '../services/cli-sessions.ts';
import { acquireSession, archiveSession, dropSession, listCliSessions, normalizeCwd, releaseSession, sessionIdFromOutput, setSessionExternalId, type CliSessionRow } from '../services/cli-sessions.ts';
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
//
// Each run continues a CLI session the agent already has, instead of starting a new conversation every time
// (see services/cli-sessions.ts for the rules: reuse / new / pinned, busy handling, rotation).

// Live CLI children keyed by pid — a run stop/hard-pause kills the whole
// tree, not just the shell wrapper.
const liveChildren = new Map<number, { runId: string | null; workItemId: string }>();

export function killCliChildrenForRun(runId: string): number {
  let n = 0;
  for (const [pid, meta] of liveChildren) {
    if (meta.runId !== runId) continue;
    // synthetic handle: only pid is needed by killProcessTree on win32
    killProcessTree({ pid } as Parameters<typeof killProcessTree>[0]);
    n++;
  }
  return n;
}

// What a CLI says when the session it was asked to continue no longer exists. Claude Code: "No conversation found with
// session ID: …"; Devin: "Error: No session found matching '…'" (both checked against the real CLIs).
export const SESSION_GONE = /no (conversation|session|chat)s? (found|with)|(session|chat|conversation)[^\n]{0,60}(not found|does not exist|expired|invalid|unknown)|(could not|couldn't|unable to) (find|load|resume)[^\n]{0,40}(session|chat|conversation)|no such (session|chat)|unknown session|invalid session/i;

interface RunOutcome {
  code: number | null; output: string; afterSha: string | null; committed: boolean;
  replyText: string; finalMessage: string; costUsd: number; inputTokens: number; outputTokens: number;
}

export const cliAdapter: Adapter = {
  id: 'cli',
  version: '1.1.0',

  async dispatch(ctx: AdapterCtx): Promise<WorkItemResult> {
    // File-changing work items run inside the task worktree. Review and
    // analysis run in the repo root so the agent can read the code. Planning
    // and prompt work is orchestration — it gets an empty desk outside the
    // repository, so the PM (and Prompt Creator) can never touch code.
    const kind = ctx.workItem.kind;
    const fileWork = ['implement', 'fix', 'test', 'doc'].includes(kind);
    // (acceptance is the PM judging reports — it never needs the code either)
    // (request intake runs before a run exists: it reads the repository when there is one, otherwise it gets the desk)
    const intakeKey = ctx.workItem.runId.startsWith('intake-') ? ctx.workItem.runId : null;
    const orchestration = ['plan', 'prompt', 'prompt-review', 'accept', 'diagnose'].includes(kind) || (!!intakeKey && !ctx.repo);
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

    // A session can be continued only from the folder that started it. The desk, and the repository itself (direct
    // mode), are the same folder every time; a per-task worktree is not.
    const support = cliSessionSupport(template, cfg);
    const preset = cliPresetOf(template)?.id ?? 'custom';
    const stable = !!desk || normalizeCwd(cwd) === normalizeCwd(ctx.repo?.path ?? '\0');

    try {
      let forceNew = false;
      for (let attempt = 0; ; attempt++) {
        const acq = await acquireSession({ agent: ctx.agent, account: ctx.account, preset, cwd, itemId: ctx.workItem.id, support, stable, forceNew,
          dedicated: intakeKey ? { key: intakeKey, label: `Request intake · ${ctx.agent.name} · ${intakeKey.slice(7, 13)}` } : undefined });
        const sess = acq.session;
        if (support) ctx.emit('agent.activity', { kind: 'status', text: `CLI session: ${acq.note}` });

        // CLIs that list their sessions (Devin) are asked before a new one starts, so the new one can be told apart afterwards
        const beforeIds = new Set<string>();
        if (sess && support?.idFrom === 'list' && support.list && !acq.resumed) {
          for (const s of await listCliSessions(template, support.list, cwd)) beforeIds.add(s.id);
        }

        let outcome: RunOutcome;
        let released = false;
        try {
          outcome = await runCli(ctx, { cwd, template, timeoutSec, promptFile, session: sess, resumed: acq.resumed, support });
        } catch (e) {
          if (sess && !released) { releaseSession(sess.id, { itemId: ctx.workItem.id, ok: false }); released = true; }
          throw e;
        }

        const ok = outcome.code === 0 || outcome.committed;
        // a session we asked the CLI to continue, but which it no longer has: retire it and go again with a fresh one
        if (sess && acq.resumed && !ok && attempt === 0 && SESSION_GONE.test(outcome.output)) {
          archiveSession(sess.id, 'the CLI could not find this session any more');
          ctx.emit('agent.activity', { kind: 'status', text: 'The CLI no longer has that session — starting a new one' });
          released = true;
          forceNew = true;
          continue;
        }

        let sessionInfo: { id: string; externalId: string | null; resumed: boolean } | undefined;
        if (sess) {
          let ext: string | null = getSession(sess.id)?.externalId ?? sess.externalId;
          if (!acq.resumed && support) {
            if (support.idFrom === 'stream' || support.idFrom === 'pattern') ext = sessionIdFromOutput(outcome.output, support.pattern) ?? ext;
            else if (support.idFrom === 'list' && support.list) {
              const after = await listCliSessions(template, support.list, cwd);
              const made = after.filter((s) => !beforeIds.has(s.id) && normalizeCwd(s.cwd || cwd) === normalizeCwd(cwd)).sort((a, b) => b.lastAt - a.lastAt)[0];
              ext = made?.id ?? ext;
            }
          }
          if (!ext && !acq.resumed) {
            // the CLI never told us the id, so this session can't be continued: don't keep a row that would pile up
            dropSession(sess.id); released = true;
            ctx.emit('agent.activity', { kind: 'status', text: "Couldn't read this CLI's session id, so the session can't be reused. Set a session pattern on the backend to enable reuse." });
          } else {
            const started = ok || !!ext;
            releaseSession(sess.id, { externalId: ext, itemId: ctx.workItem.id, ok, started });
            released = true;
            sessionInfo = { id: sess.id, externalId: ext, resumed: acq.resumed };
          }
        }

        if (outcome.code !== 0 && !outcome.committed) {
          const wait = rateLimitRetryAfterSec(outcome.output);
          if (wait != null) throw new AdapterError(`rate limited: ${outcome.output.slice(-500)}`, 'rate-limit', { 'retry-after': String(wait) });
          throw new Error(`cli exited ${outcome.code}: ${outcome.output.slice(-800)}`);
        }
        return {
          summary: (outcome.finalMessage || outcome.replyText).slice(0, 4000) || `CLI agent finished (exit ${outcome.code})`,
          sha: outcome.afterSha ?? undefined,
          raw: { tail: outcome.output.slice(-4000), exitCode: outcome.code, text: outcome.replyText, json: parseJsonFromText(outcome.replyText), cliSession: sessionInfo },
          usage: { costUsd: outcome.costUsd, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, costSource: outcome.costUsd ? 'provider' : 'estimate' },
        };
      }
    } finally {
      if (promptFile) fs.rmSync(promptFile, { force: true });
    }
  },
};

// One spawn of the CLI: stream its output into the activity feed and read the result back.
async function runCli(
  ctx: AdapterCtx,
  o: { cwd: string; template: string; timeoutSec: number; promptFile: string | null; session: CliSessionRow | null; resumed: boolean; support: CliSessionSupport | null },
): Promise<RunOutcome> {
  const { cwd, template, timeoutSec, promptFile } = o;
  let { cmd, stdin } = buildCliCommand(template, { prompt: ctx.prompt, promptFile, worktree: cwd, model: ctx.model?.name });
  // continue the session (or start one under the id we chose)
  if (o.session && o.support && o.session.externalId) {
    if (o.resumed) cmd = withSessionArgs(cmd, o.support.resume, o.session.externalId);
    else if (o.support.fresh) cmd = withSessionArgs(cmd, o.support.fresh, o.session.externalId);
  }

  const { cmd: spawnCmd, env: spawnEnv } = prepareCliCommand(cmd);
  ctx.emit('agent.output', { line: `[cli] spawn: ${spawnCmd.slice(0, 200)}${stdin ? ' (prompt via stdin)' : ''}` });
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
    if (child.pid) liveChildren.set(child.pid, { runId: ctx.workItem.runId, workItemId: ctx.workItem.id });
    let out = '';
    let lastData = Date.now();
    const killer = setTimeout(() => { killProcessTree(child); }, timeoutSec * 1000);
    const idle = setInterval(() => {
      if (Date.now() - lastData < 2000) return;
      for (const from of ['stdout', 'stderr'] as const) if (streams[from].pending().trim()) emitLines(streams[from].flushLines(), from);
    }, 1000);
    if (stdin) { child.stdin!.write(ctx.prompt); child.stdin!.end(); }
    // a CLI that reports its session id in its output: record it the moment it appears, so a run that is stopped or crashes
    // part-way can still be reconnected to (the id used to be read only after the process exited)
    let idSaved = !(o.session && !o.resumed && o.support && (o.support.idFrom === 'stream' || o.support.idFrom === 'pattern') && !o.session.externalId);
    const onData = (from: 'stdout' | 'stderr') => (d: Buffer) => {
      const s = String(d);
      out += s;
      if (!idSaved) {
        const found = sessionIdFromOutput(out, o.support!.pattern);
        if (found) { idSaved = true; setSessionExternalId(o.session!.id, found); }
      }
      lastData = Date.now();
      emitLines(streams[from].pushLines(s), from);
      ctx.emit('agent.heartbeat', {});
    };
    child.stdout!.on('data', onData('stdout'));
    child.stderr!.on('data', onData('stderr'));
    child.on('close', (c) => {
      clearTimeout(killer); clearInterval(idle);
      if (child.pid) liveChildren.delete(child.pid);
      emitLines(streams.stdout.flushLines(), 'stdout'); emitLines(streams.stderr.flushLines(), 'stderr');
      flushThinking();
      const secs = Math.round((Date.now() - started) / 1000);
      ctx.emit('agent.activity', { kind: c === 0 ? 'status' : 'error', text: `${cliExecutable(template).name} exited with code ${c} after ${secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`}` });
      resolve({ code: c, output: out });
    });
    child.on('error', (e) => { clearTimeout(killer); clearInterval(idle); if (child.pid) liveChildren.delete(child.pid); ctx.emit('agent.activity', { kind: 'error', text: `could not start the CLI: ${String(e)}` }); resolve({ code: -1, output: String(e) }); });
  });

  const afterSha = ctx.worktree ? headSha(ctx.worktree) : null;
  const committed = !!afterSha && afterSha !== beforeSha;

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
  return { code, output, afterSha, committed, replyText, finalMessage, costUsd, inputTokens, outputTokens };
}

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
