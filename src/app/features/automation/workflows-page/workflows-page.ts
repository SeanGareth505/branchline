import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { WorkflowInfo } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { WorkflowEditorDialog } from '../workflow-editor-dialog/workflow-editor-dialog';
import { stepDef, stepLabel } from '../workflow-steps';

@Component({
  selector: 'app-workflows-page',
  imports: [NgIcon, WorkflowEditorDialog],
  templateUrl: './workflows-page.html',
  styleUrl: './workflows-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkflowsPage implements OnInit {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  private readonly editor = viewChild.required(WorkflowEditorDialog);

  readonly workflows = signal<WorkflowInfo[]>([]);
  readonly runningId = signal<string | null>(null);

  readonly filter = computed(() => this.store.automationFilter());

  readonly visible = computed(() => {
    const list = this.workflows();
    const filter = this.filter();
    if (filter === 'custom') return list.filter((w) => !w.builtin);
    if (filter === 'builtin') return list.filter((w) => w.builtin);
    return list;
  });

  readonly customCount = computed(() => this.workflows().filter((w) => !w.builtin).length);

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    this.workflows.set(await this.tauri.listWorkflows());
  }

  stepLabel = stepLabel;

  iconFor(workflow: WorkflowInfo): string {
    if (!workflow.builtin) return 'lucideSparkles';
    if (workflow.id.includes('hotfix') || workflow.steps.includes('push')) return 'lucideZap';
    if (workflow.steps.includes('createBranch')) return 'lucideGitBranch';
    return 'lucideWorkflow';
  }

  create(): void {
    this.editor().openCreate();
  }

  edit(workflow: WorkflowInfo): void {
    if (workflow.builtin) {
      this.editor().openDuplicate(workflow);
      return;
    }
    this.editor().openEdit(workflow);
  }

  duplicate(workflow: WorkflowInfo): void {
    this.editor().openDuplicate(workflow);
  }

  async toggleEnabled(workflow: WorkflowInfo): Promise<void> {
    try {
      this.workflows.set(await this.tauri.setWorkflowEnabled(workflow.id, !workflow.enabled));
    } catch (e) {
      this.store.showError(e);
    }
  }

  async remove(workflow: WorkflowInfo): Promise<void> {
    if (workflow.builtin) {
      this.store.showError('Built-in workflows cannot be deleted — duplicate or disable them');
      return;
    }
    try {
      this.workflows.set(await this.tauri.deleteWorkflow(workflow.id));
      this.store.showSuccess('Workflow deleted');
    } catch (e) {
      this.store.showError(e);
    }
  }

  async run(workflow: WorkflowInfo): Promise<void> {
    if (!workflow.enabled) {
      this.store.showError('Enable this workflow before running it');
      return;
    }
    if (!this.store.currentRepo() && workflow.steps.some((s) => s !== 'refresh')) {
      this.store.showError('Open a repository first');
      return;
    }

    this.runningId.set(workflow.id);
    try {
      for (let i = 0; i < workflow.steps.length; i++) {
        const stepId = workflow.steps[i];
        const def = stepDef(stepId);
        await this.runStep(stepId);
        if (def?.interactive) {
          const remaining = workflow.steps.length - i - 1;
          if (remaining > 0) {
            this.store.showSuccess(
              `${def.label} opened — finish it, then run the remaining ${remaining} step${remaining === 1 ? '' : 's'} manually if needed`,
            );
          }
          break;
        }
      }
      if (!workflow.steps.some((s) => stepDef(s)?.interactive)) {
        this.store.showSuccess(`Finished “${workflow.name}”`);
      }
    } catch (e) {
      this.store.showError(e);
    } finally {
      this.runningId.set(null);
    }
  }

  private async runStep(stepId: string): Promise<void> {
    switch (stepId) {
      case 'fetch':
        await this.store.fetchRemote();
        return;
      case 'pull':
        await this.store.pullRemote(false);
        return;
      case 'pullRebase':
        await this.store.pullRemote(true);
        return;
      case 'push':
        await this.store.pushRemote();
        return;
      case 'createBranch':
        this.store.setView('browse');
        this.store.openCreateBranchDialog();
        return;
      case 'openCommit':
        this.store.setView('browse');
        this.store.openCommitModal();
        return;
      case 'stash':
        await this.store.stashPush();
        return;
      case 'refresh':
        await this.store.refreshRepo();
        return;
      default:
        throw new Error(`Unknown step: ${stepId}`);
    }
  }
}
