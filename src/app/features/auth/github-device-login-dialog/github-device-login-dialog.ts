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
import {
  hasGithubOAuthClientId,
  resolveGithubOAuthClientId,
} from '../../../core/github-oauth';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';

type Step = 'connect' | 'code' | 'done' | 'error' | 'dev-setup';

const DEVICE_LOGIN_URL = 'https://github.com/login/device';
const CREATE_OAUTH_APP_URL = 'https://github.com/settings/applications/new';

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

  readonly step = signal<Step>('connect');
  readonly clientIdDraft = signal('');
  readonly userCode = signal('');
  readonly verificationUri = signal(DEVICE_LOGIN_URL);
  readonly verificationUriComplete = signal<string | null>(null);
  readonly statusText = signal('Waiting for GitHub…');
  readonly errorText = signal('');
  readonly busy = signal(false);
  readonly copiedCode = signal(false);
  readonly showDevSetup = signal(false);

  private deviceCode = '';
  private pollTimer: number | null = null;
  private intervalSec = 5;
  private expiresAt = 0;
  private sessionOpen = false;
  private copyResetTimer: number | null = null;

  readonly hasClientId = computed(() =>
    hasGithubOAuthClientId(this.store.settings().githubOAuthClientId),
  );

  constructor() {
    effect(() => {
      const open = this.store.githubDeviceLoginOpen();
      if (!open) {
        if (this.sessionOpen) {
          this.stopPolling();
          this.sessionOpen = false;
        }
        return;
      }
      if (this.sessionOpen) {
        return;
      }
      this.sessionOpen = true;
      this.reset();
      if (this.hasClientId()) {
        void this.startDeviceFlow();
      } else {
        this.step.set('connect');
      }
    });
  }

  close(): void {
    this.stopPolling();
    this.store.closeGithubDeviceLogin();
  }

  async connect(): Promise<void> {
    if (!this.hasClientId()) {
      this.errorText.set(
        'GitHub sign-in is not configured in this build yet. The app publisher needs to add the OAuth Client ID once.',
      );
      this.step.set('error');
      return;
    }
    await this.startDeviceFlow();
  }

  async openDevicePage(): Promise<void> {
    const complete = this.verificationUriComplete();
    await this.openUrl(complete || this.verificationUri() || DEVICE_LOGIN_URL);
  }

  async openCreateOAuthApp(): Promise<void> {
    await this.openUrl(CREATE_OAUTH_APP_URL);
  }

  async copyUserCode(): Promise<void> {
    const code = this.userCode().trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.copiedCode.set(true);
      if (this.copyResetTimer != null) {
        window.clearTimeout(this.copyResetTimer);
      }
      this.copyResetTimer = window.setTimeout(() => this.copiedCode.set(false), 1600);
    } catch {
      this.store.showError('Could not copy the code. Select it and copy manually.');
    }
  }

  toggleDevSetup(): void {
    this.showDevSetup.update((v) => !v);
    if (this.showDevSetup()) {
      this.clientIdDraft.set(this.store.settings().githubOAuthClientId);
      this.step.set('dev-setup');
    } else {
      this.step.set('connect');
    }
  }

  async saveClientIdAndStart(): Promise<void> {
    const id = this.clientIdDraft().trim();
    if (!id) {
      this.errorText.set('Paste the OAuth App Client ID first.');
      return;
    }
    this.busy.set(true);
    this.errorText.set('');
    try {
      await this.store.saveSettings({ githubOAuthClientId: id });
      await this.startDeviceFlow();
    } catch (err) {
      this.errorText.set(this.formatErr(err));
      this.step.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  async startDeviceFlow(): Promise<void> {
    const clientId = resolveGithubOAuthClientId(this.store.settings().githubOAuthClientId);
    if (!clientId) {
      this.step.set('connect');
      return;
    }

    this.busy.set(true);
    this.errorText.set('');
    this.statusText.set('Starting GitHub sign-in…');
    try {
      const started = await this.tauri.githubDeviceLoginStart(clientId);
      this.deviceCode = started.deviceCode;
      this.userCode.set(started.userCode);
      this.verificationUri.set(started.verificationUri || DEVICE_LOGIN_URL);
      this.verificationUriComplete.set(started.verificationUriComplete ?? null);
      this.intervalSec = Math.max(1, started.interval || 5);
      this.expiresAt = Date.now() + (started.expiresIn || 900) * 1000;
      this.step.set('code');
      this.statusText.set('Enter this code on GitHub, then return here.');
      await this.openDevicePage();
      this.schedulePoll(this.intervalSec * 1000);
    } catch (err) {
      this.errorText.set(this.formatErr(err));
      this.step.set('error');
    } finally {
      this.busy.set(false);
    }
  }

  private async openUrl(url: string): Promise<void> {
    try {
      await this.tauri.openExternalUrl(url);
    } catch (err) {
      this.store.showError(this.formatErr(err) || 'Could not open the browser.');
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

    const clientId = resolveGithubOAuthClientId(this.store.settings().githubOAuthClientId);
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
      this.errorText.set(this.formatErr(err));
      this.step.set('error');
    }
  }

  private formatErr(err: unknown): string {
    return String((err as { message?: string })?.message ?? err);
  }

  private reset(): void {
    this.stopPolling();
    this.deviceCode = '';
    this.userCode.set('');
    this.verificationUri.set(DEVICE_LOGIN_URL);
    this.verificationUriComplete.set(null);
    this.statusText.set('');
    this.errorText.set('');
    this.busy.set(false);
    this.copiedCode.set(false);
    this.showDevSetup.set(false);
    this.clientIdDraft.set(this.store.settings().githubOAuthClientId);
    this.step.set(this.hasClientId() ? 'code' : 'connect');
  }
}
