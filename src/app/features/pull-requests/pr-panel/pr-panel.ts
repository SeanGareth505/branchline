import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { MockPullRequest } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';

type SortKey = 'updated' | 'number' | 'title' | 'additions';

@Component({
  selector: 'app-pr-panel',
  imports: [FormsModule, NgIcon],
  templateUrl: './pr-panel.html',
  styleUrl: './pr-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrPanel {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);

  readonly prs = signal<MockPullRequest[]>([]);
  readonly query = signal('');
  readonly status = signal<'all' | 'open' | 'draft' | 'merged' | 'closed'>('open');
  readonly team = signal('all');
  readonly author = signal('all');
  readonly reviewer = signal('all');
  readonly pipeline = signal('all');
  readonly review = signal('all');
  readonly repo = signal('all');
  readonly label = signal('all');
  readonly mineOnly = signal(false);
  readonly needsMyReview = signal(false);
  readonly sortKey = signal<SortKey>('updated');
  readonly selected = signal<Set<string>>(new Set());
  readonly commentDraftId = signal<string | null>(null);
  readonly commentText = signal('');
  readonly changesDraftId = signal<string | null>(null);
  readonly changesText = signal('');

  readonly showingDummy = computed(() => !this.store.hasLinkedPrHost());

  connectHosts(): void {
    this.store.openSettings('connections', 'github');
  }

  readonly connectionLabel = computed(() => {
    if (this.showingDummy()) {
      return 'DUMMY DATA — sample PRs for UI preview. Link GitHub, GitLab, or Azure DevOps under Settings → Connections to hide them.';
    }
    const hosts = this.store
      .settings()
      .connections.filter(
        (c) =>
          c.enabled &&
          (c.hasToken || c.token.trim()) &&
          (c.provider === 'github' || c.provider === 'gitlab' || c.provider === 'azureDevOps'),
      );
    return `Linked to ${hosts.map((h) => h.label).join(', ')}. Dummy PRs removed — live sync ships next.`;
  });

  readonly teams = computed(() => this.unique((p) => p.team));
  readonly authors = computed(() => this.unique((p) => p.author));
  readonly reviewers = computed(() =>
    [...new Set(this.prs().flatMap((p) => p.reviewers))].sort(),
  );
  readonly repos = computed(() => this.unique((p) => p.repo));
  readonly labels = computed(() =>
    [...new Set(this.prs().flatMap((p) => p.labels))].sort(),
  );

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    let list = this.prs().filter((pr) => {
      if (this.mineOnly() && !pr.isMine) return false;
      if (this.needsMyReview() && !pr.reviewers.includes('you')) return false;
      if (this.team() !== 'all' && pr.team !== this.team()) return false;
      if (this.author() !== 'all' && pr.author !== this.author()) return false;
      if (this.reviewer() !== 'all' && !pr.reviewers.includes(this.reviewer())) return false;
      if (this.repo() !== 'all' && pr.repo !== this.repo()) return false;
      if (this.label() !== 'all' && !pr.labels.includes(this.label())) return false;
      if (this.pipeline() !== 'all' && pr.pipelineStatus !== this.pipeline()) return false;
      if (this.review() !== 'all' && pr.reviewState !== this.review()) return false;

      const status = this.status();
      if (status === 'draft') {
        if (!pr.draft || pr.status !== 'open') return false;
      } else if (status !== 'all' && pr.status !== status) {
        return false;
      } else if (status === 'open' && pr.draft) {
        return false;
      }

      if (!q) return true;
      const hay = [
        pr.title,
        String(pr.number),
        pr.author,
        pr.team,
        pr.repo,
        pr.sourceBranch,
        pr.targetBranch,
        ...pr.labels,
        ...pr.reviewers,
        ...pr.assignees,
      ]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

    const key = this.sortKey();
    list = [...list].sort((a, b) => {
      if (key === 'number') return b.number - a.number;
      if (key === 'title') return a.title.localeCompare(b.title);
      if (key === 'additions') return b.additions - a.additions;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return list;
  });

  readonly stats = computed(() => {
    const all = this.filtered();
    return {
      total: all.length,
      open: all.filter((p) => p.status === 'open' && !p.draft).length,
      draft: all.filter((p) => p.draft).length,
      failing: all.filter((p) => p.pipelineStatus === 'failure').length,
      needsReview: all.filter((p) => p.reviewState === 'pending' || p.reviewState === 'changesRequested')
        .length,
    };
  });

  readonly allFilteredSelected = computed(() => {
    const ids = this.filtered().map((p) => p.id);
    if (!ids.length) return false;
    const sel = this.selected();
    return ids.every((id) => sel.has(id));
  });

  constructor() {
    const session = this.store.readSession();
    if (session.prStatus === 'all' || session.prStatus === 'open' || session.prStatus === 'draft' || session.prStatus === 'merged' || session.prStatus === 'closed') {
      this.status.set(session.prStatus);
    }
    if (typeof session.prMineOnly === 'boolean') this.mineOnly.set(session.prMineOnly);
    if (typeof session.prNeedsMyReview === 'boolean') this.needsMyReview.set(session.prNeedsMyReview);
    if (typeof session.prReview === 'string' && session.prReview) this.review.set(session.prReview);
    if (
      session.prSortKey === 'updated' ||
      session.prSortKey === 'number' ||
      session.prSortKey === 'title' ||
      session.prSortKey === 'additions'
    ) {
      this.sortKey.set(session.prSortKey);
    }

    effect(() => {
      this.store.settings();
      void this.reloadPrs();
    });

    effect(() => {
      const status = this.status();
      const mineOnly = this.mineOnly();
      const needsMyReview = this.needsMyReview();
      const review = this.review();
      const sortKey = this.sortKey();
      untracked(() => {
        this.store.patchSession({
          prStatus: status,
          prMineOnly: mineOnly,
          prNeedsMyReview: needsMyReview,
          prReview: review,
          prSortKey: sortKey,
        });
      });
    });
  }

  private async reloadPrs(): Promise<void> {
    if (this.store.hasLinkedPrHost()) {
      this.prs.set([]);
      this.selected.set(new Set());
      return;
    }
    this.prs.set(await this.tauri.listMockPullRequests());
  }

  clearFilters(): void {
    this.query.set('');
    this.status.set('open');
    this.team.set('all');
    this.author.set('all');
    this.reviewer.set('all');
    this.pipeline.set('all');
    this.review.set('all');
    this.repo.set('all');
    this.label.set('all');
    this.mineOnly.set(false);
    this.needsMyReview.set(false);
  }

  toggleSelect(id: string): void {
    const next = new Set(this.selected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected.set(next);
  }

  toggleSelectAllFiltered(): void {
    if (this.allFilteredSelected()) {
      this.selected.set(new Set());
      return;
    }
    this.selected.set(new Set(this.filtered().map((p) => p.id)));
  }

  selectedOrFiltered(): MockPullRequest[] {
    const sel = this.selected();
    const filtered = this.filtered();
    const picked = filtered.filter((p) => sel.has(p.id));
    return picked.length ? picked : filtered;
  }

  async copyLinks(): Promise<void> {
    const text = this.selectedOrFiltered()
      .map((p) => p.url)
      .join('\n');
    await this.copy(text, `Copied ${text.split('\n').filter(Boolean).length} PR link(s)`);
  }

  async copyMarkdown(): Promise<void> {
    const text = this.selectedOrFiltered()
      .map((p) => `- [#${p.number}](${p.url}) ${p.title}`)
      .join('\n');
    await this.copy(text, 'Copied markdown list');
  }

  async copyTitles(): Promise<void> {
    const text = this.selectedOrFiltered()
      .map((p) => `#${p.number} ${p.title} — ${p.url}`)
      .join('\n');
    await this.copy(text, 'Copied titles + links');
  }

  async copyCsv(): Promise<void> {
    const rows = [
      ['number', 'title', 'author', 'team', 'status', 'pipeline', 'url'].join(','),
      ...this.selectedOrFiltered().map((p) =>
        [
          p.number,
          csv(p.title),
          p.author,
          csv(p.team),
          p.draft ? 'draft' : p.status,
          p.pipelineStatus,
          p.url,
        ].join(','),
      ),
    ];
    await this.copy(rows.join('\n'), 'Copied CSV');
  }

  async copyCheckoutCommands(): Promise<void> {
    const text = this.selectedOrFiltered()
      .map(
        (p) =>
          `git fetch origin pull/${p.number}/head:pr/${p.number} && git checkout pr/${p.number}`,
      )
      .join('\n');
    await this.copy(text, 'Copied checkout commands');
  }

  async copyOneLink(pr: MockPullRequest): Promise<void> {
    await this.copy(pr.url, `Copied #${pr.number}`);
  }

  openBrowser(pr: MockPullRequest): void {
    window.open(pr.url, '_blank', 'noopener');
  }

  checkoutPr(pr: MockPullRequest): void {
    void this.checkoutPrBranch(pr);
  }

  canReview(pr: MockPullRequest): boolean {
    return pr.status === 'open' && !pr.draft;
  }

  approve(pr: MockPullRequest): void {
    if (!this.canReview(pr)) {
      this.store.showWarning(pr.draft ? `Mark #${pr.number} ready before reviewing` : `#${pr.number} is not open`);
      return;
    }
    if (pr.reviewState === 'approved') {
      this.store.showInfo(`#${pr.number} is already approved`);
      return;
    }
    this.patchPr(pr.id, {
      reviewState: 'approved',
      updatedAt: new Date().toISOString(),
      reviewers: ensureYou(pr.reviewers),
    });
    this.store.showSuccess(`DUMMY: approved #${pr.number}`);
  }

  startRequestChanges(pr: MockPullRequest): void {
    if (!this.canReview(pr)) {
      this.store.showWarning(pr.draft ? `Mark #${pr.number} ready before reviewing` : `#${pr.number} is not open`);
      return;
    }
    this.commentDraftId.set(null);
    this.commentText.set('');
    this.changesDraftId.set(pr.id);
    this.changesText.set('');
  }

  cancelRequestChanges(): void {
    this.changesDraftId.set(null);
    this.changesText.set('');
  }

  submitRequestChanges(pr: MockPullRequest): void {
    const note = this.changesText().trim();
    if (!note) {
      this.store.showWarning('Add a short note explaining the requested changes');
      return;
    }
    this.patchPr(pr.id, {
      reviewState: 'changesRequested',
      commentCount: pr.commentCount + 1,
      updatedAt: new Date().toISOString(),
      reviewers: ensureYou(pr.reviewers),
    });
    this.cancelRequestChanges();
    this.store.showWarning(`DUMMY: requested changes on #${pr.number}`);
  }

  startComment(pr: MockPullRequest): void {
    if (pr.status === 'closed' || pr.status === 'merged') {
      this.store.showWarning(`#${pr.number} is ${pr.status} — comments are read-only here`);
      return;
    }
    this.changesDraftId.set(null);
    this.changesText.set('');
    this.commentDraftId.set(pr.id);
    this.commentText.set('');
  }

  cancelComment(): void {
    this.commentDraftId.set(null);
    this.commentText.set('');
  }

  submitComment(pr: MockPullRequest): void {
    const body = this.commentText().trim();
    if (!body) {
      this.store.showWarning('Write a comment before posting');
      return;
    }
    this.patchPr(pr.id, {
      commentCount: pr.commentCount + 1,
      updatedAt: new Date().toISOString(),
    });
    this.cancelComment();
    this.store.showSuccess(`DUMMY: commented on #${pr.number}`);
  }

  merge(pr: MockPullRequest): void {
    if (!this.canReview(pr)) {
      this.store.showWarning(pr.draft ? `Mark #${pr.number} ready before merging` : `#${pr.number} cannot be merged`);
      return;
    }
    if (pr.pipelineStatus === 'failure') {
      this.store.showError('CI is failing — fix checks before merging');
      return;
    }
    if (pr.reviewState === 'changesRequested') {
      this.store.showWarning(`#${pr.number} still has requested changes`);
      return;
    }
    if (pr.reviewState !== 'approved') {
      this.store.showWarning(`#${pr.number} is not approved yet`);
      return;
    }
    this.patchPr(pr.id, {
      status: 'merged',
      updatedAt: new Date().toISOString(),
    });
    this.store.showSuccess(`DUMMY: merged #${pr.number} into ${pr.targetBranch}`);
  }

  closePr(pr: MockPullRequest): void {
    if (pr.status !== 'open') {
      this.store.showInfo(`#${pr.number} is already ${pr.status}`);
      return;
    }
    this.patchPr(pr.id, {
      status: 'closed',
      draft: false,
      updatedAt: new Date().toISOString(),
    });
    this.store.showInfo(`DUMMY: closed #${pr.number}`);
  }

  markReady(pr: MockPullRequest): void {
    if (!pr.draft || pr.status !== 'open') {
      this.store.showInfo(`#${pr.number} is already ready for review`);
      return;
    }
    this.patchPr(pr.id, {
      draft: false,
      updatedAt: new Date().toISOString(),
    });
    this.store.showSuccess(`DUMMY: marked #${pr.number} ready for review`);
  }

  assignMyself(pr: MockPullRequest): void {
    if (pr.assignees.includes('you')) {
      this.store.showInfo(`You are already assigned to #${pr.number}`);
      return;
    }
    this.patchPr(pr.id, {
      assignees: [...pr.assignees, 'you'],
      updatedAt: new Date().toISOString(),
    });
    this.store.showSuccess(`DUMMY: assigned yourself to #${pr.number}`);
  }

  requestMyReview(pr: MockPullRequest): void {
    if (!this.canReview(pr)) {
      this.store.showWarning(`#${pr.number} is not open for review`);
      return;
    }
    if (pr.reviewers.includes('you')) {
      this.store.showInfo(`You are already a reviewer on #${pr.number}`);
      return;
    }
    this.patchPr(pr.id, {
      reviewers: [...pr.reviewers, 'you'],
      reviewState: pr.reviewState === 'approved' ? 'pending' : pr.reviewState,
      updatedAt: new Date().toISOString(),
    });
    this.store.showSuccess(`DUMMY: added you as reviewer on #${pr.number}`);
  }

  private patchPr(id: string, partial: Partial<MockPullRequest>): void {
    this.prs.update((list) => list.map((p) => (p.id === id ? { ...p, ...partial } : p)));
  }

  private async checkoutPrBranch(pr: MockPullRequest): Promise<void> {
    const path = this.store.currentRepo()?.path;
    if (!path) {
      this.store.showWarning('Open a repository first');
      return;
    }
    try {
      const local = `pr/${pr.number}`;
      const fetched = await this.tauri.runGitCommand(path, [
        'fetch',
        'origin',
        `pull/${pr.number}/head:${local}`,
      ]);
      if (fetched.ok) {
        await this.store.checkoutBranch(local);
        return;
      }
      await this.store.createBranch(local, `origin/${pr.sourceBranch}`);
    } catch (err) {
      this.store.showError(err);
    }
  }

  time(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return formatDistanceToNowStrict(date, { addSuffix: true });
  }

  reviewLabel(state: string): string {
    switch (state) {
      case 'approved':
        return 'Approved';
      case 'changesRequested':
        return 'Changes requested';
      default:
        return 'Review pending';
    }
  }

  private unique(pick: (p: MockPullRequest) => string): string[] {
    return [...new Set(this.prs().map(pick).filter(Boolean))].sort();
  }

  private async copy(text: string, ok: string): Promise<void> {
    if (!text.trim()) {
      this.store.showWarning('Nothing to copy — adjust filters');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.store.showSuccess(ok);
    } catch {
      this.store.showError('Could not copy to clipboard');
    }
  }
}

function csv(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

function ensureYou(reviewers: string[]): string[] {
  return reviewers.includes('you') ? reviewers : [...reviewers, 'you'];
}
