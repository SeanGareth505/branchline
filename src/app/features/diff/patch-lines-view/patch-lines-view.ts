import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnDestroy,
  TemplateRef,
  ViewContainerRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Overlay, type OverlayRef, type ConnectedPosition } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
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
  templateUrl: './patch-lines-view.html',
  styleUrl: './patch-lines-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PatchLinesView implements OnDestroy {
  private readonly store = inject(AppStore);
  private readonly overlay = inject(Overlay);
  private readonly vcr = inject(ViewContainerRef);
  private readonly menuTpl = viewChild.required<TemplateRef<unknown>>('lineMenuTpl');
  private overlayRef: OverlayRef | null = null;

  private readonly isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

  readonly patch = input.required<string>();
  readonly mode = input<PatchLinesMode>('readonly');
  readonly layout = input<PatchLinesLayout>('unified');
  readonly emptyMessage = input('No diff to show.');
  readonly showToolbar = input(true);
  readonly captureKeys = input(true);

  readonly applied = output<PatchLinesMode>();

  readonly selectedLines = signal<Set<number>>(new Set());
  readonly patchBusy = signal(false);
  readonly menuOpen = signal(false);
  private lastClickedLine: number | null = null;
  private focused = false;
  private suppressMenuCloseUntil = 0;

  private readonly menuPositions: ConnectedPosition[] = [
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
  private selectionSnapshot = new Set<number>();
  private secondaryGesture = false;

  constructor() {
    effect(() => {
      this.patch();
      this.mode();
      this.clearLineSelection();
    });
  }

  ngOnDestroy(): void {
    this.closeLineMenu();
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
    if (!this.interactive()) return;

    this.selectionSnapshot = new Set(this.selectedLines());
    this.secondaryGesture = this.isSecondaryMouseDown(event);

    // Mac two-finger click: mousedown(button=2) → contextmenu → mouseup.
    if (this.secondaryGesture) return;
    if (event.button !== 0) return;

    const parsed = this.parsedDiff();
    const line = parsed?.lines[index];
    if (!line?.selectable) return;

    this.focused = true;
    this.beginLeftSelection(
      index,
      event.shiftKey,
      event.metaKey || (!this.isMac && event.ctrlKey),
      this.lastClickedLine,
    );
  }

  onDiffLineMouseEnter(index: number): void {
    if (this.secondaryGesture || !this.dragSelecting || this.dragAnchor === null) return;
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

    if (this.secondaryGesture || this.isMacContextClick(event) || this.menuOpen()) {
      this.secondaryGesture = false;
      return;
    }
    if (this.skipClickSelection) {
      this.skipClickSelection = false;
      return;
    }

    const parsed = this.parsedDiff();
    const line = parsed?.lines[index];
    if (!line?.selectable) return;

    const next = new Set(this.selectedLines());
    const additive = event.metaKey || (!this.isMac && event.ctrlKey);
    if (event.shiftKey && this.lastClickedLine !== null) {
      this.dragBaseSelection = additive ? new Set(next) : new Set();
      this.applyDragRange(this.lastClickedLine, index);
    } else if (additive) {
      if (next.has(index)) next.delete(index);
      else next.add(index);
      this.replaceSelection(next);
      this.lastClickedLine = index;
    } else {
      this.replaceSelection(new Set([index]));
      this.lastClickedLine = index;
    }
  }

  onDiffLineContextMenu(index: number, event: MouseEvent): void {
    if (!this.interactive()) return;

    event.preventDefault();
    event.stopPropagation();
    this.secondaryGesture = true;
    this.focused = true;
    this.skipClickSelection = true;
    this.dragSelecting = false;
    this.dragAnchor = null;

    if (this.selectionSnapshot.size === 0) {
      this.selectionSnapshot = new Set(this.selectedLines());
    }

    const parsed = this.parsedDiff();
    const line = parsed?.lines[index];
    if (line?.selectable) {
      if (this.selectionSnapshot.has(index)) {
        this.replaceSelection(new Set(this.selectionSnapshot));
      } else {
        this.replaceSelection(new Set([index]));
        this.lastClickedLine = index;
      }
    } else if (this.selectionSnapshot.size > 0) {
      this.replaceSelection(new Set(this.selectionSnapshot));
    } else if (this.selectedCount() === 0) {
      return;
    }

    if (this.selectedCount() === 0) return;
    this.openLineMenu(event.clientX, event.clientY);
  }

  onPatchContextMenu(event: MouseEvent): void {
    if (!this.interactive()) return;

    this.dragSelecting = false;
    this.secondaryGesture = true;

    if (this.selectionSnapshot.size > 0) {
      this.replaceSelection(new Set(this.selectionSnapshot));
    }
    if (this.selectedCount() === 0) return;

    event.preventDefault();
    event.stopPropagation();
    this.focused = true;
    this.skipClickSelection = true;
    this.openLineMenu(event.clientX, event.clientY);
  }

  private isSecondaryMouseDown(event: MouseEvent): boolean {
    return event.button === 2 || event.buttons === 2 || this.isMacContextClick(event);
  }

  private beginLeftSelection(
    index: number,
    shiftKey: boolean,
    additive: boolean,
    anchor: number | null,
  ): void {
    this.dragSelecting = true;
    this.skipClickSelection = true;
    this.dragAdditive = additive;
    this.dragAnchor = index;
    this.dragBaseSelection = additive ? new Set(this.selectionSnapshot) : new Set();

    if (shiftKey && anchor !== null) {
      this.applyDragRange(anchor, index);
    } else if (additive) {
      const next = new Set(this.dragBaseSelection);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      this.replaceSelection(next);
      this.dragBaseSelection = new Set(next);
    } else {
      this.replaceSelection(new Set([index]));
    }
    this.lastClickedLine = index;
  }

  private openLineMenu(x: number, y: number): void {
    this.closeLineMenu();
    this.suppressMenuCloseUntil = performance.now() + 500;

    const positionStrategy = this.overlay
      .position()
      .flexibleConnectedTo({ x, y })
      .withFlexibleDimensions(false)
      .withPush(true)
      .withPositions(this.menuPositions);

    this.overlayRef = this.overlay.create({
      positionStrategy,
      scrollStrategy: this.overlay.scrollStrategies.close(),
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
      panelClass: 'patch-line-menu-panel',
    });

    this.overlayRef.attach(new TemplatePortal(this.menuTpl(), this.vcr));
    this.menuOpen.set(true);

    this.overlayRef.backdropClick().subscribe(() => this.tryCloseLineMenu());
    this.overlayRef.outsidePointerEvents().subscribe(() => this.tryCloseLineMenu());
  }

  private tryCloseLineMenu(): void {
    if (performance.now() < this.suppressMenuCloseUntil) return;
    this.closeLineMenu();
  }

  private replaceSelection(next: Set<number>): void {
    const cur = this.selectedLines();
    if (cur.size === next.size) {
      let same = true;
      for (const i of next) {
        if (!cur.has(i)) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.selectedLines.set(next);
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
    this.replaceSelection(next);
  }

  closeLineMenu(): void {
    this.menuOpen.set(false);
    if (this.overlayRef) {
      this.overlayRef.dispose();
      this.overlayRef = null;
    }
  }

  clearLineSelection(): void {
    this.selectedLines.set(new Set());
    this.lastClickedLine = null;
    this.dragSelecting = false;
    this.dragAnchor = null;
    this.dragBaseSelection = new Set();
    this.skipClickSelection = false;
    this.secondaryGesture = false;
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
    if (!this.captureKeys() || !this.interactive()) return;
    if (!this.focused && !this.menuOpen()) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;
    if (typing) return;

    const key = event.key.toLowerCase();
    if (key === 'escape') {
      if (this.menuOpen()) {
        event.preventDefault();
        event.stopPropagation();
        this.closeLineMenu();
        return;
      }
      if (this.selectedCount() > 0) {
        event.preventDefault();
        event.stopPropagation();
        this.clearLineSelection();
      }
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

  private isMacContextClick(event: MouseEvent): boolean {
    return this.isMac && event.ctrlKey && !event.metaKey;
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
