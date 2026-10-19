import fs from 'node:fs';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';

/** Extra dirs where Cursor / Claude / Devin CLIs are commonly installed (daemon tray often lacks user PATH). */
export function cliPathDirs(): string[] {
  const dirs: string[] = [];
  const la = process.env.LOCALAPPDATA;
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const appData = process.env.APPDATA;
  if (la) dirs.push(path.join(la, 'cursor-agent'), path.join(la, 'devin', 'cli', 'bin'));
  if (home) dirs.push(path.join(home, '.local', 'bin'));
  if (appData) dirs.push(path.join(appData, 'npm'));
  return dirs;
}

/** PATH plus the extra install dirs, so a tray-launched daemon can still find CLIs. */
function augmentedPath(): string {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const basePath = process.env[pathKey] ?? '';
  return [...cliPathDirs(), ...basePath.split(path.delimiter)].filter(Boolean).join(path.delimiter);
}

function existsFile(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function findExecutable(name: string, pathEnv: string): string | null {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (existsFile(p)) return p;
    }
  }
  return null;
}

/** Quote the first token when the resolved path contains spaces (common on Windows). */
function quoteFirstToken(cmd: string, resolved: string): string {
  const m = cmd.match(/^(\s*)(\S+|"[^"]*")(.*)$/s);
  if (!m) return cmd;
  const lead = m[1];
  const rest = m[3];
  const quoted = resolved.includes(' ') ? `"${resolved}"` : resolved;
  return `${lead}${quoted}${rest}`;
}

/**
 * Augment PATH and resolve cursor-agent → agent / full path so CLI backends work
 * when the daemon is started from the tray without a login-shell PATH.
 */
export function prepareCliCommand(cmd: string): { cmd: string; env: NodeJS.ProcessEnv } {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const augmented = augmentedPath();
  const env: NodeJS.ProcessEnv = { ...process.env, [pathKey]: augmented };

  const tok = cmd.trim().match(/^(?:"([^"]+)"|(\S+))/);
  const first = tok?.[1] ?? tok?.[2];
  if (!first) return { cmd, env };
  // an explicit path is used exactly as written — only bare names are looked up
  if (/[\\/]/.test(first)) return { cmd, env };

  const base = path.basename(first).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  // cursor ships as either `agent` or `cursor-agent`
  const candidates = base === 'agent' || base === 'cursor-agent' ? ['agent', 'cursor-agent'] : [base];
  for (const name of candidates) {
    const resolved = findExecutable(name, augmented);
    if (resolved) return { cmd: quoteFirstToken(cmd, resolved), env };
  }
  return { cmd, env };
}

/**
 * Run a command line through the platform shell. On Windows the whole line is
 * wrapped in one more pair of quotes and passed verbatim: `cmd /s /c` strips
 * exactly the outer pair, so a quoted executable path with spaces
 * ("C:\Users\MY PC\...\agent.cmd") survives intact.
 */
export function spawnShell(cmd: string, opts: SpawnOptions): ChildProcess {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { ...opts, windowsVerbatimArguments: true });
  }
  return spawn('/bin/sh', ['-c', cmd], opts);
}

