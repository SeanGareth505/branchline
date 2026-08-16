#!/usr/bin/env node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const tag = process.argv[2] || process.env.TAG;
const repo = process.env.GITHUB_REPOSITORY || process.argv[3];
if (!tag || !repo) {
  console.error('Usage: node scripts/fix-updater-latest-json.mjs <tag> [owner/repo]');
  process.exit(1);
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout;
}

const assetsJson = run('gh', ['release', 'view', tag, '-R', repo, '--json', 'assets']);
const assets = JSON.parse(assetsJson).assets ?? [];
const idToBrowser = new Map();
for (const asset of assets) {
  const browser = asset.url;
  if (!browser) continue;
  const api = String(asset.apiUrl || '');
  const idMatch = api.match(/\/assets\/(\d+)/);
  if (idMatch) idToBrowser.set(idMatch[1], browser);
  if (asset.id != null) idToBrowser.set(String(asset.id), browser);
}

const latestAsset = assets.find((asset) => asset.name === 'latest.json');
if (!latestAsset?.url) {
  throw new Error(`latest.json is not on ${tag}`);
}

const dir = mkdtempSync(join(tmpdir(), 'branchline-latest-'));
const download = spawnSync(
  'gh',
  ['release', 'download', tag, '-R', repo, '-p', 'latest.json', '-D', dir],
  { encoding: 'utf8' },
);
if (download.status !== 0) {
  throw new Error(`Could not download latest.json:\n${(download.stderr || download.stdout || '').trim()}`);
}

const latestPath = join(dir, 'latest.json');
const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
let changed = 0;
for (const platform of Object.values(latest.platforms ?? {})) {
  if (!platform || typeof platform !== 'object') continue;
  const url = String(platform.url || '');
  const match = url.match(/\/releases\/assets\/(\d+)/);
  if (!match) continue;
  const next = idToBrowser.get(match[1]);
  if (next && next !== url) {
    platform.url = next;
    changed += 1;
  }
}

if (!changed) {
  console.log('latest.json already uses public download URLs');
  process.exit(0);
}

writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
run('gh', ['release', 'upload', tag, latestPath, '-R', repo, '--clobber']);
console.log(`Rewrote ${changed} updater URL(s) on ${tag}`);
