import type { RepoReleaseEvent } from '../../../core/models';

export type ReleaseEventStatusFilter = 'all' | 'success' | 'pending' | 'failure' | 'queued';
export type ReleaseEventKindFilter = 'all' | 'workflow' | 'tag';
export type ReleaseEventSort = 'newest' | 'oldest';

export interface ReleaseEventFilters {
  query: string;
  status: ReleaseEventStatusFilter;
  environment: string;
  kind: ReleaseEventKindFilter;
  sort: ReleaseEventSort;
}

export interface ReleaseEventCounts {
  shown: number;
  live: number;
  running: number;
  failed: number;
  queued: number;
}

const ENV_ORDER = ['development', 'staging', 'production'];

export function defaultReleaseEventFilters(): ReleaseEventFilters {
  return {
    query: '',
    status: 'all',
    environment: 'all',
    kind: 'all',
    sort: 'newest',
  };
}

export function releaseEventFiltersActive(filters: ReleaseEventFilters): boolean {
  return (
    filters.query.trim().length > 0 ||
    filters.status !== 'all' ||
    filters.environment !== 'all' ||
    filters.kind !== 'all' ||
    filters.sort !== 'newest'
  );
}

export function uniqueReleaseEnvironments(events: RepoReleaseEvent[]): string[] {
  const found = new Set<string>();
  for (const event of events) {
    const env = event.environment?.trim();
    if (env) found.add(env);
  }
  return [...found].sort((a, b) => {
    const ai = ENV_ORDER.indexOf(a);
    const bi = ENV_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) {
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    }
    return a.localeCompare(b);
  });
}

export function hasMultipleReleaseKinds(events: RepoReleaseEvent[]): boolean {
  const kinds = new Set(events.map((event) => (event.kind === 'tag' ? 'tag' : 'workflow')));
  return kinds.size > 1;
}

export function hasQueuedReleaseEvents(events: RepoReleaseEvent[]): boolean {
  return events.some((event) => event.status === 'queued');
}

export function releaseEnvironmentLabel(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function countReleaseEvents(events: RepoReleaseEvent[]): ReleaseEventCounts {
  let live = 0;
  let running = 0;
  let failed = 0;
  let queued = 0;
  for (const event of events) {
    if (event.status === 'success') live += 1;
    else if (event.status === 'pending') running += 1;
    else if (event.status === 'failure') failed += 1;
    else if (event.status === 'queued') queued += 1;
  }
  return { shown: events.length, live, running, failed, queued };
}

export function filterReleaseEvents(
  events: RepoReleaseEvent[],
  filters: ReleaseEventFilters,
): RepoReleaseEvent[] {
  const query = filters.query.trim().toLowerCase();
  const list = events.filter((event) => {
    if (filters.status !== 'all' && event.status !== filters.status) return false;
    if (filters.environment !== 'all' && event.environment !== filters.environment) return false;
    if (filters.kind !== 'all') {
      const kind = event.kind === 'tag' ? 'tag' : 'workflow';
      if (kind !== filters.kind) return false;
    }
    if (!query) return true;
    const hay = [event.title, event.detail, event.tag ?? '', event.environment ?? '', event.kind]
      .join(' ')
      .toLowerCase();
    return hay.includes(query);
  });
  list.sort((a, b) => {
    const delta = eventTime(a) - eventTime(b);
    return filters.sort === 'oldest' ? delta : -delta;
  });
  return list;
}

function eventTime(event: RepoReleaseEvent): number {
  if (!event.at?.trim()) return 0;
  const time = Date.parse(event.at);
  return Number.isNaN(time) ? 0 : time;
}
