import { Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
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
    return `Releasing ${activity.productName} ${activity.currentVersion} → ${activity.nextVersion}`;
  });

  readonly statusLabel = computed(() => {
    const activity = this.activity();
    if (!activity) return '';
    if (activity.phase === 'done') return 'Complete';
    if (activity.phase === 'error') return 'Failed';
    if (this.busy()) return phaseLabel(activity.phase);
    return phaseLabel(activity.phase);
  });

  clear(): void {
    this.store.clearReleaseActivity();
  }

  startRelease(): void {
    void this.store.startReleaseFlow();
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
    case 'done':
      return 'Complete';
    case 'error':
      return 'Failed';
    default:
      return 'Idle';
  }
}
