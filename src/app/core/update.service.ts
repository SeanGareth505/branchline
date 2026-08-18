import { Injectable, Injector, inject, signal } from '@angular/core';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { AppStore } from './app.store';
import { TauriService } from './tauri.service';
import { rawErrorMessage } from '../shared/git/git-error';
import {
  extractWhatsNewBody,
  githubReleaseTagUrl,
  normalizeAppVersion,
  shouldShowWhatsNew,
} from './whats-new';

const DISMISS_KEY = 'branchline.update.dismissedVersion';
const LAST_SEEN_KEY = 'branchline.update.lastSeenVersion';
const PENDING_NOTES_KEY = 'branchline.update.pendingNotes';
export const UPDATE_DOWNLOAD_PAGE = 'https://seangareth505.github.io/branchline/';

type PendingNotes = { version: string; body: string };

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'error';

@Injectable({ providedIn: 'root' })
export class UpdateService {
  private static readonly CHECK_THROTTLE_MS = 20_000;
  private static readonly PERIODIC_MS = 5 * 60_000;
  private readonly tauri = inject(TauriService);
  private readonly injector = inject(Injector);
  private pending: Update | null = null;
  private checkInFlight: Promise<boolean> | null = null;
  private lastCheckAt = 0;
  private lastNotifiedVersion = '';
  private watchedVersion: string | null = null;
  private recheckTimer: number | null = null;
  private watchTimer: number | null = null;
  private listenersBound = false;

  readonly phase = signal<UpdatePhase>('idle');
  readonly currentVersion = signal('');
  readonly availableVersion = signal<string | null>(null);
  readonly releaseNotes = signal('');
  readonly downloadPercent = signal<number | null>(null);
  readonly errorMessage = signal<string | null>(null);
  readonly bannerVisible = signal(false);
  readonly notesDialogOpen = signal(false);
  readonly whatsNewVersion = signal('');
  readonly whatsNewBody = signal('');
  readonly downloadPageUrl = UPDATE_DOWNLOAD_PAGE;

  private get store(): AppStore {
    return this.injector.get(AppStore);
  }

  async init(): Promise<void> {
    try {
      this.currentVersion.set(await getVersion());
    } catch {
      this.currentVersion.set('');
    }
    if (this.tauri.isDummyBackend) return;
    await this.maybeShowWhatsNew();
    this.bindBackgroundChecks();
    await this.checkForUpdates({ silent: true, force: true });
  }

  watchUntilAvailable(version: string): void {
    const target = normalizeAppVersion(version);
    if (!target || this.tauri.isDummyBackend) return;
    if (normalizeAppVersion(this.currentVersion()) === target) return;
    if (
      normalizeAppVersion(this.availableVersion()) === target &&
      (this.bannerVisible() || this.phase() === 'available' || this.phase() === 'ready')
    ) {
      return;
    }
    this.watchedVersion = target;
    this.clearWatchTimer();
    void this.pollWatchedVersion(0);
  }

  async checkForUpdates(options: { silent?: boolean; force?: boolean } = {}): Promise<boolean> {
    if (this.tauri.isDummyBackend) {
      if (!options.silent) {
        this.errorMessage.set('Updates are only available in the desktop app.');
        this.phase.set('error');
      }
      return false;
    }
    if (this.phase() === 'downloading' || this.phase() === 'installing') {
      return !!this.pending;
    }
    if (this.checkInFlight) return this.checkInFlight;
    const now = Date.now();
    if (
      !options.force &&
      options.silent &&
      this.lastCheckAt > 0 &&
      now - this.lastCheckAt < UpdateService.CHECK_THROTTLE_MS
    ) {
      return !!this.pending;
    }

    this.checkInFlight = this.runCheck(options).finally(() => {
      this.checkInFlight = null;
    });
    return this.checkInFlight;
  }

