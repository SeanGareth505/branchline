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
  selector: 'app-lfs-panel',
  imports: [NgIcon],
  templateUrl: './lfs-panel.html',
  styleUrl: './lfs-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LfsPanel {
  readonly store = inject(AppStore);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.store.lfsFiles();
    if (!q) return list;
    return list.filter((f) => f.path.toLowerCase().includes(q));
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

  fileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  }
}
