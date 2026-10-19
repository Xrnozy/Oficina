import fs from 'node:fs';
import path from 'node:path';
import { writeFileEnsured } from '../util.ts';
import type { Adapter, AdapterCtx } from './types.ts';
import type { WorkItemResult } from '../types.ts';

// The scripted adapter is the Office's "fake provider" (spec section 11):
// deterministic, costs nothing, and drives the full loop end-to-end for
// demos and gate tests. Its behaviour lives in agent.settings.script:
//
//   plan:      { dodItems: [...], tasks: [{key,title,..., meta:{files:{...}}}] }
//   implement: writes task.meta.files (or meta.buggyFiles on attempt 1 when
//              meta.failFirst) + HANDOFF.md into the worktree
//   fix:       writes task.meta.fixFiles / meta.files
//   review:    { decision: 'approve' | 'request-changes', notes }
//   analyse:   canned analysis fields

interface ScriptFileMap { [p: string]: string }

function writeFiles(worktree: string, files: ScriptFileMap): string[] {
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(worktree, rel);
    writeFileEnsured(p, content);
    written.push(rel);
  }
  return written;
}

const qaFailedOnce = new Set<string>(); // task ids whose first scripted QA run failed

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Content of a <LABEL> data block in a rendered prompt.
function block(prompt: string, label: string): string {
  const m = prompt.match(new RegExp(`<${label}>\\n([\\s\\S]*?)\\n</${label}>`));
  return m ? m[1] : '';
}

export const scriptedAdapter: Adapter = {
  id: 'scripted',
  version: '1.0.0',

  async dispatch(ctx: AdapterCtx): Promise<WorkItemResult> {
    const script = (ctx.agent.settings?.script ?? {}) as Record<string, any>;
    const kind = ctx.workItem.kind;
    const result = await scriptedResult(ctx, script, kind);
    // script.messages[kind]: messages this agent sends to teammates on that kind of work
    const msgs = script.messages?.[kind];
    if (Array.isArray(msgs) && msgs.length) result.raw = { ...(result.raw as object ?? {}), messages: msgs };
    return result;
  },

  async sendMessage() { /* scripted agents ignore mid-session messages */ },
};

