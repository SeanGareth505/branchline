import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { BlameLine } from '../../../core/models';

@Component({
  selector: 'app-blame-view',
  imports: [FormsModule],
  templateUrl: './blame-view.html',
  styleUrl: './blame-view.scss',
})
export class BlameView {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  readonly lines = signal<BlameLine[]>([]);
  readonly loading = signal(false);
  readonly mineOnly = signal(false);

  readonly visibleLines = computed(() => {
    const all = this.lines();
    if (!this.mineOnly()) return all;
    return all.filter((line) => this.store.isMine(line.author, line.email));
  });

  readonly mineCount = computed(
    () => this.lines().filter((line) => this.store.isMine(line.author, line.email)).length,
  );

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path;
      const file = this.store.selectedDiffPath();
      const tab = this.store.browseTab();
      if (tab !== 'blame' || !path || !file) {
        if (tab === 'blame' && !file) this.lines.set([]);
        return;
      }
      void this.load(path, file);
    });
  }

  private async load(path: string, file: string): Promise<void> {
    this.loading.set(true);
    try {
      this.lines.set(await this.tauri.getFileBlame(path, file));
    } catch {
      this.lines.set([]);
    } finally {
      this.loading.set(false);
    }
  }

  get displayPath(): string {
    return this.store.selectedDiffPath() ?? 'Select a file from Diff or File tree';
  }

  openCommit(sha: string): void {
    if (!sha.trim()) return;
    this.store.selectCommit(sha);
    this.store.setBrowseTab('diff');
  }
}
