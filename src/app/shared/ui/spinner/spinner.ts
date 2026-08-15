import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BrandMark } from '../brand-mark/brand-mark';

@Component({
  selector: 'app-spinner',
  imports: [BrandMark],
  templateUrl: './spinner.html',
  styleUrl: './spinner.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spinner {
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly label = input('Loading');

  readonly markSize = computed(() => {
    switch (this.size()) {
      case 'sm':
        return 12;
      case 'lg':
        return 56;
      default:
        return 24;
    }
  });
}
