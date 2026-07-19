import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { BranchInfo } from '../../../core/models';
import { describeBranchSync, shortUpstream } from '../../../shared/git/branch-sync';
import { isMainlineBranch } from '../../../shared/git/mainline-branch';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { RemotesPanel } from '../../remotes/remotes-panel/remotes-panel';
import { StashPanel } from '../../stash/stash-panel/stash-panel';
import { WorktreesPanel } from '../../worktrees/worktrees-panel/worktrees-panel';

export type RefsGroup = 'local' | 'tags' | 'remotes' | 'stash' | 'worktrees';

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

type BranchFlatRow =
  | { kind: 'dir'; path: string; name: string; depth: number; branchCount: number; open: boolean }
  | { kind: 'branch'; path: string; name: string; depth: number; branch: BranchInfo };

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
  | { kind: 'dir'; path: string; name: string; depth: number; tagCount: number; open: boolean }
  | { kind: 'tag'; path: string; name: string; depth: number; sha: string };

@Component({
  selector: 'app-refs-panel',
  imports: [
    FormsModule,
    NgIcon,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    StashPanel,
    RemotesPanel,
    WorktreesPanel,
  ],
  templateUrl: './refs-panel.html',
  styleUrl: './refs-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RefsPanel {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly creatingTag = signal(false);
  readonly newTag = signal('');
  readonly query = signal('');
  readonly suggestOpen = signal(false);
  readonly activeSuggest = signal(0);
  readonly branchMenu = signal<{ name: string; x: number; y: number } | null>(null);
  readonly collapsedFolders = signal<Set<string>>(new Set());
  readonly expandedRemotes = signal<Set<string>>(new Set());
  readonly expanded = signal<Record<RefsGroup, boolean>>({
    local: true,
    tags: false,
    remotes: false,
    stash: false,
    worktrees: false,
  });
  private suppressMenuCloseUntil = 0;

  readonly menuOrigin = computed(() => {
    const menu = this.branchMenu();
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
    for (const branch of remotes) {
      if (branch.name.toLowerCase().includes(q)) {
        matched.set(branch.name, branch);
      }
    }

    for (const local of this.filteredLocal()) {
      if (local.upstream) {
        const up = remotes.find((r) => r.name === local.upstream);
        if (up) matched.set(up.name, up);
      }
      for (const remote of remotes) {
        if (this.remoteTracksLocal(remote.name, local.name)) {
          matched.set(remote.name, remote);
        }
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
  readonly remoteGroups = computed((): RemoteGroupView[] => {
    const tree = this.buildBranchTree(this.filteredRemote());
    return tree.map((node) => {
      if (node.kind === 'dir') {
        const path = `remote:${node.path}`;
        return {
          name: node.name,
          path,
          count: node.branchCount,
          rows: this.flattenBranchTree(node.children, path),
        };
      }
      const path = `remote:${node.path}`;
      return {
        name: node.name,
        path,
        count: 1,
        rows: [
          {
            kind: 'branch',
            path: node.path,
            name: node.name,
            depth: 0,
            branch: node.branch,
          },
        ],
      };
    });
  });
  readonly tagRows = computed(() => this.flattenTagTree(this.buildTagTree(this.filteredTags()), 'tags'));

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

  async deleteBranch(name: string): Promise<void> {
    await this.store.openSafety('deleteBranch', name);
  }

  async cleanupLocalBranches(event?: Event): Promise<void> {
    event?.stopPropagation();
    await this.store.deleteOtherLocalBranches();
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

    if (branch.tipSha) {
      this.store.selectCommit(branch.tipSha);
      this.store.setBrowseTab('diff');
    }

    this.scrollToBranch(branch.name);
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
      this.expanded.update((state) => ({ ...state, tags: true }));
      this.expandFoldersForBranch('tags', item.name);
      return;
    }

    if (item.kind === 'folder') {
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
    this.branchMenu.set({ name, x: event.clientX, y: event.clientY });
  }

  closeBranchMenu(): void {
    this.branchMenu.set(null);
  }

  onBranchMenuDismiss(event?: Event): void {
    if (performance.now() < this.suppressMenuCloseUntil) return;
    if (event instanceof MouseEvent && (event.type === 'auxclick' || event.button === 2)) return;
    this.closeBranchMenu();
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

  startCreateTag(event?: Event): void {
    event?.stopPropagation();
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
      if (sync?.statusTooltip) return `${branch.name} (checked out) · ${sync.statusTooltip}`;
      return `${branch.name} (checked out)`;
    }
    const wt = this.store.worktrees().find((w) => !w.isMain && w.branch === branch.name);
    if (wt) return `${branch.name} (checked out in another worktree)`;
    if (branch.upstream) {
      return branch.upstreamGone
        ? `Checkout ${branch.name} · upstream gone (${branch.upstream})`
        : `Checkout ${branch.name} · tracks ${branch.upstream}`;
    }
    return `Checkout ${branch.name}`;
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
    const walk = (list: BranchTreeNode[], depth: number) => {
      for (const node of list) {
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
          });
          if (open) walk(node.children, depth + 1);
        } else {
          out.push({
            kind: 'branch',
            path: node.path,
            name: node.name,
            depth,
            branch: node.branch,
          });
        }
      }
    };
    walk(nodes, 0);
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
    const walk = (list: TagTreeNode[], depth: number) => {
      for (const node of list) {
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
          });
          if (open) walk(node.children, depth + 1);
        } else {
          out.push({
            kind: 'tag',
            path: node.path,
            name: node.name,
            depth,
            sha: node.sha,
          });
        }
      }
    };
    walk(nodes, 0);
    return out;
  }
}