  private async runCheck(options: { silent?: boolean; force?: boolean }): Promise<boolean> {
    const hadPending = !!this.pending;
    if (!options.silent || !hadPending) {
      this.phase.set('checking');
      this.errorMessage.set(null);
    }
    try {
      const update = await check();
      this.lastCheckAt = Date.now();
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

      if (normalizeAppVersion(update.version) === normalizeAppVersion(this.currentVersion())) {
        this.pending = null;
        this.availableVersion.set(null);
        this.releaseNotes.set('');
        this.bannerVisible.set(false);
        this.phase.set('idle');
        return false;
      }

      const dismissed = normalizeAppVersion(this.readDismissedVersion());
      const next = normalizeAppVersion(update.version);
      const showBanner = !options.silent || dismissed !== next;
      if (showBanner) this.bannerVisible.set(true);
      if (showBanner && this.lastNotifiedVersion !== next) {
        this.lastNotifiedVersion = next;
        this.store.notifyEvent(
          'updates',
          'Update available',
          `Branchline ${next} is ready to install`,
          { toast: true, desktop: true },
        );
      }
      return true;
    } catch (err) {
      if (options.silent) {
        if (!hadPending) this.phase.set('idle');
        return false;
      }
      this.pending = null;
      this.availableVersion.set(null);
      this.errorMessage.set(this.formatError(err));
      this.phase.set('error');
      this.bannerVisible.set(false);
      return false;
    }
  }

  private bindBackgroundChecks(): void {
    if (this.listenersBound || typeof window === 'undefined') return;
    this.listenersBound = true;
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void this.checkForUpdates({ silent: true });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const tick = (): void => {
      this.recheckTimer = window.setTimeout(() => {
        void this.checkForUpdates({ silent: true });
        tick();
      }, UpdateService.PERIODIC_MS);
    };
    tick();
  }

  private async pollWatchedVersion(attempt: number): Promise<void> {
    const target = this.watchedVersion;
    if (!target) return;
    if (normalizeAppVersion(this.currentVersion()) === target) {
      this.watchedVersion = null;
      return;
    }
    const found = await this.checkForUpdates({ silent: true, force: true });
    if (found && normalizeAppVersion(this.availableVersion()) === target) {
      this.watchedVersion = null;
      return;
    }
    if (attempt >= 10) {
      this.watchedVersion = null;
      return;
    }
    const delays = [8_000, 15_000, 30_000, 45_000, 60_000];
    const delay = delays[Math.min(attempt, delays.length - 1)]!;
    this.watchTimer = window.setTimeout(() => {
      void this.pollWatchedVersion(attempt + 1);
    }, delay);
  }

  private clearWatchTimer(): void {
    if (this.watchTimer == null) return;
    window.clearTimeout(this.watchTimer);
    this.watchTimer = null;
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
    await this.installUpdate();
  }

  async installUpdate(): Promise<void> {
    if (this.phase() === 'downloading' || this.phase() === 'installing') return;
    if (this.phase() === 'ready') {
      await this.relaunchNow();
      return;
    }
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
    this.bannerVisible.set(true);

    try {
      let contentLength: number | undefined;
      let downloaded = 0;
      await update.download((event) => {
        if (event.event === 'Started') {
          contentLength = event.data.contentLength;
          downloaded = 0;
          this.downloadPercent.set(contentLength ? 0 : null);
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (contentLength && contentLength > 0) {
            this.downloadPercent.set(Math.min(99, Math.round((downloaded / contentLength) * 100)));
          }
        } else if (event.event === 'Finished') {
          this.downloadPercent.set(100);
        }
      });
      this.downloadPercent.set(100);
      this.phase.set('installing');
      await update.install();
      this.writePendingNotes(update.version, update.body ?? this.releaseNotes());
      this.phase.set('ready');
    } catch (err) {
      this.errorMessage.set(this.formatError(err));
      this.phase.set('error');
      this.bannerVisible.set(true);
    }
  }

