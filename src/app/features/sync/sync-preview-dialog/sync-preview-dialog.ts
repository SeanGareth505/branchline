import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { SyncCommitInfo } from '../../../core/models';

@Component({
  selector: 'app-sync-preview-dialog',
  imports: [NgIcon],
  templateUrl: './sync-preview-dialog.html',
  styleUrl: './sync-preview-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SyncPreviewDialog {
  readonly store = inject(AppStore);
  readonly commits = signal<SyncCommitInfo[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  private primed = false;
  private loadedKind: 'incoming' | 'outgoing' | null = null;

  readonly incoming = computed(() => this.store.syncPreviewKind() === 'incoming');
  readonly title = computed(() => (this.incoming() ? 'Incoming' : 'Outgoing'));
  readonly emptyLabel = computed(() =>
    this.incoming() ? "You're up to date" : 'Nothing to push',
  );
  readonly submitLabel = computed(() => {
    if (this.busy()) return this.incoming() ? 'Pulling…' : 'Pushing…';
    return this.incoming() ? 'Pull' : 'Push';
  });
  readonly canSubmit = computed(
    () => !this.loading() && !this.busy() && this.commits().length > 0,
  );

  constructor() {
    effect(() => {
      const open = this.store.syncPreviewDialogOpen();
      const kind = this.store.syncPreviewKind();
      if (!open) {
        this.primed = false;
        this.loadedKind = null;
        return;
      }
      if (this.primed && this.loadedKind === kind) return;
      this.primed = true;
      this.loadedKind = kind;
      void this.load(kind);
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeSyncPreviewDialog();
  }

  openCommit(commit: SyncCommitInfo): void {
    this.store.selectCommit(commit.sha);
    this.store.setBrowseTab('diff');
    this.close();
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    try {
      if (this.incoming()) {
        await this.store.pullRemote();
      } else {
        await this.store.pushRemote();
      }
      this.store.closeSyncPreviewDialog();
    } finally {
      this.busy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.syncPreviewDialogOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
    }
  }

  private async load(kind: 'incoming' | 'outgoing'): Promise<void> {
    this.loading.set(true);
    this.busy.set(false);
    try {
      this.commits.set(await this.store.loadSyncCommits(kind));
    } catch {
      this.commits.set([]);
    } finally {
      this.loading.set(false);
    }
  }
}
