import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import {
  CdkVirtualScrollViewport,
  CdkFixedSizeVirtualScroll,
  CdkVirtualForOf,
} from '@angular/cdk/scrolling';
import { AngularSplitModule, type SplitGutterInteractionEvent } from 'angular-split';
import { DomSanitizer, type SafeUrl } from '@angular/platform-browser';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { BlobPreview } from '../../../core/models';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';
import { PatchLinesView, type PatchLinesMode } from '../patch-lines-view/patch-lines-view';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

@Component({
  selector: 'app-diff-viewer',
  imports: [
    AngularSplitModule,
    PatchLinesView,
    CdkConnectedOverlay,
    LoadingBlock,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
  ],
  templateUrl: './diff-viewer.html',
  styleUrl: './diff-viewer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffViewer {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);
  private readonly sanitizer = inject(DomSanitizer);

  readonly sideBySide = signal(false);
  readonly preferPatch = signal(false);
  readonly imagePreview = signal<{
    before?: SafeUrl;
    after?: SafeUrl;
    single?: SafeUrl;
  } | null>(null);
  readonly patch = signal('');
  readonly files = signal<
    { path: string; status: string; additions?: number | null; deletions?: number | null }[]
  >([]);
  readonly loading = signal(false);
  readonly splitSizes = signal<[number, number]>([28, 72]);
  readonly fileRowHeight = 34;
  readonly fileMenu = signal<{ open: boolean; x: number; y: number; path: string }>({
    open: false,
    x: 0,
    y: 0,
    path: '',
  });
  private suppressMenuCloseUntil = 0;
  private loadToken = 0;
  private lastPreviewKey = '';

  readonly menuOrigin = computed(() => ({ x: this.fileMenu().x, y: this.fileMenu().y }));
  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
  ];

  trackFile = (_: number, f: { path: string }) => f.path;

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
      this.store.diffIgnoreWhitespace();
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
        .querySelector<HTMLElement>(`.file-list .file-row[data-path="${CSS.escape(path)}"]`)
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

  restoreFile(path?: string): void {
    this.closeFileMenu();
    const file = path ?? this.store.selectedDiffPath();
    const sha = this.store.selectedSha();
    if (!file || !sha) return;
    void this.store.restoreFileFromRevision(file, sha);
  }

  showPatchView(): void {
    this.preferPatch.set(true);
  }

  showImageView(): void {
    this.preferPatch.set(false);
  }

  isImagePath(path: string | null | undefined): boolean {
    return !!path && IMAGE_EXT.test(path);
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

  statusTitle(status: string): string {
    const code = status.trim().charAt(0).toUpperCase();
    switch (code) {
      case 'A':
        return 'Added';
      case 'D':
        return 'Deleted';
      case 'R':
        return 'Renamed';
      case 'C':
        return 'Copied';
      case 'U':
        return 'Unmerged';
      case '?':
        return 'Untracked';
      default:
        return 'Modified';
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
    const token = ++this.loadToken;
    const ignoreWhitespace = this.store.diffIgnoreWhitespace();
    const previewKey = `${source}:${sha ?? ''}:${compare ?? ''}:${file ?? ''}`;
    if (previewKey !== this.lastPreviewKey) {
      this.lastPreviewKey = previewKey;
      this.preferPatch.set(false);
    }
    const baseOpts: {
      pathspec?: string;
      staged?: boolean;
      commit?: string;
      compareFrom?: string;
      compareTo?: string;
      ignoreWhitespace?: boolean;
    } = { ignoreWhitespace };

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
      if (token !== this.loadToken) return;
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
        this.imagePreview.set(null);
        this.preferPatch.set(false);
        return;
      }

      const diff = await this.tauri.getDiff(path, { ...baseOpts, pathspec: selected });
      if (token !== this.loadToken) return;
      this.patch.set(diff.unified || '');

      if (this.isImagePath(selected) && !this.isMissingWorkingTreeFile(selected, source, nextFiles)) {
        const preview = await this.loadImagePreview(path, selected, sha, compare, source);
        if (token !== this.loadToken) return;
        this.imagePreview.set(preview);
      } else {
        this.imagePreview.set(null);
        this.preferPatch.set(false);
      }
    } catch (err) {
      if (token !== this.loadToken) return;
      this.patch.set(this.store.formatError(err) || 'Could not load diff.');
      this.files.set([]);
      this.imagePreview.set(null);
    } finally {
      if (token === this.loadToken) this.loading.set(false);
    }
  }

  private isMissingWorkingTreeFile(
    file: string,
    source: 'commit' | 'workingDirectory' | 'staged',
    files: { path: string; status: string }[],
  ): boolean {
    if (source === 'commit') return false;
    const entry = files.find((f) => f.path === file);
    if (!entry) return true;
    return entry.status.trim().charAt(0).toUpperCase() === 'D';
  }

  private async loadImagePreview(
    repo: string,
    file: string,
    sha: string | null,
    compare: string | null,
    source: 'commit' | 'workingDirectory' | 'staged',
  ): Promise<{ before?: SafeUrl; after?: SafeUrl; single?: SafeUrl } | null> {
    const fetchUrl = async (revision: string | null) => {
      try {
        const blob = await this.tauri.getBlobPreview(repo, { file, revision });
        return blobToSafeUrl(blob, this.sanitizer);
      } catch {
        return null;
      }
    };

    if (source === 'commit' && sha && compare) {
      const [before, after] = await Promise.all([fetchUrl(compare), fetchUrl(sha)]);
      if (before && after) return { before, after };
      if (after) return { single: after };
      if (before) return { single: before };
      return null;
    }

    if (source === 'commit' && sha) {
      const parent = this.store.selectedCommit()?.parents[0] ?? null;
      const [before, after] = await Promise.all([
        parent ? fetchUrl(parent) : Promise.resolve(null),
        fetchUrl(sha),
      ]);
      if (before && after) return { before, after };
      if (after) return { single: after };
      if (before) return { single: before };
      return null;
    }

    const current = await fetchUrl(source === 'staged' ? 'HEAD' : null);
    return current ? { single: current } : null;
  }
}

function blobToSafeUrl(blob: BlobPreview | null | undefined, sanitizer: DomSanitizer): SafeUrl | null {
  if (!blob || blob.kind !== 'image' || !blob.base64) return null;
  const mime = blob.mime || 'image/png';
  return sanitizer.bypassSecurityTrustUrl(`data:${mime};base64,${blob.base64}`);
}
