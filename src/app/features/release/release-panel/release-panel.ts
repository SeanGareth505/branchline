import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppStore } from '../../../core/app.store';
import { UpdateService, UPDATE_DOWNLOAD_PAGE } from '../../../core/update.service';
import type {
  ReleaseActivity,
  ReleaseActivityStep,
  ReleaseDeployJob,
  ReleasePhase,
} from '../../../core/models';
import { ReleaseNotesEditor } from '../release-notes-editor/release-notes-editor';

type ArtifactStatus = 'success' | 'failure' | 'pending' | 'unknown';

interface ReleaseLinkCard {
  id: string;
  label: string;
  hint: string;
  url: string;
  icon: string;
}

interface ArtifactView {
  name: string;
  label: string;
  chip: ArtifactStatus;
  statusLabel: string;
  duration: string;
  url: string | null;
  icon: string;
}

interface ProgressStepView {
  id: string;
  status: ReleaseActivityStep['status'];
  label: string;
  detail: string;
  stateLabel: string;
  duration: string;
  artifacts: ArtifactView[];
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

  readonly githubLinked = computed(() => this.store.hasGithubConnection());

  readonly linkCards = computed((): ReleaseLinkCard[] => {
    const activity = this.activity();
    if (!activity) return [];
    const cards: ReleaseLinkCard[] = [];
    if (activity.releaseUrl) {
      cards.push({
        id: 'release',
        label: 'GitHub release',
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

  readonly artifacts = computed((): ArtifactView[] => {
    const now = this.now();
    return this.deployJobs().map((job) => {
      const chip = chipStatus(job);
      const label = formatDeployJobName(job.name);
      return {
        name: job.name,
        label,
        chip,
        statusLabel: statusLabelOf(job, chip),
        duration: durationOf(job, now),
        url: job.url ?? null,
        icon: artifactIcon(label, job.name),
      };
    });
  });

  readonly showReleaseDetails = computed(() => !!this.activity());

  readonly jobSummary = computed(() => {
    const jobs = this.deployJobs();
    if (!jobs.length) return '';
    const counts = this.jobCounts();
    if (counts.failed) return `${counts.completed} of ${jobs.length} ready · ${counts.failed} failed`;
    if (counts.in_progress) {
      return `${counts.completed} of ${jobs.length} ready · ${counts.in_progress} building`;
    }
    return `${counts.completed} of ${jobs.length} ready`;
  });

  readonly progressSteps = computed((): ProgressStepView[] => {
    const activity = this.activity();
    if (!activity?.steps.length) return [];
    const now = this.now();
    const artifacts = this.artifacts();
    const nestId = nestArtifactsUnder(activity.steps);
    return activity.steps.map((step, index) => ({
      id: step.id,
      status: step.status,
      label: step.label,
      detail: stepDetail(step, activity, this.jobSummary()),
      stateLabel: stepStateLabel(step.status),
      duration: stepDuration(activity.steps, index, now),
      artifacts: nestId === step.id ? artifacts : [],
    }));
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
    if (activity.currentVersion !== activity.nextVersion) {
      return `${activity.currentVersion} → ${activity.nextVersion}`;
    }
    return activity.message || '';
  });

  readonly primaryActions = computed((): { id: string; label: string; primary: boolean }[] => {
    const actions: { id: string; label: string; primary: boolean }[] = [];
    if (this.showPushFallback()) {
      actions.push({ id: 'push', label: 'Push release', primary: true });
    }
    if (this.trackingPaused()) {
      actions.push({ id: 'refresh', label: 'Refresh status', primary: true });
      if (!this.githubLinked()) {
        actions.push({ id: 'github', label: 'Link GitHub', primary: false });
      }
    }
    if (this.shippedLive()) {
      actions.push({ id: 'updates', label: 'Check for updates', primary: true });
    }
    return actions;
  });

  readonly finalStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (this.shippedLive()) {
      return 'On GitHub. Users pick it up the next time they open the app.';
    }
    if (activity.needsRefresh) {
      return activity.message || 'Refresh to keep watching the installer builds.';
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
      if (!this.shippedLive() || this.promptedUpdate) return;
      this.promptedUpdate = true;
      void this.updates.checkForUpdates({ silent: true });
    });
  }

  clear(): void {
    this.store.clearReleaseActivity();
  }

  startRelease(): void {
    void this.store.startReleaseFlow();
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
}

function nestArtifactsUnder(steps: ReleaseActivityStep[]): string | null {
  const ci = steps.find((step) => step.phase === 'ci');
  const deploying = steps.find((step) => step.phase === 'deploying');
  if (ci && ci.status !== 'pending') return ci.id;
  if (deploying && deploying.status !== 'pending') return deploying.id;
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
    return jobSummary || step.message;
  }
  if (step.phase === 'publishing' && (activity.releaseUrl || step.status === 'done')) {
    return 'GitHub release is live';
  }
  return step.message;
}

function stepStateLabel(status: ReleaseActivityStep['status']): string {
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

function chipStatus(job: ReleaseDeployJob): ArtifactStatus {
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

function statusLabelOf(job: ReleaseDeployJob, chip: ArtifactStatus): string {
  if (chip === 'success') {
    if (job.conclusion === 'skipped') return 'Skipped';
    return 'Ready';
  }
  if (chip === 'failure') return job.conclusion?.trim() || 'Failed';
  if (chip === 'pending') {
    if (job.status === 'queued' || job.status === 'waiting' || job.status === 'requested') {
      return 'Waiting';
    }
    return 'Building';
  }
  return job.status || 'Waiting';
}

function durationOf(item: ReleaseDeployJob, now: number): string {
  const start = Date.parse(item.startedAt ?? '');
  if (Number.isNaN(start)) return '';
  const endRaw = item.completedAt ? Date.parse(item.completedAt) : now;
  const end = Number.isNaN(endRaw) ? now : endRaw;
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
      return 'Waiting for installer builds…';
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

function artifactIcon(label: string, name: string): string {
  const text = `${label} ${name}`.toLowerCase();
  if (text.includes('github release') || text.includes('create-release')) return 'lucideTag';
  if (text.includes('download')) return 'lucideLink';
  if (text.includes('android') || text.includes('windows') || text.includes('linux') || text.includes('macos')) {
    return 'lucideDownload';
  }
  return 'lucideArchive';
}
