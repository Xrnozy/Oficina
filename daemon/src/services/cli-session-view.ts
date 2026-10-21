import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { parseJson } from '../util.ts';
import { cliExecutable, cliSessionSupport, effectiveCliCommand, prepareCliCommand, withSessionArgs } from '../adapters/cli-resolve.ts';
import { getSession, type CliSessionRow } from './cli-sessions.ts';

// What the owner sees of a CLI session, and how they step into it: its node, agent and backend, the work it did, the
// conversation itself where the CLI keeps it readable (Claude Code's transcript), and the exact command that continues
// it in a terminal. A terminal opened from here holds the session like a work item does: the node's agent waits for
// it instead of starting a second conversation, and continues once the terminal is closed.

export interface SessionTurn { role: string; text: string; at: string | null }
export interface SessionDetails {
  session: CliSessionRow & { agentName: string | null; backend: string | null; provider: string | null };
  resumeCommand: string | null;        // the command that continues this exact conversation, run in session.cwd
  canOpen: boolean; whyNot: string | null;
  work: { id: string; kind: string; status: string; task: string | null; runId: string; startedAt: string | null; finishedAt: string | null; prompt: string; reply: string }[];
  transcript: { source: string; turns: SessionTurn[]; total: number } | null;   // the CLI's own record, when readable
}

function backendOf(s: CliSessionRow): { template: string; cfg: Record<string, unknown>; label: string | null; provider: string | null } | null {
  const a = s.accountId ? q1('SELECT a.label, a.config, p.name FROM accounts a JOIN providers p ON p.id = a.provider_id WHERE a.id = ?', s.accountId) : null;
  if (!a) return null;
  const cfg = parseJson<Record<string, unknown>>(a.config as string, {});
  return { template: effectiveCliCommand(String(cfg.command ?? '')), cfg, label: (a.label as string) || null, provider: (a.name as string) || null };
}

/** The interactive command that continues this session: the CLI's executable plus its resume arguments. */
export function resumeCommandFor(s: CliSessionRow): string | null {
  const b = backendOf(s);
  if (!b || !s.externalId || !s.started) return null;
  const support = cliSessionSupport(b.template, b.cfg);
  if (!support) return null;
  return withSessionArgs(cliExecutable(b.template).token, support.resume, s.externalId);
}

