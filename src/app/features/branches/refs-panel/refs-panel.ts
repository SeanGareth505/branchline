import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { BranchInfo } from '../../../core/models';
import { describeBranchSync } from '../../../shared/git/branch-sync';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { RemotesPanel } from '../../remotes/remotes-panel/remotes-panel';
import { StashPanel } from '../../stash/stash-panel/stash-panel';
import { WorktreesPanel } from '../../worktrees/worktrees-panel/worktrees-panel';

export type RefsGroup = 'local' | 'tags' | 'remotes' | 'stash' | 'worktrees';

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
  imports: [FormsModule, NgIcon, CdkConnectedOverlay, StashPanel, RemotesPanel, WorktreesPanel],
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

  readonly syncLabel = computed(() =>
    describeBranchSync(this.store.status(), { hasRemotes: this.store.remotes().length > 0 }),
  );

  readonly filteredLocal = computed(() => this.filterByQuery(this.store.filteredLocalBranches()));
  readonly filteredRemote = computed(() => this.filterByQuery(this.store.filteredRemoteBranches()));
  readonly filteredTags = computed(() => {
    const q = this.query().trim().toLowerCase();
    const tags = this.store.tags();
    if (!q) return tags;
    return tags.filter((t) => t.name.toLowerCase().includes(q));
  });

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

  branchTitle(branch: BranchInfo): string {
    if (branch.isCurrent) {
      const sync = this.syncLabel();
      if (sync?.tooltip) return `${branch.name} · ${sync.tooltip}`;
      return `${branch.name} (checked out)`;
    }
    const wt = this.store.worktrees().find((w) => !w.isMain && w.branch === branch.name);
    if (wt) return `${branch.name} (checked out in another worktree)`;
    if (branch.upstream) {
      return branch.upstreamGone
        ? `${branch.name} · upstream gone (${branch.upstream})`
        : `${branch.name} → ${branch.upstream}`;
    }
    return branch.name;
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
