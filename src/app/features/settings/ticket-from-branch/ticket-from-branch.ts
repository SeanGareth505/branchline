import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import type { TicketCase, TicketFromBranchSettings } from '../../../core/models';
import { formatConventionalHead } from '../../../core/commit-types';
import {
  DEFAULT_TICKET_FROM_BRANCH,
  branchSegments,
  customPatternError,
  extractTicketFromBranch,
} from '../../../shared/git/ticket-from-branch';

@Component({
  selector: 'app-ticket-from-branch',
  imports: [FormsModule],
  templateUrl: './ticket-from-branch.html',
  styleUrl: './ticket-from-branch.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TicketFromBranch {
  private readonly store = inject(AppStore);

  readonly tryBranch = signal('');
  readonly patternDraft = signal<string | null>(null);

  readonly settings = computed(() => this.store.settings().ticketFromBranch);

  readonly patternValue = computed(
    () => this.patternDraft() ?? this.settings().customPattern,
  );

  readonly previewBranch = computed(
    () =>
      this.tryBranch().trim() ||
      this.store.status()?.branch?.trim() ||
      'sotf/feature/sotf-123',
  );

  readonly segments = computed(() => branchSegments(this.previewBranch()));

  readonly previewSettings = computed(() => {
    const draft = this.patternDraft();
    if (draft === null) return this.settings();
    return { ...this.settings(), customPattern: draft };
  });

  readonly extracted = computed(() =>
    extractTicketFromBranch(this.previewBranch(), this.previewSettings()),
  );

  readonly patternError = computed(() => customPatternError(this.patternValue()));

  readonly exampleHead = computed(() =>
    formatConventionalHead({
      type: 'feat',
      scope: this.settings().putInScope ? this.extracted() ?? 'scope' : '',
      subject: 'describe the change',
    }),
  );

  readonly currentBranch = computed(() => this.store.status()?.branch?.trim() || '');

  selectedSegmentIndex(index: number): boolean {
    const s = this.settings();
    if (!s.useSegment) return false;
    const segs = this.segments();
    const resolved = s.segmentIndex < 0 ? segs.length - 1 : s.segmentIndex;
    return resolved === index;
  }

  async patch(partial: Partial<TicketFromBranchSettings>): Promise<void> {
    await this.store.saveSettings({
      ticketFromBranch: { ...this.settings(), ...partial },
    });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.patch({ enabled });
  }

  async setMatchTicketKey(matchTicketKey: boolean): Promise<void> {
    await this.patch({ matchTicketKey });
  }

  async setPutInScope(putInScope: boolean): Promise<void> {
    await this.patch({ putInScope });
  }

  async setTicketCase(ticketCase: TicketCase): Promise<void> {
    await this.patch({ ticketCase });
  }

  async setCustomPattern(customPattern: string): Promise<void> {
    this.patternDraft.set(customPattern);
  }

  async commitCustomPattern(): Promise<void> {
    const draft = this.patternDraft();
    if (draft === null) return;
    this.patternDraft.set(null);
    await this.patch({ customPattern: draft });
  }

  async pickSegment(index: number): Promise<void> {
    const segs = this.segments();
    const last = segs.length - 1;
    const already = this.selectedSegmentIndex(index) && this.settings().useSegment;
    if (already) {
      await this.patch({ useSegment: false });
      return;
    }
    await this.patch({
      useSegment: true,
      segmentIndex: index === last ? -1 : index,
    });
  }

  async useLastSegment(): Promise<void> {
    await this.patch({ useSegment: true, segmentIndex: -1 });
  }

  async resetDefaults(): Promise<void> {
    this.tryBranch.set('');
    this.patternDraft.set(null);
    await this.store.saveSettings({
      ticketFromBranch: { ...DEFAULT_TICKET_FROM_BRANCH },
    });
  }
}
