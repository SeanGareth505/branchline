import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  HostListener,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { MockPullRequest, PrCopyFormat } from '../../../core/models';
import {
  prApprovals,
  prChangesRequested,
  prCheckFailed,
  prCheckPending,
  prCheckTotal,
  prMergeBlockReason,
  prPendingReviewers,
  prReadyToMerge,
} from '../../../core/models';
import { formatPullRequests, checkLine, reviewLine, sharedRepoPrefix } from '../pr-copy';
import { TauriService } from '../../../core/tauri.service';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { PageSkeleton } from '../../../shared/ui/page-skeleton/page-skeleton';
import { EmptyState } from '../../../shared/ui/empty-state/empty-state';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';

type SortKey = 'updated' | 'number' | 'title' | 'additions' | 'approvals' | 'checks';

@Component({
  selector: 'app-pr-panel',
  imports: [FormsModule, NgTemplateOutlet, NgIcon, HelpTip, PageSkeleton, EmptyState],
  templateUrl: './pr-panel.html',
  styleUrl: './pr-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrPanel {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);

  readonly prs = this.store.pullRequests;
  readonly loading = this.store.pullRequestsLoading;
  readonly liveError = this.store.pullRequestsError;
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
  readonly readyOnly = signal(false);
  readonly failingOnly = signal(false);
  readonly sortKey = signal<SortKey>('updated');
  readonly selected = signal<Set<string>>(new Set());
  readonly commentDraftId = signal<string | null>(null);
  readonly commentText = signal('');
  readonly changesDraftId = signal<string | null>(null);
  readonly changesText = signal('');
  readonly testing = signal(false);
  readonly copyMenuOpen = signal<'header' | 'list' | null>(null);
  readonly actingId = signal<string | null>(null);
  readonly copyFormats: { id: PrCopyFormat; label: string }[] = [
    { id: 'links', label: 'Links' },
    { id: 'markdown', label: 'Markdown' },
    { id: 'slack', label: 'Slack' },
    { id: 'standup', label: 'Standup' },
    { id: 'titles', label: 'Titles' },
    { id: 'refs', label: 'repo#number' },
    { id: 'checkout', label: 'Checkout commands' },
    { id: 'csv', label: 'CSV' },
  ];
  readonly mergeMenuId = signal<string | null>(null);

  readonly showingDummy = computed(
    () => this.store.isDummyBackend && !this.store.hasLinkedPrHost(),
  );
  readonly hasHost = computed(() => this.store.hasLinkedPrHost());
  readonly needsConnect = computed(() => !this.showingDummy() && !this.hasHost());

  readonly liveMode = computed(() => !this.showingDummy() && this.hasHost());
  readonly busy = computed(() => this.loading() || this.store.pullRequestsRefreshing());

  readonly connectionLabel = computed(() => {
    if (this.showingDummy()) {
      return 'Browser preview — sample PRs. Add a GitHub account under Settings → Connections for live PRs.';
    }
    if (this.hasHost()) {
      const n = this.prs().length;
      const updating = this.store.pullRequestsRefreshing() ? ' · updating…' : '';
      return `Live pull requests for this repo${n ? ` · ${n} loaded` : ''}${updating}.`;
    }
    return 'Add a GitHub account under Settings → Connections to load pull requests here.';
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
      if (this.needsMyReview() && !pr.needsMyReview) return false;
      if (this.team() !== 'all' && !sameName(pr.team, this.team())) return false;
      if (this.author() !== 'all' && !sameName(pr.author, this.author())) return false;
      if (this.reviewer() !== 'all' && !pr.reviewers.some((r) => sameName(r, this.reviewer()))) {
        return false;
      }
      if (this.repo() !== 'all' && pr.repo !== this.repo()) return false;
      if (this.label() !== 'all' && !pr.labels.includes(this.label())) return false;
      if (this.pipeline() !== 'all' && pr.pipelineStatus !== this.pipeline()) return false;
      if (this.review() !== 'all' && pr.reviewState !== this.review()) return false;
      if (this.readyOnly() && !prReadyToMerge(pr)) return false;
      if (this.failingOnly() && pr.pipelineStatus !== 'failure' && prCheckFailed(pr) === 0) return false;

      const status = this.status();
      if (status === 'draft') {
        if (!pr.draft || pr.status !== 'open') return false;
      } else if (status !== 'all' && pr.status !== status) {
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
      if (key === 'approvals') return prApprovals(b) - prApprovals(a);
      if (key === 'checks') return prCheckFailed(b) - prCheckFailed(a) || prCheckPending(b) - prCheckPending(a);
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
      failing: all.filter((p) => p.pipelineStatus === 'failure' || prCheckFailed(p) > 0).length,
      needsReview: all.filter((p) =>
        this.liveMode()
          ? p.needsMyReview
          : p.reviewState === 'pending' || p.reviewState === 'changesRequested',
      ).length,
      ready: all.filter((p) => prReadyToMerge(p)).length,
      approved: all.filter((p) => p.reviewState === 'approved').length,
      blocked: all.filter((p) => p.mergeable === false || p.mergeState === 'dirty' || p.mergeState === 'blocked').length,
    };
  });

  readonly hiddenCount = computed(() => Math.max(0, this.prs().length - this.filtered().length));

  readonly allFilteredSelected = computed(() => {
    const ids = this.filtered().map((p) => p.id);
    if (!ids.length) return false;
    const sel = this.selected();
    return ids.every((id) => sel.has(id));
  });

  readonly copyCounts = computed(() => {
    const filtered = this.filtered();
    const sel = this.selected();
    const all = this.prs();
    const open = all.filter((pr) => pr.status === 'open' && !pr.draft);
    const needsReview = (pr: MockPullRequest) =>
      this.liveMode()
        ? pr.needsMyReview
        : pr.reviewState === 'pending' || pr.reviewState === 'changesRequested';
    return {
      filtered: filtered.length,
      selected: filtered.filter((p) => sel.has(p.id)).length,
      open: open.length,
      ready: all.filter((pr) => prReadyToMerge(pr)).length,
      failing: all.filter((pr) => pr.pipelineStatus === 'failure' || prCheckFailed(pr) > 0).length,
      review: all.filter(needsReview).length,
      drafts: all.filter((pr) => pr.draft && pr.status === 'open').length,
      mine: all.filter((pr) => pr.isMine).length,
    };
  });

  readonly copyRepos = computed(() => {
    const names = this.repos();
    const prefix = sharedRepoPrefix(names);
    const open = this.prs().filter((pr) => pr.status === 'open' && !pr.draft);
    return names.map((name) => ({
      key: name,
      label: prefix && name.length > prefix.length ? name.slice(prefix.length) : name,
      count: open.filter((pr) => pr.repo === name).length,
    }));
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
      session.prSortKey === 'additions' ||
      session.prSortKey === 'approvals' ||
      session.prSortKey === 'checks'
    ) {
      this.sortKey.set(session.prSortKey);
    }

    effect(() => {
      this.store.currentRepo()?.path;
      this.store.hasLinkedPrHost();
      this.hasHost();
      const state = this.listState();
      void this.store.refreshPullRequests(state);
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

  connectHosts(): void {
    this.store.openSettings('connections', 'github');
  }

  reload(): void {
    void this.store.refreshPullRequests(this.listState(), { force: true });
  }

  async testConnection(): Promise<void> {
    if (this.testing()) return;
    const connections = this.store.settings().connections;
    const conn =
      connections.find((c) => c.provider === 'github' && this.store.isConnectionLinked(c)) ??
      connections.find(
        (c) =>
          (c.provider === 'gitlab' || c.provider === 'azureDevOps') &&
          this.store.isConnectionLinked(c),
      );
    if (!conn) {
      this.connectHosts();
      return;
    }
    this.testing.set(true);
    try {
      await this.store.testConnection({
        kind: conn.provider as 'github' | 'gitlab' | 'azureDevOps',
        connectionId: conn.id,
      });
    } finally {
      this.testing.set(false);
    }
  }

  createPr(): void {
    void this.store.openCreatePullRequest();
  }

  private listState(): 'open' | 'closed' | 'all' {
    const status = this.status();
    if (status === 'closed' || status === 'merged') return 'closed';
    if (status === 'all') return 'all';
    return 'open';
  }

  private canMutate(pr: MockPullRequest): boolean {
    return this.showingDummy() || (this.liveMode() && pr.id.startsWith('gh-'));
  }

  private openInstead(pr: MockPullRequest, action: string): void {
    this.store.showInfo(
      `${action} isn’t available for this host yet — opening #${pr.number} in the browser.`,
    );
    this.openBrowser(pr);
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
    this.readyOnly.set(false);
    this.failingOnly.set(false);
  }

  revealHidden(): void {
    this.query.set('');
    this.team.set('all');
    this.author.set('all');
    this.reviewer.set('all');
    this.pipeline.set('all');
    this.review.set('all');
    this.repo.set('all');
    this.label.set('all');
    this.mineOnly.set(false);
    this.needsMyReview.set(false);
    this.readyOnly.set(false);
    this.failingOnly.set(false);
    if (this.status() === 'draft') this.status.set('open');
  }

  applyStat(kind: 'open' | 'draft' | 'ready' | 'failing' | 'review' | 'approved'): void {
    if (kind === 'open') {
      this.status.set('open');
      return;
    }
    if (kind === 'draft') {
      this.status.set(this.status() === 'draft' ? 'open' : 'draft');
      return;
    }
    if (kind === 'ready') {
      this.readyOnly.update((v) => !v);
      if (!this.readyOnly()) return;
      this.failingOnly.set(false);
      this.status.set('open');
      return;
    }
    if (kind === 'failing') {
      this.failingOnly.update((v) => !v);
      return;
    }
    if (kind === 'review') {
      this.needsMyReview.update((v) => !v);
      if (this.needsMyReview()) this.mineOnly.set(false);
      return;
    }
    this.review.set(this.review() === 'approved' ? 'all' : 'approved');
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

  selectedPrs(): MockPullRequest[] {
    const sel = this.selected();
    return this.filtered().filter((p) => sel.has(p.id));
  }

  openPrs(repo = 'all'): MockPullRequest[] {
    return this.prs().filter(
      (pr) => pr.status === 'open' && !pr.draft && (repo === 'all' || pr.repo === repo),
    );
  }

  readyPrs(): MockPullRequest[] {
    return this.prs().filter((pr) => prReadyToMerge(pr));
  }

  failingPrs(): MockPullRequest[] {
    return this.prs().filter((pr) => pr.pipelineStatus === 'failure' || prCheckFailed(pr) > 0);
  }

  reviewPrs(): MockPullRequest[] {
    return this.prs().filter((pr) =>
      this.liveMode()
        ? pr.needsMyReview
        : pr.reviewState === 'pending' || pr.reviewState === 'changesRequested',
    );
  }

  draftPrs(): MockPullRequest[] {
    return this.prs().filter((pr) => pr.draft && pr.status === 'open');
  }

  minePrs(): MockPullRequest[] {
    return this.prs().filter((pr) => pr.isMine);
  }

  async copyFormat(format: PrCopyFormat, source: MockPullRequest[]): Promise<void> {
    this.copyMenuOpen.set(null);
    const text = formatPullRequests(source, format);
    const labels: Record<PrCopyFormat, string> = {
      links: 'link(s)',
      markdown: 'markdown row(s)',
      slack: 'Slack row(s)',
      standup: 'standup line(s)',
      titles: 'title(s)',
      refs: 'ref(s)',
      checkout: 'checkout command(s)',
      csv: 'CSV row(s)',
    };
    const count = source.length;
    await this.copy(text, `Copied ${count} ${labels[format]}`);
  }

  toggleCopyMenu(which: 'header' | 'list'): void {
    this.copyMenuOpen.update((open) => (open === which ? null : which));
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (this.copyMenuOpen() && !target.closest('.copy-wrap')) {
      this.copyMenuOpen.set(null);
    }
    if (this.mergeMenuId() && !target.closest('.merge-wrap')) {
      this.mergeMenuId.set(null);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.copyMenuOpen.set(null);
    this.mergeMenuId.set(null);
    this.cancelComment();
    this.cancelRequestChanges();
  }

  async copyOneLink(pr: MockPullRequest): Promise<void> {
    await this.copy(pr.url, `Copied #${pr.number}`);
  }

  async copyOneMarkdown(pr: MockPullRequest): Promise<void> {
    await this.copy(formatPullRequests([pr], 'markdown'), `Copied #${pr.number} markdown`);
  }

  async openBrowser(pr: MockPullRequest): Promise<void> {
    const url = pr.url?.trim();
    if (!url) {
      this.store.showWarning(`No URL for #${pr.number}`);
      return;
    }
    try {
      await this.tauri.openExternalUrl(url);
    } catch (err) {
      this.store.showError(err);
    }
  }

  checkoutPr(pr: MockPullRequest): void {
    void this.checkoutPrBranch(pr);
  }

  canReview(pr: MockPullRequest): boolean {
    return pr.status === 'open' && !pr.draft;
  }

  canApprove(pr: MockPullRequest): boolean {
    return this.canReview(pr) && !pr.isMine;
  }

  showReviewBar(pr: MockPullRequest): boolean {
    return pr.status === 'open' && this.canMutate(pr);
  }

  canReopen(pr: MockPullRequest): boolean {
    return pr.status === 'closed' && this.canMutate(pr);
  }

  canMergeNow(pr: MockPullRequest): boolean {
    return !prMergeBlockReason(pr);
  }

  mergeHint(pr: MockPullRequest): string {
    return prMergeBlockReason(pr) ?? 'Squash-merge into the target branch';
  }

  private me(): string {
    return this.prs().find((p) => p.isMine)?.author ?? (this.showingDummy() ? 'you' : '');
  }

  isAssignedToMe(pr: MockPullRequest): boolean {
    const me = this.me();
    if (!me) return pr.assignees.some((a) => a.toLowerCase() === 'you');
    return pr.assignees.some((a) => a.toLowerCase() === me.toLowerCase());
  }

  canRequestMyReview(pr: MockPullRequest): boolean {
    return this.canReview(pr) && !pr.isMine && this.canMutate(pr);
  }

  isActing(pr: MockPullRequest): boolean {
    return this.actingId() === pr.id;
  }

  async approve(pr: MockPullRequest): Promise<void> {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Approve');
      return;
    }
    if (!this.canApprove(pr)) {
      this.store.showWarning(
        pr.isMine
          ? `GitHub does not let you approve your own PR`
          : pr.draft
            ? `Mark #${pr.number} ready before reviewing`
            : `#${pr.number} is not open`,
      );
      return;
    }
    if (this.showingDummy()) {
      if (pr.reviewState === 'approved') {
        this.store.showInfo(`#${pr.number} is already approved`);
        return;
      }
      this.patchPr(pr.id, {
        reviewState: 'approved',
        updatedAt: new Date().toISOString(),
        reviewers: ensureYou(pr.reviewers),
        needsMyReview: false,
        approvals: Math.max(1, prApprovals(pr) + 1),
        approvedBy: [...new Set([...(pr.approvedBy ?? []), 'you'])],
      });
      this.store.showSuccess(`Approved #${pr.number}`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    try {
      await this.store.reviewPullRequest(pr, 'APPROVE');
    } finally {
      this.actingId.set(null);
    }
  }

  startRequestChanges(pr: MockPullRequest): void {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Request changes');
      return;
    }
    if (!this.canApprove(pr)) {
      this.store.showWarning(
        pr.isMine
          ? `GitHub does not let you request changes on your own PR`
          : pr.draft
            ? `Mark #${pr.number} ready before reviewing`
            : `#${pr.number} is not open`,
      );
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

  async submitRequestChanges(pr: MockPullRequest): Promise<void> {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Request changes');
      return;
    }
    const note = this.changesText().trim();
    if (!note) {
      this.store.showWarning('Add a short note explaining the requested changes');
      return;
    }
    if (this.showingDummy()) {
      this.patchPr(pr.id, {
        reviewState: 'changesRequested',
        commentCount: pr.commentCount + 1,
        updatedAt: new Date().toISOString(),
        reviewers: ensureYou(pr.reviewers),
        needsMyReview: false,
        changesRequested: Math.max(1, prChangesRequested(pr)),
        requestedChangesBy: [...new Set([...(pr.requestedChangesBy ?? []), 'you'])],
        readyToMerge: false,
      });
      this.cancelRequestChanges();
      this.store.showWarning(`Requested changes on #${pr.number}`);
      return;
    }
    this.actingId.set(pr.id);
    try {
      const ok = await this.store.reviewPullRequest(pr, 'REQUEST_CHANGES', note);
      if (ok) this.cancelRequestChanges();
    } finally {
      this.actingId.set(null);
    }
  }

  startComment(pr: MockPullRequest): void {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Comment');
      return;
    }
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

  async submitComment(pr: MockPullRequest): Promise<void> {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Comment');
      return;
    }
    const body = this.commentText().trim();
    if (!body) {
      this.store.showWarning('Write a comment before posting');
      return;
    }
    if (this.showingDummy()) {
      this.patchPr(pr.id, {
        commentCount: pr.commentCount + 1,
        updatedAt: new Date().toISOString(),
      });
      this.cancelComment();
      this.store.showSuccess(`Commented on #${pr.number}`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    try {
      const ok = await this.store.reviewPullRequest(pr, 'COMMENT', body);
      if (ok) this.cancelComment();
    } finally {
      this.actingId.set(null);
    }
  }

  async merge(pr: MockPullRequest, method: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<void> {
    this.mergeMenuId.set(null);
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Merge');
      return;
    }
    const blocked = prMergeBlockReason(pr);
    if (blocked) {
      this.store.showWarning(`#${pr.number}: ${blocked}`);
      return;
    }
    const methodLabel =
      method === 'merge' ? 'Merge commit' : method === 'rebase' ? 'Rebase-merge' : 'Squash-merge';
    const confirmed = await this.prompts.ask({
      title: `${methodLabel} #${pr.number}?`,
      message: `Merge “${pr.title}” into ${pr.targetBranch}.`,
      confirmLabel: methodLabel,
      cancelLabel: 'Cancel',
      required: false,
      confirmOnly: true,
    });
    if (confirmed === null) return;
    if (this.showingDummy()) {
      this.patchPr(pr.id, {
        status: 'merged',
        updatedAt: new Date().toISOString(),
        readyToMerge: false,
      });
      this.store.showSuccess(`Merged #${pr.number} into ${pr.targetBranch}`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    try {
      await this.store.mergePullRequest(pr, method);
    } finally {
      this.actingId.set(null);
    }
  }

  async closePr(pr: MockPullRequest): Promise<void> {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Close');
      return;
    }
    if (pr.status !== 'open') {
      this.store.showInfo(`#${pr.number} is already ${pr.status}`);
      return;
    }
    const confirmed = await this.prompts.ask({
      title: `Close #${pr.number}?`,
      message: `Close “${pr.title}” without merging.`,
      confirmLabel: 'Close',
      cancelLabel: 'Keep open',
      required: false,
      confirmOnly: true,
    });
    if (confirmed === null) return;
    if (this.showingDummy()) {
      this.patchPr(pr.id, {
        status: 'closed',
        draft: false,
        updatedAt: new Date().toISOString(),
        readyToMerge: false,
      });
      this.store.showInfo(`Closed #${pr.number}`);
      return;
    }
    this.actingId.set(pr.id);
    try {
      await this.store.updatePullRequest(pr, { state: 'closed' });
    } finally {
      this.actingId.set(null);
    }
  }

  async reopenPr(pr: MockPullRequest): Promise<void> {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Reopen');
      return;
    }
    if (pr.status !== 'closed') {
      this.store.showInfo(`#${pr.number} is ${pr.status}`);
      return;
    }
    if (this.showingDummy()) {
      this.patchPr(pr.id, {
        status: 'open',
        updatedAt: new Date().toISOString(),
      });
      this.store.showSuccess(`Reopened #${pr.number}`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    try {
      await this.store.updatePullRequest(pr, { state: 'open' });
    } finally {
      this.actingId.set(null);
    }
  }

  async markReady(pr: MockPullRequest): Promise<void> {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Mark ready');
      return;
    }
    if (!pr.draft || pr.status !== 'open') {
      this.store.showInfo(`#${pr.number} is already ready for review`);
      return;
    }
    if (this.showingDummy()) {
      this.patchPr(pr.id, {
        draft: false,
        updatedAt: new Date().toISOString(),
      });
      this.store.showSuccess(`Marked #${pr.number} ready for review`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    try {
      await this.store.updatePullRequest(pr, { ready: true });
    } finally {
      this.actingId.set(null);
    }
  }

  assignMyself(pr: MockPullRequest): void {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Assign');
      return;
    }
    if (this.isAssignedToMe(pr)) {
      this.store.showInfo(`You are already assigned to #${pr.number}`);
      return;
    }
    if (this.showingDummy()) {
      const me = this.me() || 'you';
      this.patchPr(pr.id, {
        assignees: [...pr.assignees, me],
        updatedAt: new Date().toISOString(),
      });
      this.store.showSuccess(`Assigned yourself to #${pr.number}`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    void this.store.updatePullRequest(pr, { assignMe: true }).finally(() => this.actingId.set(null));
  }

  requestMyReview(pr: MockPullRequest): void {
    if (!this.canMutate(pr)) {
      this.openInstead(pr, 'Request review');
      return;
    }
    if (!this.canRequestMyReview(pr)) {
      this.store.showWarning(
        pr.isMine ? `You cannot review your own pull request` : `#${pr.number} is not open for review`,
      );
      return;
    }
    if (
      pr.needsMyReview ||
      (this.me() && pr.reviewers.some((r) => r.toLowerCase() === this.me().toLowerCase()))
    ) {
      this.store.showInfo(`You are already a reviewer on #${pr.number}`);
      return;
    }
    if (this.showingDummy()) {
      const me = this.me() || 'you';
      this.patchPr(pr.id, {
        reviewers: [...pr.reviewers, me],
        needsMyReview: true,
        reviewState: pr.reviewState === 'approved' ? 'pending' : pr.reviewState,
        updatedAt: new Date().toISOString(),
      });
      this.store.showSuccess(`Added you as reviewer on #${pr.number}`, undefined, 'prActivity');
      return;
    }
    this.actingId.set(pr.id);
    void this.store.updatePullRequest(pr, { requestMyReview: true }).finally(() => this.actingId.set(null));
  }

  private patchPr(id: string, partial: Partial<MockPullRequest>): void {
    this.store.patchPullRequest(id, partial);
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

  reviewCountLabel(pr: MockPullRequest): string {
    return reviewLine(pr);
  }

  checkCountLabel(pr: MockPullRequest): string {
    return checkLine(pr);
  }

  mergeStateLabel(pr: MockPullRequest): string | null {
    if (prReadyToMerge(pr)) return 'Ready to merge';
    const state = (pr.mergeState ?? '').toLowerCase();
    if (pr.mergeable === false || state === 'dirty' || state === 'conflicting') return 'Conflicts';
    if (state === 'blocked') return 'Blocked';
    if (state === 'behind') return 'Behind base';
    if (state === 'unstable') return 'Unstable';
    return null;
  }

  approvedNames(pr: MockPullRequest): string {
    return (pr.approvedBy ?? []).map((n) => `@${n}`).join(', ');
  }

  changesNames(pr: MockPullRequest): string {
    return (pr.requestedChangesBy ?? []).map((n) => `@${n}`).join(', ');
  }

  waitingCount(pr: MockPullRequest): number {
    return prPendingReviewers(pr);
  }

  checkTone(pr: MockPullRequest): string {
    if (prCheckFailed(pr) > 0 || pr.pipelineStatus === 'failure') return 'failure';
    if (prCheckPending(pr) > 0 || pr.pipelineStatus === 'pending') return 'pending';
    if (prCheckTotal(pr) > 0 || pr.pipelineStatus === 'success') return 'success';
    return 'unknown';
  }

  reviewLabel(state: string): string {
    switch (state) {
      case 'approved':
        return 'Approved';
      case 'changesRequested':
        return 'Changes requested';
      case 'unknown':
        return 'Review n/a';
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

function ensureYou(reviewers: string[]): string[] {
  return reviewers.includes('you') ? reviewers : [...reviewers, 'you'];
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}
