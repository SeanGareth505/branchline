import { prMergeBlockReason, prReadyToMerge } from './models';
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
