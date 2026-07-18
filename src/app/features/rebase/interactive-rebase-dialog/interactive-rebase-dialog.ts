import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { RebaseAction } from '../../../core/models';

const ACTIONS: { id: RebaseAction; label: string }[] = [
  { id: 'pick', label: 'pick' },
  { id: 'reword', label: 'reword' },
  { id: 'edit', label: 'edit' },
  { id: 'squash', label: 'squash' },
  { id: 'fixup', label: 'fixup' },
  { id: 'drop', label: 'drop' },
];

@Component({
  selector: 'app-interactive-rebase-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './interactive-rebase-dialog.html',
  styleUrl: './interactive-rebase-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InteractiveRebaseDialog {
  readonly store = inject(AppStore);
  readonly actions = ACTIONS;

  setAction(sha: string, action: string): void {
    this.store.setRebaseStepAction(sha, action as RebaseAction);
  }
}
