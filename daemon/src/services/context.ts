import fs from 'node:fs';
import path from 'node:path';
import { q } from '../db.ts';
import { compactLog, head, parseJson, sha256 } from '../util.ts';
import type { Repo, Task } from '../types.ts';

// Context service (spec 3, 5.9): builds the minimal context pack per work
// item — task text, acceptance criteria, relevant file slices, repo summary,
// prior errors for this task — under a token budget.
//
// scope 'repo' is for a task's first items (plan, prompt drafting, implement):
// the repo file list + README excerpt orient the agent. Downstream items
// (qa, review, fix, accept, analyse) run in 'task' scope: the files the task
// already changed, no repo tour — those agents judge or patch the delivery.

export interface ContextPack {
  repoSummary: string;
  files: { path: string; excerpt: string }[];
  errors: { id: string; title: string; excerpt: string }[];
  kbNotes: { id: string; fixSummary: string }[];
  hash: string;
  approxTokens: number;
  budgetChars: number;   // char budget the whole prompt is fitted to
}

export type PackScope = 'repo' | 'task';

function listFiles(dir: string, base: string, out: string[], depth: number): void {
  if (depth > 4 || out.length > 400) return;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) listFiles(path.join(dir, e.name), rel, out, depth + 1);
    else out.push(rel);
  }
}

function excerpt(repoPath: string, rel: string, maxLines: number): { path: string; excerpt: string } | null {
  const p = path.join(repoPath, rel);
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return { path: rel, excerpt: head(fs.readFileSync(p, 'utf8'), maxLines) };
  } catch { /* unreadable */ }
  return null;
}

export function buildContextPack(opts: {
  repo: Repo | null; task: Task | null; tokenBudget: number;
  scope?: PackScope; changedFiles?: string[]; excerpts?: boolean; basePath?: string;
}): ContextPack {
  const { repo, task } = opts;
  const scope = opts.scope ?? 'repo';
  const budgetChars = opts.tokenBudget * 4;
  let used = 0;

  let repoSummary = '';
  const files: ContextPack['files'] = [];
  if (repo && scope === 'repo') {
    const all: string[] = [];
    listFiles(repo.path, '', all, 0);
    repoSummary = `Repo: ${path.basename(repo.path)}\nFiles (${all.length}): ${all.slice(0, 120).join(', ')}`;
    used += repoSummary.length;

    const readme = ['README.md', 'readme.md'].map((f) => path.join(repo!.path, f)).find(fs.existsSync);
    if (readme) {
      const ex = head(fs.readFileSync(readme, 'utf8'), 60);
      files.push({ path: path.basename(readme), excerpt: ex });
      used += ex.length;
    }
    const wanted = task?.affectedPaths ?? [];
    for (const rel of wanted.slice(0, 8)) {
      const ex = excerpt(repo.path, rel, 120);
      if (ex && used + ex.excerpt.length < budgetChars) { files.push(ex); used += ex.excerpt.length; }
    }
  } else if (repo && scope === 'task') {
    // downstream stages: no repo tour, just what this task already touched
    const changed = (opts.changedFiles ?? []).slice(0, 24);
    repoSummary = changed.length ? `Files changed in this task:\n${changed.map((f) => `- ${f}`).join('\n')}` : '';
    used += repoSummary.length;
    if (opts.excerpts) {
      // isolated mode edits live in the task's worktree, not the repo checkout
      const base = opts.basePath ?? repo.path;
      for (const rel of changed.slice(0, 8)) {
        const ex = excerpt(base, rel, 120);
        if (ex && used + ex.excerpt.length < budgetChars) { files.push(ex); used += ex.excerpt.length; }
      }
    }
  }

  const errors: ContextPack['errors'] = [];
  const kbNotes: ContextPack['kbNotes'] = [];
  if (task && scope === 'repo') {
    const errs = q(`SELECT id, title, evidence FROM error_reports WHERE task_id = ? AND status NOT IN ('resolved','wontfix') ORDER BY created_at DESC LIMIT 5`, task.id);
    for (const e of errs) {
      const ev = parseJson<{ logExcerpt?: string }>(e.evidence as string, {});
      errors.push({ id: e.id as string, title: e.title as string, excerpt: compactLog(ev.logExcerpt ?? '', 30) });
    }
  }

  const pack: ContextPack = { repoSummary, files, errors, kbNotes, hash: '', approxTokens: 0, budgetChars };
  const serialized = JSON.stringify(pack);
  pack.hash = sha256(serialized).slice(0, 16);
  pack.approxTokens = Math.ceil(serialized.length / 4);
  return pack;
}
