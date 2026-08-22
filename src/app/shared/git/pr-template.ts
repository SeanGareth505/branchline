import type { CommitInfo } from '../../core/models';
import { slugifyUser } from '../../core/workflow-placeholders';
import { isMergeCommit } from './pr-title';
import { branchSegments, extractBranchSlug, extractBranchTopic } from './ticket-from-branch';

export interface PrTemplateContext {
  title: string;
  branch: string;
  head: string;
  name: string;
  base: string;
  topic: string;
  slug: string;
  type: string;
  jira: string;
  ticket: string;
  jira_url: string;
  ticket_url: string;
  jira_link: string;
  jira_summary: string;
  first_commit: string;
  first_commit_body: string;
  first_commit_sha: string;
  latest_commit: string;
  commits: string;
  commit_count: string;
  author: string;
  email: string;
  user: string;
  repo: string;
  date: string;
  datetime: string;
  yyyy: string;
  mm: string;
  dd: string;
}

export interface PrTemplateToken {
  token: string;
  label: string;
  hint: string;
}

export const PR_TEMPLATE_TOKENS: readonly PrTemplateToken[] = [
  { token: '{title}', label: 'Title', hint: 'Suggested pull request title' },
  { token: '{branch}', label: 'Branch', hint: 'Source branch name' },
  { token: '{base}', label: 'Base', hint: 'Target branch name' },
  { token: '{topic}', label: 'Topic', hint: 'Humanized branch topic' },
  { token: '{slug}', label: 'Slug', hint: 'Branch leaf without the ticket' },
  { token: '{type}', label: 'Type', hint: 'feature, fix, hotfix, …' },
  { token: '{jira}', label: 'Jira', hint: 'Ticket key from the branch' },
  { token: '{jira_link}', label: 'Jira link', hint: 'Markdown Jira link' },
  { token: '{jira_url}', label: 'Jira URL', hint: 'Jira browse URL' },
  { token: '{jira_summary}', label: 'Jira summary', hint: 'Linked Jira issue summary' },
  { token: '{first_commit}', label: 'First commit', hint: 'Oldest unique commit subject' },
  { token: '{first_commit_body}', label: 'Commit body', hint: 'Oldest unique commit body' },
  { token: '{first_commit_sha}', label: 'SHA', hint: 'Oldest unique commit short SHA' },
  { token: '{latest_commit}', label: 'Latest commit', hint: 'Newest unique commit subject' },
  { token: '{commits}', label: 'Commits', hint: 'Bullet list of commit subjects' },
  { token: '{commit_count}', label: 'Count', hint: 'Number of unique commits' },
  { token: '{author}', label: 'Author', hint: 'Git author name' },
  { token: '{email}', label: 'Email', hint: 'Git author email' },
  { token: '{user}', label: 'User', hint: 'Git user slug' },
  { token: '{repo}', label: 'Repo', hint: 'Repository name' },
  { token: '{date}', label: 'Date', hint: 'Today YYYY-MM-DD' },
];

export const STARTER_PR_TEMPLATE_TITLE = '{title}';

export const STARTER_PR_TEMPLATE_BODY = [
  '## Description',
  '',
  '{topic}',
  '',
  '## Jira Ticket',
  '',
  '{jira_link}',
  '',
  '## Changes',
  '',
  '{commits}',
  '',
  '## Screenshots',
  '',
  '## Test plan',
  '',
  '- [ ] ',
].join('\n');

const BRANCH_TYPE =
  /^(feat|feature|features|fix|fixes|bugfix|hotfix|chore|docs|doc|refactor|perf|test|tests|ci|build|release|releases)$/i;

const DUMMY_TICKET = /\b(KEY|TICKET|PROJ|PROJECT|XXX|JIRA)-\d+\b/gi;
const DUMMY_BROWSE =
  /https?:\/\/[^\s)]+\/browse\/(?:KEY|TICKET|PROJ|PROJECT|XXX|JIRA)-\d+/gi;

export function uniquePrCommits(commitsNewestFirst: CommitInfo[]): CommitInfo[] {
  return commitsNewestFirst.filter((commit) => !isMergeCommit(commit));
}

export function firstFeatureCommit(commitsNewestFirst: CommitInfo[]): CommitInfo | null {
  return uniquePrCommits(commitsNewestFirst).at(-1) ?? null;
}

export function latestFeatureCommit(commitsNewestFirst: CommitInfo[]): CommitInfo | null {
  return uniquePrCommits(commitsNewestFirst)[0] ?? null;
}

