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
import type { WorkflowInfo, WorkflowStep, WorkflowStepConfig } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { BRANCH_PLACEHOLDER_TOKENS } from '../../../core/workflow-placeholders';
import {
  WORKFLOW_STEP_CATALOG,
  asWorkflowStep,
  serializeWorkflowSteps,
  stepDef,
  stepLabel,
  stepSummary,
} from '../workflow-steps';

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
  readonly steps = signal<WorkflowStep[]>([]);
  readonly selectedIndex = signal<number | null>(null);
  readonly busy = signal(false);
  readonly catalog = WORKFLOW_STEP_CATALOG;
  readonly placeholders = BRANCH_PLACEHOLDER_TOKENS;

  readonly isEdit = computed(() => !!this.editingId());
  readonly title = computed(() => (this.isEdit() ? 'Edit workflow' : 'New workflow'));
  readonly canSave = computed(
    () => this.name().trim().length > 0 && this.steps().length > 0 && !this.busy(),
  );

  readonly selectedStep = computed(() => {
    const index = this.selectedIndex();
    if (index === null) return null;
    return this.steps()[index] ?? null;
  });

  readonly selectedDef = computed(() => {
    const step = this.selectedStep();
    return step ? stepDef(step.id) : undefined;
  });

  readonly namePreview = computed(() => {
    const step = this.selectedStep();
    const pattern = step?.config?.namePattern?.trim();
    if (!pattern || step?.id !== 'createBranch') return '';
    return this.store.resolveBranchPattern(pattern);
  });

  readonly localBranchNames = computed(() => this.store.localBranches().map((b) => b.name));

  openCreate(presetSteps: string[] = []): void {
    this.editingId.set(null);
    this.name.set('');
    this.description.set('');
    this.steps.set(presetSteps.map((id) => ({ id })));
    this.selectedIndex.set(presetSteps.length ? 0 : null);
    this.busy.set(false);
    this.open.set(true);
  }

  openEdit(workflow: WorkflowInfo): void {
    this.editingId.set(workflow.id);
    this.name.set(workflow.name);
    this.description.set(workflow.description);
    const steps = workflow.steps.map(asWorkflowStep);
    this.steps.set(steps);
    this.selectedIndex.set(this.firstConfigurableIndex(steps));
    this.busy.set(false);
    this.open.set(true);
  }

  openDuplicate(workflow: WorkflowInfo): void {
    this.editingId.set(null);
    this.name.set(`${workflow.name} copy`);
    this.description.set(workflow.description);
    const steps = workflow.steps.map(asWorkflowStep);
    this.steps.set(steps);
    this.selectedIndex.set(this.firstConfigurableIndex(steps));
    this.busy.set(false);
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }

  stepLabel = stepLabel;
  stepSummary = stepSummary;

  addStep(id: string): void {
    const defaults = this.defaultConfig(id);
    this.steps.update((list) => [...list, { id, config: defaults }]);
    this.selectedIndex.set(this.steps().length - 1);
  }

  selectStep(index: number): void {
    this.selectedIndex.set(index);
  }

  removeStep(index: number): void {
    this.steps.update((list) => list.filter((_, i) => i !== index));
    const selected = this.selectedIndex();
    if (selected === null) return;
    if (this.steps().length === 0) {
      this.selectedIndex.set(null);
      return;
    }
    if (selected === index) {
      this.selectedIndex.set(Math.min(index, this.steps().length - 1));
    } else if (selected > index) {
      this.selectedIndex.set(selected - 1);
    }
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
    const selected = this.selectedIndex();
    if (selected === index) this.selectedIndex.set(index + delta);
    else if (selected === index + delta) this.selectedIndex.set(index);
  }

  patchSelectedConfig(patch: Partial<WorkflowStepConfig>): void {
    const index = this.selectedIndex();
    if (index === null) return;
    this.steps.update((list) =>
      list.map((step, i) => {
        if (i !== index) return step;
        const config = { ...(step.config ?? {}), ...patch };
        return { ...step, config };
      }),
    );
  }

  setNamePattern(value: string): void {
    this.patchSelectedConfig({ namePattern: value });
  }

  insertPlaceholder(token: string): void {
    const step = this.selectedStep();
    if (!step || step.id !== 'createBranch') return;
    const current = step.config?.namePattern ?? '';
    this.setNamePattern(`${current}${token}`);
  }

  setStartPoint(value: string): void {
    this.patchSelectedConfig({ startPoint: value });
  }

  setCheckout(value: boolean): void {
    this.patchSelectedConfig({ checkout: value });
  }

  setBranch(value: string): void {
    this.patchSelectedConfig({ branch: value });
  }

  setStashMessage(value: string): void {
    this.patchSelectedConfig({ stashMessage: value });
  }

  setSkipPrompt(value: boolean): void {
    this.patchSelectedConfig({ skipPrompt: value });
  }

  async save(): Promise<void> {
    if (!this.canSave()) return;
    this.busy.set(true);
    try {
      await this.tauri.saveWorkflow({
        id: this.editingId() ?? undefined,
        name: this.name().trim(),
        description: this.description().trim(),
        steps: serializeWorkflowSteps(this.steps()),
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

  private firstConfigurableIndex(steps: WorkflowStep[]): number | null {
    const index = steps.findIndex((s) => stepDef(s.id)?.configurable);
    return index >= 0 ? index : steps.length ? 0 : null;
  }

  private defaultConfig(id: string): WorkflowStepConfig | undefined {
    if (id === 'createBranch') {
      return {
        namePattern: 'feature/{jira}/{date}',
        checkout: true,
      };
    }
    if (id === 'stash') {
      return { skipPrompt: true, stashMessage: '' };
    }
    return undefined;
  }
}
