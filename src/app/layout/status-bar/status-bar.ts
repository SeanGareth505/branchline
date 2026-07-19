import { Component, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';

@Component({
  selector: 'app-status-bar',
  imports: [NgIcon],
  templateUrl: './status-bar.html',
  styleUrl: './status-bar.scss',
})
export class StatusBar {
  readonly store = inject(AppStore);

  onPush(): void {
    void this.store.pushRemote();
  }

  onPull(): void {
    void this.store.pullRemote();
  }

  onChanges(): void {
    this.store.openCommitModal();
  }
}
