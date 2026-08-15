import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AppStore } from '../../../core/app.store';
import { remoteProtocol } from '../../../shared/git/repo-links';

@Component({
  selector: 'app-git-account-bar',
  imports: [],
  templateUrl: './git-account-bar.html',
  styleUrl: './git-account-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.compact]': 'compact()',
    '[class.settings]': 'variant() === "settings"',
  },
})
export class GitAccountBar {
  readonly store = inject(AppStore);
  readonly compact = input(false);
  readonly variant = input<'repo' | 'settings'>('repo');

  readonly protocol = computed((): 'https' | 'ssh' | 'mixed' | 'none' => {
    const github = this.store
      .remotes()
      .map((remote) => remote.fetchUrl)
      .filter((url) => /github\.com/i.test(url));
    if (!github.length) return 'none';
    const https = github.some((url) => remoteProtocol(url) === 'https');
    const ssh = github.some((url) => remoteProtocol(url) === 'ssh');
    if (https && ssh) return 'mixed';
    if (ssh) return 'ssh';
    if (https) return 'https';
    return 'none';
  });

  readonly accounts = computed(() => this.store.githubGitStatus()?.accounts ?? []);
  readonly activeLogin = computed(() => this.store.githubGitStatus()?.activeLogin ?? '');
  readonly sshLogin = computed(() => this.store.githubGitStatus()?.sshLogin ?? '');
  readonly usesGh = computed(() => !!this.store.githubGitStatus()?.usesGhHelper);
  readonly busy = computed(() => this.store.githubGitBusy());
  readonly visible = computed(
    () =>
      this.variant() === 'settings' ||
      this.store.remotes().length > 0 ||
      this.accounts().length > 0,
  );

  readonly summary = computed(() => {
    const protocol = this.protocol();
    const httpsUser = this.activeLogin();
    const sshUser = this.sshLogin();
    if (this.compact()) {
      if (protocol === 'mixed') return 'This repo mixes SSH and HTTPS. Pick one protocol below.';
      if (protocol === 'https') {
        return httpsUser
          ? `HTTPS Git uses ${httpsUser} for this GitHub org. Branchline remembers it when you switch repos.`
          : 'HTTPS Git uses saved credentials. Sign in with GitHub CLI if Pull cannot see this repo.';
      }
      if (protocol === 'ssh') {
        return sshUser
          ? `SSH is ${sshUser}. Switch to HTTPS to use a different GitHub CLI account for this org.`
          : 'SSH uses ~/.ssh. Switch to HTTPS to pick a GitHub CLI account.';
      }
      return 'No GitHub remotes on this repo.';
    }
    if (protocol === 'mixed') {
      return 'This repo has both SSH and HTTPS remotes. Pull uses whichever remote the branch tracks — pick one protocol for all GitHub remotes.';
    }
    if (protocol === 'https') {
      if (httpsUser) {
        return this.usesGh()
          ? `HTTPS uses GitHub CLI as ${httpsUser}. Branchline remembers this account for this GitHub org when you switch between work and personal repos.`
          : `HTTPS remotes use saved Git credentials as ${httpsUser}.`;
      }
      return 'HTTPS remotes use saved GitHub credentials. Sign in with GitHub CLI if Pull cannot see a private repo.';
    }
    if (protocol === 'ssh') {
      return sshUser
        ? `SSH authenticates as ${sshUser} and ignores GitHub CLI. If this org hides the repo, switch to HTTPS.`
        : 'SSH remotes use the key in ~/.ssh. If GitHub hides the repo, switch to HTTPS.';
    }
    if (this.accounts().length) {
      return 'No GitHub remotes on this repo. HTTPS Git still uses the selected GitHub CLI account.';
    }
    return 'No GitHub remotes on this repo.';
  });

  useProtocol(protocol: 'https' | 'ssh'): void {
    if (this.busy() || this.protocol() === protocol) return;
    void this.store.setRepoRemoteProtocol(protocol);
  }

  useAccount(login: string): void {
    if (this.busy() || login === this.activeLogin()) return;
    void this.store.switchGithubCliUser(login);
  }

  refresh(): void {
    void this.store.refreshGithubGitStatus();
  }

  async copyAddAccount(): Promise<void> {
    try {
      await navigator.clipboard.writeText('gh auth login');
      this.store.showSuccess('Copied gh auth login — run it in Terminal for the other account, then Refresh');
    } catch {
      this.store.showError('Could not copy. In Terminal run: gh auth login');
    }
  }
}
