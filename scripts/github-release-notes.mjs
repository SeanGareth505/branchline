#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const tag = process.argv[2] || process.env.TAG;
if (!tag) {
  console.error('Usage: node scripts/github-release-notes.mjs <tag>');
  process.exit(1);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args.join(' ')}`).trim());
  }
  return (result.stdout || '').trim();
}

function previousTag(current) {
  try {
    return git(['describe', '--tags', '--abbrev=0', '--match', 'v*', `${current}^`]);
  } catch {
    return '';
  }
}

function sentence(value) {
  const text = value.trim().replace(/\.+$/, '');
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const CONVENTIONAL_RE =
  /^(?<type>[a-z][a-z0-9-]*)(?<scope>\([^)]+\))?(?<breaking>!)?:\s*(?<summary>.+)$/i;

const SECTION_ORDER = ['Breaking', 'Added', 'Improved', 'Fixed', 'Removed', 'Deprecated', 'Security'];

function classify(subject) {
  const first = (subject.split('\n')[0] ?? '').trim();
  if (!first || /^Release\s/i.test(first) || /^Merge\b/i.test(first)) return null;
  const match = first.match(CONVENTIONAL_RE);
  const type = match?.groups?.type?.toLowerCase() ?? '';
  const summary = (match?.groups?.summary ?? first).trim();
  if (['chore', 'ci', 'build', 'test', 'tests'].includes(type)) return null;
  const breaking = !!match?.groups?.breaking;
  let section = 'Improved';
  if (breaking || type === 'breaking') section = 'Breaking';
  else if (['feat', 'feature', 'add'].includes(type) || /^(add|added|give|let|notify|support|enable)\b/i.test(summary)) {
    section = 'Added';
  } else if (['fix', 'bugfix'].includes(type) || /^(fix|fixed|fixes|open)\b/i.test(summary)) {
    section = 'Fixed';
  } else if (['remove', 'removed'].includes(type) || /^(remove|drop|delete)\b/i.test(summary)) {
    section = 'Removed';
  } else if (type === 'security') section = 'Security';
  else if (['deprecate', 'deprecated'].includes(type)) section = 'Deprecated';
  return { section, summary: sentence(summary) };
}

const version = tag.replace(/^v/i, '');
const previous = previousTag(tag);
const range = previous ? `${previous}..${tag}` : tag;
const items = git(['log', '--pretty=format:%s', range])
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map(classify)
  .filter((item) => !!item);

const grouped = new Map(SECTION_ORDER.map((name) => [name, []]));
for (const item of items) {
  grouped.get(item.section)?.push(item.summary);
}

const lines = [`## What's new in ${version}`, ''];
let wrote = false;
for (const section of SECTION_ORDER) {
  const bullets = [...new Set(grouped.get(section) ?? [])];
  if (!bullets.length) continue;
  lines.push(`### ${section}`, '');
  for (const bullet of bullets) lines.push(`- ${bullet}`);
  lines.push('');
  wrote = true;
}
if (!wrote) {
  lines.push('_No user-facing changes in this range._', '');
}
if (previous) {
  lines.push(`**Full changelog:** \`${previous}\` → \`${tag}\``, '');
}

process.stdout.write(`${lines.join('\n').trimEnd()}\n`);
