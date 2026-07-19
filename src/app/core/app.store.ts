import { Injectable, computed, inject, signal, untracked } from '@angular/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppSettings,
  ArtificialCommit,
  BranchInfo,
  CherryPickPreview,
  CommitInfo,
  ConnectionConfig,
  DetectedEditors,
  GitIdentity,
  HistoryFilter,
  HostRepository,
  IgnoreFileOutput,
  IgnoreKind,
  JiraIssue,
  MutationOutput,
  PreferredEditor,
  RecentRepo,
  RebasePreview,
  RebaseStep,
  RemoteInfo,
  RepoStatus,
  RepoSummary,
  ResetMode,
  SafetyAction,
  SafetyAnalysis,
  StashEntry,
  TagInfo,
  TemplateInfo,
  UiSession,
  WorktreeInfo,
} from './models';
import { TauriService } from './tauri.service';
import { DiagnosticsService } from './diagnostics.service';
import { NotificationService } from './notification.service';
import { PromptService } from '../shared/ui/prompt-dialog/prompt.service';
import { SelectService } from '../shared/ui/select-dialog/select.service';
import { DEFAULT_COMMIT_TYPES, normalizeCommitTypes } from './commit-types';
import {
  openPathsInPreferredEditor,
  preferredEditorLabel,
} from '../shared/git/open-in-editor';
import { runConfiguredGitTool } from '../shared/git/git-tools';
import { parseRemoteRef } from '../shared/git/remote-ref';
import {
  checkoutBlockedNeedsUntracked,
  computeCheckoutOverwritePaths,
  isCheckoutBlockedByLocalChanges,
  parseCheckoutBlockedPaths,
} from '../shared/git/checkout-blocked';
import { isMainlineBranch } from '../shared/git/mainline-branch';
import {
  resolveWorkflowPattern,
  sanitizeBranchName,
  slugifyUser,
} from './workflow-placeholders';

export type BrowseTab = 'commit' | 'diff' | 'files' | 'blame' | 'history' | 'reflog' | 'console';
export type AppView =
  | 'dashboard'
  | 'browse'
  | 'onboarding'
  | 'settings'
  | 'prs'
  | 'jira'
  | 'profiles'
  | 'automation'
  | 'templates';
export type SettingsSection =
  | 'repos'
  | 'appearance'
  | 'git'
  | 'notifications'
  | 'connections'
  | 'ssh'
  | 'tools'
  | 'about';
export type AutomationFilter = 'all' | 'custom' | 'builtin';
export type ToastKind = 'success' | 'info' | 'warning' | 'error';
export type NotificationCategory =
  | 'general'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'commit'
  | 'conflicts'
  | 'behind'
  | 'updates'
  | 'prActivity'
  | 'prCi';
export interface ToastState {
  id: number;
  message: string;
  kind: ToastKind;
  undo?: () => void;
  actionLabel?: string;
}
export interface ToastOptions {
  undo?: () => void;
  actionLabel?: string;
  kind?: ToastKind;
  durationMs?: number;
  category?: NotificationCategory;
  desktop?: boolean;
  force?: boolean;
}

@Injectable({ providedIn: 'root' })
export class AppStore {
  private readonly tauri = inject(TauriService);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly notifications = inject(NotificationService);
  private readonly prompts = inject(PromptService);
  private readonly selects = inject(SelectService);

  readonly isDummyBackend = this.tauri.isDummyBackend;
  readonly view = signal<AppView>('settings');
  readonly settingsSection = signal<SettingsSection>('repos');
  readonly settingsFocusConnectionId = signal<string | null>(null);
  readonly repos = signal<RecentRepo[]>([]);
  readonly openRepos = signal<RepoSummary[]>([]);
  readonly currentRepo = signal<RepoSummary | null>(null);
  readonly status = signal<RepoStatus | null>(null);
  readonly commits = signal<CommitInfo[]>([]);
  readonly artificial = signal<ArtificialCommit[]>([]);
  readonly branches = signal<BranchInfo[]>([]);
  readonly stashes = signal<StashEntry[]>([]);
  readonly tags = signal<TagInfo[]>([]);
  readonly remotes = signal<RemoteInfo[]>([]);
  readonly worktrees = signal<WorktreeInfo[]>([]);
  readonly selectedSha = signal<string | null>(null);
  readonly selectedShas = signal<string[]>([]);
  readonly compareSha = signal<string | null>(null);
  readonly diffSource = signal<'commit' | 'workingDirectory' | 'staged'>('commit');
  readonly browseTab = signal<BrowseTab>('diff');
  readonly historyFilter = signal<HistoryFilter>({
    query: '',
    author: '',
    currentBranchOnly: false,
    mineOnly: false,
  });
  readonly identity = signal<GitIdentity | null>(null);
  readonly myBranchesOnly = signal(false);
  readonly settings = signal<AppSettings>({
    theme: (() => {
      try {
        return localStorage.getItem('branchline.theme') || 'system';
      } catch {
        return 'system';
      }
    })(),
    accent: (() => {
      try {
        return localStorage.getItem('branchline.accent') || '#0EA5E9';
      } catch {
        return '#0EA5E9';
      }
    })(),
    simpleMode: true,
    layout: {},
    focusMode: true,
    defaultPullAction: 'merge',
    defaultPushAction: 'upstream',
    autoFetchOnOpen: false,
    confirmForcePush: true,
    confirmDiscard: true,
    confirmPushNewBranch: true,
    confirmAddTrackingRef: true,
    confirmAmend: true,
    confirmUndoLastCommit: true,
    confirmStashDrop: true,
    confirmAbortOperation: true,
    confirmAbortSecond: true,
    confirmRemoveRemote: true,
    signOffByDefault: false,
    pushAfterCommit: false,
    myBranchesOnly: false,
    branchPrefixEnabled: true,
    branchPrefix: 'feature',
    branchPrefixes: DEFAULT_BRANCH_PREFIXES.slice(),
    preferredEditor: 'auto',
    editorCommand: '',
    diffTool: '',
    mergeTool: '',
    sshClient: 'openssh',
    connections: defaultConnections(),
    commitTypes: DEFAULT_COMMIT_TYPES.map((t) => ({ ...t })),
    githubOAuthClientId: '',
    notificationsEnabled: true,
    notifyToasts: true,
    notifyDesktop: true,
    notifyGitFetch: false,
    notifyGitPull: true,
    notifyGitPush: true,
    notifyGitCommit: true,
    notifyGitConflicts: true,
    notifyRemoteBehind: true,
    notifyAppUpdates: true,
    notifyPrActivity: true,
    notifyPrCi: true,
  });
  readonly detectedEditors = signal<DetectedEditors | null>(null);
  readonly loading = signal(false);
  readonly nextAction = signal('Open a repository');
  readonly safety = signal<SafetyAnalysis | null>(null);
  readonly toast = signal<ToastState | null>(null);
  private toastTimer: number | null = null;
  private toastSeq = 0;
  readonly refreshingRepo = signal(false);
  readonly paletteOpen = signal(false);
  readonly cherryPreviewOpen = signal(false);
  readonly cherryPreview = signal<CherryPickPreview | null>(null);
  readonly interactiveRebaseOpen = signal(false);
  readonly interactiveRebase = signal<RebasePreview | null>(null);
  readonly interactiveRebaseSteps = signal<RebaseStep[]>([]);
  readonly ignoreEditorOpen = signal(false);
  readonly ignoreEditor = signal<IgnoreFileOutput | null>(null);
  readonly commitModalOpen = signal(false);
  readonly pendingCommitTemplate = signal<TemplateInfo | null>(null);
  readonly paletteSeedQuery = signal<string | null>(null);
  readonly changelogModalOpen = signal(false);
  readonly cloneDialogOpen = signal(false);
  readonly cloneDialogUrl = signal('');
  readonly hostRepos = signal<HostRepository[]>([]);
  readonly hostReposLoading = signal(false);
  readonly hostReposError = signal<string | null>(null);
  private hostReposFetchedAt = 0;
  private static readonly HOST_REPOS_TTL_MS = 5 * 60 * 1000;
  readonly createBranchDialogOpen = signal(false);
  readonly publishGithubDialogOpen = signal(false);
  readonly githubDeviceLoginOpen = signal(false);
  readonly createBranchStartPoint = signal<string | null>(null);
  readonly createBranchSuggestedName = signal('');
  readonly activeJiraKey = signal<string | null>(null);
  readonly jiraIssues = signal<JiraIssue[]>([]);
  readonly jiraIssuesLoading = signal(false);
  readonly jiraIssuesError = signal<string | null>(null);
  readonly selectedDiffPath = signal<string | null>(null);
  readonly fileHistoryPath = signal<string | null>(null);
  readonly automationFilter = signal<AutomationFilter>('all');
  readonly splitMain = signal<number[]>([16, 84]);
  readonly splitNested = signal<number[]>([62, 38]);
  private sessionSaveTimer: number | null = null;
  private restoringSession = false;
  private repoFsUnlisten: UnlistenFn | null = null;
  private repoFsRefreshTimer: number | null = null;
  private mutationDepth = 0;
  private refreshQueued = false;
  private refreshInFlight: Promise<void> | null = null;

  readonly selectedCommit = computed(() => {
    const sha = this.selectedSha();
    return this.commits().find((c) => c.sha === sha || c.shortSha === sha) ?? null;
  });

