import { Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { AppStore } from '../../../core/app.store';
import type { ReleaseActivityStep, ReleasePhase } from '../../../core/models';

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
