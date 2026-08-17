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
import type { CleanEntry } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';

@Component({
  selector: 'app-git-clean-dialog',
  imports: [NgIcon],
  templateUrl: './git-clean-dialog.html',
  styleUrl: './git-clean-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitCleanDialog {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly entries = signal<CleanEntry[]>([]);
  readonly selected = signal<Set<string>>(new Set());
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private primed = false;

  readonly selectedCount = computed(() => this.selected().size);
  readonly canSubmit = computed(
    () => !this.loading() && !this.busy() && this.selectedCount() > 0,
  );
  readonly submitLabel = computed(() => (this.busy() ? 'Deleting…' : 'Delete files'));

  constructor() {
    effect(() => {
      const open = this.store.gitCleanDialogOpen();
      if (!open) {
        this.primed = false;
        return;
      }
      if (this.primed) return;
      this.primed = true;
      void this.load();
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeGitCleanDialog();
  }

  isSelected(path: string): boolean {
    return this.selected().has(path);
  }

  toggle(path: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selected.update((set) => {
      const next = new Set(set);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    const paths = this.entries()
      .map((entry) => entry.path)
      .filter((path) => this.selected().has(path));
    if (!paths.length) return;
    const n = paths.length;
    const ok = await this.prompts.ask({
      title: 'Delete untracked files?',
      message: `Permanently delete ${n} untracked file${n === 1 ? '' : 's'}? This cannot be undone from Branchline.`,
      confirmLabel: 'Delete files',
      cancelLabel: 'Cancel',
      confirmOnly: true,
      required: false,
    });
    if (ok === null) return;
    this.busy.set(true);
    try {
      await this.store.runClean(paths);
      this.store.closeGitCleanDialog();
    } finally {
      this.busy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.gitCleanDialogOpen()) return;
    if (event.key !== 'Escape') return;
    if (this.prompts.request()) return;
    event.preventDefault();
    this.close();
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.busy.set(false);
    this.error.set(null);
    try {
      const list = await this.store.loadCleanPreview();
      this.entries.set(list);
      this.selected.set(new Set(list.map((entry) => entry.path)));
    } catch (err) {
      this.entries.set([]);
      this.selected.set(new Set());
      this.error.set(this.store.formatError(err));
    } finally {
      this.loading.set(false);
    }
  }
}
