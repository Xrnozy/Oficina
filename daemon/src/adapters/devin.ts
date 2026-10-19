import { resolveSecret } from '../config.ts';
import { q1, run } from '../db.ts';
import { git, gitOk, headSha } from '../services/git.ts';
import { parseJsonFromText } from './llm.ts';
import type { Adapter, AdapterCtx } from './types.ts';
import { AdapterError } from './types.ts';
import type { WorkItemResult } from '../types.ts';

// Hosted-agent adapter (spec tier 2-3): Devin runs in its own cloud workspace.
// We never see its file writes — the handoff boundary is Git. Devin is asked to
// push its work to `devin/<task-or-workitem>` on the repo's origin remote; this
// adapter fetches and merges that branch into the task worktree when the
// session finishes. Observability is status-only (spec §8.6).
//
// API: https://docs.devin.ai — v1 sessions (legacy) and v3 org sessions with
// devin_mode for SWE-2 / agent mode selection. Auth: Bearer cog_… API key.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface DevinSession { session_id: string; url?: string; orgId?: string; apiVersion: 1 | 3 }

function mapModelToDevinMode(modelName: string | undefined): string | null {
  if (!modelName?.trim()) return null;
  const key = modelName.trim().toLowerCase().replace(/\s+/g, '-').replace(/_/g, '-');
  const aliases: Record<string, string> = {
    'swe-2': 'swe-2-medium',
    'swe2': 'swe-2-medium',
    'swe-2-med': 'swe-2-medium',
    'swe-2-medium': 'swe-2-medium',
    'swe-2-high': 'swe-2-high',
    'swe-2-max': 'swe-2-max',
  };
  const mode = aliases[key] ?? key;
  return mode || null;
}

async function resolveDevinOrgId(base: string, key: string, cfg: Record<string, unknown>): Promise<string | null> {
  const configured = String(cfg.orgId ?? '').trim();
  if (configured) return configured;
  try {
    const page = await devinFetch(base, key, '/v3/enterprise/organizations?first=5', { method: 'GET' });
    const items = Array.isArray(page.items) ? page.items : [];
    if (items.length === 1 && items[0]?.org_id) return String(items[0].org_id);
    if (items.length > 1) {
      throw new AdapterError('Devin org ID required — multiple organizations; set Organization ID on the Devin backend (Settings → Devin API)', 'bad-response');
    }
  } catch (e) {
    if (e instanceof AdapterError) throw e;
  }
  return null;
}

async function createDevinSession(
  base: string, key: string, cfg: Record<string, unknown>, prompt: string, devinMode: string | null,
  label: { title: string; tags: string[] },
): Promise<DevinSession> {
  const orgId = await resolveDevinOrgId(base, key, cfg);
  if (orgId) {
    // sessions belong to the service user, not to you — the "officechain"
    // tag and title make them easy to find in app.devin.ai
    const body: Record<string, unknown> = { prompt, idempotent: true, bypass_approval: true, title: label.title, tags: label.tags };
    if (devinMode) body.devin_mode = devinMode;
    const create = (b: Record<string, unknown>) => devinFetch(base, key, `/v3/organizations/${orgId}/sessions`, {
      method: 'POST',
      body: JSON.stringify(b),
    }) as Promise<DevinSession>;
    // an org with a tag allowlist may refuse our tags — labelling must never
    // stop the session, so retry once without them
    const session = await create(body).catch((e) => {
      if (!(e instanceof AdapterError) || e.kind !== 'bad-response') throw e;
      const { title: _t, tags: _g, ...plain } = body;
      return create(plain);
    });
    if (!session.session_id) throw new AdapterError('Devin v3 did not return a session id', 'bad-response');
    return { ...session, orgId, apiVersion: 3 };
  }
  if (devinMode) {
    throw new AdapterError(
      'Devin agent mode needs API v3 — add your Organization ID on the Devin backend (app.devin.ai → Settings → Devin API)',
      'bad-response',
    );
  }
  const session = await devinFetch(base, key, '/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ prompt, idempotent: true }),
  }) as DevinSession;
  if (!session.session_id) throw new AdapterError('Devin did not return a session id', 'bad-response');
  return { ...session, apiVersion: 1 };
}

async function fetchDevinSession(base: string, key: string, session: DevinSession): Promise<any> {
  if (session.apiVersion === 3 && session.orgId) {
    return devinFetch(base, key, `/v3/organizations/${session.orgId}/sessions/${session.session_id}`, { method: 'GET' });
  }
  return devinFetch(base, key, `/v1/session/${session.session_id}`, { method: 'GET' });
}

