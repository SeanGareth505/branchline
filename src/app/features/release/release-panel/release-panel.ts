import { Component, computed, effect, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppStore } from '../../../core/app.store';
import { UpdateService, UPDATE_DOWNLOAD_PAGE } from '../../../core/update.service';
import type { ReleaseActivityStep, ReleaseDeployJob, ReleasePhase } from '../../../core/models';

interface ReleaseLinkCard {
  id: string;
  label: string;
  hint: string;
  url: string;
  icon: string;
}

@Component({
  selector: 'app-release-panel',
  imports: [NgIcon],
  templateUrl: './release-panel.html',
  styleUrl: './release-panel.scss',
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
        hint: 'release-desktop.yml',
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

  readonly jobSummary = computed(() => {
    const jobs = this.deployJobs();
    if (!jobs.length) return '';
    let passed = 0;
    let failed = 0;
    let running = 0;
    for (const job of jobs) {
      const chip = this.jobChipStatus(job);
      if (chip === 'success') passed += 1;
      else if (chip === 'failure') failed += 1;
      else if (chip === 'pending') running += 1;
    }
    if (failed) return `${passed}/${jobs.length} passed · ${failed} failed`;
    if (running) return `${passed}/${jobs.length} passed · ${running} running`;
    return `${passed}/${jobs.length} passed`;
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

  trackJob(_index: number, job: ReleaseDeployJob): string {
    return `${job.name}:${job.status}:${job.conclusion ?? ''}`;
  }

  jobLabel(job: ReleaseDeployJob): string {
    return formatDeployJobName(job.name);
  }

  jobChipStatus(job: ReleaseDeployJob): string {
    const conclusion = job.conclusion?.trim();
    if (conclusion === 'success') return 'success';
    if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
      return 'failure';
    }
    const status = job.status.trim();
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

  jobStatusLabel(job: ReleaseDeployJob): string {
    const chip = this.jobChipStatus(job);
    if (chip === 'success') return 'Passed';
    if (chip === 'failure') return job.conclusion?.trim() || 'Failed';
    if (chip === 'pending') {
      if (job.status === 'queued' || job.status === 'waiting' || job.status === 'requested') {
        return 'Queued';
      }
      return 'Running';
    }
    return job.status || 'Pending';
  }
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
  if (lower.includes('stabilize')) return 'Stable download names';
  if (lower.includes('aarch64-apple-darwin')) return 'macOS arm64';
  if (lower.includes('x86_64-apple-darwin')) return 'macOS Intel';
  if (lower.includes('android')) return 'Android';
  if (lower.includes('windows')) return 'Windows';
  if (lower.includes('ubuntu') || lower.includes('linux')) return 'Linux';
  if (lower.includes('macos') && lower.includes('aarch64')) return 'macOS arm64';
  if (lower.includes('macos') && (lower.includes('x64') || lower.includes('x86'))) return 'macOS Intel';
  if (lower.includes('macos')) return 'macOS';
  const trimmed = name
    .replace(/^publish-tauri\s*/i, '')
    .replace(/[()]/g, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return trimmed || name;
}
