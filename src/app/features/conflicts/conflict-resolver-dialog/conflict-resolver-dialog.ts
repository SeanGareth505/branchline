import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import {
  preferredEditorLabel,
  resolvePreferredEditor,
} from '../../../shared/git/open-in-editor';

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

  readonly preferredLabel = computed(() =>
    preferredEditorLabel(this.store.settings().preferredEditor, this.store.detectedEditors()),
  );

  readonly resolvedPreferred = computed(() =>
    resolvePreferredEditor(this.store.settings().preferredEditor, this.store.detectedEditors()),
  );

  readonly hasCursor = computed(() => !!this.store.detectedEditors()?.cursor);
  readonly hasVscode = computed(() => !!this.store.detectedEditors()?.vscode);

  pickFile(path: string): void {
    void this.store.openConflictResolver(path);
  }

  openPreferred(): void {
    const editor = this.resolvedPreferred();
    if (editor === 'cursor' || editor === 'vscode') {
      void this.store.openConflictInIde(editor, 'file');
      return;
    }
    const path = this.store.conflictResolverPath();
    if (path) void this.store.openPathsInEditor([path]);
  }

  openCursor(mode: 'file' | 'merge' = 'file'): void {
    void this.store.openConflictInIde('cursor', mode);
  }

  openVscode(mode: 'file' | 'merge' = 'file'): void {
    void this.store.openConflictInIde('vscode', mode);
  }

  openIdeMerge(): void {
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
}
