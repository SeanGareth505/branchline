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
  readonly selectedReasons = signal<Set<string>>(new Set());
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
    const order = ['merged', 'gone'];
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

  readonly chosen = computed(() => {
    const selected = this.selectedReasons();
    return this.entries().filter((entry) => selected.has(entry.reason));
  });

  readonly safeCount = computed(() => this.chosen().length);
  readonly canDeleteSafe = computed(
    () => !this.loading() && !this.busy() && this.safeCount() > 0,
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

  reasonSelected(reason: string): boolean {
    return this.selectedReasons().has(reason);
  }

  toggleReason(reason: string): void {
    const next = new Set(this.selectedReasons());
    if (next.has(reason)) next.delete(reason);
    else next.add(reason);
    this.selectedReasons.set(next);
  }

  async submit(): Promise<void> {
    if (!this.canDeleteSafe()) return;
    const chosen = this.chosen();
    if (!chosen.length) return;
    this.busy.set(true);
    try {
      await this.store.deleteLocalBranches(
        chosen.map((entry) => entry.name),
        false,
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
      this.selectedReasons.set(new Set(list.map((entry) => entry.reason)));
    } catch (err) {
      this.entries.set([]);
      this.selectedReasons.set(new Set());
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
      default:
        return reason;
    }
  }
}
