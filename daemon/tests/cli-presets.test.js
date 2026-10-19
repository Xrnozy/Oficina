import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLI_PRESETS, buildCliCommand, cliPresetOf, effectiveCliCommand,
} from '../src/adapters/cli-resolve.ts';
import { fetchCliCatalog, listCommandsFor, parseDevinModelsJson } from '../src/services/cli-catalog.ts';

// ---- preset detection, defaults and listing commands -------------------------

test('each preset command is recognised as its own preset', () => {
  for (const p of Object.values(CLI_PRESETS)) assert.equal(cliPresetOf(p.command)?.id, p.id);
  assert.equal(cliPresetOf('cursor-agent -p')?.id, 'cursor');
  assert.equal(cliPresetOf('"C:\\Users\\me\\AppData\\Local\\devin\\cli\\bin\\devin.exe" -p')?.id, 'devin');
  assert.equal(cliPresetOf('aider --yes'), null);
});

test('an empty command means the Claude Code preset', () => {
  assert.equal(effectiveCliCommand(''), CLI_PRESETS.claude.command);
  assert.equal(effectiveCliCommand('  '), CLI_PRESETS.claude.command);
});

test('model listing uses each preset\'s own command', () => {
  assert.deepEqual(listCommandsFor(CLI_PRESETS.claude.command), ['claude -p /model', 'claude --list-models', 'claude models']);
  assert.deepEqual(listCommandsFor(CLI_PRESETS.cursor.command), ['agent --list-models', 'agent models']);
  assert.deepEqual(listCommandsFor(CLI_PRESETS.devin.command), ['devin models list --format json']);
  // a quoted full path is kept, not swapped for whatever is on PATH
  assert.deepEqual(listCommandsFor('"C:\\x y\\devin.exe" -p --prompt-file {promptFile}'), ['"C:\\x y\\devin.exe" models list --format json']);
});

test('Devin CLI gets its prompt as a file and the model as --model', () => {
  const { cmd, stdin } = buildCliCommand(CLI_PRESETS.devin.command, { prompt: 'do it', promptFile: 'C:\\data\\prompts\\wi.md', worktree: 'C:\\wt', model: 'swe-2-medium' });
  assert.equal(stdin, false);
  assert.match(cmd, /--prompt-file "C:\\data\\prompts\\wi\.md"/);
  assert.match(cmd, /--model "swe-2-medium"$/);
  assert.doesNotMatch(cmd, /\{promptFile\}|\{model\}/);
});

test('Claude Code and cursor-agent get the prompt on stdin; {model} is honoured', () => {
  assert.equal(buildCliCommand(CLI_PRESETS.claude.command, { prompt: 'x', worktree: '.', model: 'opus' }).stdin, true);
  const { cmd } = buildCliCommand('agent -p --model {model} --force', { prompt: 'x', worktree: '.', model: 'gpt-5.2' });
  assert.equal(cmd, 'agent -p --model gpt-5.2 --force');
  // no model chosen: no dangling --model flag
  assert.equal(buildCliCommand('agent -p --model {model}', { prompt: 'x', worktree: '.', model: '' }).cmd, 'agent -p');
});

