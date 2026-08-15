import { ChangeDetectionStrategy, Component, input } from '@angular/core';

let spinnerSeq = 0;

@Component({
  selector: 'app-spinner',
  imports: [],
  templateUrl: './spinner.html',
  styleUrl: './spinner.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Spinner {
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly label = input('Loading');

  readonly glowId = `bl-spin-glow-${++spinnerSeq}`;
}
