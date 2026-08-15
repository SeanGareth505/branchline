import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppStore } from '../../core/app.store';
import { UndoToast } from '../../shared/ui/undo-toast/undo-toast';

@Component({
  selector: 'app-toast-host',
  imports: [UndoToast],
  templateUrl: './toast-host.html',
  styleUrl: './toast-host.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastHost {
  readonly store = inject(AppStore);
}
