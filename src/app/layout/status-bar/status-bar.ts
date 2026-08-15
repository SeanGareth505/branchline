import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';
import { identityColor, repoIdentityKey } from '../../shared/ui/identity-color';
import { describeBranchSync } from '../../shared/git/branch-sync';
import { remoteProtocol } from '../../shared/git/repo-links';

@Component({
  selector: 'app-status-bar',
  imports: [NgIcon],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StatusBar {
  readonly store = inject(AppStore);

  readonly repoColor = computed(() => {
    const repo = this.store.currentRepo();
    return repo ? identityColor(repoIdentityKey(repo.name, repo.path)) : null;
  });

  readonly syncStatus = computed(() =>
    describeBranchSync(this.store.status(), { hasRemotes: this.store.remotes().length > 0 }),
  );

  readonly githubChip = computed(() => {
    const github = this.store.remotes().filter((remote) => /github\.com/i.test(remote.fetchUrl));
    if (!github.length) return null;
    const https = github.some((remote) => remoteProtocol(remote.fetchUrl) === 'https');
    const ssh = github.some((remote) => remoteProtocol(remote.fetchUrl) === 'ssh');
    const protocol = https && ssh ? 'mixed' : ssh ? 'SSH' : 'HTTPS';
    const status = this.store.githubGitStatus();
    const login =
      protocol === 'SSH'
        ? status?.sshLogin || 'SSH'
        : status?.activeLogin || status?.sshLogin || 'GitHub';
    return {
      label: `${login} · ${protocol}`,
      title:
        protocol === 'SSH'
          ? `SSH authenticates as ${status?.sshLogin || 'your key'}. Click to switch this repo to HTTPS or pick a GitHub CLI account.`
          : `HTTPS Git uses ${status?.activeLogin || 'saved credentials'}. Click to switch account or protocol.`,
    };
  });

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

  openGitAccounts(): void {
    this.store.revealRefsGroup('remotes');
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
