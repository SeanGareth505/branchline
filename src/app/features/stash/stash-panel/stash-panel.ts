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

@Component({
  selector: 'app-stash-panel',
  imports: [FormsModule, NgIcon],
  templateUrl: './stash-panel.html',
  styleUrl: './stash-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class StashPanel {
  readonly store = inject(AppStore);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();
  readonly message = signal('');
  readonly drafting = signal(false);

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

  startStash(event?: Event): void {
    event?.stopPropagation();
    this.drafting.set(true);
    this.message.set('');
    if (!this.expanded()) this.expandedChange.emit(true);
  }

  async push(): Promise<void> {
    await this.store.stashPush(this.message().trim() || undefined);
    this.drafting.set(false);
    this.message.set('');
  }
}
