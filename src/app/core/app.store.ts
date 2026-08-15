import { Injectable, computed, inject, signal } from '@angular/core';
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
  MockPullRequest,
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
  SearchHit,
  SubmoduleInfo,
  LfsFileInfo,
  ConflictSidesOutput,
  ReleaseActivity,
  ReleaseActivityStep,
  ReleasePhase,
  PollReleaseDeployOutput,
  ReleaseProgressEvent,
  ReleaseSetupFileHint,
  TagInfo,
  TemplateInfo,
  SavedPrTemplate,
  PrCreateMethod,
  UiSession,
  RevisionGridColumns,
  WorktreeInfo,
  RepoCheck,
  RepoChecksOutput,
  CheckRunState,
  ProbeRemoteOutput,
  GithubGitStatus,
  GithubRepoAccountPref,
  TestConnectionInput,
  TestConnectionOutput,
} from './models';
import { TauriService } from './tauri.service';
import { DiagnosticsService } from './diagnostics.service';
import { NotificationService } from './notification.service';
import { PromptService } from '../shared/ui/prompt-dialog/prompt.service';
import { SelectService } from '../shared/ui/select-dialog/select.service';
import { ReleaseDialogService } from '../features/release/release-dialog/release-dialog.service';
import { ChangelogService } from '../features/changelog/changelog.service';
import { DEFAULT_COMMIT_TYPES, normalizeCommitTypes } from './commit-types';
import {
  DEFAULT_TICKET_FROM_BRANCH,
  normalizeTicketFromBranch,
} from '../shared/git/ticket-from-branch';
import { normalizeCommitShortcutSequence } from '../shared/git/commit-shortcuts';
import {
  openPathsInPreferredEditor,
  preferredEditorLabel,
} from '../shared/git/open-in-editor';
import { runConfiguredGitTool } from '../shared/git/git-tools';
import { parseRemoteRef } from '../shared/git/remote-ref';
import { parseRemoteWebBase, primaryGithubOwner, remoteProtocol } from '../shared/git/repo-links';
import {
  humanizeGitError,
  isRemoteAccessError,
  rawErrorMessage,
} from '../shared/git/git-error';
import { summarizeGitToastMessage } from '../shared/git/git-toast';
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

export type BrowseTab =
  | 'commit'
  | 'diff'
  | 'files'
  | 'blame'
  | 'history'
  | 'reflog'
  | 'console';
export type AppView =
  | 'dashboard'
  | 'browse'
  | 'onboarding'
  | 'settings'
  | 'prs'
  | 'jira'
  | 'profiles'
  | 'release'
  | 'automation'
  | 'templates';
export type SettingsSection =
  | 'repos'
  | 'appearance'
  | 'git'
  | 'notifications'
  | 'connections'
  | 'about';

const SETTINGS_SECTIONS: SettingsSection[] = [
  'repos',
  'appearance',
  'git',
  'notifications',
  'connections',
  'about',
];

export function normalizeSettingsSection(raw: unknown): SettingsSection {
  if (raw === 'ssh') return 'connections';
  if (raw === 'tools') return 'git';
  if (typeof raw === 'string' && SETTINGS_SECTIONS.includes(raw as SettingsSection)) {
    return raw as SettingsSection;
  }
  return 'repos';
}

export type AutomationFilter = 'all' | 'custom' | 'builtin';
export type AutomationSection = 'workflows' | 'checks';
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
  | 'prCi'
  | 'release';
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

const RELEASE_ACTIVITY_STORAGE_KEY = 'branchline.releaseActivity';
const RELEASE_DISMISSED_TAG_KEY = 'branchline.releaseDismissedTag';
const RELEASE_NOTES_DRAFT_KEY = 'branchline.releaseNotesDraft';
const REPO_CACHE_KEY = 'branchline.repoCache.v1';

interface ReleaseNotesDraft {
  path: string;
  body: string;
}

interface RepoCacheEntry {
  savedAt: number;
  status: RepoStatus;
  commits?: CommitInfo[];
  branches?: BranchInfo[];
  artificial?: ArtificialCommit[];
  stashes?: StashEntry[];
  tags?: TagInfo[];
  remotes?: RemoteInfo[];
}

interface RepoWorkingSnapshot {
  savedAt: number;
  status: RepoStatus | null;
  commits: CommitInfo[];
  artificial: ArtificialCommit[];
  branches: BranchInfo[];
  stashes: StashEntry[];
  tags: TagInfo[];
  remotes: RemoteInfo[];
  worktrees: WorktreeInfo[];
  submodules: SubmoduleInfo[];
  lfsFiles: LfsFileInfo[];
  selectedSha: string | null;
  selectedShas: string[];
  compareSha: string | null;
  diffSource: 'commit' | 'workingDirectory' | 'staged';
  selectedDiffPath: string | null;
  fileHistoryPath: string | null;
  identity: GitIdentity | null;
}

