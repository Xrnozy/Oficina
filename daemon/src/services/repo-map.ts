import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.ts';

// Repository map: the files a project really has, and a compact summary of
// them for prompts. Git's own view is used (tracked files plus new files, with
// new folders collapsed), so ignored build output, dependency folders and
// caches never count — a Unity Library/, a gradle cache or a Python venv used
// to fill the repo tour before the real sources were reached. Folders that are
// not Git repositories fall back to a bounded directory walk.

export interface RepoFiles { files: string[]; newDirs: string[]; source: 'git' | 'fs'; truncated: boolean }

// fs fallback only: generated or dependency folders of the common toolchains
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', '__pycache__', 'venv', 'Library', 'Temp',
  'Intermediate', 'Binaries', 'DerivedData', 'Pods', 'coverage']);
// dot folders are left out (editor and tool state), except CI configuration
const KEEP_DOT_DIRS = new Set(['.github', '.gitlab', '.circleci', '.devcontainer']);
const MAX_FILES = 20000;

function visible(rel: string): boolean {
  return rel.split('/').every((p, i) => !p.startsWith('.') || (i === 0 && KEEP_DOT_DIRS.has(p)));
}

function walk(dir: string, base: string, out: string[], depth: number, limit = MAX_FILES): void {
  if (depth > 6 || out.length >= limit) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    if ((e.name.startsWith('.') && !KEEP_DOT_DIRS.has(e.name)) || SKIP_DIRS.has(e.name)) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), rel, out, depth + 1, limit);
    else out.push(rel);
  }
}

const cache = new Map<string, { at: number; files: RepoFiles }>();

/** The project's files (repo-relative, forward slashes). Memoized for a few seconds: one prompt build asks several times. */
export function repoFiles(repoPath: string, ttlMs = 5000): RepoFiles {
  const hit = cache.get(repoPath);
  if (hit && Date.now() - hit.at < ttlMs) return hit.files;
  let out: RepoFiles;
  try {
    const tracked = git(repoPath, ['ls-files', '-z', '--cached'], 64 * 1024 * 1024).split('\0').filter(Boolean);
    // new files: a new folder is one entry ("models/"), so a fresh cache or dataset folder costs nothing to list
    const others = git(repoPath, ['ls-files', '-z', '--others', '--exclude-standard', '--directory', '--no-empty-directory'], 16 * 1024 * 1024).split('\0').filter(Boolean);
    // a small new folder (fresh sources nobody committed yet) is listed file by file; a big one (a dataset, a
    // downloaded SDK, a cache someone forgot to ignore) stays one entry
    const expanded: string[] = [];
    const newDirs: string[] = [];
    let asked = 0;
    for (const d of others.filter((p) => p.endsWith('/') && visible(p.slice(0, -1)))) {
      const probe: string[] = [];
      if (expanded.length < 400 && asked < 12) walk(path.join(repoPath, d), d.slice(0, -1), probe, d.split('/').length - 1, 101);
      // small enough: git lists it exactly (its ignore rules apply inside the folder too)
      const inside = probe.length && probe.length <= 100
        ? (asked++, git(repoPath, ['ls-files', '-z', '--others', '--exclude-standard', '--', d]).split('\0').filter(Boolean)) : [];
      if (inside.length && expanded.length + inside.length <= 400) expanded.push(...inside);
      else newDirs.push(d);
    }
    const all = [...new Set([...tracked, ...others.filter((p) => !p.endsWith('/')), ...expanded])].filter((p) => !p.startsWith('.office/') && visible(p));
    out = { files: all.slice(0, MAX_FILES), newDirs, source: 'git', truncated: all.length > MAX_FILES };
  } catch {
    const files: string[] = [];
    walk(repoPath, '', files, 0);
    out = { files, newDirs: [], source: 'fs', truncated: files.length >= MAX_FILES };
  }
  cache.set(repoPath, { at: Date.now(), files: out });
  if (cache.size > 50) cache.delete(cache.keys().next().value!);
  return out;
}

