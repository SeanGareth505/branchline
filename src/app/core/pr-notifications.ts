import type { MockPullRequest } from './models';
import { prCheckFailed, prReadyToMerge } from './models';

export type PrNotifyKind = 'review' | 'ready' | 'ciFail' | 'ciPass' | 'activity';

export interface PrNotifyEvent {
  kind: PrNotifyKind;
  prs: MockPullRequest[];
}

export function diffPullRequestNotifications(
  prev: MockPullRequest[] | null,
  next: MockPullRequest[],
): PrNotifyEvent[] {
  if (!prev) return [];
  const prevById = new Map(prev.map((pr) => [pr.id, pr]));
  const review: MockPullRequest[] = [];
  const ready: MockPullRequest[] = [];
  const ciFail: MockPullRequest[] = [];
  const ciPass: MockPullRequest[] = [];
  const activity: MockPullRequest[] = [];

  for (const pr of next) {
    const before = prevById.get(pr.id);
    if (!before) {
      if (pr.needsMyReview && pr.status === 'open') review.push(pr);
      continue;
    }
    if (!before.needsMyReview && pr.needsMyReview && pr.status === 'open') {
      review.push(pr);
    }
    if (!prReadyToMerge(before) && prReadyToMerge(pr) && pr.isMine) {
      ready.push(pr);
    }
    const watchCi = pr.isMine || pr.needsMyReview;
    if (watchCi) {
      const wasFail = before.pipelineStatus === 'failure' || prCheckFailed(before) > 0;
      const isFail = pr.pipelineStatus === 'failure' || prCheckFailed(pr) > 0;
      if (!wasFail && isFail) ciFail.push(pr);
      const wasPass = before.pipelineStatus === 'success';
      const isPass = pr.pipelineStatus === 'success';
      if (!wasPass && isPass && !isFail) ciPass.push(pr);
    }
    if (pr.isMine || pr.needsMyReview) {
      if (before.commentCount < pr.commentCount) activity.push(pr);
      else if (
        before.reviewState !== pr.reviewState &&
        before.reviewState !== 'unknown' &&
        pr.reviewState !== 'unknown'
      ) {
        activity.push(pr);
      } else if (before.status !== 'merged' && pr.status === 'merged') {
        activity.push(pr);
      }
    }
  }

  const claimed = new Set(
    [...review, ...ready, ...ciFail, ...ciPass].map((pr) => pr.id),
  );
  const leftover = activity.filter((pr) => !claimed.has(pr.id));
  const out: PrNotifyEvent[] = [];
  if (review.length) out.push({ kind: 'review', prs: review });
  if (ready.length) out.push({ kind: 'ready', prs: ready });
  if (ciFail.length) out.push({ kind: 'ciFail', prs: ciFail });
  if (ciPass.length) out.push({ kind: 'ciPass', prs: ciPass });
  if (leftover.length) out.push({ kind: 'activity', prs: leftover });
  return out;
}

export function formatPrNotify(event: PrNotifyEvent): { title: string; body: string } {
  const first = event.prs[0];
  const n = event.prs.length;
  const label = first ? `#${first.number} ${first.title}` : 'Pull request';
  switch (event.kind) {
    case 'review':
      return n === 1
        ? { title: 'Review requested', body: `${label} needs your review` }
        : { title: 'Review requested', body: `${n} pull requests need your review` };
    case 'ready':
      return n === 1
        ? { title: 'Ready to merge', body: `${label} is ready to merge` }
        : { title: 'Ready to merge', body: `${n} of your pull requests are ready to merge` };
    case 'ciFail':
      return n === 1
        ? { title: 'Checks failed', body: `CI failed on ${label}` }
        : { title: 'Checks failed', body: `CI failed on ${n} pull requests` };
    case 'ciPass':
      return n === 1
        ? { title: 'Checks passed', body: `CI passed on ${label}` }
        : { title: 'Checks passed', body: `CI passed on ${n} pull requests` };
    case 'activity':
      return n === 1
        ? { title: 'Pull request updated', body: `${label} was updated` }
        : { title: 'Pull requests updated', body: `${n} pull requests were updated` };
  }
}
