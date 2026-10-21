// Project profile: what a repository is built with (IoT firmware, games, services, web, mobile, data, native), the
// checks the engine can run for it, and the repo tour agents get — for any stack and any size, not only small Node apps.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.OFFICE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-'));
const { detectProfile, checksFromProfile, profileSection, syncDetectedChecks, startBaseline, baselineSettled, gatingAllowed, nonGatingNotes, toolAvailable } = await import('../src/services/project-profile.ts');
const { summarizeRepo, repoFiles } = await import('../src/services/repo-map.ts');
const { riskFloor, tierWithFloor, routeChain } = await import('../src/services/routing.ts');
const { runCheck } = await import('../src/services/verify.ts');
const { q, run } = await import('../src/db.ts');
const { selectChecksForTask } = await import('../src/engine/engine.ts');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-profile-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}
const gitInit = (dir) => { for (const a of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']]) execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' }); };
const byFamily = (p) => Object.fromEntries(p.stacks.map((s) => [s.family, s]));

test('IoT and embedded: PlatformIO, ESP-IDF, Arduino and Zephyr are recognised, with host-only checks', () => {
  const pio = detectProfile(fixture({ 'platformio.ini': '[env:esp32dev]\nboard = esp32dev\n\n[env:native]\nplatform = native\n', 'src/main.cpp': '' }));
  assert.equal(pio.stacks[0].family, 'platformio');
  assert.deepEqual(pio.domains, ['iot']);
  assert.deepEqual(pio.stacks[0].commands.map((c) => c.command), ['pio run', 'pio test -e native']);
  assert.match(pio.stacks[0].label, /esp32dev/);

  const idf = detectProfile(fixture({ 'CMakeLists.txt': 'include($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(app)\n', 'main/CMakeLists.txt': 'idf_component_register(SRCS "main.c")' }));
  assert.deepEqual(idf.stacks.map((s) => s.family), ['esp-idf'], 'not also a plain CMake project');
  assert.match(idf.stacks[0].commands[0].command, /^idf\.py -B ".+" build$/);
  assert.ok(!idf.stacks[0].commands[0].command.includes(path.sep + 'build"'), 'build output goes outside the repository');

  const ino = detectProfile(fixture({ 'blink/blink.ino': 'void setup(){}', 'blink/sketch.yaml': 'default_fqbn: arduino:avr:uno\n' }));
  assert.equal(ino.stacks[0].family, 'arduino');
  assert.equal(ino.stacks[0].commands[0].command, 'arduino-cli compile .');
  const noBoard = detectProfile(fixture({ 'sketch.ino': '' }));
  assert.equal(noBoard.stacks[0].commands.length, 0);
  assert.match(noBoard.stacks[0].notes[0], /default_fqbn/);

  const zephyr = detectProfile(fixture({ 'CMakeLists.txt': 'find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})', 'prj.conf': '' }));
  assert.deepEqual(zephyr.stacks.map((s) => s.family), ['zephyr']);
  assert.equal(zephyr.stacks[0].commands.length, 0, 'needs a board: no guessed check');

  const rust = detectProfile(fixture({ 'Cargo.toml': '[dependencies]\nembedded-hal = "1.0"\ncortex-m-rt = "0.7"\n' }));
  assert.deepEqual(rust.domains, ['iot']);
});

test('games: Unity, Godot and Unreal own their folder; generated C# projects are not a separate stack', () => {
  const unity = detectProfile(fixture({ 'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.10f1\n', 'Assets/Player.cs': '', 'Assembly-CSharp.csproj': '<Project/>', 'Game.sln': '' }));
  assert.deepEqual(unity.stacks.map((s) => s.family), ['unity']);
  assert.match(unity.stacks[0].label, /2022\.3\.10f1/);
  assert.deepEqual(unity.domains, ['game']);
  assert.match(unity.stacks[0].notes[0], /batchmode/);

  const godot = detectProfile(fixture({ 'project.godot': '[application]', 'addons/gut/gut_cmdln.gd': '' }));
  assert.equal(godot.stacks[0].commands[0].slot, 'test');
  const ue = detectProfile(fixture({ 'Shooter.uproject': '{}', 'Source/Shooter/CMakeLists.txt': 'project(x)' }));
  assert.deepEqual(ue.stacks.map((s) => s.family), ['unreal']);

  const web = detectProfile(fixture({ 'package.json': JSON.stringify({ dependencies: { phaser: '^3' }, scripts: { build: 'vite build' } }) }));
  assert.ok(web.domains.includes('game'));
});

