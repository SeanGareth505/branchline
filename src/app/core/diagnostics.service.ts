import { Injectable, inject, signal } from '@angular/core';
import { TauriService } from './tauri.service';
import type { DiagnosticsSummary } from './models';
import { isIgnorableUnhandledError, rawErrorMessage } from '../shared/git/git-error';

@Injectable({ providedIn: 'root' })
export class DiagnosticsService {
  private readonly tauri = inject(TauriService);
  readonly summary = signal<DiagnosticsSummary | null>(null);
  private bound = false;

  bindGlobalHandlers(): void {
    if (this.bound || typeof window === 'undefined') return;
    this.bound = true;

    window.addEventListener('error', (event) => {
      const message = event.message || rawErrorMessage(event.error) || 'Unhandled error';
      void this.record(
        'window.error',
        message,
        event.error instanceof Error ? event.error.stack : undefined,
      );
    });

    window.addEventListener('unhandledrejection', (event) => {
      if (isIgnorableUnhandledError(event.reason)) return;
      const message = rawErrorMessage(event.reason) || 'Unhandled promise rejection';
      const detail = event.reason instanceof Error ? event.reason.stack : undefined;
      void this.record('unhandledrejection', message, detail);
    });
  }

  async refresh(): Promise<void> {
    try {
      this.summary.set(await this.tauri.getDiagnosticsSummary());
    } catch {
      this.summary.set(null);
    }
  }

  async record(source: string, message: string, detail?: string): Promise<void> {
    if (!message.trim()) return;
    try {
      await this.tauri.recordClientError(source, message, detail);
    } catch {
      /* ignore logging failures */
    }
  }

  async copyReport(): Promise<string> {
    return this.tauri.getDiagnosticsText();
  }

  async openFolder(): Promise<void> {
    await this.tauri.openDiagnosticsFolder();
  }

  async clear(): Promise<void> {
    await this.tauri.clearDiagnostics();
    await this.refresh();
  }
}
