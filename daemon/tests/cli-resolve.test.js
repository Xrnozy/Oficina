import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLI_PRESETS, detectInstalledClis, prepareCliCommand } from '../src/adapters/cli-resolve.ts';

test('detectInstalledClis returns only CLIs whose executable exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-cli-detect-'));
  const ext = process.platform === 'win32' ? '.cmd' : '';
  try {
    fs.writeFileSync(path.join(dir, `claude${ext}`), '');
    fs.writeFileSync(path.join(dir, `cursor-agent${ext}`), '');
    const found = detectInstalledClis(dir);
    assert.deepEqual(found.map((f) => f.id), ['claude', 'cursor']);
    assert.equal(found[1].command, CLI_PRESETS.cursor.command);
    assert.match(found[0].path, /claude/);
    assert.deepEqual(detectInstalledClis(path.join(dir, 'missing')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareCliCommand augments PATH with cursor-agent install dir', () => {
  const { env } = prepareCliCommand('agent -p --output-format stream-json');
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const pathEnv = env[pathKey] ?? '';
  const expected = path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent');
  if (process.env.LOCALAPPDATA) {
    assert.ok(pathEnv.includes(expected), `PATH should include ${expected}`);
  }
});