export function commitMessageBody(message: string, subject: string): string {
  const text = message.replace(/\r\n/g, '\n');
  const first = subject.trim();
  if (!text.trim()) return '';
  if (first && text.startsWith(first)) {
    return text.slice(first.length).replace(/^\n+/, '').trim();
  }
  const nl = text.indexOf('\n');
  return nl < 0 ? '' : text.slice(nl + 1).trim();
}

export function extractBranchType(branch: string): string {
  const found = branchSegments(branch).find((part) => BRANCH_TYPE.test(part));
  return found?.toLowerCase() ?? '';
}

export function formatCommitBullets(commitsNewestFirst: CommitInfo[]): string {
  const lines = uniquePrCommits(commitsNewestFirst)
    .map((commit) => commit.subject.trim())
    .filter(Boolean)
    .map((subject) => `- ${subject}`);
  return lines.join('\n');
}

export function emptyPrTemplateContext(): PrTemplateContext {
  return {
    title: '',
    branch: '',
    head: '',
    name: '',
    base: '',
    topic: '',
    slug: '',
    type: '',
    jira: '',
    ticket: '',
    jira_url: '',
    ticket_url: '',
    jira_link: '',
    jira_summary: '',
    first_commit: '',
    first_commit_body: '',
    first_commit_sha: '',
    latest_commit: '',
    commits: '',
    commit_count: '0',
    author: '',
    email: '',
    user: '',
    repo: '',
    date: '',
    datetime: '',
    yyyy: '',
    mm: '',
    dd: '',
  };
}

export function buildPrTemplateContext(input: {
  head: string;
  base: string;
  title: string;
  ticket: string;
  ticketUrl: string;
  ticketSummary: string;
  commitsNewestFirst: CommitInfo[];
  author?: string;
  email?: string;
  repo?: string;
  now?: Date;
}): PrTemplateContext {
  const head = input.head.trim();
  const ticket = input.ticket.trim();
  const ticketUrl = input.ticketUrl.trim();
  const unique = uniquePrCommits(input.commitsNewestFirst);
  const first = unique.at(-1) ?? null;
  const latest = unique[0] ?? null;
  const author = (first?.author || input.author || '').trim();
  const email = (first?.email || input.email || '').trim();
  const now = input.now ?? new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const date = `${yyyy}-${mm}-${dd}`;
  const jiraLink = ticket ? (ticketUrl ? `[${ticket}](${ticketUrl})` : ticket) : '';

  return {
    title: input.title.trim(),
    branch: head,
    head,
    name: head,
    base: input.base.trim(),
    topic: extractBranchTopic(head, ticket) ?? '',
    slug: extractBranchSlug(head, ticket) ?? '',
    type: extractBranchType(head),
    jira: ticket,
    ticket,
    jira_url: ticketUrl,
    ticket_url: ticketUrl,
    jira_link: jiraLink,
    jira_summary: input.ticketSummary.trim(),
    first_commit: first?.subject.trim() ?? '',
    first_commit_body: first ? commitMessageBody(first.message, first.subject) : '',
    first_commit_sha: first?.shortSha?.trim() || first?.sha.slice(0, 7) || '',
    latest_commit: latest?.subject.trim() ?? '',
    commits: formatCommitBullets(input.commitsNewestFirst),
    commit_count: String(unique.length),
    author,
    email,
    user: slugifyUser(author),
    repo: (input.repo || '').trim(),
    date,
    datetime: `${date}-${hh}${mi}`,
    yyyy,
    mm,
    dd,
  };
}

export function fillPrTemplate(text: string, ctx: PrTemplateContext): string {
  const values = ctx as unknown as Record<string, string>;
  const filled = text.replace(/\{([a-z_]+)\}/gi, (full, key: string) => {
    const value = values[key.toLowerCase()];
    return value === undefined ? full : value;
  });
  return fillDummyTickets(filled, ctx);
}

export function insertAtCaret(
  value: string,
  insert: string,
  start: number | null | undefined,
  end: number | null | undefined,
): { next: string; caret: number } {
  const from = Math.max(0, start ?? value.length);
  const to = Math.max(from, end ?? from);
  const next = `${value.slice(0, from)}${insert}${value.slice(to)}`;
  return { next, caret: from + insert.length };
}

function fillDummyTickets(text: string, ctx: PrTemplateContext): string {
  const ticket = ctx.ticket.trim();
  if (!ticket) return text;
  let out = text;
  if (ctx.ticket_url) {
    out = out.replace(DUMMY_BROWSE, ctx.ticket_url);
  }
  return out.replace(DUMMY_TICKET, (match) =>
    match.toUpperCase() === ticket.toUpperCase() ? match : ticket,
  );
}