// Kill a CLI child AND its whole process tree. `child.kill()` alone only ends
// the shell wrapper — on Windows the agent process it spawned survives and
// keeps the worktree/files locked forever.
export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    tk.on('error', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  } else {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

// ---- presets ----------------------------------------------------------------
// Each supported agent CLI: its default command, how to ask it for models,
// and what to tell the user when that fails. Everything preset-specific lives
// here so listing, defaults and messages can never drift apart.

export type CliPresetId = 'claude' | 'cursor' | 'devin';

export interface CliPreset {
  id: CliPresetId;
  label: string;
  command: string;
  /** model-listing subcommands, tried in order (appended to the executable) */
  listArgs: string[];
  loginHint: string;
}

export const CLI_PRESETS: Record<CliPresetId, CliPreset> = {
  claude: {
    id: 'claude', label: 'Claude Code',
    command: 'claude -p --verbose --dangerously-skip-permissions --output-format stream-json',
    // no --bare: it skips the CLI's own login, so /model would report "Not logged in"
    listArgs: ['-p /model', '--list-models', 'models'],
    loginHint: 'Claude Code did not return models — run `claude auth login` on this machine, then Sync from provider again',
  },
  cursor: {
    id: 'cursor', label: 'cursor-agent',
    command: 'agent -p --output-format stream-json --force',
    listArgs: ['--list-models', 'models'],
    loginHint: 'cursor-agent did not return models — install it (`irm https://cursor.com/install?win32=true | iex`) and run `agent login`, then Sync from provider again',
  },
  devin: {
    id: 'devin', label: 'Devin CLI',
    // Devin's print mode doesn't read stdin, so the prompt goes in as a file
    command: 'devin -p --prompt-file {promptFile} --permission-mode dangerous --respect-workspace-trust false',
    listArgs: ['models list --format json'],
    loginHint: 'Devin CLI did not return models — run `devin auth login` (check with `devin auth status`), then Sync from provider again',
  },
};

/** The executable as written in the template (quoted paths kept) and its bare name. */
export function cliExecutable(template: string): { token: string; name: string } {
  const m = template.trim().match(/^(?:"([^"]+)"|(\S+))/);
  const raw = m?.[1] ?? m?.[2] ?? '';
  const token = m?.[1] ? `"${m[1]}"` : raw;
  return { token, name: raw.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase() };
}

/** Which preset a command template belongs to (null for any other CLI). */
export function cliPresetOf(template: string): CliPreset | null {
  const { name } = cliExecutable(template || CLI_PRESETS.claude.command);
  if (name === 'claude') return CLI_PRESETS.claude;
  if (name === 'agent' || name === 'cursor-agent') return CLI_PRESETS.cursor;
  if (name === 'devin') return CLI_PRESETS.devin;
  return null;
}

/** Binaries that count as this preset being installed (`agent` and `cursor-agent` are the same CLI). */
function presetBinaries(preset: CliPreset): string[] {
  return preset.id === 'cursor' ? ['agent', 'cursor-agent'] : [cliExecutable(preset.command).name];
}

/**
 * Presets whose executable is on PATH or in a known install dir.
 * `pathEnv` is for tests; callers omit it to scan this machine.
 */
export function detectInstalledClis(pathEnv?: string): { id: CliPresetId; label: string; command: string; path: string }[] {
  const env = pathEnv ?? augmentedPath();
  const found: { id: CliPresetId; label: string; command: string; path: string }[] = [];
  for (const preset of Object.values(CLI_PRESETS)) {
    for (const name of presetBinaries(preset)) {
      const resolved = findExecutable(name, env);
      if (!resolved) continue;
      found.push({ id: preset.id, label: preset.label, command: preset.command, path: resolved });
      break;
    }
  }
  return found;
}

/** An empty command means the Claude Code preset. */
export function effectiveCliCommand(command: string | null | undefined): string {
  return String(command ?? '').trim() || CLI_PRESETS.claude.command;
}

/**
 * Fill a command template for one run. {prompt} embeds the prompt (flattened
 * for cmd.exe); {promptFile} passes the path of a file holding it; otherwise
 * the prompt goes to stdin. The agent's model always reaches the CLI: via
 * {model}, or an appended --model when the template has no placeholder.
 */
export function buildCliCommand(template: string, v: { prompt: string; promptFile?: string | null; worktree: string; model?: string | null }): { cmd: string; stdin: boolean } {
  const model = v.model ?? '';
  let cmd = template
    .replace('{prompt}', v.prompt.replace(/[\r\n]+/g, ' ').replace(/"/g, "'"))
    .replace('{promptFile}', v.promptFile ? `"${v.promptFile}"` : '')
    .replace('{worktree}', v.worktree)
    .replace('{model}', model);
  if (model && !template.includes('{model}')) cmd += ` --model ${JSON.stringify(model)}`;
  // scrub a dangling --model left behind by an empty {model} substitution
  if (!model) cmd = cmd.replace(/\s--model(?=\s+-|\s*$)/, '').trimEnd();
  return { cmd, stdin: !template.includes('{prompt}') && !template.includes('{promptFile}') };
}
