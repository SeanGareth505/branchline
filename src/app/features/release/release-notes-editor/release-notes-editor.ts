import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-release-notes-editor',
  imports: [FormsModule, NgIcon, HelpTip],
  templateUrl: './release-notes-editor.html',
  styleUrl: './release-notes-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseNotesEditor {
  readonly store = inject(AppStore);
  readonly open = signal(false);

  readonly statusLabel = computed(() => {
    const text = this.store.releaseNotesText().trim();
    if (this.store.releaseNotesSynced() && text) return 'On GitHub';
    if (text) return 'Local draft';
    return 'Empty';
  });

  readonly hint = computed(() => {
    const activity = this.store.visibleReleaseActivity();
    const text = this.store.releaseNotesText().trim();
    if (this.store.releaseNotesSynced() && text) {
      return activity?.releaseUrl
        ? 'These notes are on the GitHub release. Edit and update to publish changes.'
        : 'These notes match the GitHub release.';
    }
    if (activity?.releaseUrl) {
      return 'Local edits — Update GitHub to publish them on the release.';
    }
    if (activity?.tag) {
      return `Draft for ${activity.tag}. Saved locally until the GitHub release exists.`;
    }
    return 'Draft for the next release.';
  });

  readonly saveLabel = computed(() => {
    if (this.store.releaseNotesBusy()) {
      return this.store.releaseNotesCanPublish() ? 'Updating…' : 'Saving…';
    }
    if (this.store.releaseNotesCanPublish()) {
      return this.store.releaseNotesSynced() ? 'Updated' : 'Update GitHub';
    }
    return 'Save draft';
  });

  readonly placeholder = computed(() => {
    const activity = this.store.visibleReleaseActivity();
    const tag = activity?.willTag === false ? null : activity?.tag;
    return tag
      ? `Release notes for ${tag}`
      : 'What shipped in this version?';
  });

  toggle(): void {
    this.open.update((open) => !open);
  }

  onChange(value: string): void {
    this.store.setReleaseNotes(value);
  }

  save(): void {
    void this.store.saveReleaseNotes();
  }

  generate(): void {
    this.open.set(true);
    void this.store.generateReleaseNotes();
  }

  reload(): void {
    void this.store.loadGitHubReleaseNotes({ overwrite: true });
  }
}
