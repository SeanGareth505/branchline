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
import type { RepoCheck } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { PageSkeleton } from '../../../shared/ui/page-skeleton/page-skeleton';
import { Spinner } from '../../../shared/ui/spinner/spinner';
import { CheckScriptDialog } from '../check-script-dialog/check-script-dialog';

@Component({
  selector: 'app-checks-page',
  imports: [NgIcon, CheckScriptDialog, PageSkeleton, Spinner],
  templateUrl: './checks-page.html',
  styleUrl: './checks-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChecksPage implements OnInit {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  private readonly editor = viewChild.required(CheckScriptDialog);

  readonly loading = signal(true);
  readonly runningId = signal<string | null>(null);
  readonly expandedId = signal<string | null>(null);

  readonly checks = computed(() => this.store.repoChecks()?.checks ?? []);
  readonly managers = computed(() => this.store.repoChecks()?.managers ?? []);
  readonly customCount = computed(() => this.checks().filter((c) => !c.builtin).length);

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      await this.store.loadRepoChecks();
    } finally {
      this.loading.set(false);
    }
  }

  triggerLabel(trigger: string): string {
    switch (trigger) {
      case 'pre-commit':
        return 'Before commit';
      case 'commit-msg':
        return 'Commit message';
      case 'pre-push':
        return 'Before push';
      default:
        return 'Manual';
    }
  }

  iconFor(check: RepoCheck): string {
    if (!check.builtin) return 'lucideSparkles';
    if (check.source === 'husky') return 'lucideListChecks';
    if (check.trigger === 'pre-push') return 'lucideUpload';
    return 'lucideListChecks';
  }

  create(): void {
    this.editor().openCreate();
  }

  edit(check: RepoCheck): void {
    if (check.builtin) return;
    this.editor().openEdit(check);
  }

  async toggleEnabled(check: RepoCheck): Promise<void> {
    await this.store.setCheckEnabled(check.id, !check.enabled);
  }

  async remove(check: RepoCheck): Promise<void> {
    if (check.builtin) return;
    const ok = await this.prompts.ask({
      title: 'Delete script?',
      message: `Remove “${check.name}”? This only deletes the Branchline script, not files in the repo.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      confirmOnly: true,
    });
    if (ok === null) return;
    await this.store.deleteCheckScript(check.id);
    this.store.showSuccess('Script deleted');
  }

  async run(check: RepoCheck): Promise<void> {
    if (!check.enabled) {
      this.store.showError('Enable this check before running it');
      return;
    }
    this.runningId.set(check.id);
    try {
      const ok = await this.store.runSingleCheck(check, { silent: true });
      this.expandedId.set(check.id);
      if (ok) this.store.showSuccess(`${check.name} passed`);
      else this.store.showError(`${check.name} failed`);
    } finally {
      this.runningId.set(null);
    }
  }

  toggleOutput(check: RepoCheck): void {
    this.expandedId.set(this.expandedId() === check.id ? null : check.id);
  }

  outputFor(check: RepoCheck): string {
    return this.store.checkRuns()[check.id]?.output ?? '';
  }

  statusFor(check: RepoCheck): string {
    return this.store.checkRuns()[check.id]?.status ?? 'idle';
  }
}
