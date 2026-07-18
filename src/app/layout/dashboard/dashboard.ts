import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { open } from '@tauri-apps/plugin-dialog';
import { formatDistanceToNowStrict } from 'date-fns';
import Fuse from 'fuse.js';
import { AppStore } from '../../core/app.store';
import type { RecentRepo } from '../../core/models';
import { BrandMark } from '../../shared/ui/brand-mark/brand-mark';
import { EmptyState } from '../../shared/ui/empty-state/empty-state';
import { PromptService } from '../../shared/ui/prompt-dialog/prompt.service';

type SortMode = 'recent' | 'name';

interface RepoGroup {
  key: string;
  label: string;
  repos: RecentRepo[];
}

@Component({
  selector: 'app-dashboard',
  imports: [FormsModule, NgIcon, EmptyState, BrandMark],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly query = signal('');
  readonly sortMode = signal<SortMode>('recent');
  readonly collapsedGroups = signal<Record<string, boolean>>({});

  readonly filtered = computed(() => {
    const repos = this.store.repos();
    const q = this.query().trim();
    let list: RecentRepo[];
    if (!q) {
      list = [...repos];
    } else {
      const fuse = new Fuse(repos, {
        keys: [
          { name: 'name', weight: 0.7 },
          { name: 'path', weight: 0.3 },
        ],
        threshold: 0.4,
        ignoreLocation: true,
      });
      list = fuse.search(q).map((r) => r.item);
    }

    const mode = this.sortMode();
    if (mode === 'name') {
      return list.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
    });
  });

  readonly filteredCount = computed(() => this.filtered().length);
  readonly totalCount = computed(() => this.store.repos().length);

  readonly continueRepo = computed(() => {
    if (this.query().trim()) return null;
    const repos = this.store.repos();
    return repos.find((r) => r.isLast) ?? repos[0] ?? null;
  });

  readonly pinned = computed(() => {
    const resumePath = this.continueRepo()?.path;
    return this.filtered().filter((r) => r.pinned && r.path !== resumePath);
  });

  readonly groups = computed((): RepoGroup[] => {
    const resumePath = this.continueRepo()?.path;
    const unpinned = this.filtered().filter((r) => !r.pinned && r.path !== resumePath);
    const map = new Map<string, RecentRepo[]>();
    for (const repo of unpinned) {
      const key = parentDir(repo.path);
      const list = map.get(key) ?? [];
      list.push(repo);
      map.set(key, list);
    }
    return [...map.entries()]
      .map(([key, repos]) => ({
        key,
        label: shortenPath(key),
        repos:
          this.sortMode() === 'name'
            ? [...repos].sort((a, b) => a.name.localeCompare(b.name))
            : [...repos].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  });

  relativeTime(iso: string): string {
    try {
      return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
    } catch {
      return '';
    }
  }

  setSort(mode: SortMode): void {
    this.sortMode.set(mode);
  }

  isGroupCollapsed(key: string): boolean {
    return !!this.collapsedGroups()[key];
  }

  toggleGroup(key: string): void {
    this.collapsedGroups.update((map) => ({ ...map, [key]: !map[key] }));
  }

  collapseAll(): void {
    const next: Record<string, boolean> = {};
    for (const g of this.groups()) {
      next[g.key] = true;
    }
    this.collapsedGroups.set(next);
  }

  expandAll(): void {
    this.collapsedGroups.set({});
  }

  private isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  async openFolder(): Promise<void> {
    if (this.isTauri()) {
      try {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === 'string' && selected) {
          await this.store.openRepo(selected);
        }
      } catch (err) {
        this.store.showError(err);
      }
      return;
    }
    const path = await this.prompts.ask({
      title: 'Open repository',
      message: 'Enter the full path to a Git repository.',
      label: 'Repository path',
      placeholder: '/Users/you/Projects/repo',
      confirmLabel: 'Open',
      mono: true,
    });
    if (path?.trim()) {
      await this.store.openRepo(path.trim());
    }
  }

  async initRepo(): Promise<void> {
    let path: string | null = null;
    if (this.isTauri()) {
      try {
        const selected = await open({ directory: true, multiple: false });
        if (typeof selected === 'string') path = selected;
      } catch (err) {
        this.store.showError(err);
        return;
      }
    } else {
      path = await this.prompts.ask({
        title: 'Initialize repository',
        message: 'Choose a folder path to run git init.',
        label: 'Folder path',
        placeholder: '/Users/you/Projects/new-repo',
        confirmLabel: 'Initialize',
        mono: true,
      });
    }
    if (!path?.trim()) return;
    await this.store.initRepo(path.trim());
  }
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx) || '/';
}

function shortenPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const homeMatch = normalized.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (homeMatch) {
    return '~' + normalized.slice(homeMatch[1].length);
  }
  if (normalized.length > 48) {
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length > 3) {
      return '…/' + parts.slice(-3).join('/');
    }
  }
  return normalized;
}
