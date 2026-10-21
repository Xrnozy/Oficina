// Reasoning effort for CLI agents: Claude Code takes it as --effort; other CLIs have no such flag.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withEffort, CLI_PRESETS } from '../src/adapters/cli-resolve.ts';
import { settingsSupport, validateModelSettings } from '../src/services/models.ts';

const claude = CLI_PRESETS.claude.command;

test('Claude Code gets --effort for low..max; auto, off and default add nothing', () => {
  for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(withEffort('claude -p', claude, e), `claude -p --effort ${e}`);
  for (const e of ['auto', 'off', undefined, null, '']) assert.equal(withEffort('claude -p', claude, e), 'claude -p');
});

test('other CLIs ignore the effort, and a template that sets its own --effort keeps it', () => {
  assert.equal(withEffort('agent -p', 'agent -p --force', 'high'), 'agent -p');
  assert.equal(withEffort('devin -p', 'devin -p', 'high'), 'devin -p');
  assert.equal(withEffort('claude -p --effort low', 'claude -p --effort low', 'max'), 'claude -p --effort low');
});

test('xhigh and max are accepted settings, and CLI backends now allow effort and max output', () => {
  assert.deepEqual(validateModelSettings({ reasoningEffort: 'xhigh' }), []);
  assert.deepEqual(validateModelSettings({ reasoningEffort: 'max' }), []);
  assert.equal(validateModelSettings({ reasoningEffort: 'huge' }).length, 1);
  const s = settingsSupport('cli');
  assert.equal(s.reasoningEffort, 'model');
  assert.equal(s.maxOutputTokens, 'model');
  assert.equal(s.temperature, 'no');
});
