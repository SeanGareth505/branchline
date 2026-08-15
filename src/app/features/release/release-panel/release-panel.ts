import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { NgIcon } from '@ng-icons/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppStore } from '../../../core/app.store';
import { UpdateService, UPDATE_DOWNLOAD_PAGE } from '../../../core/update.service';
import type {
  ReleaseActivityStep,
  ReleaseDeployJob,
  ReleaseDeployJobStep,
  ReleasePhase,
} from '../../../core/models';

type JobFilter = 'in_progress' | 'completed' | 'failed' | 'all';
type JobChipStatus = 'success' | 'failure' | 'pending' | 'unknown';

interface ReleaseLinkCard {
  id: string;
  label: string;
  hint: string;
  url: string;
  icon: string;
}

interface JobFilterTab {
  id: JobFilter;
  label: string;
  count: number;
}

interface JobStepView {
  key: string;
  name: string;
  chip: JobChipStatus;
  statusLabel: string;
  duration: string;
  active: boolean;
}

interface JobView {
  job: ReleaseDeployJob;
  name: string;
  label: string;
  chip: JobChipStatus;
  statusLabel: string;
  duration: string;
  open: boolean;
  hasSteps: boolean;
  url: string | null;
  steps: JobStepView[];
}

@Component({
  selector: 'app-release-panel',
  imports: [NgIcon, NgTemplateOutlet],
  templateUrl: './release-panel.html',
  styleUrl: './release-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleasePanel {
  readonly store = inject(AppStore);
  private readonly updates = inject(UpdateService);
  private readonly now = signal(Date.now());
  private promptedUpdate = false;

  readonly activity = computed(() => this.store.releaseActivity());
  readonly busy = computed(() => this.store.releaseBusy());

  readonly downloadPageUrl = computed(() => {
    const activity = this.activity();
    return activity?.websiteUrl?.trim() || UPDATE_DOWNLOAD_PAGE;
  });

  readonly elapsed = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    const end = activity.finishedAt ?? this.now();
    return formatElapsed(Math.max(0, end - activity.startedAt));
  });

  readonly trackingPaused = computed(() => {
    const activity = this.activity();
    return !!activity?.needsRefresh && !this.busy();
  });

  readonly canRefresh = computed(() => {
    const activity = this.activity();
    return !!activity?.willPush && !activity.needsPush && !this.busy();
  });

  readonly githubLinked = computed(() => this.store.hasGithubConnection());

  readonly linkCards = computed((): ReleaseLinkCard[] => {
    const activity = this.activity();
    if (!activity) return [];
    const cards: ReleaseLinkCard[] = [];
    if (activity.repoUrl) {
      cards.push({
        id: 'repo',
        label: 'Repository',
        hint: 'View on GitHub',
        url: activity.repoUrl,
        icon: 'lucideGithub',
      });
    }
    if (activity.deployRunUrl) {
      cards.push({
        id: 'run',
        label: 'Workflow run',
        hint: 'Live build log',
        url: activity.deployRunUrl,
        icon: 'lucidePlay',
      });
    } else if (activity.actionsPageUrl) {
      cards.push({
        id: 'actions',
        label: 'Actions',
        hint: 'release.yml',
        url: activity.actionsPageUrl,
        icon: 'lucideWorkflow',
      });
    }
    if (activity.releaseUrl) {
      cards.push({
        id: 'release',
        label: 'Release',
        hint: activity.tag,
        url: activity.releaseUrl,
        icon: 'lucideTag',
      });
    }
    const pageUrl = this.downloadPageUrl();
    if (pageUrl) {
      cards.push({
        id: 'website',
        label: 'Download page',
        hint: 'Updates & installers',
        url: pageUrl,
        icon: 'lucideGlobe',
      });
    }
    return cards;
  });

  readonly deployJobs = computed(() => this.activity()?.deployJobs ?? []);
  readonly jobFilter = signal<JobFilter>('in_progress');
  readonly timelineView = signal<'steps' | 'actions'>('steps');
  private readonly jobOpen = signal<Record<string, boolean>>({});
  private readonly nestedActionsOverride = signal<boolean | null>(null);
  private jobFilterTouched = false;
  private lastInProgressCount = -1;

  readonly jobCounts = computed(() => {
    let inProgress = 0;
    let completed = 0;
    let failed = 0;
    for (const job of this.deployJobs()) {
      const chip = chipStatus(job);
      if (chip === 'success') completed += 1;
      else if (chip === 'failure') failed += 1;
      else inProgress += 1;
    }
    return {
      in_progress: inProgress,
      completed,
      failed,
      all: this.deployJobs().length,
    };
  });

  readonly jobFilterTabs = computed((): JobFilterTab[] => {
    const counts = this.jobCounts();
    return [
      { id: 'in_progress', label: 'In progress', count: counts.in_progress },
      { id: 'completed', label: 'History', count: counts.completed },
      { id: 'failed', label: 'Failed', count: counts.failed },
      { id: 'all', label: 'All', count: counts.all },
    ];
  });

  readonly filteredJobs = computed(() => {
    const filter = this.jobFilter();
    return this.deployJobs().filter((job) => {
      const chip = chipStatus(job);
      if (filter === 'in_progress') return chip === 'pending' || chip === 'unknown';
      if (filter === 'completed') return chip === 'success';
      if (filter === 'failed') return chip === 'failure';
      return true;
    });
  });

  readonly jobViews = computed((): JobView[] => {
    const now = this.now();
    const openState = this.jobOpen();
    const jobs = this.filteredJobs();
    const failedName = jobs.find(
      (job) => (job.steps?.length ?? 0) > 0 && chipStatus(job) === 'failure',
    )?.name;
    const runningName = jobs.find(
      (job) => (job.steps?.length ?? 0) > 0 && job.status === 'in_progress',
    )?.name;
    return jobs.map((job) => {
      const chip = chipStatus(job);
      const hasSteps = (job.steps?.length ?? 0) > 0;
      const open =
        openState[job.name] ??
        (hasSteps && (job.name === failedName || job.name === runningName));
      return {
        job,
        name: job.name,
        label: formatDeployJobName(job.name),
        chip,
        statusLabel: statusLabelOf(job, chip),
        duration: durationOf(job, now),
        open,
        hasSteps,
        url: job.url ?? null,
        steps: open && hasSteps ? job.steps!.map((step, index) => toStepView(step, index, now)) : [],
      };
    });
  });

  readonly jobEmptyLabel = computed(() => {
    const counts = this.jobCounts();
    switch (this.jobFilter()) {
      case 'in_progress':
        if (counts.failed) return `No jobs in progress · ${counts.failed} failed`;
        return counts.completed
          ? `No jobs in progress · ${counts.completed} finished`
          : 'No jobs in progress';
      case 'completed':
        return 'No finished jobs yet';
      case 'failed':
        return 'No failed jobs';
      default:
        return 'No jobs loaded yet';
    }
  });

  readonly actionsHostStep = computed(() => {
    const steps = this.activity()?.steps ?? [];
    const gha = steps.filter((step) => isActionsPhase(step.phase));
    if (!gha.length) return null;
    return (
      gha.find((step) => step.status === 'active' || step.status === 'error') ??
      [...gha].reverse().find((step) => step.status === 'done') ??
      gha[0]
    );
  });

  readonly nestedActionsOpen = computed(() => {
    if (this.nestedActionsOverride() !== null) return this.nestedActionsOverride()!;
    const host = this.actionsHostStep();
    if (!host) return false;
    return (
      host.status === 'active' ||
      host.status === 'error' ||
      this.deployJobs().length > 0
    );
  });

  readonly jobSummary = computed(() => {
    const jobs = this.deployJobs();
    if (!jobs.length) return '';
    const counts = this.jobCounts();
    if (counts.failed) return `${counts.completed}/${jobs.length} passed · ${counts.failed} failed`;
    if (counts.in_progress) {
      return `${counts.completed}/${jobs.length} passed · ${counts.in_progress} running`;
    }
    return `${counts.completed}/${jobs.length} passed`;
  });

  readonly showDeploySection = computed(() => {
    const activity = this.activity();
    if (!activity?.willPush && !activity?.deployRunUrl && !activity?.actionsPageUrl) return false;
    return (
      this.deployJobs().length > 0 ||
      this.busy() ||
      !!activity?.deployRunUrl ||
      !!activity?.needsRefresh ||
      !!activity?.actionsPageUrl
    );
  });

  readonly workflowStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return 'idle';
    if (activity.phase === 'error') return 'failure';
    if (activity.phase === 'done' && !activity.needsRefresh) return 'success';
    if (activity.needsRefresh) return 'paused';
    if (activity.phase === 'ci' || activity.phase === 'deploying' || activity.phase === 'publishing') {
      return 'running';
    }
    return 'idle';
  });

  readonly headline = computed(() => {
    const activity = this.activity();
    if (!activity) return 'No release in progress';
    if (activity.phase === 'done' && !activity.needsRefresh) {
      return `Released ${activity.productName} ${activity.nextVersion}`;
    }
    if (activity.phase === 'error') {
      return `Release failed`;
    }
    if (activity.needsRefresh) {
      return `Tracking paused for ${activity.productName} ${activity.nextVersion}`;
    }
    if (activity.phase === 'deploying' || activity.phase === 'ci' || activity.phase === 'publishing') {
      return `Deploying ${activity.productName} ${activity.nextVersion}`;
    }
    return `Releasing ${activity.productName} ${activity.currentVersion} → ${activity.nextVersion}`;
  });

  readonly statusLabel = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (activity.phase === 'done' && !activity.needsRefresh) return 'Complete';
    if (activity.phase === 'error') return 'Failed';
    if (activity.needsRefresh) return 'Paused — refresh to continue';
    return phaseLabel(activity.phase);
  });

  readonly showPushFallback = computed(() => {
    const activity = this.activity();
    return !!activity?.needsPush && !this.busy();
  });

  readonly shippedLive = computed(() => {
    const activity = this.activity();
    return (
      !!activity &&
      activity.phase === 'done' &&
      activity.ok !== false &&
      !activity.needsPush &&
      !activity.needsRefresh &&
      (activity.willPush || !!activity.releaseUrl)
    );
  });

  readonly finalStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (this.shippedLive()) {
      return 'Waiting for users to get the update banner (next app launch/check)';
    }
    if (activity.needsRefresh) {
      return activity.message || 'Refresh to keep tracking GitHub Actions.';
    }
    if (activity.phase === 'done' && activity.needsPush) {
      return 'Tagged locally — push to origin to publish and notify users';
    }
    if (activity.phase === 'error') {
      return activity.message;
    }
    return '';
  });

  constructor() {
    effect((onCleanup) => {
      const activity = this.activity();
      const live =
        !!activity &&
        activity.phase !== 'done' &&
        activity.phase !== 'error' &&
        !activity.needsRefresh;
      if (!live) return;
      const id = window.setInterval(() => this.now.set(Date.now()), 2000);
      onCleanup(() => window.clearInterval(id));
    });
    effect(() => {
      if (!this.shippedLive() || this.promptedUpdate) return;
      this.promptedUpdate = true;
      void this.updates.checkForUpdates({ silent: true });
    });
    effect(() => {
      const counts = this.jobCounts();
      const prev = this.lastInProgressCount;
      this.lastInProgressCount = counts.in_progress;
      if (this.jobFilterTouched || this.jobFilter() !== 'in_progress') return;
      if (prev > 0 && counts.in_progress === 0) {
        this.jobFilter.set(counts.failed > 0 ? 'failed' : 'all');
      }
    });
  }

  clear(): void {
    this.store.clearReleaseActivity();
  }

  startRelease(): void {
    void this.store.startReleaseFlow();
  }

  trackLatest(): void {
    void this.store.attachLatestRelease({ force: true });
  }

  pushRelease(): void {
    void this.store.pushReleaseTags();
  }

  refreshDeploy(): void {
    void this.store.refreshReleaseDeploy();
  }

  openGithubSettings(): void {
    this.store.openSettings('connections');
  }

  checkForUpdates(): void {
    void this.updates.checkForUpdates({ silent: false });
  }

  async copyTag(): Promise<void> {
    const tag = this.activity()?.tag;
    if (!tag) return;
    try {
      await navigator.clipboard.writeText(tag);
      this.store.showSuccess(`Copied ${tag}`);
    } catch {
      this.store.showError('Could not copy tag');
    }
  }

  openLink(url: string | null | undefined): void {
    if (!url) return;
    void openUrl(url);
  }

  trackStep(_index: number, step: ReleaseActivityStep): string {
    return step.id;
  }

  setTimelineView(view: 'steps' | 'actions'): void {
    this.timelineView.set(view);
  }

  nestsActions(step: ReleaseActivityStep): boolean {
    return this.actionsHostStep()?.id === step.id;
  }

  toggleNestedActions(event?: Event): void {
    event?.stopPropagation();
    this.nestedActionsOverride.set(!this.nestedActionsOpen());
  }

  setJobFilter(filter: JobFilter): void {
    this.jobFilterTouched = true;
    this.jobFilter.set(filter);
  }

  toggleJob(view: JobView, event?: Event): void {
    event?.stopPropagation();
    if (!view.hasSteps) {
      this.openLink(view.url);
      return;
    }
    this.jobOpen.update((state) => ({ ...state, [view.name]: !view.open }));
  }
}

