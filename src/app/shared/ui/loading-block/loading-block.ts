import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Spinner } from '../spinner/spinner';

@Component({
  selector: 'app-loading-block',
  imports: [Spinner],
  templateUrl: './loading-block.html',
  styleUrl: './loading-block.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoadingBlock {
  readonly message = input('Loading…');
  readonly compact = input(false);
}
