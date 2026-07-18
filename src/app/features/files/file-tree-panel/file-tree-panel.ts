import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { FileStatusEntry, FileStatusKind } from '../../../core/models';

type FileArea = 'staged' | 'unstaged' | 'untracked' | 'conflicted';
type FilterChip = 'all' | FileArea;

interface TreeFile {
  path: string;
  name: string;
  status: FileStatusKind;
  area: FileArea;
}

interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: TreeNode[];
  fileCount: number;
}

interface TreeFileNode {
  kind: 'file';
  name: string;
  path: string;
  file: TreeFile;
}

type TreeNode = TreeDir | TreeFileNode;

type FlatRow =
  | { kind: 'dir'; path: string; name: string; depth: number; fileCount: number; open: boolean }
  | { kind: 'file'; path: string; name: string; depth: number; file: TreeFile };

@Component({
  selector: 'app-file-tree-panel',
  imports: [FormsModule, NgIcon],
  templateUrl: './file-tree-panel.html',
  styleUrl: './file-tree-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FileTreePanel {
  readonly store = inject(AppStore);
  readonly query = signal('');
  readonly filter = signal<FilterChip>('all');
  readonly collapsed = signal<Set<string>>(new Set());

  readonly counts = computed(() => {
    const s = this.store.status();
    return {
      staged: s?.staged.length ?? 0,
      unstaged: s?.unstaged.length ?? 0,
      untracked: s?.untracked.length ?? 0,
      conflicted: s?.conflicted.length ?? 0,
      total:
        (s?.staged.length ?? 0) +
        (s?.unstaged.length ?? 0) +
        (s?.untracked.length ?? 0) +
        (s?.conflicted.length ?? 0),
    };
  });

  readonly files = computed((): TreeFile[] => {
    const s = this.store.status();
    if (!s) return [];
    const out: TreeFile[] = [];
    const push = (entries: FileStatusEntry[], area: FileArea) => {
      for (const e of entries) {
        out.push({
          path: e.path,
          name: e.path.split('/').pop() || e.path,
          status: e.status,
          area,
        });
      }
    };
    push(s.conflicted, 'conflicted');
    push(s.staged, 'staged');
    push(s.unstaged, 'unstaged');
    push(s.untracked, 'untracked');
    return out;
  });

  readonly visibleFiles = computed(() => {
    const q = this.query().trim().toLowerCase();
    const chip = this.filter();
    return this.files().filter((f) => {
      if (chip !== 'all' && f.area !== chip) return false;
      if (!q) return true;
      return f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q);
    });
  });

  readonly tree = computed(() => this.buildTree(this.visibleFiles()));

  readonly rows = computed((): FlatRow[] => {
    const collapsed = this.collapsed();
    const out: FlatRow[] = [];
    const walk = (nodes: TreeNode[], depth: number) => {
      for (const node of nodes) {
        if (node.kind === 'dir') {
          const open = !collapsed.has(node.path);
          out.push({
            kind: 'dir',
            path: node.path,
            name: node.name,
            depth,
            fileCount: node.fileCount,
            open,
          });
          if (open) walk(node.children, depth + 1);
        } else {
          out.push({
            kind: 'file',
            path: node.path,
            name: node.name,
            depth,
            file: node.file,
          });
        }
      }
    };
    walk(this.tree(), 0);
    return out;
  });

  readonly selectedPath = computed(() => this.store.selectedDiffPath());

  setFilter(chip: FilterChip): void {
    this.filter.set(chip);
  }

  toggleDir(path: string): void {
    this.collapsed.update((set) => {
      const next = new Set(set);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  expandAll(): void {
    this.collapsed.set(new Set());
  }

  collapseAll(): void {
    const dirs = new Set<string>();
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'dir') {
          dirs.add(n.path);
          walk(n.children);
        }
      }
    };
    walk(this.tree());
    this.collapsed.set(dirs);
  }

  openDiff(path: string): void {
    this.store.selectedDiffPath.set(path);
    this.store.setBrowseTab('diff');
  }

  openHistory(path: string): void {
    this.store.openFileHistory(path);
  }

  openBlame(path: string): void {
    this.store.openFileBlame(path);
  }

  markResolved(path: string): void {
    void this.store.stagePaths([path]);
  }

  stageFile(path: string): void {
    void this.store.stagePaths([path]);
  }

  unstageFile(path: string): void {
    void this.store.unstagePaths([path]);
  }

  discardFile(path: string): void {
    void this.store.discardPaths([path]);
  }

  statusGlyph(status: FileStatusKind, area: FileArea): string {
    if (area === 'conflicted') return '!';
    if (area === 'staged') return 'S';
    if (area === 'untracked' || status === 'untracked') return '?';
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    if (status === 'renamed') return 'R';
    return 'M';
  }

  statusClass(status: FileStatusKind, area: FileArea): string {
    if (area === 'conflicted' || status === 'conflicted') return 'st-conflict';
    if (area === 'untracked' || status === 'untracked' || status === 'added') return 'st-added';
    if (status === 'deleted') return 'st-deleted';
    if (status === 'renamed' || status === 'copied') return 'st-renamed';
    return 'st-modified';
  }

  areaLabel(area: FileArea): string {
    if (area === 'staged') return 'Staged';
    if (area === 'unstaged') return 'Changes';
    if (area === 'untracked') return 'New';
    return 'Conflict';
  }

  private buildTree(files: TreeFile[]): TreeNode[] {
    type MutableDir = {
      kind: 'dir';
      name: string;
      path: string;
      children: Map<string, MutableDir | TreeFileNode>;
    };

    const root: MutableDir = { kind: 'dir', name: '', path: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/').filter(Boolean);
      let cursor = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isFile = i === parts.length - 1;
        const path = parts.slice(0, i + 1).join('/');
        if (isFile) {
          cursor.children.set(part, {
            kind: 'file',
            name: part,
            path: file.path,
            file,
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

    const toNodes = (dir: MutableDir): TreeNode[] => {
      const nodes: TreeNode[] = [];
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
            fileCount: children.reduce((n, c) => n + (c.kind === 'file' ? 1 : c.fileCount), 0),
          });
        } else {
          nodes.push(entry);
        }
      }
      return nodes;
    };

    return toNodes(root);
  }
}
