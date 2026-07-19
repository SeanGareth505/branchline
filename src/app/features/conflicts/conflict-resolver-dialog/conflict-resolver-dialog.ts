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
import { AppStore } from '../../../core/app.store';
import {
  acceptAllChoices,
  buildConflictResult,
  ConflictChoice,
  draftHasConflictMarkers,
  parseConflictMarkers,
  remainingConflictIds,
} from '../../../core/conflict-parse';
import {
  preferredEditorLabel,
  resolvePreferredEditor,
} from '../../../shared/git/open-in-editor';

type OpenMenu = 'tools' | null;

@Component({
  selector: 'app-conflict-resolver-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './conflict-resolver-dialog.html',
  styleUrl: './conflict-resolver-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConflictResolverDialog {
  readonly store = inject(AppStore);

  readonly conflicted = computed(() => this.store.status()?.conflicted ?? []);
  readonly sides = computed(() => this.store.conflictResolver());
  readonly currentFile = computed(() => {
    const path = this.store.conflictResolverPath();
    return this.conflicted().find((f) => f.path === path) ?? null;
  });

  readonly choices = signal<Map<string, ConflictChoice>>(new Map());
  readonly activeConflictId = signal<string | null>(null);
  readonly showBase = signal(false);
  readonly resultMode = signal<'guided' | 'edit'>('guided');
  readonly openMenu = signal<OpenMenu>(null);
  readonly saving = signal(false);
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
      const key = `${path}::${sides.working.length}::${sides.binary}`;
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
    return 'Keep your version, take theirs, or combine both for each conflict.';
  });

  readonly parsed = computed(() => {
    const sides = this.sides();
    if (!sides || sides.binary) {
      return parseConflictMarkers('');
    }
    return parseConflictMarkers(sides.working || '');
  });

  readonly conflicts = computed(() => this.parsed().conflicts);

  readonly isDeleteConflict = computed(() => {
    const kind = this.currentFile()?.conflictKind ?? '';
    return kind === 'deletedByUs' || kind === 'deletedByThem' || kind === 'bothDeleted';
  });

  readonly remaining = computed(() => remainingConflictIds(this.conflicts(), this.choices()));

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
    return `File ${this.fileIndex()} of ${this.fileTotal()} · ${done}/${conflicts.length} conflicts`;
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

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.store.conflictResolverOpen()) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'INPUT' ||
      target?.isContentEditable;
    if (event.key === 'Escape') {
      if (this.openMenu()) {
        this.openMenu.set(null);
        event.preventDefault();
        return;
      }
      if (!typing) {
        this.store.closeConflictResolver();
        event.preventDefault();
      }
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
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
  }

  syncFromSides(): void {
    const sides = this.sides();
    this.choices.set(new Map());
    this.resultMode.set('guided');
    this.openMenu.set(null);
    this.showBase.set(false);
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
      case 'base':
        return 'Base';
    }
  }

  accept(id: string, choice: ConflictChoice): void {
    const next = new Map(this.choices());
    next.set(id, choice);
    this.choices.set(next);
    this.activeConflictId.set(id);
    this.rebuildDraft();
    const remaining = remainingConflictIds(this.conflicts(), next);
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
    this.rebuildDraft();
    this.activeConflictId.set(this.conflicts()[0]?.id ?? null);
  }

  clearChoice(id: string): void {
    const next = new Map(this.choices());
    next.delete(id);
    this.choices.set(next);
    this.rebuildDraft();
  }

  rebuildDraft(): void {
    const parsed = this.parsed();
    if (!parsed.hasMarkers) return;
    this.store.setConflictResolverDraft(buildConflictResult(parsed, this.choices()));
  }

  onDraftEdit(value: string): void {
    this.store.setConflictResolverDraft(value);
    this.resultMode.set('edit');
  }

  focusConflict(index: number): void {
    const list = this.conflicts();
    if (!list.length) return;
    const clamped = Math.max(0, Math.min(list.length - 1, index));
    const id = list[clamped]?.id;
    if (id) this.focusConflictById(id);
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

  previewLines(text: string, max = 12): string[] {
    if (!text) return ['(empty)'];
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    const lines = trimmed.length ? trimmed.split('\n') : ['(empty)'];
    if (lines.length <= max) return lines;
    return [...lines.slice(0, max), `… ${lines.length - max} more lines`];
  }
}
