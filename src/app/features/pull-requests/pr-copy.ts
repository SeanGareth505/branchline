import type { MockPullRequest, PrCopyFormat } from '../../core/models';
import {
  prApprovals,
  prChangesRequested,
  prCheckFailed,
  prCheckPassed,
  prCheckPending,
  prCheckTotal,
  prReadyToMerge,
} from '../../core/models';

export function formatPullRequests(prs: MockPullRequest[], format: PrCopyFormat): string {
  if (!prs.length) return '';
  switch (format) {
    case 'links':
      return prs.map((pr) => pr.url).filter(Boolean).join('\n');
    case 'titles':
      return prs.map((pr) => `#${pr.number} ${pr.title}`).join('\n');
    case 'refs':
      return prs.map((pr) => `${prRef(pr)} ${pr.title}`).join('\n');
    case 'checkout':
      return prs
        .map((pr) => `git fetch origin pull/${pr.number}/head:pr/${pr.number} && git checkout pr/${pr.number}`)
        .join('\n');
    case 'markdown':
      return prs.map((pr) => `- [#${pr.number}](${pr.url}) ${pr.title} — ${prLine(pr)}`).join('\n');
    case 'slack':
      return prs.map((pr) => `• <${pr.url}|#${pr.number} ${pr.title}> — ${prLine(pr)}`).join('\n');
    case 'standup':
      return formatStandup(prs);
    case 'csv':
      return [
        'number,title,author,status,reviews,checks,url',
        ...prs.map((pr) =>
          [
            pr.number,
            csv(pr.title),
            csv(pr.author),
            pr.draft ? 'draft' : pr.status,
            csv(reviewLine(pr)),
            csv(checkLine(pr)),
            csv(pr.url),
          ].join(','),
        ),
      ].join('\n');
  }
}

function prRef(pr: MockPullRequest): string {
  return pr.repo ? `${pr.repo}#${pr.number}` : `#${pr.number}`;
}

function prLine(pr: MockPullRequest): string {
  return [`@${pr.author}`, reviewLine(pr), checkLine(pr)].filter(Boolean).join(' · ');
}

export function reviewLine(pr: MockPullRequest): string {
  const approved = prApprovals(pr);
  const changes = prChangesRequested(pr);
  const parts: string[] = [];
  if (approved) parts.push(`${approved} approved`);
  if (changes) parts.push(`${changes} requested changes`);
  if (!parts.length) {
    if (pr.reviewState === 'pending') return 'review pending';
    if (pr.reviewState === 'approved') return 'approved';
    if (pr.reviewState === 'changesRequested') return 'changes requested';
    return 'no reviews';
  }
  return parts.join(', ');
}

export function checkLine(pr: MockPullRequest): string {
  if (pr.checkSummary) return pr.checkSummary;
  const total = prCheckTotal(pr);
  if (total > 0) {
    if (prCheckFailed(pr) > 0) return `${prCheckFailed(pr)} failing / ${total} checks`;
    if (prCheckPending(pr) > 0) return `${prCheckPending(pr)} running / ${total} checks`;
    return `${prCheckPassed(pr)}/${total} checks`;
  }
  if (pr.pipelineStatus === 'success') return 'checks passed';
  if (pr.pipelineStatus === 'failure') return 'checks failing';
  if (pr.pipelineStatus === 'pending') return 'checks running';
  if (pr.pipelineStatus === 'cancelled') return 'checks cancelled';
  return 'no checks';
}

function formatStandup(prs: MockPullRequest[]): string {
  const groups = new Map<string, MockPullRequest[]>();
  for (const pr of prs) {
    const key = pr.author || 'unknown';
    const list = groups.get(key) ?? [];
    list.push(pr);
    groups.set(key, list);
  }
  const lines: string[] = [];
  for (const [author, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`@${author}`);
    for (const pr of list) {
      const flags: string[] = [];
      if (prReadyToMerge(pr)) flags.push('ready');
      else if (prCheckFailed(pr) > 0 || pr.pipelineStatus === 'failure') flags.push('CI failing');
      else if (prChangesRequested(pr) > 0) flags.push('changes requested');
      else if (pr.draft) flags.push('draft');
      else if (pr.needsMyReview) flags.push('needs review');
      lines.push(`  #${pr.number} ${pr.title}${flags.length ? ` (${flags.join(', ')})` : ''} ${pr.url}`);
    }
  }
  return lines.join('\n');
}

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function sharedRepoPrefix(names: string[]): string {
  if (names.length < 2) return '';
  const lower = names.map((n) => n.toLowerCase());
  let i = 0;
  const first = lower[0];
  while (i < first.length && lower.every((n) => n[i] === first[i])) i++;
  const raw = names[0].slice(0, i);
  const cut = Math.max(raw.lastIndexOf('-'), raw.lastIndexOf('/'), raw.lastIndexOf('_'));
  if (cut <= 0) return '';
  return names[0].slice(0, cut + 1);
}
