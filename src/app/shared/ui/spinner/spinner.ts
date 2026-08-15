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

  readonly markSize = computed(() => (this.size() === 'lg' ? 52 : 0));
}
