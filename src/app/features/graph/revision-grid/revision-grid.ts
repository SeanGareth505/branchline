import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import { CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { ArtificialCommit, CommitInfo, RevisionGridColumns } from '../../../core/models';
import {
  COL_PAD,
  GRID_COL_IDS,
  GRID_COL_SAMPLE,
  clampColWidth,
  measureTextWidth,
  sampleStride,
  type GridColId,
} from '../../../core/revision-grid-columns';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';
import {
  ROW_HEIGHT,
  buildGraphLayout,
  graphContentWidthForLanes,
  graphWidthForLanes,
  edgeWidthForPitch,
  lanePitch,
  laneX,
  linkPath,
  nodeRadiusForPitch,
  type GraphLink,
  type GraphNode,
} from '../graph-layout';

interface LinkView {
  key: string;
  d: string;
  stroke: string;
  mergeParent: boolean;
  lineage: boolean;
  from: number;
  to: number;
}

interface RefChipView {
  ref: string;
  className: string;
  title: string;
  disabled: boolean;
}

interface StaticRowView {
  id: string;
  node: GraphNode;
  alt: boolean;
  artificial: boolean;
  head: boolean;
  cx: number;
  nodeFill: string;
  art?: ArtificialCommit;
  commit?: CommitInfo;
}

@Component({
  selector: 'app-revision-grid',
  imports: [
    FormsModule,
    NgIcon,
    CdkConnectedOverlay,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    Skeleton,
  ],
  templateUrl: './revision-grid.html',
  styleUrl: './revision-grid.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RevisionGrid {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  private readonly viewport = viewChild(CdkVirtualScrollViewport);
  private readonly headerRef = viewChild<ElementRef<HTMLElement>>('header');

  readonly rowHeight = ROW_HEIGHT;
  readonly skeletonRows = [
    { message: '15.2rem', author: '5.4rem' },
    { message: '11.6rem', author: '4.1rem' },
    { message: '17.8rem', author: '6.2rem' },
    { message: '9.8rem', author: '4.8rem' },
    { message: '13.4rem', author: '5.1rem' },
    { message: '16.1rem', author: '3.9rem' },
    { message: '10.4rem', author: '5.8rem' },
    { message: '14.7rem', author: '4.5rem' },
    { message: '12.2rem', author: '6.0rem' },
    { message: '18.4rem', author: '4.3rem' },
    { message: '8.9rem', author: '5.6rem' },
    { message: '13.9rem', author: '4.7rem' },
    { message: '16.6rem', author: '5.3rem' },
    { message: '11.1rem', author: '4.0rem' },
    { message: '14.3rem', author: '5.9rem' },
    { message: '9.5rem', author: '4.6rem' },
  ];
  readonly queryDraft = signal(this.store.historyFilter().query);
  readonly authorDraft = signal(this.store.historyFilter().author);
  private filterTimer: number | null = null;

  readonly menu = signal<{ open: boolean; x: number; y: number; sha: string; priorSha: string | null }>({
    open: false,
    x: 0,
    y: 0,
    sha: '',
    priorSha: null,
  });
  private suppressMenuCloseUntil = 0;

  readonly menuOrigin = computed(() => ({ x: this.menu().x, y: this.menu().y }));

  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
  ];

  readonly filterActive = computed(() => {
    const f = this.store.historyFilter();
    return !!(f.query.trim() || f.author.trim() || f.currentBranchOnly || f.mineOnly || f.firstParent);
  });

  readonly dropTargetSha = signal<string | null>(null);
  private dragSha: string | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.endResize());
    effect(() => {
      const reveal = this.store.graphReveal();
      if (!reveal) return;
      const sha = reveal.sha;
      untracked(() => this.scheduleScrollToSha(sha));
    });
    effect(() => {
      const max = Math.max(0, this.graphContentWidth() - this.displayGraphWidth());
      const left = untracked(() => this.graphScrollLeft());
      if (left > max) this.graphScrollLeft.set(max);
    });
  }

  readonly layout = computed(() => {
    if (this.store.repoGraphPending()) {
      return { nodes: [] as GraphNode[], laneCount: 1 };
    }
    const commits = this.filterActive()
      ? this.store.filteredCommits()
      : this.store.commits();
    const artificial = this.filterActive() ? [] : this.store.artificial();
    return buildGraphLayout(artificial, commits);
  });

  readonly graphNodes = computed(() => this.layout().nodes);

  readonly lineageShas = computed(() => {
    const selected = this.store.selectedCommit();
    if (!selected) return EMPTY_SHA_SET;
    const set = new Set<string>([selected.sha]);
    const bySha = this.store.commitBySha();
    for (const parent of selected.parents) {
      const resolved = bySha.get(parent) ?? bySha.get(parent.slice(0, 7));
      if (resolved) set.add(resolved.sha);
    }
    for (const sha of this.childrenOf(selected.sha)) set.add(sha);
    return set;
  });

  readonly selectedSet = computed(() => {
    const set = new Set(this.store.selectedShas());
    const sha = this.store.selectedSha();
    if (sha) set.add(sha);
    return set;
  });

  readonly focusMode = computed(() => this.store.settings().focusMode);

  readonly remoteRefNames = computed(() => {
    const names = new Set<string>();
    for (const b of this.store.remoteBranches()) {
      names.add(b.name);
      const slash = b.name.lastIndexOf('/');
      if (slash >= 0) names.add(b.name.slice(slash + 1));
    }
    return names;
  });

  readonly lanePitch = computed(() => lanePitch(this.layout().laneCount));
  readonly nodeR = computed(() => nodeRadiusForPitch(this.lanePitch()));
  readonly nodeRSel = computed(() => this.nodeR() + 1.25);
  readonly edgeWidth = computed(() => edgeWidthForPitch(this.lanePitch()));
  readonly graphContentWidth = computed(() =>
    graphContentWidthForLanes(this.layout().laneCount, this.lanePitch()),
  );
  readonly graphWidth = computed(() =>
    graphWidthForLanes(this.layout().laneCount, this.lanePitch()),
  );
  readonly graphScrollLeft = signal(0);

  readonly headerCols: { id: GridColId; label: string }[] = [
    { id: 'graph', label: '' },
    { id: 'message', label: 'Description' },
    { id: 'author', label: 'Author' },
    { id: 'date', label: 'Date' },
    { id: 'sha', label: 'Commit' },
  ];

  readonly resizingCol = signal<GridColId | null>(null);
  private resizeDrag: { col: GridColId; startX: number; startW: number } | null = null;
  private bodyCursor = '';
  private bodyUserSelect = '';

  readonly columns = computed(() => {
    const w = this.store.revisionGridColumns();
    const graph = this.displayGraphWidth();
    if (w.message != null) {
      return `${graph}px ${w.message}px ${w.author}px ${w.date}px ${w.sha}px minmax(0, 1fr)`;
    }
    return `${graph}px minmax(200px, 1fr) ${w.author}px ${w.date}px ${w.sha}px`;
  });

  readonly gridMinWidth = computed(() => {
    const w = this.store.revisionGridColumns();
    return this.displayGraphWidth() + (w.message ?? 200) + w.author + w.date + w.sha;
  });

  readonly displayGraphWidth = computed(() => {
    const auto = this.graphWidth();
    const stored = this.store.revisionGridColumns().graph;
    if (stored == null) return auto;
    const width = clampColWidth('graph', stored);
    if (width < auto || width > auto + 20) return auto;
    return width;
  });

  rowView(node: GraphNode, index: number): StaticRowView {
    const commit = node.commit;
    return {
      id: node.id,
      node,
      alt: index % 2 === 1,
      artificial: node.kind === 'artificial',
      head: !!commit?.refs.includes('HEAD'),
      cx: laneX(node.lane, this.lanePitch()),
      nodeFill: laneColor(node.colorIndex),
      art: node.artificial,
      commit,
    };
  }

  topLinks(row: StaticRowView): LinkView[] {
    return mapLinks(row.node.topLinks, 'top', this.lanePitch());
  }

  bottomLinks(row: StaticRowView): LinkView[] {
    return mapLinks(row.node.bottomLinks, 'bottom', this.lanePitch());
  }

  timeLabel(ts: number): string {
    return formatTime(ts);
  }

  refChips(commit: CommitInfo): RefChipView[] {
    const remotes = this.remoteRefNames();
    return commit.refs.map((ref) => ({
      ref,
      className: chipClass(ref, remotes),
      title: ref === 'HEAD' ? 'HEAD' : `Checkout ${ref}`,
      disabled: ref === 'HEAD' || ref.startsWith('tag:') || ref.startsWith('tags/'),
    }));
  }

  trackNode = (_: number, node: GraphNode): string => node.id;

  isRowSelected(row: StaticRowView): boolean {
    if (row.artificial && row.art) {
      const source = this.store.diffSource();
      return (
        (source === 'staged' && row.art.kind === 'staged') ||
        (source === 'workingDirectory' &&
          (row.art.kind === 'workingDirectory' || row.art.kind === 'working'))
      );
    }
    const sha = row.commit?.sha;
    return !!sha && this.selectedSet().has(sha);
  }

  isRowCompare(row: StaticRowView): boolean {
    const sha = row.commit?.sha;
    return !!sha && this.store.compareSha() === sha;
  }

  isRowDim(row: StaticRowView): boolean {
    if (!this.focusMode() || row.artificial) return false;
    const sha = row.commit?.sha;
    if (sha && this.lineageShas().has(sha)) return false;
    return !row.commit?.isRelativeToHead;
  }

  isRowParent(row: StaticRowView): boolean {
    const selected = this.store.selectedCommit();
    const commit = row.commit;
    if (!selected || !commit || commit.sha === selected.sha) return false;
    return selected.parents.some((p) => matchesSha(p, commit.sha));
  }

  isRowChild(row: StaticRowView): boolean {
    const selected = this.store.selectedCommit();
    const commit = row.commit;
    if (!selected || !commit || commit.sha === selected.sha) return false;
    return commit.parents.some((p) => matchesSha(p, selected.sha));
  }

  isRowLineageNode(row: StaticRowView): boolean {
    const sha = row.commit?.sha;
    return !!sha && this.lineageShas().has(sha) && !this.isRowSelected(row);
  }

  isLineageLink(row: StaticRowView, link: LinkView): boolean {
    if (!this.lineageShas().has(row.commit?.sha ?? '')) return false;
    return this.isRowSelected(row) || link.from === row.node.lane || link.to === row.node.lane;
  }

  private childrenOf(sha: string): string[] {
    const out: string[] = [];
    for (const commit of this.store.commits()) {
      if (commit.parents.some((p) => matchesSha(p, sha))) out.push(commit.sha);
    }
    return out;
  }

  onQueryInput(value: string): void {
    this.queryDraft.set(value);
    this.scheduleFilter({ query: value });
  }

  onAuthorInput(value: string): void {
    this.authorDraft.set(value);
    this.scheduleFilter({ author: value });
  }

  private scheduleFilter(partial: { query?: string; author?: string }): void {
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
    this.filterTimer = window.setTimeout(() => {
      this.filterTimer = null;
      this.store.setHistoryFilter(partial);
    }, 180);
  }

  clearFilters(): void {
    if (this.filterTimer !== null) {
      window.clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    this.queryDraft.set('');
    this.authorDraft.set('');
    this.store.clearHistoryFilter();
  }

  onScroll(): void {
    this.closeMenu();
    const body = this.viewport()?.elementRef.nativeElement;
    const header = this.headerRef()?.nativeElement;
    if (body && header) header.scrollLeft = body.scrollLeft;
  }

  onGraphColScroll(event: Event): void {
    const left = (event.currentTarget as HTMLElement).scrollLeft;
    if (Math.abs(left - this.graphScrollLeft()) < 0.5) return;
    this.graphScrollLeft.set(left);
  }

  onGraphWheel(event: WheelEvent): void {
    const max = Math.max(0, this.graphContentWidth() - this.displayGraphWidth());
    if (max <= 0) return;
    const dx = event.deltaX !== 0 ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (!dx) return;
    event.preventDefault();
    this.graphScrollLeft.set(Math.min(max, Math.max(0, this.graphScrollLeft() + dx)));
  }

  onResizeStart(col: GridColId, event: PointerEvent): void {
    if (event.button !== 0) return;
    if (event.detail > 1) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const header = this.headerRef()?.nativeElement;
    if (!header) return;
    const index = GRID_COL_IDS.indexOf(col);
    const cell = header.children[index] as HTMLElement | undefined;
    if (!cell) return;
    this.resizeDrag = { col, startX: event.clientX, startW: cell.getBoundingClientRect().width };
    this.resizingCol.set(col);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.bodyCursor = document.body.style.cursor;
    this.bodyUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  onResizeMove(event: PointerEvent): void {
    const drag = this.resizeDrag;
    if (!drag) return;
    const next = clampColWidth(drag.col, drag.startW + (event.clientX - drag.startX));
    const current = this.store.revisionGridColumns();
    const patched: RevisionGridColumns = { ...current, [drag.col]: next };
    this.store.setRevisionGridColumns(patched, { persist: false });
  }

  onResizeEnd(): void {
    this.endResize(true);
  }

  onFitColumn(col: GridColId, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.endResize(false);
    const current = this.store.revisionGridColumns();
    if (col === 'graph' || col === 'message') {
      this.store.setRevisionGridColumns({ ...current, [col]: undefined });
      return;
    }
    this.store.setRevisionGridColumns({ ...current, [col]: this.fitTextColumn(col) });
  }

  private fitTextColumn(col: 'author' | 'date' | 'sha'): number {
    const commits = this.filterActive() ? this.store.filteredCommits() : this.store.commits();
    const sample = sampleStride(commits, GRID_COL_SAMPLE);
    const font = this.columnFont(col === 'sha');
    let max = 0;
    if (col === 'sha') {
      max = measureTextWidth('abcdef1', font);
      for (const commit of sample) {
        max = Math.max(max, measureTextWidth(commit.shortSha || commit.sha.slice(0, 7), font));
      }
    } else if (col === 'date') {
      max = measureTextWidth('59 seconds ago', font);
      for (const commit of sample) {
        max = Math.max(max, measureTextWidth(formatTime(commit.timestamp), font));
      }
    } else {
      max = measureTextWidth('Author', font);
      for (const commit of sample) {
        max = Math.max(max, measureTextWidth(commit.author, font));
      }
    }
    return clampColWidth(col, max + COL_PAD);
  }

  private columnFont(mono: boolean): string {
    const header = this.headerRef()?.nativeElement;
    const styles = header ? getComputedStyle(header) : null;
    const size = styles?.fontSize || '11.5px';
    const family = mono
      ? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
      : styles?.fontFamily || 'ui-sans-serif, system-ui, sans-serif';
    return `${size} ${family}`;
  }

  private endResize(persist = false): void {
    if (!this.resizeDrag && !this.resizingCol()) return;
    this.resizeDrag = null;
    this.resizingCol.set(null);
    document.body.style.cursor = this.bodyCursor;
    document.body.style.userSelect = this.bodyUserSelect;
    this.bodyCursor = '';
    this.bodyUserSelect = '';
    if (persist) this.store.setRevisionGridColumns(this.store.revisionGridColumns());
  }

  onDragStart(row: StaticRowView, event: DragEvent): void {
    if (!row.commit) {
      event.preventDefault();
      return;
    }
    this.dragSha = row.commit.sha;
    event.dataTransfer?.setData('text/plain', row.commit.sha);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
  }

  onDragEnd(): void {
    this.dragSha = null;
    this.dropTargetSha.set(null);
  }

  onDragOver(row: StaticRowView, event: DragEvent): void {
    if (!row.commit || !this.dragSha || this.dragSha === row.commit.sha) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dropTargetSha.set(row.commit.sha);
  }

  onDragLeave(row: StaticRowView): void {
    if (row.commit && this.dropTargetSha() === row.commit.sha) {
      this.dropTargetSha.set(null);
    }
  }

  onDrop(row: StaticRowView, event: DragEvent): void {
    event.preventDefault();
    const source = this.dragSha || event.dataTransfer?.getData('text/plain') || null;
    const target = row.commit?.sha ?? null;
    this.dragSha = null;
    this.dropTargetSha.set(null);
    if (!source || !target) return;
    void this.store.handleGraphDrop(source, target);
  }

  onRowClick(row: StaticRowView, event: MouseEvent): void {
    this.closeMenu();
    if (row.artificial && row.art) {
      const kind = row.art.kind === 'staged' ? 'staged' : 'workingDirectory';
      this.store.selectWorkingDirectory(kind);
      return;
    }
    if (!row.commit) return;
    if (event.shiftKey) {
      this.store.toggleCompare(row.commit.sha);
      this.store.selectCommit(row.commit.sha);
      return;
    }
    this.store.selectCommit(row.commit.sha, event.metaKey || event.ctrlKey);
  }

  onRowDblClick(row: StaticRowView, event: MouseEvent): void {
    event.preventDefault();
    this.closeMenu();
    if (row.artificial && row.art) {
      this.store.openCommitModal();
      return;
    }
  }

  onContext(row: StaticRowView, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!row.commit) return;
    const priorSha = this.store.selectedSha();
    this.store.selectCommit(row.commit.sha);
    this.suppressMenuCloseUntil = performance.now() + 500;
    this.menu.set({
      open: true,
      x: event.clientX,
      y: event.clientY,
      sha: row.commit.sha,
      priorSha: priorSha && priorSha !== row.commit.sha ? priorSha : null,
    });
  }

  onRefClick(ref: string, event: MouseEvent): void {
    event.stopPropagation();
    if (ref === 'HEAD' || ref.startsWith('tag:') || ref.startsWith('tags/')) return;
    void this.store.checkoutBranch(ref);
  }

  async copySha(sha: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(sha);
      this.store.showSuccess(`Copied ${sha.slice(0, 7)}`);
    } catch {
      this.store.showError('Could not copy SHA');
    }
  }

  canCompareMenu(): boolean {
    const menu = this.menu();
    return !!menu.priorSha && menu.priorSha !== menu.sha;
  }

  compareWithSelected(): void {
    const { sha, priorSha } = this.menu();
    this.closeMenu();
    if (priorSha && priorSha !== sha) {
      this.store.selectedSha.set(priorSha);
      this.store.selectedShas.set([priorSha]);
      this.store.toggleCompare(sha);
      this.store.setBrowseTab('diff');
      return;
    }
    this.store.compareSelectedCommits();
  }

  openOnHost(): void {
    const sha = this.menu().sha;
    this.closeMenu();
    if (sha) void this.store.openCommitOnHost(sha);
  }

  copyLink(): void {
    const sha = this.menu().sha;
    this.closeMenu();
    if (sha) void this.store.copyCommitPermalink(sha);
  }

  savePatch(): void {
    const sha = this.menu().sha;
    this.closeMenu();
    if (sha) void this.store.exportPatchForSha(sha);
  }

  togglePin(): void {
    const sha = this.menu().sha;
    this.closeMenu();
    if (sha) this.store.togglePinnedCommit(sha);
  }

  isBadSignature(signature?: string | null): boolean {
    return !!signature && BAD_SIGNATURES.has(signature);
  }

  ciState(commit: CommitInfo): 'success' | 'failure' | 'pending' | null {
    const statuses = this.store.commitStatuses();
    const state = statuses[commit.sha] ?? statuses[commit.shortSha];
    if (state === 'success' || state === 'failure' || state === 'pending') return state;
    return null;
  }

  ciTitle(state: 'success' | 'failure' | 'pending'): string {
    if (state === 'success') return 'Checks passed';
    if (state === 'failure') return 'Checks failed';
    return 'Checks pending';
  }

  closeMenu(): void {
    if (this.menu().open) this.menu.update((m) => ({ ...m, open: false }));
  }

  onMenuDismiss(event?: Event): void {
    if (performance.now() < this.suppressMenuCloseUntil) return;
    if (event instanceof MouseEvent && (event.type === 'auxclick' || event.button === 2)) return;
    this.closeMenu();
  }

  applyHere(): void {
    void this.store.openCherryPickPreview([this.menu().sha]);
    this.closeMenu();
  }

  interactiveRebase(): void {
    void this.store.openInteractiveRebase(this.menu().sha);
    this.closeMenu();
  }

  undoCommit(): void {
    void this.store.revertSelected();
    this.closeMenu();
  }

  checkoutCommit(): void {
    const sha = this.menu().sha;
    this.closeMenu();
    this.store.openCreateBranchDialog(sha);
  }

  resetSoft(): void {
    void this.store.resetTo(this.menu().sha, 'soft');
    this.closeMenu();
  }

  resetMixed(): void {
    void this.store.resetTo(this.menu().sha, 'mixed');
    this.closeMenu();
  }

  resetHard(): void {
    void this.store.resetTo(this.menu().sha, 'hard');
    this.closeMenu();
  }

  async createTagHere(): Promise<void> {
    const sha = this.menu().sha;
    this.closeMenu();
    const name = await this.prompts.ask({
      title: 'Create tag',
      message: `Tag commit ${sha.slice(0, 7)}.`,
      label: 'Tag name',
      placeholder: 'v1.0.0',
      confirmLabel: 'Create tag',
      mono: true,
    });
    if (!name?.trim()) return;
    void this.store.createTag(name.trim(), sha);
  }

  async startBisectHere(): Promise<void> {
    const sha = this.menu().sha;
    this.closeMenu();
    const good = await this.prompts.ask({
      title: 'Bisect: known good commit',
      message: `Mark ${sha.slice(0, 7)} as bad. Enter a known good SHA, tag, or branch.`,
      label: 'Good commit',
      placeholder: 'main or abc1234',
      confirmLabel: 'Start bisect',
      mono: true,
    });
    if (!good?.trim()) return;
    void this.store.startBisect({ badSha: sha, goodSha: good.trim() });
  }

  extractChangelog(): void {
    this.store.selectCommit(this.menu().sha);
    this.store.openChangelogModal();
  }

  async squashInto(): Promise<void> {
    this.closeMenu();
    const countRaw = await this.prompts.ask({
      title: 'Squash commits',
      message: 'How many recent commits should be combined?',
      label: 'Commit count',
      initialValue: '2',
      confirmLabel: 'Next',
      mono: true,
    });
    const count = Number(countRaw);
    if (!Number.isFinite(count) || count < 2) return;
    const message = await this.prompts.ask({
      title: 'Squash commit message',
      message: `Combining the last ${count} commits.`,
      label: 'Message',
      placeholder: 'Summarize the squashed changes',
      confirmLabel: 'Squash',
      multiline: true,
    });
    if (!message?.trim()) return;
    void this.store.squashSelected(count, message.trim());
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.closeMenu();
      return;
    }

    if (event.key === 'Enter') {
      const source = this.store.diffSource();
      if (source === 'workingDirectory' || source === 'staged') {
        event.preventDefault();
        this.store.openCommitModal();
        return;
      }
    }

    const commits = this.filterActive()
      ? this.store.filteredCommits()
      : this.store.commits();
    if (!commits.length) return;

    const current = this.store.selectedSha();
    const idx = commits.findIndex((c) => c.sha === current);
    let next = idx;

    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      next = Math.min(commits.length - 1, Math.max(0, idx) + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      next = Math.max(0, (idx < 0 ? 0 : idx) - 1);
    } else if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault();
      const el = document.querySelector<HTMLInputElement>('.revision-grid .filter-query');
      el?.focus();
      return;
    } else {
      return;
    }

    const sha = commits[next]?.sha;
    if (!sha) return;
    this.store.selectCommit(sha, event.metaKey || event.ctrlKey);
    this.scrollToSha(sha);
  }

  private scheduleScrollToSha(sha: string): void {
    if (this.filterTimer !== null) {
      window.clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    const filter = this.store.historyFilter();
    this.queryDraft.set(filter.query);
    this.authorDraft.set(filter.author);
    const run = () => this.scrollToSha(sha, true);
    queueMicrotask(run);
    window.setTimeout(run, 50);
  }

  private indexOfSha(sha: string): number {
    return this.graphNodes().findIndex((node) => {
      const rowSha = node.commit?.sha;
      return !!rowSha && matchesSha(sha, rowSha);
    });
  }

  private scrollToSha(sha: string, center = false): void {
    const viewport = this.viewport();
    if (!viewport) return;
    const index = this.indexOfSha(sha);
    if (index < 0) return;
    viewport.checkViewportSize();

    if (center) {
      viewport.scrollToIndex(Math.max(0, index - 4));
      return;
    }

    const range = viewport.getRenderedRange();
    if (index < range.start || index >= range.end) {
      viewport.scrollToIndex(Math.max(0, index - 2));
      return;
    }

    const rowSha = this.graphNodes()[index]?.commit?.sha ?? sha;
    const el = viewport.elementRef.nativeElement.querySelector(
      `[data-sha="${cssEscape(rowSha)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function laneColor(index: number): string {
  const i = ((index % 8) + 8) % 8;
  return `var(--lane-${i + 1})`;
}

function formatTime(ts: number): string {
  return formatDistanceToNowStrict(new Date(ts * 1000), { addSuffix: true });
}

function chipClass(ref: string, remotes: Set<string>): string {
  if (ref.startsWith('tag:') || ref.startsWith('tags/')) return 'bl-chip bl-chip-tag';
  if (ref === 'HEAD') return 'bl-chip bl-chip-head';
  if (remotes.has(ref)) return 'bl-chip bl-chip-remote';
  return 'bl-chip bl-chip-local';
}

function mapLinks(links: GraphLink[], half: 'top' | 'bottom', pitch: number): LinkView[] {
  return links.map((link) => ({
    key: `${half}-${link.from}-${link.to}-${link.colorIndex}-${link.mergeParent ? 1 : 0}`,
    d: linkPath(link.from, link.to, half, ROW_HEIGHT, pitch),
    stroke: laneColor(link.colorIndex),
    mergeParent: !!link.mergeParent,
    lineage: false,
    from: link.from,
    to: link.to,
  }));
}

function matchesSha(raw: string, full: string): boolean {
  return raw === full || full.startsWith(raw) || raw.startsWith(full.slice(0, raw.length));
}

const EMPTY_SHA_SET = new Set<string>();
const BAD_SIGNATURES = new Set(['B', 'U', 'X', 'Y', 'R', 'E']);
