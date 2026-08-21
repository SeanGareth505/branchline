import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AngularSplitModule, type SplitGutterInteractionEvent } from 'angular-split';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { AppStore } from '../../../core/app.store';
import type { FileStatusEntry } from '../../../core/models';
import {
  acceptAllChoices,
  alignConflictLines,
  buildConflictResult,
  contentForChoice,
  type AlignedLine,
  type ConflictChoice,
  type ConflictRegion,
  type ContextSlice,
  draftHasConflictMarkers,
  parseConflictMarkers,
  remainingConflictIds,
  reconstructMarkers,
  sliceContext,
} from '../../../core/conflict-parse';
import {
  preferredEditorLabel,
  resolvePreferredEditor,
} from '../../../shared/git/open-in-editor';

type OpenMenu = 'tools' | 'more' | null;
type CollapsePane = 'files' | 'result';

interface ChoiceSnapshot {
  choices: Map<string, ConflictChoice>;
  custom: Map<string, string>;
}

interface TextBlock {
  kind: 'text';
  index: number;
  startLine: number;
  slice: ContextSlice;
}

interface ConflictBlock {
  kind: 'conflict';
  index: number;
  startLine: number;
  conflict: ConflictRegion;
  aligned: NumberedAlignedLine[];
}

interface NumberedAlignedLine extends AlignedLine {
  leftNo: number | null;
  rightNo: number | null;
}

type DocumentBlock = TextBlock | ConflictBlock;

