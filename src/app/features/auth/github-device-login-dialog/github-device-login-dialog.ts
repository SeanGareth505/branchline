import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';

type Step = 'setup' | 'code' | 'done' | 'error';

@Component({
  selector: 'app-github-device-login-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './github-device-login-dialog.html',
  styleUrl: './github-device-login-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GithubDeviceLoginDialog {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly step = signal<Step>('setup');
  readonly clientIdDraft = signal('');
  readonly userCode = signal('');
  readonly verificationUri = signal('https://github.com/login/device');
  readonly verificationUriComplete = signal<string | null>(null);
  readonly statusText = signal('Waiting for GitHub…');
  readonly errorText = signal('');
  readonly busy = signal(false);

  private deviceCode = '';
  private pollTimer: number | null = null;
  private intervalSec = 5;
  private expiresAt = 0;

  readonly hasClientId = computed(() => !!this.store.settings().githubOAuthClientId.trim());

  constructor() {
    effect(() => {
      if (!this.store.githubDeviceLoginOpen()) {
        this.stopPolling();
        return;
      }
      this.reset();
      if (this.hasClientId()) {
        void this.startDeviceFlow();
      } else {
        this.step.set('setup');
      }
    });
  }

  close(): void {
    if (this.busy() && this.step() === 'code') {
      this.stopPolling();
    }
    this.store.closeGithubDeviceLogin();
  }

  openCreateOAuthApp(): void {
    window.open('https://github.com/settings/applications/new', '_blank', 'noopener');
  }

  openDevicePage(): void {
    const complete = this.verificationUriComplete();
    window.open(complete || this.verificationUri(), '_blank', 'noopener');
  }

  async saveClientIdAndStart(): Promise<void> {
    const id = this.clientIdDraft().trim();
    if (!id) {
      this.errorText.set('Paste the OAuth App Client ID first.');
      return;
    }
    this.busy.set(true);
    try {
      await this.store.saveSettings({ githubOAuthClientId: id });
      await this.startDeviceFlow();
    } catch (err) {
      this.errorText.set(String((err as { message?: string })?.message ?? err));
      this.step.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  async startDeviceFlow(): Promise<void> {
    const clientId = this.store.settings().githubOAuthClientId.trim();
    if (!clientId) {
      this.step.set('setup');
      return;
    }

    this.busy.set(true);
    this.errorText.set('');
    this.statusText.set('Starting GitHub sign-in…');
    try {
      const started = await this.tauri.githubDeviceLoginStart(clientId);
      this.deviceCode = started.deviceCode;
      this.userCode.set(started.userCode);
      this.verificationUri.set(started.verificationUri || 'https://github.com/login/device');
      this.verificationUriComplete.set(started.verificationUriComplete ?? null);
      this.intervalSec = Math.max(1, started.interval || 5);
      this.expiresAt = Date.now() + (started.expiresIn || 900) * 1000;
      this.step.set('code');
      this.statusText.set('Enter this code on GitHub, then return here.');
      this.openDevicePage();
      this.schedulePoll(this.intervalSec * 1000);
    } catch (err) {
      this.errorText.set(String((err as { message?: string })?.message ?? err));
      this.step.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  private schedulePoll(delayMs: number): void {
    this.stopPolling();
    this.pollTimer = window.setTimeout(() => void this.pollOnce(), delayMs);
  }

  private stopPolling(): void {
    if (this.pollTimer != null) {
      window.clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.store.githubDeviceLoginOpen() || this.step() !== 'code') return;
    if (Date.now() > this.expiresAt) {
      this.errorText.set('This code expired. Start again.');
      this.step.set('error');
      return;
    }

    const clientId = this.store.settings().githubOAuthClientId.trim();
    try {
      const result = await this.tauri.githubDeviceLoginPoll(clientId, this.deviceCode);
      if (result.status === 'complete' && result.accessToken) {
        this.stopPolling();
        this.statusText.set('Saving…');
        const ok = await this.store.signInGitHost('github', result.accessToken);
        if (ok) {
          this.step.set('done');
          this.statusText.set('Signed in to GitHub');
          window.setTimeout(() => this.store.closeGithubDeviceLogin(), 900);
        } else {
          this.errorText.set('Signed in, but saving the token failed.');
          this.step.set('error');
        }
        return;
      }

      if (result.status === 'slow_down') {
        this.intervalSec = Math.max(this.intervalSec + 5, result.interval || this.intervalSec + 5);
        this.statusText.set('GitHub asked us to wait a bit longer…');
        this.schedulePoll(this.intervalSec * 1000);
        return;
      }

      if (result.status === 'pending') {
        this.statusText.set('Waiting for you to authorize in the browser…');
        this.schedulePoll(this.intervalSec * 1000);
        return;
      }

      if (result.status === 'expired') {
        this.errorText.set('This code expired. Start again.');
        this.step.set('error');
        return;
      }

      if (result.status === 'denied') {
        this.errorText.set('Authorization was denied on GitHub.');
        this.step.set('error');
        return;
      }

      this.errorText.set(result.errorDescription || `GitHub returned: ${result.status}`);
      this.step.set('error');
    } catch (err) {
      this.errorText.set(String((err as { message?: string })?.message ?? err));
      this.step.set('error');
    }
  }

  private reset(): void {
    this.stopPolling();
    this.deviceCode = '';
    this.userCode.set('');
    this.verificationUri.set('https://github.com/login/device');
    this.verificationUriComplete.set(null);
    this.statusText.set('');
    this.errorText.set('');
    this.busy.set(false);
    this.clientIdDraft.set(this.store.settings().githubOAuthClientId);
    this.step.set(this.hasClientId() ? 'code' : 'setup');
  }
}
