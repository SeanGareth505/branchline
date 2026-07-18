import { Component, EventEmitter, Input, Output } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import type { ToastKind } from '../../../core/app.store';

@Component({
  selector: 'app-undo-toast',
  imports: [NgIcon],
  templateUrl: './undo-toast.html',
  styleUrl: './undo-toast.scss',
})
export class UndoToast {
  @Input() message = '';
  @Input() kind: ToastKind = 'info';
  @Input() canUndo = false;
  @Output() undo = new EventEmitter<void>();
  @Output() dismiss = new EventEmitter<void>();

  iconName(): string {
    switch (this.kind) {
      case 'success':
        return 'lucideCheck';
      case 'warning':
        return 'lucideCircleAlert';
      case 'error':
        return 'lucideCircleAlert';
      default:
        return 'lucideInfo';
    }
  }
}
