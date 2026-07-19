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

  openInEditor(): void {
    void this.store.openConflictedInEditor();
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
