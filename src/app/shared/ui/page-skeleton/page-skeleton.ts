import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Skeleton } from '../skeleton/skeleton';

@Component({
  selector: 'app-page-skeleton',
  imports: [Skeleton],
  templateUrl: './page-skeleton.html',
  styleUrl: './page-skeleton.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageSkeleton {
  readonly cards = input(4);
  readonly showAside = input(false);

  readonly cardSlots = computed(() => {
    const n = Math.max(1, Math.min(8, Math.floor(this.cards() || 4)));
    return Array.from({ length: n }, (_, i) => i);
  });
}
