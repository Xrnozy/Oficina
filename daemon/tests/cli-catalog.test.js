import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentListModels, parseClaudeModelSlash } from '../src/services/cli-catalog.ts';

test('parseAgentListModels reads cursor agent --list-models output', () => {
  const text = `Available models

auto - Auto (current, default)
gpt-5.2 - GPT-5.2
composer-2.5 - Composer 2.5

Tip: use --model <id>`;
  const models = parseAgentListModels(text);
  assert.equal(models.length, 3);
  assert.deepEqual(models[0], { uid: 'auto', name: 'Auto (current, default)' });
});

test('parseClaudeModelSlash reads /model Available line', () => {
  const text = `Current model: Opus 5.5
Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, default, or a full model ID.`;
  const models = parseClaudeModelSlash(text);
  assert.ok(models.some((m) => m.uid === 'sonnet'));
  assert.ok(models.some((m) => m.uid === 'opus'));
});
