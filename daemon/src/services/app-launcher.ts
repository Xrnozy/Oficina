import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { DATA_DIR } from '../db.ts';

// Runs the project's own application so the owner can test a change by hand. The engine starts and watches it —
// the process, its output and whether its pages answer are facts gathered by code, not claims by a model — and an
// agent then writes the report from those facts. One app per task; the app is stopped when the owner decides, the
// task or run ends, or the daemon exits.

export interface LaunchConfig {
  command?: string;          // how to start it; empty = detect from package.json
  cwd?: string;              // folder to start it in, relative to the repository (default: the repository)
  url?: string;              // where it listens; empty = read it from the app's own output
  readyTimeoutSec?: number;  // how long to wait for it to answer (default 45)
}

export type AppRunState = 'starting' | 'ready' | 'exited' | 'failed' | 'stopped';
export interface AppInfo {
  key: string; state: AppRunState; command: string | null; cwd: string; url: string | null; pid: number | null;
  startedAt: string; exitCode: number | null; note: string; logFile: string; reachable: boolean;
}
export interface RouteProbe { path: string; url: string; status: number | null; ms: number | null; error: string | null }

interface Running { info: AppInfo; child: ChildProcess | null; tail: string[]; detectedUrl: string | null }
const apps = new Map<string, Running>();
const MAX_TAIL = 400;
const ERROR_LINE = /\b(error|exception|unhandled|uncaught|fatal|traceback|EADDRINUSE|ECONNREFUSED|ENOENT|cannot find module|failed to compile|segmentation)\b/i;

const logDir = () => path.join(DATA_DIR, 'app-logs');
const safeKey = (k: string) => k.replace(/[^\w.-]+/g, '_').slice(0, 80);
const nowIso = () => new Date().toISOString();

/** How to start the project when the owner has not said: the usual package.json scripts, and the port that tool defaults to. */
export function detectLaunch(repoPath: string): { command: string | null; urlGuess: string | null; why: string } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const port = deps.vite ? 5173 : deps.next ? 3000 : deps['react-scripts'] ? 3000 : deps['@angular/cli'] ? 4200 : deps.nuxt ? 3000 : deps['@sveltejs/kit'] ? 5173 : deps.astro ? 4321 : null;
    const pick = ['dev', 'start', 'serve'].find((s) => scripts[s]);
    if (pick) return { command: pick === 'start' ? 'npm start' : `npm run ${pick}`, urlGuess: port ? `http://localhost:${port}` : null, why: `package.json script "${pick}"` };
  } catch { /* not a node project */ }
  if (fs.existsSync(path.join(repoPath, 'manage.py'))) return { command: 'python manage.py runserver', urlGuess: 'http://localhost:8000', why: 'Django manage.py' };
  return { command: null, urlGuess: null, why: 'no "dev", "start" or "serve" script in package.json' };
}

/** What an agent needs to know to run the project itself: the detected command, the scripts, the files that show the stack,
 *  and the part of the README that says how to start it. Facts from the repository, not guesses. */
export function launchHints(repoPath: string): string {
  const out: string[] = [];
  const det = detectLaunch(repoPath);
  out.push(det.command ? `Detected start command: ${det.command} (from ${det.why}${det.urlGuess ? `; usually listens on ${det.urlGuess}` : ''})` : `No start command detected: ${det.why}.`);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    const scripts = Object.entries(pkg.scripts ?? {}).slice(0, 12).map(([k, v]) => `  ${k}: ${String(v).slice(0, 100)}`);
    if (scripts.length) out.push(`package.json scripts:\n${scripts.join('\n')}`);
    if (!fs.existsSync(path.join(repoPath, 'node_modules'))) out.push('node_modules is missing: dependencies must be installed first (npm install).');
  } catch { /* not a node project */ }
  const markers = ['requirements.txt', 'pyproject.toml', 'manage.py', 'app.py', 'main.py', 'Makefile', 'docker-compose.yml', 'Dockerfile', 'go.mod', 'Cargo.toml', 'index.html', '.env.example'].filter((f) => fs.existsSync(path.join(repoPath, f)));
  if (markers.length) out.push(`Files at the repository root: ${markers.join(', ')}`);
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      const text = fs.readFileSync(path.join(repoPath, name), 'utf8');
      const m = text.match(/^#{1,3}\s*(getting started|quick ?start|run|running|usage|development|setup|install\w*)[^\n]*\n([\s\S]{0,1400}?)(?=\n#{1,3}\s|$)/im);
      if (m) out.push(`From ${name} ("${m[1]}"):\n${m[2]!.trim()}`);
      break;
    } catch { /* no readme by this name */ }
  }
  return out.join('\n');
}

