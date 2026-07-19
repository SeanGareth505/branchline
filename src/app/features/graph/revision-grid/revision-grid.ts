import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import { CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { ArtificialCommit, CommitInfo } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import {
  GRAPH_PAD,
  LANE_WIDTH,
  NODE_RADIUS,
  NODE_RADIUS_SELECTED,
  ROW_HEIGHT,
  buildGraphLayout,
  laneX,
  linkPath,
  type GraphLink,
  type GraphNode,
} from '../graph-layout';

interface LinkView {
  key: string;
  d: string;
  stroke: string;
  mergeParent: boolean;
  lineage: boolean;
}

interface RefChipView {
  ref: string;
  className: string;
  title: string;
  disabled: boolean;
}

interface RowView {
  id: string;
  node: GraphNode;
  alt: boolean;
  artificial: boolean;
  selected: boolean;
  compare: boolean;
  head: boolean;
  dim: boolean;
  parentOf: boolean;
  childOf: boolean;
  cx: number;
  nodeStroke: string;
  nodeFill: string;
  nodeRadius: number;
  lineageNode: boolean;
  topLinks: LinkView[];
  bottomLinks: LinkView[];
  art?: ArtificialCommit;
  commit?: CommitInfo;
  timeLabel: string;
  refs: RefChipView[];
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
  readonly nodeR = NODE_RADIUS;
  readonly nodeRSel = NODE_RADIUS_SELECTED;
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

  readonly layout = computed(() => {
    const commits = this.filterActive()
      ? this.store.filteredCommits()
      : this.store.commits();
    const artificial = this.filterActive() ? [] : this.store.artificial();
    return buildGraphLayout(artificial, commits);
  });

  readonly lineageShas = computed(() => {
    const selected = this.store.selectedCommit();
    if (!selected) return new Set<string>();
    const set = new Set<string>([selected.sha]);
    const commits = this.store.commits();
    const bySha = new Map<string, CommitInfo>();
    for (const c of commits) bySha.set(c.sha, c);
    for (const parent of selected.parents) {
      const resolved = resolveSha(parent, bySha);
      if (resolved) set.add(resolved);
    }
    for (const commit of commits) {
      for (const p of commit.parents) {
        if (matchesSha(p, selected.sha)) {
          set.add(commit.sha);
          break;
        }
      }
    }
    return set;
  });

  readonly remoteRefNames = computed(() => {
    const names = new Set<string>();
    for (const b of this.store.remoteBranches()) {
      names.add(b.name);
      const slash = b.name.lastIndexOf('/');
      if (slash >= 0) names.add(b.name.slice(slash + 1));
    }
    return names;
  });

  readonly graphWidth = computed(() => {
    const lanes = this.layout().laneCount;
    return Math.max(64, GRAPH_PAD * 2 + lanes * LANE_WIDTH);
  });

  readonly columns = computed(
    () => `${this.graphWidth()}px minmax(200px, 1fr) 120px 128px 80px`,
  );

  readonly rows = computed((): RowView[] => {
    const nodes = this.layout().nodes;
    const selectedSha = this.store.selectedSha();
    const selectedShas = this.store.selectedShas();
    const compareSha = this.store.compareSha();
    const diffSource = this.store.diffSource();
    const selected = this.store.selectedCommit();
    const focusMode = this.store.settings().focusMode;
    const lineage = this.lineageShas();
    const remotes = this.remoteRefNames();
    const selectedSet = new Set(selectedShas);
    if (selectedSha) selectedSet.add(selectedSha);

    return nodes.map((node, i) => {
      const commit = node.commit;
      const sha = commit?.sha;
      const artSelected =
        node.kind === 'artificial' &&
        !!node.artificial &&
        ((diffSource === 'staged' && node.artificial.kind === 'staged') ||
          (diffSource === 'workingDirectory' &&
            (node.artificial.kind === 'workingDirectory' || node.artificial.kind === 'working')));
      const selectedRow = artSelected || (!!sha && selectedSet.has(sha));
      const compare = !!sha && compareSha === sha;
      const head = !!commit?.refs.includes('HEAD');
      const inLineage = !!sha && lineage.has(sha);
      const dim =
        focusMode &&
        node.kind !== 'artificial' &&
        !inLineage &&
        !commit?.isRelativeToHead;
      const parentOf =
        !!selected &&
        !!commit &&
        commit.sha !== selected.sha &&
        selected.parents.some((p) => matchesSha(p, commit.sha));
      const childOf =
        !!selected &&
        !!commit &&
        commit.sha !== selected.sha &&
        commit.parents.some((p) => matchesSha(p, selected.sha));
      const lineageNode = inLineage && !selectedRow;
      const fill = laneColor(node.colorIndex);
      const cx = laneX(node.lane);

      return {
        id: node.id,
        node,
        alt: i % 2 === 1,
        artificial: node.kind === 'artificial',
        selected: selectedRow,
        compare,
        head,
        dim,
        parentOf,
        childOf,
        cx,
        nodeFill: fill,
        nodeStroke: selectedRow ? 'var(--text-primary)' : fill,
        nodeRadius: selectedRow ? NODE_RADIUS_SELECTED : NODE_RADIUS,
        lineageNode,
        topLinks: mapLinks(node, node.topLinks, 'top', inLineage, selectedRow),
        bottomLinks: mapLinks(node, node.bottomLinks, 'bottom', inLineage, selectedRow),
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

  trackRow = (_: number, row: RowView): string => row.id;

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

  onDragStart(row: RowView, event: DragEvent): void {
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

  onDragOver(row: RowView, event: DragEvent): void {
    if (!row.commit || !this.dragSha || this.dragSha === row.commit.sha) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dropTargetSha.set(row.commit.sha);
  }

  onDragLeave(row: RowView): void {
    if (row.commit && this.dropTargetSha() === row.commit.sha) {
      this.dropTargetSha.set(null);
    }
  }

  onDrop(row: RowView, event: DragEvent): void {
    event.preventDefault();
    const source = this.dragSha || event.dataTransfer?.getData('text/plain') || null;
    const target = row.commit?.sha ?? null;
    this.dragSha = null;
    this.dropTargetSha.set(null);
    if (!source || !target) return;
    void this.store.handleGraphDrop(source, target);
  }

  onRowClick(row: RowView, event: MouseEvent): void {
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

  onRowDblClick(row: RowView, event: MouseEvent): void {
    event.preventDefault();
    this.closeMenu();
    if (row.artificial && row.art) {
      this.store.openCommitModal();
      return;
    }
  }

  onContext(row: RowView, event: MouseEvent): void {
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

  private scrollToSha(sha: string): void {
    const viewport = this.viewport();
    if (!viewport) return;
    const index = this.rows().findIndex((row) => row.commit?.sha === sha);
    if (index < 0) return;

    const range = viewport.getRenderedRange();
    if (index < range.start || index >= range.end) {
      const offset = Math.max(0, index - 2);
      viewport.scrollToIndex(offset);
      return;
    }

    const el = viewport.elementRef.nativeElement.querySelector(
      `[data-sha="${cssEscape(sha)}"]`,
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
  return 'bl-chip';
}

function mapLinks(
  node: GraphNode,
  links: GraphLink[],
  half: 'top' | 'bottom',
  inLineage: boolean,
  selectedRow: boolean,
): LinkView[] {
  if (!inLineage) {
    return links.map((link) => ({
      key: `${half}-${link.from}-${link.to}-${link.colorIndex}-${link.mergeParent ? 1 : 0}`,
      d: linkPath(link.from, link.to, half, ROW_HEIGHT),
      stroke: laneColor(link.colorIndex),
      mergeParent: !!link.mergeParent,
      lineage: false,
    }));
  }
  return links.map((link) => ({
    key: `${half}-${link.from}-${link.to}-${link.colorIndex}-${link.mergeParent ? 1 : 0}`,
    d: linkPath(link.from, link.to, half, ROW_HEIGHT),
    stroke: laneColor(link.colorIndex),
    mergeParent: !!link.mergeParent,
    lineage: selectedRow || link.from === node.lane || link.to === node.lane,
  }));
}

function resolveSha(raw: string, bySha: Map<string, CommitInfo>): string | null {
  if (bySha.has(raw)) return raw;
  for (const sha of bySha.keys()) {
    if (sha.startsWith(raw) || raw.startsWith(sha.slice(0, raw.length))) return sha;
  }
  return null;
}

function matchesSha(raw: string, full: string): boolean {
  return raw === full || full.startsWith(raw) || raw.startsWith(full.slice(0, raw.length));
}
