import { Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppStore } from '../../../core/app.store';
import { UPDATE_DOWNLOAD_PAGE } from '../../../core/update.service';
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

  readonly activity = computed(() => this.store.releaseActivity());
  readonly busy = computed(() => this.store.releaseBusy());

  readonly downloadPageUrl = computed(() => {
    const activity = this.activity();
    return activity?.websiteUrl?.trim() || UPDATE_DOWNLOAD_PAGE;
  });

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

  readonly showDeploySection = computed(() => {
    const activity = this.activity();
    if (!activity?.willPush && !activity?.deployRunUrl && !activity?.actionsPageUrl) return false;
    return this.deployJobs().length > 0 || this.busy() || !!activity?.deployRunUrl;
  });

  readonly workflowStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return 'idle';
    if (activity.phase === 'error') return 'failure';
    if (activity.phase === 'done') return 'success';
    if (activity.phase === 'ci' || activity.phase === 'deploying' || activity.phase === 'publishing') {
      return 'running';
    }
    return 'idle';
  });

  readonly headline = computed(() => {
    const activity = this.activity();
    if (!activity) return 'No release in progress';
    if (activity.phase === 'done') {
      return `Released ${activity.productName} ${activity.nextVersion}`;
    }
    if (activity.phase === 'error') {
      return `Release failed`;
    }
    if (activity.phase === 'deploying' || activity.phase === 'ci' || activity.phase === 'publishing') {
      return `Deploying ${activity.productName} ${activity.nextVersion}`;
    }
    return `Releasing ${activity.productName} ${activity.currentVersion} → ${activity.nextVersion}`;
  });

  readonly statusLabel = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (activity.phase === 'done') return 'Complete';
    if (activity.phase === 'error') return 'Failed';
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
      (activity.willPush || !!activity.releaseUrl)
    );
  });

  readonly finalStatus = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (this.shippedLive()) {
      return 'Waiting for users to get the update banner (next app launch/check)';
    }
    if (activity.phase === 'done' && activity.needsPush) {
      return 'Tagged locally — push to origin to publish and notify users';
    }
    if (activity.phase === 'error') {
      return activity.message;
    }
    return '';
  });

  clear(): void {
    this.store.clearReleaseActivity();
  }

  startRelease(): void {
    void this.store.startReleaseFlow();
  }

  pushRelease(): void {
    void this.store.pushReleaseTags();
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
    if (chip === 'pending') return 'Running';
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