// Binary and media files: counted by type, never listed one by one.
const ASSET_EXT = new Set(('png jpg jpeg gif bmp tga tif tiff psd webp ico icns svg exr hdr wav mp3 ogg flac m4a opus aac mid midi mp4 mov avi mkv webm '
  + 'ttf otf woff woff2 fbx obj blend glb gltf dae 3ds max uasset umap pak pth pt onnx h5 tflite pb ckpt safetensors bin weights npy npz pkl '
  + 'parquet zip tar gz tgz 7z rar exe dll so dylib a lib o obj pdb jar apk aab ipa hex elf meta import mat db sqlite').split(' '));

export function isAsset(rel: string): boolean {
  const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.') + 1).toLowerCase() : '';
  return ASSET_EXT.has(ext);
}

// Files that tell an agent how the project is built, configured and entered.
const KEY_NAMES = /^(readme(\.\w+)?|package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|pipfile|cargo\.toml|go\.mod|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|cmakelists\.txt|makefile|platformio\.ini|sketch\.yaml|prj\.conf|west\.yml|sdkconfig(\.defaults)?|pubspec\.yaml|package\.swift|project\.godot|[\w.-]+\.(sln|csproj|uproject|ino)|dockerfile|docker-compose[\w.-]*\.ya?ml|chart\.yaml|[\w-]+\.tf|tsconfig\.json|vite\.config\.\w+|next\.config\.\w+|androidmanifest\.xml|projectversion\.txt|(main|index|app|server|program)\.(py|js|ts|tsx|go|rs|cs|java|kt|c|cpp|dart))$/i;

function ext(rel: string): string {
  const b = rel.slice(rel.lastIndexOf('/') + 1);
  return b.includes('.') ? b.slice(b.lastIndexOf('.')).toLowerCase() : b;
}

function countBy<T>(items: T[], key: (t: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

const SMALL_REPO = 120;

/**
 * The repo tour for a prompt. A small project lists every source file, as before. A larger one gets its shape instead
 * — folders with file counts, the files that say how it is built and entered, file types — so the agent knows where to
 * look in a codebase of any size for about the same number of characters, and opens what it needs with its own tools.
 */
export function summarizeRepo(repoPath: string, rf: RepoFiles = repoFiles(repoPath)): string {
  const name = path.basename(repoPath);
  const assets = rf.files.filter(isAsset);
  const code = rf.files.filter((f) => !isAsset(f));
  const assetLine = assets.length ? `\nAssets (${assets.length}, not listed): ${countBy(assets, ext).slice(0, 8).map(([e, n]) => `${n} ${e}`).join(', ')}` : '';
  const newLine = rf.newDirs.length ? `\nNew folders (not yet in Git): ${rf.newDirs.slice(0, 10).join(', ')}${rf.newDirs.length > 10 ? ` (+${rf.newDirs.length - 10})` : ''}` : '';
  if (code.length <= SMALL_REPO) return `Repo: ${name}\nFiles (${code.length}): ${code.join(', ')}${assetLine}${newLine}`;

  const L = [`Repo: ${name} — ${rf.files.length}${rf.truncated ? '+' : ''} files (${code.length} source/text, ${assets.length} assets)`];
  // folders: top level with counts, each with its largest sub-folders
  const top = countBy(code, (f) => (f.includes('/') ? `${f.split('/')[0]}/` : '(root)'));
  const folders = top.slice(0, 16).map(([dir, n]) => {
    if (dir === '(root)') return `(root) ${n}`;
    const subs = countBy(code.filter((f) => f.startsWith(dir) && f.slice(dir.length).includes('/')), (f) => `${f.slice(dir.length).split('/')[0]}/`).slice(0, 4);
    return `${dir} ${n}${subs.length ? ` [${subs.map(([s, m]) => `${s} ${m}`).join(', ')}]` : ''}`;
  });
  L.push(`Folders (source files): ${folders.join(' · ')}${top.length > 16 ? ` · +${top.length - 16} more` : ''}`);
  const keys = code.filter((f) => KEY_NAMES.test(f.slice(f.lastIndexOf('/') + 1)))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  if (keys.length) L.push(`Key files: ${keys.slice(0, 30).join(', ')}${keys.length > 30 ? ` (+${keys.length - 30})` : ''}`);
  L.push(`File types: ${countBy(code, ext).slice(0, 10).map(([e, n]) => `${e} ${n}`).join(', ')}`);
  return L.join('\n') + assetLine + newLine;
}
