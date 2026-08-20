import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { format } from 'date-fns';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppStore } from '../../../core/app.store';
import { UpdateService } from '../../../core/update.service';
import type {
  ReleaseActivity,
  ReleaseActivityStep,
  ReleaseDeployJob,
  ReleasePhase,
  ReleaseStatusOutput,
} from '../../../core/models';
import { ReleaseNotesEditor } from '../release-notes-editor/release-notes-editor';
import {
  actionsWebUrl,
  releaseWorkflowWebUrl,
  tagWebUrl,
} from '../../../shared/git/repo-links';

type ArtifactStatus = 'success' | 'failure' | 'pending' | 'queued' | 'unknown';
type JobFilter = 'all' | 'queued' | 'building' | 'ready' | 'failed';

interface ToolbarAction {
  id: string;
  label: string;
  primary: boolean;
  icon: string | null;
  title: string;
}

interface JobChildView {
  id: string;
  label: string;
  chip: ArtifactStatus;
  statusLabel: string;
  duration: string;
  when: string;
}

interface ArtifactView {
  name: string;
  label: string;
  step: string;
  chip: ArtifactStatus;
  statusLabel: string;
  duration: string;
  when: string;
  url: string | null;
  children: JobChildView[];
}

interface ProgressStepView {
  id: string;
  status: ReleaseActivityStep['status'];
  label: string;
  detail: string;
  stateLabel: string;
  duration: string;
  when: string;
  artifacts: ArtifactView[];
  actionUrl: string | null;
  actionLabel: string;
  waitingRemote: boolean;
}

