import { Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';
import { describeBranchSync } from '../../shared/git/branch-sync';

@Component({
  selector: 'app-status-bar',
  imports: [NgIcon],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.scss',
})
export class StatusBar {
  readonly store = inject(AppStore);

  readonly syncStatus = computed(() =>
    describeBranchSync(this.store.status(), { hasRemotes: this.store.remotes().length > 0 }),
  );

  branchTitle(): string {
    const status = this.store.status();
    if (!status) return '';
    if (status.isDetached) return `Detached HEAD at ${status.branch}`;
    if (status.upstream) return `${status.branch} tracking ${status.upstream}`;
    return status.branch;
  }

  onSyncAction(): void {
    const sync = this.syncStatus();
    if (!sync) return;
    if (sync.kind === 'publish') {
      void this.store.pushRemote();
      return;
    }
    if (sync.kind === 'ahead') {
      void this.store.pushRemote();
      return;
    }
    if (sync.kind === 'behind') {
      void this.store.pullRemote();
      return;
    }
    void this.store.syncRemote();
  }

  onChanges(): void {
    this.store.openCommitModal();
  }

  isActionable(): boolean {
    const next = this.store.nextAction();
    return (
      next !== 'Working tree clean' &&
      next !== 'Open a repository' &&
      !next.startsWith('Working tree')
    );
  }
}
