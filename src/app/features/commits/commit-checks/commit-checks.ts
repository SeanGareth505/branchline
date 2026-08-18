import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { CheckRunStatus, RepoCheck } from '../../../core/models';
import { Spinner } from '../../../shared/ui/spinner/spinner';
import { CheckScriptDialog } from '../../checks/check-script-dialog/check-script-dialog';

@Component({
  selector: 'app-commit-checks',
  imports: [FormsModule, NgIcon, Spinner, CheckScriptDialog],
  templateUrl: './commit-checks.html',
  styleUrl: './commit-checks.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommitChecks {
  readonly store = inject(AppStore);
  private readonly editor = viewChild.required(CheckScriptDialog);

  readonly triggers = input<string[]>(['pre-commit', 'commit-msg']);
  readonly skip = signal(false);
  readonly detailsOpen = signal(false);
  readonly expandedId = signal<string | null>(null);

  constructor() {
    effect(() => {
      if (!this.store.commitModalOpen()) return;
      this.skip.set(false);
      this.expandedId.set(null);
      this.detailsOpen.set(false);
    });

    effect(() => {
      const failed = this.checks().find((c) => this.store.checkRuns()[c.id]?.status === 'fail');
      if (failed) this.expandedId.set(failed.id);
    });
  }

  readonly checks = computed(() => {
    const triggers = this.triggers();
    return (this.store.repoChecks()?.checks ?? []).filter((c) => triggers.includes(c.trigger));
  });

  readonly managers = computed(() => this.store.repoChecks()?.managers ?? []);

  readonly pushIncluded = computed(() => this.triggers().includes('pre-push'));

  readonly tone = computed((): CheckRunStatus => {
    if (this.skip()) return 'skipped';
    const checks = this.checks().filter((c) => c.enabled);
    const runs = this.store.checkRuns();
    if (checks.some((c) => runs[c.id]?.status === 'fail')) return 'fail';
    if (checks.some((c) => runs[c.id]?.status === 'running')) return 'running';
    if (checks.length && checks.every((c) => runs[c.id]?.status === 'pass')) return 'pass';
    return 'idle';
  });

  readonly failedChecks = computed(() => {
    const runs = this.store.checkRuns();
    return this.checks().filter((c) => c.enabled && runs[c.id]?.status === 'fail');
  });

  readonly failMessage = computed(() => {
    const failed = this.failedChecks();
    if (!failed.length) return '';
    if (failed.length === 1) return `${failed[0].name} failed. Fix it, or skip checks to commit anyway.`;
    return `${failed.length} checks failed. Open a row for the log, or skip checks to commit anyway.`;
  });

  readonly summary = computed(() => {
    const checks = this.checks().filter((c) => c.enabled);
    if (this.skip()) return 'Skipped';
    if (!checks.length) return 'None';
    const runs = this.store.checkRuns();
    const failed = checks.filter((c) => runs[c.id]?.status === 'fail').length;
    if (failed) return failed === 1 ? '1 failed' : `${failed} failed`;
    const passed = checks.filter((c) => runs[c.id]?.status === 'pass').length;
    if (passed === checks.length) return 'All passed';
    const running = checks.some((c) => runs[c.id]?.status === 'running');
    if (running) return 'Running…';
    return checks.length === 1 ? '1 ready' : `${checks.length} ready`;
  });

  statusOf(check: RepoCheck): CheckRunStatus {
    if (this.skip() && check.enabled) return 'skipped';
    return this.store.checkRuns()[check.id]?.status ?? 'idle';
  }

  outputOf(check: RepoCheck): string {
    return this.store.checkRuns()[check.id]?.output ?? '';
  }

  statusLabel(status: CheckRunStatus): string {
    switch (status) {
      case 'pass':
        return 'passed';
      case 'fail':
        return 'failed';
      case 'running':
        return 'running';
      case 'skipped':
        return 'skipped';
      default:
        return 'ready';
    }
  }

  openDetails(): void {
    this.detailsOpen.set(true);
  }

  closeDetails(): void {
    if (this.editor().open()) return;
    this.detailsOpen.set(false);
  }

  closeTop(): boolean {
    if (this.editor().open()) {
      this.editor().close();
      return true;
    }
    if (this.detailsOpen()) {
      this.detailsOpen.set(false);
      return true;
    }
    return false;
  }

  toggleOutput(check: RepoCheck): void {
    this.expandedId.set(this.expandedId() === check.id ? null : check.id);
  }

  addScript(): void {
    this.editor().openCreate();
  }

  manage(): void {
    if (this.store.settings().simpleMode) {
      this.store.showWarning('Switch to Advanced to manage checks');
      return;
    }
    this.store.closeCommitModal();
    this.store.setAutomationSection('checks');
  }

  iconFor(status: CheckRunStatus): string {
    switch (status) {
      case 'pass':
        return 'lucideCircleCheck';
      case 'fail':
        return 'lucideCircleAlert';
      case 'skipped':
        return 'lucideEyeOff';
      default:
        return 'lucideListChecks';
    }
  }
}
