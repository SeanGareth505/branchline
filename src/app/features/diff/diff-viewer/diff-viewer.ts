import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import { PatchLinesView, type PatchLinesMode } from '../patch-lines-view/patch-lines-view';

@Component({
  selector: 'app-diff-viewer',
  imports: [PatchLinesView],
  templateUrl: './diff-viewer.html',
  styleUrl: './diff-viewer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffViewer {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly sideBySide = signal(false);
  readonly patch = signal('');
  readonly files = signal<{ path: string; status: string }[]>([]);
  readonly loading = signal(false);

  readonly linesMode = computed((): PatchLinesMode => {
    const source = this.store.diffSource();
    if (source === 'workingDirectory') return 'unstaged';
    if (source === 'staged') return 'staged';
    return 'revert';
  });

  readonly sourceLabel = computed(() => {
    const source = this.store.diffSource();
    if (source === 'workingDirectory') return 'Unstaged';
    if (source === 'staged') return 'Staged';
    if (this.store.compareSha()) return 'Compare';
    return 'Commit';
  });

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path;
      const sha = this.store.selectedSha();
      const compare = this.store.compareSha();
      const file = this.store.selectedDiffPath();
      const source = this.store.diffSource();
      const tab = this.store.browseTab();
      if (!path || tab !== 'diff') return;
      void this.load(path, sha, compare, file, source);
    });
  }

  toggleSideBySide(): void {
    this.sideBySide.update((v) => !v);
  }

  selectFile(path: string): void {
    this.store.selectedDiffPath.set(path);
  }

  onApplied(): void {
    const repo = this.store.currentRepo()?.path;
    if (!repo) return;
    void this.load(
      repo,
      this.store.selectedSha(),
      this.store.compareSha(),
      this.store.selectedDiffPath(),
      this.store.diffSource(),
    );
  }

  private async load(
    path: string,
    sha: string | null,
    compare: string | null,
    file: string | null,
    source: 'commit' | 'workingDirectory' | 'staged',
  ): Promise<void> {
    const opts: {
      pathspec?: string;
      staged?: boolean;
      commit?: string;
      compareFrom?: string;
      compareTo?: string;
    } = {};
    if (file) opts.pathspec = file;

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

    this.loading.set(true);
    try {
      const diff = await this.tauri.getDiff(path, opts);
      this.patch.set(diff.unified || '');
      this.files.set(diff.files || []);
    } catch {
      this.patch.set('Could not load diff.');
      this.files.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
