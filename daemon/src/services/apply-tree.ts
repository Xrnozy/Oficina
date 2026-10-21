import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RAW } from './snapshot.ts';

// Moving a working tree from one recorded state (a git tree) to another, file by file — what Undo, Redo and Restore do.
//
// For every file that differs between the two states, compared with what is on disk right now:
//   already    the file is already how it should end up                      -> nothing to do
//   clean      the file is exactly how the starting state left it           -> replace/delete it
//   merge      the file was edited since, but not where this change was     -> three-way merge, the edits are kept
//   conflict   the file was edited where this change was, was deleted, or    -> left alone, reported
//              something (a file, a folder) is in the way
//   overwrite  Restore only: the file is replaced whatever it holds now      -> the caller has saved the old state
// Nothing is written until every file has been planned. Writing keeps a backup of each file first and rolls everything back
// if any step fails or any result is not byte-for-byte what was planned, so a failed operation leaves the tree untouched.
// Folders a restore needs are created, and folders a deletion empties are removed (never a folder that still holds anything).

export interface TreeEntry { mode: string; oid: string }
export type FileState = 'already' | 'clean' | 'merge' | 'conflict' | 'overwrite';
export interface FilePlan {
  path: string; state: FileState; reason?: string; from: TreeEntry | null; to: TreeEntry | null;
  merged?: Buffer; regions?: number;
}
export interface TransitionPlan {
  files: FilePlan[];
  changing: FilePlan[];                                  // what applying will write
  conflicts: { path: string; reason: string }[];
  ok: boolean;                                           // no conflicts
}

