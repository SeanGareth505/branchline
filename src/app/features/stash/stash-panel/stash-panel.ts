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
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { AppStore } from '../../../core/app.store';
import type { StashEntry } from '../../../core/models';

@Component({
  selector: 'app-stash-panel',
  imports: [FormsModule, NgIcon, HelpTip],
  templateUrl: './stash-panel.html',
  styleUrl: './stash-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StashPanel {
  readonly store = inject(AppStore);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();
  readonly hide = output<void>();
  readonly message = signal('');
  readonly drafting = signal(false);
  readonly includeUntracked = signal(false);

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const stashes = this.store.stashes();
    if (!q) return stashes;
    return stashes.filter(
      (s) => s.id.toLowerCase().includes(q) || s.message.toLowerCase().includes(q),
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

  requestHide(event?: Event): void {
    event?.stopPropagation();
    this.hide.emit();
  }

  startStash(event?: Event): void {
    event?.stopPropagation();
    this.drafting.set(true);
    this.message.set('');
    this.includeUntracked.set(false);
    if (!this.expanded()) this.expandedChange.emit(true);
  }

  async push(): Promise<void> {
    await this.store.stashPush(this.message().trim() || undefined, this.includeUntracked());
    this.drafting.set(false);
    this.message.set('');
    this.includeUntracked.set(false);
  }

  dropAll(event?: Event): void {
    event?.stopPropagation();
    void this.store.stashClear();
  }

  showStash(entry: StashEntry): void {
    const sha = entry.sha?.trim();
    if (!sha) return;
    this.store.selectCommit(sha);
    this.store.setBrowseTab('diff');
  }
}
