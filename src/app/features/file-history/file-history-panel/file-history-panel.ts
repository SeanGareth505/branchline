import { Component, effect, inject, signal } from '@angular/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { FileHistoryEntry } from '../../../core/models';

@Component({
  selector: 'app-file-history-panel',
  imports: [],
  templateUrl: './file-history-panel.html',
  styleUrl: './file-history-panel.scss',
})
export class FileHistoryPanel {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  readonly entries = signal<FileHistoryEntry[]>([]);
  readonly loading = signal(false);

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path;
      const file = this.store.fileHistoryPath() ?? this.store.selectedDiffPath();
      const tab = this.store.browseTab();
      if (tab !== 'history' || !path || !file) {
        if (tab === 'history' && !file) this.entries.set([]);
        return;
      }
      void this.load(path, file);
    });
  }

  private async load(path: string, file: string): Promise<void> {
    this.loading.set(true);
    try {
      this.entries.set(await this.tauri.getFileHistory(path, file));
    } catch {
      this.entries.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  time(ts: number): string {
    return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true });
  }

  select(entry: FileHistoryEntry): void {
    this.store.selectCommit(entry.sha);
    this.store.setBrowseTab('diff');
  }

  hasFile(): boolean {
    return !!(this.store.fileHistoryPath() ?? this.store.selectedDiffPath());
  }

  get displayPath(): string {
    return this.store.fileHistoryPath() ?? this.store.selectedDiffPath() ?? '';
  }
}
