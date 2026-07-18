import { ChangeDetectionStrategy, Component, inject, signal, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { IgnoreKind } from '../../../core/models';

@Component({
  selector: 'app-ignore-editor-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './ignore-editor-dialog.html',
  styleUrl: './ignore-editor-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IgnoreEditorDialog {
  readonly store = inject(AppStore);
  readonly content = signal('');
  readonly kind = signal<IgnoreKind>('gitignore');

  constructor() {
    effect(() => {
      const file = this.store.ignoreEditor();
      if (file) {
        this.content.set(file.content);
        this.kind.set((file.kind === 'exclude' ? 'exclude' : 'gitignore') as IgnoreKind);
      }
    });
  }

  async switchKind(kind: IgnoreKind): Promise<void> {
    this.kind.set(kind);
    await this.store.openIgnoreEditor(kind);
  }

  save(): void {
    void this.store.saveIgnoreEditor(this.content(), this.kind());
  }
}