function chipStatus(job: ReleaseDeployJob | ReleaseDeployJobStep): JobChipStatus {
  const conclusion = job.conclusion?.trim();
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
    return 'failure';
  }
  if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') {
    return 'success';
  }
  const status = job.status.trim();
  if (status === 'completed') return 'success';
  if (
    status === 'queued' ||
    status === 'in_progress' ||
    status === 'waiting' ||
    status === 'requested'
  ) {
    return 'pending';
  }
  return 'unknown';
}

function statusLabelOf(job: ReleaseDeployJob | ReleaseDeployJobStep, chip: JobChipStatus): string {
  if (chip === 'success') {
    if (job.conclusion === 'skipped') return 'Skipped';
    return 'Passed';
  }
  if (chip === 'failure') return job.conclusion?.trim() || 'Failed';
  if (chip === 'pending') {
    if (job.status === 'queued' || job.status === 'waiting' || job.status === 'requested') {
      return 'Queued';
    }
    return 'Running';
  }
  return job.status || 'Pending';
}

function durationOf(item: ReleaseDeployJob | ReleaseDeployJobStep, now: number): string {
  const start = Date.parse(item.startedAt ?? '');
  if (Number.isNaN(start)) return '';
  const endRaw = item.completedAt ? Date.parse(item.completedAt) : now;
  const end = Number.isNaN(endRaw) ? now : endRaw;
  return formatElapsed(Math.max(0, end - start));
}

