import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { ReflogEntry } from '../../../core/models';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';

@Component({
  selector: 'app-reflog-panel',
  imports: [HelpTip, LoadingBlock],
  templateUrl: './reflog-panel.html',
  styleUrl: './reflog-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReflogPanel {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  readonly entries = signal<ReflogEntry[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  private loadToken = 0;

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path;
      const tab = this.store.browseTab();
      if (tab !== 'reflog' || !path) {
        if (tab === 'reflog') {
          this.entries.set([]);
          this.error.set(null);
        }
        return;
      }
      void this.load(path);
      void this.store.loadDanglingCommits();
    });
  }

  private async load(path: string): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set(null);
    try {
      const entries = await this.tauri.listReflog(path, 100);
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
    if (!path) return;
    void this.load(path);
    void this.store.loadDanglingCommits();
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

  selectDangling(entry: { sha: string }): void {
    this.store.selectCommit(entry.sha);
    this.store.setBrowseTab('diff');
  }

  recover(entry: { sha: string; shortSha: string }): void {
    void this.store.createBranch(`recover/${entry.shortSha}`, entry.sha);
  }
}
