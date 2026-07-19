#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const configPath = resolve(root, 'release.config.json');

function usage(exitCode = 0) {
  console.log(`Usage:
  npm run release -- <patch|minor|major|x.y.z> [options]
  npm run release -- --init [options]

Options:
  --dry-run          Show what would happen; write nothing
  --push             Push commit + tag to origin after tagging
  --no-push          Don't push, even if release.config.json sets "push": true
  --no-commit        Bump files only (no git commit/tag)
  --message <text>   Override commit message (supports {{version}}, {{productName}}, {{tag}})
  --tag-message <t>  Override annotated tag message (same placeholders)
  --preid <id>       With patch|minor|major, make a prerelease (e.g. beta → 0.2.0-beta.0)
  --allow-dirty      Skip clean working tree check
  --branch <name>    Required branch (default from release.config.json)
  --help             Show this help

Bootstrap (new projects / forks):
  --init             Write a starter release.config.json (won't overwrite an existing one)
  --force            With --init, overwrite an existing release.config.json
  --product-name <n> With --init, set productName (default: inferred from package.json)

Examples:
  npm run release -- --init
  npm run release -- patch
  npm run release -- minor --push
  npm run release -- 1.0.0 --push --message "Ship {{version}}"
  npm run release -- patch --preid beta --dry-run
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    bump: null,
    dryRun: false,
    push: false,
    noPush: false,
    noCommit: false,
    message: null,
    tagMessage: null,
    preid: null,
    allowDirty: false,
    branch: null,
    init: false,
    force: false,
    productName: null,
  };

  const rest = [...argv];
  while (rest.length) {
    const token = rest.shift();
    if (token === '--help' || token === '-h') usage(0);
    if (token === '--init') {
      args.init = true;
      continue;
    }
    if (token === '--force') {
      args.force = true;
      continue;
    }
    if (token === '--product-name') {
      args.productName = rest.shift() ?? null;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--push') {
      args.push = true;
      continue;
    }
    if (token === '--no-push') {
      args.noPush = true;
      continue;
    }
    if (token === '--no-commit') {
      args.noCommit = true;
      continue;
    }
    if (token === '--allow-dirty') {
      args.allowDirty = true;
      continue;
    }
    if (token === '--message') {
      args.message = rest.shift() ?? null;
      continue;
    }
    if (token === '--tag-message') {
      args.tagMessage = rest.shift() ?? null;
      continue;
    }
    if (token === '--preid') {
      args.preid = rest.shift() ?? null;
      continue;
    }
    if (token === '--branch') {
      args.branch = rest.shift() ?? null;
      continue;
    }
    if (token.startsWith('-')) {
      console.error(`Unknown option: ${token}`);
      usage(1);
    }
    if (args.bump) {
      console.error(`Unexpected argument: ${token}`);
      usage(1);
    }
    args.bump = token;
  }

  if (!args.init && !args.bump) usage(1);
  return args;
}

const DEFAULT_CONFIG = {
  productName: null,
  tagPrefix: 'v',
  branch: 'main',
  requireClean: true,
  push: false,
  commitMessage: 'Release {{version}}',
  tagMessage: '{{productName}} {{version}}',
  files: [{ path: 'package.json', kind: 'json', keys: ['version'] }],
};

function inferProductName() {
  try {
    const tauriConfPath = resolve(root, 'src-tauri/tauri.conf.json');
    if (existsSync(tauriConfPath)) {
      const tauriConf = readJson(tauriConfPath);
      if (tauriConf.productName) return tauriConf.productName;
    }
  } catch {
    // ignore, fall through to package.json
  }
  try {
    const pkg = readJson(resolve(root, 'package.json'));
    if (pkg.name) return pkg.name;
  } catch {
    // ignore, fall back to a generic placeholder below
  }
  return 'App';
}

function initConfig(args) {
  if (existsSync(configPath) && !args.force) {
    throw new Error(
      `${configPath} already exists. Use --force to overwrite, or edit it directly.`,
    );
  }

  const starter = {
    ...DEFAULT_CONFIG,
    productName: args.productName || inferProductName(),
  };

  writeJson(configPath, starter);
  console.log(`Wrote ${configPath}`);
  console.log('Next steps:');
  console.log('  1. Review "files" — list every file that stores a version to keep in sync.');
  console.log('  2. Adjust tagPrefix, branch, commitMessage, tagMessage to taste.');
  console.log('  3. See release.config.example.jsonc for a fully annotated reference.');
  console.log('  4. Run: npm run release -- patch --dry-run');
}

function loadConfig() {
  if (!existsSync(configPath)) {
    throw new Error(
      `Missing ${configPath}\n` +
        'Bootstrap one with: node scripts/release.mjs --init\n' +
        '(or copy release.config.example.jsonc to release.config.json and edit it).',
    );
  }
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath, 'utf8')) };
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`${cmd} ${cmdArgs.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return (result.stdout || '').trim();
}

function parseSemver(version) {
  const match = String(version).trim().match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/,
  );
  if (!match) throw new Error(`Invalid semver: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
    build: match[5] ?? null,
  };
}

function formatSemver(parts) {
  let out = `${parts.major}.${parts.minor}.${parts.patch}`;
  if (parts.prerelease?.length) out += `-${parts.prerelease.join('.')}`;
  if (parts.build) out += `+${parts.build}`;
  return out;
}

function bumpVersion(current, bump, preid) {
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(bump)) {
    return bump.replace(/^\s+|\s+$/g, '');
  }

  const parsed = parseSemver(current);
  if (!['patch', 'minor', 'major'].includes(bump)) {
    throw new Error(`Unknown bump "${bump}". Use patch, minor, major, or an explicit x.y.z`);
  }

  if (preid) {
    const samePre =
      parsed.prerelease[0] === preid &&
      parsed.prerelease.length >= 2 &&
      /^\d+$/.test(parsed.prerelease[1]);
    if (samePre) {
      parsed.prerelease = [preid, String(Number(parsed.prerelease[1]) + 1)];
    } else {
      if (bump === 'major') {
        parsed.major += 1;
        parsed.minor = 0;
        parsed.patch = 0;
      } else if (bump === 'minor') {
        parsed.minor += 1;
        parsed.patch = 0;
      } else {
        parsed.patch += 1;
      }
      parsed.prerelease = [preid, '0'];
    }
    parsed.build = null;
    return formatSemver(parsed);
  }

  if (parsed.prerelease.length) {
    parsed.prerelease = [];
    parsed.build = null;
    return formatSemver(parsed);
  }

  if (bump === 'major') {
    parsed.major += 1;
    parsed.minor = 0;
    parsed.patch = 0;
  } else if (bump === 'minor') {
    parsed.minor += 1;
    parsed.patch = 0;
  } else {
    parsed.patch += 1;
  }
  return formatSemver(parsed);
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

function applyFiles(files, version, dryRun) {
  const changed = [];
  for (const file of files) {
    const path = resolve(root, file.path);
    if (!existsSync(path)) throw new Error(`Missing file: ${file.path}`);
    if (dryRun) {
      changed.push(file.path);
      continue;
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

function template(text, vars) {
  let out = String(text);
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value ?? '');
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.init) {
    initConfig(args);
    return;
  }

  const config = loadConfig();
  const branch = args.branch || config.branch || 'main';
  const requireClean = args.allowDirty ? false : config.requireClean !== false;
  const tagPrefix = config.tagPrefix ?? 'v';
  const productName = config.productName || inferProductName();
  const shouldPush = args.push || (!args.noPush && config.push === true);

  const pkg = readJson(resolve(root, 'package.json'));
  const current = pkg.version;
  const next = bumpVersion(current, args.bump, args.preid);
  const tag = `${tagPrefix}${next}`;
  const vars = { version: next, previousVersion: current, tag, productName };

  console.log(`Current: ${current}`);
  console.log(`Next:    ${next}`);
  console.log(`Tag:     ${tag}`);

  if (!args.noCommit && !args.dryRun) {
    const currentBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (currentBranch !== branch) {
      throw new Error(`On branch "${currentBranch}", expected "${branch}"`);
    }
    if (requireClean) {
      const dirty = run('git', ['status', '--porcelain']);
      if (dirty) throw new Error('Working tree is dirty. Commit/stash first, or pass --allow-dirty.');
    }
    const existing = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (existing.status === 0) {
      throw new Error(`Tag ${tag} already exists`);
    }
  }

  const changed = applyFiles(config.files ?? [], next, args.dryRun);
  console.log(`Files:   ${changed.join(', ')}`);

  if (args.noCommit) {
    console.log(args.dryRun ? 'Dry run: files not written.' : 'Version files updated (--no-commit).');
    return;
  }

  const commitMessage = template(args.message || config.commitMessage || 'Release {{version}}', vars);
  const tagMessage = template(args.tagMessage || config.tagMessage || commitMessage, vars);

  if (args.dryRun) {
    console.log(`Would commit: ${commitMessage}`);
    console.log(`Would tag:    ${tag} (${tagMessage})`);
    console.log(shouldPush ? 'Would push:   origin HEAD + tags' : 'Would push:   (skipped)');
    return;
  }

  run('git', ['add', '--', ...changed]);
  run('git', ['commit', '-m', commitMessage], { stdio: 'inherit' });
  run('git', ['tag', '-a', tag, '-m', tagMessage], { stdio: 'inherit' });
  console.log(`Created tag ${tag}`);

  if (shouldPush) {
    run('git', ['push', 'origin', 'HEAD', '--tags'], { stdio: 'inherit' });
    console.log('Pushed commit and tags to origin.');
  } else {
    console.log('Skipped push. Run with --push when ready, or: git push origin HEAD --tags');
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
