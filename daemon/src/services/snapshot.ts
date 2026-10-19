import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Working-tree snapshots for checkpoints, undo and redo. Pure git plumbing:
//   - a snapshot is a tree object of the WHOLE working state — tracked edits,
//     untracked files and deletions — built in a throwaway index, so the
//     user's real index, branch and files are never touched;
//   - .gitignore'd paths (caches, build output, usually secrets) and the
//     office's own .office/ folder are left out;
//   - each snapshot is pinned under refs/officechain/ so `git gc` keeps it;
//   - undo/redo/restore apply a patch between two snapshots to the working
//     tree with `git apply`, after a dry run that reports conflicts. No reset,
//     checkout or clean is ever run, so unrelated work is preserved: a patch
//     either applies cleanly to exactly the lines it owns, or nothing changes.

const OWN = ['.office', '.officechain'];
// Byte-exact: no CRLF conversion, so undo never rewrites a file's line endings.
export const RAW = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false'];

function run(repo: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): string {
  return execFileSync('git', [...RAW, '-C', repo, ...args], {
    encoding: 'utf8', input: opts.input, maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// Non-blocking variant for periodic work (the live diff): the sync calls
// above freeze the daemon's HTTP server while git runs.
function runAsync(repo: string, args: string[], opts: { env?: Record<string, string> } = {}): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', [...RAW, '-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...opts.env }, windowsHide: true },
      (e, out, err) => resolve({ ok: !e, out: String(out ?? ''), err: String(err ?? (e as any)?.message ?? '') }));
  });
}

function tryRun(repo: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): { ok: boolean; out: string; err: string } {
  try { return { ok: true, out: run(repo, args, opts), err: '' }; }
  catch (e: any) { return { ok: false, out: String(e?.stdout ?? ''), err: String(e?.stderr ?? e?.message ?? e) }; }
}

export function isGitRepo(repo: string): boolean {
  return tryRun(repo, ['rev-parse', '--is-inside-work-tree']).ok;
}

export function headCommit(repo: string): string | null {
  const r = tryRun(repo, ['rev-parse', '--verify', 'HEAD']);
  return r.ok ? r.out.trim() : null;
}

