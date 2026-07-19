import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { preferredEditorLabel } from '../../../shared/git/open-in-editor';

const PREVIEW_LIMIT = 3;

@Component({
  selector: 'app-conflict-banner',
  imports: [NgIcon],
  templateUrl: './conflict-banner.html',
  styleUrl: './conflict-banner.scss',
})
export class ConflictBanner {
  readonly store = inject(AppStore);
  readonly toolsOpen = signal(false);

  readonly preferredLabel = computed(() =>
    preferredEditorLabel(this.store.settings().preferredEditor, this.store.detectedEditors()),
  );

  readonly hasCursor = computed(() => !!this.store.detectedEditors()?.cursor);
  readonly hasVscode = computed(() => !!this.store.detectedEditors()?.vscode);

  readonly operation = computed(() => this.store.status()?.operation ?? null);
  readonly conflictCount = computed(() => this.store.status()?.conflicted?.length ?? 0);
  readonly readyToContinue = computed(() => this.store.operationNeedsContinue());
  readonly readyToStageCount = computed(
    () => this.store.status()?.conflicted?.filter((f) => f.markersCleared).length ?? 0,
  );

  readonly previewFiles = computed(() => (this.store.status()?.conflicted ?? []).slice(0, PREVIEW_LIMIT));

  readonly hiddenFileCount = computed(() => Math.max(0, this.conflictCount() - PREVIEW_LIMIT));

  readonly title = computed(() => {
    const op = this.operation();
    const n = this.conflictCount();
    const ready = this.readyToStageCount();
    const kind = op?.label?.replace(/ in progress$/i, '') || 'merge';
    if (n > 0) {
      if (ready > 0 && ready === n) {
        return `${n} file${n === 1 ? '' : 's'} ready to stage · ${kind.toLowerCase()}`;
      }
      if (ready > 0) {
        return `${n} conflicted · ${ready} ready to stage · ${kind.toLowerCase()}`;
      }
      return `${n} conflicted file${n === 1 ? '' : 's'} · ${kind.toLowerCase()}`;
    }
    if (op) {
      const detail = op.detail ? ` · ${op.detail}` : '';
      return `All conflicts resolved · ${op.label}${detail}`;
    }
    return 'Conflicts';
  });

  readonly hint = computed(() => {
    if (this.store.conflictIdeBusy()) {
      return `Waiting for ${this.store.conflictIdeLabel() || 'the editor'} — close the tab when finished.`;
    }
    if (this.readyToContinue()) {
      return 'Nothing left unmerged — Continue to finish, or Abort to cancel.';
    }
    if (this.readyToStageCount() > 0) {
      return 'Some files have no conflict markers left — Stage them to mark resolved.';
    }
    if (this.conflictCount() > PREVIEW_LIMIT) {
      return 'Open Resolve to work through the list, or use Files → Conflicts.';
    }
    const op = this.operation();
    if (op?.kind === 'rebase') {
      return 'Resolve each file, then Continue. During rebase, “yours” is the branch you rebase onto.';
    }
    if (op?.kind === 'cherryPick' || op?.kind === 'revert') {
      return 'Resolve each file, then Continue.';
    }
    return 'Resolve each file, then Continue the merge.';
  });

  @HostListener('document:click')
  onDocClick(): void {
    if (this.toolsOpen()) this.toolsOpen.set(false);
  }

  fileName(path: string): string {
    const parts = path.split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }

  toggleTools(): void {
    this.toolsOpen.update((v) => !v);
  }

  openResolver(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictResolver();
  }

  openInEditor(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictedInEditor();
  }

  openCursor(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictInIde('cursor', 'file');
  }

  openCursorMerge(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictInIde('cursor', 'merge');
  }

  openVscode(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictInIde('vscode', 'file');
  }

  openVscodeMerge(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictInIde('vscode', 'merge');
  }

  openMergeTool(): void {
    this.toolsOpen.set(false);
    void this.store.openMergeToolForPaths();
  }

  continueOp(): void {
    this.toolsOpen.set(false);
    void this.store.continueOperation();
  }

  abortOp(): void {
    this.toolsOpen.set(false);
    void this.store.abortOperation();
  }
}