@Component({
  selector: 'app-release-panel',
  imports: [NgIcon, ReleaseNotesEditor],
  templateUrl: './release-panel.html',
  styleUrl: './release-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleasePanel {
  readonly store = inject(AppStore);
  readonly releaseStatus = input<ReleaseStatusOutput | null>(null);
  private readonly updates = inject(UpdateService);
  private readonly now = signal(Date.now());
  private promptedVersion = '';
  private autoSyncedTag: string | null = null;
  private readonly expandedJobs = signal(new Set<string>());
  readonly jobFilter = signal<JobFilter>('all');

  readonly activity = computed(() => this.store.visibleReleaseActivity());
  readonly busy = computed(() => this.store.visibleReleaseBusy());
  readonly deployChecking = computed(
    () => !!this.activity() && this.store.releaseDeployChecking(),
  );
  readonly currentVersion = computed(() => this.releaseStatus()?.currentVersion?.trim() || '0.0.0');
  readonly productName = computed(
    () => this.releaseStatus()?.config?.productName || this.store.currentRepo()?.name || 'App',
  );
  readonly currentBranch = computed(
    () => this.releaseStatus()?.currentBranch || this.releaseStatus()?.config?.branch || '',
  );
  readonly isDirty = computed(() => !!this.releaseStatus()?.dirty);
  readonly createTagDefault = computed(
    () => this.releaseStatus()?.config?.createTagDefault !== false,
  );
  readonly pushDefault = computed(() => this.releaseStatus()?.config?.pushDefault !== false);
  readonly versionFiles = computed(() => {
    const files = this.releaseStatus()?.config?.files ?? [];
    if (!files.length) return '';
    return files.join(' · ');
  });
  readonly bumpChoices = computed(() => {
    const current = this.currentVersion();
    return [
      { kind: 'patch' as const, label: 'Patch', hint: 'Fixes', next: nextSemver(current, 'patch') },
      { kind: 'minor' as const, label: 'Minor', hint: 'Features', next: nextSemver(current, 'minor') },
      { kind: 'major' as const, label: 'Major', hint: 'Breaking', next: nextSemver(current, 'major') },
    ];
  });

  readonly elapsed = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    const end = activity.finishedAt ?? this.now();
    return formatElapsed(Math.max(0, end - activity.startedAt));
  });

  readonly startedLabel = computed(() => {
    const activity = this.activity();
    if (!activity?.startedAt) return '';
    return formatClock(activity.startedAt);
  });

  readonly finishedLabel = computed(() => {
    const activity = this.activity();
    if (!activity?.finishedAt) return '';
    return formatClock(activity.finishedAt);
  });

  readonly whenLabel = computed(() => {
    const started = this.startedLabel();
    if (!started) return '';
    const parts = [`Started ${started}`];
    const finished = this.finishedLabel();
    if (finished) parts.push(`Finished ${finished}`);
    const elapsed = this.elapsed();
    if (elapsed) parts.push(elapsed);
    return parts.join(' · ');
  });

  readonly trackingPaused = computed(() => {
    const activity = this.activity();
    return !!activity?.needsRefresh && !this.busy();
  });

  readonly canRefreshDeploy = computed(() => {
    const activity = this.activity();
    return !!activity?.tag && !!activity.willPush && !activity.needsPush;
  });

  readonly watchingGithub = computed(() => {
    const activity = this.activity();
    if (!activity || activity.needsRefresh || activity.needsPush) return false;
    return (
      activity.phase === 'deploying' ||
      activity.phase === 'ci' ||
      activity.phase === 'publishing'
    );
  });

  readonly githubWaitEmpty = computed(() => {
    return this.watchingGithub() && this.deployJobs().length === 0;
  });

  private readonly githubWatchStale = computed(() => {
    if (!this.githubWaitEmpty()) return false;
    const activity = this.activity();
    const step = activity?.steps.find((item) => item.phase === 'deploying');
    const start = step?.at ?? activity?.startedAt;
    if (!start) return false;
    return this.now() - start > 90_000;
  });

  readonly refreshLocked = computed(() => {
    const phase = this.activity()?.phase;
    if (!this.busy()) return false;
    return (
      phase === 'preparing' ||
      phase === 'bumping' ||
      phase === 'staging' ||
      phase === 'committing' ||
      phase === 'tagging' ||
      phase === 'pushing'
    );
  });

  readonly githubLinked = computed(() => this.store.hasGithubConnection());

  readonly originUrl = computed(() => this.store.originFetchUrl() ?? '');

  readonly deployUrl = computed(() => {
    const activity = this.activity();
    if (!activity?.willPush || activity.needsPush) return null;
    return (
      activity.deployRunUrl?.trim() ||
      activity.actionsPageUrl?.trim() ||
      releaseWorkflowWebUrl(this.originUrl()) ||
      actionsWebUrl(this.originUrl())
    );
  });

  readonly githubReleaseUrl = computed(() => {
    const activity = this.activity();
    const tag = activity?.tag?.trim();
    if (!activity || activity.willTag === false || !tag) return null;
    return activity.releaseUrl?.trim() || tagWebUrl(this.originUrl(), tag);
  });

  readonly toolbarActions = computed((): ToolbarAction[] => {
    const activity = this.activity();
    if (!activity) return [];
    const actions: ToolbarAction[] = [];

    if (this.showPushFallback()) {
      actions.push({
        id: 'push',
        label: 'Push release',
        primary: true,
        icon: 'lucideUpload',
        title: 'Push the release tag to origin',
      });
    }

    if (this.canRefreshDeploy() && this.trackingPaused()) {
      actions.push({
        id: 'refresh',
        label: 'Refresh status',
        primary: true,
        icon: 'lucideRefreshCw',
        title: 'Reload installer build status from GitHub',
      });
    }

    const deploy = this.deployUrl();
    if (deploy && !this.shippedLive()) {
      const hasDeployRun = !!activity.deployRunUrl?.trim();
      actions.push({
        id: 'deploy',
        label: hasDeployRun ? 'Open deploy' : 'Open Actions',
        primary: !this.showPushFallback() && !this.trackingPaused(),
        icon: hasDeployRun ? 'lucideExternalLink' : 'lucideWorkflow',
        title: hasDeployRun
          ? 'Open this installer run on GitHub Actions'
          : 'Open the release workflow on GitHub Actions',
      });
    }

    const release = this.githubReleaseUrl();
    if (release && (activity.releaseUrl || activity.phase === 'done')) {
      actions.push({
        id: 'release',
        label: 'Open release',
        primary: false,
        icon: 'lucideTag',
        title: activity.tag,
      });
    }

    const pageUrl = activity.websiteUrl?.trim();
    if (pageUrl && (activity.releaseUrl || activity.phase === 'done')) {
      actions.push({
        id: 'website',
        label: 'Download page',
        primary: false,
        icon: 'lucideGlobe',
        title: 'Updates and installers',
      });
    }

    if (this.trackingPaused() && !this.githubLinked()) {
      actions.push({
        id: 'github',
        label: 'Link GitHub',
        primary: false,
        icon: 'lucideGithub',
        title: 'Connect GitHub to keep tracking this release',
      });
    }

    if (this.shippedLive()) {
      actions.push({
        id: 'updates',
        label: 'Check for updates',
        primary: false,
        icon: 'lucideDownload',
        title: 'Check for a newer Branchline build',
      });
    }

    return actions;
  });

  readonly deployJobs = computed(() => this.activity()?.deployJobs ?? []);

  readonly jobCounts = computed(() => {
    let queued = 0;
    let building = 0;
    let completed = 0;
    let failed = 0;
    for (const job of this.deployJobs()) {
      const chip = chipStatus(job);
      if (chip === 'success') completed += 1;
      else if (chip === 'failure') failed += 1;
      else if (chip === 'pending') building += 1;
      else queued += 1;
    }
    return { queued, building, completed, failed };
  });

  readonly artifacts = computed((): ArtifactView[] => {
    const now = this.now();
    return this.deployJobs().map((job) => {
      const chip = chipStatus(job);
      const label = formatDeployJobName(job.name);
      return {
        name: job.name,
        label,
        step: currentJobStep(job, chip),
        chip,
        statusLabel: statusLabelOf(job, chip),
        duration: durationOf(job, now),
        when: formatClock(job.startedAt),
        url: job.url ?? null,
        children: (job.steps ?? []).map((child, index) => {
          const childChip = chipStatus(child);
          return {
            id: `${job.name}:${child.number ?? index}:${child.name}`,
            label: shortenJobStep(child.name),
            chip: childChip,
            statusLabel:
              childChip === 'success' && child.conclusion !== 'skipped'
                ? 'Done'
                : statusLabelOf(child, childChip),
            duration: durationOf(child, now),
            when: formatClock(child.startedAt),
          };
        }),
      };
    });
  });

  readonly jobSummary = computed(() => {
    const jobs = this.deployJobs();
    if (!jobs.length) return '';
    const counts = this.jobCounts();
    if (counts.failed) return `${counts.completed} of ${jobs.length} ready · ${counts.failed} failed`;
    const parts: string[] = [];
    if (counts.completed) parts.push(`${counts.completed} of ${jobs.length} ready`);
    if (counts.building) parts.push(`${counts.building} building`);
    if (counts.queued) parts.push(`${counts.queued} queued`);
    if (parts.length) return parts.join(' · ');
    return `${counts.completed} of ${jobs.length} ready`;
  });

  readonly progressSteps = computed((): ProgressStepView[] => {
    const activity = this.activity();
    if (!activity?.steps.length) return [];
    const now = this.now();
    const artifacts = this.artifacts();
    const nestId = nestArtifactsUnder(activity.steps);
    const origin = this.originUrl();
    return activity.steps.map((step, index) => {
      const action = stepOpenAction(step, activity, origin);
      const waitingRemote =
        step.status === 'active' &&
        (step.phase === 'ci' || step.phase === 'deploying' || step.phase === 'publishing');
      return {
        id: step.id,
        status: step.status,
        label: step.phase === 'deploying' ? 'GitHub Actions' : step.label,
        detail: stepDetail(step, activity, nestId === step.id ? this.jobSummary() : ''),
        stateLabel: stepStateLabel(step.status, waitingRemote),
        duration: stepDuration(activity.steps, index, now),
        when:
          step.status === 'done' || step.status === 'error' ? formatClock(step.at) : '',
        artifacts: nestId === step.id ? artifacts : [],
        actionUrl: action?.url ?? null,
        actionLabel: action?.label ?? '',
        waitingRemote,
      };
    });
  });

  readonly progressSummary = computed(() => {
    const steps = this.progressSteps();
    if (!steps.length) return '';
    const done = steps.filter((step) => step.status === 'done').length;
    const failed = steps.find((step) => step.status === 'error');
    if (failed) return `${done} of ${steps.length} · failed at ${failed.label.toLowerCase()}`;
    const active = steps.find((step) => step.status === 'active');
    if (active) return `${done} of ${steps.length} · ${active.label}`;
    if (done === steps.length) return `${done} of ${steps.length} done`;
    return `${done} of ${steps.length}`;
  });

  readonly progressPct = computed((): number => {
    const steps = this.progressSteps();
    if (!steps.length) return 0;
    const done = steps.filter((step) => step.status === 'done').length;
    let pct = (done / steps.length) * 100;
    const active = steps.find((step) => step.status === 'active');
    if (active?.status === 'active') {
      const jobs = this.deployJobs();
      if ((active.id === 'ci' || active.id === 'deploying') && jobs.length) {
        pct += (this.jobCounts().completed / jobs.length) * (100 / steps.length);
      } else {
        pct += 40 / steps.length;
      }
    }
    return Math.max(4, Math.min(100, Math.round(pct)));
  });

  readonly workflowStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return 'idle';
    if (activity.phase === 'error') return 'failure';
    if (activity.phase === 'done' && !activity.needsRefresh) return 'success';
    if (activity.needsRefresh) return 'paused';
    if (this.githubWaitEmpty()) return 'watching';
    if (activity.phase === 'ci' || activity.phase === 'deploying' || activity.phase === 'publishing') {
      return 'running';
    }
    return 'idle';
  });

  readonly headline = computed(() => {
    const activity = this.activity();
    if (!activity) return 'No release in progress';
    if (activity.phase === 'done' && !activity.needsRefresh) {
      if (activity.willTag === false) {
        return `Updated ${activity.productName} to ${activity.nextVersion}`;
      }
      return `Released ${activity.productName} ${activity.nextVersion}`;
    }
    if (activity.phase === 'error') {
      return `Release failed`;
    }
    if (activity.needsRefresh) {
      return `Tracking paused for ${activity.productName} ${activity.nextVersion}`;
    }
    if (this.githubWaitEmpty()) {
      return `Waiting on GitHub for ${activity.productName} ${activity.nextVersion}`;
    }
    if (activity.phase === 'deploying' || activity.phase === 'ci' || activity.phase === 'publishing') {
      return `Building ${activity.productName} ${activity.nextVersion}`;
    }
    return `Releasing ${activity.productName} ${activity.currentVersion} → ${activity.nextVersion}`;
  });

  readonly statusLabel = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (activity.phase === 'done' && !activity.needsRefresh) return 'Complete';
    if (activity.phase === 'error') return 'Failed';
    if (activity.needsRefresh) return 'Paused — refresh to continue';
    if (this.githubWaitEmpty()) return 'Watching GitHub';
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

  readonly statusDetail = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (this.finalStatus()) return this.finalStatus();
    return activity.message || '';
  });

  readonly finalStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (activity.phase === 'done' && activity.willTag === false) {
      return 'Version files were updated and committed without creating a tag.';
    }
    if (this.shippedLive()) {
      return 'On GitHub. Users pick it up the next time they open the app.';
    }
    if (activity.needsRefresh) {
      return activity.message || 'Refresh to keep watching the installer builds.';
    }
    if (this.githubWaitEmpty()) {
      return 'The tag is on origin. GitHub usually reports jobs within a minute.';
    }
    if (activity.phase === 'done' && activity.needsPush) {
      return 'Tagged locally. Push to origin to publish.';
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
      const id = window.setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => window.clearInterval(id));
    });
    effect(() => {
      if (!this.shippedLive()) return;
      const version = this.activity()?.nextVersion?.trim();
      if (!version || this.promptedVersion === version) return;
      this.promptedVersion = version;
      this.updates.watchUntilAvailable(version);
    });
    effect(() => {
      if (!this.githubWatchStale() || !this.canRefreshDeploy()) {
        if (!this.githubWatchStale()) this.autoSyncedTag = null;
        return;
      }
      const tag = this.activity()?.tag?.trim();
      if (!tag || this.autoSyncedTag === tag) return;
      this.autoSyncedTag = tag;
      queueMicrotask(() => this.refreshDeploy());
    });
  }

  clear(): void {
    this.store.clearReleaseActivity();
  }

  startRelease(kind?: 'patch' | 'minor' | 'major'): void {
    void this.store.startReleaseFlow(kind);
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

  runAction(id: string): void {
    if (id === 'push') this.pushRelease();
    else if (id === 'refresh') this.refreshDeploy();
    else if (id === 'github') this.openGithubSettings();
    else if (id === 'updates') this.checkForUpdates();
    else if (id === 'deploy') this.openLink(this.deployUrl());
    else if (id === 'release') this.openLink(this.githubReleaseUrl());
    else if (id === 'website') this.openLink(this.activity()?.websiteUrl);
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

  isJobExpanded(name: string): boolean {
    return this.expandedJobs().has(name);
  }

  toggleJob(name: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.expandedJobs.update((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  setJobFilter(filter: JobFilter, event?: Event): void {
    event?.stopPropagation();
    this.jobFilter.set(filter);
  }

  matchesJobFilter(item: ArtifactView): boolean {
    const filter = this.jobFilter();
    if (filter === 'all') return true;
    if (filter === 'queued') return item.chip === 'queued' || item.chip === 'unknown';
    if (filter === 'building') return item.chip === 'pending';
    if (filter === 'ready') return item.chip === 'success';
    return item.chip === 'failure';
  }

  visibleArtifacts(items: ArtifactView[]): ArtifactView[] {
    return items.filter((item) => this.matchesJobFilter(item));
  }

  showJobFilters(): boolean {
    const counts = this.jobCounts();
    const kinds = [counts.queued, counts.building, counts.completed, counts.failed].filter(
      (count) => count > 0,
    ).length;
    return kinds > 1;
  }

  filterEmptyLabel(): string {
    const filter = this.jobFilter();
    if (filter === 'queued') return 'No queued jobs';
    if (filter === 'building') return 'Nothing building';
    if (filter === 'ready') return 'No ready installers yet';
    if (filter === 'failed') return 'No failed jobs';
    return 'No jobs';
  }
}

function nextSemver(current: string, kind: 'patch' | 'minor' | 'major'): string {
  const core = current.trim().split('-')[0]?.split('+')[0] ?? '';
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return current;
  const [major, minor, patch] = parts;
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function nestArtifactsUnder(steps: ReleaseActivityStep[]): string | null {
  const ci = steps.find((step) => step.phase === 'ci');
  const deploying = steps.find((step) => step.phase === 'deploying');
  if (ci && ci.status !== 'pending') return ci.id;
  if (deploying && deploying.status !== 'pending') return deploying.id;
  return null;
}

function stepOpenAction(
  step: ReleaseActivityStep,
  activity: ReleaseActivity,
  originUrl: string,
): { url: string; label: string } | null {
  if (step.status === 'pending') return null;
  if (step.phase === 'ci' || step.phase === 'deploying') {
    const url =
      activity.deployRunUrl?.trim() ||
      activity.actionsPageUrl?.trim() ||
      releaseWorkflowWebUrl(originUrl) ||
      actionsWebUrl(originUrl);
    if (!url) return null;
    return {
      url,
      label: activity.deployRunUrl ? 'Open deploy' : 'Open Actions',
    };
  }
  if (step.phase === 'publishing') {
    const url = activity.releaseUrl?.trim() || tagWebUrl(originUrl, activity.tag);
    if (!url) return null;
    return { url, label: 'Open release' };
  }
  return null;
}

function stepDetail(
  step: ReleaseActivityStep,
  activity: ReleaseActivity,
  jobSummary: string,
): string {
  if (step.status === 'pending') return step.message;
  if (step.phase === 'bumping' && activity.currentVersion !== activity.nextVersion) {
    return `${activity.currentVersion} → ${activity.nextVersion}`;
  }
  if (step.phase === 'committing') {
    return `Release ${activity.nextVersion}`;
  }
  if (step.phase === 'tagging') {
    return activity.tag || step.message;
  }
  if (step.phase === 'pushing' && step.status === 'done') {
    return `Pushed ${activity.tag} to origin`;
  }
  if (step.phase === 'ci' || step.phase === 'deploying') {
    if (jobSummary) return jobSummary;
    if (step.status === 'active') return 'Waiting for GitHub to report installer jobs';
    return step.message;
  }
  if (step.phase === 'publishing' && (activity.releaseUrl || step.status === 'done')) {
    return 'GitHub release is live';
  }
  return step.message;
}

function stepStateLabel(
  status: ReleaseActivityStep['status'],
  waitingRemote: boolean,
): string {
  if (waitingRemote && status === 'active') return 'Waiting on GitHub';
  switch (status) {
    case 'done':
      return 'Done';
    case 'active':
      return 'In progress';
    case 'error':
      return 'Failed';
    default:
      return 'Waiting';
  }
}

function stepDuration(steps: ReleaseActivityStep[], index: number, now: number): string {
  const step = steps[index];
  if (!step?.at || step.status === 'pending') return '';
  const nextStarted = steps.slice(index + 1).find((item) => item.at)?.at;
  const end = step.status === 'active' ? now : (nextStarted ?? now);
  const ms = Math.max(0, end - step.at);
  if (step.status === 'done' && ms < 500) return '';
  return formatElapsed(ms);
}

function chipStatus(job: Pick<ReleaseDeployJob, 'status' | 'conclusion'>): ArtifactStatus {
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
    conclusion === 'timed_out' ||
    conclusion === 'startup_failure' ||
    conclusion === 'action_required'
  ) {
    return 'failure';
  }
  if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') {
    return 'success';
  }
  if (status === 'completed') return 'success';
  return 'unknown';
}

function statusLabelOf(
  job: Pick<ReleaseDeployJob, 'status' | 'conclusion'>,
  chip: ArtifactStatus,
): string {
  if (chip === 'success') {
    if (job.conclusion?.trim().toLowerCase() === 'skipped') return 'Skipped';
    return 'Ready';
  }
  if (chip === 'failure') return job.conclusion?.trim() || 'Failed';
  if (chip === 'queued') return 'Queued';
  if (chip === 'pending') return 'Building';
  return job.status || 'Waiting';
}

function durationOf(
  item: Pick<ReleaseDeployJob, 'startedAt' | 'completedAt'>,
  now: number,
): string {
  const start = parseClock(item.startedAt);
  if (start == null) return '';
  const end = parseClock(item.completedAt) ?? now;
  return formatElapsed(Math.max(0, end - start));
}

function phaseLabel(phase: ReleasePhase): string {
  switch (phase) {
    case 'preparing':
      return 'Checking repo…';
    case 'bumping':
      return 'Writing versions…';
    case 'staging':
      return 'Staging files…';
    case 'committing':
      return 'Creating commit…';
    case 'tagging':
      return 'Creating tag…';
    case 'pushing':
      return 'Pushing to origin…';
    case 'deploying':
      return 'Watching GitHub…';
    case 'ci':
      return 'Building installers…';
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

const CLOCK_FLOOR = Date.UTC(2010, 0, 1);

function parseClock(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || Number.isNaN(ms) || ms < CLOCK_FLOOR) return null;
  return ms;
}

function formatClock(value: number | string | null | undefined): string {
  const ms = parseClock(value);
  if (ms == null) return '';
  return format(new Date(ms), 'd MMM yyyy, HH:mm');
}

function currentJobStep(job: ReleaseDeployJob, chip: ArtifactStatus): string {
  const steps = job.steps ?? [];
  if (!steps.length) return '';
  if (chip === 'failure') {
    const failed = [...steps].reverse().find((step) => step.conclusion === 'failure');
    return failed ? shortenJobStep(failed.name) : '';
  }
  if (chip === 'success') return '';
  if (chip === 'queued') {
    const waiting = steps.find(
      (step) => step.status === 'queued' || step.status === 'pending' || step.status === 'waiting',
    );
    return waiting ? shortenJobStep(waiting.name) : 'Waiting to start';
  }
  const running = steps.find((step) => step.status === 'in_progress');
  if (running) return shortenJobStep(running.name);
  const waiting = steps.find(
    (step) => step.status === 'queued' || step.status === 'pending' || step.status === 'waiting',
  );
  if (waiting) return shortenJobStep(waiting.name);
  const last = [...steps].reverse().find((step) => step.status === 'completed' || !!step.conclusion);
  return last ? shortenJobStep(last.name) : '';
}

function shortenJobStep(name: string): string {
  let text = name.replace(/^Run\s+/i, '').trim();
  text = text.replace(/@[\w.-]+$/, '');
  const lower = text.toLowerCase();
  if (lower.includes('tauri-action') || lower.includes('tauri build')) return 'Packaging app';
  if (lower.includes('checkout')) return 'Checkout';
  if (lower.includes('setup node') || lower.includes('setup-node')) return 'Setup Node';
  if (lower.includes('install rust') || lower.includes('rust-toolchain')) return 'Install Rust';
  if (lower.includes('rust cache')) return 'Rust cache';
  if (lower.includes('frontend depend') || lower.includes('npm ci') || lower.includes('npm install')) {
    return 'Install npm';
  }
  if (lower.includes('linux depend')) return 'Linux deps';
  if (lower.includes('certificate') || lower.includes('signing')) return 'Signing';
  if (lower.includes('verify') && lower.includes('artifact')) return 'Verify artifacts';
  if (lower.includes('upload') || lower.includes('stabilize') || lower.includes('download')) {
    return 'Publish files';
  }
  if (text.length > 36) return `${text.slice(0, 34)}…`;
  return text;
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
