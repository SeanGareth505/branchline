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
import { NgIcon } from '@ng-icons/core';
import { format } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { ReleaseDeployJob, RepoReleaseEvent } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';

type JobChip = 'success' | 'failure' | 'pending' | 'queued' | 'unknown';

@Component({
  selector: 'app-release-run',
  imports: [NgIcon],
  templateUrl: './release-run.html',
  styleUrl: './release-run.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseRun {
  private readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly event = input.required<RepoReleaseEvent>();
  readonly back = output<void>();
  readonly openUrl = output<string>();

  readonly loading = signal(false);
  readonly message = signal('');
  readonly jobs = signal<ReleaseDeployJob[]>([]);
  readonly liveStatus = signal('');
  private readonly now = signal(Date.now());
  private pollTimer: number | null = null;
  private pollGen = 0;

  readonly status = computed(() => this.liveStatus() || this.event().status);
  readonly running = computed(() => {
    const status = this.status();
    return status === 'pending' || status === 'queued';
  });
  readonly title = computed(() => this.event().title);
  readonly detail = computed(() => this.event().detail);
  readonly when = computed(() => this.whenLabel(this.event().at));
  readonly kindLabel = computed(() => (this.event().kind === 'tag' ? 'Tag' : 'Deploy'));
  readonly canPoll = computed(() => {
    const event = this.event();
    return !!event.runId || (event.url ?? '').includes('/actions/runs/');
  });
  readonly jobViews = computed(() => {
    const now = this.now();
    return this.jobs().map((job) => {
      const chip = jobChip(job);
      return {
        name: job.name,
        chip,
        label: chipLabel(chip, job.conclusion),
        duration: jobDuration(job, now),
        url: job.url ?? null,
        steps: (job.steps ?? []).map((step, index) => {
          const childChip = jobChip(step);
          return {
            id: `${job.name}:${step.number ?? index}:${step.name}`,
            name: step.name,
            chip: childChip,
            label: chipLabel(childChip, step.conclusion),
          };
        }),
      };
    });
  });

  constructor() {
    effect((onCleanup) => {
      const event = this.event();
      const path = this.store.currentRepo()?.path;
      untracked(() => {
        this.liveStatus.set(event.status);
        this.jobs.set([]);
        this.message.set('');
        void this.refresh(event, path);
      });
      onCleanup(() => {
        this.pollGen += 1;
        this.stopPoll();
      });
    });
  }

  statusLabel(status: string): string {
    if (status === 'success') return 'Live';
    if (status === 'failure') return 'Failed';
    if (status === 'pending') return 'Running';
    if (status === 'queued') return 'Queued';
    return 'Unknown';
  }

  statusIcon(status: string): string {
    if (status === 'success') return 'lucideCheck';
    if (status === 'failure') return 'lucideX';
    if (status === 'pending' || status === 'queued') return 'lucideRefreshCw';
    return 'lucideCircleAlert';
  }

  whenLabel(value: string | null | undefined): string {
    if (!value?.trim()) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return format(date, 'd MMM yyyy, HH:mm');
  }

  goBack(): void {
    this.back.emit();
  }

  openGithub(): void {
    const url = this.event().url?.trim();
    if (url) this.openUrl.emit(url);
  }

  jobChipIcon(chip: JobChip): string {
    if (chip === 'success') return 'lucideCheck';
    if (chip === 'failure') return 'lucideX';
    if (chip === 'pending' || chip === 'queued') return 'lucideRefreshCw';
    return 'lucideCircleAlert';
  }

  private async refresh(event: RepoReleaseEvent, path: string | undefined): Promise<void> {
    if (!path || !this.canPoll()) {
      this.message.set(
        event.kind === 'tag'
          ? 'This is a git tag. Open it on GitHub to see the release.'
          : 'No GitHub Actions run is linked to this item.',
      );
      return;
    }
    const gen = ++this.pollGen;
    if (!this.jobs().length) this.loading.set(true);
    try {
      const result = await this.tauri.pollRepoReleaseRun(path, event.runId, event.url);
      if (gen !== this.pollGen) return;
      this.liveStatus.set(result.status || event.status);
      this.message.set(result.message || '');
      this.jobs.set(result.jobs ?? []);
      this.now.set(Date.now());
      const live = result.status === 'pending' || result.status === 'queued';
      if (live) this.schedulePoll(event, path);
      else this.stopPoll();
    } catch (err) {
      if (gen !== this.pollGen) return;
      this.message.set(this.store.formatError(err));
      this.schedulePoll(event, path);
    } finally {
      if (gen === this.pollGen) this.loading.set(false);
    }
  }

  private schedulePoll(event: RepoReleaseEvent, path: string): void {
    this.stopPoll();
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.refresh(event, path);
    }, 4000);
  }

  private stopPoll(): void {
    if (this.pollTimer !== null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function jobChip(job: { status: string; conclusion?: string | null }): JobChip {
  const status = job.status.trim().toLowerCase();
  if (status === 'in_progress') return 'pending';
  if (
    status === 'queued' ||
    status === 'waiting' ||
    status === 'requested' ||
    status === 'pending' ||
    !status
  ) {
    return 'queued';
  }
  const conclusion = job.conclusion?.trim().toLowerCase() ?? '';
  if (
    conclusion === 'failure' ||
    conclusion === 'cancelled' ||
    conclusion === 'canceled' ||
    conclusion === 'timed_out' ||
    conclusion === 'startup_failure'
  ) {
    return 'failure';
  }
  if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') {
    return 'success';
  }
  if (status === 'completed') return 'success';
  return 'unknown';
}

function chipLabel(chip: JobChip, conclusion?: string | null): string {
  if (chip === 'success') {
    return conclusion?.trim().toLowerCase() === 'skipped' ? 'Skipped' : 'Done';
  }
  if (chip === 'failure') return 'Failed';
  if (chip === 'queued') return 'Queued';
  if (chip === 'pending') return 'Running';
  return 'Waiting';
}

function jobDuration(job: Pick<ReleaseDeployJob, 'startedAt' | 'completedAt'>, now: number): string {
  const start = job.startedAt ? Date.parse(job.startedAt) : NaN;
  if (!Number.isFinite(start)) return '';
  const end = job.completedAt ? Date.parse(job.completedAt) : now;
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}
