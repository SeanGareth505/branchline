import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';
import { ALL_REPO_ACCOUNTS } from '../../shared/git/repo-accounts';
import { Spinner } from '../../shared/ui/spinner/spinner';

@Component({
  selector: 'app-repo-account-bar',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin, Spinner],
  templateUrl: './repo-account-bar.html',
  styleUrl: './repo-account-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepoAccountBar {
  readonly store = inject(AppStore);
  readonly menuOpen = signal(false);
  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
  ];

  readonly allKey = ALL_REPO_ACCOUNTS;
  readonly accounts = computed(() => this.store.repoAccounts());
  readonly visible = computed(() => this.accounts().length > 1);
  readonly canAdd = computed(() => !!this.store.githubGitStatus()?.ghAvailable);
  readonly busy = computed(() => this.store.repoAccountSwitching() || this.store.githubGitBusy());
  readonly selectedKey = computed(() => this.store.selectedRepoAccountKey());
  readonly selectedLabel = computed(() => {
    if (this.store.showingAllRepoAccounts()) return 'All accounts';
    return this.store.selectedRepoAccountLabel() || this.accounts()[0]?.label || 'Account';
  });

  readonly counts = computed(() => {
    const repos = this.store.repos();
    const map = new Map<string, number>();
    for (const account of this.accounts()) {
      map.set(
        account.key,
        repos.filter((repo) => this.store.localRepoMatchesAccount(repo.path, account.key)).length,
      );
    }
    return map;
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.menuOpen.set(false);
  }

  choose(key: string): void {
    this.closeMenu();
    if (key === this.selectedKey() || this.busy()) return;
    void this.store.selectRepoAccount(key);
  }

  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  addAccount(): void {
    this.closeMenu();
    void this.store.addGithubCliAccount();
  }

  manage(): void {
    this.closeMenu();
    this.store.openSettings('connections', 'github-git');
  }
}
