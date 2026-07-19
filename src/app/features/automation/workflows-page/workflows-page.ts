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
import type { BranchInfo, WorkflowInfo, WorkflowStep, WorkflowStepConfig } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { SelectService, type SelectOption } from '../../../shared/ui/select-dialog/select.service';
import { WorkflowEditorDialog } from '../workflow-editor-dialog/workflow-editor-dialog';
import { asWorkflowStep, createBranchIsAutomatic, stepIdOf, stepSummary } from '../workflow-steps';

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

  stepSummary = stepSummary;

  iconFor(workflow: WorkflowInfo): string {
    if (!workflow.builtin) return 'lucideSparkles';
    const ids = workflow.steps.map(stepIdOf);
    if (ids.includes('checkoutBranch')) return 'lucideGitBranch';
    if (workflow.id.includes('hotfix') || ids.includes('push')) return 'lucideZap';
    if (ids.includes('createBranch')) return 'lucideGitBranch';
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
    if (
      !this.store.currentRepo() &&
      workflow.steps.some((s) => stepIdOf(s) !== 'refresh')
    ) {
      this.store.showError('Open a repository first');
      return;
    }

    this.runningId.set(workflow.id);
    try {
      for (const raw of workflow.steps) {
        await this.runStep(asWorkflowStep(raw));
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

  private async runStep(step: WorkflowStep): Promise<void> {
    switch (step.id) {
      case 'checkoutBranch':
        await this.runCheckoutBranch(step.config);
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
        await this.runCreateBranch(step.config);
        return;
      case 'openCommit': {
        this.store.setView('browse');
        const committed = await this.store.openCommitModal();
        if (!committed) throw new WorkflowCancelled();
        return;
      }
      case 'stash':
        await this.runStash(step.config);
        return;
      case 'refresh':
        await this.store.refreshRepo();
        return;
      default:
        throw new Error(`Unknown step: ${step.id}`);
    }
  }

  private async runCheckoutBranch(config?: WorkflowStepConfig): Promise<void> {
    const fixed = config?.branch?.trim();
    if (fixed) {
      const current = this.store.status()?.branch;
      if (fixed === current) return;
      await this.store.checkoutBranch(fixed);
      return;
    }

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

  private async runCreateBranch(config?: WorkflowStepConfig): Promise<void> {
    if (createBranchIsAutomatic(config)) {
      const pattern = config!.namePattern!.trim();
      const name = this.store.resolveBranchPattern(pattern);
      if (!name) {
        throw new Error('Branch name pattern resolved to an empty name');
      }
      if (/[{}]/.test(name)) {
        throw new Error(`Branch name still has unresolved placeholders: ${name}`);
      }
      const startRaw = config?.startPoint?.trim() || '';
      const startPoint = !startRaw || startRaw === '__current__' ? undefined : startRaw;
      const checkout = config?.checkout !== false;
      const ok = await this.store.createBranch(name, startPoint, checkout);
      if (!ok) throw new Error(`Failed to create branch “${name}”`);
      return;
    }

    const locals = this.store.localBranches();
    const remotes = this.store.remoteBranches();
    const current = this.store.status()?.branch ?? 'HEAD';
    const preferredBase = config?.startPoint?.trim() || '__current__';
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
      initialValue: options.some((o) => o.value === preferredBase) ? preferredBase : '__current__',
      options,
    });
    if (!picked) throw new WorkflowCancelled();

    const startPoint = picked === '__current__' ? null : picked;
    this.store.setView('browse');
    const created = await this.store.openCreateBranchDialog(startPoint);
    if (!created) throw new WorkflowCancelled();
  }

  private async runStash(config?: WorkflowStepConfig): Promise<void> {
    if (config?.skipPrompt) {
      const message = config.stashMessage?.trim();
      await this.store.stashPush(message || undefined);
      return;
    }

    const message = await this.prompts.ask({
      title: 'Stash changes',
      message: 'Optional message for this stash. Leave blank to use the default.',
      label: 'Message',
      placeholder: 'WIP…',
      confirmLabel: 'Stash',
      required: false,
      initialValue: config?.stashMessage ?? '',
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
