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

const version = tag.replace(/^v/i, '');
const previous = previousTag(tag);
const range = previous ? `${previous}..${tag}` : tag;
const subjects = git(['log', '--pretty=format:%s', range])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !/^Release\s/i.test(line) && !/^Merge\b/i.test(line))
  .map(sentence);

const lines = [`## What's new in ${version}`, ''];
if (subjects.length) {
  for (const item of subjects) {
    lines.push(`- ${item}`);
  }
} else {
  lines.push('_No user-facing changes in this range._');
}
lines.push('');
if (previous) {
  lines.push(`**Full changelog:** \`${previous}\` → \`${tag}\``, '');
}

process.stdout.write(`${lines.join('\n').trimEnd()}\n`);