  dismissWhatsNew(): void {
    const version = this.whatsNewVersion() || this.currentVersion();
    this.writeLastSeenVersion(version);
    this.clearPendingNotes();
    this.notesDialogOpen.set(false);
    this.whatsNewBody.set('');
  }

  async openWhatsNewOnGithub(): Promise<void> {
    const url = githubReleaseTagUrl(this.whatsNewVersion() || this.currentVersion());
    if (!url) return;
    try {
      await this.tauri.openExternalUrl(url);
    } catch (err) {
      this.errorMessage.set(this.formatError(err));
    }
  }

  async relaunchNow(): Promise<void> {
    try {
      await relaunch();
    } catch (err) {
      this.errorMessage.set(this.formatError(err));
      this.phase.set('error');
      this.bannerVisible.set(true);
    }
  }

  private formatError(err: unknown): string {
    const message = rawErrorMessage(err) || String(err ?? '');
    if (/404|not found/i.test(message)) {
      return `${message} — the updater file was missing. Try again, or use Download page.`;
    }
    if (/403|forbidden/i.test(message)) {
      return `${message} — GitHub blocked the installer download. Use Download page, then try again after the release finishes publishing.`;
    }
    return message;
  }

  private async maybeShowWhatsNew(): Promise<void> {
    const current = normalizeAppVersion(this.currentVersion());
    if (!current) return;
    const pending = this.readPendingNotes();
    const pendingForCurrent =
      pending && normalizeAppVersion(pending.version) === current ? pending : null;
    const lastSeen = this.readLastSeenVersion();
    if (
      !shouldShowWhatsNew({
        currentVersion: current,
        lastSeenVersion: lastSeen,
        pendingVersion: pendingForCurrent?.version ?? null,
      })
    ) {
      if (!lastSeen) this.writeLastSeenVersion(current);
      if (pending && !pendingForCurrent) this.clearPendingNotes();
      return;
    }

    let body = extractWhatsNewBody(pendingForCurrent?.body ?? '');
    if (!body) {
      body = extractWhatsNewBody(await this.fetchGithubReleaseNotes(current));
    }
    this.whatsNewVersion.set(current);
    this.whatsNewBody.set(body);
    this.notesDialogOpen.set(true);
  }

  private async fetchGithubReleaseNotes(version: string): Promise<string> {
    const tag = `v${normalizeAppVersion(version)}`;
    try {
      const response = await fetch(
        `https://api.github.com/repos/SeanGareth505/branchline/releases/tags/${tag}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
          },
        },
      );
      if (!response.ok) return '';
      const json = (await response.json()) as { body?: unknown };
      return typeof json.body === 'string' ? json.body : '';
    } catch {
      return '';
    }
  }

  private readDismissedVersion(): string | null {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  }

  private readLastSeenVersion(): string | null {
    try {
      return localStorage.getItem(LAST_SEEN_KEY);
    } catch {
      return null;
    }
  }

  private writeLastSeenVersion(version: string): void {
    const value = normalizeAppVersion(version);
    if (!value) return;
    try {
      localStorage.setItem(LAST_SEEN_KEY, value);
    } catch {
      /* ignore */
    }
  }

  private readPendingNotes(): PendingNotes | null {
    try {
      const raw = localStorage.getItem(PENDING_NOTES_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PendingNotes;
      if (!parsed?.version) return null;
      return { version: String(parsed.version), body: String(parsed.body ?? '') };
    } catch {
      return null;
    }
  }

  private writePendingNotes(version: string, body: string): void {
    const value = normalizeAppVersion(version);
    if (!value) return;
    try {
      localStorage.setItem(
        PENDING_NOTES_KEY,
        JSON.stringify({ version: value, body: body ?? '' }),
      );
    } catch {
      /* ignore */
    }
  }

  private clearPendingNotes(): void {
    try {
      localStorage.removeItem(PENDING_NOTES_KEY);
    } catch {
      /* ignore */
    }
  }
}
