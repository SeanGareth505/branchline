import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';

@Component({
  selector: 'app-worktrees-panel',
  imports: [FormsModule, NgIcon],
  templateUrl: './worktrees-panel.html',
  styleUrl: './worktrees-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorktreesPanel {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();
  readonly drafting = signal(false);
  readonly worktreePath = signal('');
  readonly branchName = signal('');
  readonly createBranch = signal(true);

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const trees = this.store.worktrees();
    if (!q) return trees;
    return trees.filter(
      (w) =>
        w.path.toLowerCase().includes(q) ||
        (w.branch ?? '').toLowerCase().includes(q) ||
        w.shortHead.toLowerCase().includes(q),
    );
  });

  readonly open = computed(() => {
    if (this.filter().trim()) return this.filtered().length > 0 || this.drafting();
    return this.expanded() || this.drafting();
  });

  toggle(event?: Event): void {
    event?.stopPropagation();
    if (this.filter().trim()) return;
    this.expandedChange.emit(!this.expanded());
  }

  chevron(): string {
    return this.open() ? 'lucideChevronDown' : 'lucideChevronRight';
  }

  startAdd(event?: Event): void {
    event?.stopPropagation();
    this.drafting.set(true);
    this.worktreePath.set('');
    this.branchName.set('');
    this.createBranch.set(true);
    if (!this.expanded()) this.expandedChange.emit(true);
  }

  folderName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  }

  async create(): Promise<void> {
    const wt = this.worktreePath().trim();
    const branch = this.branchName().trim();
    if (!wt) return;
    await this.store.addWorktree(wt, {
      branch: branch || undefined,
      createBranch: this.createBranch() && !!branch,
      startPoint: this.store.selectedSha() ?? undefined,
    });
    this.drafting.set(false);
  }

  async remove(path: string): Promise<void> {
    const ok = await this.prompts.ask({
      title: 'Remove worktree',
      message: `Remove worktree at ${path}? The branch is kept.`,
      label: 'Confirmation',
      initialValue: 'remove',
      confirmLabel: 'Remove',
      required: false,
    });
    if (ok === null) return;
    await this.store.removeWorktree(path);
  }
}