test('parseDevinModelsJson reads families, limits and prices', () => {
  const text = JSON.stringify({ families: [{ family_uid: 'swe-2', variants: [
    { model_uid: 'swe-2-high', label: 'SWE-2 High', max_context_tokens: 262000, max_output_tokens: 128000, cost_tier: 'Free' },
    { model_uid: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 High', cost_summary: '$4 / 1M Input · $0.2 / 1M Cached input · $20 / 1M Output' },
  ] }] });
  const models = parseDevinModelsJson(`some banner\n${text}`);
  assert.equal(models.length, 2);
  assert.deepEqual(models[0], { uid: 'swe-2-high', name: 'SWE-2 High', contextTokens: 262000, maxOutputTokens: 128000, priceIn: undefined, priceOut: undefined });
  assert.equal(models[1].priceIn, 4);
  assert.equal(models[1].priceOut, 20);
});

// ---- end to end against fake CLIs ------------------------------------------------
// Each fake prints what the real CLI prints for its listing command, so this
// runs the real spawn + parse path without needing the CLIs or their logins.

const OUTPUTS = {
  claude: { match: '/model', out: 'Current model: Opus\nUsage: /model <name>. Available: sonnet, opus, haiku, sonnet[1m], opusplan, default, or a full model ID.' },
  agent: { match: '--list-models', out: 'Available models\n\nauto - Auto (current, default)\ngpt-5.2 - GPT-5.2\n\nTip: use --model <id>' },
  devin: { match: 'models list', out: JSON.stringify({ families: [{ variants: [{ model_uid: 'swe-2-medium', label: 'SWE-2 Medium' }] }] }) },
};

const CLAUDE_ALIASES = {
  sonnet: ['claude-sonnet-5-5', 'Sonnet 5.5'], opus: ['claude-opus-5-5', 'Opus 5.5'], haiku: ['claude-haiku-5-5', 'Haiku 5.5'],
  'sonnet[1m]': ['claude-sonnet-5-5[1m]', 'Sonnet 5.5'], default: ['claude-opus-5-5', 'Opus 5.5'],
};

function fakeCli(dir, name) {
  const { match, out } = OUTPUTS[name];
  const js = path.join(dir, `${name}.mjs`);
  // the fake Claude also answers `--model <alias> --output-format stream-json /model` like
  // the real one: an init event naming the versioned model, a result with its display name
  const resolve = name === 'claude' ? `const map = ${JSON.stringify(CLAUDE_ALIASES)};
if (process.argv.includes('--model')) {
  const r = map[process.argv[process.argv.indexOf('--model') + 1]];
  if (!r) process.exit(1);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: r[0] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'Current model: ' + String.fromCharCode(96) + r[1] + String.fromCharCode(96), total_cost_usd: 0 }));
  process.exit(0);
}
` : '';
  fs.writeFileSync(js, `${resolve}const a = process.argv.slice(2).join(' ');\nif (a.includes(${JSON.stringify(match)})) { console.log(${JSON.stringify(out)}); } else { console.log('usage'); process.exit(2); }\n`);
  if (process.platform === 'win32') {
    const cmd = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return `"${cmd}"`;
  }
  const sh = path.join(dir, name);
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  return `"${sh}"`;
}

test('fetchCliCatalog lists models for every preset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-cli-'));
  try {
    const claude = await fetchCliCatalog(`${fakeCli(dir, 'claude')} -p --output-format stream-json`);
    // aliases resolved to versioned IDs; 'default' deduped, 'opusplan' (a mode) left out
    assert.deepEqual(claude.map((m) => m.uid), ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5-5[1m]']);
    assert.deepEqual(claude.map((m) => m.name), ['Sonnet 5.5', 'Opus 5.5', 'Haiku 5.5', 'Sonnet 5.5 (1M context)']);
    assert.equal(claude[3].contextTokens, 1_000_000);

    const cursor = await fetchCliCatalog(`${fakeCli(dir, 'agent')} -p --force`);
    assert.deepEqual(cursor.map((m) => m.uid), ['auto', 'gpt-5.2']);

    const devin = await fetchCliCatalog(`${fakeCli(dir, 'devin')} -p --prompt-file {promptFile}`);
    assert.deepEqual(devin.map((m) => m.uid), ['swe-2-medium']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing Devin CLI reports a Devin message, never a Cursor one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-cli-'));
  try {
    const broken = path.join(dir, process.platform === 'win32' ? 'devin.cmd' : 'devin');
    fs.writeFileSync(broken, process.platform === 'win32' ? '@echo Not logged in\r\n@exit /b 1\r\n' : '#!/bin/sh\necho Not logged in\nexit 1\n', { mode: 0o755 });
    await assert.rejects(fetchCliCatalog(`"${broken}" -p --prompt-file {promptFile}`), (e) => {
      assert.match(e.message, /Devin CLI/);
      assert.doesNotMatch(e.message, /Cursor|cursor/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
