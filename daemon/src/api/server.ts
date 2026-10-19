import express, { type Request, type Response } from 'express';
import { createOffice, deleteOffice, exportOffice, exportWorkflow, importOffice, importWorkflow, updateOffice } from '../services/offices.ts';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { q, q1, run, tx } from '../db.ts';
import { emit, listEvents, onEvent, verifyChain } from '../bus.ts';
import { now, parseJson, sha256, ulid } from '../util.ts';
import { rowToCycle, rowToRun, rowToTask, rowToWorkItem } from '../rows.ts';
import { getError, rowToError } from '../services/errors.ts';
import { readBlob } from '../services/verify.ts';
import {
  approveDod, assignSweep, createRun, setRunWorkflow, evaluateDodOnIntegration, getRun, getTask,
  maybeAdvanceRun, messageAgent, ownerApproveTask, ownerEditDod, ownerEditTask,
  pauseRun, proceedMerge, resumeRun, simulateWorkflow, stopRun, getRepo, getWorkspace,
} from '../engine/engine.ts';
import { decideApproval, requestApproval } from '../services/policy.ts';
import { ensureIntegration, ensureRepo, gitOk } from '../services/git.ts';
import { getAgent, getAccount, getProvider } from '../services/router.ts';
import { resolveManual } from '../adapters/manual.ts';
import { estimatedWindows, spendTodayUsd, tokenReport, usageTotals } from '../services/usage.ts';
import { buildRunSummary, summaryMarkdown } from '../services/summary.ts';
import { deleteSecret, storeSecret } from '../config.ts';
import { rowToAgent } from '../services/router.ts';
import { execFileSync } from 'node:child_process';
import type { AgentModelSettings, DodItem } from '../types.ts';
import { modelSettings, settingsSupport, validateModelSettings } from '../services/models.ts';
import { messagesForRun, unreadCountFor } from '../services/messages.ts';
import { projectDoc } from '../services/projectDoc.ts';
import {
  addNodeForAgent, cloneWorkflow, createWorkflow, deleteWorkflow, estimateWorkflowCalls, getWorkflow, listWorkflows,
  patchNodeRouting, routingView, rowToVersion, saveWorkflowVersion, setActiveWorkflow, validateWorkflow, validationSummary,
  workflowAudit, workflowRefsFor, workflowTemplates,
} from '../services/workflow.ts';
import { CATALOG_ADAPTERS, fetchCatalog, fetchProviderCatalog, syncProviderModels } from '../services/provider-catalog.ts';
import { DEFAULT_BASE_URL } from '../services/api-catalog.ts';
import { CLI_PRESETS, detectInstalledClis } from '../adapters/cli-resolve.ts';
import { registerHistoryRoutes } from './history.ts';
import {
  attachSkill, createSkill, detachSkill, duplicateSkill, findSkillDirs, hasSkillMd, importSkillDir,
  relinkSkillContent, removeSkill, scanSkillFile, skillUsage, skillsFor, updateSkill,
} from '../services/skills.ts';

// The Office daemon API: REST for commands + a WebSocket carrying the event
// stream. The UI is a pure client of this API (spec section 3).

function rowToRepo(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id, workspaceId: r.workspace_id, path: r.path, remoteUrl: r.remote_url,
    defaultBranch: r.default_branch, integrationBranch: r.integration_branch,
    buildCmd: r.build_cmd, testCmd: r.test_cmd, checkProfileId: r.check_profile_id,
  };
}