test('a multi-part product: each part is its own stack with its own scoped checks; vendored and NDK builds are not', () => {
  const dir = fixture({
    'backend/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.110", "sqlalchemy"]\n[tool.pytest.ini_options]\n',
    'backend/tests/test_api.py': '',
    'web/package.json': JSON.stringify({ scripts: { build: 'vite build', test: 'vitest run', lint: 'eslint .' }, dependencies: { react: '^18' } }),
    'web/node_modules/left-pad/package.json': JSON.stringify({ scripts: { test: 'x' } }),
    'mobile/settings.gradle.kts': 'rootProject.name = "app"', 'mobile/gradlew': '', 'mobile/gradlew.bat': '',
    'mobile/app/build.gradle.kts': 'plugins { id("com.android.application") }',
    'mobile/app/src/main/cpp/CMakeLists.txt': 'project(native)',
    'third_party/zlib/CMakeLists.txt': 'project(zlib)',
    'docker-compose.yml': 'services: {}', '.github/workflows/ci.yml': 'on: push',
  });
  const p = detectProfile(dir);
  const fam = byFamily(p);
  assert.deepEqual(Object.keys(fam).sort(), ['jvm', 'node', 'python']);
  assert.equal(fam.python.dir, 'backend');
  assert.equal(fam.jvm.id, 'android');
  assert.ok(p.domains.includes('service') && p.domains.includes('web') && p.domains.includes('mobile'));
  assert.ok(p.signals.includes('containers') && p.signals.includes('CI pipeline'));
  const checks = checksFromProfile('r1', p);
  const names = checks.map((c) => c.name).sort();
  assert.deepEqual(names, ['build:mobile', 'build:web', 'lint:web', 'unit:backend', 'unit:mobile', 'unit:web']);
  const unitWeb = checks.find((c) => c.name === 'unit:web');
  assert.equal(unitWeb.command, 'cd "web" && npm test');
  assert.deepEqual(unitWeb.affectedPaths, ['web/'], 'runs only when the web part changes');
});

test('services, enterprise and other ecosystems: .NET, Maven, Go, Flutter, Make', () => {
  const dotnet = detectProfile(fixture({ 'Shop.sln': '', 'Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"/>', 'Api.Tests/Api.Tests.csproj': '<PackageReference Include="xunit"/>' }));
  assert.equal(dotnet.stacks[0].family, 'dotnet');
  assert.ok(dotnet.domains.includes('service'));
  assert.deepEqual(dotnet.stacks[0].commands.map((c) => c.slot), ['build', 'test']);
  const mvn = detectProfile(fixture({ 'pom.xml': '<artifactId>spring-boot-starter-web</artifactId>', 'mvnw': '', 'mvnw.cmd': '' }));
  assert.match(mvn.stacks[0].commands[1].command, /mvnw -q -B test$/);
  const go = detectProfile(fixture({ 'go.mod': 'module x\nrequire github.com/gin-gonic/gin v1.9.0\n' }));
  assert.deepEqual(go.stacks[0].commands.map((c) => c.command), ['go build ./...', 'go vet ./...', 'go test ./...']);
  const flutter = detectProfile(fixture({ 'pubspec.yaml': 'dependencies:\n  flutter:\n    sdk: flutter\n', 'test/widget_test.dart': '' }));
  assert.deepEqual(flutter.domains, ['mobile']);
  const make = detectProfile(fixture({ 'Makefile': 'CC=arm-none-eabi-gcc\nall:\n\t$(CC) main.c\ntest:\n\t./run-tests\n' }));
  assert.deepEqual(make.domains, ['iot']);
  assert.deepEqual(make.stacks[0].commands.map((c) => c.command), ['make', 'make test']);
});

