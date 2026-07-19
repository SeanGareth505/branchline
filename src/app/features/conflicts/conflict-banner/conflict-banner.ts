import { Component, computed, HostListener, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import {
  preferredEditorLabel,
  resolvePreferredEditor,
} from '../../../shared/git/open-in-editor';

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

  readonly title = computed(() => {
    const op = this.operation();
    const n = this.conflictCount();
    if (n > 0) {
      const kind = op?.label?.replace(/ in progress$/i, '') || 'Operation';
      return `${n} conflicted file${n === 1 ? '' : 's'} · ${kind.toLowerCase()}`;
    }
    if (op) {
      const detail = op.detail ? ` · ${op.detail}` : '';
      return `All conflicts resolved · ${op.label}${detail}`;
    }
    return 'Conflicts';
  });

  readonly hint = computed(() => {
    if (this.readyToContinue()) {
      return 'Nothing left unmerged — Continue to finish, or Abort to cancel.';
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

  openVscode(): void {
    this.toolsOpen.set(false);
    void this.store.openConflictInIde('vscode', 'file');
  }

  openIdeMerge(): void {
    this.toolsOpen.set(false);
    const resolved = resolvePreferredEditor(
      this.store.settings().preferredEditor,
      this.store.detectedEditors(),
    );
    if (resolved === 'vscode') {
      void this.store.openConflictInIde('vscode', 'merge');
      return;
    }
    if (resolved === 'cursor' || this.hasCursor()) {
      void this.store.openConflictInIde('cursor', 'merge');
      return;
    }
    if (this.hasVscode()) {
      void this.store.openConflictInIde('vscode', 'merge');
      return;
    }
    void this.store.openMergeToolForPaths();
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
