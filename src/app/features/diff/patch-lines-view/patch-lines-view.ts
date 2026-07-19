import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import { AppStore } from '../../../core/app.store';
import {
  buildPartialPatch,
  buildSideBySideRows,
  parseUnifiedDiff,
  selectableIndexesForHunk,
  type ParsedDiff,
  type SideBySideRow,
} from '../../../core/patch-ops';

export type PatchLinesMode = 'unstaged' | 'staged' | 'revert' | 'readonly';
export type PatchLinesLayout = 'unified' | 'sideBySide';

@Component({
  selector: 'app-patch-lines-view',
  imports: [CdkConnectedOverlay],
  templateUrl: './patch-lines-view.html',
  styleUrl: './patch-lines-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PatchLinesView {
  private readonly store = inject(AppStore);

  readonly patch = input.required<string>();
  readonly mode = input<PatchLinesMode>('readonly');
  readonly layout = input<PatchLinesLayout>('unified');
  readonly emptyMessage = input('No diff to show.');
  readonly showToolbar = input(true);
  readonly captureKeys = input(true);

  readonly applied = output<PatchLinesMode>();

  readonly selectedLines = signal<Set<number>>(new Set());
  readonly patchBusy = signal(false);
  readonly lineMenu = signal<{ open: boolean; x: number; y: number }>({
    open: false,
    x: 0,
    y: 0,
  });
  private lastClickedLine: number | null = null;
  private focused = false;

  readonly lineMenuOrigin = computed(() => ({
    x: this.lineMenu().x,
    y: this.lineMenu().y,
  }));

  readonly lineMenuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
  ];

  readonly parsedDiff = computed((): ParsedDiff | null => {
    const raw = this.patch();
    if (!raw || raw.startsWith('No textual') || raw.startsWith('Could not')) return null;
    return parseUnifiedDiff(raw);
  });

  readonly selectedCount = computed(() => this.selectedLines().size);
  readonly interactive = computed(() => this.mode() !== 'readonly');
  readonly canStage = computed(() => this.mode() === 'unstaged');
  readonly canUnstage = computed(() => this.mode() === 'staged');
  readonly canReset = computed(() => this.mode() === 'unstaged' || this.mode() === 'revert');
  readonly sideBySide = computed(() => this.layout() === 'sideBySide');
  readonly sideBySideRows = computed((): SideBySideRow[] => {
    const parsed = this.parsedDiff();
    if (!parsed || !this.sideBySide()) return [];
    return buildSideBySideRows(parsed);
  });

  private dragSelecting = false;
  private dragAdditive = false;
  private dragAnchor: number | null = null;
  private dragBaseSelection = new Set<number>();
  private skipClickSelection = false;

  constructor() {
    effect(() => {
      this.patch();
      this.mode();
      this.clearLineSelection();
    });
  }

  onFocus(): void {
    this.focused = true;
  }

  onBlur(event: FocusEvent): void {
    const next = event.relatedTarget as Node | null;
    const host = event.currentTarget as HTMLElement;
    if (next && host.contains(next)) return;
    this.focused = false;
  }

  isLineSelected(index: number): boolean {
    return this.selectedLines().has(index);
  }

  onDiffLineMouseDown(index: number, event: MouseEvent): void {
    if (!this.interactive() || event.button !== 0) return;
    const parsed = this.parsedDiff();
    const line = parsed?.lines[index];
    if (!line?.selectable) return;

    event.preventDefault();
    this.focused = true;
    this.dragSelecting = true;
    this.skipClickSelection = true;
    this.dragAdditive = event.metaKey || event.ctrlKey;
    this.dragAnchor = index;
    this.dragBaseSelection = this.dragAdditive
      ? new Set(this.selectedLines())
      : new Set();

    const anchor = this.lastClickedLine;
    if (event.shiftKey && anchor !== null) {
      this.applyDragRange(anchor, index);
    } else if (this.dragAdditive) {
      const next = new Set(this.dragBaseSelection);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      this.selectedLines.set(next);
      this.dragBaseSelection = new Set(next);
    } else {
      this.selectedLines.set(new Set([index]));
    }
    this.lastClickedLine = index;
  }

  onDiffLineMouseEnter(index: number): void {
    if (!this.dragSelecting || this.dragAnchor === null) return;
    const parsed = this.parsedDiff();
    if (!parsed?.lines[index]?.selectable) return;
    this.applyDragRange(this.dragAnchor, index);
    this.lastClickedLine = index;
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    this.dragSelecting = false;
    this.dragAnchor = null;
    this.dragAdditive = false;
    this.dragBaseSelection = new Set();
  }

  onDiffLineClick(index: number, event: MouseEvent): void {
    if (!this.interactive()) return;
    event.preventDefault();
    if (this.skipClickSelection) {
      this.skipClickSelection = false;
      return;
    }

    const parsed = this.parsedDiff();
    const line = parsed?.lines[index];
    if (!line?.selectable) return;

    const next = new Set(this.selectedLines());
    if (event.shiftKey && this.lastClickedLine !== null) {
      this.dragBaseSelection = event.metaKey || event.ctrlKey ? new Set(next) : new Set();
      this.applyDragRange(this.lastClickedLine, index);
    } else if (event.metaKey || event.ctrlKey) {
      if (next.has(index)) next.delete(index);
      else next.add(index);
      this.selectedLines.set(next);
      this.lastClickedLine = index;
    } else {
      this.selectedLines.set(new Set([index]));
      this.lastClickedLine = index;
    }
  }

  onDiffLineContextMenu(index: number, event: MouseEvent): void {
    if (!this.interactive()) return;
    const parsed = this.parsedDiff();
    const line = parsed?.lines[index];
    if (!line?.selectable) return;

    event.preventDefault();
    event.stopPropagation();
    this.focused = true;

    const current = this.selectedLines();
    if (!current.has(index)) {
      this.selectedLines.set(new Set([index]));
      this.lastClickedLine = index;
    }

    this.openLineMenu(event.clientX, event.clientY);
  }

  onPatchContextMenu(event: MouseEvent): void {
    if (!this.interactive()) return;
    if (this.selectedCount() === 0) return;

    event.preventDefault();
    event.stopPropagation();
    this.focused = true;
    this.openLineMenu(event.clientX, event.clientY);
  }

  private openLineMenu(x: number, y: number): void {
    this.lineMenu.set({ open: true, x, y });
  }

  private applyDragRange(from: number, to: number): void {
    const parsed = this.parsedDiff();
    if (!parsed) return;
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    const next = new Set(this.dragBaseSelection);
    for (let i = start; i <= end; i++) {
      if (parsed.lines[i]?.selectable) next.add(i);
    }
    this.selectedLines.set(next);
  }

  closeLineMenu(): void {
    if (this.lineMenu().open) {
      this.lineMenu.update((m) => ({ ...m, open: false }));
    }
  }

  clearLineSelection(): void {
    this.selectedLines.set(new Set());
    this.lastClickedLine = null;
    this.dragSelecting = false;
    this.dragAnchor = null;
    this.dragBaseSelection = new Set();
    this.skipClickSelection = false;
    this.closeLineMenu();
  }

  async applySelection(mode: 'stage' | 'unstage' | 'discard'): Promise<void> {
    await this.applyIndexes([...this.selectedLines()], mode);
  }

  async runLineMenuAction(mode: 'stage' | 'unstage' | 'discard'): Promise<void> {
    this.closeLineMenu();
    await this.applySelection(mode);
  }

  async stageHunk(hunkId: string): Promise<void> {
    const parsed = this.parsedDiff();
    if (!parsed) return;
    await this.applyIndexes(selectableIndexesForHunk(parsed, hunkId), 'stage');
  }

  async unstageHunk(hunkId: string): Promise<void> {
    const parsed = this.parsedDiff();
    if (!parsed) return;
    await this.applyIndexes(selectableIndexesForHunk(parsed, hunkId), 'unstage');
  }

  async discardHunk(hunkId: string): Promise<void> {
    const parsed = this.parsedDiff();
    if (!parsed) return;
    await this.applyIndexes(selectableIndexesForHunk(parsed, hunkId), 'discard');
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.captureKeys() || !this.interactive() || !this.focused) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;
    if (typing) return;

    const key = event.key.toLowerCase();
    if (key === 'escape' && this.selectedCount() > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.clearLineSelection();
      return;
    }
    if (key === 's' && this.canStage() && this.selectedCount() > 0) {
      event.preventDefault();
      event.stopPropagation();
      void this.applySelection('stage');
      return;
    }
    if (key === 'u' && this.canUnstage() && this.selectedCount() > 0) {
      event.preventDefault();
      event.stopPropagation();
      void this.applySelection('unstage');
      return;
    }
    if (key === 'r' && this.canReset() && this.selectedCount() > 0) {
      event.preventDefault();
      event.stopPropagation();
      void this.applySelection('discard');
    }
  }

  private async applyIndexes(
    indexes: number[],
    mode: 'stage' | 'unstage' | 'discard',
  ): Promise<void> {
    const parsed = this.parsedDiff();
    if (!parsed || !indexes.length || this.patchBusy()) return;

    const viewMode = this.mode();
    if (mode === 'stage' && viewMode !== 'unstaged') return;
    if (mode === 'unstage' && viewMode !== 'staged') return;
    if (mode === 'discard' && viewMode !== 'unstaged' && viewMode !== 'revert') {
      this.store.showWarning('Unstage first, or reset from the unstaged diff');
      return;
    }

    const patch = buildPartialPatch(parsed, new Set(indexes));
    if (!patch) {
      this.store.showWarning('Select added or removed lines first');
      return;
    }

    this.patchBusy.set(true);
    try {
      const ok = await this.store.applyPatch(patch, mode);
      if (ok) {
        this.clearLineSelection();
        this.applied.emit(viewMode);
      }
    } finally {
      this.patchBusy.set(false);
    }
  }
}