@Component({
  selector: 'app-conflict-resolver-dialog',
  imports: [FormsModule, AngularSplitModule, NgTemplateOutlet, NgIcon, HelpTip],
  templateUrl: './conflict-resolver-dialog.html',
  styleUrl: './conflict-resolver-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConflictResolverDialog {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);

  readonly conflicted = computed(() => this.store.status()?.conflicted ?? []);
  readonly sides = computed(() => this.store.conflictResolver());
  readonly currentFile = computed(() => {
    const path = this.store.conflictResolverPath();
    return this.conflicted().find((f) => f.path === path) ?? null;
  });

  readonly choices = signal<Map<string, ConflictChoice>>(new Map());
  readonly custom = signal<Map<string, string>>(new Map());
  readonly activeConflictId = signal<string | null>(null);
  readonly showBase = signal(false);
  readonly resultMode = signal<'guided' | 'edit'>('edit');
  readonly manualResultEdit = signal(false);
  readonly openMenu = signal<OpenMenu>(null);
  readonly hunkMoreId = signal<string | null>(null);
  readonly saving = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly editDraft = signal('');
  readonly expandedContext = signal<Set<number>>(new Set());
  readonly closing = signal(false);
  readonly choiceHistory = signal<ChoiceSnapshot[]>([]);
  readonly narrowLayout = signal(globalThis.innerWidth <= 900);
  readonly horizontalSplitDirection = computed<'horizontal' | 'vertical'>(() =>
    this.narrowLayout() ? 'vertical' : 'horizontal',
  );
  readonly workspaceSplitSizes = signal<[number, number]>([16, 84]);
  readonly twoSourceSizes = signal<[number, number]>([50, 50]);
  readonly threeSourceSizes = signal<[number, number, number]>([34, 33, 33]);
  readonly resultSplitSizes = signal<[number, number]>([72, 28]);
  readonly filesCollapsed = signal(false);
  readonly fileTreeExpanded = signal(true);
  readonly resultCollapsed = signal(false);
  private savedFilePaneSize = 16;
  private savedResultPaneSize = 28;
  private syncedKey = '';

  readonly conflictCards = viewChildren<ElementRef<HTMLElement>>('conflictCard');
  readonly resultEditor = viewChild<ElementRef<HTMLTextAreaElement>>('resultEditor');
  readonly sourceDocs = viewChildren<ElementRef<HTMLElement>>('sourceDoc');
  private syncingScroll = false;

  readonly gutterOrientation = computed<'horizontal' | 'vertical'>(() =>
    this.horizontalSplitDirection() === 'horizontal' ? 'vertical' : 'horizontal',
  );

  readonly showBasePane = computed(() => this.showBase() && !!this.sides()?.hasBase);

  constructor() {
    effect(() => {
      const open = this.store.conflictResolverOpen();
      const path = this.store.conflictResolverPath();
      const sides = this.store.conflictResolver();
      if (!open || !path || !sides) {
        this.syncedKey = '';
        return;
      }
      const w = sides.working;
      const key = `${path}::${w.length}::${w.slice(0, 64)}::${w.slice(-64)}::${sides.hasMarkers}::${sides.unmerged}::${sides.binary}`;
      if (key === this.syncedKey) return;
      this.syncedKey = key;
      this.syncFromSides();
    });
  }

  readonly preferredLabel = computed(() =>
    preferredEditorLabel(this.store.settings().preferredEditor, this.store.detectedEditors()),
  );

  readonly resolvedPreferred = computed(() =>
    resolvePreferredEditor(this.store.settings().preferredEditor, this.store.detectedEditors()),
  );

  readonly hasCursor = computed(() => !!this.store.detectedEditors()?.cursor);
  readonly hasVscode = computed(() => !!this.store.detectedEditors()?.vscode);

  readonly operation = computed(() => this.store.status()?.operation ?? null);
  readonly abortLabel = computed(() => {
    switch (this.operation()?.kind) {
      case 'merge':
        return 'Abort merge';
      case 'rebase':
        return 'Abort rebase';
      case 'cherryPick':
        return 'Abort cherry-pick';
      case 'revert':
        return 'Abort revert';
      default:
        return 'Abort operation';
    }
  });

  readonly yoursLabel = computed(() => {
    const kind = this.operation()?.kind;
    if (kind === 'rebase') return 'Onto (ours)';
    if (kind === 'cherryPick') return 'Current (ours)';
    if (kind === 'revert') return 'Current (ours)';
    return 'Yours';
  });

  readonly incomingLabel = computed(() => {
    const kind = this.operation()?.kind;
    if (kind === 'rebase') return 'Incoming commit';
    if (kind === 'cherryPick') return 'Cherry-picked';
    if (kind === 'revert') return 'Revert changes';
    return 'Incoming';
  });

  readonly parsed = computed(() => {
    const sides = this.sides();
    if (!sides || sides.binary) {
      return parseConflictMarkers('');
    }
    return parseConflictMarkers(sides.working || '');
  });

  readonly conflicts = computed(() => this.parsed().conflicts);

  readonly documentBlocks = computed((): DocumentBlock[] => {
    const parsed = this.parsed();
    const expanded = this.expandedContext();
    let line = 1;
    return parsed.segments.map((segment, index) => {
      if (segment.kind === 'text') {
        const slice = sliceContext(segment.text, expanded.has(index));
        const startLine = line;
        line += slice.total;
        return { kind: 'text', index, startLine, slice };
      }
      const startLine = line;
      line += markerLineCount(segment.conflict);
      return {
        kind: 'conflict',
        index,
        startLine,
        conflict: segment.conflict,
        aligned: numberAlignedLines(alignConflictLines(segment.conflict.ours, segment.conflict.theirs), startLine + 1),
      };
    });
  });

  readonly isDeleteConflict = computed(() => {
    const kind = this.currentFile()?.conflictKind ?? '';
    return kind === 'deletedByUs' || kind === 'deletedByThem' || kind === 'bothDeleted';
  });

  readonly markersClearedUnstaged = computed(() => {
    const file = this.currentFile();
    if (file?.markersCleared) return true;
    const sides = this.sides();
    if (!sides || sides.binary) return false;
    return sides.hasMarkers === false && sides.unmerged !== false;
  });

  readonly remaining = computed(() =>
    remainingConflictIds(this.conflicts(), this.choices(), this.custom()),
  );

  readonly remainingCount = computed(() => this.remaining().length);

  readonly allResolved = computed(() => {
    const list = this.conflicts();
    if (!list.length) return !draftHasConflictMarkers(this.store.conflictResolverDraft());
    return this.remainingCount() === 0;
  });

  readonly fileIndex = computed(() => {
    const path = this.store.conflictResolverPath();
    const idx = this.conflicted().findIndex((f) => f.path === path);
    return idx >= 0 ? idx + 1 : 1;
  });

  readonly fileTotal = computed(() => Math.max(this.conflicted().length, 1));

  readonly progressLabel = computed(() => {
    const conflicts = this.conflicts();
    if (!conflicts.length) {
      return `File ${this.fileIndex()} of ${this.fileTotal()}`;
    }
    const done = conflicts.length - this.remainingCount();
    return `${done}/${conflicts.length} in this file · ${this.fileIndex()}/${this.fileTotal()} files`;
  });

  readonly progressPercent = computed(() => {
    const conflicts = this.conflicts();
    if (!conflicts.length) return this.markersClearedUnstaged() ? 100 : 0;
    return Math.round(((conflicts.length - this.remainingCount()) / conflicts.length) * 100);
  });

  readonly progressValueText = computed(() => {
    const conflicts = this.conflicts();
    if (!conflicts.length) {
      return this.markersClearedUnstaged()
        ? `File ${this.fileIndex()} of ${this.fileTotal()} ready to stage`
        : `File ${this.fileIndex()} of ${this.fileTotal()}`;
    }
    const done = conflicts.length - this.remainingCount();
    return `${done} of ${conflicts.length} hunks resolved in this file`;
  });

  readonly abortTitle = computed(() => `${this.abortLabel()} — cannot be undone`);

  readonly canUndo = computed(() => this.choiceHistory().length > 0);

  readonly identicalConflicts = computed(() =>
    this.conflicts().filter((conflict) => this.sidesIdentical(conflict)),
  );

  readonly remainStatus = computed(() => {
    if (this.manualResultEdit()) {
      return this.canSave()
        ? 'Manual result is ready'
        : 'Remove all conflict markers to continue';
    }
    if (this.remainingCount()) return `${this.remainingCount()} left in this file`;
    return 'All conflicts chosen';
  });

  readonly activeIndex = computed(() => {
    const id = this.activeConflictId();
    const list = this.conflicts();
    if (!list.length) return -1;
    if (!id) return 0;
    const idx = list.findIndex((c) => c.id === id);
    return idx >= 0 ? idx : 0;
  });

  readonly activeConflict = computed(() => this.conflicts()[this.activeIndex()] ?? null);

  readonly canSave = computed(() => {
    const sides = this.sides();
    if (!sides || sides.binary) return false;
    if (this.isDeleteConflict()) return false;
    if (this.resultMode() === 'edit') {
      return !draftHasConflictMarkers(this.store.conflictResolverDraft());
    }
    if (this.conflicts().length) return this.allResolved();
    return !draftHasConflictMarkers(this.store.conflictResolverDraft());
  });

  readonly dirty = computed(
    () => this.choices().size > 0 || this.custom().size > 0 || this.manualResultEdit(),
  );

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.store.conflictResolverOpen() || this.prompts.request()) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'INPUT' ||
      target?.isContentEditable;
    if (event.key === 'Escape') {
      if (this.editingId()) {
        this.cancelHunkEdit();
        event.preventDefault();
        return;
      }
      if (this.openMenu() || this.hunkMoreId()) {
        this.closeMenu();
        event.preventDefault();
        return;
      }
      if (!typing) {
        event.preventDefault();
        void this.requestClose();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      if (this.editingId()) {
        event.preventDefault();
        this.commitHunkEdit();
        return;
      }
      if (this.canSave()) {
        event.preventDefault();
        void this.save();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      if (!typing && this.canUndo()) {
        event.preventDefault();
        this.undoLast();
      }
      return;
    }
    if (typing) return;
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      this.focusConflict(this.activeIndex() + 1);
      return;
    }
    if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.focusConflict(this.activeIndex() - 1);
      return;
    }
    if (event.key === 'n') {
      event.preventDefault();
      this.focusNextUnresolved(1);
      return;
    }
    if (event.key === 'p') {
      event.preventDefault();
      this.focusNextUnresolved(-1);
      return;
    }
    if (event.key === '1') {
      event.preventDefault();
      this.acceptActive('ours');
      return;
    }
    if (event.key === '2') {
      event.preventDefault();
      this.acceptActive('theirs');
      return;
    }
    if (event.key === '3') {
      event.preventDefault();
      this.acceptActive('both');
      return;
    }
    if (event.key === '4') {
      event.preventDefault();
      this.acceptActive('base');
      return;
    }
    if (event.key === 'r') {
      event.preventDefault();
      this.acceptActive('bothReverse');
      return;
    }
    if (event.key === 'e') {
      event.preventDefault();
      this.startHunkEdit(this.conflicts()[this.activeIndex()]?.id ?? null);
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.narrowLayout.set(globalThis.innerWidth <= 900);
  }

  onWorkspaceSplitDragEnd(event: SplitGutterInteractionEvent): void {
    const sizes = splitNumbers(event);
    if (sizes.length < 2) return;
    this.workspaceSplitSizes.set([sizes[0], sizes[1]]);
    this.syncCollapsedFromSize('files', sizes[0]);
  }

  onSourceSplitDragEnd(event: SplitGutterInteractionEvent): void {
    const sizes = splitNumbers(event);
    if (this.showBasePane() && sizes.length >= 3) {
      this.threeSourceSizes.set([sizes[0], sizes[1], sizes[2]]);
      return;
    }
    if (sizes.length >= 2) this.twoSourceSizes.set([sizes[0], sizes[1]]);
  }

  onResultSplitDragEnd(event: SplitGutterInteractionEvent): void {
    const sizes = splitNumbers(event);
    if (sizes.length < 2) return;
    this.resultSplitSizes.set([sizes[0], sizes[1]]);
    this.syncCollapsedFromSize('result', sizes[1]);
  }

  toggleFilesPane(): void {
    this.toggleCollapsedPane('files');
  }

  toggleResultPane(): void {
    this.toggleCollapsedPane('result');
  }

  fileTreeOpen(path: string): boolean {
    return path === this.store.conflictResolverPath() && this.fileTreeExpanded();
  }

  toggleFileTree(path: string, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (path !== this.store.conflictResolverPath()) {
      this.pickFile(path);
      return;
    }
    this.fileTreeExpanded.update((open) => !open);
  }

  sidePaneChevron(collapsed: boolean): string {
    return collapsed ? 'lucideChevronRight' : 'lucideChevronLeft';
  }

  resultPaneChevron(): string {
    return this.resultCollapsed() ? 'lucideChevronUp' : 'lucideChevronDown';
  }

  syncFromSides(): void {
    const sides = this.sides();
    this.choices.set(new Map());
    this.custom.set(new Map());
    this.choiceHistory.set([]);
    this.hunkMoreId.set(null);
    this.resultMode.set('edit');
    this.manualResultEdit.set(false);
    this.openMenu.set(null);
    this.showBase.set(false);
    this.editingId.set(null);
    this.editDraft.set('');
    this.expandedContext.set(new Set());
    const parsed = this.parsed();
    if (parsed.conflicts.length) {
      this.activeConflictId.set(parsed.conflicts[0]?.id ?? null);
      this.rebuildDraft();
    } else {
      this.activeConflictId.set(null);
    }
    if (sides && !sides.binary && !parsed.hasMarkers) {
      this.resultMode.set('edit');
    }
    this.fileTreeExpanded.set(true);
  }

  pickFile(path: string): void {
    this.fileTreeExpanded.set(true);
    void this.store.openConflictResolver(path);
  }

  choiceFor(id: string): ConflictChoice | null {
    return this.choices().get(id) ?? null;
  }

  choiceLabel(choice: ConflictChoice): string {
    switch (choice) {
      case 'ours':
        return this.yoursLabel();
      case 'theirs':
        return this.incomingLabel();
      case 'both':
        return 'Both';
      case 'bothReverse':
        return 'Incoming then yours';
      case 'base':
        return 'Base';
      case 'custom':
        return 'Edited';
    }
  }

  chosenPreview(id: string): string {
    const conflict = this.conflicts().find((c) => c.id === id);
    if (!conflict) return '';
    const choice = this.choiceFor(id);
    if (!choice) return '';
    if (choice === 'custom') return this.custom().get(id) ?? '';
    return contentForChoice(conflict, choice);
  }

  incomingAccepted(id: string): boolean {
    const choice = this.choiceFor(id);
    return choice === 'theirs' || choice === 'both' || choice === 'bothReverse';
  }

  currentAccepted(id: string): boolean {
    const choice = this.choiceFor(id);
    return choice === 'ours' || choice === 'both' || choice === 'bothReverse';
  }

  sideChosen(side: string, id: string): boolean {
    if (side === 'theirs') return this.incomingAccepted(id);
    if (side === 'ours') return this.currentAccepted(id);
    return false;
  }

  sideRejected(side: string, id: string): boolean {
    if (!this.choiceFor(id) || this.choiceFor(id) === 'custom') return false;
    if (side === 'theirs') return !this.incomingAccepted(id);
    if (side === 'ours') return !this.currentAccepted(id);
    return false;
  }

  sidesIdentical(conflict: ConflictRegion): boolean {
    return conflict.ours === conflict.theirs;
  }

  toggleIncoming(id: string): void {
    if (this.manualResultEdit()) return;
    const ours = this.currentAccepted(id);
    const theirs = this.incomingAccepted(id);
    if (theirs && ours) this.accept(id, 'ours', false);
    else if (theirs) this.clearChoice(id);
    else if (ours) this.accept(id, 'both', false);
    else this.accept(id, 'theirs', false);
  }

  toggleCurrent(id: string): void {
    if (this.manualResultEdit()) return;
    const ours = this.currentAccepted(id);
    const theirs = this.incomingAccepted(id);
    if (ours && theirs) this.accept(id, 'theirs', false);
    else if (ours) this.clearChoice(id);
    else if (theirs) this.accept(id, 'both', false);
    else this.accept(id, 'ours', false);
  }

  undoLast(): void {
    const history = this.choiceHistory();
    if (!history.length) return;
    const last = history[history.length - 1]!;
    this.choiceHistory.set(history.slice(0, -1));
    this.choices.set(new Map(last.choices));
    this.custom.set(new Map(last.custom));
    this.rebuildDraft();
  }

  acceptIdentical(): void {
    const identical = this.identicalConflicts();
    if (!identical.length || this.manualResultEdit()) return;
    this.pushChoiceHistory();
    const next = new Map(this.choices());
    for (const conflict of identical) next.set(conflict.id, 'theirs');
    this.choices.set(next);
    this.rebuildDraft();
  }

  toggleHunkMenu(id: string, event: Event): void {
    event.stopPropagation();
    this.hunkMoreId.update((cur) => (cur === id ? null : id));
    this.openMenu.set(null);
  }

  onSourceScroll(event: Event): void {
    if (this.syncingScroll) return;
    const source = event.target as HTMLElement;
    const max = source.scrollHeight - source.clientHeight;
    const ratio = max > 0 ? source.scrollTop / max : 0;
    this.syncingScroll = true;
    for (const ref of this.sourceDocs()) {
      const el = ref.nativeElement;
      if (el === source) continue;
      const otherMax = el.scrollHeight - el.clientHeight;
      el.scrollTop = ratio * Math.max(0, otherMax);
      el.scrollLeft = source.scrollLeft;
    }
    requestAnimationFrame(() => {
      this.syncingScroll = false;
    });
  }

  accept(id: string, choice: ConflictChoice, advance = true): void {
    if (this.manualResultEdit()) return;
    if (choice === 'base') {
      const conflict = this.conflicts().find((c) => c.id === id);
      if (!conflict?.hasBase) return;
    }
    this.pushChoiceHistory();
    const next = new Map(this.choices());
    next.set(id, choice);
    this.choices.set(next);
    if (choice !== 'custom') {
      const custom = new Map(this.custom());
      custom.delete(id);
      this.custom.set(custom);
    }
    this.editingId.set(null);
    this.activeConflictId.set(id);
    this.rebuildDraft();
    if (!advance) return;
    const remaining = remainingConflictIds(this.conflicts(), next, this.custom());
    if (remaining.length) {
      const currentIdx = this.conflicts().findIndex((c) => c.id === id);
      const nextId =
        remaining.find((rid) => {
          const idx = this.conflicts().findIndex((c) => c.id === rid);
          return idx > currentIdx;
        }) ?? remaining[0];
      if (nextId) {
        queueMicrotask(() => this.focusConflictById(nextId));
      }
    }
  }

  acceptActive(choice: ConflictChoice): void {
    const list = this.conflicts();
    const idx = this.activeIndex();
    const conflict = list[idx] ?? list[0];
    if (!conflict) return;
    if (choice === 'base' && !conflict.hasBase) return;
    this.accept(conflict.id, choice);
  }

  acceptAll(side: ConflictChoice): void {
    this.pushChoiceHistory();
    const map = acceptAllChoices(this.conflicts(), side);
    this.choices.set(map);
    this.custom.set(new Map());
    this.editingId.set(null);
    this.rebuildDraft();
    this.activeConflictId.set(this.conflicts()[0]?.id ?? null);
  }

  clearChoice(id: string): void {
    this.pushChoiceHistory();
    const next = new Map(this.choices());
    next.delete(id);
    this.choices.set(next);
    const custom = new Map(this.custom());
    custom.delete(id);
    this.custom.set(custom);
    this.rebuildDraft();
  }

  rebuildDraft(): void {
    const parsed = this.parsed();
    if (!parsed.hasMarkers) return;
    this.store.setConflictResolverDraft(buildConflictResult(parsed, this.choices(), this.custom()));
    this.manualResultEdit.set(false);
  }

  onDraftEdit(value: string): void {
    this.store.setConflictResolverDraft(value);
    this.resultMode.set('edit');
    this.manualResultEdit.set(true);
  }

  resetGeneratedResult(): void {
    this.manualResultEdit.set(false);
    this.rebuildDraft();
  }

  startHunkEdit(id: string | null): void {
    if (!id) return;
    const conflict = this.conflicts().find((c) => c.id === id);
    if (!conflict) return;
    const existing = this.choiceFor(id);
    const draft =
      existing === 'custom'
        ? (this.custom().get(id) ?? '')
        : existing
          ? this.chosenPreview(id)
          : conflict.ours || conflict.theirs;
    this.editingId.set(id);
    this.editDraft.set(draft.endsWith('\n') ? draft.slice(0, -1) : draft);
    this.activeConflictId.set(id);
    this.focusConflictById(id);
  }

  commitHunkEdit(): void {
    const id = this.editingId();
    if (!id) return;
    const custom = new Map(this.custom());
    custom.set(id, this.editDraft().endsWith('\n') ? this.editDraft() : `${this.editDraft()}\n`);
    this.custom.set(custom);
    this.editingId.set(null);
    this.accept(id, 'custom');
  }

  cancelHunkEdit(): void {
    this.editingId.set(null);
    this.editDraft.set('');
  }

  expandContext(index: number): void {
    const next = new Set(this.expandedContext());
    next.add(index);
    this.expandedContext.set(next);
  }

  focusConflict(index: number): void {
    const list = this.conflicts();
    if (!list.length) return;
    const clamped = Math.max(0, Math.min(list.length - 1, index));
    const id = list[clamped]?.id;
    if (id) this.focusConflictById(id);
  }

  focusNextUnresolved(dir: 1 | -1): void {
    const remaining = this.remaining();
    if (!remaining.length) return;
    const list = this.conflicts();
    const current = this.activeIndex();
    if (dir === 1) {
      const nextId =
        remaining.find((id) => (list.findIndex((c) => c.id === id) > current)) ?? remaining[0];
      if (nextId) this.focusConflictById(nextId);
      return;
    }
    const prev = [...remaining]
      .reverse()
      .find((id) => (list.findIndex((c) => c.id === id) < current));
    this.focusConflictById(prev ?? remaining[remaining.length - 1]!);
  }

  focusConflictById(id: string): void {
    this.activeConflictId.set(id);
    queueMicrotask(() => {
      const matches = this.conflictCards().filter(
        (ref) => ref.nativeElement.dataset['conflictId'] === id,
      );
      for (const ref of matches) {
        ref.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      this.scrollResultToConflict(id);
    });
  }

  onHunkCardKey(event: KeyboardEvent, id: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.focusConflictById(id);
    }
  }

  toggleBasePane(): void {
    if (!this.sides()?.hasBase) return;
    this.showBase.update((open) => !open);
  }

  scrollResultToConflict(id: string): void {
    const conflict = this.conflicts().find((c) => c.id === id);
    const area = this.resultEditor()?.nativeElement;
    if (!conflict || !area) return;
    const draft = this.store.conflictResolverDraft();
    const choice = this.choiceFor(id);
    let needle = reconstructMarkers(conflict);
    if (choice === 'custom') needle = this.custom().get(id) ?? needle;
    else if (choice) needle = contentForChoice(conflict, choice);
    const trimmed = needle.replace(/\n$/, '');
    const idx = trimmed ? draft.indexOf(trimmed) : -1;
    const before = idx >= 0 ? draft.slice(0, idx) : '';
    const line = idx >= 0 ? before.split('\n').length : conflict.startLine;
    const lh = Number.parseFloat(globalThis.getComputedStyle(area).lineHeight) || 18;
    area.scrollTop = Math.max(0, (line - 2) * lh);
  }

  fileNavLabel(file: FileStatusEntry): string {
    const status = file.markersCleared ? 'ready to stage' : file.conflictLabel || 'unresolved';
    const dir = this.dirName(file.path);
    return dir
      ? `${this.fileName(file.path)}, ${status}, ${dir}`
      : `${this.fileName(file.path)}, ${status}`;
  }

  hunkRailLabel(conflict: ConflictRegion): string {
    const choice = this.choiceFor(conflict.id);
    const state = choice ? this.choiceLabel(choice) : 'unresolved';
    return `Conflict ${conflict.index + 1}, line ${conflict.startLine}, ${state}`;
  }

  toggleMenu(menu: OpenMenu): void {
    this.hunkMoreId.set(null);
    this.openMenu.update((cur) => (cur === menu ? null : menu));
  }

  closeMenu(): void {
    this.openMenu.set(null);
    this.hunkMoreId.set(null);
  }

  async requestClose(): Promise<void> {
    if (this.closing()) return;
    if (this.dirty() && !this.allResolved()) {
      this.closing.set(true);
      try {
        const ok = await this.prompts.ask({
          title: 'Discard conflict choices?',
          message: 'Unsaved hunk choices in this file will be lost.',
          confirmLabel: 'Discard',
          cancelLabel: 'Keep editing',
          confirmOnly: true,
          required: false,
        });
        if (!ok) return;
      } finally {
        this.closing.set(false);
      }
    }
    this.store.closeConflictResolver();
  }

  openPreferred(): void {
    this.closeMenu();
    const editor = this.resolvedPreferred();
    if (editor === 'cursor' || editor === 'vscode') {
      void this.store.openConflictInIde(editor, 'file');
      return;
    }
    const path = this.store.conflictResolverPath();
    if (path) void this.store.openPathsInEditor([path]);
  }

  openCursor(mode: 'file' | 'merge' = 'file'): void {
    this.closeMenu();
    void this.store.openConflictInIde('cursor', mode);
  }

  openVscode(mode: 'file' | 'merge' = 'file'): void {
    this.closeMenu();
    void this.store.openConflictInIde('vscode', mode);
  }

  openIdeMerge(): void {
    this.closeMenu();
    const editor = this.resolvedPreferred();
    if (editor === 'vscode') {
      void this.store.openConflictInIde('vscode', 'merge');
      return;
    }
    if (editor === 'cursor' || this.hasCursor()) {
      void this.store.openConflictInIde('cursor', 'merge');
      return;
    }
    if (this.hasVscode()) {
      void this.store.openConflictInIde('vscode', 'merge');
      return;
    }
    void this.store.openMergeToolForPaths([this.store.conflictResolverPath()!]);
  }

  openMergetool(): void {
    this.closeMenu();
    void this.store.openMergeToolForPaths([this.store.conflictResolverPath()!]);
  }

  useWholeFile(side: 'ours' | 'theirs' | 'base' | 'working'): void {
    this.pushChoiceHistory();
    this.store.useConflictSide(side);
    this.choices.set(new Map());
    this.custom.set(new Map());
    this.resultMode.set('edit');
    this.manualResultEdit.set(side !== 'working');
  }

  private pushChoiceHistory(): void {
    this.choiceHistory.update((history) =>
      [
        ...history,
        {
          choices: new Map(this.choices()),
          custom: new Map(this.custom()),
        },
      ].slice(-40),
    );
  }

  async save(): Promise<void> {
    if (!this.canSave() || this.saving()) return;
    this.saving.set(true);
    try {
      await this.store.saveConflictResolution();
      this.syncFromSides();
    } finally {
      this.saving.set(false);
    }
  }

  fileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  dirName(path: string): string {
    const idx = path.lastIndexOf('/');
    return idx > 0 ? path.slice(0, idx) : '';
  }

  lineNo(start: number, offset: number): number {
    return start + offset;
  }

  textLines(text: string): string[] {
    if (!text) return [];
    return text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  }

  private toggleCollapsedPane(pane: CollapsePane): void {
    if (pane === 'files') {
      if (this.filesCollapsed()) {
        const size = this.savedFilePaneSize;
        this.workspaceSplitSizes.set([size, 100 - size]);
        this.filesCollapsed.set(false);
        return;
      }
      const current = this.workspaceSplitSizes()[0];
      if (current > COLLAPSE_THRESHOLD) this.savedFilePaneSize = current;
      this.filesCollapsed.set(true);
      this.workspaceSplitSizes.set([COLLAPSED_SIDE, 100 - COLLAPSED_SIDE]);
      return;
    }
    if (this.resultCollapsed()) {
      const size = this.savedResultPaneSize;
      this.resultSplitSizes.set([100 - size, size]);
      this.resultCollapsed.set(false);
      return;
    }
    const current = this.resultSplitSizes()[1];
    if (current > RESULT_COLLAPSE_THRESHOLD) this.savedResultPaneSize = current;
    this.resultCollapsed.set(true);
    this.resultSplitSizes.set([100 - COLLAPSED_RESULT, COLLAPSED_RESULT]);
  }

  private syncCollapsedFromSize(pane: CollapsePane, size: number): void {
    if (pane === 'files') {
      const collapsed = size <= COLLAPSE_THRESHOLD;
      this.filesCollapsed.set(collapsed);
      if (!collapsed) this.savedFilePaneSize = size;
      return;
    }
    const collapsed = size <= RESULT_COLLAPSE_THRESHOLD;
    this.resultCollapsed.set(collapsed);
    if (!collapsed) this.savedResultPaneSize = size;
  }
}

function markerLineCount(conflict: ConflictRegion): number {
  const raw = reconstructMarkers(conflict);
  return raw.endsWith('\n') ? raw.slice(0, -1).split('\n').length : raw.split('\n').length;
}

function splitNumbers(event: SplitGutterInteractionEvent): number[] {
  return event.sizes.filter((size): size is number => typeof size === 'number');
}

function numberAlignedLines(rows: AlignedLine[], startLine: number): NumberedAlignedLine[] {
  let left = startLine;
  let right = startLine;
  return rows.map((row) => ({
    ...row,
    leftNo: row.left === null ? null : left++,
    rightNo: row.right === null ? null : right++,
  }));
}

const COLLAPSED_SIDE = 2.4;
const COLLAPSED_RESULT = 4.8;
const COLLAPSE_THRESHOLD = 4.2;
const RESULT_COLLAPSE_THRESHOLD = 8;
