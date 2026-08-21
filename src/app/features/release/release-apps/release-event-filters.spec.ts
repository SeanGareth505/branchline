import type { RepoReleaseEvent } from '../../../core/models';
import {
  countReleaseEvents,
  defaultReleaseEventFilters,
  filterReleaseEvents,
  hasMultipleReleaseKinds,
  hasQueuedReleaseEvents,
  releaseEventFiltersActive,
  releaseEventFiltersFromSession,
  releaseEventFiltersToSession,
  uniqueReleaseEnvironments,
} from './release-event-filters';

function event(partial: Partial<RepoReleaseEvent>): RepoReleaseEvent {
  return {
    kind: 'workflow',
    title: 'Deploy',
    detail: 'develop · development',
    status: 'success',
    tag: null,
    environment: 'development',
    url: 'https://github.com/example/repo/actions/runs/1',
    at: '2026-08-21T10:00:00Z',
    ...partial,
  };
}

describe('release event filters', () => {
  const events: RepoReleaseEvent[] = [
    event({
      title: 'SOTF live',
      detail: 'develop · development',
      status: 'success',
      environment: 'development',
      at: '2026-08-21T12:00:00Z',
    }),
    event({
      title: 'Web Frontend',
      detail: 'staging · staging',
      status: 'pending',
      environment: 'staging',
      at: '2026-08-21T11:00:00Z',
    }),
    event({
      kind: 'tag',
      title: 'prod-v1.2.3',
      detail: 'production',
      status: 'failure',
      tag: 'prod-v1.2.3',
      environment: 'production',
      at: '2026-08-21T10:00:00Z',
    }),
    event({
      title: 'Queued deploy',
      detail: 'develop · development',
      status: 'queued',
      environment: 'development',
      at: '2026-08-21T09:00:00Z',
    }),
  ];

  it('filters by search across title, tag, detail, and environment', () => {
    const found = filterReleaseEvents(events, {
      query: 'prod-v1',
      status: 'all',
      environment: 'all',
      kind: 'all',
      sort: 'newest',
    });
    expect(found.map((item) => item.title)).toEqual(['prod-v1.2.3']);
  });

  it('filters by status, environment, and kind', () => {
    const found = filterReleaseEvents(events, {
      query: '',
      status: 'success',
      environment: 'development',
      kind: 'workflow',
      sort: 'newest',
    });
    expect(found.map((item) => item.title)).toEqual(['SOTF live']);
  });

  it('sorts oldest first when requested', () => {
    const found = filterReleaseEvents(events, {
      query: '',
      status: 'all',
      environment: 'all',
      kind: 'all',
      sort: 'oldest',
    });
    expect(found.map((item) => item.title)).toEqual([
      'Queued deploy',
      'prod-v1.2.3',
      'Web Frontend',
      'SOTF live',
    ]);
  });

  it('exposes environments, kinds, queued, counts, and active filters', () => {
    expect(uniqueReleaseEnvironments(events)).toEqual(['development', 'staging', 'production']);
    expect(hasMultipleReleaseKinds(events)).toBeTrue();
    expect(hasQueuedReleaseEvents(events)).toBeTrue();
    expect(countReleaseEvents(events)).toEqual({
      shown: 4,
      live: 1,
      running: 1,
      failed: 1,
      queued: 1,
    });
    expect(
      releaseEventFiltersActive({
        query: '',
        status: 'all',
        environment: 'all',
        kind: 'all',
        sort: 'newest',
      }),
    ).toBeFalse();
    expect(
      releaseEventFiltersActive({
        query: 'web',
        status: 'all',
        environment: 'all',
        kind: 'all',
        sort: 'newest',
      }),
    ).toBeTrue();
  });

  it('restores and serializes saved filters from session', () => {
    const restored = releaseEventFiltersFromSession({
      releaseQuery: 'sotf',
      releaseStatus: 'pending',
      releaseEnvironment: 'staging',
      releaseKind: 'workflow',
      releaseSort: 'oldest',
    });
    expect(restored).toEqual({
      query: 'sotf',
      status: 'pending',
      environment: 'staging',
      kind: 'workflow',
      sort: 'oldest',
    });
    expect(releaseEventFiltersToSession(restored)).toEqual({
      releaseQuery: 'sotf',
      releaseStatus: 'pending',
      releaseEnvironment: 'staging',
      releaseKind: 'workflow',
      releaseSort: 'oldest',
    });
    expect(releaseEventFiltersFromSession({ releaseStatus: 'nope' })).toEqual(
      defaultReleaseEventFilters(),
    );
  });
});
