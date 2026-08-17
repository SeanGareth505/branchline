import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { Spinner } from '../../../shared/ui/spinner/spinner';

@Component({
  selector: 'app-fetch-dialog',
  imports: [FormsModule, NgIcon, Spinner],
  templateUrl: './fetch-dialog.html',
  styleUrl: './fetch-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FetchDialog {
  readonly store = inject(AppStore);
  readonly allRemotes = signal(true);
  readonly prune = signal(true);
  readonly tags = signal(false);
  private primed = false;

  readonly remoteName = computed(() => this.store.remotes()[0]?.name || 'origin');
  readonly remoteCount = computed(() => this.store.remotes().length);
  readonly submitting = computed(() => this.store.remoteBusy() === 'fetch');

  constructor() {
    effect(() => {
      const open = this.store.fetchDialogOpen();
      if (!open) {
        this.primed = false;
        return;
      }
      if (this.primed) return;
      this.primed = true;
      const settings = this.store.settings();
      this.allRemotes.set(settings.fetchAllRemotes);
      this.prune.set(settings.fetchPrune);
      this.tags.set(settings.fetchTags);
    });
  }

  close(): void {
    if (this.submitting()) return;
    this.store.closeFetchDialog();
  }

  async submit(): Promise<void> {
    if (this.submitting()) return;
    const allRemotes = this.allRemotes();
    const prune = this.prune();
    const tags = this.tags();
    void this.store.saveSettings({
      fetchAllRemotes: allRemotes,
      fetchPrune: prune,
      fetchTags: tags,
    });
    this.store.armRemoteBusy('fetch');
    this.store.closeFetchDialog();
    await this.store.fetchRemote(undefined, { allRemotes, prune, tags });
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.fetchDialogOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || !event.shiftKey)) {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'TEXTAREA') return;
      event.preventDefault();
      void this.submit();
    }
  }
}
