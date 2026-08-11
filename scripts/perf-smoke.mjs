#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const repo = process.argv[2] || root;

function run(args) {
  const started = Date.now();
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const ms = Date.now() - started;
  if (result.status !== 0) {
    return { ok: false, ms, error: (result.stderr || result.stdout || '').trim() };
  }
  return { ok: true, ms, bytes: (result.stdout || '').length };
}

if (!existsSync(resolve(repo, '.git')) && !existsSync(resolve(repo, '.git'))) {
  // worktree .git file still ok via git -C
}

const checks = [
  ['status', '--porcelain=v2', '--branch', '--ignore-submodules=dirty', '--untracked-files=normal'],
  ['status', '--porcelain=v2', '--branch', '--ignore-submodules=dirty', '--untracked-files=no'],
  ['log', '--max-count=200', '--pretty=format:%H', '--all'],
  ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
];

console.log(`Branchline perf smoke · ${repo}`);
let failed = false;
for (const args of checks) {
  const result = run(args);
  const label = args.join(' ');
  if (!result.ok) {
    failed = true;
    console.log(`FAIL  ${result.ms}ms  ${label}`);
    console.log(`      ${result.error}`);
    continue;
  }
  const warn = result.ms > 1500 ? ' SLOW' : '';
  console.log(`ok    ${String(result.ms).padStart(5)}ms  ${label}${warn}  (${result.bytes} bytes)`);
}

if (failed) process.exit(1);
