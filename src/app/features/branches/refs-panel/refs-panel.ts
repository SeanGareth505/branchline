import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { CdkVirtualScrollViewport, CdkFixedSizeVirtualScroll, CdkVirtualForOf } from '@angular/cdk/scrolling';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { BranchInfo } from '../../../core/models';
import { describeBranchSync, shortUpstream } from '../../../shared/git/branch-sync';
import { isMainlineBranch } from '../../../shared/git/mainline-branch';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { SelectService } from '../../../shared/ui/select-dialog/select.service';
import { parseRemoteRef } from '../../../shared/git/remote-ref';
import { RemotesPanel } from '../../remotes/remotes-panel/remotes-panel';
import { StashPanel } from '../../stash/stash-panel/stash-panel';
import { WorktreesPanel } from '../../worktrees/worktrees-panel/worktrees-panel';
import { SubmodulesPanel } from '../../submodules/submodules-panel/submodules-panel';
import { LfsPanel } from '../../lfs/lfs-panel/lfs-panel';

export type RefsGroup = 'local' | 'tags' | 'remotes' | 'stash' | 'worktrees' | 'submodules' | 'lfs';

interface RefsSectionOption {
  id: string;
  label: string;
}

type SuggestKind = 'local' | 'remote' | 'tag' | 'folder';

interface RefSuggestion {
  id: string;
  name: string;
  kind: SuggestKind;
  hint?: string;
}

interface BranchTreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: BranchTreeNode[];
  branchCount: number;
}

interface BranchTreeLeaf {
  kind: 'branch';
  name: string;
  path: string;
  branch: BranchInfo;
}

type BranchTreeNode = BranchTreeDir | BranchTreeLeaf;

type TreeGuideKind = 'blank' | 'line' | 'tee' | 'corner';

type BranchFlatRow =
  | {
      kind: 'dir';
      path: string;
      name: string;
      depth: number;
      branchCount: number;
      open: boolean;
      guides: TreeGuideKind[];
    }
  | {
      kind: 'branch';
      path: string;
      name: string;
      depth: number;
      branch: BranchInfo;
      guides: TreeGuideKind[];
    };

interface RemoteGroupView {
  name: string;
  path: string;
  count: number;
  rows: BranchFlatRow[];
}

interface TagTreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TagTreeNode[];
  tagCount: number;
}

interface TagTreeLeaf {
  kind: 'tag';
  name: string;
  path: string;
  sha: string;
}

type TagTreeNode = TagTreeDir | TagTreeLeaf;

type TagFlatRow =
  | {
      kind: 'dir';
      path: string;
      name: string;
      depth: number;
      tagCount: number;
      open: boolean;
      guides: TreeGuideKind[];
    }
  | { kind: 'tag'; path: string; name: string; depth: number; sha: string; guides: TreeGuideKind[] };