/** Claude Code keeps each conversation as JSONL under ~/.claude/projects/<folder with non-alphanumerics as '-'>/<id>.jsonl. */
export function claudeTranscriptPath(cwd: string, externalId: string): string {
  const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(root, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${externalId}.jsonl`);
}

export function readClaudeTranscript(file: string, limit = 300): { turns: SessionTurn[]; total: number } | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const turns: SessionTurn[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let ev: { type?: string; timestamp?: string; message?: { role?: string; content?: unknown } };
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    const c = ev.message?.content;
    const parts: string[] = [];
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) {
      for (const b of c as { type?: string; text?: string; name?: string; input?: unknown }[]) {
        if (b.type === 'text' && b.text) parts.push(b.text);
        else if (b.type === 'tool_use') parts.push(`[tool: ${b.name ?? '?'}${b.input ? ` ${JSON.stringify(b.input).slice(0, 160)}` : ''}]`);
        else if (b.type === 'tool_result') parts.push('[tool result]');
      }
    }
    const t = parts.join('\n').trim();
    if (t) turns.push({ role: ev.message?.role ?? ev.type, text: t.length > 4000 ? `${t.slice(0, 4000)}…` : t, at: ev.timestamp ?? null });
  }
  return { turns: turns.slice(-limit), total: turns.length };
}

export function sessionDetails(id: string): SessionDetails | null {
  const s = getSession(id);
  if (!s) return null;
  const b = backendOf(s);
  const agentName = s.agentId ? ((q1('SELECT name FROM agents WHERE id = ?', s.agentId)?.name as string) ?? null) : null;
  const work = q(`SELECT w.id, w.kind, w.status, w.run_id, w.started_at, w.finished_at, w.result, t.title, p.rendered_text
                  FROM work_items w LEFT JOIN tasks t ON t.id = w.task_id LEFT JOIN prompt_versions p ON p.id = w.prompt_version_id
                  WHERE w.cli_session_id = ? ORDER BY w.started_at DESC LIMIT 100`, id).map((w) => ({
    id: w.id as string, kind: w.kind as string, status: w.status as string, task: (w.title as string) ?? null, runId: w.run_id as string,
    startedAt: (w.started_at as string) ?? null, finishedAt: (w.finished_at as string) ?? null,
    prompt: String(w.rendered_text ?? '').slice(0, 3000),
    reply: String(parseJson<{ summary?: string }>(w.result as string, {}).summary ?? '').slice(0, 3000),
  }));
  let transcript: SessionDetails['transcript'] = null;
  if (s.preset === 'claude' && s.externalId) {
    const file = claudeTranscriptPath(s.cwd, s.externalId);
    const t = readClaudeTranscript(file);
    if (t) transcript = { source: file, ...t };
  }
  const resumeCommand = resumeCommandFor(s);
  const whyNot = !resumeCommand ? (s.started ? 'this CLI has no way to continue a session' : 'the session has not been started by its agent yet')
    : s.status !== 'active' ? 'the session is archived'
      : s.busyItem ? (s.busyItem.startsWith('terminal:') ? 'it is already open in a terminal' : 'its agent is using it right now — open it when the work item has finished')
        : !fs.existsSync(s.cwd) ? `its folder no longer exists (${s.cwd})` : null;
  return { session: { ...s, agentName, backend: b?.label ?? null, provider: b?.provider ?? null }, resumeCommand, canOpen: !whyNot, whyNot, work, transcript };
}

/**
 * Open the session in a terminal window of its own, in the folder that started it, continuing that conversation.
 * Windows: a new console; the session is held for the terminal until it closes. Elsewhere the platform terminal is
 * asked to run the command (not tracked: close it before agents work again).
 */
export function openInTerminal(id: string): { ok: true; command: string; cwd: string; tracked: boolean } | { error: string } {
  const d = sessionDetails(id);
  if (!d) return { error: 'session not found' };
  if (!d.canOpen || !d.resumeCommand) return { error: `can't open this session: ${d.whyNot}` };
  const s = d.session;
  const { cmd, env } = prepareCliCommand(d.resumeCommand);
  const marker = `terminal:${s.id}`;
  // hold it first, atomically: an agent that starts this instant waits for the terminal instead of racing it
  run('UPDATE cli_sessions SET busy_item = ? WHERE id = ? AND busy_item IS NULL', marker, s.id);
  if (getSession(s.id)?.busyItem !== marker) return { error: 'its agent started using it just now — try again when the work item has finished' };
  const release = () => run(`UPDATE cli_sessions SET busy_item = NULL WHERE id = ? AND busy_item LIKE ?`, s.id, `${marker}%`);
  // the terminal's pid rides on the marker, so a daemon restart can tell an open terminal from a closed one
  const withPid = (pid: number | undefined) => { if (pid) run('UPDATE cli_sessions SET busy_item = ? WHERE id = ? AND busy_item = ?', `${marker}:${pid}`, s.id, marker); };
  try {
    let child;
    if (process.platform === 'win32') {
      // detached: a console window of its own, which stays open (cmd /k) when the CLI exits. /s + outer quotes: cmd
      // strips exactly those, so a quoted executable path and the quoted session id both survive (as in spawnShell)
      child = spawn('cmd.exe', ['/d', '/s', '/k', `"${cmd}"`], { cwd: s.cwd, env, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true });
      withPid(child.pid);
      child.on('exit', release);
      child.on('error', release);
      child.unref();
    } else if (process.platform === 'darwin') {
      const script = `cd ${JSON.stringify(s.cwd)} && ${cmd}`;
      child = spawn('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(script)}`, '-e', 'tell application "Terminal" to activate'], { stdio: 'ignore', detached: true });
      child.unref(); release();
    } else {
      child = spawn('x-terminal-emulator', ['-e', 'sh', '-c', `cd ${JSON.stringify(s.cwd)} && ${cmd}; exec sh`], { env, stdio: 'ignore', detached: true });
      withPid(child.pid);
      child.on('error', release);
      child.on('exit', release);
      child.unref();
    }
  } catch (e) {
    release();
    return { error: `could not open a terminal: ${String((e as Error)?.message ?? e)}` };
  }
  emit('cli.session.opened', 'owner', { sessionId: s.id, label: s.label, agent: s.agentName, command: d.resumeCommand, cwd: s.cwd });
  return { ok: true, command: d.resumeCommand, cwd: s.cwd, tracked: process.platform !== 'darwin' };
}
