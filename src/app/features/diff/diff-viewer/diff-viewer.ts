import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import { AngularSplitModule, type SplitGutterInteractionEvent } from 'angular-split';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';
import { PatchLinesView, type PatchLinesMode } from '../patch-lines-view/patch-lines-view';

@Component({
  selector: 'app-diff-viewer',
  imports: [AngularSplitModule, PatchLinesView, CdkConnectedOverlay, LoadingBlock],
  templateUrl: './diff-viewer.html',
  styleUrl: './diff-viewer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffViewer {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly sideBySide = signal(false);
  readonly patch = signal('');
  readonly files = signal<
    { path: string; status: string; additions?: number | null; deletions?: number | null }[]
  >([]);
  readonly loading = signal(false);
  readonly splitSizes = signal<[number, number]>([28, 72]);
  readonly fileMenu = signal<{ open: boolean; x: number; y: number; path: string }>({
    open: false,
    x: 0,
    y: 0,
    path: '',
  });
  private suppressMenuCloseUntil = 0;

  readonly menuOrigin = computed(() => ({ x: this.fileMenu().x, y: this.fileMenu().y }));
  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
  ];

  readonly linesMode = computed((): PatchLinesMode => {
    const source = this.store.diffSource();
    if (source === 'workingDirectory') return 'unstaged';
    if (source === 'staged') return 'staged';
    return 'cherryPick';
  });

  readonly canCherryPickFiles = computed(
    () => this.store.diffSource() === 'commit' && !!this.store.selectedSha(),
  );

  readonly canCherryPickFile = computed(
    () => this.canCherryPickFiles() && !!this.store.selectedDiffPath(),
  );

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
      if (source === 'workingDirectory' || source === 'staged') {
        this.store.changeCount();
      }
      if (!path || tab !== 'diff') return;
      void this.load(path, sha, compare, file, source);
    });
  }

  toggleSideBySide(): void {
    this.sideBySide.update((v) => !v);
  }

  openDiffTool(): void {
    void this.store.openDiffToolForPaths();
  }

  selectFile(path: string): void {
    this.closeFileMenu();
    this.store.selectedDiffPath.set(path);
  }

  onFileListKey(event: KeyboardEvent): void {
    const list = this.files();
    if (!list.length) return;
    const current = this.store.selectedDiffPath();
    const idx = list.findIndex((f) => f.path === current);
    let next = idx;

    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      next = Math.min(list.length - 1, Math.max(0, idx) + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      next = Math.max(0, (idx < 0 ? 0 : idx) - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      next = 0;
    } else if (event.key === 'End') {
      event.preventDefault();
      next = list.length - 1;
    } else {
      return;
    }

    const path = list[next]?.path;
    if (!path) return;
    this.selectFile(path);
    queueMicrotask(() => {
      document
        .querySelector<HTMLElement>(`.file-list li[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }

  formatStat(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '·';
    return String(value);
  }

  onFileContextMenu(path: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.selectedDiffPath.set(path);
    if (!this.canCherryPickFiles()) return;
    this.suppressMenuCloseUntil = performance.now() + 400;
    this.fileMenu.set({ open: true, x: event.clientX, y: event.clientY, path });
  }

  onFileMenuDismiss(event?: Event): void {
    if (event && performance.now() < this.suppressMenuCloseUntil) {
      event.preventDefault?.();
      event.stopPropagation?.();
      return;
    }
    this.closeFileMenu();
  }

  closeFileMenu(): void {
    if (!this.fileMenu().open) return;
    this.fileMenu.update((m) => ({ ...m, open: false }));
  }

  async cherryPickFile(
    target: 'worktree' | 'index' | 'both',
    path?: string,
  ): Promise<void> {
    this.closeFileMenu();
    const file = path ?? this.store.selectedDiffPath();
    if (!file) return;
    await this.store.cherryPickPathsFromCommit([file], target);
  }

  async cherryPickAllFiles(target: 'worktree' | 'index' | 'both'): Promise<void> {
    this.closeFileMenu();
    const paths = this.files().map((f) => f.path);
    if (!paths.length) return;
    await this.store.cherryPickPathsFromCommit(paths, target);
  }

  onSplitDragEnd(event: SplitGutterInteractionEvent): void {
    const nums = event.sizes.filter((s): s is number => typeof s === 'number');
    if (nums.length >= 2) this.splitSizes.set([nums[0], nums[1]]);
  }

  fileName(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
  }

  fileDir(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    return slash >= 0 ? normalized.slice(0, slash) : '';
  }

  statusGlyph(status: string): string {
    const code = status.trim().charAt(0).toUpperCase();
    switch (code) {
      case 'A':
        return 'A';
      case 'D':
        return 'D';
      case 'R':
      case 'C':
        return 'R';
      case 'U':
        return 'U';
      case '?':
        return '?';
      default:
        return 'M';
    }
  }

  statusClass(status: string): string {
    const code = status.trim().charAt(0).toUpperCase();
    switch (code) {
      case 'A':
      case '?':
        return 'st-added';
      case 'D':
        return 'st-deleted';
      case 'R':
      case 'C':
        return 'st-renamed';
      case 'U':
        return 'st-conflict';
      default:
        return 'st-modified';
    }
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
    const baseOpts: {
      pathspec?: string;
      staged?: boolean;
      commit?: string;
      compareFrom?: string;
      compareTo?: string;
    } = {};

    if (source === 'workingDirectory') {
      baseOpts.staged = false;
    } else if (source === 'staged') {
      baseOpts.staged = true;
    } else if (compare && sha) {
      baseOpts.compareFrom = compare;
      baseOpts.compareTo = sha;
    } else if (sha) {
      baseOpts.commit = sha;
    } else {
      baseOpts.staged = false;
    }

    this.loading.set(true);
    try {
      const listing = await this.tauri.getDiff(path, baseOpts);
      const nextFiles = listing.files || [];
      this.files.set(nextFiles);

      const selected =
        file && nextFiles.some((entry) => entry.path === file)
          ? file
          : (nextFiles[0]?.path ?? null);

      if (selected && selected !== file) {
        this.store.selectedDiffPath.set(selected);
        return;
      }

      if (!selected) {
        this.patch.set('');
        return;
      }

      const diff = await this.tauri.getDiff(path, { ...baseOpts, pathspec: selected });
      this.patch.set(diff.unified || '');
    } catch {
      this.patch.set('Could not load diff.');
      this.files.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
