import { Component, computed, inject } from '@angular/core';
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

  readonly preferredLabel = computed(() =>
    preferredEditorLabel(this.store.settings().preferredEditor, this.store.detectedEditors()),
  );

  readonly hasCursor = computed(() => !!this.store.detectedEditors()?.cursor);
  readonly hasVscode = computed(() => !!this.store.detectedEditors()?.vscode);

  openResolver(): void {
    void this.store.openConflictResolver();
  }

  openInEditor(): void {
    void this.store.openConflictedInEditor();
  }

  openCursor(): void {
    void this.store.openConflictInIde('cursor', 'file');
  }

  openVscode(): void {
    void this.store.openConflictInIde('vscode', 'file');
  }

  openIdeMerge(): void {
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
    void this.store.openMergeToolForPaths();
  }

  continueOp(): void {
    void this.store.continueOperation();
  }

  abortOp(): void {
    void this.store.abortOperation();
  }
}
