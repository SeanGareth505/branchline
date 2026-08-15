import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { NgIcon } from '@ng-icons/core';

@Component({
  selector: 'app-help-tip',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './help-tip.html',
  styleUrl: './help-tip.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpTip {
  readonly heading = input('');
  readonly body = input('');
  readonly compact = input(false, { transform: booleanAttribute });

  readonly open = signal(false);
  private readonly originDir = viewChild.required(CdkOverlayOrigin);

  readonly label = computed(() => {
    const heading = this.heading().trim();
    return heading ? `About ${heading}` : 'About this screen';
  });

  readonly iconSize = computed(() => (this.compact() ? '12' : '15'));

  readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
    { originX: 'end', originY: 'center', overlayX: 'start', overlayY: 'center', offsetX: 8 },
  ];

  toggle(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.open.update((open) => !open);
  }

  close(): void {
    this.open.set(false);
  }

  onOutside(event: MouseEvent): void {
    const originEl = this.originDir().elementRef.nativeElement as HTMLElement;
    if (originEl.contains(event.target as Node)) return;
    this.close();
  }
}
