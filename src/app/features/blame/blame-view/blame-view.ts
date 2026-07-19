import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { BlameLine } from '../../../core/models';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';

@Component({
  selector: 'app-blame-view',
  imports: [FormsModule, LoadingBlock],
  templateUrl: './blame-view.html',
  styleUrl: './blame-view.scss',
})
export class BlameView {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  readonly lines = signal<BlameLine[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly mineOnly = signal(false);
  private ensureToken = 0;
  private loadToken = 0;

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
      const sha = this.store.selectedSha();
      const compare = this.store.compareSha();
      const source = this.store.diffSource();
      if (tab !== 'blame' || !path) {
        return;
      }
      if (!file) {
        void this.ensureFileSelection(path, sha, compare, source);
        return;
      }
      const blameAt = source === 'commit' ? sha : null;
      void this.load(path, file, blameAt);
    });
  }

  fileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }

  retry(): void {
    const path = this.store.currentRepo()?.path;
    const file = this.store.selectedDiffPath();
    if (!path || !file) return;
    const blameAt = this.store.diffSource() === 'commit' ? this.store.selectedSha() : null;
    void this.load(path, file, blameAt);
  }

  private async ensureFileSelection(
    path: string,
    sha: string | null,
    compare: string | null,
    source: 'commit' | 'workingDirectory' | 'staged',
  ): Promise<void> {
    const token = ++this.ensureToken;
    this.loading.set(true);
    this.error.set(null);
    this.lines.set([]);
    try {
      const first = await this.firstChangedFile(path, sha, compare, source);
      if (token !== this.ensureToken) return;
      if (this.store.browseTab() !== 'blame') return;
      if (this.store.selectedDiffPath()) return;
      if (first) {
        this.store.selectedDiffPath.set(first);
      } else {
        this.loading.set(false);
      }
    } catch {
      if (token !== this.ensureToken) return;
      this.loading.set(false);
      this.lines.set([]);
    }
  }

  private async firstChangedFile(
    path: string,
    sha: string | null,
    compare: string | null,
    source: 'commit' | 'workingDirectory' | 'staged',
  ): Promise<string | null> {
    const opts: {
      staged?: boolean;
      commit?: string;
      compareFrom?: string;
      compareTo?: string;
    } = {};
    if (source === 'workingDirectory') {
      opts.staged = false;
    } else if (source === 'staged') {
      opts.staged = true;
    } else if (compare && sha) {
      opts.compareFrom = compare;
      opts.compareTo = sha;
    } else if (sha) {
      opts.commit = sha;
    } else {
      opts.staged = false;
    }
    const diff = await this.tauri.getDiff(path, opts);
    return diff.files?.[0]?.path ?? null;
  }

  private async load(path: string, file: string, commit: string | null): Promise<void> {
    const token = ++this.loadToken;
    this.loading.set(true);
    this.error.set(null);
    try {
      const lines = await this.tauri.getFileBlame(path, file, commit);
      if (token !== this.loadToken) return;
      this.lines.set(lines);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.lines.set([]);
      this.error.set(err instanceof Error ? err.message : 'Blame failed for this file');
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  openCommit(sha: string): void {
    if (!sha.trim()) return;
    this.store.selectCommit(sha);
    this.store.setBrowseTab('diff');
  }
}
