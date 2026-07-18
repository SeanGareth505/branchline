import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import Fuse from 'fuse.js';
import { AppStore } from '../../core/app.store';
import type { HostRepository, RecentRepo } from '../../core/models';
import { PromptService } from '../../shared/ui/prompt-dialog/prompt.service';

type SwitcherTab = 'local' | 'remote';

interface LocalGroup {
  key: string;
  label: string;
  repos: RecentRepo[];
}

interface HostGroup {
  key: string;
  label: string;
  repos: HostRepository[];
}

type FlatItem =
  | { kind: 'local'; repo: RecentRepo }
  | { kind: 'host'; repo: HostRepository };

@Component({
  selector: 'app-project-switcher',
  imports: [FormsModule, NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './project-switcher.html',
  styleUrl: './project-switcher.scss',
})
export class ProjectSwitcher {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly menuOpen = signal(false);
  readonly filter = signal('');
  readonly tab = signal<SwitcherTab>('local');
  readonly activeIndex = signal(0);
  readonly collapsedGroups = signal<Record<string, boolean>>({});
  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
  ];

  readonly triggerLabel = computed(() =>
    this.store.openRepos().length ? 'Repos' : 'Open repo',
  );

  readonly triggerTitle = computed(() => {
    const current = this.store.currentRepo();
    if (!current) return 'Open or switch repositories';
    const branch = this.store.status()?.branch;
    return branch ? `${current.path}\non ${branch}` : current.path;
  });

  readonly linkedHosts = computed(() => this.store.linkedGitHosts());
  readonly signedIn = computed(() => this.linkedHosts().length > 0);
  readonly linkedHostLabels = computed(() => this.linkedHosts().map((h) => h.label).join(', '));

  readonly localRepos = computed(() => {
    const current = this.store.currentRepo()?.path;
    const repos = this.store.repos().filter((r) => r.path !== current);
    const q = this.filter().trim();
    if (!q) {
      return [...repos].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
      });
    }
    const fuse = new Fuse(repos, {
      keys: [
        { name: 'name', weight: 0.7 },
        { name: 'path', weight: 0.3 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
    });
    return fuse.search(q).map((r) => r.item);
  });

  readonly localCount = computed(() => this.localRepos().length);

  readonly localGroups = computed((): LocalGroup[] => {
    const groups = new Map<string, RecentRepo[]>();
    for (const repo of this.localRepos()) {
      const key = parentDir(repo.path);
      const list = groups.get(key) ?? [];
      list.push(repo);
      groups.set(key, list);
    }
    return [...groups.entries()]
      .map(([key, repos]) => ({
        key,
        label: shortenHome(key),
        repos: [...repos].sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
      }))
      .sort((a, b) => {
        const aPinned = a.repos.some((r) => r.pinned);
        const bPinned = b.repos.some((r) => r.pinned);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return a.label.localeCompare(b.label);
      });
  });

  readonly hostReposFiltered = computed(() => {
    const repos = this.store.hostRepos();
    const q = this.filter().trim();
    if (!q) return repos;
    const fuse = new Fuse(repos, {
      keys: [
        { name: 'name', weight: 0.5 },
        { name: 'fullName', weight: 0.4 },
        { name: 'provider', weight: 0.1 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
    });
    return fuse.search(q).map((r) => r.item);
  });

  readonly hostCount = computed(() => this.hostReposFiltered().length);

  readonly hostGroups = computed((): HostGroup[] => {
    const groups = new Map<string, HostRepository[]>();
    for (const repo of this.hostReposFiltered()) {
      const owner = repo.fullName.includes('/')
        ? repo.fullName.slice(0, repo.fullName.lastIndexOf('/'))
        : repo.provider;
      const list = groups.get(owner) ?? [];
      list.push(repo);
      groups.set(owner, list);
    }
    return [...groups.entries()]
      .map(([key, repos]) => ({
        key,
        label: key,
        repos: [...repos].sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });

  readonly flatItems = computed((): FlatItem[] => {
    const collapsed = this.collapsedGroups();
    if (this.tab() === 'local') {
      const items: FlatItem[] = [];
      for (const group of this.localGroups()) {
        if (collapsed[group.key]) continue;
        for (const repo of group.repos) {
          items.push({ kind: 'local', repo });
        }
      }
      return items;
    }
    const items: FlatItem[] = [];
    for (const group of this.hostGroups()) {
      if (collapsed[group.key]) continue;
      for (const repo of group.repos) {
        items.push({ kind: 'host', repo });
      }
    }
    return items;
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.menuOpen.set(false);
  }

  toggle(): void {
    this.menuOpen.update((v) => !v);
    if (this.menuOpen()) {
      this.filter.set('');
      this.activeIndex.set(0);
      this.collapsedGroups.set({});
      if (this.store.repos().length === 0 && this.signedIn()) {
        this.tab.set('remote');
      } else {
        this.tab.set('local');
      }
      if (this.signedIn()) {
        void this.store.refreshHostRepositories();
      }
      queueMicrotask(() => this.searchInput()?.nativeElement.focus());
    } else {
      this.filter.set('');
    }
  }

  close(): void {
    this.menuOpen.set(false);
    this.filter.set('');
    this.activeIndex.set(0);
  }

  setTab(tab: SwitcherTab): void {
    this.tab.set(tab);
    this.activeIndex.set(0);
    queueMicrotask(() => this.searchInput()?.nativeElement.focus());
  }

  onFilterChange(value: string): void {
    this.filter.set(value);
    this.activeIndex.set(0);
  }

  isGroupCollapsed(key: string): boolean {
    return !!this.collapsedGroups()[key];
  }

  toggleGroup(key: string, event: Event): void {
    event.stopPropagation();
    this.collapsedGroups.update((map) => ({ ...map, [key]: !map[key] }));
  }

  onSearchKeydown(event: KeyboardEvent): void {
    const items = this.flatItems();
    if (!items.length) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.activeIndex.update((i) => Math.min(i + 1, items.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.activeIndex.update((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[this.activeIndex()];
      if (!item) return;
      if (item.kind === 'local') void this.switchTo(item.repo.path);
      else this.chooseHostRepo(item.repo);
    }
  }

  isActiveLocal(path: string): boolean {
    if (this.tab() !== 'local') return false;
    const items = this.flatItems();
    const item = items[this.activeIndex()];
    return item?.kind === 'local' && item.repo.path === path;
  }

  isActiveHost(id: string): boolean {
    if (this.tab() !== 'remote') return false;
    const items = this.flatItems();
    const item = items[this.activeIndex()];
    return item?.kind === 'host' && item.repo.id === id;
  }

  setActiveLocal(path: string): void {
    const idx = this.flatItems().findIndex((i) => i.kind === 'local' && i.repo.path === path);
    if (idx >= 0) this.activeIndex.set(idx);
  }

  setActiveHost(id: string): void {
    const idx = this.flatItems().findIndex((i) => i.kind === 'host' && i.repo.id === id);
    if (idx >= 0) this.activeIndex.set(idx);
  }

  async switchTo(path: string): Promise<void> {
    this.close();
    await this.store.openRepo(path);
  }

  disconnect(): void {
    this.close();
    this.store.closeRepo();
  }

  goBrowse(): void {
    this.close();
    if (this.store.currentRepo()) {
      this.store.setView('browse');
    }
  }

  goConnections(): void {
    this.close();
    this.store.openSettings('connections');
  }

  private isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  async openFolder(): Promise<void> {
    this.close();
    if (this.isTauri()) {
      try {
        const selected = await openDialog({ directory: true, multiple: false });
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

  startClone(): void {
    this.close();
    this.store.openCloneDialog();
  }

  chooseHostRepo(repo: HostRepository): void {
    this.close();
    this.store.openCloneDialog(repo.cloneUrl);
  }

  async signIn(provider: 'github' | 'gitlab'): Promise<void> {
    const label = provider === 'github' ? 'GitHub' : 'GitLab';
    const token = await this.prompts.ask({
      title: `Sign in to ${label}`,
      message:
        provider === 'github'
          ? 'Paste a GitHub personal access token with repo scope. Stored only on this machine.'
          : 'Paste a GitLab personal access token with read_api / read_repository. Stored only on this machine.',
      label: 'Personal access token',
      placeholder: provider === 'github' ? 'ghp_…' : 'glpat-…',
      confirmLabel: 'Sign in',
      mono: true,
    });
    if (!token?.trim()) return;
    const ok = await this.store.signInGitHost(provider, token.trim());
    if (ok) {
      this.tab.set('remote');
      this.menuOpen.set(true);
      queueMicrotask(() => this.searchInput()?.nativeElement.focus());
    }
  }

  async initRepo(): Promise<void> {
    this.close();
    let path: string | null = null;
    if (this.isTauri()) {
      try {
        const selected = await openDialog({ directory: true, multiple: false });
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

  async remove(path: string, event: Event): Promise<void> {
    event.stopPropagation();
    await this.store.removeRepo(path);
  }

  async togglePin(repo: RecentRepo, event: Event): Promise<void> {
    event.stopPropagation();
    await this.store.pinRepo(repo.path, !repo.pinned);
  }
}

function parentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized;
  return normalized.slice(0, idx) || '/';
}

function shortenHome(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const homeMatch = normalized.match(/^(\/Users\/[^/]+|\/home\/[^/]+)/);
  if (homeMatch) {
    return '~' + normalized.slice(homeMatch[1].length);
  }
  if (normalized.length > 42) {
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length > 3) {
      return '…/' + parts.slice(-3).join('/');
    }
  }
  return normalized;
}
