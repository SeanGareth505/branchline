import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  imports: [],
  templateUrl: './skeleton.html',
  styleUrl: './skeleton.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Skeleton {
  readonly width = input('100%');
  readonly height = input('0.85rem');
  readonly radius = input('8px');
  readonly variant = input<'line' | 'block' | 'circle'>('line');
}
