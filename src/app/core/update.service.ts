import { Injectable, inject, signal } from '@angular/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { TauriService } from './tauri.service';

const DISMISS_KEY = 'branchline.update.dismissedVersion';
export const UPDATE_DOWNLOAD_PAGE = 'https://seangareth505.github.io/branchline/';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'error';

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly tauri = inject(TauriService);
  private pending: Update | null = null;

  readonly phase = signal<UpdatePhase>('idle');
  readonly currentVersion = signal('');
  readonly availableVersion = signal<string | null>(null);
  readonly releaseNotes = signal('');
  readonly downloadPercent = signal<number | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly bannerVisible = signal(false);
  readonly downloadPageUrl = UPDATE_DOWNLOAD_PAGE;

  async init(): Promise<void> {
    if (this.tauri.isDummyBackend) return;
    try {
      this.currentVersion.set(await getVersion());
    } catch {
      this.currentVersion.set('');
    }
    await this.checkForUpdates({ silent: true });
  }

  async checkForUpdates(options: { silent?: boolean } = {}): Promise<boolean> {
    if (this.tauri.isDummyBackend) {
      if (!options.silent) {
        this.errorMessage.set('Updates are only available in the desktop app.');
        this.phase.set('error');
      }
      return false;
    }

    this.phase.set('checking');
    this.errorMessage.set(null);
    try {
      const update = await check();
      if (!update) {
        this.pending = null;
        this.availableVersion.set(null);
        this.releaseNotes.set('');
        this.bannerVisible.set(false);
        this.phase.set('idle');
        return false;
      }

      this.pending = update;
      this.availableVersion.set(update.version);
      this.releaseNotes.set(update.body?.trim() ?? '');
      this.phase.set('available');

      const dismissed = this.readDismissedVersion();
      if (!options.silent || dismissed !== update.version) {
        this.bannerVisible.set(true);
      }
      return true;
    } catch (err) {
      this.pending = null;
      this.availableVersion.set(null);
      if (options.silent) {
        this.errorMessage.set(null);
        this.phase.set('idle');
        return false;
      }
      this.errorMessage.set(this.formatError(err));
      this.phase.set('error');
      this.bannerVisible.set(false);
      return false;
    }
  }

  dismissBanner(): void {
    const version = this.availableVersion();
    if (version) {
      try {
        localStorage.setItem(DISMISS_KEY, version);
      } catch {
        /* ignore */
      }
    }
    this.bannerVisible.set(false);
  }

  async openDownloadPage(): Promise<void> {
    try {
      await this.tauri.openExternalUrl(UPDATE_DOWNLOAD_PAGE);
    } catch (err) {
      this.errorMessage.set(this.formatError(err));
      this.phase.set('error');
    }
  }

  async installAndRelaunch(): Promise<void> {
    if (!this.pending) {
      const found = await this.checkForUpdates({ silent: true });
      if (!found || !this.pending) {
        this.errorMessage.set('No update available to install.');
        this.phase.set('error');
        return;
      }
    }

    const update = this.pending;
    this.phase.set('downloading');
    this.downloadPercent.set(0);
    this.errorMessage.set(null);

    try {
      let contentLength: number | undefined;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength;
          downloaded = 0;
          this.downloadPercent.set(contentLength ? 0 : null);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (contentLength && contentLength > 0) {
            this.downloadPercent.set(Math.min(100, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === 'Finished') {
          this.downloadPercent.set(100);
        }
      });
      this.downloadPercent.set(100);
      await relaunch();
    } catch (err) {
      this.errorMessage.set(this.formatError(err));
      this.phase.set('error');
      this.bannerVisible.set(true);
    }
  }

  private formatError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    if (/404|not found/i.test(message)) {
      return `${message} — the macOS installer is missing from this release. Use Download page instead.`;
    }
    return message;
  }

  private readDismissedVersion(): string | null {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  }
}
