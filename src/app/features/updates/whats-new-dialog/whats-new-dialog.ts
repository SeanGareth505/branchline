import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { UpdateService } from '../../../core/update.service';

@Component({
  selector: 'app-whats-new-dialog',
  imports: [NgIcon],
  templateUrl: './whats-new-dialog.html',
  styleUrl: './whats-new-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WhatsNewDialog {
  readonly updates = inject(UpdateService);
}