async function scriptedResult(ctx: AdapterCtx, script: Record<string, any>, kind: string): Promise<WorkItemResult> {
  await delay(script.latencyMs ?? 400);
  ctx.emit('agent.output', { line: `[scripted] ${ctx.agent.name} starting ${kind}` });

  switch (kind) {
    case 'plan': {
      const plan = script.plan ?? { dodItems: [], tasks: [] };
      return {
        summary: `Scripted plan: ${(plan.tasks ?? []).length} tasks, ${(plan.dodItems ?? []).length} DoD items`,
        raw: { dodItems: plan.dodItems ?? [], planDiff: { add: plan.tasks ?? [], notes: plan.notes } },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    case 'implement':
    case 'test':
    case 'doc':
    case 'fix': {
      if (!ctx.worktree || !ctx.task) throw new Error('scripted implement requires worktree+task');
      const meta = (ctx.task.meta ?? {}) as Record<string, any>;
      const attempt = ctx.workItem.attempt;
      let files: ScriptFileMap = {};
      if (kind === 'fix') {
        files = (meta.fixFiles as ScriptFileMap) ?? (meta.files as ScriptFileMap) ?? {};
      } else if (meta.failFirst && attempt <= 1 && meta.buggyFiles) {
        files = meta.buggyFiles as ScriptFileMap;
        ctx.emit('agent.output', { line: '[scripted] delivering intentionally buggy first cut' });
      } else {
        files = (meta.files as ScriptFileMap) ?? {};
      }
      const changed = writeFiles(ctx.worktree, files);
      // change notes go where the prompt says (outside the tracked tree in direct mode)
      const notesPath = ctx.prompt.match(/change notes to (\S+?\.md)/)?.[1] ?? 'HANDOFF.md';
      const handoff = [
        `Commit: ${kind === 'fix' ? 'fix' : 'feat'}: ${ctx.task.title.charAt(0).toLowerCase()}${ctx.task.title.slice(1)}`, ``,
        `# HANDOFF`, ``, `Task: ${ctx.task.title}`, `Kind: ${kind} (attempt ${attempt})`, ``,
        `## Done`, ...changed.map((f) => `- wrote ${f}`), ``,
        `## Remaining`, `- none known`, ``,
      ].join('\n');
      writeFileEnsured(path.join(ctx.worktree, notesPath), handoff);
      if (notesPath === 'HANDOFF.md') changed.push('HANDOFF.md');
      await delay(script.stepLatencyMs ?? 150);
      ctx.emit('agent.output', { line: `[scripted] wrote ${changed.length} files` });
      return {
        summary: `Wrote ${changed.length} file(s): ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? '…' : ''}`,
        filesChanged: changed,
        raw: { wroteFiles: changed },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    case 'review': {
      const review = script.review ?? { decision: 'approve' };
      const rejectFirst = review.rejectOnce && ctx.workItem.attempt <= 1;
      return {
        summary: rejectFirst ? 'Requested changes (scripted)' : `Review ${review.decision ?? 'approve'} (scripted)`,
        raw: {
          decision: rejectFirst ? 'request-changes' : (review.decision ?? 'approve'),
          notes: review.notes ?? (rejectFirst ? 'Please address the inline comments.' : 'LGTM: matches acceptance criteria.'),
        },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    case 'analyse': {
      const failures = (ctx.workItem as any).analysisInput?.failures ?? [];
      const first = failures[0];
      return {
        summary: 'Scripted analysis',
        raw: {
          title: first?.name ? `Failing: ${first.name}` : 'Check failure',
          suspectedCause: { summary: first?.message ?? 'See log excerpt.', confidence: 'medium' },
          reproduction: { steps: ['Run the failing check command in the task worktree.'] },
          suggestedFix: { approach: 'Apply the fixFiles for this task (scripted fix).', difficulty: 1, suggestedRole: 'developer' },
        },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    // Prompt Creator: wraps the engine's base prompt. With omitCriteriaFirst the
    // first draft leaves out the acceptance criteria, so the PM's review has
    // something real to catch and the revise loop is exercised.
    // Prompt Creator: writes a short brief (the engine attaches task, criteria,
    // context and contract). With omitCriteriaFirst the first brief leaves out
    // how to verify the work, so the PM's review has something real to catch.
    case 'prompt': {
      const revising = !!block(ctx.prompt, 'REVISION_NOTES');
      const findings = block(ctx.prompt, 'CHECK_RESULTS');
      const target = block(ctx.prompt, 'TARGET').split(' — ')[0] || 'the agent';
      const lines = [`Objective: ${ctx.task?.title ?? 'the task'} (for ${target}).`, 'Scope: only what the task describes; leave unrelated files alone.'];
      if (findings) lines.push(`Correct exactly this: ${findings.split('\n')[0]}`);
      if (!(script.omitCriteriaFirst && !revising)) lines.push('Verification: run the checks and confirm every acceptance criterion.');
      return {
        summary: revising ? 'Revised the brief per PM notes (scripted)' : 'Drafted the brief (scripted)',
        raw: { brief: lines.join('\n'), rationale: revising ? 'Added how to verify, as the PM asked.' : 'Short brief for the target agent.' },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    // PM prompt review: a deterministic completeness check — every acceptance
    // criterion and the output contract must be in the draft.
    // PM brief review: a deterministic check — the brief must say how the
    // work is verified (criteria and contract are attached by the engine).
    case 'prompt-review': {
      const draft = block(ctx.prompt, 'PROMPT_UNDER_REVIEW');
      const complete = /verification:/i.test(draft) || draft.includes('OUTPUT CONTRACT');
      const contract = true;
      const approve = complete;
      const notes = approve ? '' : 'The brief does not say how the work will be verified.';
      return {
        summary: approve ? 'Prompt approved (scripted)' : 'Prompt sent back for revision (scripted)',
        raw: { decision: approve ? 'approve' : 'revise', notes, checklist: { correct: true, complete, clear: contract, aligned: true } },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    // QA tester: the engine's checks already passed, so the scripted tester
    // agrees — unless script.qaFailFirst, which fails each task's first test
    // run so the report → PM → fix loop is exercised.
    case 'qa':
      if (script.qaFailFirst && ctx.task && !qaFailedOnce.has(ctx.task.id)) {
        qaFailedOnce.add(ctx.task.id);
        return {
          summary: 'QA fail (scripted)',
          raw: { decision: 'fail', summary: 'Edge case fails: an empty line throws.', findings: [{ severity: 'high', kind: 'error', message: 'convert("") throws', evidence: 'TypeError at convert.js:4' }] },
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
        };
      }
      return {
        summary: 'QA pass (scripted)',
        raw: { decision: 'pass', summary: 'Ran the test suite: all green, no regressions found.', findings: [] },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };

    // PM diagnosis (stage 4): script.diagnose picks the strategy; the default
    // escalates to the human, which is the safe scripted choice.
    case 'diagnose': {
      const d = script.diagnose ?? {};
      return {
        summary: `Diagnosis (scripted): ${d.strategy ?? 'human'}`,
        raw: { diagnosis: d.diagnosis ?? 'Scripted adapter cannot fail for a real reason; escalating.', strategy: d.strategy ?? 'human', splits: d.splits, notes: d.notes },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    // PM acceptance: accepts what QA passed, sends back what it failed.
    case 'accept': {
      const report = block(ctx.prompt, 'QA_REPORT');
      const failed = report.startsWith('QA FAILED');
      return {
        summary: failed ? 'Sent back for rework (scripted)' : 'Accepted (scripted)',
        raw: failed
          ? { decision: 'rework', notes: 'QA found problems that block acceptance.', prompt: `Resolve every QA finding below, then re-validate against the acceptance criteria.\n${report}` }
          : { decision: 'accept', notes: 'QA passed and the change notes cover the request.' },
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, costSource: 'estimate' },
      };
    }

    default:
      return { summary: `scripted ${kind} noop`, usage: { costUsd: 0, costSource: 'estimate' } };
  }
}
