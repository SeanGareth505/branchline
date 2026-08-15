import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { UpdateService } from '../../../core/update.service';

@Component({
  selector: 'app-update-banner',
  imports: [],
  templateUrl: './update-banner.html',
  styleUrl: './update-banner.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UpdateBanner {
  readonly updates = inject(UpdateService);
}
