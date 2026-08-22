import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  HostListener,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { NgIcon } from '@ng-icons/core';
import type { MockPullRequest, PrCheckGroupState } from '../../../core/models';
import { prCheckGroups, prCheckTotal } from '../../../core/models';
import { checkLine } from '../pr-copy';

@Component({
  selector: 'app-pr-checks',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './pr-checks.html',
  styleUrl: './pr-checks.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrChecks {
  readonly pr = input.required<MockPullRequest>();

  readonly open = signal(false);
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  readonly groups = computed(() => prCheckGroups(this.pr()));
  readonly summary = computed(() => checkLine(this.pr()));
  readonly tone = computed(() => {
    const pr = this.pr();
    if ((pr.checkFailed ?? 0) > 0 || pr.pipelineStatus === 'failure') return 'failure';
    if ((pr.checkPending ?? 0) > 0 || pr.pipelineStatus === 'pending') return 'pending';
    if (prCheckTotal(pr) > 0 || pr.pipelineStatus === 'success') return 'success';
    return 'unknown';
  });

  readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 8 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 8 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -8 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -8 },
  ];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.clearHide());
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }

  groupIcon(state: PrCheckGroupState): string {
    if (state === 'failed') return 'lucideCircleAlert';
    if (state === 'pending') return 'lucideMinus';
    return 'lucideCheck';
  }

  show(): void {
    this.clearHide();
    this.open.set(true);
  }

  scheduleHide(): void {
    this.clearHide();
    this.hideTimer = setTimeout(() => this.open.set(false), 140);
  }

  keepOpen(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.show();
  }

  close(): void {
    this.clearHide();
    this.open.set(false);
  }

  private clearHide(): void {
    if (!this.hideTimer) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
