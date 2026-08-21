import { diffPullRequestNotifications, formatPrNotify } from './pr-notifications';
import type { MockPullRequest } from './models';

function pr(partial: Partial<MockPullRequest> & Pick<MockPullRequest, 'id' | 'number'>): MockPullRequest {
  return {
    id: partial.id,
    number: partial.number,
    title: partial.title ?? `PR ${partial.number}`,
    author: partial.author ?? 'you',
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
    reviewState: partial.reviewState ?? 'pending',
    pipelineStatus: partial.pipelineStatus ?? 'unknown',
    additions: partial.additions ?? 0,
    deletions: partial.deletions ?? 0,
    commentCount: partial.commentCount ?? 0,
    isMine: partial.isMine ?? false,
    needsMyReview: partial.needsMyReview ?? false,
    readyToMerge: partial.readyToMerge,
    checkFailed: partial.checkFailed,
  };
}

describe('diffPullRequestNotifications', () => {
  it('does not notify on the first snapshot', () => {
    expect(diffPullRequestNotifications(null, [pr({ id: '1', number: 1, needsMyReview: true })])).toEqual(
      [],
    );
  });

  it('notifies when a PR starts needing your review', () => {
    const before = [pr({ id: '1', number: 8, needsMyReview: false })];
    const after = [pr({ id: '1', number: 8, needsMyReview: true })];
    const events = diffPullRequestNotifications(before, after);
    expect(events.map((e) => e.kind)).toEqual(['review']);
    expect(formatPrNotify(events[0]).body).toContain('#8');
  });

  it('notifies when your PR becomes ready to merge', () => {
    const before = [pr({ id: '1', number: 9, isMine: true, readyToMerge: false })];
    const after = [pr({ id: '1', number: 9, isMine: true, readyToMerge: true })];
    expect(diffPullRequestNotifications(before, after).map((e) => e.kind)).toEqual(['ready']);
  });

  it('notifies CI failure on PRs you own or need to review', () => {
    const before = [pr({ id: '1', number: 10, isMine: true, pipelineStatus: 'pending' })];
    const after = [pr({ id: '1', number: 10, isMine: true, pipelineStatus: 'failure' })];
    expect(diffPullRequestNotifications(before, after).map((e) => e.kind)).toEqual(['ciFail']);
  });
});
