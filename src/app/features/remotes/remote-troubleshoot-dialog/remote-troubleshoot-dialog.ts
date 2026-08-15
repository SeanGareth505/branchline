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
  githubOrgFromRemote,
  githubSshKeysUrl,
  normalizeRemoteUrl,
  parseRemoteWebBase,
  remoteProtocol,
  remoteRepoSlug,
} from '../../../shared/git/repo-links';
import { GitAccountBar } from '../git-account-bar/git-account-bar';

@Component({
  selector: 'app-remote-troubleshoot-dialog',
  imports: [NgIcon, GitAccountBar],
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
  readonly envReady = signal(false);
  private opened = false;

  readonly rawError = computed(() => this.store.remoteTroubleshootError());
  readonly summary = computed(() => {
    const raw = this.rawError();
    if (!raw) {
      return 'Test the remote. Switch GitHub account or HTTPS/SSH above if Git says the repository was not found.';
    }
    if (/repository not found/i.test(raw) && this.protocol() === 'ssh') {
      return 'SSH reached GitHub, but this repo was hidden. Switch this repo to HTTPS above, then pick the GitHub CLI account that can open it in the browser.';
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
  readonly repoSlug = computed(() => remoteRepoSlug(this.currentUrl()));
  readonly webUrl = computed(() => parseRemoteWebBase(this.currentUrl())?.webBase ?? null);
  readonly sshKeysUrl = computed(() => githubSshKeysUrl(this.currentUrl()));
  readonly orgName = computed(() => githubOrgFromRemote(this.currentUrl()));
  readonly canSwitchToHttps = computed(() => this.protocol() === 'ssh');
  readonly canSwitchToSsh = computed(() => this.protocol() === 'https');

  readonly missingSshKey = computed(() => {
    if (this.protocol() !== 'ssh' || !this.envReady()) return false;
    const env = this.gitEnv();
    return !env?.sshKeysFound && !env?.sshAgent;
  });

  readonly notFoundError = computed(() => {
    const text = `${this.rawError()}\n${this.probe()?.message ?? ''}`;
    return /repository not found|could not read from remote/i.test(text);
  });

  readonly primaryAction = computed((): 'ssh' | 'open' | 'test' => {
    if (this.missingSshKey()) return 'ssh';
    if (this.notFoundError() && this.webUrl()) return 'open';
    return 'test';
  });

  readonly statusBox = computed(() => {
    const probe = this.probe();
    if (probe) {
      return {
        ok: probe.ok,
        title: probe.ok ? 'Remote responded' : 'Still unreachable',
        message: humanizeGitError(probe.message) || probe.message,
      };
    }
    const raw = this.rawError();
    if (!raw) return null;
    return { ok: false, title: 'Git error', message: humanizeGitError(raw) };
  });

  readonly hints = computed(() => {
    const protocol = this.protocol();
    const env = this.gitEnv();
    const helper = env?.credentialHelper?.trim() || 'not set';
    const items: { id: string; title: string; detail: string; action?: 'ssh' }[] = [];
    if (protocol === 'https') {
      items.push({
        id: 'auth',
        title: 'Use the HTTPS login above',
        detail:
          'GitHub Connected in Branchline is only the API. Fetch and push use GitHub CLI (or the credential helper), not the browser.',
      });
      if (helper.toLowerCase().includes('gh auth')) {
        items.push({
          id: 'helper',
          title: 'GitHub CLI is the password',
          detail:
            'Git will not prompt for a password. Click the account that can open this repo in the browser, then Test connection.',
        });
      } else {
        items.push({
          id: 'helper',
          title: `Credential helper: ${helper}`,
          detail:
            helper === 'not set'
              ? 'No helper is configured, so Git cannot store a token. Set osxkeychain in Settings → SSH, or keep using GitHub CLI.'
              : 'If an old password or token is stored, Git will keep failing until you update it or switch GitHub CLI account.',
        });
      }
    } else if (protocol === 'ssh' && this.envReady()) {
      if (this.missingSshKey()) {
        items.push({
          id: 'keys',
          title: 'No SSH keys in ~/.ssh',
          detail: 'Generate a key, add it on GitHub, then test again. Or switch this repo to HTTPS.',
          action: 'ssh',
        });
      } else {
        items.push({
          id: 'keys',
          title: 'SSH ignores GitHub CLI',
          detail:
            'The account chips above only apply after you switch this repo to HTTPS. SSH uses the key in ~/.ssh, which may be a different GitHub user.',
        });
      }
      const org = this.orgName();
      if (org) {
        items.push({
          id: 'sso',
          title: `${org} may block SSH`,
          detail: `If the repo opens in the browser but Git still says not found, switch this repo to HTTPS and pick the ${org} account.`,
        });
      }
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
      this.busy.set(false);
      this.envReady.set(false);
      this.gitEnv.set(null);
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

  openSshKeys(): void {
    const url = this.sshKeysUrl();
    if (!url) return;
    void this.tauri.openExternalUrl(url);
  }

  openSshSettings(): void {
    this.store.closeRemoteTroubleshoot();
    this.store.openSettings('connections', 'ssh');
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

  async switchProtocol(protocol: 'https' | 'ssh'): Promise<void> {
    this.busy.set(true);
    try {
      const ok = await this.store.setRepoRemoteProtocol(protocol);
      if (!ok) return;
      const remote = this.selected();
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

  private async loadEnv(): Promise<void> {
    try {
      this.gitEnv.set(await this.tauri.getGitEnv());
    } catch {
      this.gitEnv.set(null);
    } finally {
      this.envReady.set(true);
    }
  }
}
