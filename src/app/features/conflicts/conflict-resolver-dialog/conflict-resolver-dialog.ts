import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { AppStore } from '../../../core/app.store';
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

type OpenMenu = 'tools' | null;

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
  aligned: AlignedLine[];
}

type DocumentBlock = TextBlock | ConflictBlock;

@Component({
  selector: 'app-conflict-resolver-dialog',
  imports: [FormsModule, NgIcon, HelpTip],
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
  readonly resultMode = signal<'guided' | 'edit'>('guided');
  readonly openMenu = signal<OpenMenu>(null);
  readonly saving = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly editDraft = signal('');
  readonly expandedContext = signal<Set<number>>(new Set());
  readonly closing = signal(false);
  private syncedKey = '';

  readonly conflictCards = viewChildren<ElementRef<HTMLElement>>('conflictCard');

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

  readonly sideHint = computed(() => {
    const kind = this.operation()?.kind;
    if (kind === 'rebase') {
      return 'During rebase, “ours” is the branch you rebase onto; “incoming” is the commit being applied.';
    }
    if (kind === 'cherryPick') {
      return 'Keep what is on your branch, take the cherry-picked change, or combine both.';
    }
    return 'Keep yours, take incoming, combine both, or edit the hunk in place.';
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
        aligned: alignConflictLines(segment.conflict.ours, segment.conflict.theirs),
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

  readonly activeIndex = computed(() => {
    const id = this.activeConflictId();
    const list = this.conflicts();
    if (!list.length) return -1;
    if (!id) return 0;
    const idx = list.findIndex((c) => c.id === id);
    return idx >= 0 ? idx : 0;
  });

  readonly canSave = computed(() => {
    const sides = this.sides();
    if (!sides || sides.binary) return false;
    if (this.isDeleteConflict()) return false;
    if (this.conflicts().length) return this.allResolved();
    return !draftHasConflictMarkers(this.store.conflictResolverDraft());
  });

  readonly dirty = computed(() => this.choices().size > 0 || this.custom().size > 0);

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
      if (this.openMenu()) {
        this.openMenu.set(null);
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

  syncFromSides(): void {
    const sides = this.sides();
    this.choices.set(new Map());
    this.custom.set(new Map());
    this.resultMode.set('guided');
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
  }

  pickFile(path: string): void {
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

  accept(id: string, choice: ConflictChoice): void {
    if (choice === 'base') {
      const conflict = this.conflicts().find((c) => c.id === id);
      if (!conflict?.hasBase) return;
    }
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
    const map = acceptAllChoices(this.conflicts(), side);
    this.choices.set(map);
    this.custom.set(new Map());
    this.editingId.set(null);
    this.rebuildDraft();
    this.activeConflictId.set(this.conflicts()[0]?.id ?? null);
  }

  clearChoice(id: string): void {
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
  }

  onDraftEdit(value: string): void {
    this.store.setConflictResolverDraft(value);
    this.resultMode.set('edit');
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
      const el = this.conflictCards().find((ref) => ref.nativeElement.dataset['conflictId'] === id);
      el?.nativeElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  toggleMenu(menu: OpenMenu): void {
    this.openMenu.update((cur) => (cur === menu ? null : menu));
  }

  closeMenu(): void {
    this.openMenu.set(null);
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
    this.store.useConflictSide(side);
    this.choices.set(new Map());
    this.custom.set(new Map());
    this.resultMode.set('edit');
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
}

function markerLineCount(conflict: ConflictRegion): number {
  const raw = reconstructMarkers(conflict);
  return raw.endsWith('\n') ? raw.slice(0, -1).split('\n').length : raw.split('\n').length;
}