test('the profile section names the stacks a task works in and the concerns of their domains; small projects pay nothing', () => {
  const p = detectProfile(fixture({ 'firmware/platformio.ini': '[env:uno]\nboard = uno\n', 'dashboard/package.json': JSON.stringify({ dependencies: { react: '^18' }, scripts: { build: 'vite build' } }) }));
  const plan = profileSection(p, { planning: true });
  assert.match(plan, /PlatformIO/);
  assert.match(plan, /Embedded\/IoT: .*timeout/);
  assert.match(plan, /Web: /);
  assert.match(plan, /affectedPaths/);
  const fw = profileSection(p, { paths: ['firmware/src/main.cpp'] });
  assert.match(fw, /Embedded\/IoT/);
  assert.doesNotMatch(fw, /Web: /, 'a firmware task is not told about web concerns');
  assert.ok(fw.length < 900, `${fw.length} chars`);
  // a single plain project: nothing to add
  assert.equal(profileSection(detectProfile(fixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) })), { planning: true }), '');
  assert.equal(profileSection(null), '');
});

test('the repo tour: ignored output never counts, media is counted not listed, a large repository gets its shape', () => {
  const small = fixture({ 'src/app.py': '', 'README.md': '', 'assets/a.png': '', 'assets/b.wav': '', 'build/out.js': '', '.gitignore': 'build/\n' });
  gitInit(small);
  fs.mkdirSync(path.join(small, 'newpkg'));
  fs.writeFileSync(path.join(small, 'newpkg', 'mod.py'), '');                       // a small new folder: listed
  fs.mkdirSync(path.join(small, 'dataset'));
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(small, 'dataset', `${i}.csv`), '');  // a big new folder: one entry
  const s = summarizeRepo(small, repoFiles(small, 0));
  assert.match(s, /Files \(\d+\): .*src\/app\.py/);
  assert.match(s, /newpkg\/mod\.py/);
  assert.doesNotMatch(s, /build\/out\.js/, 'ignored by .gitignore');
  assert.doesNotMatch(s, /a\.png|b\.wav/);
  assert.match(s, /Assets \(2, not listed\)/);
  assert.match(s, /New folders \(not yet in Git\): dataset\//);

  const files = { 'README.md': '', 'server/package.json': '{}', 'server/src/index.ts': '' };
  for (let i = 0; i < 300; i++) files[`server/src/mod${i}.ts`] = '';
  for (let i = 0; i < 200; i++) files[`client/src/c${i}.tsx`] = '';
  for (let i = 0; i < 500; i++) files[`client/public/img${i}.png`] = '';
  const big = fixture(files);
  const b = summarizeRepo(big, repoFiles(big, 0));
  assert.match(b, /Folders \(source files\): server\/ 302 \[src\/ 301\] · client\/ 200/);
  assert.match(b, /Key files: README\.md, server\/package\.json, server\/src\/index\.ts/);
  assert.match(b, /Assets \(500, not listed\): 500 \.png/);
  assert.ok(b.length < 1200, `a 1,000-file repository costs ${b.length} chars`);
});

test('risky work is never routed to the lightest tier; ordinary small work still is', () => {
  assert.equal(tierWithFloor('implement', 1, riskFloor('implement', 'Add a password reset token')), 'standard');
  assert.equal(riskFloor('implement', 'Debounce the button ISR on GPIO 4').why, 'concurrency or hardware');
  assert.equal(riskFloor('implement', 'Add a migration for the orders table').why, 'data or API compatibility');
  assert.equal(tierWithFloor('implement', 1, riskFloor('implement', 'Rename the Save button label')), 'fast');
  assert.equal(riskFloor('analyse', 'Rename the label', 1).why, 'repeat failure');
  assert.equal(riskFloor('doc', 'Document the auth flow'), null, 'docs are not raised');
  assert.equal(tierWithFloor('implement', 5, riskFloor('implement', 'auth')), 'strong', 'a floor never lowers');
  const opt = (name, tier) => ({ account: { id: name, billing: 'subscription' }, provider: { id: 'p', adapterId: 'cli' }, model: { id: name, name, strengthTier: tier } });
  const d = routeChain([opt('small', 'fast'), opt('mid', 'standard')], 'implement', 1, undefined, 'node', riskFloor('implement', 'Fix the OAuth callback'));
  assert.equal(d.ordered[0].model.name, 'mid');
  assert.match(d.reason, /raised from fast: security-sensitive/);
  const forced = routeChain([opt('small', 'fast'), opt('mid', 'standard')], 'implement', 1, 'fast', 'node', riskFloor('implement', 'Fix the OAuth callback'));
  assert.equal(forced.ordered[0].model.name, 'small', 'an explicit node/agent tier still wins');
});

