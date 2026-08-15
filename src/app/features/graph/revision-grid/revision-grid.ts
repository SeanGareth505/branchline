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
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { ArtificialCommit, CommitInfo, RevisionGridColumns } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import {
  ROW_HEIGHT,
  buildGraphLayout,
  graphWidthForLanes,
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
  baseTopLinks: LinkView[];
  baseBottomLinks: LinkView[];
  art?: ArtificialCommit;
  commit?: CommitInfo;
  timeLabel: string;
  refs: RefChipView[];
}

type GridColId = 'graph' | 'message' | 'author' | 'date' | 'sha';

const GRID_COL_IDS: GridColId[] = ['graph', 'message', 'author', 'date', 'sha'];

const COL_MIN: Record<GridColId, number> = {
  graph: 28,
  message: 120,
  author: 56,
  date: 64,
  sha: 52,
};

const COL_MAX: Record<GridColId, number> = {
  graph: 800,
  message: 2000,
  author: 600,
  date: 400,
  sha: 280,
};

function clampColWidth(col: GridColId, width: number, graphFit: number): number {
  const min = COL_MIN[col];
  const max = col === 'graph' ? Math.max(COL_MAX.graph, graphFit) : COL_MAX[col];
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(max, Math.max(min, width)));
}

@Component({
  selector: 'app-revision-grid',
  imports: [
    FormsModule,
    CdkConnectedOverlay,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
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
  readonly queryDraft = signal(this.store.historyFilter().query);
  readonly authorDraft = signal(this.store.historyFilter().author);
  private filterTimer: number | null = null;

  readonly menu = signal<{ open: boolean; x: number; y: number; sha: string }>({
    open: false,
    x: 0,
    y: 0,
    sha: '',
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
    return !!(f.query.trim() || f.author.trim() || f.currentBranchOnly || f.mineOnly);
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
  }

  readonly layout = computed(() => {
    const commits = this.filterActive()
      ? this.store.filteredCommits()
      : this.store.commits();
    const artificial = this.filterActive() ? [] : this.store.artificial();
    return buildGraphLayout(artificial, commits);
  });

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
  readonly graphWidth = computed(() =>
    graphWidthForLanes(this.layout().laneCount, this.lanePitch()),
  );

  readonly headerCols: { id: GridColId; label: string; className: string }[] = [
    { id: 'graph', label: '', className: 'h-graph' },
    { id: 'message', label: 'Description', className: 'h-message' },
    { id: 'author', label: 'Author', className: 'h-author' },
    { id: 'date', label: 'Date', className: 'h-date' },
    { id: 'sha', label: 'Commit', className: 'h-sha' },
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
    const stored = this.store.revisionGridColumns().graph;
    if (stored == null) return this.graphWidth();
    return clampColWidth('graph', stored, this.graphWidth());
  });

  readonly staticRows = computed((): StaticRowView[] => {
    const nodes = this.layout().nodes;
    const remotes = this.remoteRefNames();
    const pitch = this.lanePitch();

    return nodes.map((node, i) => {
      const commit = node.commit;
      const fill = laneColor(node.colorIndex);
      return {
        id: node.id,
        node,
        alt: i % 2 === 1,
        artificial: node.kind === 'artificial',
        head: !!commit?.refs.includes('HEAD'),
        cx: laneX(node.lane, pitch),
        nodeFill: fill,
        baseTopLinks: mapLinks(node.topLinks, 'top', pitch),
        baseBottomLinks: mapLinks(node.bottomLinks, 'bottom', pitch),
        art: node.artificial,
        commit,
        timeLabel: commit ? formatTime(commit.timestamp) : '',
        refs: (commit?.refs ?? []).map((ref) => ({
          ref,
          className: chipClass(ref, remotes),
          title: ref === 'HEAD' ? 'HEAD' : `Checkout ${ref}`,
          disabled: ref === 'HEAD' || ref.startsWith('tag:') || ref.startsWith('tags/'),
        })),
      };
    });
  });

  trackRow = (_: number, row: StaticRowView): string => row.id;

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
    const next = clampColWidth(
      drag.col,
      drag.startW + (event.clientX - drag.startX),
      this.graphWidth(),
    );
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
    if (col !== 'graph') return;
    const current = this.store.revisionGridColumns();
    this.store.setRevisionGridColumns({ ...current, graph: undefined });
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
    this.store.selectCommit(row.commit.sha);
    this.suppressMenuCloseUntil = performance.now() + 500;
    this.menu.set({ open: true, x: event.clientX, y: event.clientY, sha: row.commit.sha });
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
    return this.staticRows().findIndex((row) => {
      const rowSha = row.commit?.sha;
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

    const rowSha = this.staticRows()[index]?.commit?.sha ?? sha;
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
