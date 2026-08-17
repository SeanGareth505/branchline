import { branchLeafName } from './mainline-branch';
import {
  DEFAULT_TICKET_FROM_BRANCH,
  extractBranchTopic,
  extractTicketFromBranch,
} from './ticket-from-branch';

export interface PrTitleCommit {
  subject?: string | null;
  parents?: string[] | null;
}

export function isMergeCommitSubject(subject: string): boolean {
  return /^(Merge (branch|remote-tracking branch|pull request)\b|Merged in \b)/i.test(
    subject.trim(),
  );
}

export function isMergeCommit(commit: PrTitleCommit): boolean {
  if ((commit.parents?.length ?? 0) > 1) return true;
  return isMergeCommitSubject(commit.subject ?? '');
}

export function fallbackPrTitle(branchName: string): string {
  const ticket = extractTicketFromBranch(branchName, DEFAULT_TICKET_FROM_BRANCH);
  const topic = extractBranchTopic(branchName, ticket)?.trim();
  if (topic) return topic;
  const leaf = branchLeafName(branchName).trim();
  if (leaf) return leaf.replace(/[-_]+/g, ' ');
  return 'Pull request';
}

export function defaultPrTitle(commitsNewestFirst: PrTitleCommit[], branchName: string): string {
  const unique = commitsNewestFirst.filter((commit) => !isMergeCommit(commit));
  if (unique.length === 1) {
    const subject = unique[0]?.subject?.trim();
    if (subject) return subject;
  }
  return fallbackPrTitle(branchName);
}