/** Only plain http(s) URLs to a machine the owner can reach: never file:, javascript: or credentials. */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
    return u.toString();
  } catch { return null; }
}

/** A path an agent suggested for the owner to open: a plain path on the app's own origin, never a different site. */
export function safeRoutePath(p: unknown): string | null {
  const s = String(p ?? '').trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.length > 200 || /[\s\\<>"'`\u0000-\u001f]/.test(s) || s.includes('..')) return null;
  return s;
}

export function probe(url: string, timeoutMs = 3000): Promise<{ status: number | null; ms: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const started = Date.now();
    let u: URL;
    try { u = new URL(url); } catch { resolve({ status: null, ms: null, error: 'invalid URL' }); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { accept: 'text/html,*/*', 'user-agent': 'oficina-probe' } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? null, ms: Date.now() - started, error: null });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: null, ms: null, error: `no answer within ${Math.round(timeoutMs / 1000)}s` }); });
    req.on('error', (e: NodeJS.ErrnoException) => resolve({ status: null, ms: null, error: e.code === 'ECONNREFUSED' ? 'connection refused (nothing is listening)' : String(e.message ?? e).slice(0, 120) }));
  });
}

const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?/i;

function pushLine(run: Running, line: string): void {
  const clean = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  if (!clean.trim()) return;
  run.tail.push(clean.slice(0, 500));
  if (run.tail.length > MAX_TAIL) run.tail.splice(0, run.tail.length - MAX_TAIL);
  if (!run.detectedUrl) {
    const m = clean.match(URL_IN_OUTPUT);
    if (m) run.detectedUrl = m[0].replace('0.0.0.0', 'localhost').replace(/\/$/, '');
  }
}

export function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
  } catch { /* already gone */ }
}

export function stopApp(key: string): boolean {
  const r = apps.get(key);
  if (!r) return false;
  const live = !!r.child && r.info.state !== 'exited' && r.info.state !== 'stopped';
  if (live) killTree(r.child);
  if (r.info.state === 'starting' || r.info.state === 'ready') r.info.state = 'stopped';
  r.info.reachable = false;
  return live;
}

export function stopAllApps(): void { for (const k of [...apps.keys()]) stopApp(k); }
process.on('exit', () => { try { stopAllApps(); } catch { /* shutting down */ } });

export function appInfo(key: string): AppInfo | null { return apps.get(key)?.info ?? null; }
export function appLog(key: string, lines = 80): string[] { return (apps.get(key)?.tail ?? []).slice(-lines); }