@Injectable({ providedIn: 'root' })
export class AppStore {
  private readonly tauri = inject(TauriService);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly notifications = inject(NotificationService);
  private readonly prompts = inject(PromptService);
  private readonly selects = inject(SelectService);
  private readonly releaseDialog = inject(ReleaseDialogService);
  private readonly changelog = inject(ChangelogService);

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
  readonly repoChecks = signal<RepoChecksOutput | null>(null);
  readonly checkRuns = signal<Record<string, CheckRunState>>({});
  readonly worktrees = signal<WorktreeInfo[]>([]);
  readonly submodules = signal<SubmoduleInfo[]>([]);
  readonly lfsFiles = signal<LfsFileInfo[]>([]);
  readonly conflictResolverOpen = signal(false);
  readonly conflictResolverPath = signal<string | null>(null);
  readonly conflictResolver = signal<ConflictSidesOutput | null>(null);
  readonly conflictResolverDraft = signal('');
  readonly conflictIdeBusy = signal(false);
  readonly conflictIdeLabel = signal<string | null>(null);
  private conflictFocusBound = false;
  private conflictSyncInFlight = false;
  private conflictAutoStageInFlight = false;
  readonly selectedSha = signal<string | null>(null);
  readonly selectedShas = signal<string[]>([]);
  readonly compareSha = signal<string | null>(null);
  readonly graphReveal = signal<{ sha: string; nonce: number } | null>(null);
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
    pushAfterCommit: true,
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
    ticketFromBranch: { ...DEFAULT_TICKET_FROM_BRANCH },
    commitShortcutSequence: [],
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
    notifyRelease: true,
    hideUntracked: false,
    uiDensity: 'comfortable',
    prTemplates: [],
    prCreateMethod: 'browser',
    githubRepoAccounts: {},
  });
  readonly hiddenRefsGroups = computed((): string[] => {
    const raw = this.settings().layout?.['hiddenRefsGroups'];
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === 'string' && id.length > 0);
  });
  readonly detectedEditors = signal<DetectedEditors | null>(null);
  readonly loading = signal(false);
  readonly loadingLabel = signal('Loading…');
  readonly nextAction = signal('Open a repository');
  readonly safety = signal<SafetyAnalysis | null>(null);
  readonly toast = signal<ToastState | null>(null);
  private toastTimer: number | null = null;
  private toastSeq = 0;
  readonly refreshingRepo = signal(false);
  readonly syncingRepo = signal(false);
  readonly remoteBusy = signal<'fetch' | 'pull' | 'push' | null>(null);
  readonly actionBusy = signal<string | null>(null);
  readonly busyMessage = computed(() => {
    if (this.loading()) return this.loadingLabel();
    return null;
  });
  readonly releaseBusy = signal(false);
  readonly releaseAttaching = signal(false);
  readonly releaseActivity = signal<ReleaseActivity | null>(null);
  readonly visibleReleaseActivity = computed(() => {
    const activity = this.releaseActivity();
    const path = this.currentRepo()?.path;
    if (!activity || !path || !sameRepoPath(activity.path, path)) return null;
    return activity;
  });
  readonly releaseNotesDraft = signal<ReleaseNotesDraft | null>(null);
  readonly releaseNotesBusy = signal(false);
  readonly releaseNotesGenerating = signal(false);
  readonly releaseNotesText = computed(() => {
    const activity = this.releaseActivity();
    if (activity) return activity.notes ?? '';
    const draft = this.releaseNotesDraft();
    const path = this.currentRepo()?.path;
    if (draft && path && sameRepoPath(draft.path, path)) return draft.body;
    return '';
  });
  readonly releaseNotesCanPublish = computed(() => {
    const activity = this.releaseActivity();
    return !!activity?.tag && (!!activity.releaseUrl || this.hasGithubConnection());
  });
  readonly releaseNotesSynced = computed(() => !!this.releaseActivity()?.notesSynced);
  private releaseAttachInFlight: Promise<boolean> | null = null;
  private releaseAttachPath: string | null = null;
  readonly releasingLocally = computed(() => {
    if (!this.releaseBusy()) return false;
    const phase = this.releaseActivity()?.phase;
    return (
      phase === 'preparing' ||
      phase === 'bumping' ||
      phase === 'staging' ||
      phase === 'committing' ||
      phase === 'tagging' ||
      phase === 'pushing'
    );
  });
  private releaseProgressUnlisten: UnlistenFn | null = null;
  private releaseDeployPollTimer: number | null = null;
  private persistReleaseTimer: number | null = null;
  private lastReleaseFingerprint = '';
  private lastReleaseNoticeKey = '';
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
  readonly shortcutOverlayOpen = signal(false);
  readonly fileSearchOpen = signal(false);
  readonly commitLogLimit = signal(1000);
  readonly commitLogHasMore = signal(false);
  readonly loadingMoreCommits = signal(false);
  readonly cloneDialogOpen = signal(false);
  readonly cloneDialogUrl = signal('');
  readonly hostRepos = signal<HostRepository[]>([]);
  readonly hostReposLoading = signal(false);
  readonly hostReposError = signal<string | null>(null);
  readonly repoWebUrls = signal<Record<string, string | null>>({});
  private hostReposFetchedAt = 0;
  private static readonly HOST_REPOS_TTL_MS = 5 * 60 * 1000;
  readonly createBranchDialogOpen = signal(false);
  readonly createPrDialogOpen = signal(false);
  readonly createPrPreferredHead = signal<string | null>(null);
  readonly publishGithubDialogOpen = signal(false);
  readonly githubDeviceLoginOpen = signal(false);
  readonly remoteTroubleshootOpen = signal(false);
  readonly remoteTroubleshootError = signal('');
  readonly githubGitStatus = signal<GithubGitStatus | null>(null);
  readonly githubGitBusy = signal(false);
  private githubGitStatusAt = 0;
  private static readonly GITHUB_GIT_STATUS_TTL_MS = 30_000;
  private readonly repoWebUrlInflight = new Map<string, Promise<string | null>>();
  readonly pendingRefsReveal = signal<string | null>(null);
  readonly createBranchStartPoint = signal<string | null>(null);
  readonly createBranchSuggestedName = signal('');
  readonly activeJiraKey = signal<string | null>(null);
  readonly jiraIssues = signal<JiraIssue[]>([]);
  readonly jiraIssuesLoading = signal(false);
  readonly jiraIssuesError = signal<string | null>(null);
  readonly pullRequests = signal<MockPullRequest[]>([]);
  readonly pullRequestsLoading = signal(false);
  readonly pullRequestsRefreshing = signal(false);
  readonly pullRequestsError = signal<string | null>(null);
  private pullRequestsKey = '';
  private pullRequestsGen = 0;
  private pullRequestsInflight: Promise<void> | null = null;
  private pullRequestsInflightKey = '';
  private readonly pullRequestCache = new Map<string, { list: MockPullRequest[]; at: number }>();
  private static readonly PRS_TTL_MS = 90_000;
  readonly selectedDiffPath = signal<string | null>(null);
  readonly fileHistoryPath = signal<string | null>(null);
  readonly automationFilter = signal<AutomationFilter>('all');
  readonly automationSection = signal<AutomationSection>('workflows');
  readonly splitMain = signal<number[]>([16, 84]);
  readonly splitNested = signal<number[]>([62, 38]);
  readonly revisionGridColumns = signal<RevisionGridColumns>({
    author: 120,
    date: 128,
    sha: 80,
  });
  private sessionSaveTimer: number | null = null;
  private sessionOverlay: UiSession = {};
  private restoringSession = false;
  private repoCacheTimer: number | null = null;
  private lastRepoCacheFp = '';
  private repoDiskCache: Record<string, RepoCacheEntry> | null = null;
  private repoLoadGen = 0;
  private readonly repoSnapshots = new Map<string, RepoWorkingSnapshot>();
  private static readonly SNAPSHOT_MAX = 12;
  private repoFsUnlisten: UnlistenFn | null = null;
  private repoFsRefreshTimer: number | null = null;
  private mutationDepth = 0;
  private refreshQueued = false;
  private refreshInFlight: Promise<void> | null = null;
  private workingTreeRefreshQueued = false;
  private workingTreeRefreshInFlight: Promise<void> | null = null;
  private lastWorkingTreeRefreshAt = 0;
  private worktreePollTimer: number | null = null;
  private worktreeFocusBound = false;
  private conflictDraftDirty = false;

  readonly commitBySha = computed(() => {
    const map = new Map<string, CommitInfo>();
    for (const c of this.commits()) {
      map.set(c.sha, c);
      map.set(c.shortSha, c);
    }
    return map;
  });

  readonly selectedCommit = computed(() => {
    const sha = this.selectedSha();
    if (!sha) return null;
    return this.commitBySha().get(sha) ?? null;
  });

  readonly changeCount = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length;
  });

  readonly hasActiveOperation = computed(() => !!this.status()?.operation);

  readonly operationNeedsContinue = computed(() => {
    const s = this.status();
    return !!s?.operation && (s.conflicted.length === 0);
  });

  readonly showConflictBanner = computed(() => {
    const s = this.status();
    if (!s) return false;
    return s.conflicted.length > 0 || !!s.operation;
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
    if (this.view() === view) return;
    if (this.view() === 'release' && view !== 'release') {
      this.pauseBackgroundReleaseWork();
    }
    this.view.set(view);
    if (view !== 'onboarding' && !this.restoringSession) {
      this.patchSession({ view });
    }
  }

  openSettings(section: SettingsSection = 'repos', connectionId?: string): void {
    this.settingsSection.set(normalizeSettingsSection(section));
    this.settingsFocusConnectionId.set(connectionId ?? null);
    if (this.view() === 'release') this.pauseBackgroundReleaseWork();
    this.view.set('settings');
    if (!this.restoringSession) {
      this.patchSession({ view: 'settings' });
    }
  }

  goHome(): void {
    this.openSettings('repos');
  }

  setSettingsSection(section: SettingsSection): void {
    this.settingsSection.set(normalizeSettingsSection(section));
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
        this.clearPullRequestCache();
      }
      this.showSuccess('Disconnected');
    } catch (err) {
      this.showError(err);
    }
  }

  setBrowseTab(tab: BrowseTab): void {
    if (this.browseTab() === tab) return;
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

  setAutomationSection(section: AutomationSection): void {
    this.automationSection.set(section);
    this.setView('automation');
  }

  setSplitSizes(kind: 'main' | 'nested', sizes: number[]): void {
    if (!sizes.length) return;
    if (kind === 'main') this.splitMain.set([...sizes]);
    else this.splitNested.set([...sizes]);
    if (!this.restoringSession) {
      this.patchSession(kind === 'main' ? { splitMain: [...sizes] } : { splitNested: [...sizes] });
    }
  }

  setRevisionGridColumns(cols: RevisionGridColumns, opts?: { persist?: boolean }): void {
    const next = normalizeRevisionGridColumns(cols);
    this.revisionGridColumns.set(next);
    if (opts?.persist === false || this.restoringSession) return;
    this.patchSession({ revisionGridColumns: next });
  }

  readSession(): UiSession {
    const layout = this.settings().layout ?? {};
    const raw = layout['session'];
    const base = raw && typeof raw === 'object' ? (raw as UiSession) : {};
    return { ...base, ...this.sessionOverlay };
  }

  patchSession(partial: Partial<UiSession>, opts?: { flush?: boolean }): void {
    this.sessionOverlay = { ...this.readSession(), ...partial };
    if (this.sessionSaveTimer !== null) {
      window.clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    if (opts?.flush) {
      this.persistSessionToDisk();
      return;
    }
    this.sessionSaveTimer = window.setTimeout(() => {
      this.sessionSaveTimer = null;
      this.persistSessionToDisk();
    }, 400);
  }

  private settingsWithSession(): AppSettings {
    const current = this.settings();
    return {
      ...current,
      layout: { ...(current.layout ?? {}), session: this.readSession() },
    };
  }

  private persistSessionToDisk(): void {
    void this.tauri.saveSettings(this.settingsWithSession()).catch(() => {
      /* ignore background session save failures */
    });
  }

  private flushSession(): void {
    if (this.sessionSaveTimer !== null) {
      window.clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    this.persistSessionToDisk();
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
      if (session.revisionGridColumns) {
        this.revisionGridColumns.set(normalizeRevisionGridColumns(session.revisionGridColumns));
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
      (view === 'automation' || view === 'templates' || view === 'profiles') &&
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
      const settings = normalizeSettings(await this.tauri.getSettings());
      this.settings.set(settings);
      await this.migratePushAfterCommitDefault();
      this.myBranchesOnly.set(this.settings().myBranchesOnly);
      this.applyTheme(this.settings());
      void this.refreshDetectedEditors();
      const session = this.readSession();
      this.applySession(session);
      if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => this.flushSession());
        window.addEventListener('pagehide', () => this.flushSession());
        this.bindConflictFocusWatch();
        this.bindWorktreeFocusWatch();
      }
      void this.bindRepoFsWatcher();
      void this.bindReleaseProgressListener();
      this.restoreReleaseActivity();
      this.restoreReleaseNotesDraft();
      this.startWorktreePoll();
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
        this.openRepos.set(pathsToOpen.map((path) => this.repoTabStub(path)));
        const toActivate =
          (activePath && pathsToOpen.some((p) => sameRepoPath(p, activePath))
            ? activePath
            : null) ||
          pathsToOpen[pathsToOpen.length - 1] ||
          null;
        if (toActivate) {
          await this.openRepo(toActivate, { restoreView: false });
        }
        hasRepo = !!this.currentRepo() || this.openRepos().length > 0;
        if (!this.currentRepo() && this.openRepos().length) {
          await this.openRepo(this.openRepos()[this.openRepos().length - 1].path, {
            restoreView: false,
          });
          hasRepo = !!this.currentRepo();
        }
        void this.refreshInactiveRepoSummaries();
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

  hasGithubConnection(): boolean {
    return this.settings().connections.some(
      (c) => c.provider === 'github' && c.enabled && (c.hasToken || c.token.trim()),
    );
  }

  async refreshPullRequests(
    state: 'open' | 'closed' | 'all' = 'open',
    opts?: { force?: boolean },
  ): Promise<void> {
    const path = this.currentRepo()?.path ?? '';
    const dummy = this.isDummyBackend && !this.hasLinkedPrHost();
    const github = this.hasGithubConnection();
    const key = dummy ? `dummy|${state}` : github ? `${path}|${state}` : `none|${path}|${state}`;
    const cached = this.pullRequestCache.get(key);
    const now = Date.now();
    const fresh = !!cached && !opts?.force && now - cached.at < AppStore.PRS_TTL_MS;

    if (cached) {
      this.pullRequests.set(cached.list);
      this.pullRequestsError.set(null);
      this.pullRequestsKey = key;
    } else if (this.pullRequestsKey !== key) {
      this.pullRequests.set([]);
      this.pullRequestsError.set(null);
    }

    if (fresh) return;

    if (
      !opts?.force &&
      this.pullRequestsInflight &&
      this.pullRequestsInflightKey === key
    ) {
      if (!cached) this.pullRequestsLoading.set(true);
      await this.pullRequestsInflight;
      return;
    }

    if (!dummy && !github) {
      this.pullRequests.set([]);
      this.pullRequestCache.set(key, { list: [], at: now });
      this.pullRequestsKey = key;
      this.pullRequestsLoading.set(false);
      this.pullRequestsRefreshing.set(false);
      return;
    }

    const gen = ++this.pullRequestsGen;
    const showExisting =
      (cached?.list.length ?? 0) > 0 ||
      (this.pullRequestsKey === key && this.pullRequests().length > 0);
    if (showExisting) this.pullRequestsRefreshing.set(true);
    else this.pullRequestsLoading.set(true);

    const run = (async () => {
      try {
        let list: MockPullRequest[];
        if (dummy) {
          list = await this.tauri.listMockPullRequests();
        } else {
          if (!path) {
            throw new Error('Open a repository with a GitHub remote to load pull requests.');
          }
          list = await this.tauri.listPullRequests(path, state);
        }
        if (gen !== this.pullRequestsGen) return;
        this.pullRequestCache.set(key, { list, at: Date.now() });
        this.pullRequests.set(list);
        this.pullRequestsKey = key;
        this.pullRequestsError.set(null);
      } catch (err) {
        if (gen !== this.pullRequestsGen) return;
        if (!cached) {
          this.pullRequests.set([]);
          this.pullRequestsKey = key;
        }
        this.pullRequestsError.set(this.formatError(err));
      } finally {
        if (gen === this.pullRequestsGen) {
          this.pullRequestsLoading.set(false);
          this.pullRequestsRefreshing.set(false);
        }
      }
    })();

    this.pullRequestsInflight = run;
    this.pullRequestsInflightKey = key;
    try {
      await run;
    } finally {
      if (this.pullRequestsInflightKey === key) {
        this.pullRequestsInflight = null;
        this.pullRequestsInflightKey = '';
      }
    }
  }

  patchPullRequest(id: string, partial: Partial<MockPullRequest>): void {
    this.pullRequests.update((list) =>
      list.map((p) => (p.id === id ? { ...p, ...partial } : p)),
    );
    const cached = this.pullRequestCache.get(this.pullRequestsKey);
    if (cached) {
      this.pullRequestCache.set(this.pullRequestsKey, {
        list: this.pullRequests(),
        at: cached.at,
      });
    }
  }

  private clearPullRequestCache(): void {
    this.pullRequestCache.clear();
    this.pullRequests.set([]);
    this.pullRequestsKey = '';
    this.pullRequestsError.set(null);
    this.pullRequestsLoading.set(false);
    this.pullRequestsRefreshing.set(false);
    this.pullRequestsGen += 1;
    this.pullRequestsInflight = null;
    this.pullRequestsInflightKey = '';
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
    root.setAttribute('data-density', settings.uiDensity === 'compact' ? 'compact' : 'comfortable');
    root.style.setProperty('--accent', settings.accent);
    try {
      localStorage.setItem('branchline.theme', preference);
      localStorage.setItem('branchline.accent', settings.accent);
      localStorage.setItem('branchline.density', settings.uiDensity);
    } catch {
      /* ignore quota / private mode */
    }
  }

  formatError(err: unknown): string {
    return this.humanizeError(rawErrorMessage(err) || err);
  }

  private humanizeError(message: unknown): string {
    if (typeof message !== 'string') {
      return humanizeGitError(rawErrorMessage(message));
    }
    return humanizeGitError(message);
  }

  private statusFetchOpts(): { hideUntracked?: boolean } {
    return { hideUntracked: this.settings().hideUntracked };
  }

  private hydrateRepoCache(path: string): boolean {
    try {
      const all = this.readRepoDiskCache();
      const entry = all[normalizeCachePath(path)];
      if (!entry?.status) return false;
      if (Date.now() - (entry.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) return false;
      this.status.set(entry.status);
      this.commits.set(entry.commits ?? []);
      this.branches.set(entry.branches ?? []);
      this.artificial.set(entry.artificial ?? artificialFromStatus(entry.status));
      this.stashes.set(entry.stashes ?? []);
      this.tags.set(entry.tags ?? []);
      this.remotes.set(entry.remotes ?? []);
      this.worktrees.set([]);
      this.submodules.set([]);
      this.lfsFiles.set([]);
      this.identity.set(null);
      this.updateNextAction(entry.status);
      const head = entry.commits?.[0]?.sha ?? null;
      this.selectedSha.set(head);
      this.selectedShas.set(head ? [head] : []);
      this.compareSha.set(null);
      this.diffSource.set('commit');
      this.selectedDiffPath.set(null);
      this.fileHistoryPath.set(null);
      return true;
    } catch {
      return false;
    }
  }

  private readRepoDiskCache(): Record<string, RepoCacheEntry> {
    if (this.repoDiskCache) return this.repoDiskCache;
    try {
      const raw = localStorage.getItem(REPO_CACHE_KEY);
      this.repoDiskCache = raw ? (JSON.parse(raw) as Record<string, RepoCacheEntry>) : {};
    } catch {
      this.repoDiskCache = {};
    }
    return this.repoDiskCache ?? {};
  }

  private persistRepoCache(path: string): void {
    if (this.repoCacheTimer !== null) window.clearTimeout(this.repoCacheTimer);
    this.repoCacheTimer = window.setTimeout(() => {
      this.repoCacheTimer = null;
      this.writeRepoCache(path);
    }, 1800);
  }

  private writeRepoCache(path: string): void {
    try {
      const current = this.currentRepo()?.path;
      if (!current || !sameRepoPath(current, path)) return;
      const status = this.status();
      if (!status) return;
      const commits = this.commits();
      const branches = this.branches();
      const fp = `${normalizeCachePath(path)}:${commitsFingerprint(commits)}:${branchesFingerprint(branches)}:${statusFingerprint(status)}`;
      if (fp === this.lastRepoCacheFp) return;
      this.lastRepoCacheFp = fp;
      const all = this.readRepoDiskCache();
      const locals = branches.filter((b) => !b.isRemote);
      const remotes = branches.filter((b) => b.isRemote).slice(0, 80);
      all[normalizeCachePath(path)] = {
        savedAt: Date.now(),
        status: {
          ...status,
          staged: status.staged.slice(0, 400),
          unstaged: status.unstaged.slice(0, 400),
          untracked: status.untracked.slice(0, 200),
          conflicted: status.conflicted.slice(0, 200),
        },
        commits: commits.slice(0, 200),
        branches: [...locals, ...remotes],
        artificial: this.artificial(),
        stashes: this.stashes().slice(0, 30),
        tags: this.tags().slice(0, 80),
        remotes: this.remotes(),
      };
      const keys = Object.keys(all);
      if (keys.length > 12) {
        keys
          .sort((a, b) => (all[a].savedAt || 0) - (all[b].savedAt || 0))
          .slice(0, keys.length - 12)
          .forEach((k) => delete all[k]);
      }
      localStorage.setItem(REPO_CACHE_KEY, JSON.stringify(all));
    } catch {
      /* ignore quota */
    }
  }

  private repoLoadStale(gen: number, path?: string): boolean {
    if (gen !== this.repoLoadGen) return true;
    if (!path) return false;
    const current = this.currentRepo()?.path;
    return !current || !sameRepoPath(current, path);
  }

  private yieldToPaint(): Promise<void> {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        window.setTimeout(() => resolve(), 0);
      });
    });
  }

  private repoTabStub(path: string): RepoSummary {
    const existing = this.openRepos().find((r) => sameRepoPath(r.path, path));
    if (existing) return existing;
    const recent = this.repos().find((r) => sameRepoPath(r.path, path));
    const name =
      recent?.name ||
      path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ||
      path;
    return {
      path,
      name,
      branch: '',
      ahead: 0,
      behind: 0,
      hasChanges: false,
    };
  }

  private mergeFocusedSummary(summary: RepoSummary): RepoSummary {
    const existing = this.openRepos().find((r) => sameRepoPath(r.path, summary.path));
    if (!existing) return summary;
    return {
      ...summary,
      ahead: existing.ahead,
      behind: existing.behind,
      hasChanges: existing.hasChanges,
      branch: summary.branch || existing.branch,
    };
  }

  private snapshotCurrentRepo(): void {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!this.status() && this.commits().length === 0) return;
    this.repoSnapshots.set(normalizeCachePath(path), {
      savedAt: Date.now(),
      status: this.status(),
      commits: this.commits().slice(),
      artificial: this.artificial().slice(),
      branches: this.branches().slice(),
      stashes: this.stashes().slice(),
      tags: this.tags().slice(),
      remotes: this.remotes().slice(),
      worktrees: this.worktrees().slice(),
      submodules: this.submodules().slice(),
      lfsFiles: this.lfsFiles().slice(),
      selectedSha: this.selectedSha(),
      selectedShas: this.selectedShas().slice(),
      compareSha: this.compareSha(),
      diffSource: this.diffSource(),
      selectedDiffPath: this.selectedDiffPath(),
      fileHistoryPath: this.fileHistoryPath(),
      identity: this.identity(),
    });
    this.pruneRepoSnapshots();
  }

  private restoreRepoSnapshot(path: string): boolean {
    const snap = this.repoSnapshots.get(normalizeCachePath(path));
    if (!snap) return false;
    this.status.set(snap.status);
    this.commits.set(snap.commits);
    this.artificial.set(snap.artificial);
    this.branches.set(snap.branches);
    this.stashes.set(snap.stashes);
    this.tags.set(snap.tags);
    this.remotes.set(snap.remotes);
    this.worktrees.set(snap.worktrees);
    this.submodules.set(snap.submodules);
    this.lfsFiles.set(snap.lfsFiles);
    this.selectedSha.set(snap.selectedSha);
    this.selectedShas.set(snap.selectedShas);
    this.compareSha.set(snap.compareSha);
    this.diffSource.set(snap.diffSource);
    this.selectedDiffPath.set(snap.selectedDiffPath);
    this.fileHistoryPath.set(snap.fileHistoryPath);
    this.identity.set(snap.identity);
    if (snap.status) this.updateNextAction(snap.status);
    return true;
  }

  private dropRepoSnapshot(path: string): void {
    this.repoSnapshots.delete(normalizeCachePath(path));
  }

  private pruneRepoSnapshots(): void {
    const open = new Set(this.openRepos().map((r) => normalizeCachePath(r.path)));
    const current = this.currentRepo()?.path;
    if (current) open.add(normalizeCachePath(current));
    for (const key of [...this.repoSnapshots.keys()]) {
      if (!open.has(key)) this.repoSnapshots.delete(key);
    }
    if (this.repoSnapshots.size <= AppStore.SNAPSHOT_MAX) return;
    const oldest = [...this.repoSnapshots.entries()]
      .sort((a, b) => a[1].savedAt - b[1].savedAt)
      .slice(0, this.repoSnapshots.size - AppStore.SNAPSHOT_MAX);
    for (const [key] of oldest) this.repoSnapshots.delete(key);
  }

  private async refreshInactiveRepoSummaries(): Promise<void> {
    const current = this.currentRepo()?.path;
    const inactive = this.openRepos().filter(
      (r) => !current || !sameRepoPath(r.path, current),
    );
    if (!inactive.length) return;
    const results = await Promise.allSettled(
      inactive.map((r) => this.tauri.peekRepository(r.path)),
    );
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      if (!this.openRepos().some((r) => sameRepoPath(r.path, result.value.path))) continue;
      this.upsertOpenRepo(result.value);
    }
    this.persistOpenRepos();
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
        this.upsertOpenRepo(this.repoTabStub(normalized));
        this.persistOpenRepos();
        const summary = await this.tauri.peekRepository(normalized);
        if (this.openRepos().some((r) => sameRepoPath(r.path, normalized))) {
          this.upsertOpenRepo(summary);
          this.persistOpenRepos();
        }
      } catch (err) {
        this.showError(err);
      }
      return;
    }

    if (this.currentRepo() && sameRepoPath(this.currentRepo()!.path, normalized)) {
      if (restoreView) this.setView('browse');
      else this.view.set('browse');
      return;
    }

    if (this.view() !== 'onboarding') {
      if (restoreView) this.setView('browse');
      else {
        if (this.view() === 'release') this.pauseBackgroundReleaseWork();
        this.view.set('browse');
      }
    }

    const alreadyOpen = this.openRepos().some((r) => sameRepoPath(r.path, normalized));
    const switching =
      alreadyOpen && !!this.currentRepo() && !sameRepoPath(this.currentRepo()!.path, normalized);
    const gen = ++this.repoLoadGen;

    const activity = this.releaseActivity();
    if (activity && !sameRepoPath(activity.path, normalized)) {
      this.pauseBackgroundReleaseWork();
    }

    this.snapshotCurrentRepo();
    this.graphReveal.set(null);

    const stub = this.mergeFocusedSummary(this.repoTabStub(normalized));
    this.currentRepo.set(stub);
    this.upsertOpenRepo(stub);

    await this.yieldToPaint();
    if (this.repoLoadStale(gen, normalized)) return;

    const summaryPromise = switching
      ? this.tauri.focusRepository(normalized).then((summary) => this.mergeFocusedSummary(summary))
      : this.tauri.openRepository(normalized);

    const hadLive = this.restoreRepoSnapshot(normalized) || this.hydrateRepoCache(normalized);
    if (!hadLive) {
      this.clearWorkingState();
      this.loadingLabel.set('Opening repository…');
      this.loading.set(true);
    } else {
      this.syncingRepo.set(true);
    }

    try {
      const summary = await summaryPromise;
      if (this.repoLoadStale(gen, normalized)) return;
      this.currentRepo.set(summary);
      this.upsertOpenRepo(summary);
      if (!switching) {
        this.repos.set(await this.tauri.listRecentRepos());
        if (this.repoLoadStale(gen, normalized)) return;
      }
      if (hadLive) {
        void this.applyGithubRepoAccount({ silent: true });
        void this.refreshRepo();
      } else {
        await this.refreshRepo();
        await this.applyGithubRepoAccount({ silent: true });
      }
      if (this.repoLoadStale(gen, normalized)) return;
      this.persistRepoCache(normalized);
      this.persistOpenRepos();
      if (!switching && (this.isDummyBackend || this.isDummyRepoPath(normalized))) {
        this.showWarning(
          'DUMMY DATA — browser preview. Open a real repo in the desktop app for live Git.',
        );
      }
      if (!switching && this.settings().autoFetchOnOpen && !this.isDummyBackend) {
        void this.runRemoteWithAccountRetry(() =>
          this.tauri.fetch(normalized, this.pushRemoteName()),
        ).then(
          () => {
            if (this.repoLoadStale(gen, normalized)) return;
            void this.refreshRepo();
          },
          (err) => this.showError(err),
        );
      }
      if (!switching && this.hasGithubConnection()) {
        void this.refreshPullRequests('open');
      }
      void this.loadRepoChecks({ toastNew: !switching });
    } catch (err) {
      this.showError(err);
      if (!this.openRepos().length) this.goHome();
    } finally {
      if (gen === this.repoLoadGen) {
        this.loading.set(false);
        if (!hadLive) this.syncingRepo.set(false);
      }
    }
  }

  async switchOpenRepo(path: string): Promise<void> {
    await this.openRepo(path);
  }

  async closeOpenRepo(path: string, showToast = true): Promise<void> {
    const tabs = this.openRepos().filter((r) => !sameRepoPath(r.path, path));
    const closingCurrent = !!this.currentRepo() && sameRepoPath(this.currentRepo()!.path, path);
    const name = this.openRepos().find((r) => sameRepoPath(r.path, path))?.name;
    this.dropRepoSnapshot(path);
    this.openRepos.set(tabs);
    this.pruneRepoSnapshots();
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

    this.repoSnapshots.clear();
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
    this.repoSnapshots.clear();
    this.clearWorkingState();
    this.currentRepo.set(null);
    this.openRepos.set([]);
    this.persistOpenRepos();
    this.goHome();
    this.nextAction.set('Open a repository');
  }

  private upsertOpenRepo(summary: RepoSummary): void {
    this.openRepos.update((tabs) => {
      const idx = tabs.findIndex((t) => sameRepoPath(t.path, summary.path));
      if (idx < 0) return [...tabs, summary];
      const next = tabs.slice();
      next[idx] = summary;
      return next;
    });
  }

  private setCommitsIfChanged(commits: CommitInfo[]): void {
    if (commitsFingerprint(this.commits()) === commitsFingerprint(commits)) return;
    this.commits.set(commits);
  }

  private setBranchesIfChanged(branches: BranchInfo[]): void {
    if (branchesFingerprint(this.branches()) === branchesFingerprint(branches)) return;
    this.branches.set(branches);
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
    this.repoChecks.set(null);
    this.checkRuns.set({});
    this.worktrees.set([]);
    this.submodules.set([]);
    this.lfsFiles.set([]);
    this.conflictResolverOpen.set(false);
    this.conflictResolverPath.set(null);
    this.conflictResolver.set(null);
    this.conflictResolverDraft.set('');
    this.conflictIdeBusy.set(false);
    this.conflictIdeLabel.set(null);
    this.selectedSha.set(null);
    this.selectedShas.set([]);
    this.compareSha.set(null);
    this.diffSource.set('commit');
    this.selectedDiffPath.set(null);
    this.fileHistoryPath.set(null);
    this.commitLogLimit.set(1000);
    this.commitLogHasMore.set(false);
    this.loadingMoreCommits.set(false);
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

  repoWebUrl(path: string): string | null {
    const value = this.repoWebUrls()[path];
    return value ?? null;
  }

  async ensureRepoWebUrl(path: string): Promise<string | null> {
    const cached = this.repoWebUrls()[path];
    if (cached !== undefined) return cached;
    const inflight = this.repoWebUrlInflight.get(path);
    if (inflight) return inflight;
    const run = this.loadRepoWebUrl(path).finally(() => {
      this.repoWebUrlInflight.delete(path);
    });
    this.repoWebUrlInflight.set(path, run);
    return run;
  }

  prefetchRepoWebUrls(paths: string[]): void {
    const missing = paths.filter(
      (path) => this.repoWebUrls()[path] === undefined && !this.repoWebUrlInflight.has(path),
    );
    if (!missing.length) return;
    const limit = 3;
    let index = 0;
    const worker = async (): Promise<void> => {
      while (index < missing.length) {
        const path = missing[index++];
        await this.ensureRepoWebUrl(path);
      }
    };
    void Promise.all(Array.from({ length: Math.min(limit, missing.length) }, () => worker()));
  }

  private async loadRepoWebUrl(path: string): Promise<string | null> {
    try {
      const remotes = await this.tauri.listRemotes(path);
      const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
      const url = origin
        ? parseRemoteWebBase(origin.fetchUrl || origin.pushUrl)?.webBase ?? null
        : null;
      this.repoWebUrls.update((map) => ({ ...map, [path]: url }));
      return url;
    } catch {
      this.repoWebUrls.update((map) => ({ ...map, [path]: null }));
      return null;
    }
  }

  openRepoWebUrl(path: string): void {
    void this.ensureRepoWebUrl(path).then((url) => {
      if (!url) {
        this.showWarning('No GitHub or GitLab remote found for this repository.');
        return;
      }
      void this.tauri.openExternalUrl(url);
    });
  }

  openHostRepoWeb(repo: HostRepository): void {
    const url =
      repo.htmlUrl?.trim() ||
      parseRemoteWebBase(repo.cloneUrl)?.webBase ||
      null;
    if (!url) {
      this.showWarning('Could not resolve a web URL for this repository.');
      return;
    }
    void this.tauri.openExternalUrl(url);
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
      const check = await this.verifySavedIntegration(provider);
      if (!check?.ok) {
        this.showError(check?.message ?? 'Connection check failed');
        return false;
      }
      await this.applyConnectionAccount(provider, check.account);
      await this.refreshHostRepositories(provider, { force: true });
      this.showSuccess(check.message);
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
      } else if (this.isDummyBackend) {
        this.jiraIssues.set(await this.tauri.listMockJiraIssues());
      } else {
        this.jiraIssues.set([]);
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
      const check = await this.verifySavedIntegration('jira');
      if (!check?.ok) {
        this.showError(check?.message ?? 'Connection check failed');
        return false;
      }
      await this.refreshJiraIssues();
      this.showSuccess(check.message);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async signInAzureDevOps(token: string, organization: string, project = ''): Promise<boolean> {
    const cleanedToken = token.trim();
    const org = organization.trim();
    if (!cleanedToken) {
      this.showWarning('Paste a personal access token to sign in.');
      return false;
    }
    if (!org) {
      this.showWarning('Set the Azure DevOps organization, then connect again.');
      return false;
    }
    const connections = this.settings().connections.map((c) => {
      if (c.provider !== 'azureDevOps') return c;
      return {
        ...c,
        enabled: true,
        token: cleanedToken,
        hasToken: true,
        organization: org,
        project: project.trim() || c.project,
      };
    });
    try {
      await this.saveSettings({ connections });
      const check = await this.verifySavedIntegration('azureDevOps');
      if (!check?.ok) {
        this.showError(check?.message ?? 'Connection check failed');
        return false;
      }
      await this.applyConnectionAccount('azureDevOps', check.account);
      this.showSuccess(check.message);
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
    if (this.mutationDepth > 0) {
      this.workingTreeRefreshQueued = true;
      return;
    }
    if (this.workingTreeRefreshInFlight) {
      this.workingTreeRefreshQueued = true;
      await this.workingTreeRefreshInFlight;
      return;
    }
    this.workingTreeRefreshInFlight = this.runRefreshWorkingTree(path)
      .catch((err) => this.showError(err))
      .finally(() => {
        this.workingTreeRefreshInFlight = null;
        if (this.workingTreeRefreshQueued && this.mutationDepth === 0) {
          this.workingTreeRefreshQueued = false;
          void this.refreshWorkingTree();
        }
      });
    await this.workingTreeRefreshInFlight;
  }

  private async runRefreshWorkingTree(path: string): Promise<void> {
    const prev = this.status();
    const status = await this.tauri.getRepoStatus(path, this.statusFetchOpts());
    if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
    this.lastWorkingTreeRefreshAt = Date.now();
    if (prev && statusFingerprint(prev) === statusFingerprint(status)) {
      return;
    }
    this.status.set(status);
    this.artificial.set(artificialFromStatus(status));
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    void this.syncConflictManager(prev, status);
    this.snapshotCurrentRepo();
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
    this.syncingRepo.set(true);
    this.refreshInFlight = this.runRefreshRepo(path, opts)
      .catch((err) => this.showError(err))
      .finally(() => {
        this.refreshInFlight = null;
        if (opts?.notify) this.refreshingRepo.set(false);
        this.syncingRepo.set(false);
        if (this.refreshQueued && this.mutationDepth === 0) {
          this.refreshQueued = false;
          void this.refreshRepo();
        }
      });
    await this.refreshInFlight;
  }

  private async runRefreshRepo(path: string, opts?: { notify?: boolean }): Promise<void> {
    const prev = this.status();
    const [status, commits, branches, stashes, tags, remotes] = await Promise.all([
      this.tauri.getRepoStatus(path, this.statusFetchOpts()),
      this.tauri.getCommitLog(path, this.commitLogLimit()),
      this.tauri.listBranches(path),
      this.tauri.listStashes(path),
      this.tauri.listTags(path),
      this.tauri.listRemotes(path),
    ]);
    if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
    this.status.set(status);
    this.setCommitsIfChanged(commits);
    this.commitLogHasMore.set(commits.length >= this.commitLogLimit() && this.commitLogLimit() < 5000);
    this.artificial.set(artificialFromStatus(status));
    this.setBranchesIfChanged(branches);
    this.stashes.set(stashes);
    this.tags.set(tags);
    this.remotes.set(remotes);
    this.lastWorkingTreeRefreshAt = Date.now();
    void this.refreshIdentity();
    if (!this.selectedSha() && commits[0]) {
      this.selectedSha.set(commits[0].sha);
      this.selectedShas.set([commits[0].sha]);
    }
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    void this.syncConflictManager(prev, status);
    this.persistRepoCache(path);
    this.snapshotCurrentRepo();
    if (opts?.notify) {
      void this.refreshHeavyLists(path, { includeLfs: true });
      const changed =
        status.staged.length + status.unstaged.length + status.untracked.length;
      const branch = status.branch || 'HEAD';
      this.showToast(
        changed
          ? `Refreshed ${branch} · ${changed} change${changed === 1 ? '' : 's'}`
          : `Refreshed ${branch} · clean`,
        { kind: 'success', durationMs: 2500, category: 'general' },
      );
    } else {
      void this.refreshHeavyLists(path, { includeLfs: false });
    }
  }

  private async refreshRepoMeta(path: string): Promise<void> {
    if (this.mutationDepth > 0) {
      this.refreshQueued = true;
      return;
    }
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      await this.refreshInFlight;
      return;
    }
    this.syncingRepo.set(true);
    this.refreshInFlight = this.runRefreshRepoMeta(path)
      .catch((err) => this.showError(err))
      .finally(() => {
        this.refreshInFlight = null;
        this.syncingRepo.set(false);
        if (this.refreshQueued && this.mutationDepth === 0) {
          this.refreshQueued = false;
          const current = this.currentRepo()?.path;
          if (current) void this.refreshRepoMeta(current);
        }
      });
    await this.refreshInFlight;
  }

  private async runRefreshRepoMeta(path: string): Promise<void> {
    const prev = this.status();
    const [status, commits, branches] = await Promise.all([
      this.tauri.getRepoStatus(path, this.statusFetchOpts()),
      this.tauri.getCommitLog(path, this.commitLogLimit()),
      this.tauri.listBranches(path),
    ]);
    if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
    if (prev && statusFingerprint(prev) === statusFingerprint(status)) {
      this.setCommitsIfChanged(commits);
      this.setBranchesIfChanged(branches);
      this.lastWorkingTreeRefreshAt = Date.now();
      this.snapshotCurrentRepo();
      return;
    }
    this.status.set(status);
    this.setCommitsIfChanged(commits);
    this.commitLogHasMore.set(commits.length >= this.commitLogLimit() && this.commitLogLimit() < 5000);
    this.artificial.set(artificialFromStatus(status));
    this.setBranchesIfChanged(branches);
    this.lastWorkingTreeRefreshAt = Date.now();
    if (!this.selectedSha() && commits[0]) {
      this.selectedSha.set(commits[0].sha);
      this.selectedShas.set([commits[0].sha]);
    }
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    void this.syncConflictManager(prev, status);
    this.snapshotCurrentRepo();
  }

  async refreshLfsFiles(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const lfsFiles = await this.tauri.listLfsFiles(path);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
      this.lfsFiles.set(lfsFiles);
    } catch {
      /* optional */
    }
  }

  private async refreshHeavyLists(
    path: string,
    opts?: { includeLfs?: boolean },
  ): Promise<void> {
    try {
      const includeLfs = opts?.includeLfs === true;
      const [worktrees, submodules, lfsFiles] = await Promise.all([
        this.tauri.listWorktrees(path),
        this.tauri.listSubmodules(path).catch(() => [] as SubmoduleInfo[]),
        includeLfs
          ? this.tauri.listLfsFiles(path).catch(() => [] as LfsFileInfo[])
          : Promise.resolve(this.lfsFiles()),
      ]);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
      this.worktrees.set(worktrees);
      this.submodules.set(submodules);
      if (includeLfs) this.lfsFiles.set(lfsFiles);
      this.snapshotCurrentRepo();
    } catch {
      /* heavy lists are best-effort */
    }
  }

  private async withRepoMutation<T>(fn: () => Promise<T>): Promise<T> {
    this.mutationDepth++;
    try {
      return await fn();
    } finally {
      this.mutationDepth--;
      if (this.mutationDepth === 0) {
        if (this.refreshQueued) {
          this.refreshQueued = false;
          this.workingTreeRefreshQueued = false;
          void this.refreshRepo();
        } else if (this.workingTreeRefreshQueued) {
          this.workingTreeRefreshQueued = false;
          void this.refreshWorkingTree();
        }
      }
    }
  }

  private beginGitAction(label: string): boolean {
    if (this.remoteBusy() || this.actionBusy() || this.loading()) return false;
    this.actionBusy.set(label);
    return true;
  }

  armRemoteBusy(kind: 'fetch' | 'pull' | 'push'): boolean {
    if (this.remoteBusy() || this.actionBusy() || this.loading()) return false;
    this.remoteBusy.set(kind);
    return true;
  }

  private async beginRemoteBusy(kind: 'fetch' | 'pull' | 'push'): Promise<boolean> {
    if (this.actionBusy() || this.loading()) return false;
    const current = this.remoteBusy();
    if (current && current !== kind) return false;
    this.remoteBusy.set(kind);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return this.remoteBusy() === kind;
  }

  private async bindReleaseProgressListener(): Promise<void> {
    if (this.isDummyBackend) return;
    if (this.releaseProgressUnlisten) {
      this.releaseProgressUnlisten();
      this.releaseProgressUnlisten = null;
    }
    try {
      this.releaseProgressUnlisten = await listen<ReleaseProgressEvent>(
        'release-progress',
        (event) => {
          this.applyReleaseProgress(event.payload);
        },
      );
    } catch {
      this.releaseProgressUnlisten = null;
    }
  }

  private applyReleaseProgress(
    payload: ReleaseProgressEvent,
    extras?: Partial<
      Pick<
        ReleaseActivity,
        | 'needsPush'
        | 'deployRunUrl'
        | 'releaseUrl'
        | 'websiteUrl'
        | 'actionsPageUrl'
        | 'repoUrl'
        | 'deployJobs'
        | 'needsRefresh'
      >
    >,
  ): void {
    const current = this.releaseActivity();
    if (!current) return;
    if (!sameRepoPath(current.path, payload.path)) return;
    const phase = normalizeReleasePhase(payload.phase);
    const message = payload.message?.trim() || current.message;
    const nextVersion = payload.version?.trim() || current.nextVersion;
    const tag = payload.tag?.trim() || current.tag;
    const steps = advanceReleaseSteps(current.steps, phase, message);
    const finished = phase === 'done' || phase === 'error';
    const next: ReleaseActivity = {
      ...current,
      ...extras,
      phase,
      message,
      nextVersion,
      tag,
      steps,
      finishedAt: finished ? Date.now() : current.finishedAt ?? null,
      ok: phase === 'done' ? true : phase === 'error' ? false : current.ok ?? null,
    };
    const fingerprint = releaseActivityFingerprint(next);
    if (fingerprint === this.lastReleaseFingerprint) return;
    this.lastReleaseFingerprint = fingerprint;
    this.releaseActivity.set(next);
    this.persistReleaseActivity(finished);
  }

  private persistReleaseActivity(immediate = false): void {
    if (typeof window === 'undefined') return;
    if (!immediate) {
      if (this.persistReleaseTimer !== null) return;
      this.persistReleaseTimer = window.setTimeout(() => {
        this.persistReleaseTimer = null;
        this.flushReleaseActivityPersist();
      }, 10_000);
      return;
    }
    if (this.persistReleaseTimer !== null) {
      window.clearTimeout(this.persistReleaseTimer);
      this.persistReleaseTimer = null;
    }
    this.flushReleaseActivityPersist();
  }

  private flushReleaseActivityPersist(): void {
    const activity = this.releaseActivity();
    if (!activity) {
      localStorage.removeItem(RELEASE_ACTIVITY_STORAGE_KEY);
      this.lastReleaseFingerprint = '';
      return;
    }
    try {
      localStorage.setItem(RELEASE_ACTIVITY_STORAGE_KEY, JSON.stringify(activity));
    } catch {
      /* ignore quota errors */
    }
  }

  private restoreReleaseActivity(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(RELEASE_ACTIVITY_STORAGE_KEY);
      if (!raw) return;
      const activity = hydrateReleaseActivity(JSON.parse(raw) as ReleaseActivity);
      if (!activity?.path || !activity.tag) return;
      this.lastReleaseFingerprint = releaseActivityFingerprint(activity);
      this.releaseActivity.set(activity);
    } catch {
      localStorage.removeItem(RELEASE_ACTIVITY_STORAGE_KEY);
    }
  }

  clearReleaseActivity(): void {
    if (this.releaseBusy()) return;
    const tag = this.releaseActivity()?.tag;
    this.stopReleaseDeployPoll();
    if (this.persistReleaseTimer !== null) {
      window.clearTimeout(this.persistReleaseTimer);
      this.persistReleaseTimer = null;
    }
    this.lastReleaseFingerprint = '';
    this.lastReleaseNoticeKey = '';
    this.releaseActivity.set(null);
    if (typeof window !== 'undefined') {
      localStorage.removeItem(RELEASE_ACTIVITY_STORAGE_KEY);
      if (tag) {
        try {
          localStorage.setItem(RELEASE_DISMISSED_TAG_KEY, tag);
        } catch {
          /* ignore quota errors */
        }
      }
    }
  }

  private restoreReleaseNotesDraft(): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(RELEASE_NOTES_DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as ReleaseNotesDraft;
      if (!draft?.path || typeof draft.body !== 'string') return;
      this.releaseNotesDraft.set(draft);
    } catch {
      localStorage.removeItem(RELEASE_NOTES_DRAFT_KEY);
    }
  }

  private persistReleaseNotesDraft(): void {
    if (typeof window === 'undefined') return;
    const draft = this.releaseNotesDraft();
    try {
      if (!draft || !draft.body.trim()) {
        localStorage.removeItem(RELEASE_NOTES_DRAFT_KEY);
        return;
      }
      localStorage.setItem(RELEASE_NOTES_DRAFT_KEY, JSON.stringify(draft));
    } catch {
      /* ignore quota errors */
    }
  }

  private patchReleaseActivity(patch: Partial<ReleaseActivity>, persistImmediate = true): void {
    const current = this.releaseActivity();
    if (!current) return;
    const next: ReleaseActivity = { ...current, ...patch };
    this.releaseActivity.set(next);
    this.persistReleaseActivity(persistImmediate);
  }

  setReleaseNotes(body: string): void {
    const activity = this.releaseActivity();
    if (activity) {
      this.patchReleaseActivity({ notes: body, notesSynced: false });
      return;
    }
    const path = this.currentRepo()?.path;
    if (!path) return;
    this.releaseNotesDraft.set({ path, body });
    this.persistReleaseNotesDraft();
  }

  async saveReleaseNotes(): Promise<void> {
    const activity = this.releaseActivity();
    const path = activity?.path || this.currentRepo()?.path;
    if (!path || this.releaseNotesBusy()) return;
    const body = this.releaseNotesText();
    this.setReleaseNotes(body);
    const tag = activity?.tag?.trim();
    if (!tag || !this.releaseNotesCanPublish()) {
      this.showSuccess('Saved local release notes draft');
      return;
    }
    this.releaseNotesBusy.set(true);
    try {
      const result = await this.tauri.updateGithubReleaseNotes(path, tag, body);
      if (result.ok && result.found) {
        this.patchReleaseActivity({
          notes: result.body,
          notesSynced: true,
          releaseUrl: result.htmlUrl ?? activity?.releaseUrl ?? null,
        });
        this.showSuccess(result.message || 'Updated GitHub release notes');
        return;
      }
      this.showSuccess(result.message || 'Saved local draft — GitHub release is not published yet');
    } catch (err) {
      this.showError(err);
    } finally {
      this.releaseNotesBusy.set(false);
    }
  }

  async loadGitHubReleaseNotes(opts?: { overwrite?: boolean }): Promise<void> {
    const activity = this.releaseActivity();
    const path = activity?.path || this.currentRepo()?.path;
    const tag = activity?.tag?.trim();
    if (!path || !tag || this.releaseNotesBusy()) return;
    const local = (activity?.notes ?? '').trim();
    if (local && !opts?.overwrite) return;
    this.releaseNotesBusy.set(true);
    try {
      const result = await this.tauri.getGithubReleaseNotes(path, tag);
      if (!result.found) return;
      const remote = result.body ?? '';
      if (!opts?.overwrite && local && local !== remote.trim()) return;
      this.patchReleaseActivity({
        notes: remote,
        notesSynced: true,
        releaseUrl: result.htmlUrl ?? activity?.releaseUrl ?? null,
      });
    } catch {
    } finally {
      this.releaseNotesBusy.set(false);
    }
  }

  async generateReleaseNotes(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || this.releaseNotesGenerating()) return;
    const activity = this.releaseActivity();
    const currentTag = activity?.tag?.trim() || null;
    const previous = this.changelog.previousReleaseTag(this.tags(), this.commits(), currentTag);
    const current = currentTag
      ? this.tags().find((tag) => tag.name === currentTag) ?? null
      : null;
    const fromSha = previous?.sha ?? null;
    const toSha = current?.sha ?? null;
    const version = activity?.nextVersion || this.changelog.suggestVersion(this.tags(), this.commits());
    this.releaseNotesGenerating.set(true);
    try {
      let commits = this.changelog.commitsBetween(this.commits(), fromSha, toSha);
      try {
        commits = await this.tauri.getCommitRange(path, fromSha, toSha || 'HEAD', 500);
      } catch {
      }
      const markdown = this.changelog.githubReleaseBody(
        commits,
        version,
        previous?.name ?? 'root',
        currentTag || 'HEAD',
      );
      this.setReleaseNotes(markdown);
      this.showSuccess('Generated notes from commits');
    } catch (err) {
      this.showError(err);
    } finally {
      this.releaseNotesGenerating.set(false);
    }
  }

  private async publishReleaseNotesIfPossible(): Promise<void> {
    const activity = this.releaseActivity();
    const path = activity?.path || this.currentRepo()?.path;
    const body = (activity?.notes ?? '').trim();
    const tag = activity?.tag?.trim();
    if (!path || !activity || !tag || !body || activity.notesSynced || this.releaseNotesBusy()) {
      return;
    }
    this.releaseNotesBusy.set(true);
    try {
      const result = await this.tauri.updateGithubReleaseNotes(path, tag, body);
      if (result.ok && result.found) {
        this.patchReleaseActivity({
          notes: result.body || body,
          notesSynced: true,
          releaseUrl: result.htmlUrl ?? activity.releaseUrl ?? null,
        });
      }
    } catch {
    } finally {
      this.releaseNotesBusy.set(false);
    }
  }

  private stopReleaseDeployPoll(): void {
    if (this.releaseDeployPollTimer !== null) {
      window.clearTimeout(this.releaseDeployPollTimer);
      this.releaseDeployPollTimer = null;
    }
  }

  private pauseBackgroundReleaseWork(): void {
    this.stopReleaseDeployPoll();
  }

  openReleaseTab(): void {
    if (this.currentRepo()) this.setView('release');
  }

  private notifyReleaseOutcome(
    kind: 'started' | 'tagged' | 'success' | 'failure' | 'paused' | 'job-failed',
    input?: { productName?: string; version?: string; tag?: string; message?: string },
  ): void {
    const activity = this.releaseActivity();
    const product = (input?.productName ?? activity?.productName ?? 'Release').trim();
    const version = (input?.version ?? activity?.nextVersion ?? '').trim();
    const tag = (input?.tag ?? activity?.tag ?? '').trim();
    const label = version ? `${product} ${version}` : tag || product;
    const message =
      input?.message?.trim() ||
      (kind === 'success'
        ? `${label} is live`
        : kind === 'tagged'
          ? `${label} tagged locally`
          : kind === 'started'
            ? `${label} is deploying`
            : kind === 'paused'
              ? `Tracking paused for ${label}`
              : kind === 'job-failed'
                ? `${label} has a failed job`
                : `${label} failed`);
    const key = `${tag}:${kind}`;
    if (this.lastReleaseNoticeKey === key) return;
    this.lastReleaseNoticeKey = key;
    const title =
      kind === 'success'
        ? `${label} is live`
        : kind === 'tagged'
          ? `${label} tagged`
          : kind === 'started'
            ? `${label} is deploying`
            : kind === 'paused'
              ? `Tracking paused for ${label}`
              : kind === 'job-failed'
                ? `${label} job failed`
                : `${label} failed`;
    const toastKind: ToastKind =
      kind === 'success' || kind === 'tagged'
        ? 'success'
        : kind === 'started'
          ? 'info'
          : kind === 'paused'
            ? 'warning'
            : 'error';
    this.showToast(message, {
      kind: toastKind,
      category: 'release',
      durationMs: toastKind === 'error' ? 14000 : 9000,
      undo: () => this.setView('release'),
      actionLabel: 'View',
    });
    void this.sendDesktopIfEnabled('release', title, message);
  }

  async attachLatestRelease(options?: { force?: boolean }): Promise<boolean> {
    if (this.view() !== 'release' && options?.force !== true) return false;
    const path = this.currentRepo()?.path;
    if (!path) return false;
    if (this.releaseAttachInFlight && this.releaseAttachPath === path) {
      return this.releaseAttachInFlight;
    }
    this.releaseAttaching.set(true);
    this.releaseAttachPath = path;
    this.releaseAttachInFlight = this.runAttachLatestRelease(options).finally(() => {
      this.releaseAttachInFlight = null;
      this.releaseAttachPath = null;
      this.releaseAttaching.set(false);
    });
    return this.releaseAttachInFlight;
  }

  private async runAttachLatestRelease(options?: { force?: boolean }): Promise<boolean> {
    if (this.isDummyBackend) return false;
    const path = this.currentRepo()?.path;
    if (!path) return false;
    const force = options?.force === true;
    if (this.releaseBusy() && !force) return false;
    try {
      const status = await this.tauri.getReleaseStatus(path);
      if (!force && this.view() !== 'release') return false;
      const version = status.currentVersion?.trim();
      const cfg = status.config;
      if (!status.available || !version || !cfg) {
        if (force) this.showWarning('Release is not configured for this repository.');
        return false;
      }
      const tag = `${cfg.tagPrefix}${version}`;
      const current = this.releaseActivity();
      if (
        current &&
        sameRepoPath(current.path, path) &&
        current.tag === tag &&
        !force &&
        !current.needsRefresh
      ) {
        if (
          this.view() === 'release' &&
          current.willPush &&
          !current.needsPush &&
          current.phase !== 'done' &&
          current.phase !== 'error'
        ) {
          void this.watchReleaseDeploy(path, tag);
        }
        return true;
      }
      if (!force && this.readDismissedReleaseTag() === tag) return false;

      const result = await this.tauri.pollReleaseDeploy(path, tag);
      if (!force && this.view() !== 'release') return false;
      this.seedAttachedReleaseActivity({
        path,
        productName: cfg.productName,
        version,
        tag,
        result,
      });
      this.clearDismissedReleaseTag(tag);
      if (result.status === 'success' || result.status === 'failure') {
        this.releaseBusy.set(false);
        return true;
      }
      if (result.status === 'unavailable') {
        this.releaseBusy.set(false);
        return true;
      }
      if (this.view() !== 'release' && !force) return true;
      this.releaseBusy.set(true);
      void this.watchReleaseDeploy(path, tag);
      return true;
    } catch (err) {
      if (force) this.showError(err);
      return false;
    }
  }

  private seedAttachedReleaseActivity(input: {
    path: string;
    productName: string;
    version: string;
    tag: string;
    result: PollReleaseDeployOutput;
  }): void {
    const phase = normalizeReleasePhase(input.result.phase);
    const trackingPhase = phase === 'idle' ? 'deploying' : phase;
    const finished = trackingPhase === 'done' || trackingPhase === 'error';
    const current = this.releaseActivity();
    const existing =
      current && sameRepoPath(current.path, input.path) && current.tag === input.tag
        ? current
        : null;
    const draft = this.releaseNotesDraft();
    const draftBody =
      draft && sameRepoPath(draft.path, input.path) ? draft.body : '';
    const activity: ReleaseActivity = {
      path: input.path,
      productName: input.productName,
      currentVersion: input.version,
      nextVersion: input.version,
      tag: input.tag,
      willPush: true,
      needsPush: false,
      deployRunUrl: input.result.runUrl ?? null,
      releaseUrl: input.result.releaseUrl ?? null,
      websiteUrl: input.result.websiteUrl ?? null,
      actionsPageUrl: input.result.actionsPageUrl ?? null,
      repoUrl: input.result.repoUrl ?? null,
      deployJobs: input.result.jobs ?? [],
      phase: trackingPhase,
      message: input.result.message,
      notes: existing?.notes ?? draftBody,
      notesSynced: existing?.notesSynced ?? false,
      steps: advanceReleaseSteps(buildReleaseSteps(true), trackingPhase, input.result.message),
      startedAt: existing?.startedAt ?? Date.now(),
      finishedAt: finished ? Date.now() : null,
      ok: trackingPhase === 'done' ? true : trackingPhase === 'error' ? false : null,
      needsRefresh: input.result.status === 'unavailable',
    };
    this.lastReleaseFingerprint = releaseActivityFingerprint(activity);
    this.releaseActivity.set(activity);
    this.persistReleaseActivity(finished);
    if (activity.releaseUrl && !(activity.notes ?? '').trim()) {
      void this.loadGitHubReleaseNotes();
    }
  }

  private readDismissedReleaseTag(): string | null {
    if (typeof window === 'undefined') return null;
    try {
      return localStorage.getItem(RELEASE_DISMISSED_TAG_KEY);
    } catch {
      return null;
    }
  }

  private clearDismissedReleaseTag(tag: string): void {
    if (typeof window === 'undefined') return;
    try {
      if (localStorage.getItem(RELEASE_DISMISSED_TAG_KEY) === tag) {
        localStorage.removeItem(RELEASE_DISMISSED_TAG_KEY);
      }
    } catch {
      /* ignore */
    }
  }

  private beginReleaseActivity(input: {
    path: string;
    productName: string;
    currentVersion: string;
    nextVersion: string;
    tag: string;
    willPush: boolean;
  }): void {
    const draft = this.releaseNotesDraft();
    const draftBody =
      draft && sameRepoPath(draft.path, input.path) ? draft.body : '';
    const steps = buildReleaseSteps(input.willPush);
    this.releaseActivity.set({
      path: input.path,
      productName: input.productName,
      currentVersion: input.currentVersion,
      nextVersion: input.nextVersion,
      tag: input.tag,
      willPush: input.willPush,
      phase: 'preparing',
      message: `Releasing ${input.productName} ${input.currentVersion} → ${input.nextVersion}`,
      notes: draftBody,
      notesSynced: false,
      steps: advanceReleaseSteps(steps, 'preparing', 'Checking release preconditions…'),
      startedAt: Date.now(),
      finishedAt: null,
      ok: null,
      needsRefresh: false,
    });
    this.releaseBusy.set(true);
    this.lastReleaseNoticeKey = '';
    this.openReleaseTab();
  }

  private async simulateReleaseProgress(willPush: boolean): Promise<void> {
    const phases: Array<{ phase: ReleasePhase; message: string; delay: number }> = [
      { phase: 'preparing', message: 'Checking release preconditions…', delay: 180 },
      { phase: 'bumping', message: 'Bumping version files…', delay: 220 },
      { phase: 'staging', message: 'Staging version files…', delay: 180 },
      { phase: 'committing', message: 'Creating release commit…', delay: 220 },
      { phase: 'tagging', message: 'Creating release tag…', delay: 180 },
    ];
    if (willPush) {
      phases.push({ phase: 'pushing', message: 'Pushing commit and tags to origin…', delay: 320 });
      phases.push({ phase: 'deploying', message: 'Waiting for GitHub Actions to start…', delay: 400 });
      phases.push({ phase: 'ci', message: 'Building release artifacts…', delay: 500 });
      phases.push({ phase: 'publishing', message: 'Publishing GitHub release…', delay: 400 });
    }
    const activity = this.releaseActivity();
    const path = activity?.path ?? this.currentRepo()?.path ?? '';
    for (const step of phases) {
      await new Promise((r) => setTimeout(r, step.delay));
      this.applyReleaseProgress({
        path,
        phase: step.phase,
        message: step.message,
        version: activity?.nextVersion,
        tag: activity?.tag,
      });
    }
  }

  private async bindRepoFsWatcher(): Promise<void> {
    if (this.isDummyBackend) return;
    if (this.repoFsUnlisten) {
      this.repoFsUnlisten();
      this.repoFsUnlisten = null;
    }
    try {
      this.repoFsUnlisten = await listen<{ path: string; scope?: string }>(
        'repo-fs-changed',
        (event) => {
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
            if (this.refreshInFlight || this.workingTreeRefreshInFlight) {
              this.refreshQueued = true;
              return;
            }
            void this.refreshRepoMeta(current);
          }, 700);
        },
      );
    } catch {
      /* watch unavailable outside desktop shell */
    }
  }

  private bindWorktreeFocusWatch(): void {
    if (this.worktreeFocusBound || typeof document === 'undefined') return;
    this.worktreeFocusBound = true;
    const maybeRefresh = (): void => {
      if (!this.currentRepo()) return;
      if (this.mutationDepth > 0 || this.refreshInFlight || this.workingTreeRefreshInFlight) {
        return;
      }
      if (Date.now() - this.lastWorkingTreeRefreshAt < 1500) return;
      void this.refreshWorkingTree();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      maybeRefresh();
    });
    window.addEventListener('focus', () => {
      maybeRefresh();
    });
  }

  private startWorktreePoll(): void {
    if (typeof window === 'undefined') return;
    if (this.worktreePollTimer !== null) {
      window.clearInterval(this.worktreePollTimer);
    }
    this.worktreePollTimer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!this.currentRepo()) return;
      if (this.view() !== 'browse') return;
      if (this.mutationDepth > 0 || this.refreshInFlight || this.workingTreeRefreshInFlight) {
        return;
      }
      if (Date.now() - this.lastWorkingTreeRefreshAt < 2800) return;
      void this.refreshWorkingTree();
    }, 3500);
  }

  updateNextAction(status: RepoStatus): void {
    if (status.conflicted.length) {
      const n = status.conflicted.length;
      this.nextAction.set(`Resolve ${n} conflict${n === 1 ? '' : 's'}`);
      return;
    }
    if (status.operation) {
      const detail = status.operation.detail ? ` · ${status.operation.detail}` : '';
      this.nextAction.set(`Continue ${status.operation.label.replace(/ in progress$/i, '').toLowerCase()}${detail}`);
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
    if (this.diffSource() !== 'commit') this.diffSource.set('commit');
    if (multi) {
      const cur = this.selectedShas();
      if (cur.includes(sha)) {
        this.selectedShas.set(cur.filter((s) => s !== sha));
      } else {
        this.selectedShas.set([...cur, sha]);
      }
      if (this.selectedSha() !== sha) this.selectedSha.set(sha);
      return;
    }
    const current = this.selectedShas();
    if (
      this.selectedSha() === sha &&
      current.length === 1 &&
      current[0] === sha &&
      this.compareSha() === null
    ) {
      return;
    }
    this.selectedSha.set(sha);
    this.selectedShas.set([sha]);
    if (this.compareSha() !== null) this.compareSha.set(null);
  }

  revealCommit(sha: string): void {
    const resolved = this.resolveLoadedCommitSha(sha);
    this.selectCommit(resolved ?? sha);
    if (!resolved) {
      this.showWarning('That commit is not in the loaded graph');
      return;
    }
    if (!this.filteredCommits().some((c) => c.sha === resolved)) {
      this.clearHistoryFilter();
    }
    this.graphReveal.update((cur) => ({ sha: resolved, nonce: (cur?.nonce ?? 0) + 1 }));
  }

  private resolveLoadedCommitSha(sha: string): string | null {
    const map = this.commitBySha();
    const hit = map.get(sha) ?? (sha.length >= 7 ? map.get(sha.slice(0, 7)) : undefined);
    return hit?.sha ?? null;
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

  compareWithCurrent(tipSha: string): void {
    const currentSha = this.localBranches().find((b) => b.isCurrent)?.tipSha;
    const sha = tipSha.trim();
    if (!sha) {
      this.showWarning('No commit to compare');
      return;
    }
    if (!currentSha) {
      this.showWarning('No current branch tip to compare');
      return;
    }
    if (currentSha === sha || currentSha.startsWith(sha) || sha.startsWith(currentSha.slice(0, 7))) {
      this.showInfo('Already on this commit');
      return;
    }
    this.selectedSha.set(currentSha);
    this.selectedShas.set([currentSha]);
    this.compareSha.set(sha);
    this.setBrowseTab('diff');
    this.revealCommit(currentSha);
  }

  showToast(message: string, undoOrOptions?: (() => void) | ToastOptions): void {
    const options =
      typeof undoOrOptions === 'function'
        ? { undo: undoOrOptions, kind: 'success' as ToastKind }
        : (undoOrOptions ?? {});
    const kind = options.kind ?? (options.undo ? 'success' : 'info');
    const category = options.category ?? 'general';
    const toastMessage = summarizeGitToastMessage(message);
    if (!options.force && !this.shouldShowToast(category, kind)) {
      if (options.desktop) {
        void this.sendDesktopIfEnabled(category, 'Branchline', toastMessage);
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
      message: toastMessage,
      kind,
      undo: options.undo,
      actionLabel: options.actionLabel,
    });
    if (durationMs > 0) {
      this.toastTimer = window.setTimeout(() => {
        if (this.toast()?.id === id) {
          this.toast.set(null);
        }
        this.toastTimer = null;
      }, durationMs);
    }
    if (options.desktop) {
      void this.sendDesktopIfEnabled(category, 'Branchline', toastMessage);
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
    const raw = rawErrorMessage(err);
    const message = this.humanizeError(raw || err);
    const remoteIssue = isRemoteAccessError(raw);
    this.showToast(message, {
      kind: 'error',
      force: true,
      durationMs: remoteIssue ? 0 : undefined,
      undo: remoteIssue ? () => this.openRemoteTroubleshoot(raw) : undefined,
      actionLabel: remoteIssue ? 'Troubleshoot' : undefined,
    });
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
      case 'release':
        return s.notifyRelease;
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
      const title = next.operation?.label || 'Conflicts';
      this.notifyEvent(
        'conflicts',
        title,
        `${repo}: ${n} conflict${n === 1 ? '' : 's'} to resolve`,
        { kind: 'warning' },
      );
    } else if (
      next.operation &&
      !prev.operation &&
      next.conflicted.length === 0
    ) {
      this.notifyEvent(
        'conflicts',
        next.operation.label,
        `${repo}: ready to Continue`,
        { kind: 'info' },
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
    const enablingSimple = partial.simpleMode === true && !this.settings().simpleMode;
    const current = this.settingsWithSession();
    const next = normalizeSettings({
      ...current,
      ...partial,
      connections: partial.connections ?? current.connections,
      layout: partial.layout ?? current.layout,
    });
    const saved = await this.tauri.saveSettings(next);
    this.settings.set(normalizeSettings(saved));
    this.sessionOverlay = {};
    this.myBranchesOnly.set(saved.myBranchesOnly);
    this.applyTheme(saved);
    if (enablingSimple) this.constrainSimpleMode();
  }

  private constrainSimpleMode(): void {
    const view = this.view();
    if (view === 'automation' || view === 'templates' || view === 'profiles') {
      if (this.currentRepo()) this.setView('browse');
      else this.openSettings('repos');
    }
    const tab = this.browseTab();
    if (tab !== 'commit' && tab !== 'diff' && tab !== 'files') {
      this.setBrowseTab('diff');
    }
  }

  private async migratePushAfterCommitDefault(): Promise<void> {
    if (typeof window === 'undefined') return;
    if (this.settings().pushAfterCommit) return;
    try {
      if (localStorage.getItem('branchline.migratedPushAfterCommit') === '1') return;
      localStorage.setItem('branchline.migratedPushAfterCommit', '1');
    } catch {
      return;
    }
    await this.saveSettings({ pushAfterCommit: true });
  }

  setHiddenRefsGroups(ids: string[]): void {
    const layout = { ...(this.settings().layout ?? {}), hiddenRefsGroups: [...new Set(ids)] };
    this.settings.update((s) => ({ ...s, layout }));
    void this.saveSettings({ layout });
  }

  setRefsGroupHidden(id: string, hidden: boolean): void {
    const current = this.hiddenRefsGroups();
    const already = current.includes(id);
    if (hidden === already) return;
    this.setHiddenRefsGroups(hidden ? [...current, id] : current.filter((x) => x !== id));
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

  async loadRepoChecks(opts?: { toastNew?: boolean }): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.repoChecks.set(null);
      this.checkRuns.set({});
      return;
    }
    try {
      const result = await this.tauri.listRepoChecks(path);
      this.repoChecks.set(result);
      this.resetCheckRuns(result.checks);
      if (opts?.toastNew && result.newlyDetected.length) {
        const labels = result.newlyDetected.join(', ');
        const count = result.checks.filter((c) => c.builtin).length;
        this.showSuccess(
          `Found ${labels} — ${count} check${count === 1 ? '' : 's'} added to Commit`,
        );
      }
    } catch (err) {
      this.showError(err);
    }
  }

  enabledChecks(triggers?: string[]): RepoCheck[] {
    const checks = this.repoChecks()?.checks ?? [];
    return checks.filter((c) => {
      if (!c.enabled) return false;
      if (!triggers?.length) return true;
      return triggers.includes(c.trigger);
    });
  }

  hasDetectedChecks(triggers: string[]): boolean {
    return (this.repoChecks()?.checks ?? []).some(
      (c) => c.builtin && triggers.includes(c.trigger),
    );
  }

  resetCheckRuns(checks: RepoCheck[] = this.repoChecks()?.checks ?? []): void {
    const next: Record<string, CheckRunState> = {};
    for (const check of checks) {
      next[check.id] = { status: 'idle', output: '' };
    }
    this.checkRuns.set(next);
  }

  async runRepoChecks(
    triggers: string[],
    opts?: { commitMessage?: string; skip?: boolean; silent?: boolean },
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return true;
    if (!this.repoChecks()) {
      await this.loadRepoChecks();
    }
    const checks = this.enabledChecks(triggers);
    if (opts?.skip || checks.length === 0) {
      if (opts?.skip) {
        const skipped: Record<string, CheckRunState> = { ...this.checkRuns() };
        for (const check of checks) {
          skipped[check.id] = { status: 'skipped', output: '' };
        }
        this.checkRuns.set(skipped);
      }
      return true;
    }

    const runs: Record<string, CheckRunState> = { ...this.checkRuns() };
    for (const check of checks) {
      runs[check.id] = { status: 'idle', output: '' };
    }
    this.checkRuns.set({ ...runs });

    for (const check of checks) {
      runs[check.id] = { status: 'running', output: '' };
      this.checkRuns.set({ ...runs });
      try {
        const result = await this.tauri.runRepoCheck(
          path,
          check.command,
          check.trigger,
          opts?.commitMessage,
        );
        const output = [result.stdout, result.stderr].filter((s) => s.trim()).join('\n');
        runs[check.id] = {
          status: result.ok ? 'pass' : 'fail',
          output,
        };
        this.checkRuns.set({ ...runs });
        if (!result.ok) {
          if (!opts?.silent) {
            this.showError(`${check.name} failed`);
          }
          return false;
        }
      } catch (err) {
        runs[check.id] = {
          status: 'fail',
          output: this.formatError(err),
        };
        this.checkRuns.set({ ...runs });
        if (!opts?.silent) this.showError(err);
        return false;
      }
    }
    return true;
  }

  async runSingleCheck(
    check: RepoCheck,
    opts?: { commitMessage?: string; silent?: boolean },
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    const runs = { ...this.checkRuns() };
    runs[check.id] = { status: 'running', output: '' };
    this.checkRuns.set(runs);
    try {
      const result = await this.tauri.runRepoCheck(
        path,
        check.command,
        check.trigger,
        opts?.commitMessage,
      );
      const output = [result.stdout, result.stderr].filter((s) => s.trim()).join('\n');
      this.checkRuns.set({
        ...this.checkRuns(),
        [check.id]: { status: result.ok ? 'pass' : 'fail', output },
      });
      if (!result.ok && !opts?.silent) {
        this.showError(`${check.name} failed`);
      }
      return result.ok;
    } catch (err) {
      this.checkRuns.set({
        ...this.checkRuns(),
        [check.id]: { status: 'fail', output: this.formatError(err) },
      });
      if (!opts?.silent) this.showError(err);
      return false;
    }
  }

  async saveCheckScript(input: {
    id?: string;
    name: string;
    command: string;
    trigger: string;
    enabled?: boolean;
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showError('Open a repository first');
      return false;
    }
    try {
      const result = await this.tauri.saveCheckScript({ ...input, path });
      this.repoChecks.set(result);
      this.resetCheckRuns(result.checks);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async deleteCheckScript(id: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.deleteCheckScript(path, id);
      this.repoChecks.set(result);
      this.resetCheckRuns(result.checks);
    } catch (err) {
      this.showError(err);
    }
  }

  async setCheckEnabled(id: string, enabled: boolean): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.setCheckEnabled(path, id, enabled);
      this.repoChecks.set(result);
    } catch (err) {
      this.showError(err);
    }
  }

  async createCommit(
    message: string,
    amend = false,
    allowEmpty = false,
    opts?: { toast?: boolean; skipHooks?: boolean },
  ): Promise<{ ok: boolean; shortSha?: string }> {
    const path = this.currentRepo()?.path;
    if (!path) return { ok: false };
    if (!message.trim() && !allowEmpty) {
      this.showWarning('Write a commit message first');
      return { ok: false };
    }
    const status = this.status();
    if ((status?.conflicted.length ?? 0) > 0) {
      this.showToast('Resolve conflicts before committing', { kind: 'warning' });
      return { ok: false };
    }
    if (!amend && !allowEmpty && !status?.staged.length) {
      this.showToast('Stage at least one file before committing', { kind: 'warning' });
      return { ok: false };
    }
    if (amend && !(await this.confirmIfEnabled('confirmAmend', {
      title: 'Amend last commit?',
      message:
        'Amending rewrites the tip of this branch. If that commit was already pushed, you will need a force push with lease afterward.',
      confirmLabel: 'Amend',
    }))) {
      return { ok: false };
    }
    try {
      const result = await this.tauri.createCommit(
        path,
        message.trim(),
        amend,
        allowEmpty,
        opts?.skipHooks ?? false,
      );
      await this.refreshRepo();
      const shortSha = result.sha.slice(0, 7);
      if (opts?.toast !== false) {
        this.showToast(amend ? `Amended ${shortSha}` : `Committed ${shortSha}`, {
          kind: 'success',
          category: 'commit',
          undo: () => void this.tauri.undoLast(path).then(() => this.refreshRepo()),
        });
      }
      return { ok: true, shortSha };
    } catch (err) {
      this.showError(err);
      return { ok: false };
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

  async undoLastActionQuiet(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      await this.tauri.undoLast(path);
      await this.refreshRepo();
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

  async createBranch(
    name: string,
    startPoint?: string,
    checkout = true,
    opts?: { push?: boolean },
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path || !name.trim()) return false;
    const trimmed = sanitizeBranchName(name);
    if (!trimmed) return false;
    try {
      const result = await this.tauri.createBranch(path, trimmed, checkout, startPoint);
      await this.refreshRepo();
      if (opts?.push) {
        const pushed = await this.pushNewBranch(trimmed);
        if (!pushed) {
          this.showToast(result.message || `Created '${trimmed}' (push failed)`, {
            kind: 'warning',
            durationMs: 4000,
          });
          return true;
        }
        return true;
      }
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
          if (opts?.push) {
            await this.pushNewBranch(trimmed);
          }
          return result.message || `Stashed changes and created '${trimmed}'`;
        }))
      ) {
        return true;
      }
      this.showError(err);
      return false;
    }
  }

  async pushNewBranch(branch: string): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path || !branch.trim()) return false;
    const remote = this.pushRemoteName();
    if (!(await this.beginRemoteBusy('push'))) return false;
    try {
      const result = await this.tauri.push(path, {
        setUpstream: true,
        remote,
        branch: branch.trim(),
      });
      await this.refreshRepo();
      this.showToast(result.message || `Pushed ${branch.trim()} to ${remote}`, {
        kind: 'success',
        durationMs: 3200,
        category: 'push',
      });
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    } finally {
      this.remoteBusy.set(null);
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

  async fetchRemote(remote?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      if (this.remoteBusy() === 'fetch') this.remoteBusy.set(null);
      return;
    }
    if (!(await this.beginRemoteBusy('fetch'))) return;
    try {
      const result = await this.runRemoteWithAccountRetry(() =>
        this.withRepoMutation(() =>
          this.tauri.fetch(path, remote?.trim() || this.pushRemoteName()),
        ),
      );
      await this.refreshRepo();
      this.showToast(result.message || 'Fetched from remote', {
        kind: 'success',
        durationMs: 3200,
        category: 'fetch',
      });
    } catch (err) {
      this.showError(err);
    } finally {
      this.remoteBusy.set(null);
    }
  }

  async pruneRemote(name: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const remote = name.trim();
    if (!path || !remote) return;
    if (!(await this.beginRemoteBusy('fetch'))) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.pruneRemote(path, remote));
      await this.refreshRepo();
      this.showToast(result.message || `Pruned ${remote}`, {
        kind: 'success',
        durationMs: 3200,
        category: 'fetch',
      });
    } catch (err) {
      this.showError(err);
    } finally {
      this.remoteBusy.set(null);
    }
  }

  async pruneAllRemotes(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const remotes = this.remotes();
    if (remotes.length === 0) {
      this.showWarning('No remotes configured');
      return;
    }
    if (!(await this.beginRemoteBusy('fetch'))) return;
    try {
      let lastMessage = '';
      for (const remote of remotes) {
        const result = await this.withRepoMutation(() => this.tauri.pruneRemote(path, remote.name));
        lastMessage = result.message || `Pruned ${remote.name}`;
      }
      await this.refreshRepo();
      this.showToast(lastMessage || 'Pruned remotes', {
        kind: 'success',
        durationMs: 3200,
        category: 'fetch',
      });
    } catch (err) {
      this.showError(err);
    } finally {
      this.remoteBusy.set(null);
    }
  }

  async pullRemote(rebase = false): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      if (this.remoteBusy() === 'pull') this.remoteBusy.set(null);
      return;
    }
    if (!(await this.beginRemoteBusy('pull'))) return;
    try {
      const remote = this.pushRemoteName();
      const result = await this.runRemoteWithAccountRetry(() =>
        this.withRepoMutation(() =>
          rebase
            ? this.tauri.pullWithOptions(path, { rebase: true, remote })
            : this.tauri.pull(path, remote),
        ),
      );
      if (!result.ok) {
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      this.showToast(result.message || (rebase ? 'Pulled with rebase' : 'Pulled from remote'), {
        kind: 'success',
        durationMs: 3200,
        category: 'pull',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('conflict')) {
        await this.handleConflictResult({ ok: false, message });
        return;
      }
      this.showError(err);
    } finally {
      this.remoteBusy.set(null);
    }
  }

  async pushRemote(opts?: {
    toast?: boolean;
    skipHooks?: boolean;
    runChecks?: boolean;
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    if (this.currentBranchLocked()) {
      const branch = this.status()?.branch ?? 'branch';
      const reason = this.currentBranchLockReason();
      this.showWarning(
        reason
          ? `Branch '${branch}' is locked: ${reason}`
          : `Branch '${branch}' is locked. Unlock it before pushing.`,
      );
      return false;
    }

    let status = this.status();
    if (status && status.ahead > 0 && status.behind > 0) {
      const choice = await this.resolveDivergedPush(status);
      if (choice === 'cancel') return false;
      if (choice === 'force') {
        await this.openForcePushSafety(status.branch);
        return false;
      }

      await this.pullRemote(this.settings().defaultPullAction === 'rebase');
      status = this.status();
      if (!status || status.ahead === 0) return false;
      if (status.behind > 0) {
        this.showWarning('Still diverged after pull. Resolve conflicts, then push again.');
        return false;
      }
    }

    const pushOpts = await this.preparePushOptions(status);
    if (!pushOpts) return false;
    if (!(await this.beginRemoteBusy('push'))) return false;
    try {
      if (opts?.runChecks !== false && !opts?.skipHooks) {
        const ok = await this.runRepoChecks(['pre-push'], { silent: true });
        if (!ok) {
          this.showError('Push checks failed');
          return false;
        }
      }
      const skipHooks =
        !!opts?.skipHooks || this.hasDetectedChecks(['pre-push']);
      const result = await this.runRemoteWithAccountRetry(() =>
        this.tauri.push(path, {
          ...pushOpts,
          remote: this.pushRemoteName(),
          skipHooks,
        }),
      );
      await this.refreshRepo();
      if (opts?.toast !== false) {
        this.showToast(result.message || 'Pushed to remote', {
          kind: 'success',
          durationMs: 3200,
          category: 'push',
        });
      }
      return true;
    } catch (err) {
      const raw = rawErrorMessage(err);
      if (/non-fast-forward|rejected|fetch first/i.test(raw)) {
        await this.openForcePushSafety(status?.branch);
        return false;
      }
      this.showError(err);
      return false;
    } finally {
      this.remoteBusy.set(null);
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
    branchName?: string,
  ): Promise<{ setUpstream?: boolean } | null> {
    const branch = branchName?.trim() || status?.branch;
    if (!branch) return {};

    const local = this.localBranches().find((b) => b.name === branch);
    const hasUpstream = !!local?.upstream;
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
    const remote = this.pushRemoteName(branch);
    try {
      const result = await this.tauri.push(path, {
        forceWithLease: true,
        remote,
        branch: branch?.trim() || undefined,
      });
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

  private pushRemoteName(branch?: string | null): string | undefined {
    const local = branch?.trim()
      ? this.localBranches().find((b) => b.name === branch.trim())
      : null;
    const upstream = (local?.upstream ?? this.status()?.upstream)?.trim();
    if (upstream) {
      const parsed = parseRemoteRef(upstream);
      if (parsed) return parsed.remote;
    }
    return this.remotes()[0]?.name;
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
      const check = await this.testConnection(
        { kind: 'gitRemote', remote: name, url },
        { toast: false },
      );
      if (check.ok) this.showSuccess(check.message);
      else this.showWarning(`${result.message}. ${check.message}`);
    } catch (err) {
      this.showError(err);
    }
  }

  openRemoteTroubleshoot(err?: unknown): void {
    const raw = rawErrorMessage(err) || this.remoteTroubleshootError();
    this.remoteTroubleshootError.set(raw);
    this.remoteTroubleshootOpen.set(true);
    this.dismissToast();
    void this.refreshGithubGitStatus();
  }

  closeRemoteTroubleshoot(): void {
    this.remoteTroubleshootOpen.set(false);
    this.remoteTroubleshootError.set('');
  }

  async refreshGithubGitStatus(opts?: { force?: boolean }): Promise<void> {
    if (
      !opts?.force &&
      this.githubGitStatus() &&
      Date.now() - this.githubGitStatusAt < AppStore.GITHUB_GIT_STATUS_TTL_MS
    ) {
      return;
    }
    try {
      this.githubGitStatus.set(await this.tauri.githubGitStatus());
      this.githubGitStatusAt = Date.now();
    } catch {
      this.githubGitStatus.set(null);
    }
  }

  async setRepoRemoteProtocol(
    protocol: 'https' | 'ssh',
    opts?: { silent?: boolean },
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    this.githubGitBusy.set(true);
    try {
      const result = await this.tauri.setRepoRemoteProtocol(path, protocol);
      await this.refreshRepo();
      if (result.ok) {
        this.rememberGithubRepoAccount({ protocol });
        if (!opts?.silent) this.showSuccess(result.message);
      } else if (!opts?.silent) {
        this.showWarning(result.message);
      }
      return result.ok;
    } catch (err) {
      if (!opts?.silent) this.showError(err);
      return false;
    } finally {
      this.githubGitBusy.set(false);
    }
  }

  async switchGithubCliUser(login: string, opts?: { silent?: boolean }): Promise<boolean> {
    this.githubGitBusy.set(true);
    try {
      const result = await this.tauri.switchGithubCliUser(login);
      await this.refreshGithubGitStatus({ force: true });
      if (result.ok) {
        this.rememberGithubRepoAccount({ login });
        if (!opts?.silent) this.showSuccess(result.message);
      } else if (!opts?.silent) {
        this.showWarning(result.message);
      }
      return result.ok;
    } catch (err) {
      if (!opts?.silent) this.showError(err);
      return false;
    } finally {
      this.githubGitBusy.set(false);
    }
  }

  private githubOwnerForCurrentRepo(): string {
    return primaryGithubOwner(this.remotes());
  }

  private rememberGithubRepoAccount(partial?: {
    login?: string;
    protocol?: 'https' | 'ssh';
  }): void {
    const owner = this.githubOwnerForCurrentRepo();
    if (!owner) return;
    const current = this.settings().githubRepoAccounts[owner];
    const login = (partial?.login || current?.login || this.githubGitStatus()?.activeLogin || '').trim();
    const protocol =
      partial?.protocol ||
      current?.protocol ||
      (this.remotes().some((remote) => remoteProtocol(remote.fetchUrl) === 'ssh') &&
      !this.remotes().some((remote) => remoteProtocol(remote.fetchUrl) === 'https')
        ? 'ssh'
        : 'https');
    if (!login) return;
    if (current?.login === login && current.protocol === protocol) return;
    void this.saveSettings({
      githubRepoAccounts: {
        ...this.settings().githubRepoAccounts,
        [owner]: { login, protocol },
      },
    });
  }

  private async applyGithubRepoAccount(opts?: { silent?: boolean }): Promise<void> {
    if (this.githubGitBusy()) return;
    await this.refreshGithubGitStatus();
    const owner = this.githubOwnerForCurrentRepo();
    if (!owner) return;
    const accounts = this.githubGitStatus()?.accounts ?? [];
    const saved = this.settings().githubRepoAccounts[owner];
    const inferred = accounts.find((account) => account.login.toLowerCase() === owner);
    const login = saved?.login || inferred?.login || '';
    const protocol = saved?.protocol;
    if (login && login !== this.githubGitStatus()?.activeLogin) {
      const ok = await this.switchGithubCliUser(login, { silent: true });
      if (ok && !opts?.silent) {
        this.showInfo(`Using ${login} for ${owner}`);
      }
    }
    if (protocol !== 'https' && protocol !== 'ssh') return;
    const github = this.remotes().filter((remote) => /github\.com/i.test(remote.fetchUrl));
    const current =
      github.length && github.every((remote) => remoteProtocol(remote.fetchUrl) === protocol)
        ? protocol
        : github.some((remote) => remoteProtocol(remote.fetchUrl) === 'https') &&
            github.some((remote) => remoteProtocol(remote.fetchUrl) === 'ssh')
          ? 'mixed'
          : github.some((remote) => remoteProtocol(remote.fetchUrl) === 'ssh')
            ? 'ssh'
            : 'https';
    if (current !== protocol) {
      await this.setRepoRemoteProtocol(protocol, { silent: true });
    }
  }

  private async runRemoteWithAccountRetry<T>(action: () => Promise<T>): Promise<T> {
    try {
      const result = await action();
      this.rememberGithubRepoAccount();
      return result;
    } catch (err) {
      if (!isRemoteAccessError(rawErrorMessage(err))) throw err;
      const recovered = await this.recoverGithubRemoteAccess(rawErrorMessage(err));
      if (!recovered) throw err;
      const result = await action();
      this.rememberGithubRepoAccount();
      return result;
    }
  }

  private async recoverGithubRemoteAccess(raw: string): Promise<boolean> {
    await this.refreshGithubGitStatus();
    const github = this.remotes().filter((remote) => /github\.com/i.test(remote.fetchUrl));
    const ssh = github.some((remote) => remoteProtocol(remote.fetchUrl) === 'ssh');
    if (ssh && /repository not found|could not read from remote/i.test(raw)) {
      return this.setRepoRemoteProtocol('https', { silent: true });
    }
    const active = this.githubGitStatus()?.activeLogin ?? '';
    const next = (this.githubGitStatus()?.accounts ?? []).find(
      (account) => account.login && account.login !== active,
    );
    if (!next) return false;
    return this.switchGithubCliUser(next.login, { silent: true });
  }

  revealRefsGroup(group: string): void {
    this.setView('browse');
    this.pendingRefsReveal.set(group);
  }

  async setRemoteUrl(name: string, url: string, opts?: { silent?: boolean }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    try {
      const result = await this.tauri.setRemoteUrl(path, name, url);
      await this.refreshRepo();
      if (!opts?.silent) this.showToast(result.message);
      return result.ok;
    } catch (err) {
      if (!opts?.silent) this.showError(err);
      return false;
    }
  }

  async probeRemote(opts?: { url?: string; remote?: string }): Promise<ProbeRemoteOutput | null> {
    const path = this.currentRepo()?.path;
    if (!path) return null;
    try {
      return await this.tauri.probeRemote(path, opts);
    } catch (err) {
      return {
        ok: false,
        url: opts?.url?.trim() || '',
        protocol: 'other',
        message: this.formatError(err),
      };
    }
  }

  async verifySavedIntegration(
    provider: string,
  ): Promise<TestConnectionOutput | null> {
    if (
      provider !== 'github' &&
      provider !== 'gitlab' &&
      provider !== 'azureDevOps' &&
      provider !== 'jira'
    ) {
      return null;
    }
    const conn = this.settings().connections.find((c) => c.provider === provider);
    return this.testConnection(
      { kind: provider, connectionId: conn?.id },
      { toast: false },
    );
  }

  private async applyConnectionAccount(provider: string, account: string): Promise<void> {
    const cleaned = account.trim();
    if (!cleaned) return;
    const current = this.settings().connections;
    if (!current.some((c) => c.provider === provider && c.username !== cleaned)) return;
    await this.saveSettings({
      connections: current.map((c) =>
        c.provider === provider ? { ...c, username: cleaned } : c,
      ),
    });
  }

  async testConnection(
    input: TestConnectionInput,
    opts?: { toast?: boolean },
  ): Promise<TestConnectionOutput> {
    try {
      const result = await this.tauri.testConnection({
        ...input,
        path: input.path ?? this.currentRepo()?.path ?? '',
      });
      if (opts?.toast !== false) {
        if (result.ok) this.showSuccess(result.message);
        else this.showError(result.message);
      }
      return result;
    } catch (err) {
      const message = this.formatError(err);
      if (opts?.toast !== false) this.showError(err);
      return {
        ok: false,
        kind: input.kind,
        connectionId: input.connectionId ?? '',
        account: '',
        message,
        detail: message,
      };
    }
  }

  async testAllConnections(): Promise<TestConnectionOutput[]> {
    const results: TestConnectionOutput[] = [];
    const linked = this.settings().connections.filter(
      (c) =>
        (c.provider === 'github' ||
          c.provider === 'gitlab' ||
          c.provider === 'azureDevOps' ||
          c.provider === 'jira') &&
        (c.hasToken || c.token.trim()),
    );
    for (const conn of linked) {
      results.push(
        await this.testConnection(
          {
            kind: conn.provider as 'github' | 'gitlab' | 'azureDevOps' | 'jira',
            connectionId: conn.id,
          },
          { toast: false },
        ),
      );
    }
    results.push(
      await this.testConnection(
        {
          kind: 'ssh',
          path: this.currentRepo()?.path ?? '',
          remote: 'origin',
        },
        { toast: false },
      ),
    );
    if (this.currentRepo()) {
      results.push(
        await this.testConnection({ kind: 'gitRemote', remote: 'origin' }, { toast: false }),
      );
    }
    const passed = results.filter((r) => r.ok).length;
    const total = results.length;
    if (passed === total) this.showSuccess(`All ${total} connections responded`);
    else this.showWarning(`${passed}/${total} connections succeeded`);
    return results;
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
    this.openShortcutOverlay();
  }

  openShortcutOverlay(): void {
    this.shortcutOverlayOpen.set(true);
  }

  closeShortcutOverlay(): void {
    this.shortcutOverlayOpen.set(false);
  }

  openFileSearch(): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.fileSearchOpen.set(true);
  }

  closeFileSearch(): void {
    this.fileSearchOpen.set(false);
  }

  openSearchHit(hit: SearchHit): void {
    this.closeFileSearch();
    this.setView('browse');
    this.openFileBlame(hit.path);
  }

  async loadMoreCommits(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || this.loadingMoreCommits()) return;
    const next = Math.min(this.commitLogLimit() + 1000, 5000);
    if (next === this.commitLogLimit()) {
      this.commitLogHasMore.set(false);
      return;
    }
    this.loadingMoreCommits.set(true);
    try {
      const commits = await this.tauri.getCommitLog(path, next);
      this.commitLogLimit.set(next);
      this.commitLogHasMore.set(commits.length >= next && next < 5000);
      this.setCommitsIfChanged(commits);
    } catch (err) {
      this.showError(err);
    } finally {
      this.loadingMoreCommits.set(false);
    }
  }

  async searchRepo(query: string): Promise<SearchHit[]> {
    const path = this.currentRepo()?.path;
    if (!path) return [];
    return this.tauri.searchRepo(path, query);
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
      await this.refreshWorkingTree();
      this.showSuccess(result.message || `Ignored ${pattern}`);
    } catch (err) {
      this.showError(err);
    }
  }

  async openCreatePullRequest(head?: string): Promise<void> {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    const preferred = head?.trim() || null;
    if (!preferred && (!this.status()?.branch || this.status()?.isDetached)) {
      this.showWarning('Check out a branch before opening a pull request');
      return;
    }
    this.createPrPreferredHead.set(preferred);
    this.createPrDialogOpen.set(true);
  }

  closeCreatePrDialog(): void {
    this.createPrDialogOpen.set(false);
    this.createPrPreferredHead.set(null);
  }

  async savePrTemplate(input: { name: string; title: string; body: string }): Promise<void> {
    const name = input.name.trim();
    if (!name) return;
    const next: SavedPrTemplate = {
      id: `pr-${Date.now().toString(36)}`,
      name,
      title: input.title.trim(),
      body: input.body,
    };
    await this.saveSettings({
      prTemplates: [...this.settings().prTemplates, next],
    });
    this.showSuccess(`Saved template “${name}”`);
  }

  async deletePrTemplate(id: string): Promise<void> {
    await this.saveSettings({
      prTemplates: this.settings().prTemplates.filter((t) => t.id !== id),
    });
  }

  async submitCreatePullRequest(opts: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft: boolean;
    method: PrCreateMethod;
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    const remotes = this.remotes();
    if (!path) {
      this.showWarning('Open a repository first');
      return false;
    }
    const title = opts.title.trim();
    const head = opts.head.trim();
    const base = opts.base.trim();
    if (!title) {
      this.showWarning('Add a pull request title');
      return false;
    }
    if (!head || !base) {
      this.showWarning('Choose source and target branches');
      return false;
    }
    if (head === base) {
      this.showWarning('Source and target branches must be different');
      return false;
    }
    await this.saveSettings({ prCreateMethod: opts.method });

    if (opts.method === 'browser') {
      const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;
      if (!origin) {
        this.showWarning('No remotes configured');
        return false;
      }
      const url = buildCreatePullRequestUrl(
        origin.fetchUrl || origin.pushUrl,
        head,
        base,
        title,
        opts.body,
      );
      if (!url) {
        this.showWarning('Could not build a pull request URL from the remote');
        return false;
      }
      try {
        await this.tauri.openExternalUrl(url);
        this.closeCreatePrDialog();
        return true;
      } catch (err) {
        this.showError(err);
        return false;
      }
    }

    try {
      const result = await this.tauri.createPullRequest({
        path,
        title,
        body: opts.body,
        head,
        base,
        draft: opts.draft,
      });
      if (!result.ok) {
        this.showError(result.message);
        return false;
      }
      this.showSuccess(result.message);
      if (result.url) {
        try {
          await this.tauri.openExternalUrl(result.url);
        } catch {
          this.showInfo(result.url);
        }
      }
      this.closeCreatePrDialog();
      void this.refreshPullRequests('open', { force: true });
      return true;
    } catch (err) {
      this.showError(err);
      return false;
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
      await this.openConflictResolver(status.conflicted[0]?.path);
      return;
    }
    if (status.operation) {
      await this.continueOperation();
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
    this.loadingLabel.set('Cloning repository…');
    this.loading.set(true);
    const gen = ++this.repoLoadGen;
    this.snapshotCurrentRepo();
    try {
      const summary = await this.tauri.cloneRepository(url, destination);
      if (gen !== this.repoLoadGen) return;
      this.clearWorkingState();
      this.currentRepo.set(summary);
      this.upsertOpenRepo(summary);
      this.repos.set(await this.tauri.listRecentRepos());
      if (gen !== this.repoLoadGen) return;
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
    this.loadingLabel.set('Initializing repository…');
    this.loading.set(true);
    const gen = ++this.repoLoadGen;
    this.snapshotCurrentRepo();
    try {
      const summary = await this.tauri.initRepository(path);
      if (gen !== this.repoLoadGen) return;
      this.clearWorkingState();
      this.currentRepo.set(summary);
      this.upsertOpenRepo(summary);
      this.repos.set(await this.tauri.listRecentRepos());
      if (gen !== this.repoLoadGen) return;
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

  private async refreshWorkingTreeAndStashes(path: string): Promise<void> {
    const [status, stashes] = await Promise.all([
      this.tauri.getRepoStatus(path, this.statusFetchOpts()),
      this.tauri.listStashes(path),
    ]);
    if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
    const prev = this.status();
    this.status.set(status);
    this.artificial.set(artificialFromStatus(status));
    this.stashes.set(stashes);
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    this.lastWorkingTreeRefreshAt = Date.now();
    void this.syncConflictManager(prev, status);
  }

  async stashPush(message?: string, includeUntracked = false): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!this.beginGitAction(includeUntracked ? 'Stashing including untracked…' : 'Stashing…')) {
      return;
    }
    try {
      const result = await this.withRepoMutation(() =>
        this.tauri.stashPush(path, message, includeUntracked),
      );
      await this.refreshWorkingTreeAndStashes(path);
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    } finally {
      this.actionBusy.set(null);
    }
  }

  async stashPop(index: number): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!this.beginGitAction('Restoring stash…')) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashPop(path, index));
      await this.refreshWorkingTreeAndStashes(path);
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    } finally {
      this.actionBusy.set(null);
    }
  }

  async stashApply(index: number): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!this.beginGitAction('Applying stash…')) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashApply(path, index));
      await this.refreshWorkingTreeAndStashes(path);
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    } finally {
      this.actionBusy.set(null);
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
    if (!this.beginGitAction('Dropping stash…')) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashDrop(path, index));
      await this.refreshWorkingTreeAndStashes(path);
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    } finally {
      this.actionBusy.set(null);
    }
  }

  async stashClear(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const count = this.stashes().length;
    if (count === 0) {
      this.showToast('No stashes to drop', { kind: 'info' });
      return;
    }
    const ok = await this.prompts.ask({
      title: 'Drop all stashes?',
      message: `Permanently delete ${count} stash${count === 1 ? '' : 'es'}? This cannot be undone from Branchline.`,
      confirmLabel: 'Drop all',
      cancelLabel: 'Cancel',
      confirmOnly: true,
    });
    if (ok === null) return;
    if (!this.beginGitAction('Dropping stashes…')) return;
    try {
      const result = await this.withRepoMutation(() => this.tauri.stashClear(path));
      await this.refreshWorkingTreeAndStashes(path);
      this.showToast(result.message);
    } catch (err) {
      this.showError(err);
    } finally {
      this.actionBusy.set(null);
    }
  }

  async stashBranch(index: number): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const entry = this.stashes().find((s) => s.index === index);
    const suggested = suggestStashBranchName(entry?.message);
    const name = await this.prompts.ask({
      title: 'Branch from stash',
      message: `Create a branch from ${entry?.id ?? `stash@{${index}}`}, apply the stash, and drop it if that succeeds.`,
      label: 'Branch name',
      initialValue: suggested,
      confirmLabel: 'Create branch',
      mono: true,
    });
    if (!name?.trim()) return;
    try {
      const result = await this.withRepoMutation(() =>
        this.tauri.stashBranch(path, index, name.trim()),
      );
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

  async pushBranch(name: string): Promise<boolean> {
    const path = this.currentRepo()?.path;
    const branch = name.trim();
    if (!path || !branch) return false;
    const local = this.localBranches().find((b) => b.name === branch);
    if (local?.isCurrent || this.status()?.branch === branch) {
      return this.pushRemote();
    }
    if (this.isBranchLocked(branch)) {
      const reason = local?.lockReason;
      this.showWarning(
        reason
          ? `Branch '${branch}' is locked: ${reason}`
          : `Branch '${branch}' is locked. Unlock it before pushing.`,
      );
      return false;
    }

    const pushOpts = await this.preparePushOptions(this.status(), branch);
    if (!pushOpts) return false;
    if (!(await this.beginRemoteBusy('push'))) return false;
    try {
      const result = await this.tauri.push(path, {
        ...pushOpts,
        remote: this.pushRemoteName(branch),
        branch,
      });
      await this.refreshRepo();
      this.showToast(result.message || `Pushed ${branch}`, {
        kind: 'success',
        durationMs: 3200,
        category: 'push',
      });
      return true;
    } catch (err) {
      const raw = rawErrorMessage(err);
      if (/non-fast-forward|rejected|fetch first/i.test(raw)) {
        await this.openForcePushSafety(branch);
        return false;
      }
      this.showError(err);
      return false;
    } finally {
      this.remoteBusy.set(null);
    }
  }

  async setBranchUpstream(branch: string, upstream: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const name = branch.trim();
    const remoteRef = upstream.trim();
    if (!path || !name || !remoteRef) return;
    await this.runGitRefresh(
      ['branch', `--set-upstream-to=${remoteRef}`, name],
      `Set upstream of ${name} to ${remoteRef}`,
    );
  }

  async unsetBranchUpstream(branch: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const name = branch.trim();
    if (!path || !name) return;
    await this.runGitRefresh(['branch', '--unset-upstream', name], `Stopped tracking on ${name}`);
  }

  async fastForwardTo(target: string, branch?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const onto = target.trim();
    if (!path || !onto) return;
    const local = branch?.trim();
    const current = this.status()?.branch;
    if (local && current && local !== current) {
      await this.runGitRefresh(
        ['fetch', '.', `${onto}:${local}`],
        `Fast-forwarded ${local} to ${onto}`,
      );
      return;
    }
    await this.runGitRefresh(['merge', '--ff-only', onto], `Fast-forwarded to ${onto}`);
  }

  async pushTag(name: string, remote?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const tag = name.trim();
    if (!path || !tag) return;
    const dest = remote?.trim() || this.pushRemoteName() || this.remotes()[0]?.name;
    if (!dest) {
      this.showWarning('No remote configured');
      return;
    }
    await this.runGitRefresh(['push', dest, `refs/tags/${tag}`], `Pushed tag ${tag} to ${dest}`);
  }

  private async runGitRefresh(args: string[], fallback: string): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    try {
      const result = await this.withRepoMutation(() => this.tauri.runGitCommand(path, args));
      const message = result.stdout.trim() || result.stderr.trim() || fallback;
      if (!result.ok) {
        if (message.toLowerCase().includes('conflict')) {
          await this.handleConflictResult({ ok: false, message });
          return false;
        }
        this.showError(message);
        return false;
      }
      await this.refreshRepo();
      this.showToast(message, { kind: 'success' });
      return true;
    } catch (err) {
      const message = this.formatError(err);
      if (message.toLowerCase().includes('conflict')) {
        await this.handleConflictResult({ ok: false, message });
        return false;
      }
      this.showError(err);
      return false;
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

  async openConflictInIde(
    editor: 'auto' | 'cursor' | 'vscode' = 'auto',
    mode: 'file' | 'merge' = 'file',
    filePath?: string,
  ): Promise<void> {
    const repo = this.currentRepo()?.path;
    const target =
      filePath?.trim() ||
      this.conflictResolverPath() ||
      this.status()?.conflicted?.[0]?.path ||
      this.selectedDiffPath();
    if (!repo || !target) {
      this.showToast('No conflicted file to open', { kind: 'info' });
      return;
    }
    const label =
      editor === 'cursor' ? 'Cursor' : editor === 'vscode' ? 'VS Code' : 'editor';
    try {
      if (!this.detectedEditors()) {
        await this.refreshDetectedEditors();
      }
      const detected = this.detectedEditors();
      const result = await this.tauri.openConflictInIde(repo, target, {
        editor,
        mode,
        cursorPath: detected?.cursorPath,
        vscodePath: detected?.vscodePath,
        wait: false,
        stageIfResolved: false,
      });
      if (!result.ok) {
        this.showWarning(result.message);
        return;
      }
      this.showSuccess(
        `${result.message} Save when done — Branchline marks it resolved when conflict markers are gone.`,
      );
    } catch (err) {
      this.showError(err);
    }
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
        runGitCommand: (path, args) =>
          this.tauri.runGitCommand(path, args, { externalTool: true }),
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
        runGitCommand: (path, args) =>
          this.tauri.runGitCommand(path, args, { externalTool: true }),
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
      await this.advanceConflictResolverAfter(path);
    } catch (err) {
      this.showError(err);
    }
  }

  async openConflictResolver(filePath?: string): Promise<void> {
    const repo = this.currentRepo()?.path;
    const conflicted = this.status()?.conflicted ?? [];
    const target = filePath?.trim() || conflicted[0]?.path || this.selectedDiffPath();
    if (!repo || !target) {
      this.showToast('No conflicted file to resolve', { kind: 'info' });
      return;
    }
    try {
      void this.refreshDetectedEditors();
      const sides = await this.tauri.getConflictSides(repo, target);
      this.conflictResolverPath.set(target);
      this.conflictResolver.set(sides);
      this.conflictResolverDraft.set(
        sides.binary ? '' : sides.working || sides.ours || sides.theirs || sides.base,
      );
      this.conflictDraftDirty = false;
      this.conflictResolverOpen.set(true);
    } catch (err) {
      this.showError(err);
    }
  }

  closeConflictResolver(): void {
    this.conflictResolverOpen.set(false);
    this.conflictResolverPath.set(null);
    this.conflictResolver.set(null);
    this.conflictResolverDraft.set('');
    this.conflictDraftDirty = false;
  }

  setConflictResolverDraft(content: string): void {
    this.conflictResolverDraft.set(content);
    this.conflictDraftDirty = true;
  }

  useConflictSide(side: 'base' | 'ours' | 'theirs' | 'working'): void {
    const sides = this.conflictResolver();
    if (!sides || sides.binary) return;
    const next =
      side === 'base'
        ? sides.base
        : side === 'ours'
          ? sides.ours
          : side === 'theirs'
            ? sides.theirs
            : sides.working;
    this.conflictResolverDraft.set(next);
    this.conflictDraftDirty = true;
  }

  async saveConflictResolution(): Promise<void> {
    const repo = this.currentRepo()?.path;
    const filePath = this.conflictResolverPath();
    const sides = this.conflictResolver();
    if (!repo || !filePath || !sides) return;
    if (sides.binary) {
      this.showWarning('Binary conflicts need an external merge tool');
      return;
    }
    try {
      const result = await this.tauri.resolveConflictFile(
        repo,
        filePath,
        this.conflictResolverDraft(),
      );
      if (!result.ok) {
        this.showWarning(result.message);
        return;
      }
      this.conflictDraftDirty = false;
      await this.refreshWorkingTree();
      this.showSuccess(result.message);
      await this.advanceConflictResolverAfter(filePath);
    } catch (err) {
      this.showError(err);
    }
  }

  async stageConflictFile(path?: string): Promise<void> {
    const target = path?.trim() || this.conflictResolverPath();
    if (!target) return;
    await this.stagePaths([target]);
    this.showSuccess(`Marked ${target} as resolved`);
    if (this.conflictResolverOpen() && this.conflictResolverPath() === target) {
      await this.advanceConflictResolverAfter(target);
    }
  }

  private bindConflictFocusWatch(): void {
    if (this.conflictFocusBound || typeof document === 'undefined') return;
    this.conflictFocusBound = true;
    const maybeRefresh = (): void => {
      if (!this.showConflictBanner() && !this.conflictResolverOpen()) return;
      if (this.conflictIdeBusy()) return;
      if (Date.now() - this.lastWorkingTreeRefreshAt < 2500) return;
      void this.refreshWorkingTree();
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      maybeRefresh();
    });
    window.addEventListener('focus', () => {
      maybeRefresh();
    });
  }

  private async syncConflictManager(
    prev: RepoStatus | null,
    next: RepoStatus,
  ): Promise<void> {
    if (this.conflictSyncInFlight || this.conflictIdeBusy()) return;
    this.conflictSyncInFlight = true;
    let autoStagePaths: string[] = [];
    try {
      const prevPaths = new Set((prev?.conflicted ?? []).map((f) => f.path));
      const nextPaths = new Set(next.conflicted.map((f) => f.path));
      const resolvedExternally = [...prevPaths].filter((p) => !nextPaths.has(p));

      if (
        resolvedExternally.length &&
        !this.conflictResolverOpen() &&
        prev &&
        prev.conflicted.length > next.conflicted.length
      ) {
        const n = resolvedExternally.length;
        this.showInfo(
          n === 1
            ? `Conflict cleared: ${resolvedExternally[0]}`
            : `${n} conflicts cleared externally`,
        );
      }

      autoStagePaths = next.conflicted
        .filter((f) => f.markersCleared === true)
        .map((f) => f.path)
        .filter(
          (p) =>
            !(this.conflictDraftDirty && this.conflictResolverPath() === p),
        );

      if (!this.conflictResolverOpen()) return;

      const current = this.conflictResolverPath();
      if (current && !nextPaths.has(current)) {
        this.showSuccess(`${this.fileBaseName(current)} resolved`);
        await this.advanceConflictResolverAfter(current, next);
        return;
      }

      if (
        current &&
        nextPaths.has(current) &&
        !this.conflictDraftDirty &&
        !autoStagePaths.includes(current)
      ) {
        await this.reloadConflictResolverFromDisk(current);
      }
    } finally {
      this.conflictSyncInFlight = false;
    }

    if (autoStagePaths.length) {
      await this.autoStageClearedConflicts(autoStagePaths);
    }
  }

  private async autoStageClearedConflicts(paths: string[]): Promise<void> {
    const repo = this.currentRepo()?.path;
    const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
    if (!repo || !unique.length || this.conflictAutoStageInFlight) return;
    this.conflictAutoStageInFlight = true;
    try {
      await this.withRepoMutation(() => this.tauri.stagePaths(repo, unique));
      await this.refreshWorkingTree();
      const n = unique.length;
      this.showSuccess(
        n === 1
          ? `Resolved ${this.fileBaseName(unique[0])} (markers cleared)`
          : `Resolved ${n} files (markers cleared)`,
        undefined,
        'conflicts',
      );
      if (this.conflictResolverOpen()) {
        const current = this.conflictResolverPath();
        if (current && unique.includes(current)) {
          await this.advanceConflictResolverAfter(current);
        }
      }
    } catch (err) {
      this.showError(err);
    } finally {
      this.conflictAutoStageInFlight = false;
    }
  }

  private async reloadConflictResolverFromDisk(path: string): Promise<void> {
    const repo = this.currentRepo()?.path;
    if (!repo || !this.conflictResolverOpen()) return;
    try {
      const sides = await this.tauri.getConflictSides(repo, path);
      const prev = this.conflictResolver();
      if (
        prev &&
        prev.path === sides.path &&
        prev.working === sides.working &&
        prev.binary === sides.binary &&
        prev.hasMarkers === sides.hasMarkers &&
        prev.unmerged === sides.unmerged
      ) {
        return;
      }
      this.conflictResolverPath.set(path);
      this.conflictResolver.set(sides);
      this.conflictResolverDraft.set(
        sides.binary ? '' : sides.working || sides.ours || sides.theirs || sides.base,
      );
      this.conflictDraftDirty = false;
      if (
        !sides.binary &&
        prev?.hasMarkers === true &&
        sides.hasMarkers === false &&
        sides.unmerged !== false
      ) {
        await this.autoStageClearedConflicts([path]);
      }
    } catch {
      /* keep previous sides if disk read fails mid-edit */
    }
  }

  private async advanceConflictResolverAfter(
    resolvedPath: string,
    statusOverride?: RepoStatus,
  ): Promise<void> {
    if (!this.conflictResolverOpen()) return;
    const status = statusOverride ?? this.status();
    const remaining = status?.conflicted ?? [];
    const next = remaining.find((f) => f.path !== resolvedPath) ?? remaining[0];
    if (next) {
      await this.openConflictResolver(next.path);
      return;
    }
    this.closeConflictResolver();
    if (status?.operation) {
      this.showInfo('All conflicts resolved — Continue when ready');
    }
  }

  private fileBaseName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }

  async handleGraphDrop(sourceSha: string, targetSha: string): Promise<void> {
    if (!sourceSha || !targetSha || sourceSha === targetSha) return;
    const target = this.commits().find((c) => c.sha === targetSha);
    const tipBranches = this.localBranches().filter(
      (b) => b.tipSha === targetSha || target?.refs.includes(b.name),
    );
    const branchOptions = tipBranches.flatMap((b) => [
      {
        value: `merge:${b.name}`,
        label: `Merge ${b.name} into HEAD`,
        hint: 'Bring that branch into your current branch',
      },
      {
        value: `rebase:${b.name}`,
        label: `Rebase HEAD onto ${b.name}`,
        hint: 'Replay your commits on top of that branch',
      },
    ]);
    const options = [
      {
        value: 'cherry-pick',
        label: `Cherry-pick ${sourceSha.slice(0, 7)} onto HEAD`,
        hint: 'Copy this commit onto your current branch',
      },
      ...branchOptions,
    ];
    const choice = await this.selects.ask({
      title: 'Drop action',
      message: `Dropped ${sourceSha.slice(0, 7)} onto ${targetSha.slice(0, 7)}.`,
      label: 'Action',
      options,
      initialValue: 'cherry-pick',
      confirmLabel: 'Run',
    });
    if (!choice) return;
    if (choice === 'cherry-pick') {
      await this.openCherryPickPreview([sourceSha]);
      return;
    }
    if (choice.startsWith('merge:')) {
      await this.mergeBranch(choice.slice('merge:'.length));
      return;
    }
    if (choice.startsWith('rebase:')) {
      await this.rebaseOnto(choice.slice('rebase:'.length));
    }
  }

  reorderRebaseStep(fromSha: string, toSha: string): void {
    if (!fromSha || !toSha || fromSha === toSha) return;
    this.interactiveRebaseSteps.update((steps) => {
      const from = steps.findIndex((s) => s.sha === fromSha);
      const to = steps.findIndex((s) => s.sha === toSha);
      if (from < 0 || to < 0) return steps;
      const copy = steps.slice();
      const [item] = copy.splice(from, 1);
      copy.splice(to, 0, item);
      return copy;
    });
  }

  async updateSubmodules(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.updateSubmodules(path);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async syncSubmodules(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.syncSubmodules(path);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async updateSubmodule(submodulePath: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.updateSubmodule(path, submodulePath);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async lfsPull(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.lfsPull(path);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async markConflictResolved(path: string): Promise<void> {
    await this.stageConflictFile(path);
  }

  private async handleConflictResult(result: MutationOutput): Promise<void> {
    await this.refreshWorkingTree();
    this.showToast(result.message, { kind: 'warning' });
    this.setBrowseTab('files');
    const first = this.status()?.conflicted?.[0]?.path;
    if (first) {
      this.selectedDiffPath.set(first);
      await this.openConflictResolver(first);
    }
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

  async startReleaseFlow(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return;
    }
    this.openReleaseTab();
    try {
      let status = await this.tauri.getReleaseStatus(path);
      if (!status.available) {
        const configured = await this.ensureReleaseSetup(path, status.message);
        if (!configured) return;
        status = await this.tauri.getReleaseStatus(path);
        if (!status.available) {
          this.showWarning(status.message || 'Release is not configured yet.');
          return;
        }
      }
      const cfg = status.config;
      if (!cfg) return;

      const branchNames = this.localBranches().map((b) => b.name);
      const branches = [
        ...new Set(
          [cfg.branch, status.currentBranch ?? '', ...branchNames].filter(
            (name): name is string => !!name.trim(),
          ),
        ),
      ];

      const setup = await this.releaseDialog.ask({
        productName: cfg.productName,
        currentVersion: status.currentVersion ?? '0.0.0',
        currentBranch: status.currentBranch ?? cfg.branch,
        dirty: status.dirty,
        config: cfg,
        branches,
      });
      if (!setup) return;

      const opts = {
        bump: setup.bump,
        push: setup.push,
        message: setup.message,
        branch: setup.branch,
        allowDirty: setup.allowDirty,
        preid: setup.preid,
        tagMessage: setup.tagMessage,
      };
      const preview = await this.tauri.previewRelease(path, opts);
      if (!preview.ok) {
        await this.prompts.ask({
          title: 'Cannot release yet',
          message: preview.message,
          confirmLabel: 'OK',
          cancelLabel: 'Close',
          confirmOnly: true,
        });
        return;
      }

      const devSkipped = preview.devSkippedFiles ?? [];
      const devRelease = devSkipped.length > 0;
      const confirmed = await this.prompts.ask({
        title: `Release ${preview.productName} ${preview.nextVersion}?`,
        message: [
          `${preview.currentVersion} → ${preview.nextVersion} (${preview.tag})`,
          `Commit: ${preview.commitMessage}`,
          `Tag: ${preview.tagMessage}`,
          preview.willPush
            ? devRelease
              ? 'Will bump package.json, commit, tag, then finish Tauri/Cargo sync and push in the background (tauri:dev may restart once).'
              : 'Will bump, commit, tag, push, and track GitHub Actions until every platform build is published.'
            : 'Will bump, commit, and tag locally — you can push from the Release screen afterward.',
          `Files: ${preview.files.join(', ')}`,
          devRelease && preview.willPush
            ? `Background sync: ${devSkipped.join(', ')}`
            : devRelease
              ? `Dev mode skips ${devSkipped.join(', ')} until you push.`
              : '',
        ]
          .filter(Boolean)
          .join('\n'),
        confirmLabel: preview.willPush ? 'Release & deploy' : 'Create release',
        cancelLabel: 'Cancel',
        confirmOnly: true,
      });
      if (confirmed === null) return;

      this.beginReleaseActivity({
        path,
        productName: preview.productName,
        currentVersion: preview.currentVersion,
        nextVersion: preview.nextVersion,
        tag: preview.tag,
        willPush: preview.willPush,
      });

      try {
        await this.withRepoMutation(async () => {
          if (this.isDummyBackend) {
            await this.simulateReleaseProgress(preview.willPush);
            if (preview.willPush) {
              this.notifyReleaseOutcome('started', {
                productName: preview.productName,
                version: preview.nextVersion,
                tag: preview.tag,
              });
              void this.watchReleaseDeploy(path, preview.tag);
              return;
            }
            this.notifyReleaseOutcome('tagged', {
              productName: preview.productName,
              version: preview.nextVersion,
              tag: preview.tag,
            });
            return;
          }
          const result = await this.tauri.runRelease(path, opts);
          await this.refreshRepo();
          if (!result.ok) {
            this.applyReleaseProgress({
              path,
              phase: 'error',
              message: result.message,
              version: preview.nextVersion,
              tag: preview.tag,
            });
            this.notifyReleaseOutcome('failure', {
              productName: preview.productName,
              version: preview.nextVersion,
              tag: preview.tag,
              message: result.message,
            });
            return;
          }
          if (preview.willPush) {
            this.applyReleaseProgress({
              path,
              phase: 'deploying',
              message: result.message,
              version: preview.nextVersion,
              tag: preview.tag,
            });
            this.notifyReleaseOutcome('started', {
              productName: preview.productName,
              version: preview.nextVersion,
              tag: preview.tag,
              message: result.message,
            });
            this.releaseBusy.set(true);
            void this.watchReleaseDeploy(path, preview.tag);
            return;
          }
          this.applyReleaseProgress(
            {
              path,
              phase: 'done',
              message: result.message,
              version: preview.nextVersion,
              tag: preview.tag,
            },
            { needsPush: true },
          );
          this.notifyReleaseOutcome('tagged', {
            productName: preview.productName,
            version: preview.nextVersion,
            tag: preview.tag,
            message: result.message,
          });
        });
      } catch (err) {
        const message = this.humanizeError(rawErrorMessage(err) || err);
        this.applyReleaseProgress({
          path,
          phase: 'error',
          message,
          version: preview.nextVersion,
          tag: preview.tag,
        });
        this.notifyReleaseOutcome('failure', {
          productName: preview.productName,
          version: preview.nextVersion,
          tag: preview.tag,
          message,
        });
      } finally {
        const activity = this.releaseActivity();
        if (!preview.willPush || activity?.phase === 'error') {
          this.releaseBusy.set(false);
        }
      }
    } catch (err) {
      this.showError(err);
    }
  }

  async saveReleaseSetup(input: {
    productName: string;
    branch: string;
    push: boolean;
    files: ReleaseSetupFileHint[];
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    try {
      const result = await this.tauri.saveReleaseConfig(path, input);
      this.showSuccess(result.message);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  private async ensureReleaseSetup(path: string, reason?: string): Promise<boolean> {
    const proceed = await this.prompts.ask({
      title: 'Set up Release',
      message: [
        reason?.trim() || 'Release is not configured for this repository.',
        'Create release.config.json now so Start release can run end-to-end?',
      ].join('\n'),
      confirmLabel: 'Set up',
      cancelLabel: 'Cancel',
      confirmOnly: true,
    });
    if (proceed === null) return false;
    const hints = await this.tauri.getReleaseSetupHints(path);
    const productName = await this.prompts.ask({
      title: 'Release setup',
      message: 'Choose the product name used in release messages and tags.',
      label: 'Product name',
      initialValue: hints.productName,
      confirmLabel: 'Next',
      required: true,
    });
    if (productName === null) return false;
    const branch = await this.prompts.ask({
      title: 'Release setup',
      message: 'Choose the branch where releases should run.',
      label: 'Release branch',
      initialValue: hints.branch,
      confirmLabel: 'Next',
      required: true,
    });
    if (branch === null) return false;
    const pushChoice = await this.selects.ask({
      title: 'Release setup',
      message: 'Should release push commit and tags by default?',
      label: 'Default push behavior',
      options: [
        { value: 'yes', label: 'Push by default (recommended)' },
        { value: 'no', label: 'Tag only by default' },
      ],
      initialValue: hints.pushDefault ? 'yes' : 'no',
      confirmLabel: 'Next',
    });
    if (pushChoice !== 'yes' && pushChoice !== 'no') return false;
    const availableFiles = hints.suggestedFiles ?? [];
    if (!availableFiles.length) {
      this.showWarning('No version files were detected for release setup.');
      return false;
    }
    const fileChoice = await this.selects.ask({
      title: 'Release setup',
      message: availableFiles.map((file) => `• ${file.path}`).join('\n'),
      label: 'Version files',
      options: [
        { value: 'all', label: 'Use all detected version files' },
        {
          value: 'package',
          label: 'Use package.json only',
          hint: 'Only available when package.json is detected',
        },
      ],
      initialValue: 'all',
      confirmLabel: 'Create config',
    });
    if (fileChoice !== 'all' && fileChoice !== 'package') return false;
    const packageOnly = availableFiles.filter((file) => file.path === 'package.json');
    const files = fileChoice === 'package' && packageOnly.length ? packageOnly : availableFiles;
    const saved = await this.saveReleaseSetup({
      productName: productName.trim(),
      branch: branch.trim(),
      push: pushChoice === 'yes',
      files,
    });
    if (!saved) return false;
    await this.refreshRepo();
    return true;
  }

  async pushReleaseTags(): Promise<boolean> {
    const path = this.currentRepo()?.path;
    const activity = this.releaseActivity();
    if (!path || !activity) return false;
    this.releaseBusy.set(true);
    try {
      const result = await this.tauri.pushReleaseTags(path);
      await this.refreshRepo();
      this.applyReleaseProgress(
        {
          path,
          phase: 'deploying',
          message: result.message,
          version: activity.nextVersion,
          tag: activity.tag,
        },
        { needsPush: false },
      );
      this.notifyReleaseOutcome('started', {
        productName: activity.productName,
        version: activity.nextVersion,
        tag: activity.tag,
        message: result.message,
      });
      void this.watchReleaseDeploy(path, activity.tag);
      return true;
    } catch (err) {
      const message = this.humanizeError(rawErrorMessage(err) || err);
      this.notifyReleaseOutcome('failure', {
        productName: activity.productName,
        version: activity.nextVersion,
        tag: activity.tag,
        message,
      });
      return false;
    } finally {
      if (this.releaseActivity()?.phase !== 'deploying') {
        this.releaseBusy.set(false);
      }
    }
  }

  async openReleaseDeployRun(): Promise<void> {
    const url = this.releaseActivity()?.deployRunUrl;
    if (!url) return;
    try {
      await this.tauri.openExternalUrl(url);
    } catch {
      this.showWarning(`Could not open workflow run. Open manually: ${url}`);
    }
  }

  async openReleasePage(): Promise<void> {
    const url = this.releaseActivity()?.releaseUrl;
    if (!url) return;
    try {
      await this.tauri.openExternalUrl(url);
    } catch {
      this.showWarning(`Could not open release page. Open manually: ${url}`);
    }
  }

  async refreshReleaseDeploy(): Promise<void> {
    const path = this.currentRepo()?.path;
    const activity = this.releaseActivity();
    if (!path || !activity || !sameRepoPath(activity.path, path) || !activity.tag) return;
    if (!activity.willPush || activity.needsPush) return;
    const phase =
      activity.phase === 'done' || activity.phase === 'error' || activity.phase === 'idle'
        ? 'deploying'
        : activity.phase;
    this.applyReleaseProgress(
      {
        path,
        phase,
        message: 'Checking GitHub Actions…',
        version: activity.nextVersion,
        tag: activity.tag,
      },
      { needsRefresh: false },
    );
    this.releaseBusy.set(true);
    if (this.lastReleaseNoticeKey.endsWith(':paused')) this.lastReleaseNoticeKey = '';
    this.openReleaseTab();
    void this.watchReleaseDeploy(path, activity.tag);
  }

  private pauseReleaseTracking(
    path: string,
    tag: string,
    version: string,
    message: string,
    extras?: Partial<
      Pick<
        ReleaseActivity,
        | 'deployRunUrl'
        | 'releaseUrl'
        | 'websiteUrl'
        | 'actionsPageUrl'
        | 'repoUrl'
        | 'deployJobs'
      >
    >,
  ): void {
    const current = this.releaseActivity();
    const phase =
      current &&
      current.phase !== 'done' &&
      current.phase !== 'error' &&
      current.phase !== 'idle'
        ? current.phase
        : 'deploying';
    this.releaseBusy.set(false);
    this.applyReleaseProgress(
      {
        path,
        phase,
        message,
        version,
        tag,
      },
      { ...extras, needsRefresh: true },
    );
    this.notifyReleaseOutcome('paused', {
      productName: current?.productName,
      version,
      tag,
      message,
    });
    this.stopReleaseDeployPoll();
  }

  private async watchReleaseDeploy(path: string, tag: string): Promise<void> {
    this.stopReleaseDeployPoll();
    if (this.view() !== 'release') return;
    const activity = this.releaseActivity();
    if (!activity) return;
    let attempts = 0;
    let errors = 0;
    const poll = async (): Promise<void> => {
      if (this.view() !== 'release') {
        this.stopReleaseDeployPoll();
        return;
      }
      attempts += 1;
      const current = this.releaseActivity();
      if (!current || !sameRepoPath(current.path, path) || current.tag !== tag) {
        this.stopReleaseDeployPoll();
        return;
      }
      try {
        const result = await this.tauri.pollReleaseDeploy(path, tag);
        if (this.view() !== 'release') {
          this.stopReleaseDeployPoll();
          return;
        }
        errors = 0;
        const phase = normalizeReleasePhase(result.phase);
        const deployExtras = {
          deployRunUrl: result.runUrl ?? current.deployRunUrl ?? null,
          releaseUrl: result.releaseUrl ?? current.releaseUrl ?? null,
          websiteUrl: result.websiteUrl ?? current.websiteUrl ?? null,
          actionsPageUrl: result.actionsPageUrl ?? current.actionsPageUrl ?? null,
          repoUrl: result.repoUrl ?? current.repoUrl ?? null,
          deployJobs: result.jobs?.length ? result.jobs : current.deployJobs ?? [],
          needsPush: false,
          needsRefresh: false,
        };
        this.applyReleaseProgress(
          {
            path,
            phase,
            message: result.message,
            version: current.nextVersion,
            tag,
          },
          deployExtras,
        );
        const hadReleaseUrl = !!current.releaseUrl;
        const nextUrl = deployExtras.releaseUrl;
        if (!hadReleaseUrl && nextUrl) {
          const notes = (this.releaseActivity()?.notes ?? '').trim();
          if (notes && !this.releaseActivity()?.notesSynced) {
            void this.publishReleaseNotesIfPossible();
          } else if (!notes) {
            void this.loadGitHubReleaseNotes();
          }
        }
        if (result.status === 'success') {
          this.releaseBusy.set(false);
          const doneMessage =
            result.message.trim() ||
            `Release ${tag} is live — waiting for users to get the update banner (next app launch/check)`;
          this.applyReleaseProgress(
            {
              path,
              phase: 'done',
              message: doneMessage,
              version: current.nextVersion,
              tag,
            },
            deployExtras,
          );
          this.notifyReleaseOutcome('success', {
            productName: current.productName,
            version: current.nextVersion,
            tag,
            message: doneMessage,
          });
          this.stopReleaseDeployPoll();
          return;
        }
        if (result.status === 'failure') {
          this.releaseBusy.set(false);
          this.applyReleaseProgress(
            {
              path,
              phase: 'error',
              message: result.message,
              version: current.nextVersion,
              tag,
            },
            deployExtras,
          );
          this.notifyReleaseOutcome('failure', {
            productName: current.productName,
            version: current.nextVersion,
            tag,
            message: result.message,
          });
          this.stopReleaseDeployPoll();
          return;
        }
        if (result.status === 'unavailable') {
          this.pauseReleaseTracking(path, tag, current.nextVersion, result.message, deployExtras);
          return;
        }
        const failedJob = (result.jobs ?? []).find((job) => {
          const conclusion = job.conclusion?.trim() ?? '';
          return conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out';
        });
        if (failedJob) {
          this.notifyReleaseOutcome('job-failed', {
            productName: current.productName,
            version: current.nextVersion,
            tag,
            message: `${failedJob.name} failed`,
          });
        }
      } catch {
        errors += 1;
        if (errors >= 8) {
          this.pauseReleaseTracking(
            path,
            tag,
            current.nextVersion,
            'Lost contact with GitHub. Refresh to keep tracking this release.',
          );
          return;
        }
      }
      if (this.view() !== 'release') {
        this.stopReleaseDeployPoll();
        return;
      }
      if (attempts >= 720) {
        this.pauseReleaseTracking(
          path,
          tag,
          current.nextVersion,
          'Still building after an hour — refresh to keep watching, or open GitHub Actions.',
        );
        return;
      }
      const delay = attempts < 24 ? 5000 : 8000;
      this.releaseDeployPollTimer = window.setTimeout(() => {
        void poll();
      }, delay);
    };
    this.releaseDeployPollTimer = window.setTimeout(() => {
      void poll();
    }, 2000);
  }

  async deleteTag(name: string): Promise<void> {
    await this.openSafety('deleteTag', name);
  }

  async forcePush(branchName?: string): Promise<void> {
    const branch = branchName?.trim() || this.status()?.branch || undefined;
    if (branch && this.isBranchLocked(branch)) {
      const reason = this.localBranches().find((b) => b.name === branch)?.lockReason;
      this.showWarning(
        reason
          ? `Branch '${branch}' is locked: ${reason}`
          : `Branch '${branch}' is locked. Unlock it before force-pushing.`,
      );
      return;
    }
    await this.openForcePushSafety(branch);
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

    const goneCount = targets.filter((b) => b.upstreamGone).length;
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
        ...(goneCount > 0
          ? [
              {
                value: 'gone',
                label: 'Upstream gone',
                hint: `Deletes ${goneCount} local branch${goneCount === 1 ? '' : 'es'} whose remote-tracking branch was deleted`,
              },
            ]
          : []),
        {
          value: 'all',
          label: 'All except current',
          hint: 'Also deletes unmerged branches (harder to recover)',
        },
      ],
      initialValue: goneCount > 0 ? 'gone' : 'merged',
      confirmLabel: 'Continue',
    });
    if (mode !== 'merged' && mode !== 'all' && mode !== 'gone') return;

    const selected = mode === 'gone' ? targets.filter((b) => b.upstreamGone) : targets;
    if (selected.length === 0) {
      this.showToast('No matching local branches to delete', { kind: 'info' });
      return;
    }

    if (mode === 'all') {
      const ok = await this.prompts.ask({
        title: 'Delete unmerged branches too?',
        message: `Force-delete ${selected.length} local branch${selected.length === 1 ? '' : 'es'}. Commits that only exist on those branches may be hard to recover.`,
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
    for (const branch of selected) {
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
        mode === 'merged' || mode === 'gone'
          ? 'Nothing deleted — remaining branches are unmerged. Choose “All except current” to force-delete them.'
          : `Could not delete ${skipped.length} branch${skipped.length === 1 ? '' : 'es'}.`,
      );
      return;
    }

    const parts = [`Deleted ${deleted} local branch${deleted === 1 ? '' : 'es'}`];
    if (skipped.length > 0) {
      parts.push(
        mode === 'merged' || mode === 'gone'
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
    const path = this.currentRepo()?.path ?? null;
    try {
      const identity = await this.tauri.getGitIdentity(path);
      if ((this.currentRepo()?.path ?? null) !== path) return;
      this.identity.set(identity);
    } catch {
      if ((this.currentRepo()?.path ?? null) !== path) return;
      this.identity.set(null);
    }
  }
}

function releaseActivityFingerprint(activity: ReleaseActivity): string {
  return JSON.stringify({
    phase: activity.phase,
    message: activity.message,
    tag: activity.tag,
    nextVersion: activity.nextVersion,
    needsPush: !!activity.needsPush,
    needsRefresh: !!activity.needsRefresh,
    deployRunUrl: activity.deployRunUrl ?? '',
    releaseUrl: activity.releaseUrl ?? '',
    localSteps: activity.steps.map((step) => `${step.id}:${step.status}:${step.message}`),
    jobs: (activity.deployJobs ?? []).map((job) => ({
      n: job.name,
      s: job.status,
      c: job.conclusion ?? '',
      steps: (job.steps ?? []).map(
        (step) => `${step.number ?? ''}:${step.status}:${step.conclusion ?? ''}`,
      ),
    })),
  });
}

function hydrateReleaseActivity(activity: ReleaseActivity): ReleaseActivity {
  const looksIncomplete =
    activity.willPush &&
    !activity.needsPush &&
    !activity.releaseUrl &&
    activity.phase === 'done' &&
    /taking longer|Check GitHub Actions|Link GitHub/i.test(activity.message ?? '');
  if (!looksIncomplete) return activity;
  return {
    ...activity,
    phase: 'deploying',
    needsRefresh: true,
    ok: null,
    finishedAt: null,
  };
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

function normalizeReleasePhase(value: string): ReleasePhase {
  switch (value) {
    case 'preparing':
    case 'bumping':
    case 'staging':
    case 'committing':
    case 'tagging':
    case 'pushing':
    case 'deploying':
    case 'ci':
    case 'publishing':
    case 'done':
    case 'error':
    case 'idle':
      return value;
    default:
      return 'preparing';
  }
}

function buildReleaseSteps(willPush: boolean): ReleaseActivityStep[] {
  const steps: ReleaseActivityStep[] = [
    {
      id: 'preparing',
      phase: 'preparing',
      label: 'Prepare',
      message: 'Check branch, cleanliness, and tag',
      status: 'pending',
    },
    {
      id: 'bumping',
      phase: 'bumping',
      label: 'Bump versions',
      message: 'Update package and app version files',
      status: 'pending',
    },
    {
      id: 'staging',
      phase: 'staging',
      label: 'Stage files',
      message: 'Stage version bumps',
      status: 'pending',
    },
    {
      id: 'committing',
      phase: 'committing',
      label: 'Commit',
      message: 'Create the release commit',
      status: 'pending',
    },
    {
      id: 'tagging',
      phase: 'tagging',
      label: 'Tag',
      message: 'Create the annotated tag',
      status: 'pending',
    },
  ];
  if (willPush) {
    steps.push({
      id: 'pushing',
      phase: 'pushing',
      label: 'Push',
      message: 'Push commit and tags to origin',
      status: 'pending',
    });
    steps.push({
      id: 'deploying',
      phase: 'deploying',
      label: 'Deploy',
      message: 'Wait for GitHub Actions to start',
      status: 'pending',
    });
    steps.push({
      id: 'ci',
      phase: 'ci',
      label: 'Build',
      message: 'Build release artifacts on GitHub',
      status: 'pending',
    });
    steps.push({
      id: 'publishing',
      phase: 'publishing',
      label: 'Publish',
      message: 'Publish GitHub release and updater files',
      status: 'pending',
    });
  }
  return steps;
}

function advanceReleaseSteps(
  steps: ReleaseActivityStep[],
  phase: ReleasePhase,
  message: string,
): ReleaseActivityStep[] {
  if (phase === 'idle') return steps;
  if (phase === 'done') {
    return steps.map((step) => ({
      ...step,
      status: 'done',
      at: step.at ?? Date.now(),
      message: step.status === 'active' ? message : step.message,
    }));
  }
  if (phase === 'error') {
    let hitActive = false;
    return steps.map((step) => {
      if (step.status === 'done') return step;
      if (!hitActive && (step.status === 'active' || step.status === 'pending')) {
        hitActive = true;
        return { ...step, status: 'error', message, at: Date.now() };
      }
      return step.status === 'pending' ? step : step;
    });
  }
  const order = [
    'preparing',
    'bumping',
    'staging',
    'committing',
    'tagging',
    'pushing',
    'deploying',
    'ci',
    'publishing',
  ];
  const activeIndex = order.indexOf(phase);
  return steps.map((step) => {
    const stepIndex = order.indexOf(step.phase);
    if (stepIndex < 0) return step;
    if (stepIndex < activeIndex) {
      return { ...step, status: 'done', at: step.at ?? Date.now() };
    }
    if (stepIndex === activeIndex) {
      return { ...step, status: 'active', message, at: Date.now() };
    }
    return { ...step, status: 'pending' };
  });
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
    value === 'release' ||
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

function buildCreatePullRequestUrl(
  remoteUrl: string,
  headBranch: string,
  baseBranch: string,
  title: string,
  body: string,
): string | null {
  const parsed = parseRemoteWebBase(remoteUrl);
  if (!parsed || !headBranch.trim()) return null;
  const head = headBranch.trim();
  const base = (baseBranch || 'main').trim();
  if (parsed.host.includes('gitlab')) {
    const params = new URLSearchParams();
    params.set('merge_request[source_branch]', head);
    params.set('merge_request[target_branch]', base);
    if (title.trim()) params.set('merge_request[title]', title.trim());
    if (body.trim()) params.set('merge_request[description]', body);
    return `${parsed.webBase}/-/merge_requests/new?${params.toString()}`;
  }
  if (parsed.host.includes('dev.azure.com') || parsed.host.includes('visualstudio.com')) {
    const params = new URLSearchParams();
    params.set('sourceRef', head);
    params.set('targetRef', base);
    if (title.trim()) params.set('title', title.trim());
    return `${parsed.webBase}/pullrequestcreate?${params.toString()}`;
  }
  const params = new URLSearchParams();
  params.set('expand', '1');
  if (title.trim()) params.set('title', title.trim());
  if (body.trim()) params.set('body', body);
  return `${parsed.webBase}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?${params.toString()}`;
}

function normalizePrTemplates(raw: unknown): SavedPrTemplate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const t = item as Partial<SavedPrTemplate>;
      const id = typeof t.id === 'string' ? t.id.trim() : '';
      const name = typeof t.name === 'string' ? t.name.trim() : '';
      if (!id || !name) return null;
      return {
        id,
        name,
        title: typeof t.title === 'string' ? t.title : '',
        body: typeof t.body === 'string' ? t.body : '',
      };
    })
    .filter((t): t is SavedPrTemplate => !!t);
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
    pushAfterCommit: raw.pushAfterCommit ?? true,
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
    ticketFromBranch: normalizeTicketFromBranch(raw.ticketFromBranch),
    commitShortcutSequence: normalizeCommitShortcutSequence(raw.commitShortcutSequence),
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
    notifyRelease: raw.notifyRelease ?? true,
    hideUntracked: raw.hideUntracked ?? false,
    uiDensity: raw.uiDensity === 'compact' ? 'compact' : 'comfortable',
    prTemplates: normalizePrTemplates(raw.prTemplates),
    prCreateMethod: raw.prCreateMethod === 'cli' ? 'cli' : 'browser',
    githubRepoAccounts: normalizeGithubRepoAccounts(raw.githubRepoAccounts),
  };
}

function normalizeGithubRepoAccounts(raw: unknown): Record<string, GithubRepoAccountPref> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, GithubRepoAccountPref> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const owner = key.trim().toLowerCase();
    if (!owner || !value || typeof value !== 'object') continue;
    const row = value as { login?: unknown; protocol?: unknown };
    const login = typeof row.login === 'string' ? row.login.trim() : '';
    const protocol = row.protocol === 'ssh' || row.protocol === 'https' ? row.protocol : 'https';
    if (!login) continue;
    out[owner] = { login, protocol };
  }
  return out;
}

function normalizeRevisionGridColumns(raw: unknown): RevisionGridColumns {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.round(Math.min(max, Math.max(min, n)));
  };
  const optional = (value: unknown, min: number, max: number): number | undefined => {
    if (value == null || value === 0) return undefined;
    const n = clamp(value, 0, min, max);
    return n > 0 ? n : undefined;
  };
  return {
    graph: optional(o['graph'], 28, 800),
    message: optional(o['message'], 120, 2000),
    author: clamp(o['author'], 120, 56, 600),
    date: clamp(o['date'], 128, 64, 400),
    sha: clamp(o['sha'], 80, 52, 280),
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

function normalizeCachePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function commitsFingerprint(commits: CommitInfo[]): string {
  let out = String(commits.length);
  for (const c of commits) {
    out += `\n${c.sha}\t${c.refs.join(',')}`;
  }
  return out;
}

function branchesFingerprint(branches: BranchInfo[]): string {
  let out = String(branches.length);
  for (const b of branches) {
    out += `\n${b.name}\t${b.tipSha ?? ''}\t${b.isCurrent ? 1 : 0}\t${b.locked ? 1 : 0}`;
  }
  return out;
}

function statusFingerprint(status: RepoStatus): string {
  const fileKey = (f: { path: string; status: string; originalPath?: string | null }) =>
    `${f.status}:${f.path}:${f.originalPath ?? ''}`;
  return [
    status.branch,
    status.upstream ?? '',
    status.ahead,
    status.behind,
    status.isDetached ? 1 : 0,
    status.operation?.kind ?? '',
    status.staged.map(fileKey).join('|'),
    status.unstaged.map(fileKey).join('|'),
    status.untracked.map(fileKey).join('|'),
    status.conflicted.map(fileKey).join('|'),
  ].join('\n');
}

function artificialFromStatus(status: RepoStatus): ArtificialCommit[] {
  const countKinds = (files: RepoStatus['staged']) => {
    let added = 0;
    let modified = 0;
    let deleted = 0;
    for (const f of files) {
      if (f.status === 'added' || f.status === 'untracked') added++;
      else if (f.status === 'deleted') deleted++;
      else modified++;
    }
    return { added, modified, deleted };
  };
  const working = [...status.unstaged, ...status.untracked, ...status.conflicted];
  const w = countKinds(working);
  const s = countKinds(status.staged);
  return [
    {
      id: 'artificial:working',
      kind: 'workingDirectory',
      label: 'Working Directory',
      fileCount: working.length,
      added: w.added,
      modified: w.modified,
      deleted: w.deleted,
    },
    {
      id: 'artificial:staged',
      kind: 'staged',
      label: 'Staged Changes',
      fileCount: status.staged.length,
      added: s.added,
      modified: s.modified,
      deleted: s.deleted,
    },
  ];
}

function suggestStashBranchName(message?: string | null): string {
  const raw = (message ?? '').trim();
  if (!raw) return '';
  const afterColon = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : raw;
  const slug = afterColon
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `stash/${slug}` : '';
}
