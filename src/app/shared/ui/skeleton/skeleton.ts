import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-skeleton',
  imports: [],
  templateUrl: './skeleton.html',
  styleUrl: './skeleton.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Skeleton {
  @Input() width = '100%';
  @Input() height = '0.85rem';
  @Input() radius = '8px';
  @Input() variant: 'line' | 'block' | 'circle' = 'line';
}
