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
import type { PrReviewerPerson, PrReviewerState } from '../../../core/models';
import {
  prReviewerGroups,
  prReviewerInitials,
  prReviewerStateLabel,
  prReviewerSummary,
} from '../../../core/models';
import { identityColor } from '../../../shared/ui/identity-color';

@Component({
  selector: 'app-pr-reviewers',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './pr-reviewers.html',
  styleUrl: './pr-reviewers.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrReviewers {
  readonly people = input<PrReviewerPerson[]>([]);
  readonly reviewState = input<string | null>(null);
  readonly emptyLabel = input('No reviewers');
  readonly compactLimit = input(7);

  readonly open = signal(false);
  readonly identityColor = identityColor;
  readonly initials = prReviewerInitials;
  readonly stateLabel = prReviewerStateLabel;

  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  readonly groups = computed(() => prReviewerGroups(this.people()));
  readonly summary = computed(() => prReviewerSummary(this.people(), this.emptyLabel()));
  readonly compact = computed(() => this.people().slice(0, this.compactLimit()));
  readonly extra = computed(() => Math.max(0, this.people().length - this.compactLimit()));

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

  stateIcon(state: PrReviewerState): string {
    if (state === 'approved') return 'lucideCheck';
    if (state === 'changes') return 'lucideX';
    if (state === 'commented') return 'lucideMessageSquare';
    return 'lucideMinus';
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
