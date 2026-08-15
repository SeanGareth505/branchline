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
  readonly selected = signal<Set<string>>(new Set());
  readonly loading = signal(false);
  readonly busy = signal(false);
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

  readonly selectedCount = computed(() => this.selected().size);
  readonly hasSafeBranches = computed(() =>
    this.entries().some((entry) => entry.reason === 'merged' || entry.reason === 'gone'),
  );
  readonly canSubmit = computed(
    () => !this.loading() && !this.busy() && this.selectedCount() > 0,
  );
  readonly submitLabel = computed(() => (this.busy() ? 'Deleting…' : 'Delete selected'));

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

  isSelected(name: string): boolean {
    return this.selected().has(name);
  }

  toggle(name: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selected.update((set) => {
      const next = new Set(set);
      if (checked) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  selectMergedAndGone(): void {
    this.selected.update((set) => {
      const next = new Set(set);
      for (const entry of this.entries()) {
        if (entry.reason === 'merged' || entry.reason === 'gone') next.add(entry.name);
      }
      return next;
    });
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    const chosen = this.entries().filter((entry) => this.selected().has(entry.name));
    if (!chosen.length) return;
    const force = chosen.some((entry) => entry.reason !== 'merged' && entry.reason !== 'gone');
    if (force) {
      const n = chosen.length;
      const ok = await this.prompts.ask({
        title: 'Delete unmerged branches?',
        message: `Force-delete ${n} local branch${n === 1 ? '' : 'es'}. Commits that only exist on those branches may be hard to recover.`,
        confirmLabel: 'Delete',
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
        force,
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
    try {
      const list = await this.store.loadBranchHygiene();
      this.entries.set(list);
      this.selected.set(
        new Set(
          list
            .filter((entry) => entry.reason === 'merged' || entry.reason === 'gone')
            .map((entry) => entry.name),
        ),
      );
    } catch {
      this.entries.set([]);
      this.selected.set(new Set());
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
