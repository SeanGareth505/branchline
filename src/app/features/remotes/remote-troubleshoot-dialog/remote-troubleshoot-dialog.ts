import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { GitEnvSnapshot, ProbeRemoteOutput, RemoteInfo } from '../../../core/models';
import { extractRemoteUrlFromGitError, humanizeGitError } from '../../../shared/git/git-error';
import {
  githubSsoUrl,
  normalizeRemoteUrl,
  parseRemoteWebBase,
  remoteProtocol,
  toSshRemoteUrl,
} from '../../../shared/git/repo-links';

@Component({
  selector: 'app-remote-troubleshoot-dialog',
  imports: [NgIcon],
  templateUrl: './remote-troubleshoot-dialog.html',
  styleUrl: './remote-troubleshoot-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemoteTroubleshootDialog {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly selectedName = signal('');
  readonly busy = signal(false);
  readonly probe = signal<ProbeRemoteOutput | null>(null);
  readonly gitEnv = signal<GitEnvSnapshot | null>(null);
  readonly showRaw = signal(false);
  private opened = false;

  readonly rawError = computed(() => this.store.remoteTroubleshootError());
  readonly summary = computed(() => {
    const raw = this.rawError();
    if (!raw) {
      return 'Test the remote, confirm the URL, and fix Git credentials or SSH if the host says the repository was not found.';
    }
    return humanizeGitError(raw);
  });
  readonly failedUrl = computed(() => extractRemoteUrlFromGitError(this.rawError()) ?? '');
  readonly remotes = computed(() => this.store.remotes());

  readonly selected = computed((): RemoteInfo | null => {
    const name = this.selectedName();
    return this.remotes().find((remote) => remote.name === name) ?? this.remotes()[0] ?? null;
  });

  readonly currentUrl = computed(() => {
    const remote = this.selected();
    return (remote?.fetchUrl || remote?.pushUrl || this.failedUrl()).trim();
  });

  readonly protocol = computed(() => remoteProtocol(this.currentUrl()));
  readonly sshUrl = computed(() => toSshRemoteUrl(this.currentUrl()));
  readonly webUrl = computed(() => parseRemoteWebBase(this.currentUrl())?.webBase ?? null);
  readonly ssoUrl = computed(() => githubSsoUrl(this.currentUrl()));
  readonly canSwitchToSsh = computed(() => {
    const ssh = this.sshUrl();
    return this.protocol() === 'https' && !!ssh && ssh !== this.currentUrl();
  });

  readonly hints = computed(() => {
    const protocol = this.protocol();
    const env = this.gitEnv();
    const helper = env?.credentialHelper?.trim() || 'not set';
    const items: { id: string; title: string; detail: string }[] = [];
    if (protocol === 'https') {
      items.push({
        id: 'auth',
        title: 'Git credentials, not the browser',
        detail:
          'GitHub returns “not found” for private repos when HTTPS Git is unauthenticated. Signing in to github.com in a browser does not update Git.',
      });
      items.push({
        id: 'helper',
        title: `Credential helper: ${helper}`,
        detail:
          helper === 'not set'
            ? 'No helper is configured, so Git cannot store a token. Set osxkeychain in Settings → SSH, or switch this remote to SSH.'
            : 'If an old password or token is stored, Git will keep failing until you update or delete it.',
      });
      if (this.ssoUrl()) {
        items.push({
          id: 'sso',
          title: 'Organization SSO',
          detail: 'If this is an org repo, authorize your token or SSH key for SSO, then test again.',
        });
      }
    } else if (protocol === 'ssh') {
      items.push({
        id: 'keys',
        title: env?.sshKeysFound ? 'SSH keys found on this machine' : 'No SSH keys in ~/.ssh',
        detail: env?.sshKeysFound
          ? 'Confirm this public key is added on GitHub, and that the org has authorized it for SSO.'
          : 'Generate a key in Settings → SSH, add it on GitHub, then test again.',
      });
    }
    items.push({
      id: 'url',
      title: 'Confirm the remote URL',
      detail: 'A renamed repo, wrong org, or extra path will also look like “not found”.',
    });
    return items;
  });

  constructor() {
    effect(() => {
      const open = this.store.remoteTroubleshootOpen();
      if (!open) {
        this.opened = false;
        return;
      }
      if (this.opened) return;
      this.opened = true;
      this.probe.set(null);
      this.showRaw.set(false);
      this.busy.set(false);
      const failed = normalizeRemoteUrl(this.failedUrl());
      const match = this.remotes().find((remote) => {
        const urls = [remote.fetchUrl, remote.pushUrl].map(normalizeRemoteUrl);
        return !!failed && urls.includes(failed);
      });
      this.selectedName.set(match?.name || this.remotes()[0]?.name || '');
      void this.loadEnv();
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeRemoteTroubleshoot();
  }

  selectRemote(name: string): void {
    this.selectedName.set(name);
    this.probe.set(null);
  }

  async copyUrl(): Promise<void> {
    const url = this.currentUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.store.showSuccess('Remote URL copied');
    } catch {
      this.store.showError('Could not copy URL');
    }
  }

  openInBrowser(): void {
    const url = this.webUrl();
    if (!url) return;
    void this.tauri.openExternalUrl(url);
  }

  openSso(): void {
    const url = this.ssoUrl();
    if (!url) return;
    void this.tauri.openExternalUrl(url);
  }

  openSshSettings(): void {
    this.store.closeRemoteTroubleshoot();
    this.store.openSettings('ssh');
  }

  showRemotes(): void {
    this.store.closeRemoteTroubleshoot();
    this.store.revealRefsGroup('remotes');
  }

  async testConnection(): Promise<void> {
    const remote = this.selected();
    this.busy.set(true);
    try {
      this.probe.set(
        await this.store.probeRemote({
          url: this.currentUrl() || undefined,
          remote: remote?.name,
        }),
      );
    } finally {
      this.busy.set(false);
    }
  }

  async switchToSsh(): Promise<void> {
    const remote = this.selected();
    const ssh = this.sshUrl();
    if (!remote || !ssh) return;
    this.busy.set(true);
    try {
      const ok = await this.store.setRemoteUrl(remote.name, ssh, { silent: true });
      if (!ok) return;
      this.store.showSuccess(`Updated ${remote.name} to SSH`);
      this.probe.set(await this.store.probeRemote({ url: ssh, remote: remote.name }));
    } finally {
      this.busy.set(false);
    }
  }

  private async loadEnv(): Promise<void> {
    try {
      this.gitEnv.set(await this.tauri.getGitEnv());
    } catch {
      this.gitEnv.set(null);
    }
  }
}
