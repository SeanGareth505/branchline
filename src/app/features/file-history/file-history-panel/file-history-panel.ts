import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { FileHistoryEntry } from '../../../core/models';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';

@Component({
  selector: 'app-file-history-panel',
  imports: [HelpTip, LoadingBlock],
  templateUrl: './file-history-panel.html',
  styleUrl: './file-history-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileHistoryPanel {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  readonly entries = signal<FileHistoryEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private loadToken = 0;

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path;
      const file = this.store.fileHistoryPath() ?? this.store.selectedDiffPath();
      const tab = this.store.browseTab();
      if (tab !== 'history' || !path || !file) {
        if (tab === 'history' && !file) {
          this.entries.set([]);
          this.error.set(null);
        }
        return;
      }
      void this.load(path, file);
    });
  }

  private async load(path: string, file: string): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set(null);
    try {
      const entries = await this.tauri.getFileHistory(path, file);
      if (token !== this.loadToken) return;
      this.entries.set(entries);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.entries.set([]);
      this.error.set(this.store.formatError(err));
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  retry(): void {
    const path = this.store.currentRepo()?.path;
    const file = this.store.fileHistoryPath() ?? this.store.selectedDiffPath();
    if (!path || !file) return;
    void this.load(path, file);
  }

  time(ts: number): string {
    return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true });
  }

  select(entry: FileHistoryEntry): void {
    this.store.selectCommit(entry.sha);
    this.store.setBrowseTab('diff');
  }

  restore(entry: FileHistoryEntry): void {
    const file = this.displayPath;
    if (!file) return;
    void this.store.restoreFileFromRevision(file, entry.sha);
  }

  hasFile(): boolean {
    return !!(this.store.fileHistoryPath() ?? this.store.selectedDiffPath());
  }

  get displayPath(): string {
    return this.store.fileHistoryPath() ?? this.store.selectedDiffPath() ?? '';
  }
}
