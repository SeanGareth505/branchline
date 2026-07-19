import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-publish-github-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './publish-github-dialog.html',
  styleUrl: './publish-github-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublishGithubDialog {
  readonly store = inject(AppStore);

  readonly name = signal('');
  readonly description = signal('');
  readonly isPrivate = signal(false);
  readonly createRelease = signal(true);
  readonly tagName = signal('v0.1.0');
  readonly busy = signal(false);

  readonly linked = computed(() => this.store.hasLinkedGithub());
  readonly canPublish = computed(
    () => !!this.name().trim() && this.linked() && !this.busy(),
  );

  constructor() {
    effect(() => {
      if (!this.store.publishGithubDialogOpen()) return;
      const repo = this.store.currentRepo();
      const folder = repo?.path.split(/[/\\]/).filter(Boolean).at(-1) ?? 'branchline';
      this.name.set(folder);
      this.description.set('Published with Branchline');
      this.isPrivate.set(false);
      this.createRelease.set(true);
      this.tagName.set('v0.1.0');
      this.busy.set(false);
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closePublishGithubDialog();
  }

  signIn(): void {
    this.store.openGithubDeviceLogin();
  }

  async publish(): Promise<void> {
    if (!this.canPublish()) return;
    this.busy.set(true);
    try {
      await this.store.publishToGithub({
        name: this.name().trim(),
        description: this.description().trim(),
        private: this.isPrivate(),
        createReleaseTag: this.createRelease(),
        tagName: this.tagName().trim() || 'v0.1.0',
      });
    } finally {
      this.busy.set(false);
    }
  }
}
