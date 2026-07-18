import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import Fuse from 'fuse.js';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-global-search',
  imports: [FormsModule],
  templateUrl: './global-search.html',
  styleUrl: './global-search.scss',
})
export class GlobalSearch {
  readonly store = inject(AppStore);
  readonly query = signal('');

  readonly results = computed(() => {
    const q = this.query().trim();
    const commits = this.store.commits().map((c) => ({
      id: c.sha,
      label: `${c.shortSha} ${c.subject}`,
      kind: 'commit' as const,
    }));
    const repos = this.store.repos().map((r) => ({
      id: r.path,
      label: r.name,
      kind: 'repo' as const,
    }));
    const items = [...repos, ...commits];
    if (!q) return items.slice(0, 20);
    return new Fuse(items, { keys: ['label'], threshold: 0.4 }).search(q).map((r) => r.item);
  });

  select(item: { id: string; kind: 'commit' | 'repo' }): void {
    if (item.kind === 'repo') {
      void this.store.openRepo(item.id);
    } else {
      this.store.selectCommit(item.id);
      this.store.setView('browse');
    }
  }
}
