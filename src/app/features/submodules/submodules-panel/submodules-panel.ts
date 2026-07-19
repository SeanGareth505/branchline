import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-submodules-panel',
  imports: [NgIcon],
  templateUrl: './submodules-panel.html',
  styleUrl: './submodules-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubmodulesPanel {
  readonly store = inject(AppStore);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.store.submodules();
    if (!q) return list;
    return list.filter(
      (s) =>
        s.path.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.url.toLowerCase().includes(q),
    );
  });

  readonly open = computed(() => {
    if (this.filter().trim()) return this.filtered().length > 0;
    return this.expanded();
  });

  toggle(event?: Event): void {
    event?.stopPropagation();
    if (this.filter().trim()) return;
    this.expandedChange.emit(!this.expanded());
  }

  chevron(): string {
    return this.open() ? 'lucideChevronDown' : 'lucideChevronRight';
  }
}