function devinStatusLine(info: any, v3: boolean): string {
  if (v3) return String(info.status_detail ?? info.status ?? 'working');
  return String(info.status_enum ?? info.status ?? 'working');
}

function devinSessionDone(info: any, v3: boolean): boolean {
  if (v3) {
    const d = String(info.status_detail ?? '');
    const s = String(info.status ?? '');
    if (d === 'finished' || s === 'exit') return true;
    if (s === 'error' || d === 'error') return true;
    return ['usage_limit_exceeded', 'out_of_credits', 'contract_expired'].includes(d);
  }
  return ['finished', 'expired', 'finished_auto_suspend'].includes(String(info.status_enum ?? info.status ?? ''));
}

function devinSessionBlocked(info: any, v3: boolean): boolean {
  if (v3) return ['waiting_for_user', 'waiting_for_approval'].includes(String(info.status_detail ?? ''));
  return String(info.status_enum ?? '') === 'blocked';
}

async function devinFetch(base: string, key: string, pathName: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${base}${pathName}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 401 || res.status === 403) throw new AdapterError(`Devin auth failed (${res.status}) — check the API key`, 'auth');
  if (res.status === 429) throw new AdapterError('Devin rate limited', 'rate-limit');
  if (!res.ok) throw new AdapterError(`Devin ${res.status}: ${await res.text().catch(() => '')}`, res.status >= 500 ? 'server' : 'bad-response');
  return res.json().catch(() => ({}));
}

function buildPrompt(ctx: AdapterCtx, pushBranch: string | null, producesCode: boolean): string {
  const parts = [ctx.prompt];
  if (pushBranch && ctx.repo) {
    parts.push(
      '',
      `HANDOFF — this work is being orchestrated externally. Clone the repo's remote, do ALL work on a new branch named exactly "${pushBranch}", commit, and PUSH the branch to origin when done. ` +
      `Do not open a pull request — pushing the branch is the delivery. In the session's structured_output report { "branch": "${pushBranch}", "summary": "<what you did>" }.`,
    );
  } else if (producesCode) {
    parts.push(
      '',
      'HANDOFF — you cannot reach the repository directly. When done, set the session structured_output to { "summary": "<what you did>", "notes": "<anything the reviewer needs>" }.',
    );
  } else {
    // Plan/review/analysis: the prompt itself demands a JSON answer. Tell Devin
    // to put THAT object in structured_output — not a session summary — so the
    // engine can parse the decision back out.
    parts.push(
      '',
      'OUTPUT CONTRACT — the prompt above asks you to reply with a JSON object. Put that exact JSON object into the session structured_output and also as your final message, unwrapped (no markdown fences).',
    );
  }
  return parts.join('\n');
}