export function createServer(port: number, uiDir: string): http.Server {
  const app = express();
  app.use(express.json({ limit: '8mb' }));
  registerHistoryRoutes(app);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  // Big event payloads (a prompt's `detail` can be 12k chars) go to every
  // client on every event — the wire gets a capped copy; the full event stays
  // in the DB and /api/events/:seq serves it on demand.
  const WS_FIELD_CAP = 2000;
  const slim = (p: Record<string, unknown>): Record<string, unknown> => {
    let out: Record<string, unknown> | null = null;
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === 'string' && v.length > WS_FIELD_CAP) {
        out ??= { ...p };
        out[k] = `${v.slice(0, WS_FIELD_CAP)}\n… truncated`;
        out[`${k}Truncated`] = true;
      }
    }
    return out ?? p;
  };
  onEvent((e) => {
    const msg = JSON.stringify({ type: 'event', event: { ...e, payload: slim(e.payload) } });
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', ts: now() }));
  });

  const ok = (res: Response, data: unknown) => res.json(data);
  const err = (res: Response, code: number, msg: string) => res.status(code).json({ error: msg });

  // ---------- reads ----------
  app.get('/api/health', (_req, res) => ok(res, { ok: true, ts: now(), chain: verifyChain() }));

  app.get('/api/workspaces', (_req, res) => {
    const rows = q('SELECT * FROM workspaces').map((r) => ({ ...r, repoIds: parseJson(r.repo_ids as string, []), allowedProviderIds: parseJson(r.allowed_provider_ids as string, []), settings: parseJson(r.settings as string, {}) }));
    ok(res, rows);
  });

  // ---------- offices (workspaces): create, clone, rename, delete, export/import ----------
  app.post('/api/workspaces', (req, res) => {
    const r = createOffice({ name: req.body?.name, purpose: req.body?.purpose, cloneFrom: req.body?.cloneFrom ?? null });
    if ('error' in r) return err(res, 400, r.error);
    ok(res, r);
  });
  app.post('/api/workspaces/import', (req, res) => {
    const r = importOffice(req.body?.bundle, { name: req.body?.name });
    if ('error' in r) return err(res, 400, r.error);
    ok(res, r);
  });
  app.get('/api/workspaces/:id/export', (req, res) => {
    const b = exportOffice(req.params.id);
    if (!b) return err(res, 404, 'office not found');
    ok(res, b);
  });
  app.put('/api/workspaces/:id', (req, res) => {
    const r = updateOffice(req.params.id, { name: req.body?.name, purpose: req.body?.purpose });
    if ('error' in r) return err(res, r.error.includes('not found') ? 404 : 400, r.error);
    ok(res, r);
  });
  app.delete('/api/workspaces/:id', (req, res) => {
    const r = deleteOffice(req.params.id);
    if ('error' in r) return err(res, r.error.includes('not found') ? 404 : 400, r.error);
    ok(res, r);
  });
  app.get('/api/workflows/:id/export', (req, res) => {
    const b = exportWorkflow(req.params.id);
    if (!b) return err(res, 404, 'workflow not found');
    ok(res, b);
  });
  app.post('/api/workflows/import', (req, res) => {
    if (!req.body?.workspaceId) return err(res, 400, 'workspaceId required');
    const r = importWorkflow(String(req.body.workspaceId), req.body?.bundle, { name: req.body?.name });
    if ('error' in r) return err(res, 400, r.error);
    ok(res, r);
  });

  app.get('/api/agents', (_req, res) => {
    const agents = q('SELECT * FROM agents').map((r) => rowToAgent(r));
    const memberships = q('SELECT * FROM memberships');
    const roles = q('SELECT * FROM roles');
    ok(res, agents.map((a) => ({
      ...a, model: modelSettings(a.settings), unread: unreadCountFor(a.id),
      memberships: memberships.filter((m) => m.agent_id === a.id).map((m) => ({ ...m, role: roles.find((x) => x.id === m.role_id)?.name })),
    })));
  });

  app.get('/api/roles', (_req, res) => ok(res, q('SELECT * FROM roles').map((r) => ({ ...r, responsibilities: parseJson(r.responsibilities as string, []), allowedActions: parseJson(r.allowed_actions as string, []), defaultSkills: parseJson(r.default_skills as string, []) }))));

  app.get('/api/repos', (req, res) => {
    const wsId = req.query.workspaceId ? String(req.query.workspaceId) : null;
    const rows = wsId
      ? q('SELECT * FROM repos WHERE workspace_id = ? ORDER BY rowid', wsId)
      : q('SELECT * FROM repos ORDER BY rowid');
    ok(res, rows.map(rowToRepo));
  });

  app.post('/api/repos', (req, res) => {
    try {
      const { workspaceId, path: rawPath, buildCmd, testCmd } = req.body ?? {};
      if (!workspaceId || !rawPath) return err(res, 400, 'workspaceId and path required');
      const ws = q1('SELECT * FROM workspaces WHERE id = ?', workspaceId);
      if (!ws) return err(res, 400, 'workspace not found');
      const abs = path.resolve(String(rawPath));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        return err(res, 400, 'path is not an existing directory on this machine');
      }
      const existing = q1('SELECT * FROM repos WHERE workspace_id = ? AND path = ?', workspaceId, abs);
      if (existing) return ok(res, rowToRepo(existing));
      // Non-git folders get a repo + initial commit; existing repos are taken
      // as-is. Either way the folder is where task worktrees and the
      // integration branch live.
      ensureRepo(abs);
      const remote = gitOk(abs, ['remote', 'get-url', 'origin']);
      const branch = gitOk(abs, ['symbolic-ref', '--short', 'HEAD']);
      const base = path.basename(abs).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
      let repoId = `repo-${base}`;
      for (let n = 2; q1('SELECT 1 FROM repos WHERE id = ?', repoId); n++) repoId = `repo-${base}-${n}`;
      const repo: Record<string, unknown> = {
        id: repoId, workspace_id: workspaceId, path: abs,
        remote_url: remote.ok ? remote.out : null,
        default_branch: branch.ok ? branch.out : 'main',
        integration_branch: 'integration',
        build_cmd: String(buildCmd ?? ''), test_cmd: String(testCmd ?? ''),
      };
      run(`INSERT INTO repos (id, workspace_id, path, remote_url, default_branch, integration_branch, build_cmd, test_cmd)
           VALUES (?,?,?,?,?,?,?,?)`,
        repoId, workspaceId, abs, repo.remote_url, repo.default_branch, 'integration',
        repo.build_cmd, repo.test_cmd);
      const ids = parseJson(ws.repo_ids as string, [] as string[]);
      if (!ids.includes(repoId)) {
        run('UPDATE workspaces SET repo_ids = ? WHERE id = ?', JSON.stringify([...ids, repoId]), workspaceId);
      }
      ensureIntegration(getRepo(repoId)!);
      emit('repo.registered', 'owner', { repoId, path: abs, remote: repo.remote_url }, null, null);
      ok(res, rowToRepo(q1('SELECT * FROM repos WHERE id = ?', repoId)!));
    } catch (e) { err(res, 500, `${String(e)}\n${(e as Error)?.stack ?? ''}`); }
  });

  // each run carries the workflow it is pinned to (null = the standard pipeline)
  app.get('/api/runs', (_req, res) => ok(res, q('SELECT * FROM runs ORDER BY rowid DESC LIMIT 50').map((r) => {
    const v = r.workflow_version_id ? q1('SELECT v.n, w.id, w.name FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE v.id = ?', r.workflow_version_id as string) : null;
    return { ...rowToRun(r), workflow: v ? { id: v.id as string, name: v.name as string, n: v.n as number } : null };
  })));

  app.get('/api/runs/:id', (req, res) => {
    const r = getRun(req.params.id);
    if (!r) return err(res, 404, 'run not found');
    const dod = q1('SELECT * FROM dod WHERE id = ?', r.dodId);
    const tasks = q('SELECT * FROM tasks WHERE run_id = ?', r.id).map(rowToTask);
    const cycles = q('SELECT * FROM cycles WHERE run_id = ? ORDER BY n', r.id).map(rowToCycle);
    const agents = q(`SELECT DISTINCT a.* FROM agents a JOIN work_items w ON w.agent_id = a.id WHERE w.run_id = ?`, r.id).map(rowToAgent);
    ok(res, { ...r, dod: dod ? { ...dod, items: parseJson(dod.items as string, []) } : null, tasks, cycles, agents });
  });

  app.get('/api/runs/:id/token-report', (req, res) => {
    if (!getRun(req.params.id)) return err(res, 404, 'run not found');
    ok(res, tokenReport(req.params.id));
  });

  // Run summary (spec 6.6): terminal runs return the stored summary; live runs
  // are summarized on the fly. `?format=md` exports Markdown for download.
  app.get('/api/runs/:id/summary', (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return err(res, 404, 'run not found');
    if (req.query.format === 'md') {
      const row = q1('SELECT summary_md FROM runs WHERE id = ?', run.id);
      const md = (row?.summary_md as string | null) ?? (() => { const s = buildRunSummary(run.id); return s ? summaryMarkdown(s) : null; })();
      if (!md) return err(res, 404, 'no summary');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="run-${run.id}.md"`);
      res.send(md);
      return;
    }
    ok(res, buildRunSummary(run.id));
  });

  app.get('/api/runs/:id/events', (req, res) => {
    const types = req.query.types ? String(req.query.types).split(',') : undefined;
    const since = req.query.sinceSeq ? Number(req.query.sinceSeq) : undefined;
    ok(res, listEvents({ runId: req.params.id, types, sinceSeq: since, limit: Number(req.query.limit ?? 2000), latest: req.query.latest === '1' }));
  });

  // Replay: task board state as of a given event seq (read-only; never re-executes).
  app.get('/api/runs/:id/state-at', (req, res) => {
    const seq = Number(req.query.seq ?? 0);
    const evs = listEvents({ runId: req.params.id, limit: 100000 }).filter((e) => e.seq <= seq);
    const taskStatus = new Map<string, { title: string; status: string }>();
    for (const e of evs) {
      if (e.type === 'task.created') taskStatus.set(e.entityId!, { title: String(e.payload.title ?? ''), status: 'backlog' });
      if (e.type === 'task.status' && taskStatus.has(e.entityId!)) taskStatus.get(e.entityId!)!.status = String(e.payload.status);
    }
    const runEv = [...evs].reverse().find((e) => e.type === 'run.status' || e.type === 'run.started' || e.type === 'run.done' || e.type === 'run.created');
    ok(res, { seq, runStatus: runEv ? (runEv.payload.status ?? (runEv.type === 'run.done' ? 'done' : 'running')) : 'draft', tasks: [...taskStatus.entries()].map(([id, t]) => ({ id, ...t })) });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const t = getTask(req.params.id);
    if (!t) return err(res, 404, 'task not found');
    const wis = q('SELECT * FROM work_items WHERE task_id = ? ORDER BY started_at', t.id).map(rowToWorkItem);
    const crs = q('SELECT * FROM check_runs WHERE task_id = ? ORDER BY created_at', t.id);
    const errs = q('SELECT * FROM error_reports WHERE task_id = ?', t.id).map(rowToError);
    const prompts = q('SELECT * FROM prompt_versions WHERE work_item_id IN (SELECT id FROM work_items WHERE task_id = ?)', t.id);
    const deps = t.dependsOn.map((d) => getTask(d)).filter(Boolean).map((d) => ({ id: d!.id, title: d!.title, status: d!.status }));
    ok(res, { ...t, workItems: wis, checkRuns: crs.map((c) => ({ ...c, failures: parseJson(c.failures as string, []), evidenceRefs: parseJson(c.evidence_refs as string, []) })), errorReports: errs, prompts, dependencies: deps });
  });

  app.get('/api/workitems/:id', (req, res) => {
    const r = q1('SELECT * FROM work_items WHERE id = ?', req.params.id);
    if (!r) return err(res, 404, 'not found');
    const wi = rowToWorkItem(r);
    const prompt = wi.promptVersionId ? q1('SELECT * FROM prompt_versions WHERE id = ?', wi.promptVersionId) : null;
    ok(res, { ...wi, prompt: prompt?.rendered_text ?? null });
  });

  app.post('/api/workitems/:id/manual-result', (req, res) => {
    const { summary, files, sha } = req.body ?? {};
    const done = resolveManual(req.params.id, { summary: summary ?? 'manual result', filesChanged: files ?? [], sha, usage: { costUsd: 0, costSource: 'estimate' } });
    ok(res, { accepted: done });
  });

  app.get('/api/errors', (req, res) => {
    const runId = req.query.runId as string | undefined;
    const rows = runId ? q('SELECT * FROM error_reports WHERE run_id = ? ORDER BY seq_no', runId) : q('SELECT * FROM error_reports ORDER BY created_at DESC LIMIT 200');
    ok(res, rows.map(rowToError));
  });

  app.get('/api/errors/:id', (req, res) => {
    const r = q1('SELECT * FROM error_reports WHERE id = ?', req.params.id);
    if (!r) return err(res, 404, 'not found');
    const e = rowToError(r);
    const fullLog = e.evidence.fullLogRef ? readBlob(e.evidence.fullLogRef) : null;
    ok(res, { ...e, fullLog });
  });

  app.get('/api/approvals', (_req, res) => {
    ok(res, q('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100').map((a) => ({ ...a, payload: parseJson(a.payload as string, {}) })));
  });

  app.post('/api/approvals/:id/decide', (req, res) => {
    const { approve, reason, alwaysAllowForAgent } = req.body ?? {};
    if (!approve && !reason) return err(res, 400, 'a reason is required to reject');
    const a = decideApproval(req.params.id, !!approve, reason ?? '', alwaysAllowForAgent);
    if (!a) return err(res, 404, 'not found');
    ok(res, a);
  });

  // Batch approve every pending low-risk item (optionally within one run).
  // Only risk-gated change actions qualify — questions and escalations are
  // never batch-approved.
  const BATCH_APPROVABLE = new Set(['commit.task', 'file.write.protected', 'deps.add']);
  app.post('/api/approvals/approve-all', (req, res) => {
    const runId = req.body?.runId ?? null;
    const pending = q(`SELECT * FROM approvals WHERE status = 'pending' AND (? IS NULL OR run_id = ?) ORDER BY created_at`, runId, runId);
    let n = 0;
    const skipped: string[] = [];
    for (const a of pending) {
      const p = parseJson<Record<string, any>>(a.payload as string, {});
      const risky = p.risk?.risky === true || !BATCH_APPROVABLE.has(a.action as string);
      if (risky) { skipped.push(a.id as string); continue; }
      decideApproval(a.id as string, true, 'batch-approved: low risk');
      n++;
    }
    ok(res, { approved: n, skipped: skipped.length });
  });

  // Tray/UI notifications (spec 5.3): only needs-you, run done and run failed
  // surface — everything else stays in the event log. An approval that was
  // auto-approved before the poll lands does not notify.
  app.get('/api/notifications', (req, res) => {
    const after = Number(req.query.after) || 0;
    const evs = listEvents({ sinceSeq: after, types: ['approval.requested', 'run.done', 'run.stopped'], limit: 100 });
    const out: { seq: number; kind: string; title: string; body: string; runId: string | null; at: string }[] = [];
    for (const e of evs) {
      if (e.type === 'approval.requested') {
        const a = q1('SELECT status FROM approvals WHERE id = ?', e.payload.approvalId as string);
        if (!a || a.status !== 'pending') continue; // already decided (e.g. auto-approved)
        out.push({ seq: e.seq, kind: 'needs-you', title: 'Needs you', body: String(e.payload.summary ?? e.payload.action ?? 'a decision is waiting'), runId: e.runId, at: e.ts });
      } else if (e.type === 'run.done') {
        const goal = q1('SELECT goal FROM runs WHERE id = ?', e.runId)?.goal ?? '';
        out.push({ seq: e.seq, kind: 'run-done', title: 'Run finished', body: String(goal).slice(0, 160), runId: e.runId, at: e.ts });
      } else if (e.type === 'run.stopped') {
        out.push({ seq: e.seq, kind: 'run-failed', title: 'Run stopped', body: String(e.payload.reason ?? 'stopped').slice(0, 160), runId: e.runId, at: e.ts });
      }
    }
    ok(res, out);
  });

  // Dashboard digest (spec 5.4): what happened since the owner's last visit —
  // tasks finished or blocked, tokens used, and what still needs a decision.
  app.get('/api/digest', (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : '1970-01-01T00:00:00Z';
    // last status change per task since `since`
    const taskEvents = q(`SELECT entity_id, payload, ts FROM events WHERE type = 'task.status' AND ts > ? ORDER BY seq`, since);
    const latest = new Map<string, { status: string; title: string; reason?: string }>();
    for (const e of taskEvents) {
      const p = parseJson<Record<string, any>>(e.payload as string, {});
      if (e.entity_id) latest.set(e.entity_id as string, { status: p.status, title: p.title ?? '', reason: p.reason });
    }
    const done = [...latest.entries()].filter(([, t]) => t.status === 'done').map(([id, t]) => ({ id, title: t.title }));
    const blocked = [...latest.entries()].filter(([, t]) => ['blocked', 'failed', 'waiting-input'].includes(t.status))
      .map(([id, t]) => ({ id, title: t.title, status: t.status, reason: t.reason ?? null }));
    const usage = q1(`SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens,
                      COALESCE(SUM(cost_usd),0) costUsd FROM usage_records WHERE ts > ?`, since) ?? {};
    const promptChars = q1(`SELECT COALESCE(SUM(LENGTH(pv.rendered_text)),0) c FROM prompt_versions pv
                            JOIN work_items w ON w.id = pv.work_item_id WHERE w.finished_at > ?`, since)?.c ?? 0;
    const needsYou = q(`SELECT id, action, payload, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 8`)
      .map((a) => ({ id: a.id, action: a.action, summary: parseJson<Record<string, any>>(a.payload as string, {}).summary ?? a.action, since: a.created_at }));
    ok(res, { since, tasksDone: done, tasksBlocked: blocked, tokens: { ...(usage as object), promptChars }, needsYou });
  });

  app.get('/api/providers', (_req, res) => {
    const providers = q('SELECT * FROM providers').map((p) => ({ ...p, capabilities: parseJson(p.capabilities as string, {}), config: parseJson(p.config as string, {}), settingsSupport: settingsSupport(p.adapter_id as string) }));
    const rawAccounts = q('SELECT * FROM accounts');
    const accounts = rawAccounts.map((a) => ({ ...a, hasSecret: !!a.secret_ref, secret_ref: a.secret_ref ? '(stored)' : null, config: parseJson(a.config as string, {}) }));
    const models = q('SELECT * FROM models').map((m) => {
      const supports = parseJson(m.supports as string, {}) as Record<string, unknown>;
      return { ...m, supports, label: String(supports.displayName ?? m.name) };
    });
    const windows = q('SELECT * FROM quota_windows').map((w) => ({ ...w }));
    const circuits = q('SELECT * FROM circuits');
    const est = rawAccounts.flatMap((a) => estimatedWindows(a.id as string, a.monthly_budget_usd as number | null))
      .map((w) => ({ id: w.id, account_id: w.accountId, model_id: w.modelId, metric: w.metric, kind: w.kind, period: w.period, lim: w.lim, used: w.used, remaining: w.remaining, resets_at: w.resetsAt, source: w.source, confidence: w.confidence, observed_at: w.observedAt }));
    ok(res, { providers, accounts, models, windows: [...windows, ...est], circuits, totals: usageTotals() });
  });

  app.get('/api/usage', (_req, res) => {
    ok(res, {
      totals: usageTotals(),
      records: q('SELECT * FROM usage_records ORDER BY ts DESC LIMIT 200'),
      byAgent: q(`SELECT a.name, a.id, SUM(u.cost_usd) cost, COUNT(*) calls FROM usage_records u
                  JOIN work_items w ON w.id = u.work_item_id JOIN agents a ON a.id = w.agent_id GROUP BY a.id`),
    });
  });

  app.get('/api/dod/:runId', (req, res) => {
    const r = getRun(req.params.runId);
    if (!r) return err(res, 404, 'run not found');
    const dod = q1('SELECT * FROM dod WHERE id = ?', r.dodId);
    ok(res, dod ? { ...dod, items: parseJson(dod.items as string, []) } : null);
  });

  app.get('/api/skills', (_req, res) => {
    const skills = q('SELECT * FROM skills ORDER BY name');
    const versions = q('SELECT * FROM skill_versions ORDER BY created_at').map((v) => ({
      ...v, manifest: parseJson(v.manifest as string, {}), files: parseJson(v.files as string, []),
      hasContent: !!v.content, content: v.content ? String(v.content).slice(0, 20000) : null,
    }));
    const attachments = q('SELECT a.*, v.skill_id FROM skill_attachments a LEFT JOIN skill_versions v ON v.id = a.skill_version_id').map((a) => ({ ...a, target: parseJson(a.target as string, {}) }));
    ok(res, { skills, versions, attachments, usage: skillUsage() });
  });

  app.get('/api/events', (req, res) => ok(res, listEvents({ sinceSeq: req.query.sinceSeq ? Number(req.query.sinceSeq) : undefined, limit: 500 })));

  // full event incl. fields the WS broadcast truncates — the UI lazy-loads it
  app.get('/api/events/:seq', (req, res) => {
    const r = q1('SELECT * FROM events WHERE seq = ?', Number(req.params.seq));
    if (!r) return err(res, 404, 'not found');
    ok(res, { seq: r.seq, runId: r.run_id, ts: r.ts, actor: r.actor, type: r.type, entityId: r.entity_id, payload: parseJson(r.payload as string, {}) });
  });

  app.get('/api/blobs/:ref', (req, res) => {
    const content = readBlob(`blob:${req.params.ref}`);
    if (content == null) return err(res, 404, 'blob not found');
    res.type('text/plain').send(content);
  });

  // ---------- workflows ----------
  app.get('/api/workflows', (req, res) => {
    const wsId = String(req.query.workspaceId ?? '');
    if (!wsId) return err(res, 400, 'workspaceId required');
    ok(res, listWorkflows(wsId));
  });
  app.post('/api/workflows/validate', (req, res) => {
    const issues = validateWorkflow(req.body?.graph, req.body?.workspaceId);
    ok(res, { ...validationSummary(issues), issues, estimate: req.body?.graph ? estimateWorkflowCalls(req.body.graph) : null });
  });
  app.get('/api/workflows/templates', (_req, res) => ok(res, workflowTemplates()));
  app.post('/api/workflows/simulate', (req, res) => {
    const g = req.body?.graph;
    if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return err(res, 400, 'graph required');
    ok(res, simulateWorkflow(g, req.body ?? {}));
  });
  app.get('/api/workflows/refs', (req, res) => {
    ok(res, workflowRefsFor({ agentId: req.query.agentId as string | undefined, roleName: req.query.roleName as string | undefined }));
  });
  // The Routing page's view of the active workflow: ordered steps, branches,
  // loops and message lines with the agents and per-node model config on each.
  app.get('/api/workflows/active/routing', (req, res) => {
    const wsId = String(req.query.workspaceId ?? '');
    if (!wsId) return err(res, 400, 'workspaceId required');
    ok(res, routingView(wsId, req.query.workflowId ? String(req.query.workflowId) : null));
  });
  // Same view for an unsaved draft graph from the editor (live preview, nothing is stored).
  app.post('/api/workflows/routing-preview', (req, res) => {
    const { workspaceId, workflowId, graph } = req.body ?? {};
    if (!workspaceId || !graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return err(res, 400, 'workspaceId and graph required');
    ok(res, routingView(String(workspaceId), workflowId ? String(workflowId) : null, graph));
  });
  // Per-node model tier / prompt budget / bypass — written as a new version
  // so the Workflow inspector and this page always edit the same field.
  app.put('/api/workflows/:id/nodes/:nodeId', (req, res) => {
    const { modelTier, budgetChars, disabled } = req.body ?? {};
    const r = patchNodeRouting(req.params.id, req.params.nodeId, { modelTier, budgetChars, disabled });
    if ('error' in r) return err(res, 422, r.error);
    ok(res, r);
  });
  app.post('/api/workflows/:id/add-node', (req, res) => {
    const agentId = String(req.body?.agentId ?? '');
    if (!agentId) return err(res, 400, 'agentId required');
    const r = addNodeForAgent(req.params.id, agentId);
    if ('error' in r) return err(res, 422, r.error);
    ok(res, r);
  });

  // Nodes an agent touches in each workspace's effective workflow: pinned
  // directly, or the last member of a role a node names.
  function workflowWarningsForAgent(agentId: string): string[] {
    const warnings: string[] = [];
    for (const ref of workflowRefsFor({ agentId })) {
      warnings.push(`${ref.workflowName}: pinned on ${ref.nodes.map((n) => `"${n.label}"`).join(', ')}`);
    }
    for (const m of q(`SELECT m.role_id, m.workspace_id, r.name rname FROM memberships m JOIN roles r ON r.id = m.role_id WHERE m.agent_id = ? AND m.active = 1`, agentId)) {
      const others = (q1(`SELECT COUNT(*) c FROM memberships WHERE role_id = ? AND workspace_id = ? AND active = 1 AND agent_id != ?`, m.role_id, m.workspace_id, agentId)?.c as number) ?? 0;
      if (others > 0) continue;
      for (const ref of workflowRefsFor({ roleName: m.rname as string })) {
        warnings.push(`${ref.workflowName}: ${ref.nodes.map((n) => `"${n.label}"`).join(', ')} need a "${m.rname}" — this agent is the last one in that workspace`);
      }
    }
    return warnings;
  }
  app.get('/api/workflows/:id/audit', (req, res) => ok(res, workflowAudit(req.params.id)));
  app.get('/api/workflows/:id', (req, res) => {
    const w = getWorkflow(req.params.id);
    if (!w) return err(res, 404, 'not found');
    const issues = w.graph ? validateWorkflow(w.graph, w.workflow.workspaceId) : [];
    ok(res, { ...w, issues: { ...validationSummary(issues), issues }, estimate: w.graph ? estimateWorkflowCalls(w.graph) : null, audit: workflowAudit(req.params.id) });
  });
  app.get('/api/workflows/:id/versions/:n', (req, res) => {
    const v = q1('SELECT * FROM workflow_versions WHERE workflow_id = ? AND n = ?', req.params.id, Number(req.params.n));
    if (!v) return err(res, 404, 'version not found');
    ok(res, { version: rowToVersion(v), graph: parseJson(v.graph as string, { nodes: [], edges: [] }) });
  });
  app.post('/api/workflows', (req, res) => {
    const { workspaceId, name, description, graph } = req.body ?? {};
    if (!workspaceId || !name) return err(res, 400, 'workspaceId and name required');
    const r = createWorkflow(workspaceId, name, description ?? '', graph);
    if ('error' in r) return err(res, 422, r.error);
    ok(res, { id: r.workflowId });
  });
  app.put('/api/workflows/:id', (req, res) => {
    const { graph, note } = req.body ?? {};
    if (!graph) return err(res, 400, 'graph required');
    const r = saveWorkflowVersion(req.params.id, graph, note ?? '', 'owner');
    if ('error' in r) return err(res, 422, r.error);
    ok(res, r);
  });
  app.post('/api/workflows/:id/clone', (req, res) => {
    const r = cloneWorkflow(req.params.id, req.body?.name);
    if ('error' in r) return err(res, 422, r.error);
    ok(res, { id: r.workflowId });
  });
  app.delete('/api/workflows/:id', (req, res) => {
    const r = deleteWorkflow(req.params.id);
    if ('error' in r) return err(res, 422, r.error);
    ok(res, r);
  });
  app.post('/api/workflows/:id/activate', (req, res) => {
    const w = getWorkflow(req.params.id);
    if (!w) return err(res, 404, 'not found');
    const r = setActiveWorkflow(w.workflow.workspaceId, req.params.id);
    if ('error' in r) return err(res, 422, r.error);
    ok(res, r);
  });
  app.post('/api/workflows/:id/deactivate', (req, res) => {
    const w = getWorkflow(req.params.id);
    if (!w) return err(res, 404, 'not found');
    const r = setActiveWorkflow(w.workflow.workspaceId, null);
    if ('error' in r) return err(res, 422, r.error);
    ok(res, r);
  });

  // ---------- commands ----------
  app.post('/api/runs', (req, res) => {
    try {
      const { workspaceId, goal, budgetUsd, repoId, oneShot, limits, workflowId } = req.body ?? {};
      if (!workspaceId || !goal) return err(res, 400, 'workspaceId and goal required');
      const cleanLimits: Record<string, number> = {};
      for (const k of ['maxParallel', 'maxReadOnly', 'maxCycles', 'maxWallclockMin', 'sameErrorAttempts', 'noProgressCycles', 'maxTaskMinutes']) {
        const v = (limits as Record<string, unknown> | undefined)?.[k];
        if (v != null) { const n = Number(v); if (!Number.isFinite(n) || n < 0) return err(res, 400, `limits.${k} must be a non-negative number`); cleanLimits[k] = n; }
      }
      ok(res, createRun({ workspaceId, goal, budgetUsd, repoId, oneShot: !!oneShot, limits: cleanLimits, workflowId: workflowId ? String(workflowId) : undefined }));
    } catch (e) {
      if (/workflow not found/.test(String(e))) return err(res, 400, 'workflow not found or has no saved version');
      err(res, 500, `${String(e)}\n${(e as Error)?.stack ?? ''}`);
    }
  });

  app.post('/api/runs/:id/workflow', (req, res) => {
    const wfId = String(req.body?.workflowId ?? '');
    if (!wfId) return err(res, 400, 'workflowId required');
    const r = setRunWorkflow(req.params.id, wfId);
    if ('error' in r) return err(res, 409, r.error);
    ok(res, getRun(req.params.id));
  });
  app.post('/api/runs/:id/pause', (req, res) => { pauseRun(req.params.id, !!req.body?.hard); ok(res, getRun(req.params.id)); });
  app.post('/api/runs/:id/resume', (req, res) => { resumeRun(req.params.id); ok(res, getRun(req.params.id)); });
  app.post('/api/runs/:id/stop', (req, res) => { stopRun(req.params.id); ok(res, getRun(req.params.id)); });
  app.post('/api/runs/:id/approve-dod', (req, res) => { approveDod(req.params.id); ok(res, getRun(req.params.id)); });

  app.put('/api/runs/:id/dod', (req, res) => {
    const items = req.body?.items as DodItem[];
    if (!Array.isArray(items)) return err(res, 400, 'items array required');
    const impact = ownerEditDod(req.params.id, items);
    ok(res, { ...q1('SELECT * FROM dod WHERE run_id = ? ORDER BY rowid DESC LIMIT 1', req.params.id), impact });
  });

  app.get('/api/runs/:id/messages', (req, res) => ok(res, messagesForRun(req.params.id)));

  app.get('/api/runs/:id/project-doc', (req, res) => {
    const doc = projectDoc(req.params.id);
    if (!doc) return err(res, 404, 'run not found');
    ok(res, doc);
  });

  app.put('/api/workspaces/:id/settings', (req, res) => {
    const ws = q1('SELECT settings FROM workspaces WHERE id = ?', req.params.id);
    if (!ws) return err(res, 404, 'workspace not found');
    const mode = req.body?.promptReview;
    if (mode != null && !['off', 'pipeline', 'handoffs', 'implement', 'all'].includes(mode)) return err(res, 400, 'promptReview must be pipeline | handoffs | all | off');
    const selfReview = req.body?.selfReview;
    if (selfReview != null && typeof selfReview !== 'boolean') return err(res, 400, 'selfReview must be true or false');
    const confirmPlan = req.body?.confirmPlan;
    if (confirmPlan != null && typeof confirmPlan !== 'boolean') return err(res, 400, 'confirmPlan must be true or false');
    const routing = req.body?.routing;
    if (routing != null && !['smart', 'fixed'].includes(routing)) return err(res, 400, 'routing must be smart | fixed');
    const workMode = req.body?.workMode;
    if (workMode != null && !['direct', 'isolated'].includes(workMode)) return err(res, 400, 'workMode must be direct | isolated');
    const commitMode = req.body?.commitMode;
    if (commitMode != null && !['auto', 'approve', 'manual'].includes(commitMode)) return err(res, 400, 'commitMode must be auto | approve | manual');
    const approvalMode = req.body?.approvalMode;
    if (approvalMode != null && !['always-ask', 'ask-when-risky', 'auto'].includes(approvalMode)) return err(res, 400, 'approvalMode must be always-ask | ask-when-risky | auto');
    const settings = {
      ...parseJson<Record<string, unknown>>(ws.settings as string, {}),
      ...(mode != null ? { promptReview: mode } : {}),
      ...(selfReview != null ? { selfReview } : {}),
      ...(confirmPlan != null ? { confirmPlan } : {}),
      ...(routing != null ? { routing } : {}),
      ...(workMode != null ? { workMode } : {}),
      ...(commitMode != null ? { commitMode } : {}),
      ...(approvalMode != null ? { approvalMode } : {}),
    };
    run('UPDATE workspaces SET settings = ? WHERE id = ?', JSON.stringify(settings), req.params.id);
    emit('workspace.settings', 'owner', { workspaceId: req.params.id, promptReview: settings.promptReview, selfReview: !!settings.selfReview, confirmPlan: !!settings.confirmPlan, routing: settings.routing ?? 'smart' });
    ok(res, settings);
  });

  app.put('/api/tasks/:id', (req, res) => {
    const { mode, ...edits } = req.body ?? {};
    ownerEditTask(req.params.id, edits, mode ?? 'finish');
    ok(res, getTask(req.params.id));
  });

  app.post('/api/tasks/:id/approve', (req, res) => { ownerApproveTask(req.params.id, req.body?.reason ?? 'owner approval'); ok(res, getTask(req.params.id)); });
  app.post('/api/tasks/:id/replan', (req, res) => {
    const t = getTask(req.params.id);
    if (!t) return err(res, 404, 'not found');
    run(`UPDATE tasks SET status = 'backlog', attempts = 0 WHERE id = ?`, t.id);
    emit('task.replanned', 'owner', {}, t.runId, t.id);
    run(`UPDATE tasks SET status = 'ready' WHERE id = ?`, t.id);
    void maybeAdvanceRun(t.runId);
    ok(res, getTask(t.id));
  });

  app.post('/api/agents/:id/message', (req, res) => { messageAgent(req.params.id, String(req.body?.text ?? '')); ok(res, { sent: true }); });

  app.post('/api/agents', (req, res) => {
    const { name, avatar, role, workspace, observability, instructions } = req.body ?? {};
    if (!name) return err(res, 400, 'name required');
    const id = ulid();
    const acct = q1('SELECT id, provider_id FROM accounts WHERE enabled = 1 LIMIT 1');
    const model = acct ? q1('SELECT id FROM models WHERE provider_id = ? LIMIT 1', acct.provider_id as string) : null;
    run(`INSERT INTO agents (id, name, avatar, account_id, model_id, settings, instructions, caps, observability, status)
         VALUES (?,?,?,?,?,?,?,?,?,'idle')`,
      id, name, avatar ?? '', acct?.id ?? null, model?.id ?? null, '{}', instructions ?? '',
      JSON.stringify({ perTaskUsd: 10, perDayUsd: 50, maxTokensPerCall: 128000 }), observability ?? 'actions');
    if (workspace && role) {
      run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
           VALUES (?,?,?,?,?,1,1)`, ulid(), id, workspace, role, now());
    }
    emit('agent.hired', 'owner', { agentId: id, name });
    ok(res, getAgent(id));
  });

  app.post('/api/agents/:id/fire', (req, res) => {
    const a = getAgent(req.params.id);
    if (!a) return err(res, 404, 'agent not found');
    const warnings = workflowWarningsForAgent(a.id);          // before memberships deactivate
    run('UPDATE memberships SET active = 0 WHERE agent_id = ?', a.id);
    run(`UPDATE agents SET status = 'idle' WHERE id = ?`, a.id);
    emit('agent.fired', 'owner', { agentId: a.id, name: a.name, workflowWarnings: warnings.length });
    ok(res, { ok: true, workflowWarnings: warnings });
  });

  app.post('/api/errors/:id/wontfix', (req, res) => {
    const e = getError(req.params.id);
    if (!e) return err(res, 404, 'not found');
    run(`UPDATE error_reports SET status = 'wontfix', updated_at = ? WHERE id = ?`, now(), e.id);
    emit('error.wontfix', 'owner', { errorId: e.id }, e.runId, e.id);
    ok(res, getError(e.id));
  });

  // Create a provider (+ model + account) in one call — the "add backend" form.
  app.post('/api/providers', async (req, res) => {
    const { kind, name, baseUrl, model, apiKey, monthlyBudgetUsd, command, timeoutSec, orgId } = req.body ?? {};
    if (!kind) return err(res, 400, 'kind required');
    // id is just a slug for you to recognize the backend — derive it when blank.
    let id = String(req.body?.id ?? '').trim();
    if (!id) {
      const exe = kind === 'cli' ? String(command ?? 'claude').trim().split(/\s+/)[0].split(/[\\/]/).pop() : null;
      id = `${kind}-${(exe ?? 'backend').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
      let n = 2;
      while (q1('SELECT id FROM providers WHERE id = ?', id)) id = `${id.replace(/-\d+$/, '')}-${n++}`;
    }
    if (q1('SELECT id FROM providers WHERE id = ?', id)) return err(res, 409, `provider id "${id}" already exists — pick another`);
    run('DELETE FROM provider_tombstones WHERE id = ?', id);
    const caps = kind === 'openai-compatible'
      ? { models: model ? [model] : [], observability: 'actions', reasoningVisibility: 'none', midSessionMessages: false, suspendResume: false, webhooks: false, usageData: { perResponse: true, accountApi: false, resetTimes: 'headers' }, mcp: false, nativeSkills: false }
      : kind === 'cli'
        ? { models: [], observability: 'actions', reasoningVisibility: 'none', midSessionMessages: false, suspendResume: false, webhooks: false, usageData: { perResponse: false, accountApi: false, resetTimes: 'none' }, mcp: false, nativeSkills: false }
        : kind === 'devin'
          ? { models: [], observability: 'status-only', reasoningVisibility: 'none', midSessionMessages: true, suspendResume: false, webhooks: false, usageData: { perResponse: false, accountApi: false, resetTimes: 'none' }, mcp: false, nativeSkills: false }
          : {};
    const tier = kind === 'manual' ? 3 : kind === 'cli' || kind === 'scripted' || kind === 'devin' ? 2 : 1;
    const provKind = kind === 'manual' ? 'manual' : kind === 'openai-compatible' || kind === 'anthropic' ? 'model' : 'agent';
    run(`INSERT INTO providers (id, name, kind, adapter_id, adapter_version, adapter_hash, tier, enabled, capabilities, config)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, name ?? id, provKind, kind, '1.0.0', 'local', tier, 1,
      JSON.stringify(caps), JSON.stringify({ baseUrl: baseUrl || null, command: command || null, timeoutSec: timeoutSec || null }));
    let modelId: string | null = null;
    if (model && kind !== 'devin') {
      modelId = `${id}:${model}`;
      run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier)
           VALUES (?,?,?,128000,8192,0,0,'standard')`, modelId, id, model);
    }
    const secretRef = apiKey ? storeSecret(`${id}-key`, apiKey) : null;
    const accountId = `acct-${id}`;
    run(`INSERT INTO accounts (id, provider_id, label, secret_ref, billing, monthly_budget_usd, enabled, config)
         VALUES (?,?,?,?,'payg',?,1,?)`, accountId, id, `${name ?? id} account`, secretRef, monthlyBudgetUsd ?? null,
      JSON.stringify({ baseUrl, command, timeoutSec, orgId: orgId ? String(orgId).trim() : null }));
    emit('account.added', 'owner', { accountId, providerId: id });
    // The model list always comes from the provider itself (Devin needs its key first).
    let syncWarning: string | null = null;
    if (CATALOG_ADAPTERS.includes(kind) && (kind !== 'devin' || apiKey)) {
      try {
        await syncProviderModels(id);
        // the model picked in the form (listed live by the provider) wins
        const chosen = model ? q1('SELECT id FROM models WHERE id = ?', `${id}:${model}`) as { id: string } | undefined : undefined;
        if (chosen) modelId = chosen.id;
        else if (!modelId) {
          const first = q1('SELECT id FROM models WHERE provider_id = ? ORDER BY name LIMIT 1', id) as { id: string } | undefined;
          modelId = first?.id ?? null;
        }
      } catch (e) {
        syncWarning = String((e as Error).message ?? e);
      }
    }
    ok(res, { providerId: id, accountId, modelId, syncWarning });
  });

  app.put('/api/agents/:id', (req, res) => {
    const a = getAgent(req.params.id);
    if (!a) return err(res, 404, 'agent not found');
    const b = req.body ?? {};
    // model + account must belong to the same provider
    const accountId = b.accountId !== undefined ? b.accountId : a.accountId;
    const modelId = b.modelId !== undefined ? b.modelId : a.modelId;
    if (accountId && modelId) {
      const acct = getAccount(accountId);
      const m = q1('SELECT provider_id FROM models WHERE id = ?', modelId);
      if (!acct) return err(res, 400, `account ${accountId} not found`);
      if (m && m.provider_id !== acct.providerId) return err(res, 400, `model ${modelId} does not belong to ${acct.providerId}`);
    }
    let settings: Record<string, unknown> | null = null;
    if (b.settings != null) {
      const patch = b.settings as AgentModelSettings;
      const problems = validateModelSettings(patch);
      for (const fb of patch.fallbacks ?? []) {
        const acct = getAccount(fb.accountId);
        if (!acct) { problems.push(`fallback account ${fb.accountId} not found`); continue; }
        const m = fb.modelId ? q1('SELECT provider_id FROM models WHERE id = ?', fb.modelId) : null;
        if (fb.modelId && (!m || m.provider_id !== acct.providerId)) problems.push(`fallback model ${fb.modelId} is not offered by ${acct.providerId}`);
      }
      if (problems.length) return err(res, 400, problems.join('; '));
      // keep non-model settings (e.g. a scripted agent's script) untouched; null clears a field
      settings = { ...a.settings };
      for (const k of ['reasoningEffort', 'temperature', 'maxOutputTokens', 'contextTokens', 'fallbacks'] as const) {
        if (k in patch) { if (patch[k] == null) delete settings[k]; else settings[k] = patch[k]; }
      }
    }
    if (typeof b.name === 'string' && b.name.trim()) run('UPDATE agents SET name = ? WHERE id = ?', b.name.trim(), a.id);
    if (typeof b.avatar === 'string') run('UPDATE agents SET avatar = ? WHERE id = ?', b.avatar, a.id);
    if (b.instructions != null) run('UPDATE agents SET instructions = ? WHERE id = ?', b.instructions, a.id);
    if (b.modelId !== undefined) run('UPDATE agents SET model_id = ? WHERE id = ?', b.modelId, a.id);
    if (b.accountId !== undefined) run('UPDATE agents SET account_id = ? WHERE id = ?', b.accountId, a.id);
    if (b.caps != null) run('UPDATE agents SET caps = ? WHERE id = ?', JSON.stringify({ ...a.caps, ...b.caps }), a.id);
    if (b.observability != null && ['full', 'actions', 'status-only', 'manual'].includes(b.observability)) run('UPDATE agents SET observability = ? WHERE id = ?', b.observability, a.id);
    if (settings) run('UPDATE agents SET settings = ? WHERE id = ?', JSON.stringify(settings), a.id);
    const next = getAgent(a.id)!;
    emit('agent.updated', 'owner', {
      agentId: a.id, name: a.name, accountId: next.accountId, modelId: next.modelId,
      model: modelSettings(next.settings), changed: Object.keys(b),
    });
    const warnings = workflowWarningsForAgent(a.id);
    ok(res, { ...next, workflowWarnings: warnings });
  });

  app.get('/api/providers/:id/catalog', async (req, res) => {
    const p = getProvider(req.params.id);
    if (!p) return err(res, 404, 'provider not found');
    if (!CATALOG_ADAPTERS.includes(p.adapterId)) return err(res, 400, `${p.adapterId} backends have no model list to fetch`);
    try {
      ok(res, { models: await fetchProviderCatalog(p.id) });
    } catch (e) {
      err(res, 502, String((e as Error).message ?? e));
    }
  });

  // Known CLIs plus which of them are actually installed on this machine.
  app.get('/api/cli-presets', (_req, res) => {
    const found = new Map(detectInstalledClis().map((d) => [d.id, d.path]));
    ok(res, Object.values(CLI_PRESETS).map(({ id, label, command }) => ({
      id, label, command, installed: found.has(id), path: found.get(id) ?? null,
    })));
  });

  // Live model list for a backend that isn't saved yet (the "add backend" form).
  app.post('/api/providers/catalog-preview', async (req, res) => {
    const { kind, apiKey, command, baseUrl, orgId } = req.body ?? {};
    if (!CATALOG_ADAPTERS.includes(kind)) return err(res, 400, `kind must be one of ${CATALOG_ADAPTERS.join(', ')}`);
    try {
      ok(res, { models: await fetchCatalog(kind, {
        apiKey: String(apiKey ?? '').trim() || null,
        baseUrl: String(baseUrl ?? '').trim() || DEFAULT_BASE_URL[kind] || '',
        command: String(command ?? ''),
        orgId: String(orgId ?? '').trim() || null,
      }) });
    } catch (e) {
      err(res, 502, String((e as Error).message ?? e));
    }
  });

  app.post('/api/providers/:id/sync-models', async (req, res) => {
    const p = getProvider(req.params.id);
    if (!p) return err(res, 404, 'provider not found');
    if (!CATALOG_ADAPTERS.includes(p.adapterId)) return err(res, 400, `${p.adapterId} backends have no model list to sync`);
    try {
      ok(res, await syncProviderModels(p.id));
    } catch (e) {
      err(res, 502, String((e as Error).message ?? e));
    }
  });

  // Routing tier (and prices) of a model; an owner-set tier survives catalog syncs.
  app.put('/api/models/:id', (req, res) => {
    const m = q1('SELECT * FROM models WHERE id = ?', req.params.id);
    if (!m) return err(res, 404, 'model not found');
    const { strengthTier, priceIn, priceOut } = req.body ?? {};
    if (strengthTier != null && !['fast', 'standard', 'strong'].includes(strengthTier)) return err(res, 400, 'strengthTier must be fast | standard | strong');
    for (const [k, v] of [['priceIn', priceIn], ['priceOut', priceOut]] as const) {
      if (v != null && !(Number(v) >= 0)) return err(res, 400, `${k} must be a number ≥ 0`);
    }
    if (strengthTier != null) {
      const supports = { ...parseJson<Record<string, unknown>>(m.supports as string, {}), tierSet: true };
      run('UPDATE models SET strength_tier = ?, supports = ? WHERE id = ?', strengthTier, JSON.stringify(supports), m.id);
    }
    if (priceIn != null) run('UPDATE models SET price_in = ? WHERE id = ?', Number(priceIn), m.id);
    if (priceOut != null) run('UPDATE models SET price_out = ? WHERE id = ?', Number(priceOut), m.id);
    emit('model.updated', 'owner', { modelId: m.id, strengthTier: strengthTier ?? null });
    ok(res, q1('SELECT * FROM models WHERE id = ?', m.id));
  });

  // The router's recent model choices, newest first.
  app.get('/api/routing/decisions', (_req, res) => {
    ok(res, q(`SELECT seq, run_id, ts, entity_id, payload FROM events WHERE type = 'model.routed' ORDER BY seq DESC LIMIT 40`)
      .map((e) => ({ seq: e.seq, runId: e.run_id, ts: e.ts, workItemId: e.entity_id, ...parseJson<Record<string, unknown>>(e.payload as string, {}) })));
  });

  // Register another model on an existing provider so agents can pick it.
  app.post('/api/providers/:id/models', (req, res) => {
    const p = getProvider(req.params.id);
    if (!p) return err(res, 404, 'provider not found');
    const { name, contextTokens, maxOutputTokens, priceIn, priceOut, strengthTier, displayName } = req.body ?? {};
    if (!name || typeof name !== 'string') return err(res, 400, 'model name required');
    const trimmed = name.trim();
    const id = `${p.id}:${trimmed}`;
    if (q1('SELECT id FROM models WHERE id = ?', id)) return err(res, 409, `${name} is already registered on ${p.id}`);
    const supports = p.adapterId === 'devin'
      ? JSON.stringify({ displayName: String(displayName ?? trimmed).trim(), devinUid: trimmed })
      : p.adapterId === 'cli'
        ? JSON.stringify({ displayName: String(displayName ?? trimmed).trim(), cliUid: trimmed })
        : JSON.stringify({ displayName: String(displayName ?? trimmed).trim(), providerUid: trimmed });
    run(`INSERT INTO models (id, provider_id, name, context_tokens, max_output_tokens, price_in, price_out, strength_tier, supports) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, p.id, trimmed, Number(contextTokens) || 128000, Number(maxOutputTokens) || 8192, Number(priceIn) || 0, Number(priceOut) || 0,
      ['fast', 'standard', 'strong'].includes(strengthTier) ? strengthTier : 'standard', supports);
    const caps = p.capabilities as unknown as Record<string, unknown>;
    const names = Array.isArray(caps.models) ? (caps.models as unknown[]).map(String) : [];
    if (!names.includes(name.trim())) run('UPDATE providers SET capabilities = ? WHERE id = ?', JSON.stringify({ ...caps, models: [...names, name.trim()] }), p.id);
    emit('model.added', 'owner', { providerId: p.id, modelId: id });
    ok(res, { id });
  });

  app.put('/api/providers/:id', (req, res) => {
    const p = getProvider(req.params.id);
    if (!p) return err(res, 404, 'provider not found');
    if (req.body?.enabled != null) run('UPDATE providers SET enabled = ? WHERE id = ?', req.body.enabled ? 1 : 0, p.id);
    if (req.body?.orgId != null && p.adapterId === 'devin') {
      const acct = q1('SELECT id, config FROM accounts WHERE provider_id = ? LIMIT 1', p.id) as { id: string; config: string } | undefined;
      if (acct) {
        const cfg = parseJson(acct.config, {}) as Record<string, unknown>;
        cfg.orgId = String(req.body.orgId).trim() || null;
        run('UPDATE accounts SET config = ? WHERE id = ?', JSON.stringify(cfg), acct.id);
      }
    }
    emit('provider.updated', 'owner', { providerId: p.id, enabled: !!req.body?.enabled });
    ok(res, getProvider(p.id));
  });

  // Remove a provider (spec 3): its accounts, stored credentials, models,
  // quota and circuit state go; history (usage, work items, events) stays.
  // Agents that used it lose that backend and keep everything else.
  app.delete('/api/providers/:id', (req, res) => {
    const p = getProvider(req.params.id);
    if (!p) return err(res, 404, 'provider not found');
    const accounts = q('SELECT * FROM accounts WHERE provider_id = ?', p.id);
    const accountIds = accounts.map((a) => a.id as string);
    const inFlight = accountIds.length
      ? (q1(`SELECT COUNT(*) c FROM work_items WHERE status IN ('queued','running','waiting') AND account_id IN (${accountIds.map(() => '?').join(',')})`, ...accountIds)?.c as number)
      : 0;
    if (inFlight && !req.query.force) return err(res, 409, `${inFlight} work item(s) are running on this provider — pause the run or wait, then remove it`);
    ok(res, removeAccounts(accountIds, p.id, true));
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const a = getAccount(req.params.id);
    if (!a) return err(res, 404, 'account not found');
    const inFlight = q1(`SELECT COUNT(*) c FROM work_items WHERE status IN ('queued','running','waiting') AND account_id = ?`, a.id)?.c as number;
    if (inFlight && !req.query.force) return err(res, 409, `${inFlight} work item(s) are running on this account`);
    ok(res, removeAccounts([a.id], a.providerId, false));
  });

  // Move an agent between workspaces/roles (spec 6.6) — the "diff preview" is
  // computed client-side from the request; this applies it.
  app.post('/api/agents/:id/move', (req, res) => {
    const { workspaceId, roleId, inFlightChoice } = req.body ?? {};
    const a = getAgent(req.params.id);
    if (!a) return err(res, 404, 'agent not found');
    const warnings = workflowWarningsForAgent(a.id);          // the role it is leaving
    const existing = q1('SELECT * FROM memberships WHERE agent_id = ? AND workspace_id = ? AND active = 1', a.id, workspaceId);
    if (existing) {
      run('UPDATE memberships SET role_id = ? WHERE id = ?', roleId, existing.id);
    } else {
      run(`INSERT INTO memberships (id, agent_id, workspace_id, role_id, active_since, max_concurrent_tasks, active)
           VALUES (?,?,?,?,?,1,1)`, ulid(), a.id, workspaceId, roleId, now());
    }
    const inFlightTasks = q(`SELECT id FROM tasks WHERE owner_agent_id = ? AND status IN ('assigned','in-progress','verifying','in-review','changes-requested')`, a.id);
    if (inFlightTasks.length && inFlightChoice === 'abort') {
      for (const t of inFlightTasks) ownerEditTask(t.id as string, { status: undefined }, 'abort');
    }
    emit('membership.changed', 'owner', { agentId: a.id, workspaceId, roleId, inFlight: inFlightTasks.length, workflowWarnings: warnings.length });
    ok(res, { ok: true, workflowWarnings: warnings });
  });

  app.delete('/api/memberships/:id', (req, res) => {
    const m = q1('SELECT agent_id FROM memberships WHERE id = ?', req.params.id);
    const warnings = m ? workflowWarningsForAgent(m.agent_id as string) : [];
    run('UPDATE memberships SET active = 0 WHERE id = ?', req.params.id);
    emit('membership.removed', 'owner', { membershipId: req.params.id });
    ok(res, { ok: true, workflowWarnings: warnings });
  });

  // ---------- skills ----------
  app.post('/api/skills/import', (req, res) => {
    try {
      const dir = path.resolve(String(req.body?.path ?? ''));
      if (!fs.existsSync(dir)) return err(res, 400, `folder not found: ${dir}`);
      if (hasSkillMd(dir)) return ok(res, { imported: [importSkillDir(dir)], errors: [] });
      // no SKILL.md at the root — treat it as a folder OF skills and import each
      const dirs = findSkillDirs(dir);
      if (!dirs.length) return err(res, 400, `no SKILL.md found under ${dir} — point at a skill folder or a folder containing skill folders`);
      const imported: ReturnType<typeof importSkillDir>[] = [];
      const errors: string[] = [];
      for (const d of dirs) {
        try { imported.push(importSkillDir(d)); }
        catch (e) { errors.push(`${path.basename(d)}: ${String((e as Error).message ?? e)}`); }
      }
      ok(res, { imported, errors });
    } catch (e) { err(res, 500, String(e)); }
  });

  // find the stored-before-content skill versions again (by exact hash)
  app.post('/api/skills/relink', (req, res) => {
    const extra = req.body?.path ? [path.resolve(String(req.body.path))] : [];
    ok(res, relinkSkillContent(extra));
  });

  app.post('/api/skills', (req, res) => {
    try { ok(res, createSkill(req.body ?? {})); } catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });
  app.put('/api/skills/:id', (req, res) => {
    try { ok(res, updateSkill(req.params.id, req.body ?? {})); } catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });
  app.post('/api/skills/:id/duplicate', (req, res) => {
    try { ok(res, duplicateSkill(req.params.id, req.body?.name)); } catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });
  app.post('/api/skills/:id/enabled', (req, res) => {
    run('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?', req.body?.enabled ? 1 : 0, now(), req.params.id);
    emit('skill.enabled', 'owner', { skillId: req.params.id, enabled: !!req.body?.enabled });
    ok(res, { ok: true });
  });
  app.delete('/api/skills/:id', (req, res) => { removeSkill(req.params.id); ok(res, { ok: true }); });

  app.post('/api/skill-versions/:id/review', (req, res) => {
    const { approve, notes } = req.body ?? {};
    run('UPDATE skill_versions SET review_status = ?, review_notes = ?, reviewed_at = ? WHERE id = ?',
      approve ? 'approved' : 'rejected', notes ?? '', now(), req.params.id);
    emit('skill.reviewed', 'owner', { versionId: req.params.id, approved: !!approve });
    ok(res, q1('SELECT * FROM skill_versions WHERE id = ?', req.params.id));
  });

  // attach a skill (latest approved version, or a pinned one) to a role or agent
  app.post('/api/skill-versions/:id/attach', (req, res) => {
    try { ok(res, attachSkill({ versionId: req.params.id, roleId: req.body?.roleId, agentId: req.body?.agentId, pinned: !!req.body?.pinned })); }
    catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });
  app.post('/api/skills/:id/attach', (req, res) => {
    try { ok(res, attachSkill({ skillId: req.params.id, roleId: req.body?.roleId, agentId: req.body?.agentId, pinned: !!req.body?.pinned })); }
    catch (e) { err(res, 400, String((e as Error).message ?? e)); }
  });
  app.delete('/api/skill-attachments/:id', (req, res) => { detachSkill(req.params.id); ok(res, { ok: true }); });

  // what an agent would receive for a kind of work — the actual prompt section
  app.get('/api/agents/:id/skills-preview', (req, res) => {
    const role = q1('SELECT role_id FROM memberships WHERE agent_id = ? AND active = 1 LIMIT 1', req.params.id);
    ok(res, skillsFor({ agentId: req.params.id, roleId: (req.query.roleId as string) ?? (role?.role_id as string) ?? null, kind: (String(req.query.kind ?? 'implement')) as never, taskText: String(req.query.text ?? '') }));
  });

  // preview a draft node's skill resolution (editor budget meter / greyed list)
  app.post('/api/skills/node-preview', (req, res) => {
    const b = req.body ?? {};
    ok(res, skillsFor({
      agentId: String(b.agentId ?? ''), roleId: (b.roleId as string) ?? null,
      kind: (String(b.kind ?? 'implement')) as never, taskText: String(b.taskText ?? ''),
      nodeSkills: Array.isArray(b.skills) ? b.skills : [],
      inheritSkills: b.inheritSkills !== false,
    }));
  });

  // ---------- accounts ----------
  app.post('/api/accounts', (req, res) => {
    const { providerId, label, apiKey, billing, monthlyBudgetUsd, baseUrl, command, timeoutSec } = req.body ?? {};
    const p = q1('SELECT * FROM providers WHERE id = ?', providerId);
    if (!p) return err(res, 404, 'provider not found');
    const secretRef = apiKey ? storeSecret(`${providerId}-${label ?? 'key'}`, apiKey) : null;
    const id = ulid();
    const pc = p.config ? (parseJson(p.config as string, {}) as Record<string, unknown>) : {};
    run(`INSERT INTO accounts (id, provider_id, label, secret_ref, billing, monthly_budget_usd, config)
         VALUES (?,?,?,?,?,?,?)`, id, providerId, label ?? providerId, secretRef, billing ?? 'payg', monthlyBudgetUsd ?? null,
      JSON.stringify({ baseUrl: baseUrl || pc.baseUrl || null, command: command || pc.command || null, timeoutSec: timeoutSec ?? pc.timeoutSec ?? null }));
    emit('account.added', 'owner', { accountId: id, providerId });
    ok(res, { id });
  });

  app.post('/api/workspaces/:id/allowed-providers', (req, res) => {
    run('UPDATE workspaces SET allowed_provider_ids = ? WHERE id = ?', JSON.stringify(req.body?.providerIds ?? []), req.params.id);
    emit('workspace.policy', 'owner', { workspaceId: req.params.id });
    ok(res, { ok: true });
  });

  app.post('/api/runs/:id/nudge', (req, res) => { void maybeAdvanceRun(req.params.id); ok(res, { ok: true }); });

  // static UI
  const uiPath = path.resolve(process.cwd(), uiDir);
  if (fs.existsSync(uiPath)) {
    app.use(express.static(uiPath));
    app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(uiPath, 'index.html')));
  }

  server.listen(port, '127.0.0.1', () => console.log(`[office] daemon + UI on http://localhost:${port}`));
  return server;
}

