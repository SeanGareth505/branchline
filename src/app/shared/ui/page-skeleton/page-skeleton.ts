import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { Skeleton } from '../skeleton/skeleton';

@Component({
  selector: 'app-page-skeleton',
  imports: [Skeleton],
  templateUrl: './page-skeleton.html',
  styleUrl: './page-skeleton.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageSkeleton {
  @Input() set cards(value: number) {
    const n = Math.max(1, Math.min(8, Math.floor(value || 4)));
    this.cardSlots = Array.from({ length: n }, (_, i) => i);
  }
  @Input() showAside = false;

  cardSlots = [0, 1, 2, 3];
}
