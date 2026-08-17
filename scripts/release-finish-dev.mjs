#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(root, 'release.config.json'), 'utf8'));

function parseArgs(argv) {
  const options = {
    version: '',
    tag: '',
    tagMessage: '',
    commitMessage: '',
    push: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--push') {
      options.push = true;
      continue;
    }
    if (arg === '--version' || arg === '--tag' || arg === '--tag-message' || arg === '--commit-message') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}.`);
      }
      if (arg === '--version') options.version = value;
      if (arg === '--tag') options.tag = value;
      if (arg === '--tag-message') options.tagMessage = value;
      if (arg === '--commit-message') options.commitMessage = value;
      index += 1;
      continue;
    }
    if (!arg.startsWith('--') && !options.version) {
      options.version = arg;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.version) {
    throw new Error('Usage: node scripts/release-finish-dev.mjs --version <semver> --tag <tag> --tag-message <message> [--push]');
  }
  if (!options.tag) {
    options.tag = `v${options.version}`;
  }
  if (!options.tagMessage) {
    options.tagMessage = `Branchline ${options.version}`;
  }
  if (!options.commitMessage) {
    options.commitMessage = `Release ${options.version}`;
  }
  return options;
}

function git(args, extra = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', extra.capture ? 'pipe' : 'inherit', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `git ${args.join(' ')} failed.`);
  }
  return (result.stdout || '').trim();
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
  const pattern = new RegExp(
    `(name = "${packageName}"\\nversion = )"([^"]*)"`,
  );
  if (!pattern.test(text)) {
    throw new Error(`Could not find package "${packageName}" in ${path}`);
  }
  writeFileSync(path, text.replace(pattern, `$1"${version}"`));
}

function applyFiles(version) {
  const changed = [];
  for (const file of config.files ?? []) {
    const path = join(root, file.path);
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

function tagExists(tag) {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log(`Finishing tauri:dev release ${options.version} (${options.tag}).`);
  const changed = applyFiles(options.version);
  console.log(`Updated: ${changed.join(', ')}`);
  git(['add', '--', ...changed]);
  git(['commit', '-m', options.commitMessage]);
  if (tagExists(options.tag)) {
    git(['tag', '-d', options.tag]);
  }
  git(['tag', '-a', options.tag, '-m', options.tagMessage]);
  if (options.push) {
    git(['push', 'origin', 'HEAD']);
    git(['push', 'origin', options.tag]);
  }
  console.log(`Tagged ${options.tag} at ${git(['rev-parse', 'HEAD'], { capture: true })}.`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
