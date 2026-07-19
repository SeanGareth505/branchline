import { ChangeDetectionStrategy, Component, Input } from '@angular/core';
import { Spinner } from '../spinner/spinner';

@Component({
  selector: 'app-loading-block',
  imports: [Spinner],
  templateUrl: './loading-block.html',
  styleUrl: './loading-block.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingBlock {
  @Input() message = 'Loading…';
  @Input() compact = false;
}