export const devinAdapter: Adapter = {
  id: 'devin',
  version: '1.0.0',

  async dispatch(ctx: AdapterCtx): Promise<WorkItemResult> {
    const apiKey = resolveSecret(ctx.account?.secretRef);
    if (!apiKey) throw new AdapterError('no Devin API key on this account (add one on the Providers page)', 'auth');
    const cfg = (ctx.account?.config ?? {}) as Record<string, unknown>;
    const base = (String(cfg.baseUrl ?? '').trim() || 'https://api.devin.ai').replace(/\/$/, '');
    const timeoutMs = (Number(cfg.timeoutSec) || 3600) * 1000;
    const pollMs = Math.max(5_000, (Number(cfg.pollSec) || 15) * 1000);

    // Delivery: can Devin push back into this repo? Only if it has a remote.
    // Only code-producing work items need the handoff — warn for those; plan,
    // review and analysis come back as the report regardless.
    const producesCode = ['implement', 'fix', 'test', 'doc'].includes(ctx.workItem.kind);
    let pushBranch: string | null = null;
    if (ctx.repo && producesCode) {
      const remote = gitOk(ctx.repo.path, ['remote', 'get-url', 'origin']);
      if (remote.ok && remote.out.trim()) pushBranch = `devin/${ctx.task?.id ?? ctx.workItem.id}`;
      else ctx.emit('agent.output', { line: '[devin] repo has no origin remote — Devin cannot push code back; collecting its report only' });
    }

    const devinMode = mapModelToDevinMode(ctx.model?.name);
    const label = {
      title: `officeChain · ${ctx.workItem.kind}${ctx.task ? ` · ${ctx.task.title}` : ''}`.slice(0, 120),
      tags: ['officechain', ctx.workItem.kind, ...(ctx.task ? [ctx.task.id] : [])],
    };
    const session = await createDevinSession(base, apiKey, cfg, buildPrompt(ctx, pushBranch, producesCode), devinMode, label);
    if (devinMode) ctx.emit('agent.output', { line: `[devin] devin_mode=${devinMode}` });
    // Persist the ref so "message this agent" in the UI reaches the session.
    run('UPDATE work_items SET adapter_ref = ? WHERE id = ?', session.session_id, ctx.workItem.id);
    ctx.emit('agent.output', { line: `[devin] session started (${session.apiVersion === 3 ? 'v3' : 'v1'}): ${session.url ?? session.session_id}` });

    const deadline = Date.now() + timeoutMs;
    let lastStatus = '';
    let info: any = {};
    const v3 = session.apiVersion === 3;
    for (;;) {
      await sleep(pollMs);
      info = await fetchDevinSession(base, apiKey, session);
      const status = devinStatusLine(info, v3);
      if (status !== lastStatus) {
        lastStatus = status;
        ctx.emit('agent.output', { line: `[devin] ${status}` });
        ctx.emit('agent.heartbeat', { session: session.session_id, status });
        if (devinSessionBlocked(info, v3)) ctx.emit('agent.output', { line: '[devin] waiting on input — message this agent from Live activity to unblock it' });
      }
      if (devinSessionDone(info, v3)) break;
      if (Date.now() > deadline) throw new AdapterError(`Devin session timed out after ${Math.round(timeoutMs / 60000)}m (still ${status})`, 'timeout');
    }

    const structured = (info.structured_output ?? {}) as Record<string, unknown>;
    const summary = String(structured.summary ?? `Devin session ${lastStatus || 'finished'} — ${session.url ?? session.session_id}`);
    const prUrl = (structured.pr_url ?? info.pull_request?.url) as string | undefined;

    // Collect the pushed branch into the task worktree, if it exists.
    let filesChanged: string[] = [];
    let sha: string | undefined;
    if (pushBranch && ctx.repo && ctx.worktree) {
      const fetched = gitOk(ctx.repo.path, ['fetch', 'origin', pushBranch]);
      if (fetched.ok) {
        const before = headSha(ctx.worktree);
        const merged = gitOk(ctx.worktree, ['merge', '--no-edit', `origin/${pushBranch}`]);
        if (merged.ok && headSha(ctx.worktree) !== before) {
          sha = headSha(ctx.worktree) ?? undefined;
          filesChanged = git(ctx.worktree, ['diff', '--name-only', `${before}..HEAD`]).split('\n').filter(Boolean);
          ctx.emit('agent.output', { line: `[devin] merged ${pushBranch} (${filesChanged.length} files)` });
        } else if (!merged.ok) {
          ctx.emit('agent.output', { line: `[devin] merge of ${pushBranch} conflicted — delivered as branch for review` });
        }
      } else {
        ctx.emit('agent.output', { line: `[devin] branch ${pushBranch} not found on origin — check ${session.url ?? 'the session'} for its output` });
      }
    }

    // For plan/review/analysis the JSON answer is what matters: prefer a
    // populated structured_output, fall back to JSON in the session's last
    // message (not all Devin flows fill structured_output).
    const msgs = Array.isArray(info.messages) ? info.messages as Record<string, unknown>[] : [];
    const lastMsgText = [...msgs].reverse().map((m) => String(m?.message ?? m?.text ?? '')).find((t) => t.includes('{'));
    const json = (Object.keys(structured).length ? parseJsonFromText(JSON.stringify(structured)) : null)
      ?? (lastMsgText ? parseJsonFromText(lastMsgText) : null);

    return {
      summary,
      sha,
      prUrl,
      filesChanged,
      raw: { sessionId: session.session_id, url: session.url, status: lastStatus, structured, text: lastMsgText ?? '', json },
      // Devin bills in ACUs, not tokens — recorded in raw, no USD estimate.
      usage: { costUsd: 0, costSource: 'estimate' },
    };
  },

  async sendMessage(ref: string, text: string): Promise<void> {
    const wi = q1('SELECT account_id FROM work_items WHERE adapter_ref = ? ORDER BY started_at DESC LIMIT 1', ref) as { account_id?: string } | undefined;
    if (!wi?.account_id) return;
    const acc = q1('SELECT secret_ref, config FROM accounts WHERE id = ?', wi.account_id) as { secret_ref?: string; config?: string } | undefined;
    const key = resolveSecret(acc?.secret_ref);
    if (!key) return;
    const cfg = JSON.parse(acc?.config ?? '{}') as Record<string, unknown>;
    const base = (String(cfg.baseUrl ?? '').trim() || 'https://api.devin.ai').replace(/\/$/, '');
    await devinFetch(base, key, `/v1/session/${ref}/message`, { method: 'POST', body: JSON.stringify({ message: text }) });
  },
};
