import { Component, effect, inject, signal } from '@angular/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { ReflogEntry } from '../../../core/models';

@Component({
  selector: 'app-reflog-panel',
  imports: [],
  templateUrl: './reflog-panel.html',
  styleUrl: './reflog-panel.scss',
})
export class ReflogPanel {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);
  readonly entries = signal<ReflogEntry[]>([]);
  readonly loading = signal(false);

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path;
      const tab = this.store.browseTab();
      if (tab !== 'reflog' || !path) {
        if (tab === 'reflog') this.entries.set([]);
        return;
      }
      void this.load(path);
    });
  }

  private async load(path: string): Promise<void> {
    this.loading.set(true);
    try {
      this.entries.set(await this.tauri.listReflog(path, 100));
    } catch {
      this.entries.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  time(ts: number): string {
    if (!ts) return '';
    return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true });
  }

  select(entry: ReflogEntry): void {
    this.store.selectCommit(entry.sha);
    this.store.setBrowseTab('diff');
  }

  checkout(entry: ReflogEntry): void {
    void this.store.createBranch(`reflog/${entry.shortSha}`, entry.sha);
  }
}