test('detected checks: registered when the owner has none, measured on the untouched repository, gating only when they passed', async () => {
  const dir = fixture({ 'package.json': JSON.stringify({ scripts: {
    test: 'node -e "process.exit(0)"', lint: 'node -e "process.exit(3)"' } }) });
  gitInit(dir);
  run(`INSERT INTO repos (id, workspace_id, path, build_cmd, test_cmd) VALUES ('repo-p', 'ws', ?, '', '')`, dir);
  const repo = { id: 'repo-p', path: dir, buildCmd: '', testCmd: '' };
  const stored = await syncDetectedChecks(repo);
  assert.deepEqual(stored.checks.filter((c) => c.registered).map((c) => c.name).sort(), ['lint', 'unit:all']);
  const rows = () => q(`SELECT name, origin, baseline FROM checks WHERE repo_id = 'repo-p' ORDER BY name`);
  assert.deepEqual(rows().map((r) => r.origin), ['detected', 'detected']);

  const p = startBaseline(repo, 'run-p', { tree: async () => 'tree-1', runCheck: async (row) => runCheck({ check: { ...row, repoId: row.repo_id, passRule: 'exit0', timeoutSec: 60, affectedPaths: [], origin: 'detected' }, worktree: dir, runId: 'run-p', ref: 'baseline' }) });
  assert.equal(await baselineSettled('repo-p', 0), false, 'writers see the baseline still running');
  await p;
  assert.equal(await baselineSettled('repo-p', 0), true);
  assert.deepEqual(rows().map((r) => [r.name, r.baseline]), [['lint', 'fail'], ['unit:all', 'pass']]);
  assert.match(nonGatingNotes('repo-p'), /^lint did not pass before this run/);

  const sel = selectChecksForTask(repo, ['src/index.js']).map((c) => c.name);
  assert.deepEqual(sel, ['unit:all'], 'the failure that was already there does not gate the task');
  assert.deepEqual(selectChecksForTask(repo, ['README.md', 'docs/logo.png']).map((c) => c.name), [], 'docs-only changes skip the test suite');
  assert.equal(gatingAllowed({ origin: 'owner', baseline: '' }), true);

  // same tree again: nothing re-measured
  let calls = 0;
  await startBaseline(repo, 'run-p2', { tree: async () => 'tree-1', runCheck: async () => { calls++; return { status: 'pass', summary: '' }; } });
  assert.equal(calls, 0);

  // the office turns detection off: detected checks go, and come back when it is on again
  run(`INSERT INTO workspaces (id, name, settings) VALUES ('ws', 'W', '{"detectChecks":false}')`);
  assert.equal((await syncDetectedChecks(repo)).checks.some((c) => c.registered), false);
  assert.deepEqual(rows(), []);
  run(`UPDATE workspaces SET settings = '{}' WHERE id = 'ws'`);
  await syncDetectedChecks(repo);
  assert.deepEqual(rows().map((r) => r.name), ['lint', 'unit:all']);

  // the owner adds a check of their own: detected checks step aside
  run(`INSERT INTO checks (id, repo_id, name, kind, command) VALUES ('own', 'repo-p', 'build', 'build', 'node -v')`);
  const again = await syncDetectedChecks(repo);
  assert.equal(again.ownerChecks, true);
  assert.deepEqual(rows().map((r) => r.name), ['build'], 'detected checks removed, the owner\'s kept');
});

test('a tool that is not installed gives no check', async () => {
  assert.equal(await toolAvailable('oficina-no-such-tool-xyz --version', os.tmpdir()), false);
  assert.equal(await toolAvailable('node --version', os.tmpdir()), true);
});
