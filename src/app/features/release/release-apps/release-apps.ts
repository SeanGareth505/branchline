import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { RepoReleaseApp, RepoReleaseEvent } from '../../../core/models';
import { ReleaseRun } from '../release-run/release-run';
import {
  countReleaseEvents,
  defaultReleaseEventFilters,
  filterReleaseEvents,
  hasMultipleReleaseKinds,
  hasQueuedReleaseEvents,
  releaseEnvironmentLabel,
  releaseEventFiltersActive,
  releaseEventFiltersFromSession,
  releaseEventFiltersToSession,
  uniqueReleaseEnvironments,
  type ReleaseEventKindFilter,
  type ReleaseEventSort,
  type ReleaseEventStatusFilter,
} from './release-event-filters';

@Component({
  selector: 'app-release-apps',
  imports: [FormsModule, NgIcon, ReleaseRun],
  templateUrl: './release-apps.html',
  styleUrl: './release-apps.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseApps {
  private readonly store = inject(AppStore);

  readonly apps = input<RepoReleaseApp[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly loading = input(false);
  readonly message = input('');
  readonly opened = input<RepoReleaseEvent | null>(null);
  readonly selectApp = output<string>();
  readonly openEvent = output<RepoReleaseEvent>();
  readonly closeEvent = output<void>();
  readonly openExternal = output<RepoReleaseEvent>();
  readonly openWorkflow = output<RepoReleaseApp>();
  readonly refresh = output<void>();

  readonly query = signal('');
  readonly status = signal<ReleaseEventStatusFilter>('all');
  readonly environment = signal('all');
  readonly kind = signal<ReleaseEventKindFilter>('all');
  readonly sort = signal<ReleaseEventSort>('newest');

  readonly selected = computed(() => {
    const id = this.selectedId();
    const apps = this.apps();
    return apps.find((app) => app.id === id) ?? apps[0] ?? null;
  });

  readonly events = computed(() => this.selected()?.events ?? []);
  readonly environments = computed(() => uniqueReleaseEnvironments(this.events()));
  readonly showKindFilter = computed(() => hasMultipleReleaseKinds(this.events()));
  readonly showQueuedFilter = computed(() => hasQueuedReleaseEvents(this.events()));
  readonly filtersActive = computed(() =>
    releaseEventFiltersActive({
      query: this.query(),
      status: this.status(),
      environment: this.environment(),
      kind: this.kind(),
      sort: this.sort(),
    }),
  );
  readonly filtered = computed(() =>
    filterReleaseEvents(this.events(), {
      query: this.query(),
      status: this.status(),
      environment: this.environment(),
      kind: this.kind(),
      sort: this.sort(),
    }),
  );
  readonly counts = computed(() => countReleaseEvents(this.filtered()));
  readonly listSubtitle = computed(() => {
    const name = this.selected()?.name ?? 'this app';
    return `Live deploys for ${name} — ${this.filtered().length} shown`;
  });

  constructor() {
    const saved = releaseEventFiltersFromSession(this.store.readSession());
    this.query.set(saved.query);
    this.status.set(saved.status);
    this.environment.set(saved.environment);
    this.kind.set(saved.kind);
    this.sort.set(saved.sort);

    effect(() => {
      const events = this.events();
      const environments = this.environments();
      const showKind = this.showKindFilter();
      const showQueued = this.showQueuedFilter();
      untracked(() => {
        const environment = this.environment();
        if (events.length && environment !== 'all' && !environments.includes(environment)) {
          this.environment.set('all');
        }
        if (events.length && !showKind && this.kind() !== 'all') this.kind.set('all');
        if (events.length && !showQueued && this.status() === 'queued') this.status.set('all');
      });
    });

    effect(() => {
      const filters = {
        query: this.query(),
        status: this.status(),
        environment: this.environment(),
        kind: this.kind(),
        sort: this.sort(),
      };
      untracked(() => {
        this.store.patchSession(releaseEventFiltersToSession(filters));
      });
    });
  }

  setQuery(value: string): void {
    this.query.set(value);
  }

  setStatus(value: string): void {
    if (
      value === 'all' ||
      value === 'success' ||
      value === 'pending' ||
      value === 'failure' ||
      value === 'queued'
    ) {
      this.status.set(value);
    }
  }

  setEnvironment(value: string): void {
    this.environment.set(value);
  }

  setKind(value: string): void {
    if (value === 'all' || value === 'workflow' || value === 'tag') {
      this.kind.set(value);
    }
  }

  setSort(value: string): void {
    if (value === 'newest' || value === 'oldest') this.sort.set(value);
  }

  resetFilters(): void {
    const next = defaultReleaseEventFilters();
    this.query.set(next.query);
    this.status.set(next.status);
    this.environment.set(next.environment);
    this.kind.set(next.kind);
    this.sort.set(next.sort);
  }

  envLabel(value: string): string {
    return releaseEnvironmentLabel(value);
  }

  statusLabel(status: string): string {
    if (status === 'success') return 'Live';
    if (status === 'failure') return 'Failed';
    if (status === 'pending') return 'Running';
    if (status === 'queued') return 'Queued';
    return 'Unknown';
  }

  kindLabel(kind: string): string {
    return kind === 'tag' ? 'Tag' : 'Deploy';
  }

  whenLabel(value: string | null | undefined): string {
    if (!value?.trim()) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return formatDistanceToNowStrict(date, { addSuffix: true });
  }

  statusIcon(status: string): string {
    if (status === 'success') return 'lucideCheck';
    if (status === 'failure') return 'lucideX';
    if (status === 'pending' || status === 'queued') return 'lucideRefreshCw';
    return 'lucideCircleAlert';
  }

  isRunning(status: string): boolean {
    return status === 'pending' || status === 'queued';
  }

  appHasRunning(app: RepoReleaseApp): boolean {
    return app.events.some((item) => this.isRunning(item.status));
  }

  eventTrack(event: RepoReleaseEvent): string {
    return `${event.kind}:${event.runId ?? ''}:${event.title}:${event.at ?? ''}:${event.url ?? ''}`;
  }

  onRowClick(event: RepoReleaseEvent): void {
    this.openEvent.emit(event);
  }

  openRow(event: RepoReleaseEvent, click: Event): void {
    click.stopPropagation();
    this.openExternal.emit(event);
  }

  async copyLink(event: RepoReleaseEvent, click: Event): Promise<void> {
    click.stopPropagation();
    const url = event.url?.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.store.showSuccess('Copied deploy link');
    } catch {
      this.store.showError('Could not copy link');
    }
  }

  onClose(): void {
    this.closeEvent.emit();
  }

  onOpenUrl(url: string): void {
    const current = this.opened();
    if (current) this.openExternal.emit({ ...current, url });
  }
}
