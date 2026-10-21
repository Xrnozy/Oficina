import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { q, q1, run } from '../db.ts';
import { emit } from '../bus.ts';
import { parseJson, sha256 } from '../util.ts';
import { spawnShell, killProcessTree } from '../adapters/cli-resolve.ts';
import { repoFiles, type RepoFiles } from './repo-map.ts';
import type { Repo } from '../types.ts';

// Project profile (spec: check profiles per stack). What a repository is built
// with — found from its manifest files, never from a model — and what that
// means for the work: the build/test/lint commands the engine can run as
// checks, and the engineering concerns of the domain (embedded, game, service,
// web, mobile, data, native) that agents must respect. Detectors are a table,
// so a new toolchain is one entry, not a new code path.
//
// Detected checks are used only when the owner configured none. Each is
// measured once on the untouched repository (its baseline): a check that
// already fails there is reported to the PM but does not gate deliveries, so
// agents are never sent to fix failures they did not cause.

export type Domain = 'web' | 'service' | 'iot' | 'game' | 'mobile' | 'data' | 'native';
export type Slot = 'build' | 'test' | 'lint' | 'typecheck';
export interface StackCommand { slot: Slot; command: string; probe: string; timeoutSec: number }
export interface Stack { id: string; family: string; label: string; dir: string; domains: Domain[]; commands: StackCommand[]; notes: string[] }
export interface ProjectProfile { stacks: Stack[]; domains: Domain[]; signals: string[]; hash: string }

const WIN = process.platform === 'win32';
const VENDORED = /(^|\/)(node_modules|vendor|third_party|third-party|extern|external|deps|site-packages|venv|\.venv|Pods|bower_components)\//;
const MAX_DEPTH = 4;

interface DirCtx {
  dir: string; abs: string;
  names: Set<string>;                                      // files directly in dir
  subdirs: Set<string>;                                    // folders directly in dir
  files: string[];                                         // every file under dir (repo-relative)
  read: (name: string) => string; tmp: (tag: string) => string;
}
type Detector = { family: string; detect: (c: DirCtx) => Omit<Stack, 'dir' | 'family'> | null; inside?: string[] };

const deps = (text: string, list: string[]) => list.filter((d) => new RegExp(`["'\\s/=]${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'\\s=<>~^@:,\\]]`, 'i').test(` ${text} `));
const pick = (found: string[], labels: Record<string, string>) => [...new Set(found.map((f) => labels[f] ?? f))];
const cmd = (slot: Slot, command: string, probe: string, timeoutSec = 600): StackCommand => ({ slot, command, probe, timeoutSec });