/** Start (or restart) the app for `key` and wait until it answers, exits or the timeout passes. Never throws. */
export async function startApp(key: string, cfg: LaunchConfig, repoPath: string): Promise<AppInfo> {
  stopApp(key);
  const det = detectLaunch(repoPath);
  const command = (cfg.command ?? '').trim() || det.command;
  const cwd = cfg.cwd?.trim() ? path.resolve(repoPath, cfg.cwd.trim()) : repoPath;
  const logFile = path.join(logDir(), `${safeKey(key)}.log`);
  const info: AppInfo = { key, state: 'starting', command, cwd, url: null, pid: null, startedAt: nowIso(), exitCode: null, note: '', logFile, reachable: false };
  const run: Running = { info, child: null, tail: [], detectedUrl: null };
  apps.set(key, run);
  if (!command) { info.state = 'failed'; info.note = `Nothing to start: ${det.why}. Set a start command on the Human approval node.`; return info; }
  const rel = path.relative(repoPath, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) { info.state = 'failed'; info.note = 'The start folder must be inside the repository.'; return info; }
  if (!fs.existsSync(cwd)) { info.state = 'failed'; info.note = `The start folder does not exist: ${cfg.cwd}`; return info; }
  const configuredUrl = cfg.url?.trim() ? safeUrl(cfg.url.trim()) : null;
  if (cfg.url?.trim() && !configuredUrl) { info.state = 'failed'; info.note = `The app URL "${cfg.url}" is not a valid http(s) URL.`; return info; }

  // Something already answering where this app should listen is a stale copy (a previous run, or another program): reviewing
  // it would mean testing the wrong code, so refuse instead of reporting a healthy app that is not the one just started.
  const expected = configuredUrl ?? det.urlGuess;
  if (expected && (await probe(expected, 1200)).status != null) {
    info.state = 'failed'; info.url = expected.replace(/\/$/, '');
    info.note = `Something is already answering on ${info.url} before the app was started — a copy from an earlier review, or another program. Stop it (or set a different address on the node) and restart.`;
    return info;
  }

  try { fs.mkdirSync(logDir(), { recursive: true }); fs.writeFileSync(logFile, `$ ${command}\n(cwd ${cwd})\n\n`); } catch { /* logging is best effort */ }
  const append = (s: string) => { try { fs.appendFileSync(logFile, s); } catch { /* ignore */ } };
  let child: ChildProcess;
  try {
    child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1' } });
  } catch (e) { info.state = 'failed'; info.note = `Could not start it: ${String((e as Error).message ?? e).slice(0, 160)}`; return info; }
  run.child = child; info.pid = child.pid ?? null;
  let partial = '';
  const onData = (d: Buffer) => {
    const text = d.toString('utf8'); append(text);
    const parts = (partial + text).split('\n'); partial = parts.pop() ?? '';
    for (const l of parts) pushLine(run, l);
  };
  child.stdout?.on('data', onData); child.stderr?.on('data', onData);
  child.on('error', (e) => { info.state = 'failed'; info.note = `The process could not run: ${String(e.message ?? e).slice(0, 160)}`; });
  child.on('exit', (code, signal) => {
    if (partial) pushLine(run, partial);
    info.exitCode = code; info.reachable = false;
    if (info.state === 'starting' || info.state === 'ready') { info.state = info.state === 'ready' && signal ? 'stopped' : 'exited'; info.note = info.note || `The app stopped${code != null ? ` (exit code ${code})` : signal ? ` (${signal})` : ''}.`; }
    append(`\n[process exited${code != null ? ` with code ${code}` : ''}${signal ? ` on ${signal}` : ''}]\n`);
  });

  const deadline = Date.now() + Math.max(3, Math.min(300, cfg.readyTimeoutSec ?? 45)) * 1000;
  while (Date.now() < deadline) {
    if (info.state === 'failed' || info.state === 'exited' || info.state === 'stopped') break;
    const url = configuredUrl ?? run.detectedUrl ?? det.urlGuess;
    if (url) {
      const p = await probe(url, 1500);
      if (p.status != null) { info.url = url.replace(/\/$/, ''); info.state = 'ready'; info.reachable = true; info.note = `Answering on ${info.url}.`; break; }
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (info.state === 'starting') {
    info.url = (configuredUrl ?? run.detectedUrl ?? det.urlGuess)?.replace(/\/$/, '') ?? null;
    info.note = `It had not answered after ${Math.round((Date.now() - Date.parse(info.startedAt)) / 1000)}s${info.url ? ` on ${info.url}` : ' and no address was found in its output'}.`;
  } else if (info.state === 'exited') {
    info.note = `It exited right away${info.exitCode != null ? ` (exit code ${info.exitCode})` : ''}. ${run.tail.filter((l) => ERROR_LINE.test(l)).slice(-2).join(' | ').slice(0, 240)}`.trim();
  }
  return info;
}

export interface Diagnostics {
  app: AppInfo | null; logTail: string[]; errorLines: string[]; listening: boolean | null; summary: string;
}

/** What the engine can see about the running app: state, whether it answers, and the lines that look like errors. */
export async function diagnose(key: string, lines = 40): Promise<Diagnostics> {
  const r = apps.get(key);
  if (!r) return { app: null, logTail: [], errorLines: [], listening: null, summary: 'The app was not started.' };
  let listening: boolean | null = null;
  if (r.info.url && (r.info.state === 'ready' || r.info.state === 'starting')) listening = (await probe(r.info.url, 2000)).status != null;
  r.info.reachable = listening === true;
  const errorLines = r.tail.filter((l) => ERROR_LINE.test(l)).slice(-12);
  const summary = `${r.info.state}${r.info.pid ? ` (pid ${r.info.pid})` : ''}${r.info.url ? `, ${listening ? 'answering' : listening === false ? 'NOT answering' : 'not checked'} on ${r.info.url}` : ''}; ${errorLines.length} error-looking log line(s)`;
  return { app: { ...r.info }, logTail: r.tail.slice(-lines), errorLines, listening, summary };
}

export async function probeRoutes(baseUrl: string, paths: string[]): Promise<RouteProbe[]> {
  const out: RouteProbe[] = [];
  for (const p of paths.slice(0, 10)) {
    const url = `${baseUrl.replace(/\/$/, '')}${p}`;
    const r = await probe(url, 4000);
    out.push({ path: p, url, ...r });
  }
  return out;
}

/** Open a URL in the owner's default browser. Skipped when OFFICE_NO_BROWSER is set (tests, servers). */
export function openBrowser(url: string): boolean {
  const safe = safeUrl(url);
  if (!safe || process.env.OFFICE_NO_BROWSER) return false;
  try {
    // no shell: the URL is one argument and never parsed as a command
    if (process.platform === 'win32') execFile('rundll32', ['url.dll,FileProtocolHandler', safe], { windowsHide: true }, () => undefined);
    else execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [safe], () => undefined);
    return true;
  } catch { return false; }
}
