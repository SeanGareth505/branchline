import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-cherry-pick-preview',
  imports: [],
  templateUrl: './cherry-pick-preview.html',
  styleUrl: './cherry-pick-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CherryPickPreview {
  readonly store = inject(AppStore);
}