/** Tree of the full working state (tracked + untracked, minus ignored files). */
// One private index per repository, kept between snapshots: its stat cache
// means `git add -A` only re-hashes files that changed, so a snapshot of a
// large repo costs little more than `git status`. It is seeded from a COPY
// of the repo's own index (read-only) and never replaces it.
const privateIndex = new Map<string, string>();
function indexFor(repo: string, tag = ''): string {
  const key = `${repo}\0${tag}`;
  let p = privateIndex.get(key);
  if (p && fs.existsSync(p)) return p;
  p = path.join(os.tmpdir(), `oc-index${tag}-${process.pid}-${createHash('sha1').update(path.resolve(repo)).digest('hex').slice(0, 12)}`);
  privateIndex.set(key, p);
  const real = tryRun(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const realPath = real.ok ? real.out.trim() : '';
  if (realPath && fs.existsSync(realPath)) fs.copyFileSync(realPath, p);
  else {
    const head = headCommit(repo);
    run(repo, head ? ['read-tree', head] : ['read-tree', '--empty'], { env: { GIT_INDEX_FILE: p } });
  }
  return p;
}

// Untracked files bigger than this (datasets, audio, model weights) are left
// out of snapshots: copying them into .git on every snapshot would bloat the
// repository. Undo therefore never deletes or restores them.
export const MAX_SNAPSHOT_FILE = 8 * 1024 * 1024;
const skippedLarge = new Map<string, string[]>();

const skippedBroken = new Map<string, string[]>();

// Untracked tool caches (dependency and build caches that are not gitignored,
// e.g. a 10k-file Gradle cache) are left out too: walking and hashing them
// made every snapshot take seconds and filled .git with loose objects. Ignore
// rules never apply to tracked files, so tracked files there are still kept.
// Undo never deletes or restores these folders.
export const CACHE_DIRS = ['node_modules', '.gradle', '.gradle-user-home', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache',
  '.ruff_cache', '.tox', '.next', '.nuxt', '.turbo', '.parcel-cache', '.cache', '.dart_tool', '.terraform'];
let excludesFile: string | null = null;
/** `-c core.excludesFile=…`: the user's own global excludes plus CACHE_DIRS. */
function cacheExcludes(): string[] {
  if (!excludesFile) {
    let own = '';
    try {
      const configured = execFileSync('git', ['config', '--global', '--path', 'core.excludesFile'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      own = fs.readFileSync(configured, 'utf8');
    } catch {
      const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      try { own = fs.readFileSync(path.join(xdg, 'git', 'ignore'), 'utf8'); } catch { /* none */ }
    }
    excludesFile = path.join(os.tmpdir(), `oc-excludes-${process.pid}`);
    fs.writeFileSync(excludesFile, [own, ...CACHE_DIRS.map((d) => `${d}/`), ''].join('\n'));
  }
  return ['-c', `core.excludesFile=${excludesFile}`];
}

/** Untracked files the last snapshot of this repo left out for size. */
export function largeUntracked(repo: string): string[] { return skippedLarge.get(repo) ?? []; }
/** Files the last snapshot could not include because git cannot index them. */
export function unaddablePaths(repo: string): string[] { return skippedBroken.get(repo) ?? []; }

export function snapshotTree(repo: string): string {
  const env = { GIT_INDEX_FILE: indexFor(repo) };
  try {
    const big = run(repo, [...cacheExcludes(), 'ls-files', '--others', '--exclude-standard', '-z'], { env }).split('\0').filter(Boolean)
      .filter((f) => { try { return fs.statSync(path.join(repo, f)).size > MAX_SNAPSHOT_FILE; } catch { return false; } });
    skippedLarge.set(repo, big);
    // (an explicit exclude pathspec fails when the path is also .gitignore'd,
    // so add everything not ignored, then drop the office's own folders)
    // Files git cannot index at all (e.g. a stray `nul` from a `> nul`
    // redirect in Git Bash — a reserved name on Windows) are skipped with
    // --ignore-errors instead of failing the whole snapshot.
    const spec = path.join(os.tmpdir(), `oc-spec-${process.pid}-${Date.now()}`);
    fs.writeFileSync(spec, ['.', ...big.map((f) => `:(exclude,literal)${f}`)].join('\0'));
    let res: { ok: boolean; out: string; err: string };
    try { res = tryRun(repo, [...cacheExcludes(), 'add', '-A', '--ignore-errors', `--pathspec-from-file=${spec}`, '--pathspec-file-nul'], { env }); }
    finally { fs.rmSync(spec, { force: true }); }
    const unaddable = [...res.err.matchAll(/(?:invalid path|unable to add|unable to index file) '([^']+)'/g)].map((m) => m[1]);
    skippedBroken.set(repo, [...new Set(unaddable)]);
    if (!res.ok && !unaddable.length) throw new Error(res.err.trim() || 'git add failed');
    run(repo, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...OWN], { env });
    return run(repo, ['write-tree'], { env }).trim();
  } catch (e) {
    // a damaged private index is just rebuilt next time
    const p = privateIndex.get(`${repo}\0`);
    if (p) { fs.rmSync(p, { force: true }); privateIndex.delete(`${repo}\0`); }
    throw e;
  }
}

// Async twin of snapshotTree for callers already on an async path (DoD
// evaluation, delivery verification): identical steps via runAsync so the
// HTTP/event loop is never held while git walks the working tree.
export async function snapshotTreeAsync(repo: string): Promise<string> {
  const env = { GIT_INDEX_FILE: indexFor(repo) };
  const must = async (args: string[]) => {
    const r = await runAsync(repo, args, { env });
    if (!r.ok) throw new Error(r.err.trim() || 'git failed');
    return r.out;
  };
  try {
    const big = (await must([...cacheExcludes(), 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      .filter((f) => { try { return fs.statSync(path.join(repo, f)).size > MAX_SNAPSHOT_FILE; } catch { return false; } });
    skippedLarge.set(repo, big);
    const spec = path.join(os.tmpdir(), `oc-spec-${process.pid}-${Date.now()}`);
    fs.writeFileSync(spec, ['.', ...big.map((f) => `:(exclude,literal)${f}`)].join('\0'));
    let res: { ok: boolean; out: string; err: string };
    try { res = await runAsync(repo, [...cacheExcludes(), 'add', '-A', '--ignore-errors', `--pathspec-from-file=${spec}`, '--pathspec-file-nul'], { env }); }
    finally { fs.rmSync(spec, { force: true }); }
    const unaddable = [...res.err.matchAll(/(?:invalid path|unable to add|unable to index file) '([^']+)'/g)].map((m) => m[1]);
    skippedBroken.set(repo, [...new Set(unaddable)]);
    if (!res.ok && !unaddable.length) throw new Error(res.err.trim() || 'git add failed');
    await must(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...OWN]);
    return (await must(['write-tree'])).trim();
  } catch (e) {
    const p = privateIndex.get(`${repo}\0`);
    if (p) { fs.rmSync(p, { force: true }); privateIndex.delete(`${repo}\0`); }
    throw e;
  }
}

// A snapshot taken moments ago is good enough for *display* consumers (the
// changed-file list and diff sent to QA/review prompts — never checkpoints).
// One delivery path used to snapshot the same tree twice back-to-back.
const recentTrees = new Map<string, { tree: string; at: number }>();
export function snapshotTreeRecent(repo: string, ttlMs = 3000): string {
  const hit = recentTrees.get(repo);
  if (hit && Date.now() - hit.at < ttlMs) return hit.tree;
  const tree = snapshotTree(repo);
  recentTrees.set(repo, { tree, at: Date.now() });
  return tree;
}

/** Live view of an agent's changes: snapshot tree plus changed files with
 *  line counts against `base`, without blocking the event loop. Uses its own
 *  private index so it never collides with a checkpoint snapshot. */
export async function liveChanges(repo: string, base: string): Promise<{ tree: string; files: (FileChange & { added?: number; removed?: number })[] }> {
  const env = { GIT_INDEX_FILE: indexFor(repo, '-live') };
  const must = async (args: string[]) => { const r = await runAsync(repo, args, { env }); if (!r.ok) throw new Error(r.err.trim()); return r.out; };
  const big = (await must([...cacheExcludes(), 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
    .filter((f) => { try { return fs.statSync(path.join(repo, f)).size > MAX_SNAPSHOT_FILE; } catch { return false; } });
  const spec = path.join(os.tmpdir(), `oc-spec-live-${process.pid}-${Date.now()}`);
  fs.writeFileSync(spec, ['.', ...big.map((f) => `:(exclude,literal)${f}`)].join('\0'));
  try { await runAsync(repo, [...cacheExcludes(), 'add', '-A', '--ignore-errors', `--pathspec-from-file=${spec}`, '--pathspec-file-nul'], { env }); }
  finally { fs.rmSync(spec, { force: true }); }
  await must(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...OWN]);
  const tree = (await must(['write-tree'])).trim();
  if (tree === base) return { tree, files: [] };
  const [ns, num] = await Promise.all([must(['diff', '--name-status', '-M', '-z', base, tree]), must(['diff', '--numstat', '-M', '-z', base, tree])]);
  const stat = parseNumstat(num);
  return { tree, files: parseNameStatus(ns).map((f) => ({ ...f, ...(stat.find((x) => x.path === f.path) ?? {}) })) };
}

/** Pin a tree under refs/officechain/<name> so it survives garbage collection. */
export function pinTree(repo: string, tree: string, name: string, message: string): string {
  const env = { GIT_AUTHOR_NAME: 'officeChain', GIT_AUTHOR_EMAIL: 'officechain@local', GIT_COMMITTER_NAME: 'officeChain', GIT_COMMITTER_EMAIL: 'officechain@local' };
  const commit = run(repo, ['commit-tree', tree, '-m', message], { env }).trim();
  run(repo, ['update-ref', `refs/officechain/${name}`, commit]);
  return commit;
}

export function unpin(repo: string, name: string): void {
  tryRun(repo, ['update-ref', '-d', `refs/officechain/${name}`]);
}

export interface FileChange { status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T'; path: string; from?: string }

export function changedFilesBetween(repo: string, a: string, b: string): FileChange[] {
  if (a === b) return [];
  return parseNameStatus(run(repo, ['diff', '--name-status', '-M', '-z', a, b]));
}

function parseNameStatus(out: string): FileChange[] {
  const parts = out.split('\0').filter((x) => x !== '');
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    const st = code[0] as FileChange['status'];
    if (st === 'R' || st === 'C') { const from = parts[i++]; const to = parts[i++]; files.push({ status: st, path: to, from }); }
    else files.push({ status: st, path: parts[i++] });
  }
  return files;
}

/** Binary-safe patch from tree a to tree b (optionally limited to paths). */
export function patchBetween(repo: string, a: string, b: string, paths: string[] = []): string {
  if (a === b) return '';
  return run(repo, ['diff', '--binary', '--full-index', '--no-color', a, b, ...(paths.length ? ['--', ...paths] : [])]);
}

/** Human-readable diff (with rename detection) for display. */
export function displayDiff(repo: string, a: string, b: string, paths: string[] = []): string {
  if (a === b) return '';
  return run(repo, ['diff', '-M', '--no-color', a, b, ...(paths.length ? ['--', ...paths] : [])]);
}

export interface ApplyCheck { ok: boolean; conflicts: { path: string; reason: string }[]; message: string }

function parseApplyErrors(err: string): { path: string; reason: string }[] {
  const out: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const line of err.split(/\r?\n/)) {
    const m = line.match(/^error: (?:patch failed: )?(.+?)(?::\d+)?: (.+)$/) ?? line.match(/^error: patch failed: (.+?):(\d+)$/);
    if (!m) continue;
    const p = m[1].trim();
    const reason = (m[2] ?? 'patch does not apply').trim();
    const key = `${p}|${reason}`;
    if (!seen.has(key)) { seen.add(key); out.push({ path: p, reason: /^\d+$/.test(reason) ? `changed since (line ${reason})` : reason }); }
  }
  return out;
}

/** Dry run: would this patch (or its reverse) apply cleanly to the working tree? */
export function checkPatch(repo: string, patch: string, reverse = false): ApplyCheck {
  if (!patch.trim()) return { ok: true, conflicts: [], message: 'nothing to apply' };
  const r = tryRun(repo, ['apply', '--check', '--whitespace=nowarn', ...(reverse ? ['-R'] : [])], { input: patch });
  if (r.ok) return { ok: true, conflicts: [], message: 'applies cleanly' };
  const conflicts = parseApplyErrors(r.err);
  return { ok: false, conflicts: conflicts.length ? conflicts : [{ path: '?', reason: r.err.trim().slice(0, 300) }], message: r.err.trim().slice(0, 1000) };
}

/** Apply after a successful dry run; throws (changing nothing) when it would conflict. */
export function applyPatch(repo: string, patch: string, reverse = false): ApplyCheck {
  const c = checkPatch(repo, patch, reverse);
  if (!c.ok) return c;
  if (!patch.trim()) return c;
  run(repo, ['apply', '--whitespace=nowarn', ...(reverse ? ['-R'] : [])], { input: patch });
  return c;
}

/** Changed line ranges per file in a patch (new-side for forward patches). */
export function touchedLines(patch: string): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>();
  let file = '';
  for (const line of patch.split('\n')) {
    const f = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (f) { file = f[2]; if (!map.has(file)) map.set(file, []); continue; }
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const oldStart = +h[1]; const oldLen = h[2] == null ? 1 : +h[2];
      map.get(file)!.push([oldStart, oldStart + Math.max(oldLen, 1) - 1]);
    }
  }
  return map;
}

/** Added/removed line counts per file between two trees (binary files: -1). */
export function diffStat(repo: string, a: string, b: string): { path: string; added: number; removed: number }[] {
  if (a === b) return [];
  return parseNumstat(run(repo, ['diff', '--numstat', '-M', '-z', a, b]));
}

function parseNumstat(out: string): { path: string; added: number; removed: number }[] {
  const parts = out.split('\0');
  const stats: { path: string; added: number; removed: number }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const m = p.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) continue;
    let file = m[3];
    if (file === '') { i++; file = parts[++i] ?? ''; } // rename: "\0from\0to"
    stats.push({ path: file, added: m[1] === '-' ? -1 : +m[1], removed: m[2] === '-' ? -1 : +m[2] });
  }
  return stats;
}
