import { Component, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-conflict-banner',
  imports: [NgIcon],
  templateUrl: './conflict-banner.html',
  styleUrl: './conflict-banner.scss',
})
export class ConflictBanner {
  readonly store = inject(AppStore);

  open(tool: 'cursor' | 'vscode' | 'merge'): void {
    const files = this.store.status()?.conflicted.map((f) => f.path).join('\n') ?? '';
    if (tool === 'cursor') {
      window.open(`cursor://file${this.store.currentRepo()?.path ?? ''}`, '_blank');
    } else if (tool === 'vscode') {
      window.open(`vscode://file${this.store.currentRepo()?.path ?? ''}`, '_blank');
    } else {
      this.store.showInfo(
        files ? `Open your merge tool for:\n${files}` : 'No conflicted files listed',
      );
    }
  }

  continueOp(): void {
    void this.store.continueOperation();
  }

  abortOp(): void {
    void this.store.abortOperation();
  }
}
