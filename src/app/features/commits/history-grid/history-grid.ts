import { Component, inject } from '@angular/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-history-grid',
  imports: [],
  templateUrl: './history-grid.html',
  styleUrl: './history-grid.scss',
})
export class HistoryGrid {
  readonly store = inject(AppStore);

  time(ts: number): string {
    return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true });
  }

  onRowClick(sha: string, event: MouseEvent): void {
    if (event.shiftKey) {
      this.store.toggleCompare(sha);
      this.store.selectCommit(sha);
      return;
    }
    this.store.selectCommit(sha, event.metaKey || event.ctrlKey);
  }

  chipClass(ref: string): string {
    if (ref.startsWith('tag:') || ref.startsWith('tags/')) return 'bl-chip bl-chip-tag';
    if (this.store.remoteBranches().some((b) => b.name === ref || b.name.endsWith('/' + ref))) {
      return 'bl-chip bl-chip-remote';
    }
    return 'bl-chip';
  }
}
