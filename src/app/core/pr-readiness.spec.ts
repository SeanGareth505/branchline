import {
  prBodyDisplay,
  prBodyExcerpt,
  prBodySegments,
  prCodeThreads,
  prConversationThreads,
  prDiffHunkPreview,
  prMergeBlockReason,
  prReadyToMerge,
  prReviewerGroups,
  prReviewerInitials,
  prReviewerPeople,
  prReviewerSummary,
  prReviewStateLabel,
} from './models';
import type { MockPullRequest } from './models';

function pr(partial: Partial<MockPullRequest> = {}): MockPullRequest {
  return {
    id: partial.id ?? '1',
    number: partial.number ?? 1,
    title: partial.title ?? 'PR',
    author: partial.author ?? 'alex',
    assignees: partial.assignees ?? [],
    reviewers: partial.reviewers ?? [],
    team: partial.team ?? '',
    repo: partial.repo ?? 'demo',
    sourceBranch: partial.sourceBranch ?? 'feat',
    targetBranch: partial.targetBranch ?? 'main',
    status: partial.status ?? 'open',
    url: partial.url ?? '',
    labels: partial.labels ?? [],
    updatedAt: partial.updatedAt ?? '',
    draft: partial.draft ?? false,
    reviewState: partial.reviewState ?? 'approved',
    pipelineStatus: partial.pipelineStatus ?? 'success',
    additions: partial.additions ?? 0,
    deletions: partial.deletions ?? 0,
    commentCount: partial.commentCount ?? 0,
    isMine: partial.isMine ?? false,
    needsMyReview: partial.needsMyReview ?? false,
    approvals: partial.approvals ?? 1,
    changesRequested: partial.changesRequested ?? 0,
    checkFailed: partial.checkFailed ?? 0,
    mergeable: partial.mergeable,
    mergeState: partial.mergeState,
    readyToMerge: partial.readyToMerge,
    approvedBy: partial.approvedBy,
    requestedChangesBy: partial.requestedChangesBy,
    commentedBy: partial.commentedBy,
  };
}

describe('prMergeBlockReason', () => {
  it('blocks drafts and closed PRs', () => {
    expect(prMergeBlockReason(pr({ draft: true }))).toBe('Mark ready before merging');
    expect(prMergeBlockReason(pr({ status: 'closed' }))).toBe('This pull request is closed');
  });

  it('blocks conflicts, failing CI, and requested changes', () => {
    expect(prMergeBlockReason(pr({ mergeable: false }))).toBe('Has merge conflicts');
    expect(prMergeBlockReason(pr({ checkFailed: 1, pipelineStatus: 'failure' }))).toBe('CI is failing');
    expect(prMergeBlockReason(pr({ reviewState: 'changesRequested', changesRequested: 1 }))).toBe(
      'Requested changes are outstanding',
    );
  });

  it('allows an approved open PR with passing checks', () => {
    expect(prMergeBlockReason(pr())).toBeNull();
    expect(prReadyToMerge(pr({ readyToMerge: true }))).toBeTrue();
  });
});

describe('prReviewerPeople', () => {
  it('marks approved, requested changes, and waiting reviewers', () => {
    const people = prReviewerPeople(
      pr({
        reviewers: ['jamie', 'sam', 'alex'],
        approvedBy: ['jamie'],
        requestedChangesBy: ['sam'],
      }),
    );
    expect(people).toEqual([
      { name: 'jamie', state: 'approved' },
      { name: 'sam', state: 'changes' },
      { name: 'alex', state: 'pending' },
    ]);
  });

  it('marks people who only left a comment review', () => {
    expect(
      prReviewerPeople(
        pr({
          reviewers: ['alex'],
          commentedBy: ['alex'],
        }),
      ),
    ).toEqual([{ name: 'alex', state: 'commented' }]);
  });

  it('includes people who approved without being in reviewers', () => {
    const people = prReviewerPeople(
      pr({
        reviewers: ['jamie'],
        approvedBy: ['sam'],
      }),
    );
    expect(people.map((p) => p.name)).toEqual(['jamie', 'sam']);
  });
});

describe('prReviewerGroups', () => {
  it('groups reviewers by approved, changes, and waiting', () => {
    const groups = prReviewerGroups(
      prReviewerPeople(
        pr({
          reviewers: ['jamie', 'sam', 'alex'],
          approvedBy: ['jamie'],
          requestedChangesBy: ['sam'],
        }),
      ),
    );
    expect(groups.map((group) => group.state)).toEqual(['approved', 'changes', 'pending']);
    expect(groups[0].people.map((person) => person.name)).toEqual(['jamie']);
    expect(groups[2].label).toBe('Waiting to review');
  });
});

describe('prReviewerSummary', () => {
  it('prefers requested changes over the approval count', () => {
    expect(
      prReviewerSummary(
        prReviewerPeople(
          pr({
            reviewers: ['jamie', 'sam'],
            approvedBy: ['jamie'],
            requestedChangesBy: ['sam'],
          }),
        ),
      ),
    ).toBe('1 requested changes');
    expect(prReviewerSummary([])).toBe('No reviewers');
  });
});

describe('prReviewerInitials', () => {
  it('uses two name parts or the first two characters', () => {
    expect(prReviewerInitials('jamie-chen')).toBe('JC');
    expect(prReviewerInitials('sam')).toBe('SA');
  });
});

describe('prBodyExcerpt', () => {
  it('uses the first real line and truncates long text', () => {
    expect(prBodyExcerpt('## Summary\n\nShip the graph focus work')).toBe(
      'Summary Ship the graph focus work',
    );
    expect(prBodyExcerpt('a'.repeat(200)).length).toBeLessThanOrEqual(161);
  });
});

describe('prBodyDisplay', () => {
  it('strips Jira tracking query params from links', () => {
    expect(
      prBodyDisplay(
        '[WEB-83](https://jira.example.com/browse/WEB-83?atlOrigin=eyJpIjoiYWJjIn0)',
      ),
    ).toBe('[WEB-83](https://jira.example.com/browse/WEB-83)');
  });
});

describe('prBodySegments', () => {
  it('turns markdown links into labeled segments', () => {
    expect(
      prBodySegments('[WEB-83](https://jira.example.com/browse/WEB-83) and more'),
    ).toEqual([
      { kind: 'link', text: 'WEB-83', href: 'https://jira.example.com/browse/WEB-83' },
      { kind: 'text', text: ' and more' },
    ]);
  });
});

describe('pr comment helpers', () => {
  it('splits conversation from code threads', () => {
    const threads = [
      { id: '1', kind: 'conversation' as const, comments: [] },
      { id: '2', kind: 'review' as const, comments: [] },
      { id: '3', kind: 'code' as const, path: 'src/app.ts', line: 4, comments: [] },
    ];
    expect(prConversationThreads(threads).map((t) => t.id)).toEqual(['1', '2']);
    expect(prCodeThreads(threads).map((t) => t.id)).toEqual(['3']);
  });

  it('previews the end of a diff hunk', () => {
    expect(prDiffHunkPreview('a\nb\nc\nd\ne\nf\ng', 3)).toBe('e\nf\ng');
  });

  it('labels review states', () => {
    expect(prReviewStateLabel('APPROVED')).toBe('Approved');
    expect(prReviewStateLabel('CHANGES_REQUESTED')).toBe('Requested changes');
    expect(prReviewStateLabel('pending')).toBeNull();
  });
});