@Component({
  selector: 'app-refs-panel',
  imports: [
    FormsModule,
    NgTemplateOutlet,
    NgIcon,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    CdkVirtualScrollViewport,
    CdkFixedSizeVirtualScroll,
    CdkVirtualForOf,
    StashPanel,
    RemotesPanel,
    WorktreesPanel,
    SubmodulesPanel,
    LfsPanel,
    HelpTip,
  ],
  templateUrl: './refs-panel.html',
  styleUrl: './refs-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RefsPanel {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  private readonly selects = inject(SelectService);
  readonly refRowHeight = 26;
  readonly localScrollIndex = signal(0);
  readonly tagScrollIndex = signal(0);
  readonly remoteScrollIndex = signal<Record<string, number>>({});
  trackBranchRow = (_: number, row: BranchFlatRow): string => row.path + ':' + row.kind;
  trackTagRow = (_: number, row: TagFlatRow): string => row.path + ':' + row.kind;

  refViewportPx(count: number): number {
    if (count <= 0) return this.refRowHeight;
    return Math.min(count * this.refRowHeight, 392);
  }

  readonly creatingTag = signal(false);
  readonly newTag = signal('');
  readonly query = signal('');
  readonly suggestOpen = signal(false);
  readonly activeSuggest = signal(0);
  readonly branchMenu = signal<{ name: string; x: number; y: number } | null>(null);
  readonly tagMenu = signal<{ name: string; x: number; y: number } | null>(null);
  readonly collapsedFolders = signal<Set<string>>(new Set());
  readonly expandedRemotes = signal<Set<string>>(new Set());
  readonly sectionsMenuOpen = signal(false);
  readonly expanded = signal<Record<RefsGroup, boolean>>({
    local: true,
    tags: false,
    remotes: false,
    stash: false,
    worktrees: false,
    submodules: false,
    lfs: false,
  });
  private suppressMenuCloseUntil = 0;

  constructor() {
    effect(() => {
      const group = this.store.pendingRefsReveal();
      if (group !== 'remotes' && group !== 'local' && group !== 'tags' && group !== 'stash' && group !== 'worktrees' && group !== 'submodules' && group !== 'lfs') {
        return;
      }
      if (this.store.hiddenRefsGroups().includes(group)) {
        this.store.setHiddenRefsGroups(this.store.hiddenRefsGroups().filter((id) => id !== group));
      }
      this.setExpanded(group as RefsGroup, true);
      this.store.pendingRefsReveal.set(null);
    });
  }

  readonly menuOrigin = computed(() => {
    const menu = this.branchMenu() ?? this.tagMenu();
    return menu ? { x: menu.x, y: menu.y } : { x: 0, y: 0 };
  });

  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
  ];

  readonly suggestPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
  ];

  readonly sectionsMenuPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  readonly sectionOptions = computed((): RefsSectionOption[] => [
    { id: 'local', label: 'Local' },
    ...this.remoteGroups().map((group) => ({ id: group.path, label: group.name })),
    { id: 'tags', label: 'Tags' },
    { id: 'remotes', label: 'Remote URLs' },
    { id: 'worktrees', label: 'Worktrees' },
    { id: 'submodules', label: 'Submodules' },
    { id: 'lfs', label: 'LFS' },
    { id: 'stash', label: 'Stash' },
  ]);

  readonly hasHiddenSections = computed(() => this.store.hiddenRefsGroups().length > 0);

  readonly suggestions = computed((): RefSuggestion[] => {
    const q = this.query().trim().toLowerCase();
    if (!q) return [];

    const scored: { item: RefSuggestion; score: number }[] = [];
    const seen = new Set<string>();

    const push = (item: RefSuggestion, score: number) => {
      const key = `${item.kind}:${item.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      scored.push({ item, score });
    };

    for (const branch of this.store.filteredLocalBranches()) {
      const score = this.matchScore(branch.name, q);
      if (score < 0) continue;
      push(
        {
          id: `local:${branch.name}`,
          name: branch.name,
          kind: 'local',
          hint: branch.isCurrent ? 'current' : (branch.upstream ?? undefined),
        },
        score - (branch.isCurrent ? 0.2 : 0),
      );
    }

    for (const branch of this.store.filteredRemoteBranches()) {
      const score = this.matchScore(branch.name, q);
      if (score < 0) continue;
      push(
        {
          id: `remote:${branch.name}`,
          name: branch.name,
          kind: 'remote',
          hint: 'remote',
        },
        score + 0.15,
      );
    }

    for (const tag of this.store.tags()) {
      const score = this.matchScore(tag.name, q);
      if (score < 0) continue;
      push(
        {
          id: `tag:${tag.name}`,
          name: tag.name,
          kind: 'tag',
          hint: 'tag',
        },
        score + 0.25,
      );
    }

    for (const folder of this.folderPrefixes()) {
      const score = this.matchScore(folder, q);
      if (score < 0) continue;
      push(
        {
          id: `folder:${folder}`,
          name: folder,
          kind: 'folder',
          hint: 'folder',
        },
        score + 0.35,
      );
    }

    return scored
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.item.name.localeCompare(b.item.name);
      })
      .slice(0, 10)
      .map((s) => s.item);
  });

  readonly suggestVisible = computed(
    () => this.suggestOpen() && this.suggestions().length > 0,
  );

  readonly syncLabel = computed(() =>
    describeBranchSync(this.store.status(), { hasRemotes: this.store.remotes().length > 0 }),
  );

  readonly cleanupTargetCount = computed(() => {
    const current = this.store.status()?.branch ?? null;
    const worktreeBranches = new Set(
      this.store
        .worktrees()
        .filter((w) => !w.isMain && !!w.branch?.trim())
        .map((w) => w.branch!.trim()),
    );
    return this.store.localBranches().filter((b) => {
      if (b.isCurrent || b.locked) return false;
      if (current && b.name === current) return false;
      if (worktreeBranches.has(b.name)) return false;
      return true;
    }).length;
  });

  readonly currentBranch = computed(
    () => this.store.localBranches().find((b) => b.isCurrent) ?? null,
  );

  readonly flashCurrent = signal(false);
  readonly flashPath = signal<string | null>(null);
  private flashTimer: number | null = null;

  readonly filteredLocal = computed(() => this.filterByQuery(this.store.filteredLocalBranches()));
  readonly filteredRemote = computed(() => {
    const remotes = this.store.filteredRemoteBranches();
    const q = this.query().trim().toLowerCase();
    if (!q) return remotes;

    const matched = new Map<string, BranchInfo>();
    const remotesByName = new Map<string, BranchInfo>();
    const remotesByLocal = new Map<string, BranchInfo[]>();
    for (const branch of remotes) {
      remotesByName.set(branch.name, branch);
      if (branch.name.toLowerCase().includes(q)) {
        matched.set(branch.name, branch);
      }
      const slash = branch.name.indexOf('/');
      if (slash > 0) {
        const local = branch.name.slice(slash + 1);
        const list = remotesByLocal.get(local);
        if (list) list.push(branch);
        else remotesByLocal.set(local, [branch]);
      }
    }

    for (const local of this.filteredLocal()) {
      if (local.upstream) {
        const up = remotesByName.get(local.upstream);
        if (up) matched.set(up.name, up);
      }
      const tracked = remotesByLocal.get(local.name);
      if (tracked) {
        for (const remote of tracked) matched.set(remote.name, remote);
      }
    }

    return [...matched.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
  readonly filteredTags = computed(() => {
    const q = this.query().trim().toLowerCase();
    const tags = this.store.tags();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  });

  readonly showRemoteFilterHint = computed(
    () => !!this.query().trim() && this.filteredLocal().length > 0 && this.filteredRemote().length === 0,
  );

  readonly localRows = computed(() => this.flattenBranchTree(this.buildBranchTree(this.filteredLocal()), 'local'));
  readonly localTrail = computed(() => this.treeTrail(this.localRows(), this.localScrollIndex()));
  readonly tagTrail = computed(() => this.treeTrail(this.tagRows(), this.tagScrollIndex()));
  readonly remoteGroups = computed((): RemoteGroupView[] => {
    const remotes = this.filteredRemote();
    const expanded = this.expandedRemotes();
    const searching = !!this.query().trim();
    const grouped = new Map<string, BranchInfo[]>();
    for (const branch of remotes) {
      const slash = branch.name.indexOf('/');
      const remote = slash > 0 ? branch.name.slice(0, slash) : branch.name;
      const list = grouped.get(remote);
      if (list) list.push(branch);
      else grouped.set(remote, [branch]);
    }
    return [...grouped.entries()].map(([name, branches]) => {
      const path = `remote:${name}`;
      return {
        name,
        path,
        count: branches.length,
        rows:
          searching || expanded.has(path)
            ? this.flattenBranchTree(this.buildBranchTree(branches).flatMap((node) =>
                node.kind === 'dir' && node.name === name ? node.children : [node],
              ), path)
            : [],
      };
    });
  });
  readonly tagRows = computed(() => this.flattenTagTree(this.buildTagTree(this.filteredTags()), 'tags'));

  isSectionHidden(id: string): boolean {
    return this.store.hiddenRefsGroups().includes(id);
  }

  isSectionVisible(id: string): boolean {
    if (!this.isSectionHidden(id)) return true;
    return this.sectionHasQueryMatch(id);
  }

  hideSection(id: string, event?: Event): void {
    event?.stopPropagation();
    this.store.setRefsGroupHidden(id, true);
  }

  toggleSectionHidden(id: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.store.setRefsGroupHidden(id, !this.isSectionHidden(id));
  }

  showAllSections(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.store.setHiddenRefsGroups([]);
  }

  toggleSectionsMenu(event?: Event): void {
    event?.stopPropagation();
    this.sectionsMenuOpen.update((open) => !open);
  }

  closeSectionsMenu(): void {
    this.sectionsMenuOpen.set(false);
  }

  isOpen(group: RefsGroup): boolean {
    if (this.query().trim()) {
      if (group === 'local') return this.filteredLocal().length > 0;
      if (group === 'tags') return this.filteredTags().length > 0;
      return true;
    }
    if (group === 'tags' && this.creatingTag()) return true;
    return this.expanded()[group];
  }

  isRemoteGroupOpen(path: string): boolean {
    if (this.query().trim()) return true;
    return this.expandedRemotes().has(path);
  }

  toggleRemoteGroup(path: string, event?: Event): void {
    event?.stopPropagation();
    if (this.query().trim()) return;
    this.expandedRemotes.update((set) => {
      const next = new Set(set);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  remoteChevron(path: string): string {
    return this.isRemoteGroupOpen(path) ? 'lucideChevronDown' : 'lucideChevronRight';
  }

  toggle(group: RefsGroup, event?: Event): void {
    event?.stopPropagation();
    if (this.query().trim()) return;
    this.expanded.update((state) => ({ ...state, [group]: !state[group] }));
  }

  setExpanded(group: RefsGroup, value: boolean): void {
    this.expanded.update((state) => ({ ...state, [group]: value }));
    if (group === 'lfs' && value) {
      void this.store.refreshLfsFiles();
    }
  }

  expandAll(event?: Event): void {
    event?.stopPropagation();
    this.expanded.set({
      local: true,
      tags: true,
      remotes: true,
      stash: true,
      worktrees: true,
      submodules: true,
      lfs: true,
    });
    this.expandedRemotes.set(new Set(this.remoteGroups().map((group) => group.path)));
    this.collapsedFolders.set(new Set());
    void this.store.refreshLfsFiles();
  }

  collapseAll(event?: Event): void {
    event?.stopPropagation();
    this.expanded.set({
      local: false,
      tags: false,
      remotes: false,
      stash: false,
      worktrees: false,
      submodules: false,
      lfs: false,
    });
    this.expandedRemotes.set(new Set());
    this.collapsedFolders.set(new Set(this.collectFolderPaths()));
  }

  chevron(group: RefsGroup): string {
    return this.isOpen(group) ? 'lucideChevronDown' : 'lucideChevronRight';
  }

  folderOpen(path: string): boolean {
    if (this.query().trim()) return true;
    return !this.collapsedFolders().has(path);
  }

  toggleFolder(path: string, event?: Event): void {
    event?.stopPropagation();
    if (this.query().trim()) return;
    this.collapsedFolders.update((set) => {
      const next = new Set(set);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  rowTreePath(row: BranchFlatRow | TagFlatRow): string {
    if (row.kind === 'branch') return row.branch.name;
    if (row.kind === 'tag') return row.path;
    const stripped = row.path.replace(/^[^:]+:/, '');
    return stripped;
  }

  onLocalScroll(index: number): void {
    this.localScrollIndex.set(index);
  }

  onTagScroll(index: number): void {
    this.tagScrollIndex.set(index);
  }

  onRemoteScroll(path: string, index: number): void {
    this.remoteScrollIndex.update((current) => ({ ...current, [path]: index }));
  }

  remoteTrail(group: RemoteGroupView): string {
    return this.treeTrail(group.rows, this.remoteScrollIndex()[group.path] ?? 0);
  }

  treeTrail(rows: Array<BranchFlatRow | TagFlatRow>, index: number): string {
    if (index <= 0 || !rows.length) return '';
    const row = rows[Math.min(index, rows.length - 1)];
    if (!row || row.depth < 2) return '';
    const parts = this.rowTreePath(row).split('/').filter(Boolean);
    parts.pop();
    return parts.join(' / ');
  }

  async deleteBranch(name: string): Promise<void> {
    await this.store.openSafety('deleteBranch', name);
  }

  cleanupLocalBranches(event?: Event): void {
    event?.stopPropagation();
    this.store.openBranchHygieneDialog();
  }

  fetchRemote(name: string, event?: Event): void {
    event?.stopPropagation();
    void this.store.fetchRemote(name);
  }

  pruneRemote(name: string, event?: Event): void {
    event?.stopPropagation();
    void this.store.pruneRemote(name);
  }

  revealCurrentBranch(event?: Event): void {
    event?.stopPropagation();
    const branch = this.currentBranch();
    if (!branch) {
      this.store.showWarning('No current local branch');
      return;
    }

    this.closeSuggest();
    this.query.set('');
    this.ensureSectionVisible('local');
    if (this.store.myBranchesOnly() && !this.store.isMyBranch(branch)) {
      this.store.setMyBranchesOnly(false);
    }

    this.expanded.update((state) => ({ ...state, local: true }));

    const parts = branch.name.split('/').filter(Boolean);
    if (parts.length > 1) {
      this.collapsedFolders.update((set) => {
        const next = new Set(set);
        for (let i = 1; i < parts.length; i++) {
          next.delete(`local:${parts.slice(0, i).join('/')}`);
        }
        return next;
      });
    }

    this.locateBranch(branch);
    this.scrollToBranch(branch.name);
  }

  locateBranch(branch: BranchInfo, event?: Event): void {
    event?.stopPropagation();
    if (!branch.tipSha) return;
    this.store.revealCommit(branch.tipSha);
    this.store.setBrowseTab('diff');
  }

  locateTag(sha: string, event?: Event): void {
    event?.stopPropagation();
    this.store.revealCommit(sha);
    this.store.setBrowseTab('diff');
  }

  checkoutBranch(branch: BranchInfo, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (branch.isCurrent) return;
    void this.store.checkoutBranch(branch.name);
  }

  onQueryChange(value: string): void {
    this.query.set(value);
    this.activeSuggest.set(0);
    this.suggestOpen.set(value.trim().length > 0);
  }

  onFilterFocus(): void {
    if (this.query().trim() && this.suggestions().length > 0) {
      this.suggestOpen.set(true);
    }
  }

  closeSuggest(): void {
    this.suggestOpen.set(false);
    this.activeSuggest.set(0);
  }

  onSuggestOutsideClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && target.closest('.refs .filter')) return;
    this.closeSuggest();
  }

  onFilterKeydown(event: KeyboardEvent): void {
    const open = this.suggestVisible();
    const items = this.suggestions();

    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        this.closeSuggest();
      }
      return;
    }

    if (!open || items.length === 0) {
      if (event.key === 'ArrowDown' && this.query().trim() && items.length > 0) {
        event.preventDefault();
        this.suggestOpen.set(true);
        this.activeSuggest.set(0);
      }
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeSuggest.update((i) => (i + 1) % items.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeSuggest.update((i) => (i - 1 + items.length) % items.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[this.activeSuggest()] ?? items[0];
      if (item) this.applySuggestion(item);
      return;
    }

    if (event.key === 'Tab' && !event.shiftKey) {
      const item = items[this.activeSuggest()] ?? items[0];
      if (item) {
        event.preventDefault();
        this.applySuggestion(item);
      }
    }
  }

  applySuggestion(item: RefSuggestion, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.query.set(item.name);
    this.closeSuggest();

    if (item.kind === 'local') {
      this.ensureSectionVisible('local');
      this.expanded.update((state) => ({ ...state, local: true }));
      this.expandFoldersForBranch('local', item.name);
      this.scrollToBranch(item.name);
      return;
    }

    if (item.kind === 'remote') {
      this.revealRemoteBranch(item.name);
      return;
    }

    if (item.kind === 'tag') {
      this.ensureSectionVisible('tags');
      this.expanded.update((state) => ({ ...state, tags: true }));
      this.expandFoldersForBranch('tags', item.name);
      return;
    }

    if (item.kind === 'folder') {
      this.ensureSectionVisible('local');
      this.expanded.update((state) => ({ ...state, local: true, remotes: true }));
    }
  }

  suggestKindLabel(kind: SuggestKind): string {
    if (kind === 'local') return 'Local';
    if (kind === 'remote') return 'Remote';
    if (kind === 'tag') return 'Tag';
    return 'Folder';
  }

  private matchScore(name: string, q: string): number {
    const lower = name.toLowerCase();
    if (lower === q) return 0;
    if (lower.startsWith(q)) return 1;
    const parts = lower.split(/[/_-]/);
    if (parts.some((p) => p.startsWith(q))) return 2;
    if (lower.includes(q)) return 3;
    return -1;
  }

  private collectFolderPaths(): string[] {
    const paths: string[] = [];
    const walkBranch = (nodes: BranchTreeNode[], scope: string) => {
      for (const node of nodes) {
        if (node.kind !== 'dir') continue;
        paths.push(`${scope}:${node.path}`);
        walkBranch(node.children, scope);
      }
    };
    walkBranch(this.buildBranchTree(this.filteredLocal()), 'local');
    for (const node of this.buildBranchTree(this.filteredRemote())) {
      if (node.kind !== 'dir') continue;
      walkBranch(node.children, `remote:${node.path}`);
    }
    const walkTag = (nodes: TagTreeNode[], scope: string) => {
      for (const node of nodes) {
        if (node.kind !== 'dir') continue;
        paths.push(`${scope}:${node.path}`);
        walkTag(node.children, scope);
      }
    };
    walkTag(this.buildTagTree(this.filteredTags()), 'tags');
    return paths;
  }

  private folderPrefixes(): string[] {
    const folders = new Set<string>();
    const addFrom = (name: string) => {
      const parts = name.split('/').filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        folders.add(parts.slice(0, i).join('/'));
      }
    };
    for (const b of this.store.filteredLocalBranches()) addFrom(b.name);
    for (const b of this.store.filteredRemoteBranches()) addFrom(b.name);
    for (const t of this.store.tags()) addFrom(t.name);
    return [...folders];
  }

  private expandFoldersForBranch(scope: string, name: string): void {
    const parts = name.split('/').filter(Boolean);
    if (parts.length <= 1) return;
    this.collapsedFolders.update((set) => {
      const next = new Set(set);
      for (let i = 1; i < parts.length; i++) {
        next.delete(`${scope}:${parts.slice(0, i).join('/')}`);
      }
      return next;
    });
  }

  private scrollToBranch(name: string): void {
    this.flashPath.set(name);
    queueMicrotask(() => {
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-branch-path="${CSS.escape(name)}"]`,
        );
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        if (this.flashTimer !== null) window.clearTimeout(this.flashTimer);
        this.flashCurrent.set(true);
        this.flashTimer = window.setTimeout(() => {
          this.flashCurrent.set(false);
          this.flashPath.set(null);
          this.flashTimer = null;
        }, 1400);
      }, 40);
    });
  }

  isFlashing(path: string): boolean {
    return this.flashCurrent() && this.flashPath() === path;
  }

  openBranchMenu(name: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.suppressMenuCloseUntil = performance.now() + 500;
    this.tagMenu.set(null);
    this.branchMenu.set({ name, x: event.clientX, y: event.clientY });
  }

  closeBranchMenu(): void {
    this.branchMenu.set(null);
  }

  openTagMenu(name: string, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.suppressMenuCloseUntil = performance.now() + 500;
    this.branchMenu.set(null);
    this.tagMenu.set({ name, x: event.clientX, y: event.clientY });
  }

  closeTagMenu(): void {
    this.tagMenu.set(null);
  }

  onBranchMenuDismiss(event?: Event): void {
    if (performance.now() < this.suppressMenuCloseUntil) return;
    if (event instanceof MouseEvent && (event.type === 'auxclick' || event.button === 2)) return;
    this.closeBranchMenu();
    this.closeTagMenu();
  }

  async copyRefName(name: string): Promise<void> {
    this.closeBranchMenu();
    this.closeTagMenu();
    try {
      await navigator.clipboard.writeText(name);
      this.store.showSuccess(`Copied ${name}`);
    } catch {
      this.store.showError('Could not copy name');
    }
  }

  locateTagFromMenu(name: string): void {
    const tag = this.store.tags().find((t) => t.name === name);
    this.closeTagMenu();
    if (tag) this.locateTag(tag.sha);
  }

  async mergeBranch(name: string): Promise<void> {
    this.closeBranchMenu();
    await this.store.mergeBranch(name);
  }

  async rebaseOnto(name: string): Promise<void> {
    this.closeBranchMenu();
    await this.store.rebaseOnto(name);
  }

  async rename(name: string): Promise<void> {
    this.closeBranchMenu();
    if (!this.menuLocalBranch(name)) {
      this.store.showWarning('Remote-tracking branches cannot be renamed here');
      return;
    }
    if (this.store.isBranchLocked(name)) {
      this.store.showWarning(`Branch '${name}' is locked. Unlock it before renaming.`);
      return;
    }
    const next = await this.prompts.ask({
      title: 'Rename branch',
      message: `Rename “${name}”.`,
      label: 'New name',
      initialValue: name,
      confirmLabel: 'Rename',
      mono: true,
    });
    if (!next?.trim() || next.trim() === name) return;
    await this.store.renameBranch(name, next.trim());
  }

  async lockBranch(name: string): Promise<void> {
    this.closeBranchMenu();
    const reason = await this.prompts.ask({
      title: `Lock ${name}`,
      message: 'Blocks push, force-push, rename, and delete while locked.',
      label: 'Reason (optional)',
      placeholder: 'Why is this branch locked?',
      confirmLabel: 'Lock',
      required: false,
      multiline: true,
    });
    if (reason === null) return;
    await this.store.lockBranch(name, reason.trim() || undefined);
  }

  async unlockBranch(name: string): Promise<void> {
    this.closeBranchMenu();
    await this.store.unlockBranch(name);
  }

  canLockBranch(name: string): boolean {
    return this.store.localBranches().some((b) => b.name === name);
  }

  menuTipSha(name: string): string | null {
    return (
      this.menuLocalBranch(name)?.tipSha ??
      this.menuRemoteBranch(name)?.tipSha ??
      this.store.tags().find((t) => t.name === name)?.sha ??
      null
    );
  }

  menuUpstream(name: string): string | null {
    const local = this.menuLocalBranch(name);
    if (!local) return null;
    return local.upstream ?? this.relatedRemote(local)?.name ?? null;
  }

  menuUpstreamShort(name: string): string | null {
    const upstream = this.menuUpstream(name);
    return upstream ? shortUpstream(upstream) : null;
  }

  remoteNameOf(ref: string): string | null {
    return parseRemoteRef(ref)?.remote ?? null;
  }

  showInGraph(name: string): void {
    const local = this.menuLocalBranch(name);
    const remote = this.menuRemoteBranch(name);
    this.closeBranchMenu();
    if (local) {
      this.locateBranch(local);
      return;
    }
    if (remote) {
      this.locateBranch(remote);
      return;
    }
    this.locateTagFromMenu(name);
  }

  async copySha(name: string): Promise<void> {
    const sha = this.menuTipSha(name);
    this.closeBranchMenu();
    this.closeTagMenu();
    if (!sha) {
      this.store.showWarning('No commit SHA to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(sha);
      this.store.showSuccess(`Copied ${sha.slice(0, 7)}`);
    } catch {
      this.store.showError('Could not copy SHA');
    }
  }

  async mergeUpstream(name: string): Promise<void> {
    this.closeBranchMenu();
    const upstream = this.menuUpstream(name);
    if (!upstream) {
      this.store.showWarning(`“${name}” has no origin branch to merge`);
      return;
    }
    await this.store.mergeBranch(upstream);
  }

  async rebaseOntoUpstream(name: string): Promise<void> {
    this.closeBranchMenu();
    const upstream = this.menuUpstream(name);
    if (!upstream) {
      this.store.showWarning(`“${name}” has no origin branch to rebase onto`);
      return;
    }
    await this.store.rebaseOnto(upstream);
  }

  async pullCurrent(rebase = false): Promise<void> {
    this.closeBranchMenu();
    await this.store.pullRemote(rebase);
  }

  async pushThis(name: string): Promise<void> {
    this.closeBranchMenu();
    await this.store.pushBranch(name);
  }

  async forcePushThis(name: string): Promise<void> {
    this.closeBranchMenu();
    await this.store.forcePush(name);
  }

  fetchThis(name: string): void {
    this.closeBranchMenu();
    const upstream = this.menuUpstream(name) ?? name;
    const remote = parseRemoteRef(upstream)?.remote;
    void this.store.fetchRemote(remote ?? undefined);
  }

  async fastForwardThis(name: string): Promise<void> {
    this.closeBranchMenu();
    const local = this.menuLocalBranch(name);
    const target = local ? this.menuUpstream(name) : name;
    if (!target) {
      this.store.showWarning(`“${name}” has no origin branch to fast-forward to`);
      return;
    }
    await this.store.fastForwardTo(target, local && !local.isCurrent ? local.name : undefined);
  }

  async setUpstream(name: string): Promise<void> {
    this.closeBranchMenu();
    const remotes = this.store.remoteBranches();
    if (remotes.length === 0) {
      this.store.showWarning('No remote-tracking branches yet — fetch first');
      return;
    }
    const current = this.menuUpstream(name);
    const guess =
      current ??
      remotes.find((r) => this.remoteTracksLocal(r.name, name))?.name ??
      remotes[0]?.name;
    const choice = await this.selects.ask({
      title: current ? `Change upstream for ${name}` : `Set upstream for ${name}`,
      message: 'Pull, push, and merge origin will use this remote-tracking branch.',
      label: 'Remote branch',
      options: remotes.map((r) => ({
        value: r.name,
        label: r.name,
        hint: r.tipShortSha ?? undefined,
      })),
      initialValue: guess,
      confirmLabel: 'Set upstream',
    });
    if (!choice) return;
    await this.store.setBranchUpstream(name, choice);
  }

  async unsetUpstream(name: string): Promise<void> {
    this.closeBranchMenu();
    await this.store.unsetBranchUpstream(name);
  }

  newBranchFrom(name: string): void {
    this.closeBranchMenu();
    this.closeTagMenu();
    void this.store.openCreateBranchDialog(name);
  }

  async newWorktreeFrom(name: string): Promise<void> {
    this.closeBranchMenu();
    const suggested = this.suggestedWorktreePath(name);
    const path = await this.prompts.ask({
      title: 'New worktree',
      message: `Check out “${name}” in a separate working directory.`,
      label: 'Path',
      initialValue: suggested,
      confirmLabel: 'Create',
      mono: true,
    });
    if (!path?.trim()) return;
    const inUse =
      this.menuLocalBranch(name)?.isCurrent ||
      this.store.worktrees().some((w) => w.branch === name);
    if (inUse) {
      const branch = await this.prompts.ask({
        title: 'New branch for worktree',
        message: `“${name}” is already checked out. Create a new branch from it for this worktree.`,
        label: 'Branch name',
        initialValue: name,
        confirmLabel: 'Create',
        mono: true,
      });
      if (!branch?.trim()) return;
      await this.store.addWorktree(path.trim(), {
        branch: branch.trim(),
        createBranch: true,
        startPoint: name,
      });
      return;
    }
    await this.store.addWorktree(path.trim(), { branch: name });
  }

  async createTagHere(name: string): Promise<void> {
    this.closeBranchMenu();
    const sha = this.menuTipSha(name);
    const tag = await this.prompts.ask({
      title: 'Create tag',
      message: `Tag the tip of “${name}”.`,
      label: 'Tag name',
      placeholder: 'v1.0.0',
      confirmLabel: 'Tag',
      mono: true,
    });
    if (!tag?.trim()) return;
    await this.store.createTag(tag.trim(), sha ?? undefined);
  }

  compareThis(name: string): void {
    this.closeBranchMenu();
    this.closeTagMenu();
    const sha = this.menuTipSha(name);
    if (!sha) {
      this.store.showWarning('No commit to compare');
      return;
    }
    this.store.compareWithCurrent(sha);
  }

  cherryPickTip(name: string): void {
    this.closeBranchMenu();
    this.closeTagMenu();
    const sha = this.menuTipSha(name);
    if (!sha) {
      this.store.showWarning('No commit to cherry-pick');
      return;
    }
    void this.store.openCherryPickPreview([sha]);
  }

  openPr(name: string): void {
    this.closeBranchMenu();
    void this.store.openCreatePullRequest(name);
  }

  async resetCurrent(name: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    this.closeBranchMenu();
    this.closeTagMenu();
    const sha = this.menuTipSha(name) ?? name;
    await this.store.resetTo(sha, mode);
  }

  async pushTag(name: string): Promise<void> {
    this.closeTagMenu();
    const remotes = this.store.remotes();
    if (remotes.length === 0) {
      this.store.showWarning('No remote configured');
      return;
    }
    let remote = remotes[0]?.name;
    if (remotes.length > 1) {
      const choice = await this.selects.ask({
        title: `Push tag ${name}`,
        message: 'Choose which remote to push this tag to.',
        label: 'Remote',
        options: remotes.map((r) => ({ value: r.name, label: r.name, hint: r.fetchUrl })),
        initialValue: remote,
        confirmLabel: 'Push tag',
      });
      if (!choice) return;
      remote = choice;
    }
    await this.store.pushTag(name, remote);
  }

  checkoutTag(name: string): void {
    this.closeTagMenu();
    void this.store.checkoutBranch(name);
  }

  async mergeTag(name: string): Promise<void> {
    this.closeTagMenu();
    await this.store.mergeBranch(name);
  }

  private suggestedWorktreePath(branch: string): string {
    const repo = this.store.currentRepo()?.path ?? '';
    const unix = repo.replace(/\\/g, '/').replace(/\/$/, '');
    const slash = unix.lastIndexOf('/');
    const parent = slash >= 0 ? unix.slice(0, slash) : unix;
    const repoName = slash >= 0 ? unix.slice(slash + 1) : unix || 'repo';
    const leaf = branch.replace(/\//g, '-');
    const sep = repo.includes('\\') ? '\\' : '/';
    return `${parent.replace(/\//g, sep)}${sep}${repoName}-${leaf}`;
  }

  startCreateTag(event?: Event): void {
    event?.stopPropagation();
    this.ensureSectionVisible('tags');
    this.creatingTag.set(true);
    this.newTag.set('');
    this.expanded.update((state) => ({ ...state, tags: true }));
  }

  async createTag(): Promise<void> {
    const name = this.newTag().trim();
    if (!name) return;
    await this.store.createTag(name, this.store.selectedSha() ?? undefined);
    this.creatingTag.set(false);
  }

  async deleteTag(name: string): Promise<void> {
    await this.store.deleteTag(name);
  }

  isTipSelected(tipSha: string | null | undefined): boolean {
    if (!tipSha) return false;
    const selected = this.store.selectedSha();
    if (!selected) return false;
    return tipSha === selected || tipSha.startsWith(selected) || selected.startsWith(tipSha.slice(0, 7));
  }

  isMainline(name: string): boolean {
    return isMainlineBranch(name);
  }

  branchTitle(branch: BranchInfo): string {
    if (branch.isCurrent) {
      const sync = this.syncLabel();
      const base = sync?.statusTooltip
        ? `${branch.name} (checked out) · ${sync.statusTooltip}`
        : `${branch.name} (checked out)`;
      return `${base} · Click to show tip in the graph`;
    }
    const wt = this.store.worktrees().find((w) => !w.isMain && w.branch === branch.name);
    if (wt) {
      return `${branch.name} (checked out in another worktree) · Click to show tip · Double-click to switch here`;
    }
    if (branch.upstream) {
      return branch.upstreamGone
        ? `${branch.name} · upstream gone (${branch.upstream}) · Click to show tip · Double-click to checkout`
        : `${branch.name} · tracks ${branch.upstream} · Click to show tip · Double-click to checkout`;
    }
    return `${branch.name} · Click to show tip · Double-click to checkout`;
  }

  upstreamLabel(branch: BranchInfo): string | null {
    if (!branch.upstream) return null;
    return shortUpstream(branch.upstream);
  }

  relatedRemote(branch: BranchInfo): BranchInfo | null {
    if (branch.upstream) {
      const up = this.store.remoteBranches().find((r) => r.name === branch.upstream);
      if (up) return up;
    }
    return (
      this.store.remoteBranches().find((r) => this.remoteTracksLocal(r.name, branch.name)) ?? null
    );
  }

  menuLocalBranch(name: string): BranchInfo | null {
    return this.store.localBranches().find((b) => b.name === name) ?? null;
  }

  menuRemoteBranch(name: string): BranchInfo | null {
    return this.store.remoteBranches().find((b) => b.name === name) ?? null;
  }

  revealUpstream(branch: BranchInfo, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.closeSuggest();

    const related = this.relatedRemote(branch);
    if (related) {
      this.revealRemoteBranch(related.name);
      return;
    }

    if (branch.upstream) {
      this.store.showWarning(`Upstream ${branch.upstream} is missing — fetch or prune may be needed`);
      return;
    }

    this.query.set('');
    this.ensureSectionVisible('remotes');
    this.expanded.update((state) => ({ ...state, remotes: true }));
    const firstRemote = this.store.remoteBranches()[0]?.name.split('/')[0];
    if (firstRemote) {
      this.expandedRemotes.update((set) => new Set(set).add(`remote:${firstRemote}`));
    }
    this.store.showInfo(`“${branch.name}” has no upstream yet — publish it to create one`);
  }

  revealRemoteBranch(name: string): void {
    this.closeSuggest();
    const remote = name.split('/')[0];
    if (remote) this.ensureSectionVisible(`remote:${remote}`);
    this.expandedRemotes.update((set) => {
      const next = new Set(set);
      if (remote) next.add(`remote:${remote}`);
      return next;
    });
    this.expandFoldersForBranch('remote', name);

    const leaf = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    if (this.query().trim() && !name.toLowerCase().includes(this.query().trim().toLowerCase())) {
      this.query.set(leaf);
    }

    this.scrollToBranch(name);
  }

  private ensureSectionVisible(id: string): void {
    this.store.setRefsGroupHidden(id, false);
  }

  private sectionHasQueryMatch(id: string): boolean {
    const q = this.query().trim().toLowerCase();
    if (!q) return false;
    if (id === 'local') return this.filteredLocal().length > 0;
    if (id === 'tags') return this.filteredTags().length > 0;
    if (id === 'remotes') {
      return this.store
        .remotes()
        .some((r) => r.name.toLowerCase().includes(q) || r.fetchUrl.toLowerCase().includes(q));
    }
    if (id === 'stash') {
      return this.store
        .stashes()
        .some((s) => s.id.toLowerCase().includes(q) || s.message.toLowerCase().includes(q));
    }
    if (id === 'worktrees') {
      return this.store
        .worktrees()
        .some(
          (w) =>
            w.path.toLowerCase().includes(q) ||
            (w.branch ?? '').toLowerCase().includes(q) ||
            w.shortHead.toLowerCase().includes(q),
        );
    }
    if (id === 'submodules') {
      return this.store
        .submodules()
        .some(
          (s) =>
            s.path.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            s.url.toLowerCase().includes(q),
        );
    }
    if (id === 'lfs') {
      return this.store.lfsFiles().some((f) => f.path.toLowerCase().includes(q));
    }
    if (id.startsWith('remote:')) {
      return (this.remoteGroups().find((group) => group.path === id)?.count ?? 0) > 0;
    }
    return false;
  }

  private remoteTracksLocal(remoteName: string, localName: string): boolean {
    const slash = remoteName.indexOf('/');
    if (slash < 0) return false;
    return remoteName.slice(slash + 1) === localName;
  }

  private filterByQuery<T extends { name: string }>(items: T[]): T[] {
    const q = this.query().trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.name.toLowerCase().includes(q));
  }

  private buildBranchTree(branches: BranchInfo[]): BranchTreeNode[] {
    type MutableDir = {
      kind: 'dir';
      name: string;
      path: string;
      children: Map<string, MutableDir | BranchTreeLeaf>;
    };

    const root: MutableDir = { kind: 'dir', name: '', path: '', children: new Map() };

    for (const branch of branches) {
      const parts = branch.name.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      let cursor = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const path = parts.slice(0, i + 1).join('/');
        const isLeaf = i === parts.length - 1;
        if (isLeaf) {
          cursor.children.set(part, {
            kind: 'branch',
            name: part,
            path: branch.name,
            branch,
          });
        } else {
          let next = cursor.children.get(part);
          if (!next || next.kind !== 'dir') {
            next = { kind: 'dir', name: part, path, children: new Map() };
            cursor.children.set(part, next);
          }
          cursor = next as MutableDir;
        }
      }
    }

    const toNodes = (dir: MutableDir): BranchTreeNode[] => {
      const nodes: BranchTreeNode[] = [];
      const entries = [...dir.children.values()].sort((a, b) => {
        const rank = (entry: MutableDir | BranchTreeLeaf): number => {
          if (entry.kind === 'branch' && isMainlineBranch(entry.branch.name)) return 0;
          if (entry.kind === 'dir') return 1;
          return 2;
        };
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          const children = toNodes(entry);
          nodes.push({
            kind: 'dir',
            name: entry.name,
            path: entry.path,
            children,
            branchCount: children.reduce((n, c) => n + (c.kind === 'branch' ? 1 : c.branchCount), 0),
          });
        } else {
          nodes.push(entry);
        }
      }
      return nodes;
    };

    return toNodes(root);
  }

  private flattenBranchTree(nodes: BranchTreeNode[], scope: string): BranchFlatRow[] {
    const out: BranchFlatRow[] = [];
    const walk = (list: BranchTreeNode[], depth: number, ancestorContinues: boolean[]) => {
      list.forEach((node, index) => {
        const isLast = index === list.length - 1;
        const guides = treeGuides(depth, ancestorContinues, isLast);
        if (node.kind === 'dir') {
          const folderPath = `${scope}:${node.path}`;
          const open = this.folderOpen(folderPath);
          out.push({
            kind: 'dir',
            path: folderPath,
            name: node.name,
            depth,
            branchCount: node.branchCount,
            open,
            guides,
          });
          if (open) walk(node.children, depth + 1, [...ancestorContinues, !isLast]);
        } else {
          out.push({
            kind: 'branch',
            path: node.path,
            name: node.name,
            depth,
            branch: node.branch,
            guides,
          });
        }
      });
    };
    walk(nodes, 0, []);
    return out;
  }

  private buildTagTree(tags: { name: string; sha: string }[]): TagTreeNode[] {
    type MutableDir = {
      kind: 'dir';
      name: string;
      path: string;
      children: Map<string, MutableDir | TagTreeLeaf>;
    };

    const root: MutableDir = { kind: 'dir', name: '', path: '', children: new Map() };

    for (const tag of tags) {
      const parts = tag.name.split('/').filter(Boolean);
      if (parts.length === 0) continue;
      let cursor = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const path = parts.slice(0, i + 1).join('/');
        const isLeaf = i === parts.length - 1;
        if (isLeaf) {
          cursor.children.set(part, {
            kind: 'tag',
            name: part,
            path: tag.name,
            sha: tag.sha,
          });
        } else {
          let next = cursor.children.get(part);
          if (!next || next.kind !== 'dir') {
            next = { kind: 'dir', name: part, path, children: new Map() };
            cursor.children.set(part, next);
          }
          cursor = next as MutableDir;
        }
      }
    }

    const toNodes = (dir: MutableDir): TagTreeNode[] => {
      const nodes: TagTreeNode[] = [];
      const entries = [...dir.children.values()].sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const entry of entries) {
        if (entry.kind === 'dir') {
          const children = toNodes(entry);
          nodes.push({
            kind: 'dir',
            name: entry.name,
            path: entry.path,
            children,
            tagCount: children.reduce((n, c) => n + (c.kind === 'tag' ? 1 : c.tagCount), 0),
          });
        } else {
          nodes.push(entry);
        }
      }
      return nodes;
    };

    return toNodes(root);
  }

  private flattenTagTree(nodes: TagTreeNode[], scope: string): TagFlatRow[] {
    const out: TagFlatRow[] = [];
    const walk = (list: TagTreeNode[], depth: number, ancestorContinues: boolean[]) => {
      list.forEach((node, index) => {
        const isLast = index === list.length - 1;
        const guides = treeGuides(depth, ancestorContinues, isLast);
        if (node.kind === 'dir') {
          const folderPath = `${scope}:${node.path}`;
          const open = this.folderOpen(folderPath);
          out.push({
            kind: 'dir',
            path: folderPath,
            name: node.name,
            depth,
            tagCount: node.tagCount,
            open,
            guides,
          });
          if (open) walk(node.children, depth + 1, [...ancestorContinues, !isLast]);
        } else {
          out.push({
            kind: 'tag',
            path: node.path,
            name: node.name,
            depth,
            sha: node.sha,
            guides,
          });
        }
      });
    };
    walk(nodes, 0, []);
    return out;
  }
}

function treeGuides(
  depth: number,
  ancestorContinues: boolean[],
  isLast: boolean,
): TreeGuideKind[] {
  const guides: TreeGuideKind[] = [];
  for (let i = 0; i < depth; i++) {
    if (i < depth - 1) guides.push(ancestorContinues[i] ? 'line' : 'blank');
    else guides.push(isLast ? 'corner' : 'tee');
  }
  return guides;
}
