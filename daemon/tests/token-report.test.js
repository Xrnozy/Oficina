// Token report: per-kind aggregation of prompt size and reported usage for a
// run — several usage rows or prompt versions on one work item must not
// multiply each other through the join.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tokens-'));
const { q1, run } = await import('../src/db.ts');
const { tokenReport } = await import('../src/services/usage.ts');

const RUN = 'run-1';
const wi = (id, kind, taskId = 'task-1', status = 'delivered') => {
  run(`INSERT INTO work_items (id, task_id, run_id, kind, agent_id, account_id, model_id, prompt_version_id, idempotency_key, status, started_at, attempt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`, id, taskId, RUN, kind, 'ag-1', 'acct-1', 'm-1', `pv-${id}`, `${id}-key`, status, '2026-10-19T10:00:00Z');
};
const pv = (id, workItemId, text) =>
  run(`INSERT INTO prompt_versions (id, work_item_id, template_id, version, rendered_text, created_at)
       VALUES (?,?,?,1,?,?)`, id, workItemId, `${workItemId}/tpl`, text, '2026-10-19T10:00:00Z');
const usage = (workItemId, inT, outT, cost = 0) =>
  run(`INSERT INTO usage_records (id, account_id, model_id, work_item_id, ts, input_tokens, output_tokens, cost_usd, cost_source)
       VALUES (?,?,?,?,?,?,?,?,?)`, `u-${workItemId}-${Math.random()}`, 'acct-1', 'm-1', workItemId, '2026-10-19T10:00:00Z', inT, outT, cost, 'estimate');

test('per-kind aggregation: calls, prompt chars, reported tokens, average', () => {
  wi('wi-plan', 'plan'); pv('pv-plan', 'wi-plan', 'x'.repeat(1000)); usage('wi-plan', 400, 100, 0.02);
  wi('wi-impl-1', 'implement'); pv('pv-i1', 'wi-impl-1', 'x'.repeat(4000)); usage('wi-impl-1', 1500, 500, 0.10);
  wi('wi-impl-2', 'implement'); pv('pv-i2', 'wi-impl-2', 'x'.repeat(2000)); usage('wi-impl-2', 700, 300, 0.05);
  wi('wi-review', 'review'); pv('pv-r', 'wi-review', 'x'.repeat(1500)); usage('wi-review', 800, 50, 0.02);

  const rep = tokenReport(RUN);
  const impl = rep.byKind.find((r) => r.kind === 'implement');
  assert.equal(impl.calls, 2);
  assert.equal(impl.promptChars, 6000);
  assert.equal(impl.reportedTokens, 3000);
  assert.equal(impl.avgTokensPerCall, 1500);
  assert.ok(Math.abs(impl.costUsd - 0.15) < 1e-9);
  // most prompt volume first
  assert.equal(rep.byKind[0].kind, 'implement');
});

test('a second usage row or prompt version on one work item adds, not multiplies', () => {
  wi('wi-fix', 'fix');
  pv('pv-fix-a', 'wi-fix', 'x'.repeat(100));
  pv('pv-fix-b', 'wi-fix', 'x'.repeat(300));           // revised draft
  usage('wi-fix', 100, 10, 0.01);
  usage('wi-fix', 200, 20, 0.01);                       // retry after fallback
  const rep = tokenReport(RUN);
  const fix = rep.byKind.find((r) => r.kind === 'fix');
  assert.equal(fix.calls, 1);
  assert.equal(fix.promptChars, 400);
  assert.equal(fix.reportedTokens, 330);
});

test('top 5 most expensive work items, cancelled excluded', () => {
  for (let i = 0; i < 7; i++) { wi(`wi-extra-${i}`, 'qa'); pv(`pv-e${i}`, `wi-extra-${i}`, 'x'.repeat(10 * (i + 1))); usage(`wi-extra-${i}`, i * 100, 0, 0); }
  wi('wi-cancelled', 'dev', 'task-1', 'cancelled'); usage('wi-cancelled', 99999, 0, 0);
  const rep = tokenReport(RUN);
  assert.equal(rep.top.length, 5);
  for (let i = 1; i < rep.top.length; i++) assert.ok(rep.top[i - 1].reportedTokens >= rep.top[i].reportedTokens);
  assert.equal(rep.byKind.find((r) => r.kind === 'dev'), undefined);
  assert.ok(rep.byKind.every((r) => r.calls >= 0));
});
