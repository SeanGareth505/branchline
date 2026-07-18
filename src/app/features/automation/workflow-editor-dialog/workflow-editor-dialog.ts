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
import type { WorkflowInfo } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { WORKFLOW_STEP_CATALOG, stepLabel } from '../workflow-steps';

@Component({
  selector: 'app-workflow-editor-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './workflow-editor-dialog.html',
  styleUrl: './workflow-editor-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowEditorDialog {
  private readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly saved = output<void>();
  readonly open = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly name = signal('');
  readonly description = signal('');
  readonly steps = signal<string[]>([]);
  readonly busy = signal(false);
  readonly catalog = WORKFLOW_STEP_CATALOG;

  readonly isEdit = computed(() => !!this.editingId());
  readonly title = computed(() => (this.isEdit() ? 'Edit workflow' : 'New workflow'));
  readonly canSave = computed(
    () => this.name().trim().length > 0 && this.steps().length > 0 && !this.busy(),
  );

  openCreate(presetSteps: string[] = []): void {
    this.editingId.set(null);
    this.name.set('');
    this.description.set('');
    this.steps.set([...presetSteps]);
    this.busy.set(false);
    this.open.set(true);
  }

  openEdit(workflow: WorkflowInfo): void {
    this.editingId.set(workflow.id);
    this.name.set(workflow.name);
    this.description.set(workflow.description);
    this.steps.set([...workflow.steps]);
    this.busy.set(false);
    this.open.set(true);
  }

  openDuplicate(workflow: WorkflowInfo): void {
    this.editingId.set(null);
    this.name.set(`${workflow.name} copy`);
    this.description.set(workflow.description);
    this.steps.set([...workflow.steps]);
    this.busy.set(false);
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  stepLabel = stepLabel;

  addStep(id: string): void {
    this.steps.update((list) => [...list, id]);
  }

  removeStep(index: number): void {
    this.steps.update((list) => list.filter((_, i) => i !== index));
  }

  moveStep(index: number, delta: number): void {
    this.steps.update((list) => {
      const next = [...list];
      const target = index + delta;
      if (target < 0 || target >= next.length) return list;
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.busy.set(true);
    try {
      await this.tauri.saveWorkflow({
        id: this.editingId() ?? undefined,
        name: this.name().trim(),
        description: this.description().trim(),
        steps: this.steps(),
        enabled: true,
      });
      this.store.showSuccess(this.isEdit() ? 'Workflow updated' : 'Workflow created');
      this.open.set(false);
      this.saved.emit();
    } catch (e) {
      this.store.showError(e);
    } finally {
      this.busy.set(false);
    }
  }
}
