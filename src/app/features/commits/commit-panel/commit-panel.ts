import { Component, computed, inject } from '@angular/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-commit-panel',
  imports: [],
  templateUrl: './commit-panel.html',
  styleUrl: './commit-panel.scss',
})
export class CommitPanel {
  readonly store = inject(AppStore);

  readonly parentEntries = computed(() => {
    const commit = this.store.selectedCommit();
    if (!commit) return [];
    return commit.parents.map((raw) => {
      const resolved = this.resolveCommit(raw);
      return {
        raw,
        sha: resolved?.sha ?? null,
        short: resolved?.shortSha ?? raw.slice(0, 7),
        subject: resolved?.subject ?? '',
      };
    });
  });

  readonly childEntries = computed(() => {
    const commit = this.store.selectedCommit();
    if (!commit) return [];
    return this.store
      .commits()
      .filter((c) => c.parents.some((p) => this.matchesSha(p, commit.sha)))
      .slice(0, 8)
      .map((c) => ({
        sha: c.sha,
        short: c.shortSha,
        subject: c.subject,
      }));
  });

  time(ts: number): string {
    return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true });
  }

  parentRole(index: number, total: number): string {
    if (total <= 1) return 'Parent';
    if (index === 0) return '1st';
    if (index === 1) return '2nd';
    return `${index + 1}th`;
  }

  goToCommit(sha: string): void {
    this.store.selectCommit(sha);
  }

  openCommitModal(): void {
    this.store.openCommitModal();
  }

  async copySha(sha: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(sha);
      this.store.showSuccess(`Copied ${sha.slice(0, 7)}`);
    } catch {
      this.store.showError('Could not copy SHA');
    }
  }

  chipClass(ref: string): string {
    if (ref.startsWith('tag:') || ref.startsWith('tags/')) return 'bl-chip bl-chip-tag';
    if (ref === 'HEAD') return 'bl-chip bl-chip-head';
    if (this.store.remoteBranches().some((b) => b.name === ref || b.name.endsWith('/' + ref))) {
      return 'bl-chip bl-chip-remote';
    }
    return 'bl-chip';
  }

  private resolveCommit(raw: string) {
    const commits = this.store.commits();
    return (
      commits.find((c) => c.sha === raw || c.shortSha === raw) ??
      commits.find((c) => c.sha.startsWith(raw) || raw.startsWith(c.sha.slice(0, raw.length))) ??
      null
    );
  }

  private matchesSha(raw: string, full: string): boolean {
    return raw === full || full.startsWith(raw) || raw.startsWith(full.slice(0, raw.length));
  }
}
