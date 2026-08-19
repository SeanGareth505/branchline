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
import type { BranchHygieneEntry } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';

interface HygieneGroup {
  reason: string;
  label: string;
  entries: BranchHygieneEntry[];
}

@Component({
  selector: 'app-branch-hygiene-dialog',
  imports: [NgIcon],
  templateUrl: './branch-hygiene-dialog.html',
  styleUrl: './branch-hygiene-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BranchHygieneDialog {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly entries = signal<BranchHygieneEntry[]>([]);
  readonly loading = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  private primed = false;

  readonly groups = computed((): HygieneGroup[] => {
    const buckets = new Map<string, BranchHygieneEntry[]>();
    for (const entry of this.entries()) {
      const list = buckets.get(entry.reason) ?? [];
      list.push(entry);
      buckets.set(entry.reason, list);
    }
    const order = ['merged', 'gone', 'stale'];
    const reasons = [
      ...order.filter((reason) => buckets.has(reason)),
      ...[...buckets.keys()].filter((reason) => !order.includes(reason)).sort(),
    ];
    return reasons.map((reason) => ({
      reason,
      label: this.reasonLabel(reason),
      entries: buckets.get(reason) ?? [],
    }));
  });

  readonly safeCount = computed(
    () => this.entries().filter((entry) => entry.safeToDelete).length,
  );
  readonly canDeleteSafe = computed(
    () => !this.loading() && !this.busy() && this.safeCount() > 0,
  );
  readonly canDeleteAll = computed(
    () => !this.loading() && !this.busy() && this.entries().length > 0,
  );

  constructor() {
    effect(() => {
      const open = this.store.branchHygieneDialogOpen();
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
    this.store.closeBranchHygieneDialog();
  }

  async submit(mode: 'safe' | 'all'): Promise<void> {
    if (mode === 'safe' && !this.canDeleteSafe()) return;
    if (mode === 'all' && !this.canDeleteAll()) return;
    const chosen =
      mode === 'safe' ? this.entries().filter((entry) => entry.safeToDelete) : this.entries();
    if (!chosen.length) return;
    if (mode === 'all') {
      const n = chosen.length;
      const ok = await this.prompts.ask({
        title: 'Delete all local branches?',
        message: `Force-delete all ${n} listed local branch${n === 1 ? '' : 'es'}, including unmerged branches. Commits that only exist on those branches may be hard to recover.`,
        confirmLabel: 'Delete all',
        cancelLabel: 'Cancel',
        confirmOnly: true,
        required: false,
      });
      if (ok === null) return;
    }
    this.busy.set(true);
    try {
      await this.store.deleteLocalBranches(
        chosen.map((entry) => entry.name),
        mode === 'all',
      );
      this.store.closeBranchHygieneDialog();
    } finally {
      this.busy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.branchHygieneDialogOpen()) return;
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
      const list = await this.store.loadBranchHygiene();
      this.entries.set(list);
    } catch (err) {
      this.entries.set([]);
      this.error.set(this.store.formatError(err));
    } finally {
      this.loading.set(false);
    }
  }

  private reasonLabel(reason: string): string {
    switch (reason) {
      case 'merged':
        return 'Merged into HEAD';
      case 'gone':
        return 'Remote branch deleted';
      case 'stale':
        return 'No commits in 90+ days';
      default:
        return reason;
    }
  }
}
