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
import type { BranchInfo, WorkflowInfo } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { SelectService, type SelectOption } from '../../../shared/ui/select-dialog/select.service';
import { WorkflowEditorDialog } from '../workflow-editor-dialog/workflow-editor-dialog';
import { stepLabel } from '../workflow-steps';

class WorkflowCancelled extends Error {
  constructor() {
    super('Workflow cancelled');
    this.name = 'WorkflowCancelled';
  }
}

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
  private readonly prompts = inject(PromptService);
  private readonly selects = inject(SelectService);
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
    if (workflow.steps.includes('checkoutBranch')) return 'lucideGitBranch';
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
      for (const stepId of workflow.steps) {
        await this.runStep(stepId);
      }
      this.store.showSuccess(`Finished “${workflow.name}”`);
    } catch (e) {
      if (e instanceof WorkflowCancelled) {
        this.store.showToast('Workflow cancelled', { kind: 'info' });
      } else {
        this.store.showError(e);
      }
    } finally {
      this.runningId.set(null);
    }
  }

  private async runStep(stepId: string): Promise<void> {
    switch (stepId) {
      case 'checkoutBranch':
        await this.runCheckoutBranch();
        return;
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
        await this.runCreateBranch();
        return;
      case 'openCommit': {
        this.store.setView('browse');
        const committed = await this.store.openCommitModal();
        if (!committed) throw new WorkflowCancelled();
        return;
      }
      case 'stash':
        await this.runStash();
        return;
      case 'refresh':
        await this.store.refreshRepo();
        return;
      default:
        throw new Error(`Unknown step: ${stepId}`);
    }
  }

  private async runCheckoutBranch(): Promise<void> {
    const branches = this.store.localBranches();
    if (branches.length === 0) {
      throw new Error('No local branches to switch to');
    }
    const picked = await this.selects.ask({
      title: 'Switch branch',
      message: 'Choose which branch to check out.',
      label: 'Branch',
      placeholder: 'Filter branches…',
      confirmLabel: 'Switch',
      initialValue: branches.find((b) => !b.isCurrent)?.name,
      options: this.branchOptions(branches, { markCurrent: true }),
    });
    if (!picked) throw new WorkflowCancelled();
    const current = this.store.status()?.branch;
    if (picked === current) return;
    await this.store.checkoutBranch(picked);
  }

  private async runCreateBranch(): Promise<void> {
    const locals = this.store.localBranches();
    const remotes = this.store.remoteBranches();
    const current = this.store.status()?.branch ?? 'HEAD';
    const options: SelectOption[] = [
      {
        value: '__current__',
        label: current,
        hint: 'Current HEAD',
      },
      ...this.branchOptions(
        locals.filter((b) => b.name !== current),
        { markCurrent: false },
      ),
      ...this.branchOptions(remotes, { markCurrent: false, remote: true }),
    ];

    const picked = await this.selects.ask({
      title: 'Create branch from',
      message: 'Pick the base commit for the new branch, then name it.',
      label: 'Base',
      placeholder: 'Filter branches…',
      confirmLabel: 'Continue',
      initialValue: '__current__',
      options,
    });
    if (!picked) throw new WorkflowCancelled();

    const startPoint = picked === '__current__' ? null : picked;
    this.store.setView('browse');
    const created = await this.store.openCreateBranchDialog(startPoint);
    if (!created) throw new WorkflowCancelled();
  }

  private async runStash(): Promise<void> {
    const message = await this.prompts.ask({
      title: 'Stash changes',
      message: 'Optional message for this stash. Leave blank to use the default.',
      label: 'Message',
      placeholder: 'WIP…',
      confirmLabel: 'Stash',
      required: false,
    });
    if (message === null) throw new WorkflowCancelled();
    await this.store.stashPush(message.trim() || undefined);
  }

  private branchOptions(
    branches: BranchInfo[],
    opts: { markCurrent: boolean; remote?: boolean },
  ): SelectOption[] {
    return branches.map((b) => ({
      value: b.name,
      label: b.name,
      hint: opts.markCurrent && b.isCurrent
        ? 'Current'
        : opts.remote
          ? 'Remote'
          : (b.upstream ?? undefined),
      disabled: opts.markCurrent && b.isCurrent,
    }));
  }
}
