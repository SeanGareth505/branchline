#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const configPath = resolve(root, 'release.config.json');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(detail || `${cmd} ${args.join(' ')} failed`);
  }
  return (result.stdout || '').trim();
}

function parseArgs(argv) {
  let version = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version') {
      version = argv[i + 1] ?? null;
      i += 1;
    }
  }
  if (!version) {
    throw new Error('Missing --version');
  }
  return { version };
}

function loadConfig() {
  if (!existsSync(configPath)) {
    throw new Error('Missing release.config.json');
  }
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

function shouldFinishInBackground(file) {
  if (file.kind === 'toml-package-version' || file.kind === 'cargo-lock-package') {
    return true;
  }
  return String(file.path).replace(/\\/g, '/').startsWith('src-tauri/');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function setJsonKeys(path, keys, version) {
  const data = readJson(path);
  for (const key of keys) {
    const parts = key.split('.');
    let cursor = data;
    for (let i = 0; i < parts.length - 1; i++) {
      cursor = cursor[parts[i]];
      if (cursor == null || typeof cursor !== 'object') {
        throw new Error(`Cannot set ${key} in ${path}`);
      }
    }
    cursor[parts[parts.length - 1]] = version;
  }
  writeJson(path, data);
}

function setTomlPackageVersion(path, version) {
  const text = readFileSync(path, 'utf8');
  const next = text.replace(
    /^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m,
    `$1"${version}"`,
  );
  if (next === text) {
    throw new Error(`Could not find [package] version in ${path}`);
  }
  writeFileSync(path, next);
}

function setCargoLockPackageVersion(path, packageName, version) {
  const text = readFileSync(path, 'utf8');
  const pattern = new RegExp(`(name = "${packageName}"\\nversion = )"([^"]*)"`);
  if (!pattern.test(text)) {
    throw new Error(`Could not find package "${packageName}" in ${path}`);
  }
  writeFileSync(path, text.replace(pattern, `$1"${version}"`));
}

function applyFiles(files, version) {
  const changed = [];
  for (const file of files) {
    const path = resolve(root, file.path);
    if (!existsSync(path)) {
      throw new Error(`Missing file: ${file.path}`);
    }
    switch (file.kind) {
      case 'json':
        setJsonKeys(path, file.keys ?? ['version'], version);
        break;
      case 'toml-package-version':
        setTomlPackageVersion(path, version);
        break;
      case 'cargo-lock-package':
        setCargoLockPackageVersion(path, file.package ?? 'app', version);
        break;
      default:
        throw new Error(`Unknown file kind "${file.kind}" for ${file.path}`);
    }
    changed.push(file.path);
  }
  return changed;
}

function main() {
  const { version } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const pending = (config.files ?? []).filter(shouldFinishInBackground);
  if (!pending.length) {
    run('git', ['push', 'origin', 'HEAD', '--tags']);
    return;
  }
  const changed = applyFiles(pending, version);
  if (changed.length) {
    run('git', ['add', '--', ...changed]);
    run('git', ['commit', '--amend', '--no-edit']);
  }
  run('git', ['push', 'origin', 'HEAD', '--tags']);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