  readonly changeCount = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return s.staged.length + s.unstaged.length + s.untracked.length;
  });

  readonly localBranches = computed(() => this.branches().filter((b) => !b.isRemote));
  readonly remoteBranches = computed(() => this.branches().filter((b) => b.isRemote));

  readonly filteredLocalBranches = computed(() => {
    const list = this.localBranches();
    if (!this.myBranchesOnly()) return list;
    return list.filter((b) => this.isMyBranch(b));
  });
  readonly filteredRemoteBranches = computed(() => {
    const list = this.remoteBranches();
    if (!this.myBranchesOnly()) return list;
    return list.filter((b) => this.isMyBranch(b));
  });

  private readonly commitBySha = computed(() => {
    const map = new Map<string, CommitInfo>();
    for (const c of this.commits()) {
      map.set(c.sha, c);
      map.set(c.shortSha, c);
    }
    return map;
  });

  readonly currentBranchLocked = computed(() => {
    const branch = this.status()?.branch;
    if (!branch) return false;
    return this.localBranches().some((b) => b.name === branch && b.locked);
  });

  readonly currentBranchLockReason = computed(() => {
    const branch = this.status()?.branch;
    if (!branch) return null;
    return this.localBranches().find((b) => b.name === branch)?.lockReason ?? null;
  });

  readonly filteredCommits = computed(() => {
    const filter = this.historyFilter();
    const identity = this.identity();
    let list = this.commits();
    if (filter.currentBranchOnly) {
      list = list.filter((c) => c.isRelativeToHead);
    }
    const q = filter.query.trim().toLowerCase();
    const author = filter.author.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          c.message.toLowerCase().includes(q) ||
          c.sha.toLowerCase().includes(q) ||
          c.shortSha.toLowerCase().includes(q) ||
          c.refs.some((r) => r.toLowerCase().includes(q)),
      );
    }
    if (filter.mineOnly) {
      if (!identity?.email && !identity?.name) return [];
      list = list.filter((c) => this.isMine(c.author, c.email));
    } else if (author) {
      list = list.filter(
        (c) =>
          c.author.toLowerCase().includes(author) || c.email.toLowerCase().includes(author),
      );
    }
    return list;
  });

  isMine(author: string, email: string): boolean {
    const id = this.identity();
    if (!id) return false;
    const idEmail = normalizeEmail(id.email);
    const lineEmail = normalizeEmail(email);
    if (idEmail && lineEmail && idEmail === lineEmail) return true;
    const idName = id.name.trim().toLowerCase();
    const lineName = author.trim().toLowerCase();
    return !!idName && !!lineName && idName === lineName;
  }

  isMyBranch(branch: BranchInfo): boolean {
    if (branch.tipAuthor || branch.tipEmail) {
      return this.isMine(branch.tipAuthor ?? '', branch.tipEmail ?? '');
    }
    const tip = branch.tipSha;
    if (!tip) return false;
    const map = this.commitBySha();
    const commit = map.get(tip) ?? map.get(tip.slice(0, 7));
    return commit ? this.isMine(commit.author, commit.email) : false;
  }

  setView(view: AppView): void {
    if (view === 'dashboard') {
      this.openSettings('repos');
      return;
    }
    this.view.set(view);
    if (view !== 'onboarding' && !this.restoringSession) {
      this.patchSession({ view });
    }
  }

  openSettings(section: SettingsSection = 'repos', connectionId?: string): void {
    this.settingsSection.set(section);
    this.settingsFocusConnectionId.set(connectionId ?? null);
    this.view.set('settings');
    if (!this.restoringSession) {
      this.patchSession({ view: 'settings' });
    }
  }

  goHome(): void {
    this.openSettings('repos');
  }

  setSettingsSection(section: SettingsSection): void {
    this.settingsSection.set(section);
  }

  clearSettingsFocusConnection(): void {
    this.settingsFocusConnectionId.set(null);
  }

  isConnectionLinked(conn: ConnectionConfig): boolean {
    return conn.enabled && !!(conn.hasToken || conn.token.trim());
  }

  async disconnectConnection(idOrProvider: string): Promise<void> {
    const target = this.settings().connections.find(
      (c) => c.id === idOrProvider || c.provider === idOrProvider,
    );
    const connections = this.settings().connections.map((c) => {
      if (c.id !== idOrProvider && c.provider !== idOrProvider) return c;
      return { ...c, enabled: false, token: '', hasToken: false };
    });
    try {
      await this.saveSettings({ connections });
      if (target?.provider === 'jira') {
        this.jiraIssues.set([]);
        this.activeJiraKey.set(null);
      }
      if (target && ['github', 'gitlab', 'azureDevOps'].includes(target.provider)) {
        this.hostRepos.set([]);
        this.hostReposFetchedAt = 0;
      }
      this.showSuccess('Disconnected');
    } catch (err) {
      this.showError(err);
    }
  }

  setBrowseTab(tab: BrowseTab): void {
    this.browseTab.set(tab);
    if (!this.restoringSession) {
      this.patchSession({ browseTab: tab });
    }
  }

  setAutomationFilter(filter: AutomationFilter): void {
    this.automationFilter.set(filter);
    if (!this.restoringSession) {
      this.patchSession({ automationFilter: filter });
    }
  }

  setSplitSizes(kind: 'main' | 'nested', sizes: number[]): void {
    if (!sizes.length) return;
    if (kind === 'main') this.splitMain.set([...sizes]);
    else this.splitNested.set([...sizes]);
    if (!this.restoringSession) {
      this.patchSession(kind === 'main' ? { splitMain: [...sizes] } : { splitNested: [...sizes] });
    }
  }

  readSession(): UiSession {
    const layout = this.settings().layout ?? {};
    const raw = layout['session'];
    if (!raw || typeof raw !== 'object') return {};
    return raw as UiSession;
  }

  patchSession(partial: Partial<UiSession>, opts?: { flush?: boolean }): void {
    untracked(() => {
      const session = { ...this.readSession(), ...partial };
      const layout = { ...(this.settings().layout ?? {}), session };
      this.settings.update((s) => ({ ...s, layout }));
    });
    if (this.sessionSaveTimer !== null) {
      window.clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    if (opts?.flush) {
      void this.tauri.saveSettings(this.settings()).catch(() => {
        /* ignore background session save failures */
      });
      return;
    }
    this.sessionSaveTimer = window.setTimeout(() => {
      this.sessionSaveTimer = null;
      void this.tauri.saveSettings(this.settings()).catch(() => {
        /* ignore background session save failures */
      });
    }, 400);
  }

  private flushSession(): void {
    if (this.sessionSaveTimer !== null) {
      window.clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
      void this.tauri.saveSettings(this.settings()).catch(() => {
        /* ignore */
      });
    }
  }

  private applySession(session: UiSession): void {
    this.restoringSession = true;
    try {
      if (isBrowseTab(session.browseTab)) {
        this.browseTab.set(session.browseTab);
      }
      if (
        session.automationFilter === 'all' ||
        session.automationFilter === 'custom' ||
        session.automationFilter === 'builtin'
      ) {
        this.automationFilter.set(session.automationFilter);
      }
      this.historyFilter.update((f) => ({
        ...f,
        currentBranchOnly: session.historyCurrentBranchOnly ?? f.currentBranchOnly,
        mineOnly: session.historyMineOnly ?? f.mineOnly,
      }));
      if (Array.isArray(session.splitMain) && session.splitMain.length >= 2) {
        this.splitMain.set(session.splitMain.map(Number));
      }
      if (Array.isArray(session.splitNested) && session.splitNested.length >= 2) {
        this.splitNested.set(session.splitNested.map(Number));
      }
    } finally {
      this.restoringSession = false;
    }
  }

  private restoreView(session: UiSession, hasRepo: boolean): void {
    const view = session.view;
    if (view === 'dashboard') {
      if (hasRepo) this.view.set('browse');
      else {
        this.settingsSection.set('repos');
        this.view.set('settings');
      }
      return;
    }
    if (!isAppView(view) || view === 'onboarding') {
      if (hasRepo) this.view.set('browse');
      else {
        this.settingsSection.set('repos');
        this.view.set('settings');
      }
      return;
    }
    if (view === 'browse' && !hasRepo) {
      this.settingsSection.set('repos');
      this.view.set('settings');
      return;
    }
    if (
      (view === 'automation' || view === 'templates') &&
      this.settings().simpleMode
    ) {
      if (hasRepo) this.view.set('browse');
      else {
        this.settingsSection.set('repos');
        this.view.set('settings');
      }
      return;
    }
    this.view.set(view);
  }

  async init(): Promise<void> {
    try {
      const settings = await this.tauri.getSettings();
      this.settings.set(normalizeSettings(settings));
      this.myBranchesOnly.set(this.settings().myBranchesOnly);
      this.applyTheme(this.settings());
      void this.refreshDetectedEditors();
      const session = this.readSession();
      this.applySession(session);
      if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => this.flushSession());
        window.addEventListener('pagehide', () => this.flushSession());
      }
      void this.bindRepoFsWatcher();
      try {
        this.identity.set(await this.tauri.getGitIdentity(this.currentRepo()?.path ?? null));
      } catch {
        this.identity.set(null);
      }
      const onboarding = await this.tauri.getOnboardingStatus();
      if (!onboarding.completed && !onboarding.skipped) {
        this.view.set('onboarding');
        return;
      }
      this.repos.set(await this.tauri.listRecentRepos());
      const sessionPaths = Array.isArray(session.openRepoPaths)
        ? session.openRepoPaths.filter((p): p is string => typeof p === 'string' && !!p.trim())
        : [];
      const pathsToOpen =
        sessionPaths.length > 0
          ? sessionPaths
          : (() => {
              const last = this.repos().find((r) => r.isLast) ?? this.repos()[0];
              return last ? [last.path] : [];
            })();
      let hasRepo = false;
      const activePath =
        (typeof session.activeRepoPath === 'string' && session.activeRepoPath.trim()) ||
        pathsToOpen[pathsToOpen.length - 1] ||
        null;
      this.restoringSession = true;
      try {
        for (const path of pathsToOpen) {
          await this.openRepo(path, {
            restoreView: false,
            activate:
              path === activePath || (!activePath && path === pathsToOpen[pathsToOpen.length - 1]),
          });
        }
        hasRepo = !!this.currentRepo() || this.openRepos().length > 0;
        if (!this.currentRepo() && this.openRepos().length) {
          await this.openRepo(this.openRepos()[this.openRepos().length - 1].path, {
            restoreView: false,
          });
          hasRepo = !!this.currentRepo();
        }
      } finally {
        this.restoringSession = false;
      }
      this.persistOpenRepos();
      this.restoreView(session, hasRepo);
    } catch (err) {
      this.showError(err);
      this.goHome();
    }
  }

  hasLinkedPrHost(): boolean {
    return this.settings().connections.some(
      (c) =>
        c.enabled &&
        (c.hasToken || c.token.trim()) &&
        (c.provider === 'github' || c.provider === 'gitlab' || c.provider === 'azureDevOps'),
    );
  }

  hasLinkedJira(): boolean {
    return this.settings().connections.some(
      (c) => c.provider === 'jira' && c.enabled && (c.hasToken || c.token.trim()),
    );
  }

  isDummyRepoPath(path: string | null | undefined): boolean {
    if (!path) return false;
    return path.includes('/Users/demo/') || path.startsWith('/demo/');
  }

  applyTheme(settings: AppSettings): void {
    const root = document.documentElement;
    const preference =
      settings.theme === 'dark' || settings.theme === 'light' || settings.theme === 'system'
        ? settings.theme
        : 'system';
    const theme =
      preference === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : preference;
    root.setAttribute('data-theme', theme);
    root.style.setProperty('--accent', settings.accent);
    try {
      localStorage.setItem('branchline.theme', preference);
      localStorage.setItem('branchline.accent', settings.accent);
    } catch {
      /* ignore quota / private mode */
    }
  }

  formatError(err: unknown): string {
    if (typeof err === 'string') return err;
    if (err && typeof err === 'object' && 'message' in err) {
      return String((err as { message: unknown }).message);
    }
    return 'Something went wrong';
  }

  async openRepo(
    path: string,
    opts?: { restoreView?: boolean; activate?: boolean },
  ): Promise<void> {
    const restoreView = opts?.restoreView !== false;
    const activate = opts?.activate !== false;
    const normalized = path.trim();
    if (!normalized) return;

    if (!activate) {
      try {
        const summary = await this.tauri.openRepository(normalized);
        this.upsertOpenRepo(summary);
        this.persistOpenRepos();
      } catch (err) {
        this.showError(err);
      }
      return;
    }

    if (this.currentRepo()?.path === normalized) {
      if (restoreView) this.setView('browse');
      else this.view.set('browse');
      return;
    }

    this.loading.set(true);
    try {
      this.clearWorkingState();
      const summary = await this.tauri.openRepository(normalized);
      this.currentRepo.set(summary);
      this.upsertOpenRepo(summary);
      this.repos.set(await this.tauri.listRecentRepos());
      await this.refreshRepo();
      this.persistOpenRepos();
      if (restoreView) {
        this.setView('browse');
      } else {
        this.view.set('browse');
      }
      if (this.isDummyBackend || this.isDummyRepoPath(normalized)) {
        this.showWarning(
          'DUMMY DATA — browser preview. Open a real repo in the desktop app for live Git.',
        );
      }
      if (this.settings().autoFetchOnOpen && !this.isDummyBackend) {
        void this.tauri.fetch(normalized).then(
          () => this.refreshRepo(),
          (err) => this.showError(err),
        );
      }
    } catch (err) {
      this.showError(err);
      if (!this.openRepos().length) this.goHome();
    } finally {
      this.loading.set(false);
    }
  }

  async switchOpenRepo(path: string): Promise<void> {
    await this.openRepo(path);
  }

  async closeOpenRepo(path: string, showToast = true): Promise<void> {
    const tabs = this.openRepos().filter((r) => r.path !== path);
    const closingCurrent = this.currentRepo()?.path === path;
    const name = this.openRepos().find((r) => r.path === path)?.name;
    this.openRepos.set(tabs);
    this.persistOpenRepos();

    if (!closingCurrent) {
      if (showToast && name) this.showToast(`Closed ${name}`);
      return;
    }

    if (tabs.length) {
      await this.openRepo(tabs[tabs.length - 1].path);
      if (showToast && name) this.showToast(`Closed ${name}`);
      return;
    }

    this.clearWorkingState();
    this.currentRepo.set(null);
    this.goHome();
    this.nextAction.set('Open a repository');
    if (showToast && name) this.showToast(`Closed ${name}`);
  }

  closeRepo(showToast = true): void {
    const path = this.currentRepo()?.path;
    if (path) {
      void this.closeOpenRepo(path, showToast);
      return;
    }
    this.clearWorkingState();
    this.currentRepo.set(null);
    this.openRepos.set([]);
    this.persistOpenRepos();
    this.goHome();
    this.nextAction.set('Open a repository');
  }

  private upsertOpenRepo(summary: RepoSummary): void {
    this.openRepos.update((tabs) => {
      const idx = tabs.findIndex((t) => t.path === summary.path);
      if (idx < 0) return [...tabs, summary];
      const next = tabs.slice();
      next[idx] = summary;
      return next;
    });
  }

  private persistOpenRepos(): void {
    if (this.restoringSession) return;
    this.patchSession(
      {
        openRepoPaths: this.openRepos().map((r) => r.path),
        activeRepoPath: this.currentRepo()?.path ?? null,
      },
      { flush: true },
    );
  }

  private clearWorkingState(): void {
    this.status.set(null);
    this.commits.set([]);
    this.artificial.set([]);
    this.branches.set([]);
    this.stashes.set([]);
    this.tags.set([]);
    this.remotes.set([]);
    this.worktrees.set([]);
    this.selectedSha.set(null);
    this.selectedShas.set([]);
    this.compareSha.set(null);
    this.diffSource.set('commit');
    this.selectedDiffPath.set(null);
    this.fileHistoryPath.set(null);
    this.cherryPreviewOpen.set(false);
    this.cherryPreview.set(null);
    this.interactiveRebaseOpen.set(false);
    this.interactiveRebase.set(null);
    this.interactiveRebaseSteps.set([]);
    this.ignoreEditorOpen.set(false);
    this.ignoreEditor.set(null);
    this.commitModalOpen.set(false);
    this.commitWaiter?.(false);
    this.commitWaiter = null;
    this.identity.set(null);
    if (this.createBranchDialogOpen()) {
      this.closeCreateBranchDialog(false);
    }
  }

  private clearRepoState(): void {
    this.currentRepo.set(null);
    this.clearWorkingState();
  }

  openCloneDialog(url?: string): void {
    this.cloneDialogUrl.set(url?.trim() ?? '');
    this.cloneDialogOpen.set(true);
  }

  closeCloneDialog(): void {
    this.cloneDialogOpen.set(false);
    this.cloneDialogUrl.set('');
  }

  linkedGitHosts(): ConnectionConfig[] {
    return this.settings().connections.filter(
      (c) =>
        c.enabled &&
        (c.hasToken || c.token.trim()) &&
        (c.provider === 'github' || c.provider === 'gitlab' || c.provider === 'azureDevOps'),
    );
  }

  async refreshHostRepositories(
    connectionId?: string,
    opts?: { force?: boolean; notify?: boolean },
  ): Promise<void> {
    if (!this.hasLinkedPrHost()) {
      this.hostRepos.set([]);
      this.hostReposError.set(null);
      this.hostReposFetchedAt = 0;
      if (opts?.notify) {
        this.showWarning('Sign in to GitHub or GitLab to load remote repositories');
      }
      return;
    }
    const fresh =
      !opts?.force &&
      this.hostRepos().length > 0 &&
      Date.now() - this.hostReposFetchedAt < AppStore.HOST_REPOS_TTL_MS;
    if (fresh) {
      if (opts?.notify) {
        const n = this.hostRepos().length;
        this.showToast(n === 1 ? '1 remote repository ready' : `${n} remote repositories ready`, {
          kind: 'success',
          durationMs: 2200,
        });
      }
      return;
    }

    this.hostReposLoading.set(true);
    this.hostReposError.set(null);
    try {
      const repos = await this.tauri.listHostRepositories(connectionId);
      this.hostRepos.set(repos);
      this.hostReposFetchedAt = Date.now();
      if (opts?.notify) {
        this.showToast(
          repos.length === 1
            ? 'Loaded 1 remote repository'
            : `Loaded ${repos.length} remote repositories`,
          { kind: 'success', durationMs: 2800 },
        );
      }
    } catch (err) {
      this.hostRepos.set([]);
      this.hostReposError.set(this.formatError(err));
      this.hostReposFetchedAt = 0;
      if (opts?.notify) this.showError(err);
    } finally {
      this.hostReposLoading.set(false);
    }
  }

  async signInGitHost(provider: 'github' | 'gitlab', token: string, username = ''): Promise<boolean> {
    const cleaned = token.trim();
    if (!cleaned) {
      this.showWarning('Paste a personal access token to sign in.');
      return false;
    }
    const connections = this.settings().connections.map((c) => {
      if (c.provider !== provider) return c;
      return {
        ...c,
        enabled: true,
        token: cleaned,
        username: username.trim() || c.username,
        hasToken: true,
      };
    });
    try {
      await this.saveSettings({ connections });
      await this.refreshHostRepositories(provider, { force: true });
      this.showSuccess(`Signed in to ${provider === 'github' ? 'GitHub' : 'GitLab'}`);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  private createBranchWaiter: ((completed: boolean) => void) | null = null;
  private commitWaiter: ((completed: boolean) => void) | null = null;

  openCreateBranchDialog(
    startPoint?: string | null,
    suggestedName?: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.createBranchWaiter?.(false);
      this.createBranchWaiter = resolve;
      this.createBranchStartPoint.set(startPoint ?? null);
      this.createBranchSuggestedName.set(suggestedName?.trim() ?? '');
      this.createBranchDialogOpen.set(true);
    });
  }

  closeCreateBranchDialog(completed = false): void {
    this.createBranchDialogOpen.set(false);
    this.createBranchStartPoint.set(null);
    this.createBranchSuggestedName.set('');
    const waiter = this.createBranchWaiter;
    this.createBranchWaiter = null;
    waiter?.(completed);
  }

  openPublishGithubDialog(): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first.');
      return;
    }
    this.publishGithubDialogOpen.set(true);
  }

  closePublishGithubDialog(): void {
    this.publishGithubDialogOpen.set(false);
  }

  openGithubDeviceLogin(): void {
    this.githubDeviceLoginOpen.set(true);
  }

  closeGithubDeviceLogin(): void {
    this.githubDeviceLoginOpen.set(false);
  }

  hasLinkedGithub(): boolean {
    return this.settings().connections.some(
      (c) => c.provider === 'github' && c.enabled && !!(c.hasToken || c.token.trim()),
    );
  }

  async publishToGithub(opts: {
    name: string;
    description?: string;
    private?: boolean;
    createReleaseTag?: boolean;
    tagName?: string;
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first.');
      return false;
    }
    try {
      const result = await this.tauri.publishToGithub({
        path,
        name: opts.name,
        description: opts.description,
        private: opts.private,
        createReleaseTag: opts.createReleaseTag,
        tagName: opts.tagName,
      });
      await this.refreshRepo();
      this.showSuccess(result.message);
      const openUrl = result.releaseUrl || result.htmlUrl;
      if (openUrl) {
        try {
          await this.tauri.openExternalUrl(openUrl);
        } catch {
          this.showWarning(
            `Published, but could not open the browser. Open it manually: ${openUrl}`,
          );
        }
      }
      this.closePublishGithubDialog();
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  setActiveJiraKey(key: string | null): void {
    this.activeJiraKey.set(key?.trim() || null);
  }

  async refreshJiraIssues(jql?: string): Promise<void> {
    this.jiraIssuesLoading.set(true);
    this.jiraIssuesError.set(null);
    try {
      if (this.hasLinkedJira()) {
        const issues = await this.tauri.listJiraIssues(jql);
        this.jiraIssues.set(issues);
      } else {
        this.jiraIssues.set(await this.tauri.listMockJiraIssues());
      }
    } catch (err) {
      this.jiraIssues.set([]);
      this.jiraIssuesError.set(this.formatError(err));
    } finally {
      this.jiraIssuesLoading.set(false);
    }
  }

  async signInJira(email: string, token: string, baseUrl?: string): Promise<boolean> {
    const cleanedEmail = email.trim();
    const cleanedToken = token.trim();
    if (!cleanedEmail || !cleanedToken) {
      this.showWarning('Email and API token are required to link Jira.');
      return false;
    }
    const connections = this.settings().connections.map((c) => {
      if (c.provider !== 'jira') return c;
      return {
        ...c,
        enabled: true,
        username: cleanedEmail,
        token: cleanedToken,
        hasToken: true,
        baseUrl: (baseUrl?.trim() || c.baseUrl || 'https://your-domain.atlassian.net').replace(
          /\/$/,
          '',
        ),
      };
    });
    try {
      await this.saveSettings({ connections });
      await this.refreshJiraIssues();
      this.showSuccess('Signed in to Jira');
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  branchNameFromIssue(issue: JiraIssue): string {
    const settings = this.settings();
    const slug = issue.summary
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    const leaf = slug ? `${issue.key}-${slug}` : issue.key;
    if (!settings.branchPrefixEnabled) return leaf;
    const prefix = (settings.branchPrefix || 'feature').trim().replace(/^\/+|\/+$/g, '');
    return prefix ? `${prefix}/${leaf}` : leaf;
  }

  startWorkFromIssue(issue: JiraIssue): void {
    this.setActiveJiraKey(issue.key);
    this.openCreateBranchDialog(null, this.branchNameFromIssue(issue));
  }

  async transitionJiraIssue(issueKey: string, transitionId: string): Promise<boolean> {
    try {
      if (this.hasLinkedJira()) {
        await this.tauri.transitionJiraIssue(issueKey, transitionId);
      }
      await this.refreshJiraIssues();
      this.showSuccess(`Transitioned ${issueKey}`);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async refreshWorkingTree(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const prev = this.status();
      const [status, artificial] = await Promise.all([
        this.tauri.getRepoStatus(path),
        this.tauri.getArtificialCommits(path),
      ]);
      this.status.set(status);
      this.artificial.set(artificial);
      this.updateNextAction(status);
      this.maybeNotifyStatusChanges(prev, status);
    } catch (err) {
      this.showError(err);
    }
  }

  async refreshRepo(opts?: { notify?: boolean }): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      if (opts?.notify) this.showWarning('Open a repository first');
      return;
    }
    if (this.mutationDepth > 0) {
      this.refreshQueued = true;
      return;
    }
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      await this.refreshInFlight;
      return;
    }

    if (opts?.notify) this.refreshingRepo.set(true);
    this.refreshInFlight = this.runRefreshRepo(path, opts)
      .catch((err) => this.showError(err))
      .finally(() => {
        this.refreshInFlight = null;
        if (opts?.notify) this.refreshingRepo.set(false);
        if (this.refreshQueued && this.mutationDepth === 0) {
          this.refreshQueued = false;
          void this.refreshRepo();
        }
      });
    await this.refreshInFlight;
  }

  private async runRefreshRepo(path: string, opts?: { notify?: boolean }): Promise<void> {
    const prev = this.status();
    const [status, commits, artificial, branches, stashes, tags, remotes, worktrees] =
      await Promise.all([
        this.tauri.getRepoStatus(path),
        this.tauri.getCommitLog(path, 300),
        this.tauri.getArtificialCommits(path),
        this.tauri.listBranches(path),
        this.tauri.listStashes(path),
        this.tauri.listTags(path),
        this.tauri.listRemotes(path),
        this.tauri.listWorktrees(path),
      ]);
    this.status.set(status);
    this.commits.set(commits);
    this.artificial.set(artificial);
    this.branches.set(branches);
    this.stashes.set(stashes);
    this.tags.set(tags);
    this.remotes.set(remotes);
    this.worktrees.set(worktrees);
    void this.refreshIdentity();
    if (!this.selectedSha() && commits[0]) {
      this.selectedSha.set(commits[0].sha);
      this.selectedShas.set([commits[0].sha]);
    }
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    if (opts?.notify) {
      const changed =
        status.staged.length + status.unstaged.length + status.untracked.length;
      const branch = status.branch || 'HEAD';
      this.showToast(
        changed
          ? `Refreshed ${branch} · ${changed} change${changed === 1 ? '' : 's'}`
          : `Refreshed ${branch} · clean`,
        { kind: 'success', durationMs: 2500, category: 'general' },
      );
    }
  }

  private async withRepoMutation<T>(fn: () => Promise<T>): Promise<T> {
    this.mutationDepth++;
    try {
      return await fn();
    } finally {
      this.mutationDepth--;
      if (this.mutationDepth === 0 && this.refreshQueued) {
        this.refreshQueued = false;
        void this.refreshRepo();
      }
    }
  }

  private async bindRepoFsWatcher(): Promise<void> {
    if (this.isDummyBackend) return;
    if (this.repoFsUnlisten) {
      this.repoFsUnlisten();
      this.repoFsUnlisten = null;
    }
    try {
      this.repoFsUnlisten = await listen<{ path: string }>('repo-fs-changed', (event) => {
        const current = this.currentRepo()?.path;
        if (!current) return;
        if (!sameRepoPath(current, event.payload.path)) return;
        if (this.mutationDepth > 0) {
          this.refreshQueued = true;
          return;
        }
        if (this.repoFsRefreshTimer !== null) {
          window.clearTimeout(this.repoFsRefreshTimer);
        }
        this.repoFsRefreshTimer = window.setTimeout(() => {
          this.repoFsRefreshTimer = null;
          if (this.mutationDepth > 0) {
            this.refreshQueued = true;
            return;
          }
          void this.refreshRepo();
        }, 750);
      });
    } catch {
      /* watch unavailable outside desktop shell */
    }
  }

  updateNextAction(status: RepoStatus): void {
    if (status.conflicted.length) {
      this.nextAction.set(`Resolve ${status.conflicted.length} conflicts`);
      return;
    }
    const uncommitted = status.unstaged.length + status.untracked.length + status.staged.length;
    if (status.staged.length) {
      this.nextAction.set(
        `Commit ${status.staged.length} staged file${status.staged.length === 1 ? '' : 's'}`,
      );
      return;
    }
    if (uncommitted) {
      this.nextAction.set(`Review ${uncommitted} local change${uncommitted === 1 ? '' : 's'}`);
      return;
    }
    if (status.ahead > 0) {
      this.nextAction.set(`Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'}`);
      return;
    }
    if (status.behind > 0) {
      this.nextAction.set(`Update from team (${status.behind} behind)`);
      return;
    }
    this.nextAction.set('Working tree clean');
  }

  selectCommit(sha: string, multi = false): void {
    this.diffSource.set('commit');
    if (multi) {
      const cur = this.selectedShas();
      if (cur.includes(sha)) {
        this.selectedShas.set(cur.filter((s) => s !== sha));
      } else {
        this.selectedShas.set([...cur, sha]);
      }
      this.selectedSha.set(sha);
      return;
    }
    this.selectedSha.set(sha);
    this.selectedShas.set([sha]);
    this.compareSha.set(null);
  }

  selectWorkingDirectory(kind: 'workingDirectory' | 'staged' = 'workingDirectory'): void {
    this.diffSource.set(kind);
    this.selectedSha.set(null);
    this.selectedShas.set([]);
    this.compareSha.set(null);
    this.setBrowseTab('diff');
  }

  toggleCompare(sha: string): void {
    if (this.compareSha() === sha) {
      this.compareSha.set(null);
    } else {
      this.compareSha.set(sha);
    }
  }

  showToast(message: string, undoOrOptions?: (() => void) | ToastOptions): void {
    const options =
      typeof undoOrOptions === 'function'
        ? { undo: undoOrOptions, kind: 'success' as ToastKind }
        : (undoOrOptions ?? {});
    const kind = options.kind ?? (options.undo ? 'success' : 'info');
    const category = options.category ?? 'general';
    if (!options.force && !this.shouldShowToast(category, kind)) {
      if (options.desktop) {
        void this.sendDesktopIfEnabled(category, 'Branchline', message);
      }
      return;
    }
    const durationMs = options.durationMs ?? (kind === 'error' ? 12000 : options.undo ? 10000 : 6000);
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    const id = ++this.toastSeq;
    this.toast.set({
      id,
      message,
      kind,
      undo: options.undo,
      actionLabel: options.actionLabel,
    });
    this.toastTimer = window.setTimeout(() => {
      if (this.toast()?.id === id) {
        this.toast.set(null);
      }
      this.toastTimer = null;
    }, durationMs);
    if (options.desktop) {
      void this.sendDesktopIfEnabled(category, 'Branchline', message);
    }
  }

  showSuccess(message: string, undo?: () => void, category: NotificationCategory = 'general'): void {
    this.showToast(message, { kind: 'success', undo, category });
  }

  showWarning(message: string, undo?: () => void, category: NotificationCategory = 'general'): void {
    this.showToast(message, {
      kind: 'warning',
      undo,
      category,
      durationMs: undo ? 10000 : 8000,
      force: true,
    });
  }

  showInfo(message: string, undo?: () => void, category: NotificationCategory = 'general'): void {
    this.showToast(message, { kind: 'info', undo, category, durationMs: undo ? 10000 : 6000 });
  }

  showError(err: unknown): void {
    const message = this.formatError(err);
    this.showToast(message, { kind: 'error', force: true });
    void this.diagnostics.record('ui.error', message);
  }

  notifyEvent(
    category: NotificationCategory,
    title: string,
    body: string,
    options?: { toast?: boolean; desktop?: boolean; kind?: ToastKind },
  ): void {
    const toast = options?.toast !== false;
    const desktop = options?.desktop !== false;
    if (toast) {
      this.showToast(body, {
        kind: options?.kind ?? 'info',
        category,
        desktop: false,
      });
    }
    if (desktop) {
      void this.sendDesktopIfEnabled(category, title, body);
    }
  }

  private shouldShowToast(category: NotificationCategory, kind: ToastKind): boolean {
    if (kind === 'error' || kind === 'warning') return true;
    const s = this.settings();
    if (!s.notifyToasts) return false;
    return this.categoryEnabled(category, s);
  }

  private categoryEnabled(
    category: NotificationCategory,
    s = this.settings(),
  ): boolean {
    switch (category) {
      case 'fetch':
        return s.notifyGitFetch;
      case 'pull':
        return s.notifyGitPull;
      case 'push':
        return s.notifyGitPush;
      case 'commit':
        return s.notifyGitCommit;
      case 'conflicts':
        return s.notifyGitConflicts;
      case 'behind':
        return s.notifyRemoteBehind;
      case 'updates':
        return s.notifyAppUpdates;
      case 'prActivity':
        return s.notifyPrActivity;
      case 'prCi':
        return s.notifyPrCi;
      case 'general':
      default:
        return true;
    }
  }

  private async sendDesktopIfEnabled(
    category: NotificationCategory,
    title: string,
    body: string,
  ): Promise<void> {
    const s = this.settings();
    if (!s.notificationsEnabled || !s.notifyDesktop) return;
    if (!this.categoryEnabled(category, s)) return;
    await this.notifications.sendDesktop(title, body);
  }

  private maybeNotifyStatusChanges(prev: RepoStatus | null, next: RepoStatus): void {
    if (!prev) return;
    const repo = this.currentRepo()?.name || next.branch || 'Repository';

    if (next.conflicted.length > 0 && prev.conflicted.length === 0) {
      const n = next.conflicted.length;
      this.notifyEvent(
        'conflicts',
        'Merge conflicts',
        `${repo}: ${n} conflict${n === 1 ? '' : 's'} to resolve`,
        { kind: 'warning' },
      );
    }

    if (next.behind > prev.behind) {
      const n = next.behind;
      this.notifyEvent(
        'behind',
        'Remote updated',
        `${repo} is ${n} commit${n === 1 ? '' : 's'} behind upstream`,
        { kind: 'info' },
      );
    }
  }

  dismissToast(): void {
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.toast.set(null);
  }

  runUndoFromToast(): void {
    const undo = this.toast()?.undo;
    this.dismissToast();
    undo?.();
  }

  async saveSettings(partial: Partial<AppSettings>): Promise<void> {
    const next = normalizeSettings({
      ...this.settings(),
      ...partial,
      connections: partial.connections ?? this.settings().connections,
    });
    const saved = await this.tauri.saveSettings(next);
    this.settings.set(normalizeSettings(saved));
    this.myBranchesOnly.set(saved.myBranchesOnly);
    this.applyTheme(saved);
  }

  setMyBranchesOnly(value: boolean): void {
    if (value) {
      const id = this.identity();
      if (!id?.name?.trim() && !id?.email?.trim()) {
        void this.refreshIdentity().then(() => {
          const refreshed = this.identity();
          if (!refreshed?.name?.trim() && !refreshed?.email?.trim()) {
            this.showToast('Set user.name / user.email in Git to use Mine', { kind: 'warning' });
            return;
          }
          this.myBranchesOnly.set(true);
          void this.saveSettings({ myBranchesOnly: true });
        });
        return;
      }
    }
    this.myBranchesOnly.set(value);
    void this.saveSettings({ myBranchesOnly: value });
  }

  async toggleTheme(): Promise<void> {
    const preference = this.settings().theme;
    const applied =
      preference === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : preference === 'dark'
          ? 'dark'
          : 'light';
    await this.saveSettings({ theme: applied === 'dark' ? 'light' : 'dark' });
  }

  async toggleSimpleMode(): Promise<void> {
    await this.saveSettings({ simpleMode: !this.settings().simpleMode });
  }

  async toggleFocusMode(): Promise<void> {
    await this.saveSettings({ focusMode: !this.settings().focusMode });
  }

  async stagePaths(paths: string[]): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !paths.length) return;
    try {
      await this.withRepoMutation(() => this.tauri.stagePaths(path, paths));
      await this.refreshWorkingTree();
    } catch (err) {
      this.showError(err);
    }
  }

  async unstagePaths(paths: string[]): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !paths.length) return;
    try {
      await this.withRepoMutation(() => this.tauri.unstagePaths(path, paths));
      await this.refreshWorkingTree();
    } catch (err) {
      this.showError(err);
    }
  }

  async discardPaths(paths: string[]): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !paths.length) return;
    if (paths.length > 3 || this.settings().confirmDiscard) {
      await this.openSafety('discard', paths.join('\n'));
      return;
    }
    try {
      const result = await this.withRepoMutation(() => this.tauri.discardPaths(path, paths));
      await this.refreshWorkingTree();
      this.showToast(result.message, () =>
        void this.tauri.undoLast(path).then(() => this.refreshWorkingTree()),
      );
    } catch (err) {
      this.showError(err);
    }
  }

  async applyPatch(
    patch: string,
    mode: 'stage' | 'unstage' | 'discard' | 'apply' | 'apply-index',
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path || !patch.trim()) return false;
    try {
      const result = await this.tauri.applyPatch(path, patch, mode);
      await this.refreshWorkingTree();
      this.showToast(result.message, () =>
        void this.tauri.undoLast(path).then(() => this.refreshWorkingTree()),
      );
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async cherryPickPathsFromCommit(
    paths: string[],
    target: 'worktree' | 'index' | 'both' = 'both',
    revision?: string,
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    const sha = revision ?? this.selectedSha();
    if (!path || !sha || !paths.length) return false;
    try {
      const result = await this.tauri.checkoutPathsFromRevision(path, sha, paths, target);
      await this.refreshWorkingTree();
      this.showToast(result.message, () =>
        void this.tauri.undoLast(path).then(() => this.refreshWorkingTree()),
      );
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async createCommit(message: string, amend = false, allowEmpty = false): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    if (!message.trim() && !allowEmpty) {
      this.showWarning('Write a commit message first');
      return false;
    }
    const status = this.status();
    if ((status?.conflicted.length ?? 0) > 0) {
      this.showToast('Resolve conflicts before committing', { kind: 'warning' });
      return false;
    }
    if (!amend && !allowEmpty && !status?.staged.length) {
      this.showToast('Stage at least one file before committing', { kind: 'warning' });
      return false;
    }
    if (amend && !(await this.confirmIfEnabled('confirmAmend', {
      title: 'Amend last commit?',
      message:
        'Amending rewrites the tip of this branch. If that commit was already pushed, you will need a force push with lease afterward.',
      confirmLabel: 'Amend',
    }))) {
      return false;
    }
    try {
      const result = await this.tauri.createCommit(path, message.trim(), amend, allowEmpty);
      await this.refreshRepo();
      this.showToast(
        amend ? `Amended ${result.sha.slice(0, 7)}` : `Committed ${result.sha.slice(0, 7)}`,
        {
          kind: 'success',
          category: 'commit',
          undo: () => void this.tauri.undoLast(path).then(() => this.refreshRepo()),
        },
      );
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async softUndoLastCommit(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!(await this.confirmIfEnabled('confirmUndoLastCommit', {
      title: 'Undo last action?',
      message:
        'This undoes the most recent Branchline action from the undo journal (often a soft reset of the last commit).',
      confirmLabel: 'Undo',
    }))) {
      return;
    }
    try {
      const entry = await this.tauri.undoLast(path);
      await this.refreshRepo();
      this.showToast(entry?.label ?? 'Nothing to undo', { kind: 'info' });
    } catch (err) {
      this.showError(err);
    }
  }

  async checkoutBranch(name: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;

    const remoteEntry = this.remoteBranches().find((b) => b.name === name);
    const parsed = remoteEntry
      ? parseRemoteRef(remoteEntry.name)
      : (() => {
          const candidate = parseRemoteRef(name);
          if (!candidate) return null;
          return this.remotes().some((r) => r.name === candidate.remote) ? candidate : null;
        })();

    if (parsed) {
      const handled = await this.checkoutRemoteTrackingBranch(
        path,
        `${parsed.remote}/${parsed.branch}`,
        parsed.remote,
        parsed.branch,
      );
      if (handled) return;
    }

    await this.runCheckoutWithLocalChanges(path, name);
  }

  /**
   * Git Extensions–style checkout: when the working tree is dirty, ask what to do
   * with local changes (Don't change / Merge / Stash / Reset) before switching.
   */
  private async runCheckoutWithLocalChanges(
    path: string,
    target: string,
    retry?: () => Promise<string>,
  ): Promise<boolean> {
    const dirty = this.changeCount() > 0;
    let mode: 'keep' | 'merge' | 'stash' | 'reset' = 'keep';

    if (dirty) {
      const preview = await this.previewCheckoutOverwrite(path, target);
      const choice = await this.askCheckoutLocalChanges(
        target,
        preview.files.length ? preview.files : undefined,
        preview.includeUntracked,
      );
      if (choice === null) return true;
      mode = choice;
    }

    return this.executeCheckoutLocalChanges(path, target, mode, retry);
  }

  private async previewCheckoutOverwrite(
    path: string,
    target: string,
  ): Promise<{ files: string[]; includeUntracked: boolean }> {
    const status = this.status();
    if (!status) return { files: [], includeUntracked: false };

    const dirtyTrackedPaths = [
      ...status.staged,
      ...status.unstaged,
      ...status.conflicted,
    ].flatMap((f) => [f.path, f.originalPath].filter((p): p is string => !!p?.trim()));
    const untrackedPaths = status.untracked.map((f) => f.path).filter((p) => !!p?.trim());

    try {
      const diff = await this.tauri.runGitCommand(path, ['diff', '--name-only', 'HEAD', target]);
      const changedBetweenHeadAndTarget = (diff.ok ? diff.stdout : '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      let pathsPresentInTarget: string[] = [];
      if (untrackedPaths.length) {
        const tree = await this.tauri.runGitCommand(path, [
          'ls-tree',
          '-r',
          '--name-only',
          target,
        ]);
        if (tree.ok) {
          pathsPresentInTarget = tree.stdout
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter(Boolean);
        }
      }

      return computeCheckoutOverwritePaths({
        changedBetweenHeadAndTarget,
        dirtyTrackedPaths,
        untrackedPaths,
        pathsPresentInTarget,
      });
    } catch {
      return { files: [], includeUntracked: false };
    }
  }

  private async askCheckoutLocalChanges(
    target: string,
    conflictingFiles?: string[],
    includeUntrackedHint = false,
  ): Promise<'keep' | 'merge' | 'stash' | 'reset' | null> {
    const current = this.status()?.branch?.trim() || '(detached HEAD)';
    const hasConflicts = !!conflictingFiles?.length;
    const choice = await this.selects.ask({
      title: 'Checkout branch',
      message: hasConflicts
        ? `Cannot switch from '${current}' to '${target}' — these files would be overwritten. Choose how to handle local changes:`
        : `Switch from '${current}' to '${target}'. Local uncommitted changes found — choose how to handle them:`,
      detailsLabel: hasConflicts
        ? includeUntrackedHint
          ? 'Would be overwritten (including untracked)'
          : 'Would be overwritten by checkout'
        : undefined,
      details: hasConflicts ? conflictingFiles : undefined,
      options: [
        {
          value: 'keep',
          label: "Don't change",
          hint: hasConflicts
            ? 'Unavailable — local changes would be overwritten by this checkout'
            : 'Keep local changes if they do not conflict with the branch you are checking out',
          disabled: hasConflicts,
        },
        {
          value: 'merge',
          label: 'Merge',
          hint: 'Three-way merge between your current branch, local changes, and the branch you are checking out',
        },
        {
          value: 'stash',
          label: 'Stash',
          hint: 'Stash local changes, check out the branch, then optionally re-apply the stash',
        },
        {
          value: 'reset',
          label: 'Reset',
          hint: 'Discard local changes and check out the branch (cannot be undone)',
        },
      ],
      confirmLabel: 'Checkout',
      cancelLabel: 'Cancel',
      initialValue: hasConflicts ? 'stash' : 'keep',
      filterable: false,
    });

    if (choice === null) return null;
    if (choice === 'keep' || choice === 'merge' || choice === 'stash' || choice === 'reset') {
      return choice;
    }
    return null;
  }

  private async executeCheckoutLocalChanges(
    path: string,
    target: string,
    mode: 'keep' | 'merge' | 'stash' | 'reset',
    retry?: () => Promise<string>,
  ): Promise<boolean> {
    if (mode === 'reset') {
      const confirmed = await this.prompts.ask({
        title: 'Discard local changes?',
        message: `Reset discards all uncommitted changes, then checks out '${target}'. Git has no record of those changes — they cannot be retrieved.`,
        confirmLabel: 'Discard & checkout',
        cancelLabel: 'Cancel',
        confirmOnly: true,
        required: false,
      });
      if (confirmed === null) return true;
    }

    try {
      if (mode === 'stash') {
        const status = this.status();
        const includeUntracked = (status?.untracked.length ?? 0) > 0;
        await this.withRepoMutation(() =>
          this.tauri.stashPush(path, `Auto-stash before checkout ${target}`, includeUntracked),
        );
      } else if (mode === 'reset') {
        const hard = await this.tauri.runGitCommand(path, ['reset', '--hard']);
        if (!hard.ok) {
          throw new Error(hard.stderr.trim() || hard.stdout.trim() || 'git reset --hard failed');
        }
      }

      let message: string;
      if (retry) {
        if (mode === 'merge') {
          try {
            const result = await this.tauri.checkoutBranch(path, target, 'merge');
            await this.refreshRepo();
            message = result.message;
          } catch {
            message = await retry();
          }
        } else {
          message = await retry();
        }
      } else {
        const localChanges =
          mode === 'merge' ? 'merge' : mode === 'reset' ? 'force' : 'keep';
        const result = await this.tauri.checkoutBranch(path, target, localChanges);
        await this.refreshRepo();
        message = result.message;
      }

      this.showToast(message, { kind: 'success' });

      if (mode === 'stash') {
        const apply = await this.prompts.ask({
          title: 'Apply stashed changes?',
          message: `Apply the stash onto '${target}' now?`,
          confirmLabel: 'Apply stash',
          cancelLabel: 'Keep stashed',
          confirmOnly: true,
          required: false,
        });
        if (apply !== null) {
          await this.stashPop(0);
        }
      }

      return true;
    } catch (err) {
      const raw = this.formatError(err);
      if (mode === 'keep' && isCheckoutBlockedByLocalChanges(raw)) {
        const files = parseCheckoutBlockedPaths(raw);
        const includeUntracked = checkoutBlockedNeedsUntracked(raw);
        const next = await this.askCheckoutLocalChanges(target, files, includeUntracked);
        if (next === null) return true;
        return this.executeCheckoutLocalChanges(path, target, next, retry);
      }
      this.showError(err);
      return true;
    }
  }

  private async handleCheckoutBlockedByLocalChanges(
    path: string,
    target: string,
    err: unknown,
    retry?: () => Promise<string>,
  ): Promise<boolean> {
    const raw = this.formatError(err);
    if (!isCheckoutBlockedByLocalChanges(raw)) return false;

    const files = parseCheckoutBlockedPaths(raw);
    const includeUntracked = checkoutBlockedNeedsUntracked(raw);
    const choice = await this.askCheckoutLocalChanges(target, files, includeUntracked);
    if (choice === null) return true;
    return this.executeCheckoutLocalChanges(path, target, choice, retry);
  }

  private async checkoutRemoteTrackingBranch(
    path: string,
    remoteRef: string,
    remote: string,
    branch: string,
  ): Promise<boolean> {
    const local = this.localBranches().find((b) => b.name === branch);
    if (!local) {
      try {
        const result = await this.tauri.createBranch(path, branch, true, remoteRef);
        const tracked = await this.tauri.runGitCommand(path, [
          'branch',
          `--set-upstream-to=${remoteRef}`,
          branch,
        ]);
        await this.refreshRepo();
        if (!tracked.ok) {
          this.showToast(
            result.message || `Created and checked out '${branch}' from ${remoteRef}`,
          );
          return true;
        }
        this.showToast(`Created and checked out '${branch}' tracking ${remoteRef}`, {
          kind: 'success',
        });
      } catch (err) {
        if (
          await this.handleCheckoutBlockedByLocalChanges(path, branch, err, async () => {
            const result = await this.tauri.createBranch(path, branch, true, remoteRef);
            const tracked = await this.tauri.runGitCommand(path, [
              'branch',
              `--set-upstream-to=${remoteRef}`,
              branch,
            ]);
            await this.refreshRepo();
            if (!tracked.ok) {
              return result.message || `Created and checked out '${branch}' from ${remoteRef}`;
            }
            return `Created and checked out '${branch}' tracking ${remoteRef}`;
          })
        ) {
          return true;
        }
        this.showError(err);
      }
      return true;
    }

    let behind = 0;
    let ahead = 0;
    const status = this.status();
    if (
      status &&
      !status.isDetached &&
      status.branch === branch &&
      status.upstream === remoteRef
    ) {
      behind = status.behind;
      ahead = status.ahead;
    } else {
      const remoteTip = this.remoteBranches().find((b) => b.name === remoteRef)?.tipSha;
      if (!local.tipSha || !remoteTip || local.tipSha !== remoteTip) {
        const counts = await this.countAheadBehind(path, branch, remoteRef);
        if (counts) {
          ahead = counts.ahead;
          behind = counts.behind;
        }
      }
    }

    if (behind > 0) {
      const commitLabel = behind === 1 ? '1 commit' : `${behind} commits`;
      const extra =
        ahead > 0
          ? ` Your local branch is also ${ahead} commit${ahead === 1 ? '' : 's'} ahead — pull may create a merge.`
          : '';
      const confirmed = await this.prompts.ask({
        title: 'Remote is ahead',
        message: `${remoteRef} is ${commitLabel} ahead of local '${branch}'. Updating will overwrite your local branch with the remote tip.${extra}`,
        confirmLabel: 'Pull & checkout',
        cancelLabel: 'Cancel',
        confirmOnly: true,
        required: false,
      });
      if (confirmed === null) return true;

      try {
        if (!local.isCurrent) {
          await this.tauri.checkoutBranch(path, branch);
        }
        const rebase = this.settings().defaultPullAction === 'rebase';
        const args = rebase
          ? ['pull', '--rebase', remote, branch]
          : ['pull', remote, branch];
        const pulled = await this.tauri.runGitCommand(path, args);
        await this.refreshRepo();
        if (!pulled.ok) {
          this.showError(pulled.stderr.trim() || pulled.stdout.trim() || 'Pull failed');
          return true;
        }
        this.showToast(
          pulled.stdout.trim() || `Updated '${branch}' from ${remoteRef}`,
          { kind: 'success', durationMs: 3200, category: 'pull' },
        );
      } catch (err) {
        if (
          await this.handleCheckoutBlockedByLocalChanges(path, branch, err, async () => {
            if (!local.isCurrent) {
              await this.tauri.checkoutBranch(path, branch);
            }
            const rebase = this.settings().defaultPullAction === 'rebase';
            const args = rebase
              ? ['pull', '--rebase', remote, branch]
              : ['pull', remote, branch];
            const pulled = await this.tauri.runGitCommand(path, args);
            await this.refreshRepo();
            if (!pulled.ok) {
              throw new Error(pulled.stderr.trim() || pulled.stdout.trim() || 'Pull failed');
            }
            return pulled.stdout.trim() || `Updated '${branch}' from ${remoteRef}`;
          })
        ) {
          return true;
        }
        this.showError(err);
      }
      return true;
    }

    try {
      if (local.isCurrent) {
        this.showToast(`Already on '${branch}'`);
        return true;
      }
      await this.runCheckoutWithLocalChanges(path, branch);
    } catch (err) {
      this.showError(err);
    }
    return true;
  }

  private async countAheadBehind(
    path: string,
    left: string,
    right: string,
  ): Promise<{ ahead: number; behind: number } | null> {
    try {
      const result = await this.tauri.runGitCommand(path, [
        'rev-list',
        '--left-right',
        '--count',
        `${left}...${right}`,
      ]);
      if (!result.ok) return null;
      const parts = result.stdout.trim().split(/\s+/);
      if (parts.length < 2) return null;
      return {
        ahead: Number.parseInt(parts[0], 10) || 0,
        behind: Number.parseInt(parts[1], 10) || 0,
      };
    } catch {
      return null;
    }
  }

  async createBranch(name: string, startPoint?: string, checkout = true): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path || !name.trim()) return false;
    const trimmed = name.trim();
    try {
      const result = await this.tauri.createBranch(path, trimmed, checkout, startPoint);
      await this.refreshRepo();
      this.showToast(result.message, () =>
        void this.tauri.undoLast(path).then(() => this.refreshRepo()),
      );
      return true;
    } catch (err) {
      if (
        checkout &&
        (await this.handleCheckoutBlockedByLocalChanges(path, trimmed, err, async () => {
          const result = await this.tauri.createBranch(path, trimmed, true, startPoint);
          await this.refreshRepo();
          return result.message || `Stashed changes and created '${trimmed}'`;
        }))
      ) {
        return true;
      }
      this.showError(err);
      return false;
    }
  }

  async openSafety(action: SafetyAction, target?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const analysis = await this.tauri.analyzeSafety(path, action, target);
      this.safety.set(analysis);
    } catch (err) {
      this.showError(err);
    }
  }

  closeSafety(): void {
    this.safety.set(null);
  }

  async executeSafety(
    useRecommended: boolean,
    options?: {
      confirmationPhrase?: string;
      allowBareForce?: boolean;
      acknowledged?: boolean;
    },
  ): Promise<void> {
    const path = this.currentRepo()?.path;
    const analysis = this.safety();
    if (!path || !analysis) return;
    try {
      const result = await this.tauri.executeSafeAction(
        path,
        analysis.action,
        analysis.target,
        useRecommended,
        options,
      );
      if (!result.ok) {
        this.showToast(result.message || 'Action blocked', { kind: 'warning' });
        return;
      }
      this.safety.set(null);
      await this.refreshRepo();
      if (result.undoable) {
        this.showToast(result.message, () =>
          void this.tauri.undoLast(path).then(() => this.refreshRepo()),
        );
      } else {
        this.showToast(result.message);
      }
    } catch (err) {
      if (
        analysis.action === 'forcePush' &&
        useRecommended &&
        this.isForceWithLeaseRejected(err)
      ) {
        this.showWarning(
          'Force-with-lease refused — the remote moved since your last fetch. Fetch first, then try again.',
        );
        await this.openSafety('forcePush', analysis.target ?? undefined);
        return;
      }
      this.showError(err);
    }
  }

  async fetchRemote(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.fetch(path));
      await this.refreshRepo();
      this.showToast(result.message || 'Fetched from remote', {
        kind: 'success',
        durationMs: 3200,
        category: 'fetch',
      });
    } catch (err) {
      this.showError(err);
    }
  }

  async pullRemote(rebase = false): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() =>
        rebase
          ? this.tauri.pullWithOptions(path, { rebase: true })
          : this.tauri.pull(path),
      );
      await this.refreshRepo();
      this.showToast(result.message || (rebase ? 'Pulled with rebase' : 'Pulled from remote'), {
        kind: 'success',
        durationMs: 3200,
        category: 'pull',
      });
    } catch (err) {
      this.showError(err);
    }
  }

  async pushRemote(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (this.currentBranchLocked()) {
      const branch = this.status()?.branch ?? 'branch';
      const reason = this.currentBranchLockReason();
      this.showWarning(
        reason
          ? `Branch '${branch}' is locked: ${reason}`
          : `Branch '${branch}' is locked. Unlock it before pushing.`,
      );
      return;
    }

    let status = this.status();
    if (status && status.ahead > 0 && status.behind > 0) {
      const choice = await this.resolveDivergedPush(status);
      if (choice === 'cancel') return;
      if (choice === 'force') {
        await this.openForcePushSafety(status.branch);
        return;
      }

      await this.pullRemote(this.settings().defaultPullAction === 'rebase');
      status = this.status();
      if (!status || status.ahead === 0) return;
      if (status.behind > 0) {
        this.showWarning('Still diverged after pull. Resolve conflicts, then push again.');
        return;
      }
    }

    const pushOpts = await this.preparePushOptions(status);
    if (!pushOpts) return;

    try {
      const result = await this.tauri.push(path, pushOpts);
      await this.refreshRepo();
      this.showToast(result.message || 'Pushed to remote', {
        kind: 'success',
        durationMs: 3200,
        category: 'push',
      });
    } catch (err) {
      const message = this.formatError(err);
      if (/non-fast-forward|rejected|fetch first/i.test(message)) {
        await this.openForcePushSafety(status?.branch);
        return;
      }
      this.showError(message);
    }
  }

  private async resolveDivergedPush(status: RepoStatus): Promise<'pull' | 'force' | 'cancel'> {
    const up = status.upstream ?? 'upstream';
    const choice = await this.selects.ask({
      title: 'Branch has diverged',
      message: `'${status.branch}' is ${status.ahead} ahead and ${status.behind} behind ${up}. Pushing now would require overwriting remote history.`,
      label: 'How to proceed',
      options: [
        {
          value: 'pull',
          label: 'Pull remote changes first',
          hint: 'Safer — integrate remote commits, then push yours',
        },
        {
          value: 'force',
          label: 'Force push with lease',
          hint: 'Overwrites the remote if nobody else pushed since your last fetch',
        },
      ],
      initialValue: 'pull',
      confirmLabel: 'Continue',
    });
    if (choice === 'pull' || choice === 'force') return choice;
    return 'cancel';
  }

  private async preparePushOptions(
    status: RepoStatus | null,
  ): Promise<{ setUpstream?: boolean } | null> {
    const branch = status?.branch;
    if (!branch) return {};

    const hasUpstream = !!status?.upstream;
    if (hasUpstream) return {};

    if (!(await this.confirmIfEnabled('confirmPushNewBranch', {
      title: 'Push new branch?',
      message: `'${branch}' does not exist on the remote yet. Create it with this push?`,
      confirmLabel: 'Push new branch',
    }))) {
      return null;
    }

    if (!this.settings().confirmAddTrackingRef) {
      return { setUpstream: true };
    }

    const choice = await this.selects.ask({
      title: 'Remember this remote branch?',
      message: `'${branch}' isn’t on the remote yet. After pushing, should Branchline link this local branch to origin/${branch} so Pull and Push know where to go?`,
      label: 'After push',
      options: [
        {
          value: 'yes',
          label: 'Yes — set upstream (recommended)',
          hint: 'Links local ↔ origin so future Pull/Push/Sync work without asking again',
        },
        {
          value: 'no',
          label: 'No — just push once',
          hint: 'Uploads the branch but doesn’t track it; you’ll need to set upstream later',
        },
      ],
      initialValue: 'yes',
      confirmLabel: 'Continue',
    });
    if (choice === null) return null;
    return { setUpstream: choice === 'yes' };
  }

  private async runForceWithLease(branch?: string | null): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const remote = this.pushRemoteName();
    try {
      const result = await this.tauri.push(path, { forceWithLease: true, remote });
      await this.refreshRepo();
      this.showToast(result.message || `Force-pushed ${branch ?? 'branch'} with lease`, {
        kind: 'success',
        category: 'push',
      });
    } catch (err) {
      if (this.isForceWithLeaseRejected(err)) {
        this.showWarning(
          'Force-with-lease refused — the remote moved since your last fetch. Fetch first, then try again.',
        );
        await this.openSafety('forcePush', branch ?? undefined);
        return;
      }
      this.showError(err);
    }
  }

  private pushRemoteName(): string | undefined {
    const upstream = this.status()?.upstream?.trim();
    if (!upstream) return undefined;
    const slash = upstream.indexOf('/');
    if (slash <= 0) return undefined;
    return upstream.slice(0, slash);
  }

  private isForceWithLeaseRejected(err: unknown): boolean {
    const message = this.formatError(err).toLowerCase();
    return (
      message.includes('stale info') ||
      message.includes('failed to push some refs') ||
      (message.includes('force-with-lease') && message.includes('rejected')) ||
      (message.includes('rejected') && message.includes('fetch first'))
    );
  }

  private async openForcePushSafety(branch?: string | null): Promise<void> {
    const name = branch?.trim() || this.status()?.branch || undefined;
    if (this.settings().confirmForcePush || (name ? isMainlineBranch(name) : false)) {
      await this.openSafety('forcePush', name);
      return;
    }
    await this.runForceWithLease(name);
  }

  async syncRemote(): Promise<void> {
    const status = this.status();
    if (status && status.ahead > 0 && status.behind > 0) {
      await this.pushRemote();
      return;
    }
    const action = this.settings().defaultPullAction;
    if (action === 'fetch') {
      await this.fetchRemote();
    } else {
      await this.pullRemote(action === 'rebase');
    }
    await this.pushRemote();
  }

  setHistoryFilter(partial: Partial<HistoryFilter>): void {
    this.historyFilter.update((f) => {
      const next = { ...f, ...partial };
      if (partial.mineOnly === true) {
        next.author = '';
      }
      if (partial.author !== undefined && partial.author.trim()) {
        next.mineOnly = false;
      }
      return next;
    });
    if (!this.restoringSession) {
      const f = this.historyFilter();
      this.patchSession({
        historyCurrentBranchOnly: f.currentBranchOnly,
        historyMineOnly: f.mineOnly,
      });
    }
  }

  toggleMineFilter(): void {
    const enabling = !this.historyFilter().mineOnly;
    if (enabling) {
      const id = this.identity();
      if (!id?.name?.trim() && !id?.email?.trim()) {
        void this.refreshIdentity().then(() => {
          const refreshed = this.identity();
          if (!refreshed?.name?.trim() && !refreshed?.email?.trim()) {
            this.showToast('Set user.name / user.email in Git to use Mine', { kind: 'warning' });
            return;
          }
          this.setHistoryFilter({ mineOnly: true });
        });
        return;
      }
    }
    this.setHistoryFilter({ mineOnly: enabling });
  }

  toggleCurrentBranchFilter(): void {
    this.setHistoryFilter({ currentBranchOnly: !this.historyFilter().currentBranchOnly });
  }

  clearHistoryFilter(): void {
    this.historyFilter.set({ query: '', author: '', currentBranchOnly: false, mineOnly: false });
    if (!this.restoringSession) {
      this.patchSession({ historyCurrentBranchOnly: false, historyMineOnly: false });
    }
  }

  async addRemote(name: string, url: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.addRemote(path, name, url);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async removeRemote(name: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!(await this.confirmIfEnabled('confirmRemoveRemote', {
      title: 'Remove remote?',
      message: `Remove remote "${name}" from this repository? Local branches and commits stay; only the remote entry is deleted.`,
      confirmLabel: 'Remove remote',
    }))) {
      return;
    }
    try {
      const result = await this.tauri.removeRemote(path, name);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async squashSelected(count: number, message: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.squashCommits(path, count, message);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  focusCommitPanel(): void {
    this.openCommitModal();
  }

  openCommitModal(): Promise<boolean> {
    return new Promise((resolve) => {
      this.commitWaiter?.(false);
      this.commitWaiter = resolve;
      this.commitModalOpen.set(true);
    });
  }

  closeCommitModal(completed = false): void {
    this.commitModalOpen.set(false);
    this.pendingCommitTemplate.set(null);
    const waiter = this.commitWaiter;
    this.commitWaiter = null;
    waiter?.(completed);
  }

  openShortcutPalette(): void {
    this.paletteSeedQuery.set('shortcut');
    this.paletteOpen.set(true);
  }

  applyCommitTemplate(template: TemplateInfo): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.pendingCommitTemplate.set(template);
    this.setView('browse');
    this.openCommitModal();
  }

  applyBranchTemplate(template: TemplateInfo): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    const name = this.resolveBranchPattern(template.pattern);
    if (!name) {
      this.showWarning('Branch template resolved to an empty name');
      return;
    }
    this.setView('browse');
    this.openCreateBranchDialog(null, name);
  }

  resolveBranchPattern(pattern: string): string {
    const settings = this.settings();
    const branch = this.status()?.branch ?? 'main';
    const jira = this.activeJiraKey() || '';
    const prefix = (settings.branchPrefix || settings.branchPrefixes[0] || 'feature')
      .trim()
      .replace(/^\/+|\/+$/g, '');
    const user = slugifyUser(this.identity()?.name);
    return sanitizeBranchName(
      resolveWorkflowPattern(pattern, {
        branch,
        jira,
        prefix,
        user,
        type: 'feat',
        summary: 'summary',
      }),
    );
  }

  async ignorePath(filePath: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !filePath.trim()) return;
    try {
      const file = await this.tauri.getIgnoreFile(path, 'gitignore');
      const lines = file.content.split(/\r?\n/);
      const pattern = filePath.trim();
      if (lines.some((line) => line.trim() === pattern)) {
        this.showInfo(`Already ignored: ${pattern}`);
        return;
      }
      const next = file.content.trimEnd();
      const content = next ? `${next}\n${pattern}\n` : `${pattern}\n`;
      const result = await this.tauri.saveIgnoreFile(path, 'gitignore', content);
      await this.refreshRepo();
      this.showSuccess(result.message || `Ignored ${pattern}`);
    } catch (err) {
      this.showError(err);
    }
  }

  async openCreatePullRequest(): Promise<void> {
    const status = this.status();
    const remotes = this.remotes();
    if (!status) {
      this.showWarning('Open a repository first');
      return;
    }
    const origin =
      remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;
    if (!origin) {
      this.showWarning('No remotes configured');
      return;
    }
    const upstream = status.upstream?.includes('/')
      ? status.upstream.split('/').slice(1).join('/')
      : null;
    const url = buildCompareUrl(origin.fetchUrl || origin.pushUrl, status.branch, upstream);
    if (!url) {
      this.showWarning('Could not build a pull request URL from the remote');
      return;
    }
    try {
      await this.tauri.openExternalUrl(url);
    } catch (err) {
      this.showError(err);
    }
  }

  openChangelogModal(): void {
    if (!this.currentRepo()) {
      this.showToast('Open a repository first', { kind: 'warning' });
      return;
    }
    this.setView('browse');
    this.changelogModalOpen.set(true);
  }

  closeChangelogModal(): void {
    this.changelogModalOpen.set(false);
  }

  async runNextAction(): Promise<void> {
    const status = this.status();
    if (!status) {
      this.goHome();
      return;
    }
    if (status.conflicted.length) {
      this.setBrowseTab('files');
      return;
    }
    if (status.staged.length || status.unstaged.length || status.untracked.length) {
      this.openCommitModal();
      return;
    }
    if (status.ahead > 0) {
      await this.pushRemote();
      return;
    }
    if (status.behind > 0) {
      await this.pullRemote();
    }
  }

  async openCherryPickPreview(shas?: string[]): Promise<void> {
    const path = this.currentRepo()?.path;
    const selected = shas?.length ? shas : this.selectedShas();
    if (!path || !selected.length) return;
    const preview = await this.tauri.cherryPickPreview(path, selected);
    this.cherryPreview.set(preview);
    this.cherryPreviewOpen.set(true);
  }

  closeCherryPick(): void {
    this.cherryPreviewOpen.set(false);
    this.cherryPreview.set(null);
  }

  async applyCherryPick(): Promise<void> {
    const path = this.currentRepo()?.path;
    const preview = this.cherryPreview();
    if (!path || !preview) return;
    const shas = preview.commits.filter((c) => !c.alreadyApplied).map((c) => c.sha);
    if (!shas.length) {
      this.showToast('All selected commits are already on this branch', { kind: 'info' });
      this.closeCherryPick();
      return;
    }
    const result = await this.tauri.cherryPick(path, shas);
    if (!result.ok) {
      await this.handleConflictResult(result);
      return;
    }
    this.closeCherryPick();
    await this.refreshRepo();
    this.showToast(result.message);
  }

  async openInteractiveRebase(fromSha?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const selected = fromSha ?? this.selectedSha();
    if (!selected) {
      this.showToast('Select a commit to rebase from', { kind: 'warning' });
      return;
    }
    try {
      const commit = this.commits().find((c) => c.sha === selected || c.shortSha === selected);
      const onto = commit?.parents?.[0] || selected;
      const preview = await this.tauri.previewInteractiveRebase(path, onto);
      if (!preview.commits.length) {
        this.showToast('No commits to rebase above this point', { kind: 'info' });
        return;
      }
      this.interactiveRebase.set(preview);
      this.interactiveRebaseSteps.set(
        preview.commits.map((c) => ({
          sha: c.sha,
          shortSha: c.shortSha,
          subject: c.subject,
          author: c.author,
          action: 'pick' as const,
          message: c.subject,
        })),
      );
      this.interactiveRebaseOpen.set(true);
    } catch (err) {
      this.showError(err);
    }
  }

  closeInteractiveRebase(): void {
    this.interactiveRebaseOpen.set(false);
    this.interactiveRebase.set(null);
    this.interactiveRebaseSteps.set([]);
  }

  setRebaseStepAction(sha: string, action: RebaseStep['action']): void {
    this.interactiveRebaseSteps.update((steps) =>
      steps.map((s) => (s.sha === sha ? { ...s, action } : s)),
    );
  }

  setRebaseStepMessage(sha: string, message: string): void {
    this.interactiveRebaseSteps.update((steps) =>
      steps.map((s) => (s.sha === sha ? { ...s, message } : s)),
    );
  }

  moveRebaseStep(sha: string, direction: -1 | 1): void {
    this.interactiveRebaseSteps.update((steps) => {
      const index = steps.findIndex((s) => s.sha === sha);
      if (index < 0) return steps;
      const next = index + direction;
      if (next < 0 || next >= steps.length) return steps;
      const copy = steps.slice();
      const [item] = copy.splice(index, 1);
      copy.splice(next, 0, item);
      return copy;
    });
  }

  async applyInteractiveRebase(): Promise<void> {
    const path = this.currentRepo()?.path;
    const preview = this.interactiveRebase();
    const steps = this.interactiveRebaseSteps();
    if (!path || !preview || !steps.length) return;
    try {
      const result = await this.tauri.startInteractiveRebase(
        path,
        preview.onto,
        steps.map((s) => ({
          sha: s.sha,
          action: s.action,
          message: s.action === 'reword' ? s.message : null,
        })),
      );
      this.closeInteractiveRebase();
      if (!result.ok) {
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async openIgnoreEditor(kind: IgnoreKind = 'gitignore'): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const file = await this.tauri.getIgnoreFile(path, kind);
      this.ignoreEditor.set(file);
      this.ignoreEditorOpen.set(true);
    } catch (err) {
      this.showError(err);
    }
  }

  closeIgnoreEditor(): void {
    this.ignoreEditorOpen.set(false);
    this.ignoreEditor.set(null);
  }

  async saveIgnoreEditor(content: string, kind?: IgnoreKind): Promise<void> {
    const path = this.currentRepo()?.path;
    const current = this.ignoreEditor();
    if (!path || !current) return;
    const targetKind = (kind ?? current.kind) as IgnoreKind;
    try {
      const result = await this.tauri.saveIgnoreFile(path, targetKind, content);
      this.showToast(result.message);
      this.closeIgnoreEditor();
    } catch (err) {
      this.showError(err);
    }
  }

  async addWorktree(
    worktreePath: string,
    opts: { branch?: string; createBranch?: boolean; startPoint?: string } = {},
  ): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.addWorktree(path, worktreePath, opts);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.removeWorktree(path, worktreePath, force);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async pruneWorktrees(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.pruneWorktrees(path);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async openWorktree(worktreePath: string): Promise<void> {
    await this.openRepo(worktreePath);
  }

  async revertSelected(): Promise<void> {
    const path = this.currentRepo()?.path;
    const sha = this.selectedSha();
    if (!path || !sha) return;
    const result = await this.tauri.revertCommit(path, sha);
    if (!result.ok) {
      await this.handleConflictResult(result);
      return;
    }
    await this.refreshRepo();
    this.showToast(result.message);
  }

  async pinRepo(path: string, pinned: boolean): Promise<void> {
    this.repos.set(await this.tauri.pinRepo(path, pinned));
  }

  async removeRepo(path: string): Promise<void> {
    const wasOpen = this.openRepos().some((r) => r.path === path);
    this.repos.set(await this.tauri.removeRecentRepo(path));
    if (wasOpen) {
      await this.closeOpenRepo(path, false);
      this.showToast('Removed from recent and closed');
    }
  }

  async cloneRepo(url: string, destination: string): Promise<void> {
    this.loading.set(true);
    try {
      const summary = await this.tauri.cloneRepository(url, destination);
      this.clearWorkingState();
      this.currentRepo.set(summary);
      this.upsertOpenRepo(summary);
      this.repos.set(await this.tauri.listRecentRepos());
      await this.refreshRepo();
      this.persistOpenRepos();
      this.setView('browse');
      this.showToast(`Cloned ${summary.name}`);
    } catch (err) {
      this.showError(err);
    } finally {
      this.loading.set(false);
    }
  }

  async initRepo(path: string): Promise<void> {
    this.loading.set(true);
    try {
      const summary = await this.tauri.initRepository(path);
      this.clearWorkingState();
      this.currentRepo.set(summary);
      this.upsertOpenRepo(summary);
      this.repos.set(await this.tauri.listRecentRepos());
      await this.refreshRepo();
      this.persistOpenRepos();
      this.setView('browse');
      this.showToast(`Initialized ${summary.name}`);
    } catch (err) {
      this.showError(err);
    } finally {
      this.loading.set(false);
    }
  }

  async stashPush(message?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashPush(path, message));
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async stashPop(index: number): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashPop(path, index));
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async stashApply(index: number): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashApply(path, index));
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async stashDrop(index: number): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const entry = this.stashes().find((s) => s.index === index);
    const label = entry?.id ?? `stash@{${index}}`;
    if (!(await this.confirmIfEnabled('confirmStashDrop', {
      title: 'Drop stash?',
      message: `Permanently delete ${label}? This cannot be undone from Branchline.`,
      confirmLabel: 'Drop stash',
    }))) {
      return;
    }
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashDrop(path, index));
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async mergeBranch(name: string, noFf = false): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.mergeBranch(path, name, noFf));
      if (!result.ok) {
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async rebaseOnto(onto: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.rebaseOnto(path, onto));
      if (!result.ok) {
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async abortOperation(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!(await this.confirmIfEnabled('confirmAbortOperation', {
      title: 'Abort in-progress operation?',
      message:
        'Aborting a merge, rebase, cherry-pick, or revert discards the in-progress resolution and returns the repo to the pre-operation state.',
      confirmLabel: 'Abort',
    }))) {
      return;
    }
    if (!(await this.confirmIfEnabled('confirmAbortSecond', {
      title: 'Are you sure?',
      message: 'This is the second confirmation. Conflict resolutions in progress will be lost.',
      confirmLabel: 'Yes, abort',
    }))) {
      return;
    }
    try {
      const result = await this.tauri.abortOperation(path);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async continueOperation(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.continueOperation(path);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async refreshDetectedEditors(): Promise<void> {
    try {
      this.detectedEditors.set(await this.tauri.detectEditors());
    } catch {
      this.detectedEditors.set(null);
    }
  }

  preferredEditorButtonLabel(): string {
    return preferredEditorLabel(this.settings().preferredEditor, this.detectedEditors());
  }

  async openPathsInEditor(relativePaths: string[]): Promise<void> {
    const repo = this.currentRepo()?.path;
    if (!repo) {
      this.showWarning('Open a repository first');
      return;
    }
    const cleaned = relativePaths.map((p) => p.trim()).filter(Boolean);
    const abs = cleaned.length
      ? cleaned.map((p) => `${repo.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`)
      : [repo];
    try {
      const result = await openPathsInPreferredEditor(abs, {
        preferred: this.settings().preferredEditor,
        editorCommand: this.settings().editorCommand,
        detected: this.detectedEditors(),
        openExternalUrl: (url) => this.tauri.openExternalUrl(url),
        openWithCommand: async (command, path) => {
          const opened = await this.tauri.openPathWithCommand(command, path);
          if (!opened.ok) throw new Error(opened.message);
        },
      });
      if (result.opened > 1) {
        this.showInfo(`Opened ${result.opened} files in ${this.preferredEditorButtonLabel()}`);
      }
    } catch (err) {
      this.showError(err);
    }
  }

  async openConflictedInEditor(): Promise<void> {
    const conflicted = this.status()?.conflicted.map((f) => f.path) ?? [];
    await this.openPathsInEditor(conflicted);
  }

  async openMergeToolForPaths(paths?: string[]): Promise<void> {
    const repo = this.currentRepo()?.path;
    if (!repo) {
      this.showWarning('Open a repository first');
      return;
    }
    const targets =
      paths?.length ? paths : (this.status()?.conflicted.map((f) => f.path) ?? []);
    try {
      const result = await runConfiguredGitTool({
        kind: 'merge',
        repoPath: repo,
        toolName: this.settings().mergeTool,
        paths: targets,
        runGitCommand: (path, args) => this.tauri.runGitCommand(path, args),
      });
      if (!result.ok) {
        this.showWarning(
          result.stderr ||
            result.stdout ||
            'No merge tool configured — set one in Settings → Tools',
        );
      } else {
        this.showSuccess(result.stdout || 'Opened merge tool');
      }
      await this.refreshRepo();
    } catch (err) {
      this.showError(err);
    }
  }

  async openDiffToolForPaths(paths?: string[]): Promise<void> {
    const repo = this.currentRepo()?.path;
    if (!repo) {
      this.showWarning('Open a repository first');
      return;
    }
    const targets = paths?.filter(Boolean) ?? [];
    const selected = this.selectedDiffPath();
    const pathArgs = targets.length ? targets : selected ? [selected] : [];
    try {
      const result = await runConfiguredGitTool({
        kind: 'diff',
        repoPath: repo,
        toolName: this.settings().diffTool,
        paths: pathArgs,
        runGitCommand: (path, args) => this.tauri.runGitCommand(path, args),
      });
      if (!result.ok) {
        this.showWarning(
          result.stderr ||
            result.stdout ||
            'No diff tool configured — set one in Settings → Tools',
        );
      } else {
        this.showSuccess(result.stdout || 'Opened diff tool');
      }
    } catch (err) {
      this.showError(err);
    }
  }

  async takeConflictSide(path: string, side: 'ours' | 'theirs'): Promise<void> {
    const repo = this.currentRepo()?.path;
    if (!repo || !path) return;
    try {
      const flag = side === 'ours' ? '--ours' : '--theirs';
      const result = await this.tauri.runGitCommand(repo, ['checkout', flag, '--', path]);
      if (!result.ok) {
        this.showWarning(result.stderr || result.stdout || `Could not take ${side}`);
        return;
      }
      await this.stagePaths([path]);
      this.showSuccess(`Took ${side} for ${path}`);
    } catch (err) {
      this.showError(err);
    }
  }

  async markConflictResolved(path: string): Promise<void> {
    await this.stagePaths([path]);
    this.showSuccess(`Marked ${path} as resolved`);
  }

  private async handleConflictResult(result: MutationOutput): Promise<void> {
    await this.refreshRepo();
    this.showToast(result.message, { kind: 'warning' });
    this.setBrowseTab('files');
  }

  async resetTo(target: string, mode: ResetMode): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (mode === 'hard') {
      await this.openSafety('hardReset', target);
      return;
    }
    try {
      const result = await this.tauri.resetTo(path, target, mode);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async createTag(name: string, target?: string, message?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !name.trim()) return;
    try {
      const result = await this.tauri.createTag(path, name.trim(), target, message);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async deleteTag(name: string): Promise<void> {
    await this.openSafety('deleteTag', name);
  }

  async forcePush(): Promise<void> {
    if (this.currentBranchLocked()) {
      const branch = this.status()?.branch ?? 'branch';
      const reason = this.currentBranchLockReason();
      this.showWarning(
        reason
          ? `Branch '${branch}' is locked: ${reason}`
          : `Branch '${branch}' is locked. Unlock it before force-pushing.`,
      );
      return;
    }
    await this.openForcePushSafety(this.status()?.branch);
  }

  private async confirmIfEnabled(
    setting:
      | 'confirmAmend'
      | 'confirmUndoLastCommit'
      | 'confirmStashDrop'
      | 'confirmAbortOperation'
      | 'confirmAbortSecond'
      | 'confirmRemoveRemote'
      | 'confirmPushNewBranch',
    options: { title: string; message: string; confirmLabel?: string },
  ): Promise<boolean> {
    if (!this.settings()[setting]) return true;
    const result = await this.prompts.ask({
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'Continue',
      cancelLabel: 'Cancel',
      confirmOnly: true,
    });
    return result !== null;
  }

  openFileHistory(filePath: string): void {
    this.fileHistoryPath.set(filePath);
    this.selectedDiffPath.set(filePath);
    this.setBrowseTab('history');
  }

  openFileBlame(filePath: string): void {
    this.selectedDiffPath.set(filePath);
    this.setBrowseTab('blame');
  }

  async renameBranch(from: string, to: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !to.trim()) return;
    try {
      const result = await this.tauri.renameBranch(path, from, to.trim());
      await this.refreshRepo();
      this.showToast(result.message, () =>
        void this.tauri.undoLast(path).then(() => this.refreshRepo()),
      );
    } catch (err) {
      this.showError(err);
    }
  }

  async deleteOtherLocalBranches(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return;
    }

    const current = this.status()?.branch ?? null;
    const worktreeBranches = new Set(
      this.worktrees()
        .filter((w) => !w.isMain && !!w.branch?.trim())
        .map((w) => w.branch!.trim()),
    );

    const targets = this.localBranches().filter((b) => {
      if (b.isCurrent || b.locked) return false;
      if (current && b.name === current) return false;
      if (worktreeBranches.has(b.name)) return false;
      return true;
    });

    if (targets.length === 0) {
      this.showToast('No other local branches to delete', { kind: 'info' });
      return;
    }

    const mode = await this.selects.ask({
      title: 'Clean up local branches',
      message: `Delete ${targets.length} local branch${targets.length === 1 ? '' : 'es'}? Keeps your current branch${current ? ` (${current})` : ''}, locked branches, and branches checked out in other worktrees. Remotes are not deleted.`,
      label: 'What to delete',
      options: [
        {
          value: 'merged',
          label: 'Merged only',
          hint: 'Safer — skips branches with commits not in HEAD',
        },
        {
          value: 'all',
          label: 'All except current',
          hint: 'Also deletes unmerged branches (harder to recover)',
        },
      ],
      initialValue: 'merged',
      confirmLabel: 'Continue',
    });
    if (mode !== 'merged' && mode !== 'all') return;

    if (mode === 'all') {
      const ok = await this.prompts.ask({
        title: 'Delete unmerged branches too?',
        message: `Force-delete ${targets.length} local branch${targets.length === 1 ? '' : 'es'}. Commits that only exist on those branches may be hard to recover.`,
        confirmLabel: 'Delete all',
        cancelLabel: 'Cancel',
        confirmOnly: true,
        required: false,
      });
      if (ok === null) return;
    }

    const force = mode === 'all';
    let deleted = 0;
    const skipped: string[] = [];
    for (const branch of targets) {
      try {
        await this.tauri.deleteBranch(path, branch.name, force);
        deleted += 1;
      } catch {
        skipped.push(branch.name);
      }
    }

    await this.refreshRepo();
    if (deleted === 0 && skipped.length > 0) {
      this.showWarning(
        mode === 'merged'
          ? 'Nothing deleted — remaining branches are unmerged. Choose “All except current” to force-delete them.'
          : `Could not delete ${skipped.length} branch${skipped.length === 1 ? '' : 'es'}.`,
      );
      return;
    }

    const parts = [`Deleted ${deleted} local branch${deleted === 1 ? '' : 'es'}`];
    if (skipped.length > 0) {
      parts.push(
        mode === 'merged'
          ? `skipped ${skipped.length} unmerged`
          : `failed ${skipped.length}`,
      );
    }
    this.showToast(parts.join(' · '), { kind: 'success' });
  }

  async lockBranch(name: string, reason?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !name.trim()) return;
    try {
      const result = await this.tauri.lockBranch(path, name.trim(), reason?.trim() || undefined);
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  async unlockBranch(name: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !name.trim()) return;
    try {
      const result = await this.tauri.unlockBranch(path, name.trim());
      await this.refreshRepo();
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    }
  }

  isBranchLocked(name: string): boolean {
    return this.localBranches().some((b) => b.name === name && b.locked);
  }

  async refreshIdentity(): Promise<void> {
    try {
      this.identity.set(await this.tauri.getGitIdentity(this.currentRepo()?.path ?? null));
    } catch {
      this.identity.set(null);
    }
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase().replace(/^<|>$/g, '');
}

function isBrowseTab(value: unknown): value is BrowseTab {
  return (
    value === 'commit' ||
    value === 'diff' ||
    value === 'files' ||
    value === 'blame' ||
    value === 'history' ||
    value === 'reflog' ||
    value === 'console'
  );
}

function isAppView(value: unknown): value is AppView {
  return (
    value === 'dashboard' ||
    value === 'browse' ||
    value === 'onboarding' ||
    value === 'settings' ||
    value === 'prs' ||
    value === 'jira' ||
    value === 'profiles' ||
    value === 'automation' ||
    value === 'templates'
  );
}

function normalizePullAction(value: unknown): AppSettings['defaultPullAction'] {
  if (value === 'rebase' || value === 'fetch' || value === 'merge') return value;
  return 'merge';
}

function normalizePushAction(value: unknown): AppSettings['defaultPushAction'] {
  if (value === 'current' || value === 'matching' || value === 'upstream') return value;
  return 'upstream';
}

function buildCompareUrl(
  remoteUrl: string,
  branch: string,
  upstreamBranch: string | null,
): string | null {
  const parsed = parseRemoteWebBase(remoteUrl);
  if (!parsed || !branch.trim()) return null;
  const head = encodeURIComponent(branch.trim());
  if (parsed.host.includes('gitlab')) {
    const params = new URLSearchParams();
    params.set('merge_request[source_branch]', branch.trim());
    if (upstreamBranch) {
      params.set('merge_request[target_branch]', upstreamBranch);
    }
    return `${parsed.webBase}/-/merge_requests/new?${params.toString()}`;
  }
  if (parsed.host.includes('dev.azure.com') || parsed.host.includes('visualstudio.com')) {
    return `${parsed.webBase}/pullrequestcreate?sourceRef=${head}`;
  }
  const base = encodeURIComponent(upstreamBranch || 'main');
  return `${parsed.webBase}/compare/${base}...${head}?expand=1`;
}

function parseRemoteWebBase(
  remoteUrl: string,
): { host: string; webBase: string } | null {
  const raw = remoteUrl.trim();
  if (!raw) return null;

  let host = '';
  let path = '';

  const ssh = raw.match(/^git@([^:]+):(.+)$/i);
  if (ssh) {
    host = ssh[1].toLowerCase();
    path = ssh[2];
  } else {
    try {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
      const url = new URL(withScheme);
      host = url.host.toLowerCase();
      path = url.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  path = path.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !path) return null;
  return { host, webBase: `https://${host}/${path}` };
}

function defaultConnections(): AppSettings['connections'] {
  return [
    {
      id: 'github',
      provider: 'github',
      label: 'GitHub',
      enabled: false,
      baseUrl: 'https://api.github.com',
      username: '',
      token: '',
      organization: '',
      project: '',
    },
    {
      id: 'gitlab',
      provider: 'gitlab',
      label: 'GitLab',
      enabled: false,
      baseUrl: 'https://gitlab.com',
      username: '',
      token: '',
      organization: '',
      project: '',
    },
    {
      id: 'azureDevOps',
      provider: 'azureDevOps',
      label: 'Azure DevOps',
      enabled: false,
      baseUrl: 'https://dev.azure.com',
      username: '',
      token: '',
      organization: '',
      project: '',
    },
    {
      id: 'jira',
      provider: 'jira',
      label: 'Jira',
      enabled: false,
      baseUrl: 'https://your-domain.atlassian.net',
      username: '',
      token: '',
      organization: '',
      project: '',
    },
  ];
}

export const DEFAULT_BRANCH_PREFIXES = ['feature', 'bugfix', 'hotfix', 'chore', 'release'];

function normalizeBranchPrefixes(raw: unknown, selected?: string): string[] {
  const fromList = Array.isArray(raw)
    ? raw
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim().replace(/^\/+|\/+$/g, ''))
        .filter(Boolean)
    : [];
  const selectedClean = (selected ?? '').trim().replace(/^\/+|\/+$/g, '');
  const merged = [...fromList];
  if (selectedClean && !merged.includes(selectedClean)) {
    merged.unshift(selectedClean);
  }
  if (merged.length === 0) {
    return DEFAULT_BRANCH_PREFIXES.slice();
  }
  return [...new Set(merged)];
}

function normalizeSettings(raw: Partial<AppSettings> | AppSettings): AppSettings {
  const base = defaultConnections();
  const incoming = Array.isArray(raw.connections) ? raw.connections : [];
  const connections =
    incoming.length === 0
      ? base
      : base.map((def) => {
          const found = incoming.find((c) => c.provider === def.provider || c.id === def.id);
          return found
            ? {
                ...def,
                ...found,
                organization: found.organization ?? '',
                project: found.project ?? '',
              }
            : def;
        });

  return {
    theme: raw.theme || 'system',
    accent: raw.accent || '#0EA5E9',
    simpleMode: raw.simpleMode ?? true,
    layout: raw.layout ?? {},
    focusMode: raw.focusMode ?? true,
    defaultPullAction: normalizePullAction(raw.defaultPullAction),
    defaultPushAction: normalizePushAction(raw.defaultPushAction),
    autoFetchOnOpen: raw.autoFetchOnOpen ?? false,
    confirmForcePush: raw.confirmForcePush ?? true,
    confirmDiscard: raw.confirmDiscard ?? true,
    confirmPushNewBranch: raw.confirmPushNewBranch ?? true,
    confirmAddTrackingRef: raw.confirmAddTrackingRef ?? true,
    confirmAmend: raw.confirmAmend ?? true,
    confirmUndoLastCommit: raw.confirmUndoLastCommit ?? true,
    confirmStashDrop: raw.confirmStashDrop ?? true,
    confirmAbortOperation: raw.confirmAbortOperation ?? true,
    confirmAbortSecond: raw.confirmAbortSecond ?? true,
    confirmRemoveRemote: raw.confirmRemoveRemote ?? true,
    signOffByDefault: raw.signOffByDefault ?? false,
    pushAfterCommit: raw.pushAfterCommit ?? false,
    myBranchesOnly: raw.myBranchesOnly ?? false,
    branchPrefixEnabled: raw.branchPrefixEnabled ?? true,
    branchPrefix: (raw.branchPrefix ?? 'feature').trim() || 'feature',
    branchPrefixes: normalizeBranchPrefixes(raw.branchPrefixes, raw.branchPrefix),
    preferredEditor: normalizePreferredEditor(raw.preferredEditor),
    editorCommand: raw.editorCommand ?? '',
    diffTool: raw.diffTool ?? '',
    mergeTool: raw.mergeTool ?? '',
    sshClient: raw.sshClient || 'openssh',
    connections,
    commitTypes: normalizeCommitTypes(raw.commitTypes),
    githubOAuthClientId: (raw.githubOAuthClientId ?? '').trim(),
    notificationsEnabled: raw.notificationsEnabled ?? true,
    notifyToasts: raw.notifyToasts ?? true,
    notifyDesktop: raw.notifyDesktop ?? true,
    notifyGitFetch: raw.notifyGitFetch ?? false,
    notifyGitPull: raw.notifyGitPull ?? true,
    notifyGitPush: raw.notifyGitPush ?? true,
    notifyGitCommit: raw.notifyGitCommit ?? true,
    notifyGitConflicts: raw.notifyGitConflicts ?? true,
    notifyRemoteBehind: raw.notifyRemoteBehind ?? true,
    notifyAppUpdates: raw.notifyAppUpdates ?? true,
    notifyPrActivity: raw.notifyPrActivity ?? true,
    notifyPrCi: raw.notifyPrCi ?? true,
  };
}

function normalizePreferredEditor(raw: unknown): PreferredEditor {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (
    value === 'auto' ||
    value === 'cursor' ||
    value === 'vscode' ||
    value === 'system' ||
    value === 'command'
  ) {
    return value;
  }
  return 'auto';
}

function sameRepoPath(a: string, b: string): boolean {
  const norm = (p: string) =>
    p
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}
