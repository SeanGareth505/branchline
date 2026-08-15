import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { SearchHit } from '../../../core/models';

@Component({
  selector: 'app-file-search-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './file-search-dialog.html',
  styleUrl: './file-search-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileSearchDialog {
  readonly store = inject(AppStore);

  readonly query = signal('');
  readonly hits = signal<SearchHit[]>([]);
  readonly loading = signal(false);
  readonly activeIndex = signal(0);
  private searchGen = 0;
  private timer: number | null = null;

  readonly files = computed(() => this.hits().filter((h) => h.kind === 'file'));
  readonly content = computed(() => this.hits().filter((h) => h.kind !== 'file'));

  constructor() {
    effect(() => {
      if (!this.store.fileSearchOpen()) {
        this.query.set('');
        this.hits.set([]);
        this.activeIndex.set(0);
        return;
      }
    });
  }

  close(): void {
    this.store.closeFileSearch();
  }

  onQuery(value: string): void {
    this.query.set(value);
    this.scheduleSearch();
  }

  open(hit: SearchHit): void {
    this.store.openSearchHit(hit);
  }

  onQueryKeydown(event: KeyboardEvent): void {
    const items = this.hits();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.update((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.update((i) => Math.max(0, i - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const hit = items[this.activeIndex()];
      if (hit) this.open(hit);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.store.fileSearchOpen()) this.close();
  }

  private scheduleSearch(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.runSearch(), 160);
  }

  private async runSearch(): Promise<void> {
    const q = this.query().trim();
    if (q.length < 2) {
      this.hits.set([]);
      this.loading.set(false);
      return;
    }
    const gen = ++this.searchGen;
    this.loading.set(true);
    try {
      const hits = await this.store.searchRepo(q);
      if (gen !== this.searchGen) return;
      this.hits.set(hits);
      this.activeIndex.set(0);
    } catch (err) {
      if (gen !== this.searchGen) return;
      this.store.showError(err);
      this.hits.set([]);
    } finally {
      if (gen === this.searchGen) this.loading.set(false);
    }
  }
}