function toStepView(step: ReleaseDeployJobStep, index: number, now: number): JobStepView {
  const chip = chipStatus(step);
  return {
    key: `${step.number ?? index}:${step.name}`,
    name: step.name,
    chip,
    statusLabel: statusLabelOf(step, chip),
    duration: durationOf(step, now),
    active: chip === 'pending',
  };
}

function isActionsPhase(phase: ReleasePhase): boolean {
  return phase === 'deploying' || phase === 'ci' || phase === 'publishing';
}

function phaseLabel(phase: ReleasePhase): string {
  switch (phase) {
    case 'preparing':
      return 'Preparing…';
    case 'bumping':
      return 'Bumping versions…';
    case 'staging':
      return 'Staging…';
    case 'committing':
      return 'Committing…';
    case 'tagging':
      return 'Tagging…';
    case 'pushing':
      return 'Pushing…';
    case 'deploying':
      return 'Starting deploy…';
    case 'ci':
      return 'Building on GitHub…';
    case 'publishing':
      return 'Publishing release…';
    case 'done':
      return 'Complete';
    case 'error':
      return 'Failed';
    default:
      return 'Idle';
  }
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatDeployJobName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('stabilize') || lower.includes('stable download')) return 'Stable download names';
  if (lower.includes('create-release') || lower === 'github release') return 'GitHub Release';
  if (lower.includes('android')) return 'Android';
  if (lower.includes('windows')) return 'Windows';
  if (lower.includes('ubuntu') || lower.includes('linux')) return 'Linux';
  if (lower.includes('macos') && (lower.includes('arm') || lower.includes('aarch64'))) return 'macOS arm64';
  if (lower.includes('macos') && (lower.includes('intel') || lower.includes('x64') || lower.includes('x86'))) {
    return 'macOS Intel';
  }
  if (lower.includes('macos')) return 'macOS';
  const trimmed = name
    .replace(/^publish-tauri\s*/i, '')
    .replace(/[()]/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed || name;
}