// Deletes accounts (and, with dropProvider, the provider itself). Credentials
// are deleted only when no remaining account still uses the same secret ref.
// None of the supported providers offer key revocation through their API, so
// the result says so plainly instead of claiming a remote revoke happened.
function removeAccounts(accountIds: string[], providerId: string, dropProvider: boolean) {
  const accounts = accountIds.map((id) => getAccount(id)).filter(Boolean) as NonNullable<ReturnType<typeof getAccount>>[];
  const modelIds = dropProvider ? q('SELECT id FROM models WHERE provider_id = ?', providerId).map((m) => m.id as string) : [];
  let secretsDeleted = 0;
  const envRefs: string[] = [];
  const affectedAgents: string[] = [];
  tx(() => {
    for (const a of accounts) {
      run('DELETE FROM accounts WHERE id = ?', a.id);
      run('DELETE FROM quota_windows WHERE account_id = ?', a.id);
      run('DELETE FROM circuits WHERE account_id = ?', a.id);
      if (a.secretRef?.startsWith('env:')) envRefs.push(a.secretRef.slice(4));
    }
    for (const row of q('SELECT * FROM agents')) {
      const ag = rowToAgent(row);
      const usesPrimary = ag.accountId && accountIds.includes(ag.accountId);
      const fbs = modelSettings(ag.settings).fallbacks ?? [];
      const keep = fbs.filter((f) => !accountIds.includes(f.accountId) && !(f.modelId && modelIds.includes(f.modelId)));
      if (!usesPrimary && keep.length === fbs.length) continue;
      affectedAgents.push(ag.name);
      // promote the first remaining fallback so the agent keeps working
      const promoted = usesPrimary ? keep.shift() : undefined;
      run('UPDATE agents SET account_id = ?, model_id = ?, settings = ? WHERE id = ?',
        usesPrimary ? (promoted?.accountId ?? null) : ag.accountId,
        usesPrimary ? (promoted?.modelId ?? null) : ag.modelId,
        JSON.stringify({ ...ag.settings, fallbacks: keep }), ag.id);
    }
    if (dropProvider) {
      run('DELETE FROM models WHERE provider_id = ?', providerId);
      run('DELETE FROM providers WHERE id = ?', providerId);
      run('INSERT OR REPLACE INTO provider_tombstones (id, removed_at) VALUES (?,?)', providerId, now());
      const wsRows = q('SELECT id, allowed_provider_ids FROM workspaces');
      for (const w of wsRows) {
        const ids = parseJson<string[]>(w.allowed_provider_ids as string, []);
        if (ids.includes(providerId)) run('UPDATE workspaces SET allowed_provider_ids = ? WHERE id = ?', JSON.stringify(ids.filter((x) => x !== providerId)), w.id);
      }
    }
  });
  for (const a of accounts) {
    const stillUsed = a.secretRef && q1('SELECT id FROM accounts WHERE secret_ref = ?', a.secretRef);
    if (a.secretRef && !stillUsed && deleteSecret(a.secretRef)) secretsDeleted++;
  }
  const result = {
    providerId, removedProvider: dropProvider, accountsRemoved: accounts.length, secretsDeleted,
    envVarsToRemove: envRefs, affectedAgents,
    remoteRevocation: accounts.some((a) => a.secretRef)
      ? 'not supported by this provider\'s API — revoke the key in the provider\'s console if it may have been exposed'
      : 'no credentials were stored',
    kept: 'usage records, work items, prompts and the event log',
  };
  emit(dropProvider ? 'provider.removed' : 'account.removed', 'owner', result);
  return result;
}

// moved to services/skills.ts; re-exported for existing importers
export { scanSkillFile };