const gitText = (repo: string, args: string[], input?: string | Buffer): string =>
  execFileSync('git', [...RAW, '-C', repo, ...args], { windowsHide: true, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const gitBuf = (repo: string, args: string[]): Buffer =>
  execFileSync('git', [...RAW, '-C', repo, ...args], { windowsHide: true, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as Buffer;

const isBinary = (b: Buffer): boolean => b.subarray(0, 8000).includes(0);
const EMPTY_OID = '0'.repeat(40);

/** Every path whose entry differs between two trees, with both sides' mode and object id. */
export function treeDelta(repo: string, a: string, b: string): { path: string; from: TreeEntry | null; to: TreeEntry | null }[] {
  if (a === b) return [];
  const out = gitText(repo, ['diff-tree', '-r', '-z', '--no-renames', '--raw', '--full-index', a, b]);
  const parts = out.split('\0');
  const res: { path: string; from: TreeEntry | null; to: TreeEntry | null }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    const p = parts[i + 1];
    const m = meta.match(/^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/);
    if (!m || !p) continue;
    const from = /^0+$/.test(m[3]) ? null : { mode: m[1], oid: m[3] };
    const to = /^0+$/.test(m[4]) ? null : { mode: m[2], oid: m[4] };
    res.push({ path: p, from, to });
  }
  return res;
}

type Work = { kind: 'absent' } | { kind: 'dir' } | { kind: 'symlink' } | { kind: 'file'; oid: string; bytes: Buffer };

function look(repo: string, rel: string): Work {
  const abs = path.join(repo, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return { kind: 'absent' }; }
  if (st.isSymbolicLink()) return { kind: 'symlink' };
  if (st.isDirectory()) return { kind: 'dir' };
  const bytes = fs.readFileSync(abs);
  // the same object id git itself would store for these bytes, filters and all (the snapshot was taken with git add)
  const oid = gitText(repo, ['hash-object', `--path=${rel}`, '--stdin'], bytes).trim();
  return { kind: 'file', oid, bytes };
}

// A file already sitting where a folder is needed (or the other way round).
function obstruction(repo: string, rel: string, needsFile: boolean): string | null {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const seg = parts.slice(0, i).join('/');
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(path.join(repo, seg)); } catch { return null; }   // nothing there: the folder will be created
    if (!st.isDirectory()) return `a file named "${seg}" is in the way of the folder this needs`;
  }
  if (needsFile) {
    try {
      const st = fs.lstatSync(path.join(repo, rel));
      if (st.isDirectory() && fs.readdirSync(path.join(repo, rel)).length) return `a folder named "${rel}" that holds files is in the way`;
    } catch { /* free */ }
  }
  return null;
}

function mergeText(current: Buffer, base: Buffer, other: Buffer): { clean: boolean; regions: number; merged: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-merge-'));
  try {
    const f = (n: string, b: Buffer) => { const p = path.join(dir, n); fs.writeFileSync(p, b); return p; };
    const r = spawnSync('git', ['merge-file', '-p', '-L', 'current', '-L', 'recorded', '-L', 'target', f('cur', current), f('base', base), f('oth', other)], { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
    const code = r.status ?? -1;
    if (code < 0 || code > 127) return { clean: false, regions: 1, merged: current };
    return { clean: code === 0, regions: code, merged: r.stdout as Buffer };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Plan moving the working tree from state `a` to state `b`. `force` (Restore) replaces files edited since instead of reporting them. */
export function planTransition(repo: string, a: string, b: string, opts: { force?: boolean } = {}): TransitionPlan {
  const files: FilePlan[] = [];
  for (const d of treeDelta(repo, a, b)) {
    const base: FilePlan = { path: d.path, state: 'already', from: d.from, to: d.to };
    const special = (e: TreeEntry | null) => !!e && (e.mode === '120000' || e.mode === '160000');
    const w = look(repo, d.path);
    const wOid = w.kind === 'absent' ? null : w.kind === 'file' ? w.oid : 'x';
    const aOid = d.from?.oid ?? null, bOid = d.to?.oid ?? null;
    if (special(d.from) || special(d.to)) {
      files.push({ ...base, state: wOid === bOid ? 'already' : 'conflict', reason: 'symbolic links and submodules are not restored automatically' });
      continue;
    }
    if (wOid === bOid && w.kind !== 'dir') { files.push(base); continue; }
    if (w.kind === 'symlink') { files.push({ ...base, state: 'conflict', reason: 'a symbolic link is in the way' }); continue; }
    if (w.kind === 'dir' && d.to) {
      const why = obstruction(repo, d.path, true);
      files.push(why ? { ...base, state: 'conflict', reason: why } : { ...base, state: 'clean' });   // an empty folder is replaced by the file
      continue;
    }
    if (d.to) {
      const why = obstruction(repo, d.path, true);
      if (why) { files.push({ ...base, state: 'conflict', reason: why }); continue; }
    }
    if (wOid === aOid) { files.push({ ...base, state: 'clean' }); continue; }
    if (opts.force) { files.push({ ...base, state: 'overwrite', reason: w.kind === 'absent' ? 'you deleted it since — it comes back' : 'your edits to this file are replaced (the current state is saved first)' }); continue; }
    // edited (or deleted) since: try to keep those edits
    if (w.kind !== 'file') { files.push({ ...base, state: 'conflict', reason: 'you deleted this file since' }); continue; }
    if (!d.to) { files.push({ ...base, state: 'conflict', reason: 'this change deletes the file, but you edited it since' }); continue; }
    const aBuf = d.from ? gitBuf(repo, ['cat-file', 'blob', d.from.oid]) : Buffer.alloc(0);
    const bBuf = gitBuf(repo, ['cat-file', 'blob', d.to.oid]);
    if (isBinary(w.bytes) || isBinary(aBuf) || isBinary(bBuf)) { files.push({ ...base, state: 'conflict', reason: 'a binary file you changed since' }); continue; }
    const m = mergeText(w.bytes, aBuf, bBuf);
    files.push(m.clean ? { ...base, state: 'merge', merged: m.merged, reason: 'edited since, in other places — both sets of edits are kept' }
      : { ...base, state: 'conflict', regions: m.regions, reason: `edited since, in the same place (${m.regions} overlapping region${m.regions === 1 ? '' : 's'})` });
  }
  const conflicts = files.filter((f) => f.state === 'conflict').map((f) => ({ path: f.path, reason: f.reason ?? 'changed since' }));
  return { files, changing: files.filter((f) => f.state === 'clean' || f.state === 'merge' || f.state === 'overwrite'), conflicts, ok: conflicts.length === 0 };
}

export interface ApplyResult { ok: boolean; message: string; applied: string[]; skipped: { path: string; reason: string }[] }

function removeEmptyDirs(repo: string, rel: string): string[] {
  const removed: string[] = [];
  let dir = path.posix.dirname(rel);
  while (dir && dir !== '.' && dir !== '/') {
    const abs = path.join(repo, dir);
    try { if (fs.readdirSync(abs).length) break; fs.rmdirSync(abs); removed.push(dir); } catch { break; }
    dir = path.posix.dirname(dir);
  }
  return removed;
}

/** Write a plan. Without `partial`, any conflict means nothing is touched. Every written file is verified; a failure rolls everything back. */
export function applyPlan(repo: string, plan: TransitionPlan, opts: { partial?: boolean } = {}): ApplyResult {
  const skipped = plan.conflicts.map((c) => ({ path: c.path, reason: c.reason }));
  if (skipped.length && !opts.partial) return { ok: false, message: `${skipped.length} file(s) cannot be changed safely — nothing was changed`, applied: [], skipped };
  const backups = new Map<string, Buffer | null>();
  const createdDirs: string[] = [];
  const prunedDirs: string[] = [];
  const written: { path: string; want: Buffer | null }[] = [];
  const rollback = () => {
    for (const [rel, orig] of [...backups.entries()].reverse()) {
      const abs = path.join(repo, rel);
      try {
        if (orig === null) fs.rmSync(abs, { force: true });
        else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, orig); }
      } catch { /* best effort: the backup stays in memory for the caller's message */ }
    }
    for (const d of [...createdDirs].reverse()) { try { fs.rmdirSync(path.join(repo, d)); } catch { /* not empty / gone */ } }
    for (const d of prunedDirs) { try { fs.mkdirSync(path.join(repo, d), { recursive: true }); } catch { /* ignore */ } }
  };
  try {
    for (const f of plan.changing) {
      const abs = path.join(repo, f.path);
      const w = look(repo, f.path);
      backups.set(f.path, w.kind === 'file' ? w.bytes : null);
      if (w.kind === 'dir' && f.to) { fs.rmdirSync(abs); prunedDirs.push(f.path); }
      if (!f.to) {
        fs.rmSync(abs, { force: true });
        written.push({ path: f.path, want: null });
        for (const d of removeEmptyDirs(repo, f.path)) prunedDirs.push(d);
        continue;
      }
      const content = f.merged ?? gitBuf(repo, ['cat-file', 'blob', f.to.oid]);
      // folders that do not exist yet (the task's new directories were removed by an undo, or never existed)
      const missing: string[] = [];
      for (let dir = path.posix.dirname(f.path); dir && dir !== '.'; dir = path.posix.dirname(dir)) { if (fs.existsSync(path.join(repo, dir))) break; missing.unshift(dir); }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      createdDirs.push(...missing);
      const tmp = `${abs}.oficina-tmp`;
      fs.writeFileSync(tmp, content);
      try { fs.renameSync(tmp, abs); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
      if (process.platform !== 'win32') { try { fs.chmodSync(abs, f.to.mode === '100755' ? 0o755 : 0o644); } catch { /* best effort */ } }
      written.push({ path: f.path, want: content });
    }
    // trust nothing: read every result back
    for (const w of written) {
      const abs = path.join(repo, w.path);
      if (w.want === null ? fs.existsSync(abs) : !fs.existsSync(abs) || !fs.readFileSync(abs).equals(w.want)) throw new Error(`${w.path} does not hold what was written`);
    }
  } catch (e) {
    rollback();
    return { ok: false, message: `could not write ${String((e as Error).message ?? e).slice(0, 200)} — everything was put back as it was`, applied: [], skipped };
  }
  return { ok: true, message: `${written.length} file(s) changed${skipped.length ? `, ${skipped.length} left alone` : ''}`, applied: written.map((w) => w.path), skipped };
}