const DETECTORS: Detector[] = [
  { family: 'node', detect: (c) => {
    if (!c.names.has('package.json')) return null;
    const pkg = parseJson<{ scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(c.read('package.json'), {});
    const s = pkg.scripts ?? {};
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const pm = c.names.has('pnpm-lock.yaml') ? 'pnpm' : c.names.has('yarn.lock') ? 'yarn' : c.names.has('bun.lockb') || c.names.has('bun.lock') ? 'bun' : 'npm';
    const runS = (name: string) => (name === 'test' ? `${pm} test` : `${pm} run ${name}`);
    const probe = `${pm} --version`;
    const commands: StackCommand[] = [];
    if (s.build) commands.push(cmd('build', runS('build'), probe));
    const tc = ['typecheck', 'type-check', 'tsc', 'check-types'].find((n) => s[n]);
    if (tc) commands.push(cmd('typecheck', runS(tc), probe, 300));
    if (s.lint) commands.push(cmd('lint', runS('lint'), probe, 300));
    if (s.test && !/no test specified/i.test(s.test)) commands.push(cmd('test', runS('test'), probe));
    const has = (...n: string[]) => n.some((x) => all.includes(x) || all.some((d) => d.startsWith(`${x}/`)));
    const domains: Domain[] = [];
    if (has('react', 'vue', 'svelte', 'next', 'nuxt', '@angular/core', 'solid-js', 'astro', '@remix-run/react', 'vite', 'preact')) domains.push('web');
    if (has('express', 'fastify', 'koa', '@nestjs/core', 'hono', 'apollo-server', '@apollo/server', 'prisma', 'typeorm', 'sequelize', 'mongoose', 'pg')) domains.push('service');
    if (has('react-native', 'expo', '@capacitor/core', '@ionic/react', '@ionic/angular')) domains.push('mobile');
    if (has('electron', '@tauri-apps/api')) domains.push('native');
    if (has('phaser', 'three', 'pixi.js', 'babylonjs', '@babylonjs/core', 'playcanvas', 'kaboom', 'excalibur', 'matter-js', 'cannon-es')) domains.push('game');
    if (has('johnny-five', 'serialport', '@serialport/stream', 'mqtt', 'node-red', 'onoff', 'i2c-bus', 'modbus-serial')) domains.push('iot');
    const fw = ['next', 'react', 'vue', 'svelte', '@angular/core', 'express', 'fastify', '@nestjs/core', 'electron', 'react-native', 'phaser', 'three'].filter((d) => all.includes(d));
    const notes: string[] = [];
    if (commands.length && all.length && !fs.existsSync(path.join(c.abs, 'node_modules'))) notes.push(`dependencies are not installed here (no node_modules) — run \`${pm} install\` first`);
    return { id: 'node', label: `Node.js${all.includes('typescript') ? ' / TypeScript' : ''}${fw.length ? ` — ${pick(fw, { '@angular/core': 'Angular', '@nestjs/core': 'NestJS' }).join(', ')}` : ''}`, domains, commands, notes };
  } },
  { family: 'python', detect: (c) => {
    const manifests = [...c.names].filter((n) => /^(pyproject\.toml|setup\.py|setup\.cfg|pipfile|requirements[\w.-]*\.txt|environment\.ya?ml)$/i.test(n));
    if (!manifests.length) return null;
    const text = manifests.map((m) => c.read(m)).join('\n');
    const tests = c.names.has('pytest.ini') || c.names.has('conftest.py') || /pytest/i.test(text) || c.files.some((f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f));
    const py = WIN ? 'python' : 'python3';
    const commands: StackCommand[] = [];
    if (/\[tool\.ruff|^ruff\b/im.test(text) || c.names.has('ruff.toml')) commands.push(cmd('lint', `${py} -m ruff check .`, `${py} -m ruff --version`, 300));
    if (/\[tool\.mypy|^mypy\b/im.test(text) || c.names.has('mypy.ini')) commands.push(cmd('typecheck', `${py} -m mypy .`, `${py} -m mypy --version`, 600));
    if (tests) commands.push(cmd('test', `${py} -m pytest -q`, `${py} -m pytest --version`));
    const found = deps(text, ['django', 'flask', 'fastapi', 'starlette', 'aiohttp', 'tornado', 'sqlalchemy', 'celery',
      'torch', 'tensorflow', 'keras', 'scikit-learn', 'sklearn', 'pandas', 'numpy', 'opencv-python', 'transformers', 'ultralytics', 'jax',
      'micropython', 'esptool', 'paho-mqtt', 'pyserial', 'RPi.GPIO', 'gpiozero', 'adafruit-blinka', 'smbus2', 'pymodbus', 'bleak',
      'pygame', 'arcade', 'pyglet', 'panda3d', 'ursina']);
    const domains: Domain[] = [];
    if (found.some((d) => ['django', 'flask', 'fastapi', 'starlette', 'aiohttp', 'tornado', 'sqlalchemy', 'celery'].includes(d))) domains.push('service');
    if (found.some((d) => ['torch', 'tensorflow', 'keras', 'scikit-learn', 'sklearn', 'pandas', 'transformers', 'ultralytics', 'jax', 'opencv-python'].includes(d))) domains.push('data');
    if (found.some((d) => ['micropython', 'esptool', 'paho-mqtt', 'pyserial', 'RPi.GPIO', 'gpiozero', 'adafruit-blinka', 'smbus2', 'pymodbus', 'bleak'].includes(d))) domains.push('iot');
    if (found.some((d) => ['pygame', 'arcade', 'pyglet', 'panda3d', 'ursina'].includes(d))) domains.push('game');
    const shown = found.filter((d) => !['numpy', 'pandas', 'sqlalchemy'].includes(d)).slice(0, 4);
    return { id: 'python', label: `Python${shown.length ? ` — ${shown.join(', ')}` : ''}`, domains, commands, notes: tests ? [] : ['no tests found'] };
  } },
  { family: 'rust', detect: (c) => {
    if (!c.names.has('Cargo.toml')) return null;
    const t = c.read('Cargo.toml');
    const found = deps(t, ['embedded-hal', 'cortex-m', 'cortex-m-rt', 'esp-hal', 'esp-idf-svc', 'rp2040-hal', 'embassy-executor', 'stm32f4xx-hal',
      'bevy', 'macroquad', 'ggez', 'fyrox', 'actix-web', 'axum', 'rocket', 'warp', 'poem', 'tauri', 'yew', 'leptos', 'wasm-bindgen']);
    const domains: Domain[] = [];
    const embedded = found.some((d) => /hal|cortex|embassy|esp-idf/.test(d));
    if (embedded) domains.push('iot');
    if (found.some((d) => ['bevy', 'macroquad', 'ggez', 'fyrox'].includes(d))) domains.push('game');
    if (found.some((d) => ['actix-web', 'axum', 'rocket', 'warp', 'poem'].includes(d))) domains.push('service');
    if (found.some((d) => ['yew', 'leptos', 'wasm-bindgen'].includes(d))) domains.push('web');
    if (found.includes('tauri')) domains.push('native');
    return { id: 'rust', label: `Rust${found.length ? ` — ${found.slice(0, 3).join(', ')}` : ''}`, domains,
      commands: [cmd('build', 'cargo build', 'cargo --version', 1200), cmd('test', 'cargo test', 'cargo --version', 1200)],
      notes: embedded ? ['firmware crate: `cargo test` needs host-runnable tests'] : [] };
  } },
  { family: 'go', detect: (c) => {
    if (!c.names.has('go.mod')) return null;
    const t = c.read('go.mod');
    const domains: Domain[] = [];
    if (/gin-gonic|labstack\/echo|gofiber|go-chi|google\.golang\.org\/grpc|gorilla\/mux/.test(t)) domains.push('service');
    if (/tinygo\.org/.test(t)) domains.push('iot');
    if (/hajimehoshi\/ebiten/.test(t)) domains.push('game');
    return { id: 'go', label: 'Go', domains, notes: [],
      commands: [cmd('build', 'go build ./...', 'go version'), cmd('lint', 'go vet ./...', 'go version', 600), cmd('test', 'go test ./...', 'go version')] };
  } },
  { family: 'dotnet', inside: ['unity', 'unreal'], detect: (c) => {
    const sln = [...c.names].find((n) => /\.sln$/i.test(n));
    const projs = [...c.names].filter((n) => /\.(cs|fs|vb)proj$/i.test(n));
    if (!sln && !projs.length) return null;
    const text = projs.slice(0, 10).map((p) => c.read(p)).join('\n') + c.files.filter((f) => /\.(cs|fs)proj$/i.test(f)).slice(0, 20).map((f) => c.read(f.slice(c.dir ? c.dir.length + 1 : 0))).join('\n');
    const domains: Domain[] = [];
    if (/Microsoft\.NET\.Sdk\.Web|Microsoft\.AspNetCore/.test(text)) domains.push('service');
    if (/MonoGame|Stride|FNA/.test(text)) domains.push('game');
    if (/nanoFramework|Meadow|System\.Device\.Gpio|Iot\.Device/.test(text)) domains.push('iot');
    if (/Microsoft\.Maui|UseMaui/.test(text)) domains.push('mobile');
    if (/UseWPF|UseWindowsForms|Avalonia/.test(text)) domains.push('native');
    const tests = /Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest/i.test(text) || c.files.some((f) => /tests?\.(cs|fs)proj$/i.test(f));
    const target = sln ? ` "${sln}"` : '';
    return { id: 'dotnet', label: '.NET', domains, notes: [],
      commands: [cmd('build', `dotnet build${target}`, 'dotnet --version', 900), ...(tests ? [cmd('test', `dotnet test${target}`, 'dotnet --version', 1200)] : [])] };
  } },
  { family: 'jvm', detect: (c) => {
    if (c.names.has('pom.xml')) {
      const t = c.read('pom.xml');
      const mvn = c.names.has('mvnw') || c.names.has('mvnw.cmd') ? (WIN ? 'mvnw' : './mvnw') : 'mvn';
      return { id: 'maven', label: `Java (Maven)${/spring-boot/.test(t) ? ' — Spring Boot' : ''}`, domains: /spring-boot|quarkus|micronaut|jakarta/.test(t) ? ['service'] : [], notes: [],
        commands: [cmd('build', `${mvn} -q -B -DskipTests compile`, mvn === 'mvn' ? 'mvn -v' : 'java -version', 1200), cmd('test', `${mvn} -q -B test`, mvn === 'mvn' ? 'mvn -v' : 'java -version', 1800)] };
    }
    const build = [...c.names].find((n) => /^(build|settings)\.gradle(\.kts)?$/.test(n));
    if (!build) return null;
    const t = [...c.names].filter((n) => /\.gradle(\.kts)?$/.test(n)).map((n) => c.read(n)).join('\n')
      + c.files.filter((f) => /(^|\/)app\/build\.gradle(\.kts)?$/.test(f)).map((f) => c.read(f.slice(c.dir ? c.dir.length + 1 : 0))).join('\n');
    const wrapper = WIN ? c.names.has('gradlew.bat') : c.names.has('gradlew');
    const g = wrapper ? (WIN ? 'gradlew' : './gradlew') : 'gradle';
    const android = /com\.android\.(application|library)|id\("com\.android|android\s*\{/.test(t);
    const domains: Domain[] = android ? ['mobile'] : /spring|ktor|micronaut|quarkus/.test(t) ? ['service'] : /libgdx|gdx/.test(t) ? ['game'] : [];
    const notes = android && !c.names.has('local.properties') && !process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT ? ['Android SDK location unknown (no local.properties, no ANDROID_HOME)'] : [];
    return { id: android ? 'android' : 'gradle', label: android ? 'Android (Gradle' + (/kotlin/i.test(t) ? ', Kotlin)' : ')') : `JVM (Gradle${/kotlin/i.test(t) ? ', Kotlin' : ''})`, domains, notes,
      commands: android
        ? [cmd('build', `${g} -q assembleDebug`, wrapper ? 'java -version' : 'gradle --version', 1800), cmd('test', `${g} -q testDebugUnitTest`, wrapper ? 'java -version' : 'gradle --version', 1800)]
        : [cmd('build', `${g} -q assemble`, wrapper ? 'java -version' : 'gradle --version', 1800), cmd('test', `${g} -q test`, wrapper ? 'java -version' : 'gradle --version', 1800)] };
  } },
  { family: 'platformio', detect: (c) => {
    if (!c.names.has('platformio.ini')) return null;
    const t = c.read('platformio.ini');
    const boards = [...t.matchAll(/^\s*board\s*=\s*(\S+)/gm)].map((m) => m[1]);
    const native = /^\s*\[env:native\]/m.test(t);
    return { id: 'platformio', label: `PlatformIO firmware${boards.length ? ` — ${[...new Set(boards)].slice(0, 3).join(', ')}` : ''}`, domains: ['iot'],
      commands: [cmd('build', 'pio run', 'pio --version', 1800), ...(native ? [cmd('test', 'pio test -e native', 'pio --version', 1200)] : [])],
      notes: ['on-device tests (`pio test` on a board) and uploads are never run automatically'] };
  } },
  { family: 'esp-idf', inside: ['platformio'], detect: (c) => {
    if (!c.names.has('CMakeLists.txt')) return null;
    const t = c.read('CMakeLists.txt');
    if (!/\$ENV\{IDF_PATH\}|project\.cmake|idf_component_register/.test(t) && !c.names.has('sdkconfig') && !c.names.has('sdkconfig.defaults')) return null;
    return { id: 'esp-idf', label: 'ESP-IDF firmware', domains: ['iot'], commands: [cmd('build', `idf.py -B "${c.tmp('idf')}" build`, 'idf.py --version', 1800)],
      notes: ['flashing and monitoring a device are never run automatically'] };
  } },
  { family: 'zephyr', detect: (c) => {
    if (!c.names.has('CMakeLists.txt') || !/find_package\(Zephyr/.test(c.read('CMakeLists.txt'))) return null;
    return { id: 'zephyr', label: 'Zephyr RTOS firmware', domains: ['iot'], commands: [],
      notes: ['no build check: Zephyr needs a board — add a check such as `west build -b <board>`'] };
  } },
  { family: 'cmake', inside: ['jvm', 'esp-idf', 'zephyr', 'platformio', 'unreal'], detect: (c) => {
    if (!c.names.has('CMakeLists.txt')) return null;
    const t = c.read('CMakeLists.txt');
    if (/find_package\(Zephyr|idf_component_register|project\.cmake/.test(t)) return null;
    const b = c.tmp('cmake');
    const configure = `cmake -S . -B "${b}" && cmake --build "${b}"`;
    const embedded = /pico_sdk_init|arm-none-eabi|STM32|CMAKE_SYSTEM_NAME\s+Generic|avr-gcc/i.test(t);
    const tests = /enable_testing\(|add_test\(|include\(CTest\)|gtest|Catch2|doctest/i.test(t);
    return { id: 'cmake', label: `C/C++ (CMake)${embedded ? ' — embedded target' : ''}`, domains: embedded ? ['iot'] : ['native'], notes: [],
      commands: [cmd('build', configure, 'cmake --version', 1800), ...(tests ? [cmd('test', `${configure} && ctest --test-dir "${b}" --output-on-failure`, 'cmake --version', 1800)] : [])] };
  } },
  { family: 'arduino', inside: ['platformio', 'esp-idf', 'cmake'], detect: (c) => {
    const ino = [...c.names].find((n) => /\.ino$/i.test(n));
    if (!ino) return null;
    const fqbn = c.read('sketch.yaml').match(/default_fqbn:\s*(\S+)/)?.[1];
    return { id: 'arduino', label: `Arduino sketch${fqbn ? ` — ${fqbn}` : ''}`, domains: ['iot'],
      commands: fqbn ? [cmd('build', 'arduino-cli compile .', 'arduino-cli version', 1200)] : [],
      notes: fqbn ? ['uploads are never run automatically'] : ['no build check: set default_fqbn in sketch.yaml (or add `arduino-cli compile --fqbn <board>` as a check)'] };
  } },
  { family: 'micropython', detect: (c) => (c.names.has('boot.py') && c.names.has('main.py')
    ? { id: 'micropython', label: 'MicroPython', domains: ['iot'], commands: [], notes: ['runs on the device — test logic on the host with stubs'] } : null) },
  { family: 'unity', detect: (c) => {
    if (!c.subdirs.has('ProjectSettings') || !c.subdirs.has('Assets')) return null;
    const v = c.read('ProjectSettings/ProjectVersion.txt').match(/m_EditorVersion:\s*(\S+)/)?.[1];
    return { id: 'unity', label: `Unity${v ? ` ${v}` : ''}`, domains: ['game'], commands: [],
      notes: ['no automatic check: Unity tests need the editor — add a check such as `"<Unity>" -batchmode -nographics -projectPath . -runTests -testPlatform EditMode`'] };
  } },
  { family: 'unreal', detect: (c) => {
    const up = [...c.names].find((n) => /\.uproject$/i.test(n));
    return up ? { id: 'unreal', label: `Unreal Engine (${up.replace(/\.uproject$/i, '')})`, domains: ['game'], commands: [],
      notes: ['no automatic check: builds need the engine — add a RunUAT/UnrealBuildTool command as a check'] } : null;
  } },
  { family: 'godot', detect: (c) => {
    if (!c.names.has('project.godot')) return null;
    const gut = c.files.some((f) => f.includes('addons/gut/'));
    return { id: 'godot', label: 'Godot', domains: ['game'],
      commands: gut ? [cmd('test', 'godot --headless -s addons/gut/gut_cmdln.gd -gexit', 'godot --version', 900)] : [],
      notes: gut ? [] : ['no automatic tests (GUT is not installed)'] };
  } },
  { family: 'dart', detect: (c) => {
    if (!c.names.has('pubspec.yaml')) return null;
    const flutter = /sdk:\s*flutter/.test(c.read('pubspec.yaml'));
    const tool = flutter ? 'flutter' : 'dart';
    const tests = c.files.some((f) => /(^|\/)test\/.+_test\.dart$/.test(f));
    return { id: tool, label: flutter ? 'Flutter' : 'Dart', domains: flutter ? ['mobile'] : [], notes: [],
      commands: [cmd('lint', `${tool} analyze`, `${tool} --version`, 600), ...(tests ? [cmd('test', `${tool} test`, `${tool} --version`, 1200)] : [])] };
  } },
  { family: 'swift', detect: (c) => (c.names.has('Package.swift')
    ? { id: 'swift', label: 'Swift (SwiftPM)', domains: [], notes: [],
      commands: [cmd('build', 'swift build', 'swift --version', 1200), ...(c.files.some((f) => /(^|\/)Tests\//.test(f)) ? [cmd('test', 'swift test', 'swift --version', 1200)] : [])] } : null) },
  { family: 'make', detect: (c) => {
    const mk = ['Makefile', 'makefile', 'GNUmakefile'].find((n) => c.names.has(n));
    if (!mk) return null;
    const t = c.read(mk);
    const embedded = /arm-none-eabi|avr-gcc|STM32|xtensa|riscv\d*-unknown-elf|openocd/i.test(t);
    const commands: StackCommand[] = [];
    if (/^(all|build)\s*:/m.test(t)) commands.push(cmd('build', 'make', 'make --version', 1200));
    if (/^test\s*:/m.test(t)) commands.push(cmd('test', 'make test', 'make --version', 1200));
    return { id: 'make', label: `Make${embedded ? ' — embedded toolchain' : ''}`, domains: embedded ? ['iot'] : ['native'], commands, notes: [] };
  } },
];

const tmpRoot = () => path.join(os.tmpdir(), 'oficina-checks');

// a folder is examined only when it holds one of these (or is a Unity project root)
const MANIFEST = /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|pipfile|requirements[\w.-]*\.txt|environment\.ya?ml|cargo\.toml|go\.mod|[\w.-]+\.(sln|csproj|fsproj|vbproj|ino|uproject)|pom\.xml|[\w.-]+\.gradle(\.kts)?|platformio\.ini|cmakelists\.txt|boot\.py|project\.godot|pubspec\.yaml|package\.swift|(gnu)?makefile|sdkconfig(\.defaults)?)$/i;

const under = (child: string, parent: string) => parent === '' ? child !== '' : child.startsWith(`${parent}/`);

/** Stacks of a repository, from its manifest files (no commands run). */
export function detectProfile(repoPath: string, rf: RepoFiles = repoFiles(repoPath)): ProjectProfile {
  // one pass: the files and folders directly inside every folder up to MAX_DEPTH
  const names = new Map<string, Set<string>>();
  const subdirs = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, k: string, v: string) => { let s = m.get(k); if (!s) m.set(k, (s = new Set())); s.add(v); };
  for (const f of rf.files) {
    if (VENDORED.test(f)) continue;
    const parts = f.split('/');
    if (parts.length - 1 > MAX_DEPTH) continue;
    const dir = parts.slice(0, -1).join('/');
    add(names, dir, parts[parts.length - 1]);
    for (let i = 0; i < parts.length - 1; i++) add(subdirs, parts.slice(0, i).join('/'), parts[i]);
  }
  const candidates = [...new Set([...names.keys(), ...subdirs.keys()])]
    .filter((d) => [...(names.get(d) ?? [])].some((n) => MANIFEST.test(n)) || (subdirs.get(d)?.has('ProjectSettings') ?? false))
    .sort((a, b) => (a ? a.split('/').length : 0) - (b ? b.split('/').length : 0) || a.localeCompare(b));
  const stacks: Stack[] = [];
  for (const dir of candidates) {
    const prefix = dir ? `${dir}/` : '';
    let files: string[] | null = null;
    const ctx: DirCtx = {
      dir, abs: path.join(repoPath, dir), names: names.get(dir) ?? new Set(), subdirs: subdirs.get(dir) ?? new Set(),
      get files() { return (files ??= rf.files.filter((f) => f.startsWith(prefix))); },
      read: (name) => { try { const p = path.join(repoPath, dir, name); return fs.statSync(p).size < 512 * 1024 ? fs.readFileSync(p, 'utf8') : ''; } catch { return ''; } },
      // build output of detected checks goes outside the repository, never into the owner's tree
      tmp: (tag) => path.join(tmpRoot(), sha256(`${repoPath}|${dir}`).slice(0, 12), tag),
    };
    for (const d of DETECTORS) {
      // a nested manifest of the same toolchain belongs to its parent project (workspaces, vendored libraries), and a
      // build another toolchain drives (CMake under Gradle for the NDK, C# project files Unity generates) is not separate
      if (stacks.some((s) => under(dir, s.dir) && s.family === d.family && s.commands.length)) continue;
      if (d.inside && stacks.some((s) => under(dir, s.dir) && d.inside!.includes(s.family))) continue;
      const found = d.detect(ctx);
      if (found) stacks.push({ ...found, family: d.family, dir });
    }
  }
  // Unity / Unreal own their folder: generated project files there are not a stack of their own
  const engines = stacks.filter((s) => s.family === 'unity' || s.family === 'unreal');
  const kept = stacks.filter((s) => !(['dotnet', 'cmake'].includes(s.family) && engines.some((e) => s.dir === e.dir || under(s.dir, e.dir))));
  const signals: string[] = [];
  const any = (re: RegExp) => rf.files.some((f) => re.test(f));
  if (any(/(^|\/)(Dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml)$/i)) signals.push('containers');
  if (any(/(^|\/)(Chart\.yaml|k8s\/|kubernetes\/|helm\/)/)) signals.push('Kubernetes');
  if (any(/\.tf$/)) signals.push('Terraform');
  if (any(/^\.github\/workflows\//) || fs.existsSync(path.join(repoPath, '.gitlab-ci.yml')) || any(/(^|\/)(Jenkinsfile|azure-pipelines\.ya?ml)$/)) signals.push('CI pipeline');
  if (any(/(^|\/)(migrations?|alembic|flyway|liquibase)\//)) signals.push('database migrations');
  if (any(/(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i)) signals.push('API spec');
  // order domains by how much of the repository each stack covers
  const share = (s: Stack) => (s.dir ? rf.files.filter((f) => f.startsWith(`${s.dir}/`)).length : rf.files.length);
  const domains: Domain[] = [];
  for (const s of [...kept].sort((a, b) => share(b) - share(a))) for (const d of s.domains) if (!domains.includes(d)) domains.push(d);
  if (signals.some((x) => ['containers', 'Kubernetes', 'Terraform', 'database migrations', 'API spec'].includes(x)) && !domains.includes('service')) domains.push('service');
  const hash = sha256(JSON.stringify({ kept, signals })).slice(0, 16);
  return { stacks: kept, domains, signals, hash };
}

// ---------------------------------------------------------------------------
// Prompt section: the stacks and the engineering concerns of their domains.
// ---------------------------------------------------------------------------

const GUIDANCE: Record<Domain, string> = {
  iot: 'Embedded/IoT: respect the target\'s RAM, flash and power limits (no unbounded buffers, heap churn or busy-waits); never block in an interrupt handler or the main loop; put a timeout and a retry on every bus, radio and network wait; validate sensor and network input; keep pin and board configuration in one place; test logic on the host (native env, mocks). Never flash a device, change fuses or bootloaders, or touch hardware without the owner.',
  game: 'Game: hold the frame budget (no per-frame allocations, file I/O or scene searches in update loops); fixed timestep for physics and gameplay that must be deterministic; follow the engine\'s conventions (Unity: move or rename an asset together with its .meta file; Godot: keep scene and resource paths valid); never hand-edit binary or generated asset files.',
  service: 'Service/enterprise: keep public APIs, message formats and database schemas backward compatible (add migrations, never edit applied ones); configuration and secrets come from the environment, never from code; authorize every operation that needs it; put timeouts, retries and clear errors on external calls; log failures with context; cover changed endpoints with integration tests.',
  web: 'Web: validate input on the server, never only in the client; no secrets or privileged calls in client code; escape output (XSS) and protect state-changing requests (CSRF); keep the UI accessible (labels, keyboard, contrast); check the screens you changed, not only the unit tests.',
  mobile: 'Mobile: handle the app lifecycle (pause/resume, rotation, process death) and permissions explicitly; no network or disk work on the UI thread; mind battery and data use; keep minimum SDK and platform versions unless the task says otherwise.',
  data: 'Data/ML: fix random seeds and report metrics before and after a change on the same data; keep preprocessing identical between training and inference; never commit datasets, checkpoints or model weights.',
  native: 'Native code: no undefined behaviour; check every return and error code; release what you acquire (RAII); keep the build warning-free on the targets the project supports.',
};

function stackLine(s: Stack): string {
  return `${s.label}${s.dir ? ` (${s.dir}/)` : ''}`;
}

/** The stacks a task works in: those containing its paths (all of them when it names none). */
export function stacksFor(p: ProjectProfile, paths: string[] = []): Stack[] {
  const ps = paths.map((x) => x.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\*.*$/, ''));
  if (!ps.length || ps.some((x) => !x || x === '/')) return p.stacks;
  const hit = p.stacks.filter((s) => !s.dir || ps.some((x) => x === s.dir || x.startsWith(`${s.dir}/`)));
  return hit.length ? hit : p.stacks;
}

/**
 * "## Project profile" for a prompt — a few hundred characters: the stacks the work touches and, per domain, what
 * good engineering means there. Empty when nothing was detected, so a plain script costs nothing extra.
 */
export function profileSection(p: ProjectProfile | null, opts: { paths?: string[]; planning?: boolean } = {}): string {
  if (!p || !p.stacks.length) return '';
  const stacks = opts.planning ? p.stacks : stacksFor(p, opts.paths);
  const domains = opts.planning ? p.domains : [...new Set(stacks.flatMap((s) => s.domains))];
  // one stack at the root and no domain with special concerns: the file list already says it all
  if (p.stacks.length === 1 && !p.stacks[0].dir && !domains.length) return '';
  const L = ['## Project profile', `Stacks: ${stacks.slice(0, 8).map(stackLine).join(' · ')}${p.signals.length && opts.planning ? ` · ${p.signals.join(', ')}` : ''}`];
  for (const d of domains.slice(0, 3)) L.push(`- ${GUIDANCE[d]}`);
  if (opts.planning && p.stacks.length) {
    L.push('Give every task the affectedPaths of the part of the project it changes (so the right checks run and independent tasks can proceed side by side), and rate difficulty by risk as well as size: security, concurrency, hardware, data migrations and public API changes are 3 or more.');
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Detected checks and their baseline.
// ---------------------------------------------------------------------------

const SLOT_KIND: Record<Slot, 'build' | 'unit' | 'lint' | 'typecheck'> = { build: 'build', test: 'unit', lint: 'lint', typecheck: 'typecheck' };
const SLOT_NAME: Record<Slot, string> = { build: 'build', test: 'unit', lint: 'lint', typecheck: 'typecheck' };

export interface DetectedCheck { id: string; name: string; kind: string; command: string; probe: string; timeoutSec: number; affectedPaths: string[]; stack: string }

/** The checks a profile proposes: `unit:all`/`build` for the repository root, `unit:<folder>` for a stack in a folder. */
export function checksFromProfile(repoId: string, p: ProjectProfile): DetectedCheck[] {
  const out: DetectedCheck[] = [];
  const rootStacks = p.stacks.filter((s) => !s.dir && s.commands.length);
  for (const s of p.stacks) {
    const scope = s.dir ? s.dir.toLowerCase().replace(/[^a-z0-9/]+/g, '-').replace(/\//g, '.') : (rootStacks.length > 1 && rootStacks[0] !== s ? s.id : '');
    for (const c of s.commands) {
      const base = SLOT_NAME[c.slot];
      const name = scope ? `${base}:${scope}` : c.slot === 'test' ? 'unit:all' : base;
      if (out.some((x) => x.name === name)) continue;
      const command = s.dir ? `cd "${s.dir}" && ${c.command}` : c.command;
      const probe = s.dir && c.probe.includes('python') ? `cd "${s.dir}" && ${c.probe}` : c.probe;
      out.push({ id: `auto:${repoId}:${name}`, name, kind: SLOT_KIND[c.slot], command, probe, timeoutSec: c.timeoutSec, affectedPaths: s.dir ? [`${s.dir}/`] : [], stack: stackLine(s) });
    }
  }
  return out;
}

function runQuiet(command: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try { child = spawnShell(command, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ ok: false, out: String(e) }); return; }
    const t = setTimeout(() => { killProcessTree(child); resolve({ ok: false, out: `${out}\n(timed out)` }); }, timeoutMs);
    child.stdout?.on('data', (d) => { if (out.length < 4000) out += d; });
    child.stderr?.on('data', (d) => { if (out.length < 4000) out += d; });
    child.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out }); });
  });
}

const probeCache = new Map<string, { at: number; ok: boolean }>();

/** Is the tool a check needs installed here? (`<tool> --version`, cached for 10 minutes.) */
export async function toolAvailable(probe: string, cwd: string): Promise<boolean> {
  const key = `${cwd}|${probe}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.ok;
  const { ok } = await runQuiet(probe, cwd, 20_000);
  probeCache.set(key, { at: Date.now(), ok });
  return ok;
}

export interface StoredProfile { profile: ProjectProfile; checks: { name: string; command: string; stack: string; registered: boolean; why?: string }[]; at: string; ownerChecks: boolean }

export function storedProfile(repoId: string): StoredProfile | null {
  const r = q1('SELECT profile FROM repos WHERE id = ?', repoId);
  return r?.profile ? parseJson<StoredProfile | null>(r.profile as string, null) : null;
}

const memo = new Map<string, { at: number; p: ProjectProfile }>();

/** The profile for prompts: detected from the files (cheap, memoized), no tools probed. */
export function profileForPrompt(repo: Repo | null | undefined): ProjectProfile | null {
  if (!repo) return null;
  const hit = memo.get(repo.path);
  if (hit && Date.now() - hit.at < 30_000) return hit.p;
  let p: ProjectProfile | null = null;
  try { p = detectProfile(repo.path); } catch { p = storedProfile(repo.id)?.profile ?? null; }
  if (p) memo.set(repo.path, { at: Date.now(), p });
  return p;
}

/** The owner configured how this repository is verified: detected checks stay out of the way. */
export function ownerConfiguredChecks(repo: Repo): boolean {
  if (repo.buildCmd || repo.testCmd) return true;
  return !!q1(`SELECT 1 FROM checks WHERE repo_id = ? AND command != '' AND COALESCE(origin, 'owner') = 'owner' LIMIT 1`, repo.id);
}

/**
 * Detect the stacks and register the checks they offer (only those whose tool is installed here). Leaves owner-defined
 * checks alone; when the owner has any command check, nothing is registered. Re-detection replaces detected checks
 * that changed and removes those whose manifest is gone.
 */
export async function syncDetectedChecks(repo: Repo): Promise<StoredProfile> {
  const profile = detectProfile(repo.path);
  memo.set(repo.path, { at: Date.now(), p: profile });
  const ownerChecks = ownerConfiguredChecks(repo);
  // the office can turn detected checks off (workspace setting detectChecks: false); the profile still reaches prompts
  const ws = q1('SELECT settings FROM workspaces WHERE id = (SELECT workspace_id FROM repos WHERE id = ?)', repo.id);
  const off = parseJson<Record<string, unknown>>(ws?.settings as string, {}).detectChecks === false;
  const proposed = checksFromProfile(repo.id, profile);
  const listed: StoredProfile['checks'] = [];
  const keep = new Set<string>();
  for (const c of proposed) {
    if (ownerChecks || off) { listed.push({ name: c.name, command: c.command, stack: c.stack, registered: false, why: ownerChecks ? 'the owner configured checks for this repository' : 'detected checks are turned off for this office' }); continue; }
    const cwd = repo.path;
    if (!(await toolAvailable(c.probe, cwd))) { listed.push({ name: c.name, command: c.command, stack: c.stack, registered: false, why: `\`${c.probe}\` failed — tool not installed here` }); continue; }
    keep.add(c.id);
    const prev = q1('SELECT command FROM checks WHERE id = ?', c.id);
    if (!prev) {
      run(`INSERT INTO checks (id, repo_id, name, kind, command, parser, pass_rule, timeout_sec, affected_paths, protected, origin, baseline)
           VALUES (?,?,?,?,?,'exit0','exit0',?,?,0,'detected','')`, c.id, repo.id, c.name, c.kind, c.command, c.timeoutSec, JSON.stringify(c.affectedPaths));
    } else if (prev.command !== c.command) {
      run(`UPDATE checks SET command = ?, timeout_sec = ?, affected_paths = ?, baseline = '', baseline_tree = NULL WHERE id = ?`, c.command, c.timeoutSec, JSON.stringify(c.affectedPaths), c.id);
    }
    listed.push({ name: c.name, command: c.command, stack: c.stack, registered: true });
  }
  for (const r of q(`SELECT id FROM checks WHERE repo_id = ? AND origin = 'detected'`, repo.id)) {
    if (!keep.has(r.id as string)) run('DELETE FROM checks WHERE id = ?', r.id as string);
  }
  const stored: StoredProfile = { profile, checks: listed, at: new Date().toISOString(), ownerChecks };
  const before = storedProfile(repo.id);
  run('UPDATE repos SET profile = ?, check_profile_id = ? WHERE id = ?', JSON.stringify(stored), `auto:${profile.hash}`, repo.id);
  if (before?.profile.hash !== profile.hash || JSON.stringify(before?.checks) !== JSON.stringify(listed)) {
    emit('checks.detected', 'engine', { repoId: repo.id, stacks: profile.stacks.map(stackLine), domains: profile.domains,
      registered: listed.filter((c) => c.registered).map((c) => c.name), skipped: listed.filter((c) => !c.registered).map((c) => `${c.name}: ${c.why}`) }, null, repo.id);
  }
  return stored;
}

export type BaselineStatus = '' | 'pass' | 'fail' | 'error' | 'flaky';

/** Detected checks that may gate a delivery: they passed on the untouched repository. */
export function gatingAllowed(check: { origin?: string; baseline?: string }): boolean {
  return check.origin !== 'detected' || check.baseline === 'pass';
}

const baselines = new Map<string, Promise<void>>();

/**
 * Measure every detected check once on the repository as it is (before any task writes), unless the tree is the one
 * already measured. Runs in the background; writers and verification wait for it through baselineSettled().
 */
export function startBaseline(repo: Repo, runId: string, opts: { tree: () => Promise<string>; runCheck: (check: Record<string, unknown>) => Promise<{ status: string; summary: string }> }): Promise<void> {
  const busy = baselines.get(repo.id);
  if (busy) return busy;
  const p = (async () => {
    const pending = q(`SELECT * FROM checks WHERE repo_id = ? AND origin = 'detected'`, repo.id);
    if (!pending.length) return;
    let tree = '';
    try { tree = await opts.tree(); } catch { /* not a git tree: measure anyway */ }
    for (const c of pending) {
      if (tree && c.baseline_tree === tree && c.baseline) continue;
      try {
        const cr = await opts.runCheck(c);
        run('UPDATE checks SET baseline = ?, baseline_summary = ?, baseline_tree = ? WHERE id = ?', cr.status, String(cr.summary ?? '').slice(0, 300), tree || null, c.id as string);
        emit('checks.baseline', 'engine', { repoId: repo.id, check: c.name, status: cr.status, summary: cr.summary, gating: cr.status === 'pass' }, runId, c.id as string);
      } catch (e) {
        run(`UPDATE checks SET baseline = 'error', baseline_summary = ? WHERE id = ?`, String((e as Error)?.message ?? e).slice(0, 300), c.id as string);
      }
    }
  })().finally(() => { baselines.delete(repo.id); });
  baselines.set(repo.id, p);
  return p;
}

/** Wait (bounded) for a running baseline of this repository. Resolves at once when none is running. */
export async function baselineSettled(repoId: string, capMs = 20 * 60_000): Promise<boolean> {
  const p = baselines.get(repoId);
  if (!p) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([p.then(() => true, () => true), new Promise<boolean>((r) => { timer = setTimeout(() => r(false), capMs); })]);
  clearTimeout(timer);
  return done;
}

export function baselineRunning(repoId: string): boolean { return baselines.has(repoId); }

/** For the plan prompt: checks that exist but did not pass before this run, so the PM can decide about them. */
export function nonGatingNotes(repoId: string): string {
  const rows = q(`SELECT name, baseline, baseline_summary FROM checks WHERE repo_id = ? AND origin = 'detected' AND baseline NOT IN ('pass','')`, repoId);
  return rows.map((r) => `${r.name as string} did not pass before this run (${r.baseline as string}: ${String(r.baseline_summary ?? '').slice(0, 80)}) — it does not gate deliveries; putting it in the DoD means fixing it`).join('\n');
}
