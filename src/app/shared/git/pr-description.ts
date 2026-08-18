import type { CommitInfo } from '../../core/models';
import { isMergeCommit } from './pr-title';

export function fallbackPrDescription(head: string, base: string): string {
  const headLabel = head.trim() || 'branch';
  const baseLabel = base.trim() || 'main';
  return [
    '## Summary',
    '',
    `Merges \`${headLabel}\` into \`${baseLabel}\`.`,
    '',
    '## Test plan',
    '',
    '- [ ] ',
  ].join('\n');
}

export function defaultPrDescription(
  commitsNewestFirst: CommitInfo[],
  head: string,
  base: string,
): string {
  const commits = commitsNewestFirst.filter((commit) => !isMergeCommit(commit));
  const headLabel = head.trim() || 'branch';
  const baseLabel = base.trim() || 'main';
  const lines: string[] = ['## Summary', ''];

  if (commits.length === 1) {
    lines.push(commits[0].subject.trim() || `Merges \`${headLabel}\` into \`${baseLabel}\`.`);
  } else if (commits.length > 1) {
    lines.push(`Merges \`${headLabel}\` into \`${baseLabel}\` (${commits.length} commits).`);
  } else {
    lines.push(`Merges \`${headLabel}\` into \`${baseLabel}\`.`);
  }

  if (commits.length > 0) {
    lines.push('', '## Changes', '');
    for (const commit of commits) {
      const subject = commit.subject.trim();
      if (subject) lines.push(`- ${subject}`);
    }
  }

  lines.push('', '## Test plan', '', '- [ ] ');
  return lines.join('\n');
}
