import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
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
  readonly dragOverSha = signal<string | null>(null);
  private dragSha: string | null = null;

  setAction(sha: string, action: string): void {
    this.store.setRebaseStepAction(sha, action as RebaseAction);
  }

  onDragStart(sha: string, event: DragEvent): void {
    this.dragSha = sha;
    event.dataTransfer?.setData('text/plain', sha);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragEnd(): void {
    this.dragSha = null;
    this.dragOverSha.set(null);
  }

  onDragOver(sha: string, event: DragEvent): void {
    if (!this.dragSha || this.dragSha === sha) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.dragOverSha.set(sha);
  }

  onDrop(sha: string, event: DragEvent): void {
    event.preventDefault();
    const from = this.dragSha || event.dataTransfer?.getData('text/plain') || '';
    this.dragSha = null;
    this.dragOverSha.set(null);
    if (!from || from === sha) return;
    this.store.reorderRebaseStep(from, sha);
  }
}
