import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { SshSetupOutput } from '../../../core/models';

const GITHUB_SSH_KEYS_URL = 'https://github.com/settings/keys';
const GITHUB_SSH_GUIDE_URL =
  'https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account';

@Component({
  selector: 'app-ssh-setup-panel',
  imports: [],
  templateUrl: './ssh-setup-panel.html',
  styleUrl: './ssh-setup-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SshSetupPanel implements OnInit {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);

  readonly keyComment = input('');
  readonly setupChanged = output<SshSetupOutput>();

  readonly setup = signal<SshSetupOutput | null>(null);
  readonly busy = signal(false);
  readonly copied = signal(false);
  readonly errorText = signal('');

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.errorText.set('');
    try {
      const result = await this.tauri.getSshSetup();
      this.setup.set(result);
      this.setupChanged.emit(result);
    } catch (err) {
      this.errorText.set(this.store.formatError(err));
    }
  }

  async generateKey(): Promise<void> {
    this.busy.set(true);
    this.errorText.set('');
    this.copied.set(false);
    try {
      const result = await this.tauri.generateSshKey(this.keyComment());
      this.setup.set(result);
      this.setupChanged.emit(result);
      this.store.showToast(result.message, { kind: 'success' });
    } catch (err) {
      this.errorText.set(this.store.formatError(err));
      this.store.showError(err);
    } finally {
      this.busy.set(false);
    }
  }

  async copyPublicKey(): Promise<void> {
    const key = this.setup()?.publicKey?.trim();
    if (!key) {
      this.store.showToast('No public key to copy yet', { kind: 'warning' });
      return;
    }
    try {
      await navigator.clipboard.writeText(key);
      this.copied.set(true);
      this.store.showToast('Public key copied', { kind: 'success' });
      window.setTimeout(() => this.copied.set(false), 2000);
    } catch {
      this.store.showError('Could not copy to clipboard');
    }
  }

  async openGithubKeys(): Promise<void> {
    try {
      await this.tauri.openExternalUrl(GITHUB_SSH_KEYS_URL);
    } catch (err) {
      this.store.showError(err);
    }
  }

  async openGuide(): Promise<void> {
    try {
      await this.tauri.openExternalUrl(GITHUB_SSH_GUIDE_URL);
    } catch (err) {
      this.store.showError(err);
    }
  }
}
