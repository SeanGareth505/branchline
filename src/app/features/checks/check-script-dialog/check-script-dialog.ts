import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { RepoCheck } from '../../../core/models';

@Component({
  selector: 'app-check-script-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './check-script-dialog.html',
  styleUrl: './check-script-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CheckScriptDialog {
  private readonly store = inject(AppStore);

  readonly saved = output<void>();
  readonly open = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly name = signal('');
  readonly command = signal('');
  readonly trigger = signal('pre-commit');
  readonly busy = signal(false);

  readonly isEdit = computed(() => !!this.editingId());
  readonly title = computed(() => (this.isEdit() ? 'Edit script' : 'New check script'));
  readonly canSave = computed(
    () => this.name().trim().length > 0 && this.command().trim().length > 0 && !this.busy(),
  );

  readonly triggers = [
    { id: 'pre-commit', label: 'Before commit' },
    { id: 'commit-msg', label: 'Commit message' },
    { id: 'pre-push', label: 'Before push' },
    { id: 'manual', label: 'Manual' },
  ];

  openCreate(): void {
    this.editingId.set(null);
    this.name.set('');
    this.command.set('');
    this.trigger.set('pre-commit');
    this.busy.set(false);
    this.open.set(true);
  }

  openEdit(check: RepoCheck): void {
    this.editingId.set(check.id);
    this.name.set(check.name);
    this.command.set(check.command);
    this.trigger.set(check.trigger);
    this.busy.set(false);
    this.open.set(true);
  }

  close(): void {
    if (this.busy()) return;
    this.open.set(false);
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.busy.set(true);
    try {
      const ok = await this.store.saveCheckScript({
        id: this.editingId() ?? undefined,
        name: this.name().trim(),
        command: this.command().trim(),
        trigger: this.trigger(),
      });
      if (!ok) return;
      this.store.showSuccess(this.isEdit() ? 'Script updated' : 'Script added');
      this.open.set(false);
      this.saved.emit();
    } finally {
      this.busy.set(false);
    }
  }
}
