import type { CommitInfo } from '../../core/models';
import {
  STARTER_PR_TEMPLATE_BODY,
  buildPrTemplateContext,
  commitMessageBody,
  extractBranchType,
  fillPrTemplate,
  firstFeatureCommit,
  insertAtCaret,
} from './pr-template';

function commit(partial: Partial<CommitInfo> & Pick<CommitInfo, 'subject'>): CommitInfo {
  return {
    sha: partial.sha ?? 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    shortSha: partial.shortSha ?? 'aaaaaaa',
    message: partial.message ?? partial.subject,
    subject: partial.subject,
    author: partial.author ?? 'Ada',
    email: partial.email ?? 'ada@example.com',
    timestamp: partial.timestamp ?? 1,
    parents: partial.parents ?? ['bbbbbbb'],
    refs: partial.refs ?? [],
    laneHint: 0,
    isRelativeToHead: true,
  };
}

describe('pr template', () => {
  const now = new Date('2026-08-21T15:04:00');

  function ctx(overrides: Partial<Parameters<typeof buildPrTemplateContext>[0]> = {}) {
    return buildPrTemplateContext({
      head: 'sotf/feature/sotf-1783-implement-barcode-for-better-rewards-card',
      base: 'develop',
      title: 'Implement barcode for better rewards card',
      ticket: 'SOTF-1783',
      ticketUrl: 'https://dischem-it.atlassian.net/browse/SOTF-1783',
      ticketSummary: 'Better rewards barcode',
      commitsNewestFirst: [
        commit({
          subject: 'Tweak scanner copy',
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          shortSha: 'ccccccc',
        }),
        commit({
          subject: 'Add barcode scanner',
          message: 'Add barcode scanner\n\nUse the camera preview on iOS.',
          sha: 'dddddddddddddddddddddddddddddddddddddddd',
          shortSha: 'ddddddd',
          author: 'Sean',
          email: 'sean@example.com',
        }),
      ],
      repo: 'rewards-app',
      now,
      ...overrides,
    });
  }

  it('fills jira, branch, first commit, and commit list tokens', () => {
    const filled = fillPrTemplate(STARTER_PR_TEMPLATE_BODY, ctx());
    expect(filled).toContain('Implement barcode for better rewards card');
    expect(filled).toContain('[SOTF-1783](https://dischem-it.atlassian.net/browse/SOTF-1783)');
    expect(filled).toContain('- Tweak scanner copy');
    expect(filled).toContain('- Add barcode scanner');
  });

  it('treats the oldest unique commit as the first commit', () => {
    const built = ctx();
    expect(built.first_commit).toBe('Add barcode scanner');
    expect(built.first_commit_body).toBe('Use the camera preview on iOS.');
    expect(built.first_commit_sha).toBe('ddddddd');
    expect(built.latest_commit).toBe('Tweak scanner copy');
    expect(built.commit_count).toBe('2');
    expect(firstFeatureCommit([])).toBeNull();
  });

  it('skips merge commits when picking the first commit', () => {
    const built = ctx({
      commitsNewestFirst: [
        commit({
          subject: "Merge branch 'develop' into feature/barcode",
          parents: ['aaa', 'bbb'],
        }),
        commit({ subject: 'Add barcode scanner', shortSha: 'ddddddd' }),
      ],
    });
    expect(built.first_commit).toBe('Add barcode scanner');
    expect(built.commit_count).toBe('1');
  });

  it('replaces KEY-123 placeholders and dummy Jira URLs in repo templates', () => {
    const source = [
      '## Jira Ticket',
      '[KEY-123](https://example.atlassian.net/browse/KEY-123)',
    ].join('\n');
    expect(fillPrTemplate(source, ctx())).toBe(
      [
        '## Jira Ticket',
        '[SOTF-1783](https://dischem-it.atlassian.net/browse/SOTF-1783)',
      ].join('\n'),
    );
  });

  it('leaves unknown tokens and dummy tickets when no Jira key exists', () => {
    const built = ctx({ ticket: '', ticketUrl: '', ticketSummary: '' });
    expect(fillPrTemplate('Ticket {jira} KEY-123 {unknown}', built)).toBe(
      'Ticket  KEY-123 {unknown}',
    );
  });

  it('does not eat {datetime} when filling {date}', () => {
    const filled = fillPrTemplate('{date} {datetime}', ctx());
    expect(filled).toBe('2026-08-21 2026-08-21-1504');
  });

  it('extracts a conventional branch type and commit bodies', () => {
    expect(extractBranchType('sotf/feature/sotf-1783-barcode')).toBe('feature');
    expect(extractBranchType('hotfix/login')).toBe('hotfix');
    expect(extractBranchType('main')).toBe('');
    expect(commitMessageBody('Add scanner\n\nDetails here.', 'Add scanner')).toBe('Details here.');
  });

  it('inserts at the caret', () => {
    expect(insertAtCaret('Hello world', '{jira}', 6, 6)).toEqual({
      next: 'Hello {jira}world',
      caret: 12,
    });
  });
});
