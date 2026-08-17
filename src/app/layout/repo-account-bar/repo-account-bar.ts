import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';

@Component({
  selector: 'app-repo-account-bar',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './repo-account-bar.html',
  styleUrl: './repo-account-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepoAccountBar {
  readonly store = inject(AppStore);
  readonly menuOpen = signal(false);
  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
  ];

  readonly visible = computed(
    () =>
      !!this.store.githubGitStatus()?.ghAvailable ||
      (this.store.githubGitStatus()?.accounts.length ?? 0) > 0 ||
      this.store.repoAccounts().length > 0,
  );

  readonly canAdd = computed(() => !!this.store.githubGitStatus()?.ghAvailable);
  readonly busy = computed(() => this.store.githubGitBusy());
  readonly cliAccounts = computed(() => this.store.githubGitStatus()?.accounts ?? []);

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.menuOpen.set(false);
  }

  choose(key: string): void {
    if (key === this.store.selectedRepoAccountKey()) return;
    this.store.selectRepoAccount(key);
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

  unlink(login: string): void {
    this.closeMenu();
    const cli = this.cliAccounts().some(
      (account) => account.login.toLowerCase() === login.trim().toLowerCase(),
    );
    if (!cli) return;
    void this.store.logoutGithubCliUser(login);
  }

  manage(): void {
    this.closeMenu();
    this.store.openSettings('connections', 'github-git');
  }

  onChipContext(login: string, event: Event): void {
    event.preventDefault();
    void this.store.logoutGithubCliUser(login);
  }
}
