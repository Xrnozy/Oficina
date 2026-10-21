import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../util.ts';
import type { Repo } from '../types.ts';

// Git is the handoff surface for every agent kind (spec 8.3). One worktree +
// `agent/<task>` branch per task; a dedicated `.office/integration` worktree
// tracks the integration branch where DoD checks are evaluated.

// Resolve the git binary once (Windows needs the .exe form for execFileSync).
const GIT_BIN: string = (() => {
  for (const c of ['git.exe', 'git', 'git.cmd']) {
    try { execFileSync(c, ['--version'], { stdio: 'pipe', windowsHide: true }); return c; } catch { /* next */ }
  }
  try {
    const out = execSync('where git', { encoding: 'utf8', windowsHide: true }).trim().split('\n')[0].trim();
    if (out) return out;
  } catch { /* fall through */ }
  return 'git';
})();

// NOTE: on Windows, spawning with an explicit cwd containing spaces can fail
// with ENOENT. We therefore never pass `cwd`; `git -C <dir>` does the chdir.
export function git(cwd: string, args: string[], maxBuffer?: number): string {
  return execFileSync(GIT_BIN, ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(maxBuffer ? { maxBuffer } : {}) }).trim();
}

export function gitOk(cwd: string, args: string[]): { ok: boolean; out: string } {
  try { return { ok: true, out: git(cwd, args) }; }
  catch (e: any) { return { ok: false, out: String(e?.stderr ?? e?.message ?? e) }; }
}

export function officeDir(repo: Repo): string {
  return path.join(repo.path, '.office');
}

export function integrationWorktreePath(repo: Repo): string {
  return path.join(officeDir(repo), 'integration');
}

export function ensureRepo(p: string): void {
  ensureDir(p);
  if (!fs.existsSync(path.join(p, '.git'))) {
    git(p, ['init', '-b', 'main']);
    git(p, ['config', 'user.email', 'office@local']);
    git(p, ['config', 'user.name', 'Office Daemon']);
  }
  const head = gitOk(p, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) {
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n.office/\ndist/\n');
    git(p, ['add', '-A']);
    git(p, ['commit', '-m', 'chore: initial commit']);
  }
}

export function ensureIntegration(repo: Repo): string {
  const wt = integrationWorktreePath(repo);
  const exists = gitOk(repo.path, ['rev-parse', '--verify', repo.integrationBranch]);
  if (!exists.ok) git(repo.path, ['branch', repo.integrationBranch, repo.defaultBranch]);
  if (!fs.existsSync(path.join(wt, '.git'))) {
    ensureDir(officeDir(repo));
    const res = gitOk(repo.path, ['worktree', 'add', wt, repo.integrationBranch]);
    if (!res.ok && !fs.existsSync(path.join(wt, '.git'))) throw new Error(`worktree add failed: ${res.out}`);
  }
  return wt;
}

export function taskBranch(taskId: string): string { return `agent/${taskId}`; }

export function createWorktree(repo: Repo, taskId: string): { worktree: string; branch: string } {
  const branch = taskBranch(taskId);
  const wt = path.join(officeDir(repo), 'worktrees', taskId);
  ensureDir(path.dirname(wt));
  ensureIntegration(repo);
  const b = gitOk(repo.path, ['rev-parse', '--verify', branch]);
  if (b.ok) git(repo.path, ['branch', '-D', branch]);
  if (fs.existsSync(wt)) {
    gitOk(repo.path, ['worktree', 'remove', '--force', wt]);
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  }
  const res = gitOk(repo.path, ['worktree', 'add', wt, '-b', branch, repo.integrationBranch]);
  if (!res.ok) throw new Error(`worktree add failed: ${res.out}`);
  return { worktree: wt, branch };
}

export function commitAll(worktree: string, message: string): string | null {
  git(worktree, ['add', '-A']);
  const st = gitOk(worktree, ['status', '--porcelain']);
  if (!st.out) return headSha(worktree);
  const c = gitOk(worktree, ['commit', '-m', message]);
  if (!c.ok) return null;
  return headSha(worktree);
}

export function headSha(worktree: string): string | null {
  const r = gitOk(worktree, ['rev-parse', 'HEAD']);
  return r.ok ? r.out : null;
}

export function branchSha(repoPath: string, branch: string): string | null {
  const r = gitOk(repoPath, ['rev-parse', branch]);
  return r.ok ? r.out : null;
}

export function changedFiles(worktree: string, baseRef: string): string[] {
  const r = gitOk(worktree, ['diff', '--name-only', `${baseRef}...HEAD`]);
  if (!r.ok || !r.out) {
    const r2 = gitOk(worktree, ['diff', '--name-only', 'HEAD~1', 'HEAD']);
    return r2.ok && r2.out ? r2.out.split('\n').filter(Boolean) : [];
  }
  return r.out.split('\n').filter(Boolean);
}

export function diffText(worktree: string, baseRef: string): string {
  const r = gitOk(worktree, ['diff', `${baseRef}...HEAD`]);
  if (r.ok && r.out) return r.out;
  const r2 = gitOk(worktree, ['diff', 'HEAD~1', 'HEAD']);
  return r2.ok ? r2.out : '';
}

export interface MergeResult { ok: boolean; sha?: string; conflicts?: string[]; output?: string }

export function mergeIntoIntegration(repo: Repo, branch: string): MergeResult {
  const wt = ensureIntegration(repo);
  const res = gitOk(wt, ['merge', '--no-ff', '--no-edit', branch]);
  if (res.ok) return { ok: true, sha: headSha(wt) ?? undefined };
  const conflicts = gitOk(wt, ['diff', '--name-only', '--diff-filter=U']);
  gitOk(wt, ['merge', '--abort']);
  return { ok: false, conflicts: conflicts.out ? conflicts.out.split('\n').filter(Boolean) : [], output: res.out.slice(-1500) };
}

export function removeWorktree(repo: Repo, taskId: string): void {
  const wt = path.join(officeDir(repo), 'worktrees', taskId);
  if (fs.existsSync(wt)) gitOk(repo.path, ['worktree', 'remove', '--force', wt]);
  gitOk(repo.path, ['worktree', 'prune']);
}

export function initDemoRepo(p: string): void {
  ensureRepo(p);
  const wt = ensureIntegration({ path: p, integrationBranch: 'integration', defaultBranch: 'main' } as Repo);
  void wt;
}

export function renameBranch(repoPath: string, from: string, to: string): void {
  gitOk(repoPath, ['branch', '-m', from, to]);
}
