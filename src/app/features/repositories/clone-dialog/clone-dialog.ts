import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AppStore } from '../../../core/app.store';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import type { HostRepository } from '../../../core/models';

@Component({
  selector: 'app-clone-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './clone-dialog.html',
  styleUrl: './clone-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CloneDialog {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly url = signal('');
  readonly parentDir = signal('');
  readonly busy = signal(false);
  readonly shallow = signal(false);
  readonly recurseSubmodules = signal(false);
  readonly sparse = signal(false);

  constructor() {
    effect(() => {
      if (!this.store.cloneDialogOpen()) return;
      const prefill = this.store.cloneDialogUrl().trim();
      if (prefill) this.url.set(prefill);
      if (this.store.hostRepos().length === 0 && this.store.hasLinkedPrHost()) {
        void this.store.refreshHostRepositories();
      }
    });
  }

  readonly hostSuggestions = computed(() => {
    const q = this.url().trim().toLowerCase();
    const repos = this.store.hostRepos();
    if (!q) return repos.slice(0, 8);
    const match = repos.filter((repo) => {
      const name = (repo.fullName || repo.name || '').toLowerCase();
      const cloneUrl = (repo.cloneUrl || '').toLowerCase();
      return name.includes(q) || cloneUrl.includes(q);
    });
    return match.slice(0, 8);
  });

  readonly folderName = computed(() => {
    const raw = this.url().trim().replace(/\/$/, '');
    if (!raw) return 'repo';
    return raw.split('/').pop()?.replace(/\.git$/, '') || 'repo';
  });

  readonly destination = computed(() => {
    const parent = this.parentDir().trim().replace(/\/$/, '');
    if (!parent) return '';
    return `${parent}/${this.folderName()}`;
  });

  readonly canClone = computed(
    () => !!this.url().trim() && !!this.parentDir().trim() && !this.busy(),
  );

  close(): void {
    if (this.busy()) return;
    this.store.closeCloneDialog();
    this.resetForm();
  }

  private resetForm(): void {
    this.url.set('');
    this.parentDir.set('');
    this.shallow.set(false);
    this.recurseSubmodules.set(false);
    this.sparse.set(false);
  }

  private isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  async pickFolder(): Promise<void> {
    if (this.isTauri()) {
      try {
        const selected = await openDialog({ directory: true, multiple: false });
        if (typeof selected === 'string' && selected) {
          this.parentDir.set(selected);
        }
      } catch (err) {
        this.store.showError(err);
      }
      return;
    }
    const path = await this.prompts.ask({
      title: 'Clone destination',
      message: 'Parent folder where the repository will be created.',
      label: 'Parent folder',
      placeholder: '/Users/you/Projects',
      confirmLabel: 'Use folder',
      mono: true,
    });
    if (path?.trim()) this.parentDir.set(path.trim());
  }

  async submit(): Promise<void> {
    if (!this.canClone()) return;
    this.busy.set(true);
    try {
      await this.store.cloneRepo(this.url().trim(), this.destination(), {
        shallow: this.shallow(),
        recurseSubmodules: this.recurseSubmodules(),
        sparse: this.sparse(),
      });
      this.store.closeCloneDialog();
      this.resetForm();
    } finally {
      this.busy.set(false);
    }
  }

  pickHostRepo(repo: HostRepository): void {
    if (!repo.cloneUrl) return;
    this.url.set(repo.cloneUrl);
  }
}
