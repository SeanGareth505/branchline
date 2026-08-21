import { ApplicationRef, Injectable, computed, inject, signal } from '@angular/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppSettings,
  ArtificialCommit,
  BranchHygieneEntry,
  BranchInfo,
  CherryPickPreview,
  CleanEntry,
  CommitInfo,
  ConnectionConfig,
  DetectedEditors,
  FileFlagEntry,
  GitIdentity,
  HistoryFilter,
  HostRepository,
  IgnoreFileOutput,
  IgnoreKind,
  JiraIssue,
  KeyboardShortcuts,
  LargeFileEntry,
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
  SyncCommitInfo,
  LfsFileInfo,
  BisectStatus,
  ConflictSidesOutput,
  ReleaseActivity,
  ReleaseActivityStep,
  ReleaseDeployJob,
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
import { normalizePullRequest } from './models';
import { diffPullRequestNotifications, formatPrNotify } from './pr-notifications';
import { SoundService, type NotifySoundKind } from './sound.service';
import { mergeUiSession } from './ui-session';
import { TauriService } from './tauri.service';
import { DiagnosticsService } from './diagnostics.service';
import { NotificationService } from './notification.service';
import { PromptService } from '../shared/ui/prompt-dialog/prompt.service';
import { SelectService } from '../shared/ui/select-dialog/select.service';
import { ReleaseDialogService } from '../features/release/release-dialog/release-dialog.service';
import { ChangelogService } from '../features/changelog/changelog.service';
import { DEFAULT_COMMIT_TYPES, normalizeCommitTypes } from './commit-types';
import {
  COL_DEFAULT,
  SPLIT_COMMIT_COMPOSER_DEFAULT,
  SPLIT_COMMIT_FILES_DEFAULT,
  SPLIT_MAIN_DEFAULT,
  SPLIT_NESTED_DEFAULT,
  normalizeRevisionGridColumns,
  normalizeSplitSizes,
  type SplitKind,
} from './revision-grid-columns';
import {
  DEFAULT_TICKET_FROM_BRANCH,
  branchNameWithTicket,
  extractTicketFromBranch,
  normalizeTicketFromBranch,
} from '../shared/git/ticket-from-branch';
import { normalizeCommitShortcutSequence } from '../shared/git/commit-shortcuts';
import {
  openPathsInPreferredEditor,
  preferredEditorLabel,
} from '../shared/git/open-in-editor';
import { runConfiguredGitTool } from '../shared/git/git-tools';
import { parseRemoteRef } from '../shared/git/remote-ref';
import { parseRemoteWebBase, primaryGithubOwner, remoteProtocol, branchWebUrl, tagWebUrl, commitWebUrl, compareWebUrl, fileWebUrl } from '../shared/git/repo-links';
import {
  ALL_REPO_ACCOUNTS,
  collectWorkspaceAccounts,
  hostOwnerFromSlug,
  hostOwnerFromWebUrl,
  repoAccountKeyForOwner,
  repoAccountMatchesOwner,
  resolveSelectedRepoAccount,
  type RepoAccountOption,
} from '../shared/git/repo-accounts';
import {
  humanizeGitError,
  isRemoteAccessError,
  rawErrorMessage,
} from '../shared/git/git-error';
import {
  alreadyUpToDateLabel,
  isAlreadyUpToDateMessage,
  summarizeGitToastMessage,
} from '../shared/git/git-toast';
import { appendGitProcessOutput, gitProcessTitle } from '../shared/git/git-process-output';
import {
  checkoutBlockedNeedsUntracked,
  computeCheckoutOverwritePaths,
  isCheckoutBlockedByLocalChanges,
  parseCheckoutBlockedPaths,
} from '../shared/git/checkout-blocked';
import { isMainlineBranch, resolveBaseUpdateRef } from '../shared/git/mainline-branch';
import {
  resolveWorkflowPattern,
  sanitizeBranchName,
  slugifyUser,
} from './workflow-placeholders';
import { DEFAULT_SHORTCUTS, shortcutMatches } from '../shared/git/shortcuts';
import {
  COMMIT_LOG_INITIAL,
  COMMIT_LOG_MAX,
  COMMIT_LOG_WARM,
  shouldKeepExistingCommitLog,
} from './commit-log-window';

export { DEFAULT_SHORTCUTS, shortcutMatches };

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
  | 'help'
  | 'about';

const SETTINGS_SECTIONS: SettingsSection[] = [
  'repos',
  'appearance',
  'git',
  'notifications',
  'connections',
  'help',
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
export type RemoteBusyKind = 'fetch' | 'pull' | 'push' | 'merge' | 'rebase' | 'check' | 'commit';
export interface GitProcessState {
  kind: RemoteBusyKind;
  title: string;
  command: string;
  output: string;
  hasLiveOutput: boolean;
  running: boolean;
  ok: boolean | null;
}
interface GitProcessOutputEvent {
  path: string;
  kind: RemoteBusyKind;
  chunk: string;
}
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
  | 'prReview'
  | 'prReady'
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
  private readonly appRef = inject(ApplicationRef);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly notifications = inject(NotificationService);
  private readonly sounds = inject(SoundService);
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
    firstParent: false,
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
    fetchAllRemotes: true,
    fetchPrune: true,
    fetchTags: false,
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
    keepGitProcessOpen: false,
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
    notifyPrReview: true,
    notifyPrReady: true,
    notifyRelease: true,
    notifySoundEnabled: true,
    notifySoundVolume: 0.5,
    notifySoundPrReview: true,
    notifySoundPrReady: true,
    notifySoundPrCi: true,
    notifySoundPrActivity: false,
    hideUntracked: false,
    uiDensity: 'comfortable',
    prTemplates: [],
    prCreateMethod: 'browser',
    githubRepoAccounts: {},
    selectedRepoAccount: '',
    gitFlowMain: 'main',
    gitFlowDevelop: 'develop',
    pinnedCommits: {},
    keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
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
  readonly remoteBusy = signal<RemoteBusyKind | null>(null);
  readonly gitProcess = signal<GitProcessState | null>(null);
  private gitProcessCloseTimer: number | null = null;
  private gitProcessOutputUnlisten: UnlistenFn | null = null;
  readonly actionBusy = signal<string | null>(null);
  readonly repoStatusPending = computed(() => this.syncingRepo() && !this.status());
  readonly repoRefsPending = computed(() => this.syncingRepo() && this.branches().length === 0);
  readonly repoGraphPending = computed(() => this.syncingRepo() && this.commits().length === 0);
  readonly repoContentPending = computed(
    () => this.repoStatusPending() && this.repoGraphPending(),
  );
  readonly busyMessage = computed(() => {
    if (this.repoAccountSwitching()) return 'Switching account…';
    if (this.loading()) return this.loadingLabel();
    return null;
  });
  readonly releaseBusy = signal(false);
  readonly releaseDeployChecking = signal(false);
  readonly releaseAttaching = signal(false);
  readonly releaseActivity = signal<ReleaseActivity | null>(null);
  readonly visibleReleaseActivity = computed(() => {
    const activity = this.releaseActivity();
    const path = this.currentRepo()?.path;
    if (!activity || !path || !sameRepoPath(activity.path, path)) return null;
    return activity;
  });
  readonly visibleReleaseBusy = computed(
    () => !!this.visibleReleaseActivity() && this.releaseBusy(),
  );
  readonly releaseNotesDraft = signal<ReleaseNotesDraft | null>(null);
  readonly releaseNotesBusy = signal(false);
  readonly releaseNotesGenerating = signal(false);
  readonly releaseSetupError = signal<string | null>(null);
  readonly releaseNotesText = computed(() => {
    const activity = this.visibleReleaseActivity();
    if (activity) return activity.notes ?? '';
    const draft = this.releaseNotesDraft();
    const path = this.currentRepo()?.path;
    if (draft && path && sameRepoPath(draft.path, path)) return draft.body;
    return '';
  });
  readonly releaseNotesCanPublish = computed(() => {
    const activity = this.visibleReleaseActivity();
    return (
      activity?.willTag !== false &&
      !!activity?.tag &&
      (!!activity.releaseUrl || this.hasGithubApiAccess())
    );
  });
  readonly releaseNotesSynced = computed(() => !!this.visibleReleaseActivity()?.notesSynced);
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
  private releaseDeployWatchGen = 0;
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
  readonly commitLogLimit = signal(COMMIT_LOG_INITIAL);
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
  readonly gitFlowDialogOpen = signal(false);
  readonly branchHygieneDialogOpen = signal(false);
  readonly gitCleanDialogOpen = signal(false);
  readonly fetchDialogOpen = signal(false);
  readonly syncPreviewDialogOpen = signal(false);
  readonly syncPreviewKind = signal<'incoming' | 'outgoing'>('incoming');
  readonly fetchAllBusy = signal(false);
  readonly diffIgnoreWhitespace = signal(false);
  readonly diffWordHighlight = signal(false);
  readonly commitStatuses = signal<Record<string, string>>({});
  readonly danglingCommits = signal<CommitInfo[]>([]);
  readonly largeFiles = signal<LargeFileEntry[]>([]);
  readonly fileFlags = signal<FileFlagEntry[]>([]);
  readonly bisectStatus = signal<BisectStatus | null>(null);
  readonly publishGithubDialogOpen = signal(false);
  readonly githubDeviceLoginOpen = signal(false);
  readonly remoteTroubleshootOpen = signal(false);
  readonly remoteTroubleshootError = signal('');
  readonly githubGitStatus = signal<GithubGitStatus | null>(null);
  readonly githubGitBusy = signal(false);
  readonly repoAccountSwitching = signal(false);
  readonly repoAccounts = computed((): RepoAccountOption[] => {
    const owners = [
      ...this.hostRepos().map((repo) => hostOwnerFromSlug(repo.fullName || repo.name)),
      ...Object.values(this.repoWebUrls())
        .filter((url): url is string => !!url)
        .map((url) => hostOwnerFromWebUrl(url)),
    ];
    return collectWorkspaceAccounts({
      cliAccounts: this.githubGitStatus()?.accounts ?? [],
      connectionUsernames: this.linkedGitHosts()
        .map((conn) => conn.username)
        .filter(Boolean),
      owners,
    });
  });
  readonly showingAllRepoAccounts = computed(
    () => this.selectedRepoAccountKey() === ALL_REPO_ACCOUNTS,
  );
  readonly selectedRepoAccountLabel = computed(() => {
    const key = this.selectedRepoAccountKey();
    if (key === ALL_REPO_ACCOUNTS) return '';
    return this.repoAccounts().find((account) => account.key === key)?.label ?? key;
  });
  readonly selectedRepoAccountKey = computed(() =>
    resolveSelectedRepoAccount(this.settings().selectedRepoAccount, this.repoAccounts(), [
      this.githubGitStatus()?.activeLogin ?? '',
      this.githubApiUsername(),
    ]),
  );
  readonly visibleOpenRepos = computed(() => {
    const account = this.selectedRepoAccountKey();
    const tabs = this.openRepos();
    if (account === ALL_REPO_ACCOUNTS) return tabs;
    return tabs.filter((repo) => this.localRepoMatchesAccount(repo.path, account));
  });
  private githubGitStatusAt = 0;
  private repoAccountSwitchGen = 0;
  private githubGitPollTimer: number | null = null;
  private static readonly GITHUB_GIT_STATUS_TTL_MS = 30_000;
  private readonly repoWebUrlInflight = new Map<string, Promise<string | null>>();
  readonly pendingRefsReveal = signal<string | null>(null);
  readonly createBranchStartPoint = signal<string | null>(null);
  readonly createBranchSuggestedName = signal('');
  readonly activeJiraKey = signal<string | null>(null);
  private jiraSyncedBranch: string | null | undefined = undefined;
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
  private readonly pullRequestSeen = new Map<string, MockPullRequest[]>();
  private prPollTimer: number | null = null;
  private static readonly PRS_TTL_MS = 90_000;
  private static readonly PR_POLL_MS = 90_000;
  readonly selectedDiffPath = signal<string | null>(null);
  readonly fileHistoryPath = signal<string | null>(null);
  readonly automationFilter = signal<AutomationFilter>('all');
  readonly automationSection = signal<AutomationSection>('workflows');
  readonly splitMain = signal<number[]>([...SPLIT_MAIN_DEFAULT]);
  readonly splitNested = signal<number[]>([...SPLIT_NESTED_DEFAULT]);
  readonly splitCommitFiles = signal<number[]>([...SPLIT_COMMIT_FILES_DEFAULT]);
  readonly splitCommitComposer = signal<number[]>([...SPLIT_COMMIT_COMPOSER_DEFAULT]);
  readonly revisionGridColumns = signal<RevisionGridColumns>({ ...COL_DEFAULT });
  private sessionSaveTimer: number | null = null;
  private sessionOverlay: UiSession = {};
  private settingsWrite: Promise<void> = Promise.resolve();
  private sessionPersistReady = false;
  private workspaceCleared = false;
  private restoringSession = false;
  private repoBooting = false;
  private repoCacheTimer: number | null = null;
  private lastRepoCacheFp = '';
  private repoDiskCache: Record<string, RepoCacheEntry> | null = null;
  private repoLoadGen = 0;
  private graphCommitsFull: CommitInfo[] | null = null;
  private commitApplyCancel: (() => void) | null = null;
  private readonly repoSnapshots = new Map<string, RepoWorkingSnapshot>();
  private static readonly SNAPSHOT_MAX = 12;
  private static readonly GRAPH_FIRST_PAINT = 120;
  private static readonly GRAPH_PAINT_CHUNK = 220;
  private repoFsUnlisten: UnlistenFn | null = null;
  private repoFsRefreshTimer: number | null = null;
  private mutationDepth = 0;
  private refreshQueued = false;
  private refreshInFlight: Promise<void> | null = null;
  private commitLogWarmGen = 0;
  private workingTreeRefreshQueued = false;
  private workingTreeRefreshInFlight: Promise<void> | null = null;
  private lastWorkingTreeRefreshAt = 0;
  private worktreePollTimer: number | null = null;
  private static readonly WORKTREE_POLL_MIN_MS = 3500;
  private static readonly WORKTREE_POLL_MAX_MS = 15000;
  private worktreePollDelay = AppStore.WORKTREE_POLL_MIN_MS;
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
  readonly baseUpdateRef = computed(() => {
    const current = this.status()?.branch;
    if (!current) return null;
    return resolveBaseUpdateRef(
      current,
      this.localBranches().map((b) => b.name),
      this.remoteBranches().map((b) => b.name),
      [this.settings().gitFlowDevelop, this.settings().gitFlowMain],
    );
  });
  readonly hasUpstreamRemote = computed(() => this.remotes().some((r) => r.name === 'upstream'));
  readonly pinnedShasForRepo = computed(() => {
    const path = this.currentRepo()?.path;
    if (!path) return new Set<string>();
    return new Set(this.settings().pinnedCommits[path] ?? []);
  });

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
    if (filter.firstParent) {
      const bySha = this.commitBySha();
      const head = list.find((c) => c.refs.includes('HEAD')) ?? list[0];
      if (!head) {
        list = [];
      } else {
        const keep = new Set<string>();
        const seen = new Set<string>();
        let cur: CommitInfo | undefined = head;
        while (cur && !seen.has(cur.sha)) {
          seen.add(cur.sha);
          keep.add(cur.sha);
          const parentSha: string | undefined = cur.parents[0];
          if (!parentSha) break;
          cur = bySha.get(parentSha) ?? (parentSha.length >= 7 ? bySha.get(parentSha.slice(0, 7)) : undefined);
        }
        list = list.filter((c) => keep.has(c.sha));
      }
    }
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
    if (view === 'release') this.resumeInProgressReleaseWatch();
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

  setSplitSizes(kind: SplitKind, sizes: number[]): void {
    if (!sizes.length) return;
    const next = normalizeSplitSizes(kind, sizes);
    if (kind === 'main') this.splitMain.set(next);
    else if (kind === 'nested') this.splitNested.set(next);
    else if (kind === 'commitFiles') this.splitCommitFiles.set(next);
    else this.splitCommitComposer.set(next);
    if (!this.restoringSession) {
      const key =
        kind === 'main'
          ? 'splitMain'
          : kind === 'nested'
            ? 'splitNested'
            : kind === 'commitFiles'
              ? 'commitSplitFiles'
              : 'commitSplitComposer';
      this.patchSession({ [key]: next });
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
    if (!this.sessionPersistReady) return;
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
    if (!this.sessionPersistReady) return;
    void this.saveSettings({}).catch((err) => {
      void this.diagnostics.record('session.save', rawErrorMessage(err) || 'Session save failed');
    });
  }

  private flushSession(): void {
    if (!this.sessionPersistReady) return;
    if (this.sessionSaveTimer !== null) {
      window.clearTimeout(this.sessionSaveTimer);
      this.sessionSaveTimer = null;
    }
    this.persistSessionToDisk();
  }

  private bindSessionFlush(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('beforeunload', () => this.flushSession());
    window.addEventListener('pagehide', () => this.flushSession());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushSession();
    });
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
        this.splitMain.set(normalizeSplitSizes('main', session.splitMain.map(Number)));
      }
      if (Array.isArray(session.splitNested) && session.splitNested.length >= 2) {
        this.splitNested.set(normalizeSplitSizes('nested', session.splitNested.map(Number)));
      }
      if (Array.isArray(session.commitSplitFiles) && session.commitSplitFiles.length >= 2) {
        this.splitCommitFiles.set(
          normalizeSplitSizes('commitFiles', session.commitSplitFiles.map(Number)),
        );
      }
      if (Array.isArray(session.commitSplitComposer) && session.commitSplitComposer.length >= 2) {
        this.splitCommitComposer.set(
          normalizeSplitSizes('commitComposer', session.commitSplitComposer.map(Number)),
        );
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
    if (view === 'release') this.resumeInProgressReleaseWatch();
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
        this.bindConflictFocusWatch();
        this.bindWorktreeFocusWatch();
      }
      void this.bindRepoFsWatcher();
      void this.bindGitProcessOutputListener();
      void this.bindReleaseProgressListener();
      this.restoreReleaseActivity();
      this.restoreReleaseNotesDraft();
      this.startWorktreePoll();
      this.startPullRequestPoll();
      this.readRepoDiskCache();
      const onboarding = await this.tauri.getOnboardingStatus();
      if (!onboarding.completed && !onboarding.skipped) {
        this.view.set('onboarding');
        void this.refreshIdentity();
        this.sessionPersistReady = true;
        this.bindSessionFlush();
        return;
      }
      await this.loadRecentRepos();
      this.restoreSessionRepoWebUrls(session);
      void this.refreshGithubGitStatus();
      void this.refreshIdentity();
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
      this.restoringSession = true;
      try {
        this.openRepos.set(pathsToOpen.map((path) => this.repoTabStub(path)));
        this.prefetchRepoWebUrls(pathsToOpen);
        const account = this.selectedRepoAccountKey();
        const matching =
          account === ALL_REPO_ACCOUNTS
            ? pathsToOpen
            : pathsToOpen.filter((path) => this.localRepoMatchesAccount(path, account));
        const savedForAccount = session.activeRepoPathByAccount?.[account]?.trim() || '';
        const activePath =
          (typeof session.activeRepoPath === 'string' && session.activeRepoPath.trim()) || '';
        const toActivate =
          (activePath && matching.some((p) => sameRepoPath(p, activePath)) ? activePath : null) ||
          (savedForAccount && matching.some((p) => sameRepoPath(p, savedForAccount))
            ? savedForAccount
            : null) ||
          matching[matching.length - 1] ||
          null;
        if (toActivate) {
          await this.openRepo(toActivate, { restoreView: false });
        }
        hasRepo = !!this.currentRepo();
        if (!this.currentRepo() && matching.length) {
          const fallback = matching[matching.length - 1];
          if (fallback && (!toActivate || !sameRepoPath(fallback, toActivate))) {
            await this.openRepo(fallback, { restoreView: false });
          }
          hasRepo = !!this.currentRepo();
        }
        void this.refreshInactiveRepoSummaries();
      } finally {
        this.restoringSession = false;
      }
      this.sessionPersistReady = true;
      this.persistOpenRepos();
      this.bindSessionFlush();
      this.restoreView(session, hasRepo);
    } catch (err) {
      this.showError(err);
      await this.loadRecentRepos();
      this.sessionPersistReady = true;
      this.bindSessionFlush();
      this.goHome();
    }
  }

  hasLinkedPrHost(): boolean {
    return (
      this.settings().connections.some(
        (c) =>
          c.enabled &&
          (c.hasToken || c.token.trim()) &&
          (c.provider === 'github' || c.provider === 'gitlab' || c.provider === 'azureDevOps'),
      ) || this.hasGithubCliLogin()
    );
  }

  hasGithubCliLogin(): boolean {
    return (this.githubGitStatus()?.accounts ?? []).some((account) => account.ok);
  }

  hasGithubApiAccess(): boolean {
    return this.hasGithubConnection() || this.hasGithubCliLogin();
  }

  hasLinkedJira(): boolean {
    const conn = this.jiraConnection();
    return !!(
      conn &&
      conn.enabled &&
      (conn.hasToken || conn.token.trim()) &&
      conn.username.trim() &&
      conn.baseUrl.trim()
    );
  }

  jiraConnection(): ConnectionConfig | undefined {
    return this.settings().connections.find((c) => c.provider === 'jira');
  }

  canPickJiraIssues(): boolean {
    return this.hasLinkedJira() || this.isDummyBackend;
  }

  jiraSetupIncomplete(): boolean {
    const conn = this.jiraConnection();
    if (!conn?.enabled) return false;
    const hasToken = !!(conn.hasToken || conn.token.trim());
    if (!hasToken) return false;
    return !conn.username.trim() || !conn.baseUrl.trim();
  }

  hasGithubConnection(): boolean {
    return this.settings().connections.some(
      (c) => c.provider === 'github' && c.enabled && (c.hasToken || c.token.trim()),
    );
  }

  async refreshPullRequests(
    state: 'open' | 'closed' | 'all' = 'open',
    opts?: { force?: boolean; notify?: boolean },
  ): Promise<void> {
    const path = this.currentRepo()?.path ?? '';
    const dummy = this.isDummyBackend && !this.hasLinkedPrHost();
    const live = this.hasLinkedPrHost();
    const key = dummy ? `dummy|${state}` : live ? `${path}|${state}` : `none|${path}|${state}`;
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

    if (!dummy && !live) {
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
            throw new Error('Open a repository with a GitHub, GitLab, or Azure DevOps remote to load pull requests.');
          }
          list = await this.tauri.listPullRequests(path, state);
        }
        if (gen !== this.pullRequestsGen) return;
        this.pullRequestCache.set(key, { list, at: Date.now() });
        this.pullRequests.set(list);
        this.pullRequestsKey = key;
        this.pullRequestsError.set(null);
        this.emitPullRequestNotifications(key, list, opts?.notify !== false);
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
      list.map((p) => (p.id === id ? normalizePullRequest({ ...p, ...partial }) : p)),
    );
    const cached = this.pullRequestCache.get(this.pullRequestsKey);
    if (cached) {
      this.pullRequestCache.set(this.pullRequestsKey, {
        list: this.pullRequests(),
        at: cached.at,
      });
    }
  }

  async reviewPullRequest(
    pr: MockPullRequest,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body?: string,
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return false;
    }
    try {
      const result = await this.tauri.reviewPullRequest({
        path,
        number: pr.number,
        event,
        body,
      });
      if (!result.ok) {
        this.showError(result.message);
        return false;
      }
      this.showSuccess(result.message, undefined, 'prActivity');
      await this.refreshPullRequests(this.prListStateFromStatus(pr.status), { force: true, notify: false });
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async mergePullRequest(pr: MockPullRequest, mergeMethod: 'merge' | 'squash' | 'rebase' = 'squash'): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return false;
    }
    try {
      const result = await this.tauri.mergePullRequest({
        path,
        number: pr.number,
        mergeMethod,
      });
      if (!result.ok) {
        this.showError(result.message);
        return false;
      }
      this.showSuccess(result.message, undefined, 'prActivity');
      await this.refreshPullRequests('open', { force: true, notify: false });
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async updatePullRequest(
    pr: MockPullRequest,
    patch: { state?: 'open' | 'closed'; ready?: boolean },
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return false;
    }
    try {
      const result = await this.tauri.updatePullRequest({
        path,
        number: pr.number,
        ...patch,
      });
      if (!result.ok) {
        this.showError(result.message);
        return false;
      }
      this.showSuccess(result.message, undefined, 'prActivity');
      await this.refreshPullRequests(this.prListStateFromStatus(pr.status), { force: true, notify: false });
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  private prListStateFromStatus(status: string): 'open' | 'closed' | 'all' {
    if (status === 'closed' || status === 'merged') return 'closed';
    return 'open';
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

  private hydrateRepoCache(path: string, includeGraph = true): boolean {
    try {
      const all = this.readRepoDiskCache();
      const entry = all[normalizeCachePath(path)];
      if (!entry?.status) return false;
      if (Date.now() - (entry.savedAt || 0) > 7 * 24 * 60 * 60 * 1000) return false;
      this.status.set(entry.status);
      this.branches.set(entry.branches ?? []);
      this.stashes.set(entry.stashes ?? []);
      this.tags.set(entry.tags ?? []);
      this.remotes.set(entry.remotes ?? []);
      this.cacheRepoWebUrl(path, entry.remotes ?? []);
      this.worktrees.set([]);
      this.submodules.set([]);
      this.lfsFiles.set([]);
      this.identity.set(null);
      this.updateNextAction(entry.status);
      this.diffSource.set('commit');
      if (includeGraph) {
        const commits = entry.commits ?? [];
        this.artificial.set(entry.artificial ?? artificialFromStatus(entry.status));
        const head = commits[0]?.sha ?? null;
        this.selectedSha.set(head);
        this.selectedShas.set(head ? [head] : []);
        this.compareSha.set(null);
        this.selectedDiffPath.set(null);
        this.fileHistoryPath.set(null);
        this.applyCommitsProgressive(commits);
      }
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
      const commits = this.graphCommitsFull ?? this.commits();
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
    if (!this.status() && this.commits().length === 0 && !this.graphCommitsFull?.length) return;
    this.repoSnapshots.set(normalizeCachePath(path), {
      savedAt: Date.now(),
      status: this.status(),
      commits: this.graphCommitsFull ?? this.commits(),
      artificial: this.artificial(),
      branches: this.branches(),
      stashes: this.stashes(),
      tags: this.tags(),
      remotes: this.remotes(),
      worktrees: this.worktrees(),
      submodules: this.submodules(),
      lfsFiles: this.lfsFiles(),
      selectedSha: this.selectedSha(),
      selectedShas: this.selectedShas(),
      compareSha: this.compareSha(),
      diffSource: this.diffSource(),
      selectedDiffPath: this.selectedDiffPath(),
      fileHistoryPath: this.fileHistoryPath(),
      identity: this.identity(),
    });
    this.pruneRepoSnapshots();
  }

  private applyWorkingSnapshot(snap: RepoWorkingSnapshot, includeGraph: boolean): void {
    this.status.set(snap.status);
    this.branches.set(snap.branches);
    this.stashes.set(snap.stashes);
    this.tags.set(snap.tags);
    this.remotes.set(snap.remotes);
    const currentPath = this.currentRepo()?.path;
    if (currentPath) this.cacheRepoWebUrl(currentPath, snap.remotes);
    this.worktrees.set(snap.worktrees);
    this.submodules.set(snap.submodules);
    this.lfsFiles.set(snap.lfsFiles);
    this.identity.set(snap.identity);
    this.diffSource.set(snap.diffSource);
    if (includeGraph) {
      this.artificial.set(snap.artificial);
      this.selectedSha.set(snap.selectedSha);
      this.selectedShas.set(snap.selectedShas);
      this.compareSha.set(snap.compareSha);
      this.selectedDiffPath.set(snap.selectedDiffPath);
      this.fileHistoryPath.set(snap.fileHistoryPath);
      this.applyCommitsProgressive(snap.commits);
    } else {
      this.cancelCommitApply();
      this.graphCommitsFull = null;
      this.commits.set([]);
      this.artificial.set([]);
      this.selectedSha.set(null);
      this.selectedShas.set([]);
      this.compareSha.set(null);
      this.selectedDiffPath.set(null);
      this.fileHistoryPath.set(null);
    }
    if (snap.status) this.updateNextAction(snap.status);
  }

  private restoreCachedRepo(path: string, includeGraph: boolean): boolean {
    const snap = this.repoSnapshots.get(normalizeCachePath(path));
    if (snap) {
      this.applyWorkingSnapshot(snap, includeGraph);
      return true;
    }
    if (!includeGraph) return false;
    return this.hydrateRepoCache(path, includeGraph);
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

  isCurrentRepo(path: string): boolean {
    const current = this.currentRepo()?.path;
    return !!current && sameRepoPath(current, path);
  }

  async openRepo(
    path: string,
    opts?: { restoreView?: boolean; activate?: boolean; keepView?: boolean },
  ): Promise<void> {
    const restoreView = opts?.restoreView !== false;
    const activate = opts?.activate !== false;
    const keepView = !!opts?.keepView;
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
      if (!keepView) {
        if (restoreView) this.setView('browse');
        else this.view.set('browse');
      }
      return;
    }

    if (!keepView && this.view() !== 'onboarding') {
      if (restoreView) this.setView('browse');
      else {
        if (this.view() === 'release') this.pauseBackgroundReleaseWork();
        this.view.set('browse');
      }
    }

    this.workspaceCleared = false;
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
    this.cancelCommitApply();
    this.clearWorkingState();
    this.repoBooting = true;
    const hadCache = this.restoreCachedRepo(normalized, true);
    this.syncingRepo.set(!hadCache);

    const summaryPromise = switching
      ? this.tauri.focusRepository(normalized).then((summary) => this.mergeFocusedSummary(summary))
      : this.tauri.openRepository(normalized);
    void this.refreshRepo().finally(() => {
      if (this.repoLoadGen === gen) this.repoBooting = false;
    });
    this.resumeReleaseTrackingIfNeeded();
    if (this.hasLinkedPrHost()) void this.refreshPullRequests('open');
    if (!hadCache) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.repoLoadStale(gen, normalized) || this.commits().length > 0) return;
          if (this.repoSnapshots.has(normalizeCachePath(normalized))) {
            this.restoreCachedRepo(normalized, true);
            return;
          }
          this.commitApplyCancel = scheduleIdleWork(() => {
            this.commitApplyCancel = null;
            if (this.repoLoadStale(gen, normalized) || this.commits().length > 0) return;
            this.hydrateRepoCache(normalized, true);
          });
        });
      });
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
      this.alignSelectedAccountToRepo(normalized);
      void this.ensureRepoWebUrl(normalized).then(() => {
        if (this.repoLoadStale(gen, normalized)) return;
        this.alignSelectedAccountToRepo(normalized);
      });
      void this.applyGithubRepoAccount({ silent: true });
      if (this.repoLoadStale(gen, normalized)) return;
      this.persistOpenRepos();
      if (!switching && (this.isDummyBackend || this.isDummyRepoPath(normalized))) {
        this.showWarning(
          'DUMMY DATA — browser preview. Open a real repo in the desktop app for live Git.',
        );
      }
      if (!switching && this.settings().autoFetchOnOpen && !this.isDummyBackend) {
        void this.runRemoteWithAccountRetry(() =>
          this.tauri.fetch(normalized, { remote: this.pushRemoteName() }),
        ).then(
          () => {
            if (this.repoLoadStale(gen, normalized)) return;
            void this.refreshRepo();
          },
          (err) => this.showError(err),
        );
      }
      void this.loadRepoChecks({ toastNew: !switching });
    } catch (err) {
      this.showError(err);
      if (!this.openRepos().length) this.goHome();
    } finally {
      if (gen === this.repoLoadGen) {
        this.loading.set(false);
        if (!this.refreshInFlight) this.syncingRepo.set(false);
      }
    }
  }

  async switchOpenRepo(path: string): Promise<void> {
    await this.openRepo(path, { keepView: true });
  }

  async closeOpenRepo(path: string, showToast = true): Promise<void> {
    const tabs = this.openRepos().filter((r) => !sameRepoPath(r.path, path));
    const closingCurrent = !!this.currentRepo() && sameRepoPath(this.currentRepo()!.path, path);
    const name = this.openRepos().find((r) => sameRepoPath(r.path, path))?.name;
    this.dropRepoSnapshot(path);
    this.openRepos.set(tabs);
    this.pruneRepoSnapshots();
    if (!tabs.length) this.workspaceCleared = true;
    this.persistOpenRepos();

    if (!closingCurrent) {
      if (showToast && name) this.showToast(`Closed ${name}`);
      return;
    }

    const visible = tabs.filter((r) =>
      this.localRepoMatchesAccount(r.path, this.selectedRepoAccountKey()),
    );
    if (visible.length) {
      await this.openRepo(visible[visible.length - 1].path, { keepView: true });
      if (showToast && name) this.showToast(`Closed ${name}`);
      return;
    }

    this.parkCurrentRepo();
    if (showToast && name) this.showToast(`Closed ${name}`);
  }

  closeOtherOpenRepos(showToast = true): void {
    const current = this.currentRepo()?.path;
    if (!current) return;
    const dropped = this.openRepos().filter((repo) => !sameRepoPath(repo.path, current));
    if (!dropped.length) return;
    for (const repo of dropped) this.dropRepoSnapshot(repo.path);
    this.openRepos.set(this.openRepos().filter((repo) => sameRepoPath(repo.path, current)));
    this.pruneRepoSnapshots();
    this.persistOpenRepos();
    if (showToast) {
      this.showToast(`Closed ${dropped.length} other ${dropped.length === 1 ? 'repo' : 'repos'}`);
    }
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
    this.workspaceCleared = true;
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

  private setCommitsIfChanged(commits: CommitInfo[], requestedLimit: number): void {
    const current = this.graphCommitsFull ?? this.commits();
    if (shouldKeepExistingCommitLog(current, commits, requestedLimit)) {
      return;
    }
    this.applyCommitsProgressive(commits);
  }

  private applyCommitsProgressive(commits: CommitInfo[]): void {
    const gen = this.repoLoadGen;
    const current = this.commits();
    const full = this.graphCommitsFull ?? current;
    if (
      commits.length === full.length &&
      commits.length === current.length &&
      commitsFingerprint(full) === commitsFingerprint(commits)
    ) {
      this.graphCommitsFull = null;
      return;
    }
    this.cancelCommitApply();
    this.graphCommitsFull = commits;
    const first = AppStore.GRAPH_FIRST_PAINT;
    if (commits.length <= first) {
      this.commits.set(commits);
      this.graphCommitsFull = null;
      return;
    }
    const prefix = commitPrefixLength(current, commits);
    if (prefix === commits.length) {
      this.commits.set(commits);
      this.graphCommitsFull = null;
      return;
    }
    let shown = prefix === current.length ? current.length : 0;
    if (shown === 0) {
      this.commits.set(commits.slice(0, first));
      shown = first;
    } else if (shown < first) {
      shown = Math.min(first, commits.length);
      this.commits.set(commits.slice(0, shown));
    }
    if (shown >= commits.length) {
      this.commits.set(commits);
      this.graphCommitsFull = null;
      return;
    }
    this.scheduleCommitTail(commits, shown, gen);
  }

  private scheduleCommitTail(commits: CommitInfo[], shown: number, gen: number): void {
    this.commitApplyCancel = scheduleIdleWork(() => {
      this.commitApplyCancel = null;
      if (this.repoLoadStale(gen) || this.graphCommitsFull !== commits) return;
      const next = Math.min(shown + AppStore.GRAPH_PAINT_CHUNK, commits.length);
      this.commits.set(next >= commits.length ? commits : commits.slice(0, next));
      if (next >= commits.length) {
        this.graphCommitsFull = null;
        return;
      }
      this.scheduleCommitTail(commits, next, gen);
    });
  }

  private cancelCommitApply(): void {
    this.commitApplyCancel?.();
    this.commitApplyCancel = null;
    this.graphCommitsFull = null;
  }

  private setBranchesIfChanged(branches: BranchInfo[]): void {
    if (branchesFingerprint(this.branches()) === branchesFingerprint(branches)) return;
    this.branches.set(branches);
  }

  private syncRepoSummaryFromStatus(path: string, status: RepoStatus): void {
    const current = this.currentRepo();
    if (!current || !sameRepoPath(current.path, path)) return;
    const hasChanges =
      status.staged.length +
        status.unstaged.length +
        status.untracked.length +
        status.conflicted.length >
      0;
    if (
      current.branch === status.branch &&
      current.ahead === status.ahead &&
      current.behind === status.behind &&
      current.hasChanges === hasChanges
    ) {
      return;
    }
    const next: RepoSummary = {
      ...current,
      branch: status.branch || current.branch,
      ahead: status.ahead,
      behind: status.behind,
      hasChanges,
    };
    this.currentRepo.set(next);
    this.upsertOpenRepo(next);
  }

  private persistOpenRepos(): void {
    if (this.restoringSession || !this.sessionPersistReady) return;
    const paths = this.openRepos().map((r) => r.path);
    if (!paths.length && !this.workspaceCleared) return;
    const account = this.selectedRepoAccountKey();
    const currentPath = this.currentRepo()?.path ?? null;
    const byAccount = { ...(this.readSession().activeRepoPathByAccount ?? {}) };
    if (currentPath) byAccount[account] = currentPath;
    this.patchSession(
      {
        openRepoPaths: paths,
        activeRepoPath: currentPath,
        activeRepoPathByAccount: byAccount,
        repoWebUrls: persistRepoWebUrls(this.repoWebUrls(), [
          ...paths,
          ...this.repos().map((r) => r.path),
        ]),
      },
      { flush: true },
    );
  }

  private async loadRecentRepos(): Promise<void> {
    try {
      this.repos.set(await this.tauri.listRecentRepos());
    } catch (err) {
      this.showError(err);
    }
  }

  private clearWorkingState(): void {
    this.cancelCommitApply();
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
    this.bisectStatus.set(null);
    this.gitFlowDialogOpen.set(false);
    this.branchHygieneDialogOpen.set(false);
    this.gitCleanDialogOpen.set(false);
    this.fetchDialogOpen.set(false);
    this.syncPreviewDialogOpen.set(false);
    this.danglingCommits.set([]);
    this.largeFiles.set([]);
    this.fileFlags.set([]);
    this.commitStatuses.set({});
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
    this.commitLogLimit.set(COMMIT_LOG_INITIAL);
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
    this.activeJiraKey.set(null);
    this.jiraSyncedBranch = undefined;
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

  githubApiUsername(): string {
    return (
      this.settings().connections.find(
        (conn) => conn.provider === 'github' && this.isConnectionLinked(conn),
      )?.username ?? ''
    );
  }

  localRepoMatchesAccount(path: string, accountKey = this.selectedRepoAccountKey()): boolean {
    const url = this.repoWebUrl(path);
    return repoAccountMatchesOwner(
      accountKey,
      url ? hostOwnerFromWebUrl(url) : '',
      this.settings().githubRepoAccounts,
      this.githubApiUsername(),
    );
  }

  hostRepoMatchesAccount(
    repo: HostRepository,
    accountKey = this.selectedRepoAccountKey(),
  ): boolean {
    return repoAccountMatchesOwner(
      accountKey,
      hostOwnerFromSlug(repo.fullName || repo.name),
      this.settings().githubRepoAccounts,
      this.githubApiUsername(),
    );
  }

  async selectRepoAccount(key: string, opts?: { syncWorkspace?: boolean }): Promise<void> {
    const next = key.trim().toLowerCase() || ALL_REPO_ACCOUNTS;
    const prev = this.selectedRepoAccountKey();
    if (prev === next) return;

    const gen = ++this.repoAccountSwitchGen;
    const currentPath = this.currentRepo()?.path ?? null;
    const byAccount = { ...(this.readSession().activeRepoPathByAccount ?? {}) };
    if (currentPath) byAccount[prev] = currentPath;
    this.patchSession({
      openRepoPaths: this.openRepos().map((r) => r.path),
      activeRepoPath: currentPath,
      activeRepoPathByAccount: byAccount,
      repoWebUrls: persistRepoWebUrls(this.repoWebUrls(), [
        ...this.openRepos().map((r) => r.path),
        ...this.repos().map((r) => r.path),
      ]),
    });
    if (this.settings().selectedRepoAccount.trim().toLowerCase() !== next) {
      this.settings.update((current) => ({ ...current, selectedRepoAccount: next }));
      void this.saveSettings({ selectedRepoAccount: next });
    }

    this.repoAccountSwitching.set(true);
    try {
      if (next !== ALL_REPO_ACCOUNTS) {
        const cli = (this.githubGitStatus()?.accounts ?? []).find(
          (account) => account.login.toLowerCase() === next,
        );
        const mapped = this.settings().githubRepoAccounts[next]?.login.trim() ?? '';
        const login = cli?.login || mapped;
        const active = this.githubGitStatus()?.activeLogin ?? '';
        if (login && login.toLowerCase() !== active.toLowerCase()) {
          await this.switchGithubCliUser(login, {
            silent: true,
            skipBusy: true,
            deferStatusRefresh: true,
          });
        }
      }
      if (gen !== this.repoAccountSwitchGen) return;
      if (opts?.syncWorkspace !== false) {
        await this.syncAccountWorkspace(next);
      }
    } finally {
      if (gen === this.repoAccountSwitchGen) {
        this.repoAccountSwitching.set(false);
      }
    }
  }

  private async syncAccountWorkspace(accountKey: string): Promise<void> {
    const current = this.currentRepo()?.path;
    if (current && this.localRepoMatchesAccount(current, accountKey)) return;
    const saved = this.readSession().activeRepoPathByAccount?.[accountKey]?.trim() || '';
    const visible = this.openRepos().filter((repo) =>
      this.localRepoMatchesAccount(repo.path, accountKey),
    );
    const fromTabs =
      visible.find((repo) => saved && sameRepoPath(repo.path, saved)) ??
      visible[visible.length - 1];
    if (fromTabs) {
      await this.openRepo(fromTabs.path, { keepView: !!current, restoreView: !current });
      return;
    }
    if (current) this.parkCurrentRepo();
  }

  private parkCurrentRepo(): void {
    this.repoLoadGen += 1;
    this.snapshotCurrentRepo();
    this.clearWorkingState();
    this.currentRepo.set(null);
    this.syncingRepo.set(false);
    this.loading.set(false);
    this.nextAction.set('Open a repository');
    this.goHome();
    this.persistOpenRepos();
  }

  private restoreSessionRepoWebUrls(session: UiSession): void {
    const cached = normalizeSessionRepoWebUrls(session.repoWebUrls);
    if (!Object.keys(cached).length) return;
    this.repoWebUrls.update((current) => ({ ...cached, ...current }));
  }

  private cacheRepoWebUrl(path: string, remotes: RemoteInfo[]): void {
    if (!path) return;
    const origin = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
    const url = origin
      ? parseRemoteWebBase(origin.fetchUrl || origin.pushUrl)?.webBase ?? null
      : null;
    const previous = this.repoWebUrls()[path];
    if (previous === url) return;
    this.repoWebUrls.update((map) => ({ ...map, [path]: url }));
  }

  private alignSelectedAccountToRepo(path: string): void {
    if (this.selectedRepoAccountKey() === ALL_REPO_ACCOUNTS) return;
    if (this.localRepoMatchesAccount(path)) return;
    const url = this.repoWebUrl(path);
    const owner = url
      ? hostOwnerFromWebUrl(url)
      : primaryGithubOwner(this.remotes());
    const key = repoAccountKeyForOwner(
      owner,
      this.repoAccounts(),
      this.settings().githubRepoAccounts,
    );
    if (key && key !== this.selectedRepoAccountKey()) {
      void this.selectRepoAccount(key, { syncWorkspace: false });
    }
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
    void Promise.all(Array.from({ length: Math.min(limit, missing.length) }, () => worker())).then(
      () => {
        this.patchSession({
          repoWebUrls: persistRepoWebUrls(this.repoWebUrls(), [
            ...this.openRepos().map((r) => r.path),
            ...this.repos().map((r) => r.path),
          ]),
        });
      },
    );
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

  originFetchUrl(): string | null {
    const remotes = this.remotes();
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
    const url = origin?.fetchUrl || origin?.pushUrl || '';
    return url.trim() || null;
  }

  openCommitOnHost(sha: string): void {
    const url = commitWebUrl(this.originFetchUrl() ?? '', sha);
    if (!url) {
      this.showWarning('No GitHub or GitLab remote found for this repository.');
      return;
    }
    void this.tauri.openExternalUrl(url);
  }

  openBranchOnHost(branch: string): void {
    const url = branchWebUrl(this.originFetchUrl() ?? '', branch);
    if (!url) {
      this.showWarning('No GitHub or GitLab remote found for this repository.');
      return;
    }
    void this.tauri.openExternalUrl(url);
  }

  openTagOnHost(tag: string): void {
    const url = tagWebUrl(this.originFetchUrl() ?? '', tag);
    if (!url) {
      this.showWarning('No GitHub or GitLab remote found for this repository.');
      return;
    }
    void this.tauri.openExternalUrl(url);
  }

  openCompareOnHost(from: string, to: string): void {
    const url = compareWebUrl(this.originFetchUrl() ?? '', from, to);
    if (!url) {
      this.showWarning('No GitHub or GitLab remote found for this repository.');
      return;
    }
    void this.tauri.openExternalUrl(url);
  }

  openFileOnHost(sha: string, file: string): void {
    const url = fileWebUrl(this.originFetchUrl() ?? '', sha, file);
    if (!url) {
      this.showWarning('No GitHub or GitLab remote found for this repository.');
      return;
    }
    void this.tauri.openExternalUrl(url);
  }

  async copyCommitPermalink(sha: string): Promise<void> {
    const url = commitWebUrl(this.originFetchUrl() ?? '', sha);
    try {
      await navigator.clipboard.writeText(url || sha);
      this.showSuccess(url ? 'Copied commit URL' : 'Copied commit SHA');
    } catch (err) {
      this.showError(err);
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
        baseUrl: (baseUrl?.trim() || c.baseUrl || '').replace(/\/$/, ''),
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

  ticketForBranch(name: string): string | null {
    const branch = name.trim();
    if (!branch) return null;
    const mapped = this.localBranches()
      .find((b) => b.name === branch)
      ?.jiraKey?.trim();
    if (mapped) return mapped;
    return extractTicketFromBranch(branch, this.settings().ticketFromBranch);
  }

  mappedTicketForBranch(name: string): string | null {
    return (
      this.localBranches()
        .find((b) => b.name === name.trim())
        ?.jiraKey?.trim() || null
    );
  }

  branchesLinkedToIssue(issueKey: string): string[] {
    const key = issueKey.trim().toLowerCase();
    if (!key) return [];
    return this.localBranches()
      .filter((b) => (b.jiraKey || '').trim().toLowerCase() === key)
      .map((b) => b.name);
  }

  jiraBrowseUrl(issueKey: string): string | null {
    const key = issueKey.trim();
    if (!key) return null;
    const known = this.jiraIssues().find((i) => i.key === key)?.url?.trim();
    if (known) return known;
    const base = this.jiraConnection()?.baseUrl.trim().replace(/\/$/, '');
    if (!base) return null;
    const browse = base.replace(/\/rest\/api\/[23]$/, '');
    return `${browse}/browse/${key}`;
  }

  async promptConnectJira(message: string): Promise<boolean> {
    const go = await this.prompts.ask({
      title: 'Connect Jira',
      message,
      confirmLabel: 'Connect Jira',
      cancelLabel: 'Not now',
      confirmOnly: true,
      required: false,
    });
    if (go === null) return false;
    this.openSettings('connections', 'jira');
    return true;
  }

  async ensureJiraIssuesAvailable(): Promise<boolean> {
    const conn = this.jiraConnection();
    const hasCreds = !!(conn && conn.enabled && (conn.hasToken || conn.token.trim()));
    if (hasCreds && !conn!.baseUrl.trim()) {
      await this.promptConnectJira(
        'Jira is missing the site URL (for example https://company.atlassian.net). Add it under Settings → Connections.',
      );
      return false;
    }
    if (hasCreds && !conn!.username.trim()) {
      await this.promptConnectJira(
        'Jira needs the Atlassian account email as well as the API token.',
      );
      return false;
    }
    if (!this.canPickJiraIssues()) {
      await this.promptConnectJira(
        'Connect Jira under Settings → Connections to pick issues. Ticket keys in branch names still work without signing in.',
      );
      return false;
    }
    if (this.jiraIssues().length) return true;
    await this.refreshJiraIssues();
    if (this.jiraIssues().length) return true;
    if (this.jiraIssuesError()) {
      this.showWarning(this.jiraIssuesError()!);
      return false;
    }
    this.showWarning('No Jira issues loaded. Refresh on the Jira page or adjust JQL.');
    return false;
  }

  async pickJiraIssue(opts?: {
    title?: string;
    message?: string;
    confirmLabel?: string;
    initialKey?: string | null;
  }): Promise<JiraIssue | null> {
    if (!(await this.ensureJiraIssuesAvailable())) return null;
    const issues = this.jiraIssues();
    const picked = await this.selects.ask({
      title: opts?.title ?? 'Link to Jira',
      message: opts?.message ?? 'Pick an issue to attach to this branch.',
      label: 'Issue',
      options: issues.map((issue) => ({
        value: issue.key,
        label: `${issue.key}  ${issue.summary}`,
        hint: `${issue.status} · ${issue.assignee}`,
      })),
      initialValue: opts?.initialKey?.trim() || undefined,
      confirmLabel: opts?.confirmLabel ?? 'Link',
      filterable: true,
    });
    if (!picked) return null;
    return (
      issues.find((issue) => issue.key === picked) ?? {
        key: picked,
        summary: picked,
        status: '',
        assignee: '',
        priority: '',
        issueType: '',
        url: this.jiraBrowseUrl(picked) ?? '',
        updatedAt: '',
        labels: [],
      }
    );
  }

  async linkCurrentBranchToIssue(issue: JiraIssue): Promise<boolean> {
    const branch = this.currentLocalBranchName();
    if (!branch) {
      this.showWarning('Check out a local branch first');
      return false;
    }
    return this.linkBranchToIssue(branch, issue.key);
  }

  async pickAndLinkBranchToJira(branchName?: string): Promise<boolean> {
    const branch = (branchName ?? this.currentLocalBranchName() ?? '').trim();
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return false;
    }
    if (!branch) {
      this.showWarning('Check out a local branch first');
      return false;
    }
    if (this.localBranches().every((b) => b.name !== branch) && this.status()?.branch !== branch) {
      this.showWarning('Link a local branch');
      return false;
    }
    const issue = await this.pickJiraIssue({
      title: 'Link to Jira',
      message: `Attach a Jira issue to “${branch}”.`,
      initialKey: this.ticketForBranch(branch),
    });
    if (!issue) return false;
    return this.linkBranchToIssue(branch, issue.key);
  }

  async linkBranchToIssue(branchName: string, issueKey: string): Promise<boolean> {
    const path = this.currentRepo()?.path;
    const branch = branchName.trim();
    const key = issueKey.trim();
    if (!path || !branch || !key) return false;

    let target = branch;
    if (!branch.toLowerCase().includes(key.toLowerCase())) {
      const nextName = branchNameWithTicket(branch, key);
      const choice = await this.selects.ask({
        title: `Link ${key}`,
        message: `“${branch}” does not include ${key}. Rename it so GitHub/GitLab for Jira can pick it up, or keep the name and only link it in Branchline.`,
        label: 'How to link',
        options: [
          {
            value: 'rename',
            label: `Rename to ${nextName}`,
            hint: 'Best when the branch is still local',
          },
          {
            value: 'keep',
            label: 'Keep this name',
            hint: 'Safer if a pull request already exists',
          },
        ],
        initialValue: this.localBranches().find((b) => b.name === branch)?.upstream
          ? 'keep'
          : 'rename',
        confirmLabel: 'Continue',
        filterable: false,
      });
      if (!choice) return false;
      if (choice === 'rename') {
        try {
          await this.tauri.renameBranch(path, branch, nextName);
          target = nextName;
        } catch (err) {
          this.showError(err);
          return false;
        }
      }
    }

    try {
      const result = await this.tauri.linkBranchToJira(path, target, key);
      const current = this.currentLocalBranchName();
      const isCurrent = current === branch || current === target;
      if (isCurrent) {
        this.setActiveJiraKey(key);
        this.jiraSyncedBranch = target;
      }
      await this.refreshRepo();
      this.showSuccess(result.message);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async unlinkBranchFromJira(branchName: string): Promise<boolean> {
    const path = this.currentRepo()?.path;
    const branch = branchName.trim();
    if (!path || !branch) return false;
    try {
      const result = await this.tauri.unlinkBranchFromJira(path, branch);
      if (this.status()?.branch === branch) {
        this.jiraSyncedBranch = branch;
        this.activeJiraKey.set(
          extractTicketFromBranch(branch, this.settings().ticketFromBranch),
        );
      }
      await this.refreshRepo();
      this.showSuccess(result.message);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async openJiraIssue(issueKey: string): Promise<void> {
    const url = this.jiraBrowseUrl(issueKey);
    if (url) {
      window.open(url, '_blank', 'noopener');
      return;
    }
    if (!this.hasLinkedJira() && !this.isDummyBackend) {
      await this.promptConnectJira(
        `No Jira site URL to open ${issueKey}. Connect Jira under Settings → Connections.`,
      );
      return;
    }
    this.showWarning(
      `No Jira URL for ${issueKey}. Add the site URL under Settings → Connections.`,
    );
  }

  currentLocalBranchName(): string | null {
    const status = this.status();
    if (!status || status.isDetached) return null;
    return status.branch?.trim() || null;
  }

  private syncActiveJiraIfBranchChanged(): void {
    const branch = this.currentLocalBranchName();
    if (branch === this.jiraSyncedBranch) return;
    this.jiraSyncedBranch = branch;
    this.activeJiraKey.set(branch ? this.ticketForBranch(branch) : null);
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
      this.worktreePollDelay = Math.min(this.worktreePollDelay * 2, AppStore.WORKTREE_POLL_MAX_MS);
      return;
    }
    this.worktreePollDelay = AppStore.WORKTREE_POLL_MIN_MS;
    this.status.set(status);
    this.artificial.set(artificialFromStatus(status));
    this.updateNextAction(status);
    this.syncRepoSummaryFromStatus(path, status);
    this.syncActiveJiraIfBranchChanged();
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
    this.commitLogWarmGen++;
    const logLimit = COMMIT_LOG_INITIAL;
    const prev = this.status();
    const [status, commits, branches] = await Promise.all([
      this.tauri.getRepoStatus(path, this.statusFetchOpts()),
      this.tauri.getCommitLog(path, logLimit, {
        firstParent: this.historyFilter().firstParent,
      }),
      this.tauri.listBranches(path),
    ]);
    if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
    this.status.set(status);
    this.setCommitsIfChanged(commits, logLimit);
    this.commitLogHasMore.set(commits.length >= logLimit && this.commitLogLimit() < COMMIT_LOG_MAX);
    this.artificial.set(artificialFromStatus(status));
    this.setBranchesIfChanged(branches);
    this.syncActiveJiraIfBranchChanged();
    this.lastWorkingTreeRefreshAt = Date.now();
    this.worktreePollDelay = AppStore.WORKTREE_POLL_MIN_MS;
    this.syncRepoSummaryFromStatus(path, status);
    void this.refreshIdentity();
    void this.refreshBisectStatus(path);
    if (!this.selectedSha() && commits[0]) {
      this.selectedSha.set(commits[0].sha);
      this.selectedShas.set([commits[0].sha]);
    }
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    void this.syncConflictManager(prev, status);
    this.persistRepoCache(path);
    this.snapshotCurrentRepo();
    void this.refreshCommitStatuses();
    void this.refreshSecondaryLists(path, { includeLfs: opts?.notify === true });
    scheduleIdleWork(() => {
      void this.warmCommitLog(path);
    }, 1200);
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
    if (this.view() === 'release') void this.attachLatestRelease();
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
    const showSync = !this.status() || this.commits().length === 0;
    if (showSync) this.syncingRepo.set(true);
    this.refreshInFlight = this.runRefreshRepoMeta(path)
      .catch((err) => this.showError(err))
      .finally(() => {
        this.refreshInFlight = null;
        if (showSync) this.syncingRepo.set(false);
        if (this.refreshQueued && this.mutationDepth === 0) {
          this.refreshQueued = false;
          const current = this.currentRepo()?.path;
          if (current) void this.refreshRepoMeta(current);
        }
      });
    await this.refreshInFlight;
  }

  private async runRefreshRepoMeta(path: string): Promise<void> {
    this.commitLogWarmGen++;
    const prev = this.status();
    const logLimit = COMMIT_LOG_INITIAL;
    const [status, commits, branches] = await Promise.all([
      this.tauri.getRepoStatus(path, this.statusFetchOpts()),
      this.tauri.getCommitLog(path, logLimit, {
        firstParent: this.historyFilter().firstParent,
      }),
      this.tauri.listBranches(path),
    ]);
    if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
    const statusUnchanged = !!prev && statusFingerprint(prev) === statusFingerprint(status);
    this.setCommitsIfChanged(commits, logLimit);
    this.setBranchesIfChanged(branches);
    this.syncActiveJiraIfBranchChanged();
    this.commitLogHasMore.set(commits.length >= logLimit && this.commitLogLimit() < COMMIT_LOG_MAX);
    this.lastWorkingTreeRefreshAt = Date.now();
    if (statusUnchanged) {
      this.snapshotCurrentRepo();
      if (!shouldKeepExistingCommitLog(this.graphCommitsFull ?? this.commits(), commits, logLimit)) {
        void this.warmCommitLog(path);
      }
      return;
    }
    this.status.set(status);
    this.artificial.set(artificialFromStatus(status));
    this.worktreePollDelay = AppStore.WORKTREE_POLL_MIN_MS;
    this.syncRepoSummaryFromStatus(path, status);
    if (!this.selectedSha() && commits[0]) {
      this.selectedSha.set(commits[0].sha);
      this.selectedShas.set([commits[0].sha]);
    }
    this.updateNextAction(status);
    this.maybeNotifyStatusChanges(prev, status);
    void this.syncConflictManager(prev, status);
    this.snapshotCurrentRepo();
    void this.warmCommitLog(path);
  }

  async refreshBisectStatus(path?: string): Promise<void> {
    const repo = path ?? this.currentRepo()?.path;
    if (!repo) {
      this.bisectStatus.set(null);
      return;
    }
    try {
      const status = await this.tauri.getBisectStatus(repo);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, repo)) return;
      this.bisectStatus.set(status.active ? status : null);
    } catch {
      if (this.currentRepo()?.path && sameRepoPath(this.currentRepo()!.path, repo)) {
        this.bisectStatus.set(null);
      }
    }
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

  private async refreshSecondaryLists(
    path: string,
    opts?: { includeLfs?: boolean },
  ): Promise<void> {
    try {
      const [stashes, tags, remotes] = await Promise.all([
        this.tauri.listStashes(path),
        this.tauri.listTags(path),
        this.tauri.listRemotes(path),
      ]);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
      this.stashes.set(stashes);
      this.tags.set(tags);
      this.remotes.set(remotes);
      this.cacheRepoWebUrl(path, remotes);
      this.snapshotCurrentRepo();
      this.persistRepoCache(path);
    } catch {
      /* secondary lists are best-effort */
    }
    void this.refreshHeavyLists(path, opts);
  }

  private async warmCommitLog(path: string): Promise<void> {
    const target = Math.max(COMMIT_LOG_WARM, this.commitLogLimit());
    const current = this.graphCommitsFull ?? this.commits();
    if (target <= COMMIT_LOG_INITIAL) return;
    if (current.length >= target) {
      this.commitLogLimit.set(Math.max(this.commitLogLimit(), Math.min(current.length, COMMIT_LOG_MAX)));
      this.commitLogHasMore.set(this.commitLogLimit() < COMMIT_LOG_MAX);
      return;
    }
    const gen = this.commitLogWarmGen;
    try {
      const commits = await this.tauri.getCommitLog(path, target, {
        firstParent: this.historyFilter().firstParent,
      });
      if (gen !== this.commitLogWarmGen) return;
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
      this.commitLogLimit.set(Math.max(this.commitLogLimit(), target));
      this.commitLogHasMore.set(commits.length >= target && target < COMMIT_LOG_MAX);
      this.setCommitsIfChanged(commits, target);
      this.snapshotCurrentRepo();
    } catch {
      /* warm history is best-effort */
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

  private async paintBusy(): Promise<void> {
    this.appRef.tick();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  private async beginGitAction(label: string): Promise<boolean> {
    if (this.remoteBusy() || this.actionBusy() || this.loading()) return false;
    this.actionBusy.set(label);
    await this.paintBusy();
    return true;
  }

  armRemoteBusy(kind: RemoteBusyKind, command?: string): boolean {
    if (this.remoteBusy() || this.actionBusy() || this.loading()) return false;
    this.remoteBusy.set(kind);
    this.openGitProcess(kind, command || `git ${kind}`);
    this.appRef.tick();
    return true;
  }

  private async beginRemoteBusy(kind: RemoteBusyKind, command?: string): Promise<boolean> {
    if (this.actionBusy() || this.loading()) return false;
    const current = this.remoteBusy();
    if (current && current !== kind) return false;
    this.remoteBusy.set(kind);
    this.openGitProcess(kind, command || `git ${kind}`);
    await this.paintBusy();
    return this.remoteBusy() === kind;
  }

  openGitProcess(kind: RemoteBusyKind, command: string): void {
    this.clearGitProcessCloseTimer();
    const current = this.gitProcess();
    if (current?.running) {
      if (command && command !== current.command) {
        const separator = current.output.endsWith('\n\n')
          ? ''
          : current.output.endsWith('\n')
            ? '\n'
            : '\n\n';
        const output = appendGitProcessOutput(
          current.output,
          `${separator}${command}\n\n`,
        );
        this.gitProcess.set({ ...current, command, output });
      }
      return;
    }
    this.gitProcess.set({
      kind,
      title: gitProcessTitle(kind),
      command,
      output: `${command}\n\n`,
      hasLiveOutput: false,
      running: true,
      ok: null,
    });
  }

  finishGitProcess(ok: boolean, extra?: string): void {
    this.clearGitProcessCloseTimer();
    this.gitProcess.update((current) => {
      if (!current || !current.running) return current;
      let output = current.output;
      if (extra?.trim() && !current.hasLiveOutput) {
        const chunk = extra.endsWith('\n') ? extra : `${extra}\n`;
        output = appendGitProcessOutput(output, chunk);
      }
      if (!output.endsWith('\n')) output += '\n';
      output += ok ? '\nDone.\n' : '\nFailed.\n';
      return { ...current, running: false, ok, output };
    });
    if (ok && !this.settings().keepGitProcessOpen) {
      this.gitProcessCloseTimer = window.setTimeout(() => {
        this.gitProcessCloseTimer = null;
        if (!this.settings().keepGitProcessOpen) this.closeGitProcess();
      }, 700);
    }
  }

  closeGitProcess(): void {
    if (this.gitProcess()?.running) return;
    this.clearGitProcessCloseTimer();
    this.gitProcess.set(null);
  }

  setKeepGitProcessOpen(value: boolean): void {
    if (this.settings().keepGitProcessOpen === value) return;
    this.settings.update((current) => ({ ...current, keepGitProcessOpen: value }));
    void this.saveSettings({ keepGitProcessOpen: value });
  }

  private clearGitProcessCloseTimer(): void {
    if (this.gitProcessCloseTimer == null) return;
    window.clearTimeout(this.gitProcessCloseTimer);
    this.gitProcessCloseTimer = null;
  }

  private endRemoteBusy(ok: boolean, output?: string): void {
    this.remoteBusy.set(null);
    this.finishGitProcess(ok, output);
  }

  private async bindGitProcessOutputListener(): Promise<void> {
    if (this.isDummyBackend) return;
    if (this.gitProcessOutputUnlisten) {
      this.gitProcessOutputUnlisten();
      this.gitProcessOutputUnlisten = null;
    }
    try {
      this.gitProcessOutputUnlisten = await listen<GitProcessOutputEvent>(
        'git-process-output',
        (event) => {
          const payload = event.payload;
          const repoPath = this.currentRepo()?.path;
          if (!repoPath || !sameRepoPath(repoPath, payload.path) || !payload.chunk) return;
          this.gitProcess.update((current) => {
            if (!current?.running) return current;
            return {
              ...current,
              output: appendGitProcessOutput(current.output, payload.chunk),
              hasLiveOutput: true,
            };
          });
        },
      );
    } catch {
      this.gitProcessOutputUnlisten = null;
    }
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
    const rawMessage = payload.message?.trim() || current.message;
    const message = phase === 'error' ? humanizeGitError(rawMessage) : rawMessage;
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
    this.persistReleaseActivity(true);
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
      if (activity.willPush && activity.phase !== 'done' && activity.phase !== 'error') {
        this.releaseBusy.set(true);
      }
    } catch {
      localStorage.removeItem(RELEASE_ACTIVITY_STORAGE_KEY);
    }
  }

  clearReleaseActivity(): void {
    if (this.releaseBusy()) return;
    const tag = this.releaseActivity()?.tag;
    this.releaseDeployWatchGen += 1;
    this.releaseDeployChecking.set(false);
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

  private patchReleaseActivity(
    path: string,
    patch: Partial<ReleaseActivity>,
    persistImmediate = true,
  ): void {
    const current = this.releaseActivity();
    if (!current || !sameRepoPath(current.path, path)) return;
    const next: ReleaseActivity = { ...current, ...patch };
    this.releaseActivity.set(next);
    this.persistReleaseActivity(persistImmediate);
  }

  setReleaseNotes(body: string): void {
    const activity = this.visibleReleaseActivity();
    if (activity) {
      this.patchReleaseActivity(activity.path, { notes: body, notesSynced: false });
      return;
    }
    const path = this.currentRepo()?.path;
    if (!path) return;
    this.releaseNotesDraft.set({ path, body });
    this.persistReleaseNotesDraft();
  }

  async saveReleaseNotes(): Promise<void> {
    const activity = this.visibleReleaseActivity();
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
        this.patchReleaseActivity(path, {
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
    const activity = this.visibleReleaseActivity();
    const path = activity?.path || this.currentRepo()?.path;
    const tag = activity?.tag?.trim();
    if (!path || !tag || activity?.willTag === false || this.releaseNotesBusy()) return;
    const local = (activity?.notes ?? '').trim();
    if (local && !opts?.overwrite) return;
    this.releaseNotesBusy.set(true);
    try {
      const result = await this.tauri.getGithubReleaseNotes(path, tag);
      if (!result.found) return;
      const remote = result.body ?? '';
      if (!opts?.overwrite && local && local !== remote.trim()) return;
      this.patchReleaseActivity(path, {
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
    const activity = this.visibleReleaseActivity();
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
        this.patchReleaseActivity(path, {
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

  private resumeInProgressReleaseWatch(): void {
    const activity = this.visibleReleaseActivity();
    const path = this.currentRepo()?.path;
    if (!path || !activity?.tag || !activity.willPush || activity.needsPush || activity.needsRefresh) {
      return;
    }
    if (
      activity.phase === 'done' ||
      activity.phase === 'error' ||
      activity.phase === 'idle'
    ) {
      return;
    }
    void this.watchReleaseDeploy(path, activity.tag, { immediate: true });
  }

  private resumeReleaseTrackingIfNeeded(): void {
    const activity = this.visibleReleaseActivity();
    const path = this.currentRepo()?.path;
    if (!path) return;
    if (!activity?.tag || !activity.willPush || activity.needsPush) {
      if (this.view() === 'release') void this.attachLatestRelease();
      return;
    }
    if (activity.phase === 'done' || activity.phase === 'error') {
      void this.attachLatestRelease();
      return;
    }
    void this.watchReleaseDeploy(path, activity.tag, { immediate: true });
  }

  openReleaseTab(): void {
    if (this.currentRepo()) this.setView('release');
  }

  viewReleaseOutcome(
    kind:
      | 'started'
      | 'tagged'
      | 'committed'
      | 'success'
      | 'failure'
      | 'paused'
      | 'job-failed' = 'failure',
  ): void {
    const url = this.releaseOutcomeUrl(kind);
    if (url) {
      this.openReleaseTab();
      void this.openReleaseExternalUrl(url);
      return;
    }
    if (this.view() !== 'release') {
      this.setView('release');
      return;
    }
    this.showWarning('No GitHub Actions URL yet. Details are on the Release screen.');
  }

  private releaseOutcomeUrl(
    kind: 'started' | 'tagged' | 'committed' | 'success' | 'failure' | 'paused' | 'job-failed',
  ): string | null {
    const activity = this.releaseActivity();
    const failedJobUrl =
      (activity?.deployJobs ?? []).find((job) => {
        const conclusion = job.conclusion?.trim() ?? '';
        return conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out';
      })?.url?.trim() || null;
    const runUrl = activity?.deployRunUrl?.trim() || null;
    const releaseUrl = activity?.releaseUrl?.trim() || null;
    const actionsUrl = activity?.actionsPageUrl?.trim() || null;
    if (kind === 'success') return firstNonEmptyUrl(releaseUrl, runUrl, actionsUrl);
    if (kind === 'failure' || kind === 'job-failed') {
      return firstNonEmptyUrl(failedJobUrl, runUrl, actionsUrl, releaseUrl);
    }
    return firstNonEmptyUrl(runUrl, actionsUrl, releaseUrl);
  }

  private async openReleaseExternalUrl(url: string): Promise<void> {
    try {
      await this.tauri.openExternalUrl(url);
    } catch {
      this.showWarning(`Could not open that link. Open manually: ${url}`);
    }
  }

  private notifyReleaseOutcome(
    kind: 'started' | 'tagged' | 'committed' | 'success' | 'failure' | 'paused' | 'job-failed',
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
          : kind === 'committed'
            ? `${label} committed without a tag`
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
          : kind === 'committed'
            ? `${label} version committed`
          : kind === 'started'
            ? `${label} is deploying`
            : kind === 'paused'
              ? `Tracking paused for ${label}`
              : kind === 'job-failed'
                ? `${label} job failed`
                : `${label} failed`;
    const toastKind: ToastKind =
      kind === 'success' || kind === 'tagged' || kind === 'committed'
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
      undo: () => this.viewReleaseOutcome(kind),
      actionLabel: 'View',
    });
    void this.sendDesktopIfEnabled('release', title, message);
  }

  async attachLatestRelease(options?: { force?: boolean; quiet?: boolean }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    if (this.releasingLocally()) return false;
    if (this.releaseAttachInFlight && this.releaseAttachPath === path) {
      if (!options?.force) return this.releaseAttachInFlight;
      await this.releaseAttachInFlight;
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

  private async runAttachLatestRelease(options?: { force?: boolean; quiet?: boolean }): Promise<boolean> {
    if (this.isDummyBackend) return false;
    const path = this.currentRepo()?.path;
    if (!path) return false;
    const force = options?.force === true;
    const quiet = options?.quiet === true;
    if (this.releasingLocally()) return false;
    if (this.releaseBusy() && !force) return false;
    try {
      const status = await this.tauri.getReleaseStatus(path);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return false;
      const version = status.currentVersion?.trim();
      const cfg = status.config;
      const productName = cfg?.productName || this.currentRepo()?.name || 'App';
      let tag = '';
      let watchVersion = version || '';
      let githubReleaseUrl: string | null = null;
      if (version) {
        tag = `${cfg?.tagPrefix || 'v'}${version}`;
      } else {
        const latest = await this.tauri.getLatestGithubRelease(path);
        if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) {
          return false;
        }
        if (!latest.found || !latest.tag.trim()) {
          if (force && !quiet) {
            this.showWarning(latest.message || 'No GitHub releases found for this repository.');
          }
          return false;
        }
        tag = latest.tag.trim();
        watchVersion = latest.version.trim() || tag.replace(/^v/i, '');
        githubReleaseUrl = latest.htmlUrl?.trim() || null;
      }
      const current = this.releaseActivity();
      const sameTag =
        !!current && sameRepoPath(current.path, path) && current.tag === tag;
      const onRelease = this.view() === 'release';
      if (!force && !onRelease && sameTag) return false;
      if (sameTag && !force && current && !current.needsRefresh) {
        if (
          onRelease &&
          current.willPush &&
          !current.needsPush &&
          current.phase !== 'done' &&
          current.phase !== 'error'
        ) {
          void this.watchReleaseDeploy(path, tag, { immediate: true });
        }
        return true;
      }
      if (!force && this.readDismissedReleaseTag() === tag) return false;

      const result = await this.tauri.pollReleaseDeploy(path, tag);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return false;
      if (!force && !onRelease && sameTag) return false;
      if (result.status === 'unavailable' && normalizeReleasePhase(result.phase) === 'idle') {
        if (githubReleaseUrl) {
          this.seedAttachedReleaseActivity({
            path,
            productName,
            version: watchVersion,
            tag,
            result: {
              ...result,
              status: 'success',
              phase: 'done',
              message: `GitHub release ${tag} is published.`,
              releaseUrl: githubReleaseUrl,
            },
          });
          this.clearDismissedReleaseTag(tag);
          this.releaseBusy.set(false);
          return true;
        }
        if (force && !quiet) this.showWarning(result.message);
        return false;
      }
      this.seedAttachedReleaseActivity({
        path,
        productName,
        version: watchVersion,
        tag,
        result: {
          ...result,
          releaseUrl: result.releaseUrl ?? githubReleaseUrl,
        },
      });
      this.clearDismissedReleaseTag(tag);
      if (
        result.status === 'success' ||
        result.status === 'failure' ||
        deployJobsTerminalFailure(result.jobs)
      ) {
        this.releaseBusy.set(false);
        return true;
      }
      if (result.status === 'unavailable') {
        this.releaseBusy.set(false);
        return true;
      }
      this.releaseBusy.set(true);
      void this.watchReleaseDeploy(path, tag);
      return true;
    } catch (err) {
      if (force && !quiet) this.showError(err);
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
    const terminalFailure =
      input.result.status === 'failure' ||
      deployJobsTerminalFailure(input.result.jobs);
    const phase = terminalFailure
      ? 'error'
      : normalizeReleasePhase(input.result.phase);
    const trackingPhase = phase === 'idle' ? 'deploying' : phase;
    const finished = trackingPhase === 'done' || trackingPhase === 'error';
    const message = terminalFailure
      ? input.result.message.trim() || deployFailureMessage(input.tag, input.result.jobs ?? [])
      : input.result.message;
    const current = this.releaseActivity();
    const existing =
      current && sameRepoPath(current.path, input.path) && current.tag === input.tag
        ? current
        : null;
    const draft = this.releaseNotesDraft();
    const draftBody =
      draft && sameRepoPath(draft.path, input.path) ? draft.body : '';
    const baseSteps = existing?.steps?.length
      ? existing.steps
      : advanceReleaseSteps(
          buildReleaseSteps(true, true),
          trackingPhase === 'error' ? 'deploying' : trackingPhase,
          message,
        );
    const activity: ReleaseActivity = {
      path: input.path,
      productName: input.productName,
      currentVersion: input.version,
      nextVersion: input.version,
      tag: input.tag,
      willTag: true,
      willPush: true,
      needsPush: false,
      deployRunUrl: input.result.runUrl ?? null,
      releaseUrl: input.result.releaseUrl ?? null,
      websiteUrl: input.result.websiteUrl ?? null,
      actionsPageUrl: input.result.actionsPageUrl ?? null,
      repoUrl: input.result.repoUrl ?? null,
      deployJobs: adoptReleaseDeployJobs(input.result.jobs, existing?.deployJobs),
      phase: trackingPhase,
      message,
      notes: existing?.notes ?? draftBody,
      notesSynced: existing?.notesSynced ?? false,
      steps: advanceReleaseSteps(baseSteps, trackingPhase, message),
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
    willTag: boolean;
    willPush: boolean;
  }): void {
    const draft = this.releaseNotesDraft();
    const draftBody =
      draft && sameRepoPath(draft.path, input.path) ? draft.body : '';
    const steps = buildReleaseSteps(input.willTag, input.willPush);
    this.releaseActivity.set({
      path: input.path,
      productName: input.productName,
      currentVersion: input.currentVersion,
      nextVersion: input.nextVersion,
      tag: input.tag,
      willTag: input.willTag,
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
    this.persistReleaseActivity(true);
  }

  private async simulateReleaseProgress(willTag: boolean, willPush: boolean): Promise<void> {
    const phases: Array<{ phase: ReleasePhase; message: string; delay: number }> = [
      { phase: 'preparing', message: 'Checking release preconditions…', delay: 180 },
      { phase: 'bumping', message: 'Bumping version files…', delay: 220 },
      { phase: 'staging', message: 'Staging version files…', delay: 180 },
      { phase: 'committing', message: 'Creating release commit…', delay: 220 },
    ];
    if (willTag) phases.push({ phase: 'tagging', message: 'Creating release tag…', delay: 180 });
    if (willPush) {
      phases.push({ phase: 'pushing', message: 'Pushing commit and tags to origin…', delay: 320 });
      phases.push({ phase: 'deploying', message: 'Waiting for GitHub to report installer jobs…', delay: 400 });
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
            if (this.repoBooting) return;
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

  private startPullRequestPoll(): void {
    if (typeof window === 'undefined') return;
    if (this.prPollTimer !== null) {
      window.clearInterval(this.prPollTimer);
    }
    this.prPollTimer = window.setInterval(() => {
      if (this.isDummyBackend) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (!this.hasLinkedPrHost() || !this.currentRepo()) return;
      if (this.pullRequestsLoading() || this.pullRequestsRefreshing()) return;
      void this.refreshPullRequests('open', { force: true });
    }, AppStore.PR_POLL_MS);
  }

  private startWorktreePoll(): void {
    if (typeof window === 'undefined') return;
    if (this.worktreePollTimer !== null) {
      window.clearTimeout(this.worktreePollTimer);
    }
    const tick = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
        return;
      }
      if (!this.currentRepo()) {
        this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
        return;
      }
      if (this.view() !== 'browse') {
        this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
        return;
      }
      if (this.mutationDepth > 0 || this.refreshInFlight || this.workingTreeRefreshInFlight) {
        this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
        return;
      }
      if (Date.now() - this.lastWorkingTreeRefreshAt < this.worktreePollDelay - 700) {
        this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
        return;
      }
      void this.refreshWorkingTree().finally(() => {
        this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
      });
    };
    this.worktreePollTimer = window.setTimeout(tick, this.worktreePollDelay);
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

  compareSelectedCommits(): void {
    const selected = this.selectedShas();
    if (selected.length >= 2) {
      this.selectedSha.set(selected[0]);
      this.compareSha.set(selected[1]);
      this.setBrowseTab('diff');
      return;
    }
    if (this.selectedSha() && this.compareSha()) {
      this.setBrowseTab('diff');
      return;
    }
    this.showToast('Select two commits (Shift-click or ⌘-click)', { kind: 'warning' });
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

  private toastGitIntegrate(
    raw: string,
    fallback: string,
    source?: string | null,
    category: NotificationCategory = 'pull',
  ): void {
    const text = raw.trim() || fallback;
    const already = isAlreadyUpToDateMessage(text);
    this.showToast(already ? alreadyUpToDateLabel(source) : text, {
      kind: already ? 'info' : 'success',
      durationMs: 3200,
      category,
      force: already,
    });
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

  checkFailMessage(name: string, output: string): string {
    const detail = summarizeGitToastMessage(output.trim());
    return detail ? `${name} failed — ${detail}` : `${name} failed`;
  }

  private lastFailedCheckMessage(fallback: string): string {
    const checks = this.repoChecks()?.checks ?? [];
    for (const check of checks) {
      const run = this.checkRuns()[check.id];
      if (run?.status === 'fail') {
        return this.checkFailMessage(check.name, run.output);
      }
    }
    return fallback;
  }

  private undoFromToast(path: string, workingTree = false): () => void {
    return () => {
      void (async () => {
        try {
          await this.tauri.undoLast(path);
          if (workingTree) await this.refreshWorkingTree();
          else await this.refreshRepo();
        } catch (err) {
          this.showError(err);
        }
      })();
    };
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
    this.playNotifySound(category, options?.kind);
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
      case 'prReview':
        return s.notifyPrReview;
      case 'prReady':
        return s.notifyPrReady;
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

  unlockSounds(): void {
    this.sounds.unlock();
  }

  playTestNotifySound(): void {
    this.sounds.unlock();
    this.sounds.play('review', this.settings().notifySoundVolume);
  }

  private emitPullRequestNotifications(key: string, next: MockPullRequest[], notify = true): void {
    const prev = this.pullRequestSeen.get(key) ?? null;
    this.pullRequestSeen.set(key, next);
    if (!notify || !prev || this.restoringSession) return;
    for (const event of diffPullRequestNotifications(prev, next)) {
      const copy = formatPrNotify(event);
      const category =
        event.kind === 'review'
          ? 'prReview'
          : event.kind === 'ready'
            ? 'prReady'
            : event.kind === 'ciFail' || event.kind === 'ciPass'
              ? 'prCi'
              : 'prActivity';
      const kind: ToastKind =
        event.kind === 'ciFail' ? 'warning' : event.kind === 'ready' || event.kind === 'ciPass' ? 'success' : 'info';
      this.notifyEvent(category, copy.title, copy.body, { kind });
    }
  }

  private playNotifySound(category: NotificationCategory, kind?: ToastKind): void {
    const s = this.settings();
    if (!s.notifySoundEnabled) return;
    if (!this.categoryEnabled(category, s)) return;
    const sound = this.soundKindFor(category, kind, s);
    if (!sound) return;
    this.sounds.play(sound, s.notifySoundVolume);
  }

  private soundKindFor(
    category: NotificationCategory,
    kind: ToastKind | undefined,
    s = this.settings(),
  ): NotifySoundKind | null {
    switch (category) {
      case 'prReview':
        return s.notifySoundPrReview ? 'review' : null;
      case 'prReady':
        return s.notifySoundPrReady ? 'ready' : null;
      case 'prCi':
        if (!s.notifySoundPrCi) return null;
        return kind === 'warning' || kind === 'error' ? 'fail' : 'success';
      case 'prActivity':
        return s.notifySoundPrActivity ? 'activity' : null;
      default:
        return null;
    }
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
    const run = this.settingsWrite.then(() => this.writeSettings(partial));
    this.settingsWrite = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    if (enablingSimple) this.constrainSimpleMode();
  }

  private async writeSettings(partial: Partial<AppSettings>): Promise<void> {
    const stored = this.settings();
    const storedSession =
      stored.layout && typeof stored.layout['session'] === 'object' && stored.layout['session']
        ? (stored.layout['session'] as UiSession)
        : {};
    const liveSession = this.readSession();
    const current = this.settingsWithSession();
    const session = this.workspaceCleared
      ? liveSession
      : mergeUiSession(storedSession, liveSession);
    const next = normalizeSettings({
      ...current,
      ...partial,
      connections: partial.connections ?? current.connections,
      layout: {
        ...(current.layout ?? {}),
        ...(partial.layout ?? {}),
        session,
      },
    });
    const saved = await this.tauri.saveSettings(next);
    const live = this.workspaceCleared
      ? this.readSession()
      : mergeUiSession(session, this.readSession());
    this.settings.set(
      normalizeSettings({
        ...saved,
        layout: { ...(saved.layout ?? {}), session: live },
      }),
    );
    this.sessionOverlay = live;
    this.myBranchesOnly.set(saved.myBranchesOnly);
    this.applyTheme(saved);
  }

  private constrainSimpleMode(): void {
    const view = this.view();
    if (view === 'automation' || view === 'templates' || view === 'profiles') {
      if (this.currentRepo()) this.setView('browse');
      else this.openSettings('repos');
    }
    const tab = this.browseTab();
    if (tab === 'reflog' || tab === 'console') {
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
      this.showToast(result.message, this.undoFromToast(path, true));
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
      this.showToast(result.message, this.undoFromToast(path, true));
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
      this.showToast(result.message, this.undoFromToast(path, true));
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async restoreFileFromRevision(
    file: string,
    revision: string,
    target: 'worktree' | 'index' | 'both' = 'both',
  ): Promise<boolean> {
    return this.cherryPickPathsFromCommit([file], target, revision);
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

    const ownsProcess = !this.gitProcess()?.running;
    let allPassed = false;
    try {
      for (const check of checks) {
        this.openGitProcess('check', check.command);
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
              this.showError(this.checkFailMessage(check.name, output));
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
      allPassed = true;
      return true;
    } finally {
      if (ownsProcess) this.finishGitProcess(allPassed);
    }
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
    const ownsProcess = !this.gitProcess()?.running;
    this.openGitProcess('check', check.command);
    let passed = false;
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
        this.showError(this.checkFailMessage(check.name, output));
      }
      passed = result.ok;
      return result.ok;
    } catch (err) {
      this.checkRuns.set({
        ...this.checkRuns(),
        [check.id]: { status: 'fail', output: this.formatError(err) },
      });
      if (!opts?.silent) this.showError(err);
      return false;
    } finally {
      if (ownsProcess) this.finishGitProcess(passed);
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
    opts?: { toast?: boolean; skipHooks?: boolean; refresh?: boolean },
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
    if (amend && !(await this.confirmIfEnabled('confirmAmend', {
      title: 'Amend last commit?',
      message:
        'Amending rewrites the tip of this branch. If that commit was already pushed, you will need a force push with lease afterward.',
      confirmLabel: 'Amend',
    }))) {
      return { ok: false };
    }
    const command = [
      'git commit',
      amend ? '--amend' : '',
      '--allow-empty',
      opts?.skipHooks ? '--no-verify' : '',
      '-m <message>',
    ]
      .filter(Boolean)
      .join(' ');
    const ownsProcess = !this.gitProcess()?.running;
    this.openGitProcess('commit', command);
    let committed = false;
    try {
      const result = await this.withRepoMutation(() =>
        this.tauri.createCommit(
          path,
          message.trim(),
          amend,
          true,
          opts?.skipHooks ?? false,
        ),
      );
      if (opts?.refresh !== false) {
        await this.refreshRepo();
      }
      const shortSha = result.sha.slice(0, 7);
      if (opts?.toast !== false) {
        this.showToast(amend ? `Amended ${shortSha}` : `Committed ${shortSha}`, {
          kind: 'success',
          category: 'commit',
          undo: this.undoFromToast(path),
        });
      }
      committed = true;
      return { ok: true, shortSha };
    } catch (err) {
      this.showError(err);
      return { ok: false };
    } finally {
      if (ownsProcess) this.finishGitProcess(committed);
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
          : ['pull', '--no-rebase', remote, branch];
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
              : ['pull', '--no-rebase', remote, branch];
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
    opts?: { push?: boolean; jiraKey?: string | null },
  ): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path || !name.trim()) return false;
    const trimmed = sanitizeBranchName(name);
    if (!trimmed) return false;
    try {
      const result = await this.tauri.createBranch(path, trimmed, checkout, startPoint);
      await this.persistCreatedBranchTicket(path, trimmed, opts?.jiraKey);
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
      this.showToast(result.message, this.undoFromToast(path));
      return true;
    } catch (err) {
      if (
        checkout &&
        (await this.handleCheckoutBlockedByLocalChanges(path, trimmed, err, async () => {
          const result = await this.tauri.createBranch(path, trimmed, true, startPoint);
          await this.persistCreatedBranchTicket(path, trimmed, opts?.jiraKey);
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

  private async persistCreatedBranchTicket(
    path: string,
    branch: string,
    issueKey?: string | null,
  ): Promise<void> {
    const key =
      issueKey?.trim() ||
      extractTicketFromBranch(branch, this.settings().ticketFromBranch) ||
      this.activeJiraKey()?.trim() ||
      '';
    if (!key) return;
    try {
      await this.tauri.linkBranchToJira(path, branch, key);
      this.setActiveJiraKey(key);
    } catch {
      return;
    }
  }

  async pushNewBranch(branch: string): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path || !branch.trim()) return false;
    const remote = this.pushRemoteName();
    if (!(await this.beginRemoteBusy('push', `git push -u ${remote} ${branch.trim()}`))) return false;
    let ok = false;
    let output = '';
    try {
      const result = await this.withRepoMutation(() =>
        this.tauri.push(path, {
          setUpstream: true,
          remote,
          branch: branch.trim(),
        }),
      );
      await this.refreshRepo();
      output = result.message || `Pushed ${branch.trim()} to ${remote}`;
      this.showToast(output, {
        kind: 'success',
        durationMs: 3200,
        category: 'push',
      });
      ok = true;
      return true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
      return false;
    } finally {
      this.endRemoteBusy(ok, output);
    }
  }

  async openSafety(action: SafetyAction, target?: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const analysis = await this.tauri.analyzeSafety(path, action, target);
      this.safety.set(analysis);
      this.appRef.tick();
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
        this.showToast(result.message, this.undoFromToast(path));
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

  async fetchWithSavedOptions(): Promise<void> {
    const s = this.settings();
    const command = this.fetchCommand({
      allRemotes: s.fetchAllRemotes,
      prune: s.fetchPrune,
      tags: s.fetchTags,
    });
    this.armRemoteBusy('fetch', command);
    await this.fetchRemote(undefined, {
      allRemotes: s.fetchAllRemotes,
      prune: s.fetchPrune,
      tags: s.fetchTags,
    });
  }

  async fetchRemote(
    remote?: string,
    opts?: { toast?: boolean; allRemotes?: boolean; prune?: boolean; tags?: boolean },
  ): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      if (this.remoteBusy() === 'fetch') this.endRemoteBusy(false);
      return;
    }
    const allRemotes = opts?.allRemotes ?? false;
    const prune = opts?.prune ?? false;
    const tags = opts?.tags ?? false;
    const command = this.fetchCommand({
      remote: remote?.trim() || this.pushRemoteName(),
      allRemotes,
      prune,
      tags,
    });
    if (!(await this.beginRemoteBusy('fetch', command))) return;
    let ok = false;
    let output = '';
    try {
      const result = await this.runRemoteWithAccountRetry(() =>
        this.withRepoMutation(() =>
          this.tauri.fetch(path, {
            remote: allRemotes ? null : remote?.trim() || this.pushRemoteName(),
            allRemotes,
            prune,
            tags,
          }),
        ),
      );
      await this.refreshRepo();
      output = result.message || 'Fetched from remote';
      if (opts?.toast !== false) {
        this.toastGitIntegrate(
          output,
          'Fetched from remote',
          allRemotes ? 'all remotes' : remote?.trim() || this.pushRemoteName() || null,
          'fetch',
        );
      }
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
    }
  }

  private fetchCommand(opts: {
    remote?: string | null;
    allRemotes?: boolean;
    prune?: boolean;
    tags?: boolean;
  }): string {
    const parts = ['git', 'fetch', '--progress'];
    if (opts.allRemotes) parts.push('--all');
    if (opts.prune) parts.push('--prune');
    if (opts.tags) parts.push('--tags');
    if (!opts.allRemotes && opts.remote?.trim()) parts.push(opts.remote.trim());
    return parts.join(' ');
  }

  async fetchAllRecent(): Promise<void> {
    const account = this.selectedRepoAccountKey();
    const recents = this.repos().filter((repo) => this.localRepoMatchesAccount(repo.path, account));
    if (!recents.length) {
      this.showWarning(
        account === ALL_REPO_ACCOUNTS
          ? 'No recent repositories'
          : `No recent repositories for ${this.selectedRepoAccountLabel() || 'this account'}`,
      );
      return;
    }
    if (this.fetchAllBusy()) return;
    this.fetchAllBusy.set(true);
    const current = this.currentRepo()?.path;
    let fetched = 0;
    try {
      for (const repo of recents) {
        try {
          await this.tauri.fetch(repo.path);
          fetched += 1;
        } catch (err) {
          this.showError(err);
        }
      }
      if (current && recents.some((repo) => sameRepoPath(repo.path, current))) {
        await this.refreshRepo();
      }
      this.showToast(`Fetched ${fetched} repositories`, { kind: 'success', category: 'fetch' });
    } finally {
      this.fetchAllBusy.set(false);
    }
  }

  async pruneRemote(name: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const remote = name.trim();
    if (!path || !remote) return;
    if (!(await this.beginRemoteBusy('fetch', `git fetch --prune ${remote}`))) return;
    let ok = false;
    let output = '';
    try {
      const result = await this.withRepoMutation(() => this.tauri.pruneRemote(path, remote));
      await this.refreshRepo();
      output = result.message || `Pruned ${remote}`;
      this.showToast(output, {
        kind: 'success',
        durationMs: 3200,
        category: 'fetch',
      });
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
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
    if (!(await this.beginRemoteBusy('fetch', 'git remote prune'))) return;
    let ok = false;
    let output = '';
    try {
      let lastMessage = '';
      for (const remote of remotes) {
        const result = await this.withRepoMutation(() => this.tauri.pruneRemote(path, remote.name));
        lastMessage = result.message || `Pruned ${remote.name}`;
      }
      await this.refreshRepo();
      output = lastMessage || 'Pruned remotes';
      this.showToast(output, {
        kind: 'success',
        durationMs: 3200,
        category: 'fetch',
      });
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
    }
  }

  async pullRemote(rebase = false): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      if (this.remoteBusy() === 'pull') this.endRemoteBusy(false);
      return;
    }
    const remote = this.pushRemoteName();
    const command = rebase
      ? `git pull --progress --rebase ${remote}`.trim()
      : `git pull --progress --no-rebase ${remote}`.trim();
    if (!(await this.beginRemoteBusy('pull', command))) return;
    let ok = false;
    let output = '';
    try {
      const result = await this.runRemoteWithAccountRetry(() =>
        this.withRepoMutation(() =>
          this.tauri.pullWithOptions(path, { rebase, remote }),
        ),
      );
      if (!result.ok) {
        output = result.message;
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      output = result.message || (rebase ? 'Pulled with rebase' : 'Pulled from remote');
      this.toastGitIntegrate(
        output,
        rebase ? 'Pulled with rebase' : 'Pulled from remote',
        this.status()?.upstream ?? this.pushRemoteName() ?? null,
        'pull',
      );
      ok = true;
    } catch (err) {
      const message = rawErrorMessage(err);
      output = message;
      if (message.toLowerCase().includes('conflict')) {
        await this.handleConflictResult({ ok: false, message });
        return;
      }
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
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
    const remote = this.pushRemoteName();
    const branch = status?.branch?.trim() || '';
    const command = [
      'git',
      'push',
      '--progress',
      pushOpts.setUpstream ? '-u' : '',
      remote,
      branch,
    ]
      .filter(Boolean)
      .join(' ');
    if (!(await this.beginRemoteBusy('push', command))) return false;
    let ok = false;
    let output = '';
    try {
      if (opts?.runChecks !== false && !opts?.skipHooks) {
        const checksOk = await this.runRepoChecks(['pre-push'], { silent: true });
        if (!checksOk) {
          output = this.lastFailedCheckMessage('Push checks failed');
          this.showError(output);
          return false;
        }
      }
      const skipHooks =
        !!opts?.skipHooks || this.hasDetectedChecks(['pre-push']);
      const result = await this.runRemoteWithAccountRetry(() =>
        this.withRepoMutation(() =>
          this.tauri.push(path, {
            ...pushOpts,
            remote,
            skipHooks,
          }),
        ),
      );
      await this.refreshRepo();
      output = result.message || 'Pushed to remote';
      if (opts?.toast !== false) {
        this.showToast(output, {
          kind: 'success',
          durationMs: 3200,
          category: 'push',
        });
      }
      ok = true;
      return true;
    } catch (err) {
      const raw = rawErrorMessage(err);
      output = raw;
      if (/non-fast-forward|rejected|fetch first/i.test(raw)) {
        await this.openForcePushSafety(status?.branch);
        return false;
      }
      this.showError(err);
      return false;
    } finally {
      this.endRemoteBusy(ok, output);
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
    const name = branch?.trim() || '';
    const command = ['git', 'push', '--progress', '--force-with-lease', remote, name]
      .filter(Boolean)
      .join(' ');
    if (!(await this.beginRemoteBusy('push', command))) return;
    let ok = false;
    let output = '';
    try {
      const result = await this.withRepoMutation(() =>
        this.tauri.push(path, {
          forceWithLease: true,
          remote,
          branch: name || undefined,
        }),
      );
      await this.refreshRepo();
      output = result.message || `Force-pushed ${branch ?? 'branch'} with lease`;
      this.showToast(output, {
        kind: 'success',
        category: 'push',
      });
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      if (this.isForceWithLeaseRejected(err)) {
        this.showWarning(
          'Force-with-lease refused — the remote moved since your last fetch. Fetch first, then try again.',
        );
        await this.openSafety('forcePush', branch ?? undefined);
        return;
      }
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
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
      const s = this.settings();
      await this.fetchRemote(undefined, {
        allRemotes: s.fetchAllRemotes,
        prune: s.fetchPrune,
        tags: s.fetchTags,
      });
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

  toggleFirstParentFilter(): void {
    this.setHistoryFilter({ firstParent: !this.historyFilter().firstParent });
  }

  clearHistoryFilter(): void {
    this.historyFilter.set({
      query: '',
      author: '',
      currentBranchOnly: false,
      mineOnly: false,
      firstParent: false,
    });
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
    const hadCli = this.hasGithubCliLogin();
    try {
      this.githubGitStatus.set(await this.tauri.githubGitStatus());
      this.githubGitStatusAt = Date.now();
    } catch {
      this.githubGitStatus.set(null);
    }
    if (!hadCli && this.hasGithubCliLogin() && !this.hasGithubConnection()) {
      void this.refreshPullRequests('open', { force: true });
      void this.refreshHostRepositories(undefined, { force: true });
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

  async switchGithubCliUser(
    login: string,
    opts?: { silent?: boolean; skipBusy?: boolean; deferStatusRefresh?: boolean },
  ): Promise<boolean> {
    const manageBusy = !opts?.skipBusy;
    if (manageBusy) this.githubGitBusy.set(true);
    try {
      const result = await this.tauri.switchGithubCliUser(login);
      if (result.ok) {
        this.patchGithubActiveLogin(login);
        this.rememberGithubRepoAccount({ login });
        if (opts?.deferStatusRefresh) {
          void this.refreshGithubGitStatus({ force: true });
        } else {
          await this.refreshGithubGitStatus({ force: true });
        }
        if (!opts?.silent) this.showSuccess(result.message);
      } else if (!opts?.silent) {
        this.showWarning(result.message);
      }
      return result.ok;
    } catch (err) {
      if (!opts?.silent) this.showError(err);
      return false;
    } finally {
      if (manageBusy) this.githubGitBusy.set(false);
    }
  }

  private patchGithubActiveLogin(login: string): void {
    const target = login.trim().toLowerCase();
    if (!target) return;
    this.githubGitStatus.update((status) => {
      if (!status) return status;
      return {
        ...status,
        activeLogin: login.trim(),
        accounts: status.accounts.map((account) => ({
          ...account,
          active: account.login.toLowerCase() === target,
        })),
      };
    });
    this.githubGitStatusAt = Date.now();
  }

  async addGithubCliAccount(): Promise<boolean> {
    this.githubGitBusy.set(true);
    const known = new Set(
      (this.githubGitStatus()?.accounts ?? []).map((account) => account.login.toLowerCase()),
    );
    try {
      const result = await this.tauri.startGithubCliLogin();
      if (!result.ok) {
        this.showWarning(result.message);
        return false;
      }
      this.showSuccess(result.message);
      this.pollNewGithubCliAccount(known);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    } finally {
      this.githubGitBusy.set(false);
    }
  }

  async logoutGithubCliUser(login: string): Promise<boolean> {
    const name = login.trim();
    if (!name) return false;
    const confirmed = await this.prompts.ask({
      title: `Unlink ${name}?`,
      message: `GitHub CLI will sign out of ${name}. Fetch and push for that account stop until you add it again.`,
      confirmLabel: 'Unlink',
      cancelLabel: 'Keep',
      required: false,
      confirmOnly: true,
    });
    if (confirmed === null) return false;
    this.githubGitBusy.set(true);
    try {
      const result = await this.tauri.logoutGithubCliUser(name);
      await this.refreshGithubGitStatus({ force: true });
      if (!result.ok) {
        this.showWarning(result.message);
        return false;
      }
      this.forgetGithubAccountPrefs(name);
      const remaining = this.githubGitStatus()?.accounts ?? [];
      const selected = this.selectedRepoAccountKey();
      if (selected === name.toLowerCase()) {
        const next = remaining[0]?.login || ALL_REPO_ACCOUNTS;
        void this.selectRepoAccount(next, { syncWorkspace: true });
      }
      this.showSuccess(result.message);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    } finally {
      this.githubGitBusy.set(false);
    }
  }

  private forgetGithubAccountPrefs(login: string): void {
    const key = login.trim().toLowerCase();
    if (!key) return;
    const current = this.settings().githubRepoAccounts;
    const next: Record<string, GithubRepoAccountPref> = {};
    for (const [owner, pref] of Object.entries(current)) {
      if (pref.login.trim().toLowerCase() === key) continue;
      next[owner] = pref;
    }
    if (Object.keys(next).length === Object.keys(current).length) return;
    void this.saveSettings({ githubRepoAccounts: next });
  }

  private pollNewGithubCliAccount(known: Set<string>): void {
    if (this.githubGitPollTimer !== null) {
      window.clearInterval(this.githubGitPollTimer);
      this.githubGitPollTimer = null;
    }
    const started = Date.now();
    this.githubGitPollTimer = window.setInterval(() => {
      void (async () => {
        await this.refreshGithubGitStatus({ force: true });
        const added = (this.githubGitStatus()?.accounts ?? []).find(
          (account) => !known.has(account.login.toLowerCase()),
        );
        if (added) {
          if (this.githubGitPollTimer !== null) {
            window.clearInterval(this.githubGitPollTimer);
            this.githubGitPollTimer = null;
          }
          void this.selectRepoAccount(added.login);
          this.showSuccess(`Added ${added.login}`);
          return;
        }
        if (Date.now() - started > 90_000 && this.githubGitPollTimer !== null) {
          window.clearInterval(this.githubGitPollTimer);
          this.githubGitPollTimer = null;
        }
      })();
    }, 2500);
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
    if (this.githubGitBusy() || this.repoAccountSwitching()) return;
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
    const path = this.currentRepo()?.path;
    if (path) {
      this.cacheRepoWebUrl(path, this.remotes());
      this.alignSelectedAccountToRepo(path);
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
    const next =
      this.commitLogLimit() < COMMIT_LOG_WARM
        ? COMMIT_LOG_WARM
        : Math.min(this.commitLogLimit() + 1000, COMMIT_LOG_MAX);
    if (next === this.commitLogLimit()) {
      this.commitLogHasMore.set(false);
      return;
    }
    this.loadingMoreCommits.set(true);
    this.commitLogWarmGen++;
    try {
      const commits = await this.tauri.getCommitLog(path, next, {
        firstParent: this.historyFilter().firstParent,
      });
      this.commitLogLimit.set(next);
      this.commitLogHasMore.set(commits.length >= next && next < COMMIT_LOG_MAX);
      this.setCommitsIfChanged(commits, next);
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

  async cloneRepo(
    url: string,
    destination: string,
    opts?: { shallow?: boolean; recurseSubmodules?: boolean; sparse?: boolean },
  ): Promise<void> {
    this.loadingLabel.set('Cloning repository…');
    this.loading.set(true);
    const gen = ++this.repoLoadGen;
    this.snapshotCurrentRepo();
    try {
      const summary = await this.tauri.cloneRepository(url, destination, opts);
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
    if (!(await this.beginGitAction(includeUntracked ? 'Stashing including untracked…' : 'Stashing…'))) {
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
    if (!(await this.beginGitAction('Restoring stash…'))) return;
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
    if (!(await this.beginGitAction('Applying stash…'))) return;
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
    if (!(await this.beginGitAction('Dropping stash…'))) return;
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
    if (!(await this.beginGitAction('Dropping stashes…'))) return;
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
    const source = name.trim();
    if (!path || !source) return;
    if (!(await this.beginRemoteBusy('merge', `git merge ${source}`))) return;
    let ok = false;
    let output = '';
    try {
      const result = await this.withRepoMutation(() => this.tauri.mergeBranch(path, source, noFf));
      if (!result.ok) {
        output = result.message;
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      output = result.message || `Merged ${source}`;
      this.toastGitIntegrate(output, `Merged ${source}`, source);
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
    }
  }

  async mergeLatestBase(): Promise<void> {
    const path = this.currentRepo()?.path;
    const base = this.baseUpdateRef();
    if (!path) return;
    if (!base) {
      this.showWarning('No base branch to merge from');
      return;
    }
    const remote = parseRemoteRef(base.ref)?.remote;
    const command = remote
      ? `git fetch --progress ${remote} && git merge ${base.ref}`
      : `git merge ${base.ref}`;
    if (!(await this.beginRemoteBusy('fetch', command))) return;
    let ok = false;
    let output = '';
    try {
      if (remote) {
        const fetched = await this.runRemoteWithAccountRetry(() =>
          this.withRepoMutation(() => this.tauri.fetch(path, { remote })),
        );
        if (fetched.message) output = fetched.message;
      }
      this.remoteBusy.set('merge');
      this.openGitProcess('merge', `git merge ${base.ref}`);
      await this.paintBusy();
      const result = await this.withRepoMutation(() => this.tauri.mergeBranch(path, base.ref));
      if (!result.ok) {
        output = [output, result.message].filter(Boolean).join('\n');
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      output = [output, result.message || `Merged ${base.label}`].filter(Boolean).join('\n');
      this.toastGitIntegrate(result.message, `Merged ${base.label}`, base.label);
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
    }
  }

  async rebaseOnto(onto: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const target = onto.trim();
    if (!path || !target) return;
    if (!(await this.beginRemoteBusy('rebase', `git rebase ${target}`))) return;
    let ok = false;
    let output = '';
    try {
      const result = await this.withRepoMutation(() => this.tauri.rebaseOnto(path, target));
      if (!result.ok) {
        output = result.message;
        await this.handleConflictResult(result);
        return;
      }
      await this.refreshRepo();
      output = result.message || `Rebased onto ${target}`;
      this.toastGitIntegrate(output, `Rebased onto ${target}`, target);
      ok = true;
    } catch (err) {
      output = rawErrorMessage(err);
      this.showError(err);
    } finally {
      this.endRemoteBusy(ok, output);
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
    const remote = this.pushRemoteName(branch);
    const command = [
      'git',
      'push',
      '--progress',
      pushOpts.setUpstream ? '-u' : '',
      remote,
      branch,
    ]
      .filter(Boolean)
      .join(' ');
    if (!(await this.beginRemoteBusy('push', command))) return false;
    let ok = false;
    let output = '';
    try {
      const result = await this.withRepoMutation(() =>
        this.tauri.push(path, {
          ...pushOpts,
          remote,
          branch,
        }),
      );
      await this.refreshRepo();
      output = result.message || `Pushed ${branch}`;
      this.showToast(output, {
        kind: 'success',
        durationMs: 3200,
        category: 'push',
      });
      ok = true;
      return true;
    } catch (err) {
      const raw = rawErrorMessage(err);
      output = raw;
      if (/non-fast-forward|rejected|fetch first/i.test(raw)) {
        await this.openForcePushSafety(branch);
        return false;
      }
      this.showError(err);
      return false;
    } finally {
      this.endRemoteBusy(ok, output);
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
      this.toastGitIntegrate(message, fallback);
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

  async lfsTrack(pattern: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const target = pattern.trim();
    if (!path || !target) return;
    try {
      const result = await this.tauri.lfsTrack(path, target);
      await this.refreshLfsFiles();
      await this.refreshWorkingTree();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async lfsUntrack(pattern: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const target = pattern.trim();
    if (!path || !target) return;
    try {
      const result = await this.tauri.lfsUntrack(path, target);
      await this.refreshLfsFiles();
      await this.refreshWorkingTree();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async lfsLock(filePath: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const target = filePath.trim();
    if (!path || !target) return;
    try {
      const result = await this.tauri.lfsLock(path, target);
      await this.refreshLfsFiles();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async lfsUnlock(filePath: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const target = filePath.trim();
    if (!path || !target) return;
    try {
      const result = await this.tauri.lfsUnlock(path, target);
      await this.refreshLfsFiles();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  openGitFlowDialog(): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.gitFlowDialogOpen.set(true);
  }

  closeGitFlowDialog(): void {
    this.gitFlowDialogOpen.set(false);
  }

  openBranchHygieneDialog(): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.branchHygieneDialogOpen.set(true);
  }

  closeBranchHygieneDialog(): void {
    this.branchHygieneDialogOpen.set(false);
  }

  openGitCleanDialog(): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.gitCleanDialogOpen.set(true);
  }

  closeGitCleanDialog(): void {
    this.gitCleanDialogOpen.set(false);
  }

  openFetchDialog(): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.fetchDialogOpen.set(true);
  }

  closeFetchDialog(): void {
    this.fetchDialogOpen.set(false);
  }

  openSyncPreview(kind: 'incoming' | 'outgoing'): void {
    if (!this.currentRepo()) {
      this.showWarning('Open a repository first');
      return;
    }
    this.syncPreviewKind.set(kind);
    this.syncPreviewDialogOpen.set(true);
  }

  closeSyncPreviewDialog(): void {
    this.syncPreviewDialogOpen.set(false);
  }

  async loadBranchHygiene(): Promise<BranchHygieneEntry[]> {
    const path = this.currentRepo()?.path;
    if (!path) return [];
    return this.tauri.listBranchHygiene(path);
  }

  async deleteLocalBranches(names: string[], force: boolean): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !names.length) return;
    const gone = new Set(
      this.localBranches()
        .filter((branch) => branch.upstreamGone)
        .map((branch) => branch.name),
    );
    try {
      for (const name of names) {
        await this.tauri.deleteBranch(path, name, force || gone.has(name));
      }
      await this.refreshRepo();
      this.showToast(`Deleted ${names.length} local branch${names.length === 1 ? '' : 'es'}`, {
        kind: 'success',
      });
    } catch (err) {
      this.showError(err);
    }
  }

  async loadSyncCommits(direction: 'incoming' | 'outgoing'): Promise<SyncCommitInfo[]> {
    const path = this.currentRepo()?.path;
    if (!path) return [];
    return this.tauri.listSyncCommits(path, direction);
  }

  async loadCleanPreview(): Promise<CleanEntry[]> {
    const path = this.currentRepo()?.path;
    if (!path) return [];
    return this.tauri.previewClean(path);
  }

  async runClean(paths: string[]): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !paths.length) return;
    try {
      const result = await this.tauri.runClean(path, paths);
      await this.refreshWorkingTree();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async loadDanglingCommits(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.danglingCommits.set([]);
      return;
    }
    try {
      this.danglingCommits.set(await this.tauri.listDanglingCommits(path));
    } catch (err) {
      this.showError(err);
    }
  }

  async loadLargeFiles(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.largeFiles.set([]);
      return;
    }
    try {
      this.largeFiles.set(await this.tauri.listLargeFiles(path));
    } catch (err) {
      this.showError(err);
    }
  }

  async setFileFlag(
    file: string,
    flag: 'skipWorktree' | 'assumeUnchanged' | 'skip-worktree' | 'assume-unchanged',
    enable: boolean,
  ): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !file.trim()) return;
    try {
      const result = await this.tauri.setFileFlag(path, file, flag, enable);
      await this.refreshWorkingTree();
      await this.loadFileFlags();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async loadFileFlags(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.fileFlags.set([]);
      return;
    }
    try {
      this.fileFlags.set(await this.tauri.listFileFlags(path));
    } catch (err) {
      this.showError(err);
    }
  }

  async exportPatchForSha(sha: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path || !sha.trim()) return;
    try {
      const result = await this.tauri.formatPatch(path, sha.trim());
      if (this.isDummyBackend) {
        await navigator.clipboard.writeText(result.patch);
        this.showSuccess('Copied patch to clipboard');
        return;
      }
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      const dest = await save({
        defaultPath: `${sha.slice(0, 7)}.patch`,
        filters: [{ name: 'Patch', extensions: ['patch'] }],
      });
      if (!dest) return;
      await writeTextFile(dest, result.patch);
      this.showSuccess('Saved patch');
    } catch (err) {
      this.showError(err);
    }
  }

  async applyPatchFromUser(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return;
    }
    try {
      let patch = '';
      if (this.isDummyBackend) {
        const pasted = await this.prompts.ask({
          title: 'Apply patch',
          message: 'Paste a mailbox patch',
          label: 'Patch',
          multiline: true,
          confirmLabel: 'Apply',
          required: true,
          mono: true,
        });
        if (!pasted?.trim()) return;
        patch = pasted;
      } else {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const { readTextFile } = await import('@tauri-apps/plugin-fs');
        const selected = await open({
          multiple: false,
          filters: [{ name: 'Patch', extensions: ['patch', 'mbox', 'diff', 'txt'] }],
        });
        if (!selected || Array.isArray(selected)) return;
        patch = await readTextFile(selected);
      }
      const result = await this.tauri.applyMailboxPatch(path, patch);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async syncUpstream(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return;
    }
    try {
      const result = await this.tauri.syncUpstream(path);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  toggleDiffIgnoreWhitespace(): void {
    this.diffIgnoreWhitespace.update((value) => !value);
  }

  toggleDiffWordHighlight(): void {
    this.diffWordHighlight.update((value) => !value);
  }

  async refreshCommitStatuses(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    const shas = this.commits()
      .slice(0, 12)
      .map((c) => c.sha);
    if (!shas.length) return;
    try {
      const statuses = await this.tauri.listCommitStatuses(path, shas);
      if (!this.currentRepo()?.path || !sameRepoPath(this.currentRepo()!.path, path)) return;
      this.commitStatuses.update((cur) => {
        const next = { ...cur };
        for (const status of statuses) {
          next[status.sha] = status.state;
          if (status.sha.length >= 7) next[status.sha.slice(0, 7)] = status.state;
        }
        return next;
      });
    } catch {
      /* optional */
    }
  }

  async togglePinnedCommit(sha: string): Promise<void> {
    const path = this.currentRepo()?.path;
    const id = sha.trim();
    if (!path || !id) return;
    const map = { ...this.settings().pinnedCommits };
    const current = [...(map[path] ?? [])];
    const idx = current.findIndex(
      (entry) => entry === id || entry.startsWith(id) || id.startsWith(entry),
    );
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.unshift(id);
      if (current.length > 20) current.length = 20;
    }
    if (current.length) map[path] = current;
    else delete map[path];
    await this.saveSettings({ pinnedCommits: map });
  }

  isCommitPinned(sha: string): boolean {
    const id = sha.trim();
    if (!id) return false;
    const pins = this.pinnedShasForRepo();
    if (pins.has(id)) return true;
    for (const pin of pins) {
      if (pin.startsWith(id) || id.startsWith(pin)) return true;
    }
    return false;
  }

  async runGitFlow(input: {
    kind: 'feature' | 'release' | 'hotfix' | string;
    action: 'start' | 'finish' | string;
    name: string;
    deleteBranch?: boolean;
    tag?: boolean;
    push?: boolean;
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return false;
    }
    try {
      const result = await this.tauri.gitFlow(path, {
        ...input,
        main: this.settings().gitFlowMain,
        develop: this.settings().gitFlowDevelop,
      });
      if (!result.ok) {
        this.showError(result.message);
        return false;
      }
      await this.refreshRepo();
      this.showSuccess(result.message);
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  async startBisect(opts?: { badSha?: string; goodSha?: string }): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) {
      this.showWarning('Open a repository first');
      return;
    }
    try {
      const result = await this.tauri.bisectStart(path, opts);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  async bisectGood(sha = ''): Promise<void> {
    await this.runBisectMark('good', sha);
  }

  async bisectBad(sha = ''): Promise<void> {
    await this.runBisectMark('bad', sha);
  }

  async bisectSkip(sha = ''): Promise<void> {
    await this.runBisectMark('skip', sha);
  }

  async bisectReset(): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result = await this.tauri.bisectReset(path);
      await this.refreshRepo();
      this.showToast(result.message, { kind: result.ok ? 'success' : 'warning' });
    } catch (err) {
      this.showError(err);
    }
  }

  private async runBisectMark(kind: 'good' | 'bad' | 'skip', sha: string): Promise<void> {
    const path = this.currentRepo()?.path;
    if (!path) return;
    try {
      const result =
        kind === 'good'
          ? await this.tauri.bisectGood(path, sha)
          : kind === 'bad'
            ? await this.tauri.bisectBad(path, sha)
            : await this.tauri.bisectSkip(path, sha);
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

  async startReleaseFlow(preferredBump?: 'patch' | 'minor' | 'major'): Promise<void> {
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
      if (!status.currentVersion?.trim()) {
        this.showWarning(
          'This repository has no version file Branchline can bump. Watch GitHub releases instead, or point release.config.json at a file with a semantic version.',
        );
        return;
      }

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
        preferredBump,
      });
      if (!setup) return;

      const opts = {
        bump: setup.bump,
        push: setup.push,
        message: setup.message,
        branch: setup.branch,
        createTag: setup.createTag,
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

      const backgroundFinish = !!preview.backgroundFinish;
      const confirmed = await this.prompts.ask({
        title: `Release ${preview.productName} ${preview.nextVersion}?`,
        message: [
          preview.willTag
            ? `${preview.currentVersion} → ${preview.nextVersion} (${preview.tag})`
            : `${preview.currentVersion} → ${preview.nextVersion}`,
          `Commit: ${preview.commitMessage}`,
          preview.willTag ? `Tag: ${preview.tagMessage}` : '',
          preview.willPush
            ? backgroundFinish
              ? 'Will bump, commit, tag, and push in a background process so the app stays responsive. tauri:dev may reload once; the release keeps going.'
              : 'Will bump, commit, tag, push, and watch until installers are published for every platform.'
            : preview.willTag
              ? 'Will bump, commit, and tag locally — you can push from the Release screen afterward.'
              : 'Will bump the version files and create a commit without creating or pushing a tag.',
          `Files: ${preview.files.join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
        confirmLabel: preview.willPush
          ? 'Release & deploy'
          : preview.willTag
            ? 'Create release'
            : 'Update version',
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
        willTag: preview.willTag,
        willPush: preview.willPush,
      });

      try {
        await this.withRepoMutation(async () => {
          if (this.isDummyBackend) {
            await this.simulateReleaseProgress(preview.willTag, preview.willPush);
            if (preview.willPush) {
              this.notifyReleaseOutcome('started', {
                productName: preview.productName,
                version: preview.nextVersion,
                tag: preview.tag,
              });
              void this.watchReleaseDeploy(path, preview.tag);
              return;
            }
            this.notifyReleaseOutcome(preview.willTag ? 'tagged' : 'committed', {
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
              phase: backgroundFinish ? 'pushing' : 'deploying',
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
            { needsPush: preview.willTag },
          );
          this.notifyReleaseOutcome(preview.willTag ? 'tagged' : 'committed', {
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
    createTag: boolean;
    push: boolean;
    files: ReleaseSetupFileHint[];
  }): Promise<boolean> {
    const path = this.currentRepo()?.path;
    if (!path) return false;
    this.releaseSetupError.set(null);
    try {
      const result = await this.tauri.saveReleaseConfig(path, input);
      this.showSuccess(result.message);
      return true;
    } catch (err) {
      const message = this.formatError(err);
      this.releaseSetupError.set(message);
      this.showError(message);
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
    const releaseMode = await this.selects.ask({
      title: 'Release setup',
      message: 'Choose how Branchline should finish releases by default.',
      label: 'Release mode',
      options: [
        { value: 'deploy', label: 'Create tag, push, and deploy (recommended)' },
        { value: 'tag', label: 'Create a local tag without pushing' },
        { value: 'commit', label: 'Version and commit without a tag' },
      ],
      initialValue: hints.pushDefault
        ? 'deploy'
        : hints.createTagDefault
          ? 'tag'
          : 'commit',
      confirmLabel: 'Next',
    });
    if (releaseMode !== 'deploy' && releaseMode !== 'tag' && releaseMode !== 'commit') {
      return false;
    }
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
      createTag: releaseMode !== 'commit',
      push: releaseMode === 'deploy',
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
    const url = this.releaseActivity()?.deployRunUrl?.trim();
    if (!url) {
      this.showWarning('No GitHub Actions run URL yet.');
      return;
    }
    await this.openReleaseExternalUrl(url);
  }

  async openReleasePage(): Promise<void> {
    const url = this.releaseActivity()?.releaseUrl?.trim();
    if (!url) {
      this.showWarning('No GitHub release URL yet.');
      return;
    }
    await this.openReleaseExternalUrl(url);
  }

  async refreshReleaseDeploy(): Promise<void> {
    const path = this.currentRepo()?.path;
    const activity = this.releaseActivity();
    if (!path || !activity || !sameRepoPath(activity.path, path) || !activity.tag) return;
    if (!activity.willPush || activity.needsPush) return;
    this.releaseDeployChecking.set(true);
    if (this.lastReleaseNoticeKey.endsWith(':paused')) this.lastReleaseNoticeKey = '';
    this.openReleaseTab();
    if (!this.releasingLocally()) {
      const attached = await this.attachLatestRelease({ force: true });
      if (attached) {
        const next = this.releaseActivity();
        const watching =
          !!next &&
          next.willPush &&
          !next.needsPush &&
          next.phase !== 'done' &&
          next.phase !== 'error';
        if (!watching) this.releaseDeployChecking.set(false);
        return;
      }
    }
    void this.watchReleaseDeploy(path, activity.tag, { immediate: true });
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
    this.releaseDeployChecking.set(false);
    this.stopReleaseDeployPoll();
  }

  private async watchReleaseDeploy(
    path: string,
    tag: string,
    options?: { immediate?: boolean },
  ): Promise<void> {
    this.stopReleaseDeployPoll();
    const watchGen = ++this.releaseDeployWatchGen;
    const activity = this.releaseActivity();
    if (!activity) {
      this.releaseDeployChecking.set(false);
      return;
    }
    let attempts = 0;
    let errors = 0;
    const poll = async (): Promise<void> => {
      attempts += 1;
      if (watchGen !== this.releaseDeployWatchGen) return;
      const current = this.releaseActivity();
      if (!current || !sameRepoPath(current.path, path) || current.tag !== tag) {
        this.releaseDeployChecking.set(false);
        this.stopReleaseDeployPoll();
        return;
      }
      try {
        const result = await this.tauri.pollReleaseDeploy(path, tag);
        if (watchGen !== this.releaseDeployWatchGen) return;
        this.releaseDeployChecking.set(false);
        errors = 0;
        const latest = this.releaseActivity();
        if (!latest || !sameRepoPath(latest.path, path) || latest.tag !== tag) {
          this.stopReleaseDeployPoll();
          return;
        }
        const jobs = adoptReleaseDeployJobs(result.jobs, latest.deployJobs);
        const terminalFailure =
          result.status === 'failure' || deployJobsTerminalFailure(jobs);
        if (
          latest.phase === 'error' &&
          !terminalFailure &&
          (result.status === 'pending' || result.status === 'unavailable')
        ) {
          this.releaseBusy.set(false);
          this.stopReleaseDeployPoll();
          return;
        }
        const phase = terminalFailure ? 'error' : normalizeReleasePhase(result.phase);
        const message = terminalFailure
          ? result.message.trim() || deployFailureMessage(tag, jobs)
          : result.message;
        const deployExtras = {
          deployRunUrl: result.runUrl ?? latest.deployRunUrl ?? null,
          releaseUrl: result.releaseUrl ?? latest.releaseUrl ?? null,
          websiteUrl: result.websiteUrl ?? latest.websiteUrl ?? null,
          actionsPageUrl: result.actionsPageUrl ?? latest.actionsPageUrl ?? null,
          repoUrl: result.repoUrl ?? latest.repoUrl ?? null,
          deployJobs: jobs,
          needsPush: false,
          needsRefresh: false,
        };
        this.applyReleaseProgress(
          {
            path,
            phase,
            message,
            version: latest.nextVersion,
            tag,
          },
          deployExtras,
        );
        const hadReleaseUrl = !!latest.releaseUrl;
        const nextUrl = deployExtras.releaseUrl;
        if (!hadReleaseUrl && nextUrl) {
          const notes = (this.releaseActivity()?.notes ?? '').trim();
          if (notes && !this.releaseActivity()?.notesSynced) {
            void this.publishReleaseNotesIfPossible();
          } else if (!notes) {
            void this.loadGitHubReleaseNotes();
          }
        }
        if (result.status === 'success' && !terminalFailure) {
          this.releaseBusy.set(false);
          const doneMessage =
            result.message.trim() ||
            `Release ${tag} is live on GitHub`;
          this.applyReleaseProgress(
            {
              path,
              phase: 'done',
              message: doneMessage,
              version: latest.nextVersion,
              tag,
            },
            deployExtras,
          );
          this.notifyReleaseOutcome('success', {
            productName: latest.productName,
            version: latest.nextVersion,
            tag,
            message: doneMessage,
          });
          this.stopReleaseDeployPoll();
          return;
        }
        if (terminalFailure) {
          this.releaseBusy.set(false);
          const failMessage =
            result.message.trim() || deployFailureMessage(tag, jobs);
          this.applyReleaseProgress(
            {
              path,
              phase: 'error',
              message: failMessage,
              version: latest.nextVersion,
              tag,
            },
            deployExtras,
          );
          this.notifyReleaseOutcome('failure', {
            productName: latest.productName,
            version: latest.nextVersion,
            tag,
            message: failMessage,
          });
          this.stopReleaseDeployPoll();
          return;
        }
        if (result.status === 'unavailable') {
          this.pauseReleaseTracking(path, tag, latest.nextVersion, result.message, deployExtras);
          return;
        }
        const failedJob = jobs.find((job) => deployConclusionFailed(job.conclusion));
        if (failedJob) {
          this.notifyReleaseOutcome('job-failed', {
            productName: latest.productName,
            version: latest.nextVersion,
            tag,
            message: `${failedJob.name} failed`,
          });
        }
        this.releaseBusy.set(true);
      } catch {
        if (watchGen !== this.releaseDeployWatchGen) return;
        this.releaseDeployChecking.set(false);
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
      if (watchGen !== this.releaseDeployWatchGen) return;
      if (attempts >= 720) {
        this.pauseReleaseTracking(
          path,
          tag,
          current.nextVersion,
          'Still building after an hour — refresh if GitHub already finished, or open the GitHub release.',
        );
        return;
      }
      const delay = attempts < 24 ? 5000 : 8000;
      this.releaseDeployPollTimer = window.setTimeout(() => {
        void poll();
      }, delay);
    };
    if (options?.immediate) {
      void poll();
      return;
    }
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
      this.showToast(result.message, this.undoFromToast(path));
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
      message: `Delete local branches that are merged, or whose remote was deleted. Keeps your current branch${current ? ` (${current})` : ''}, locked branches, worktree checkouts, and unmerged branches that still exist on origin.`,
      label: 'What to delete',
      options: [
        {
          value: 'merged',
          label: 'Merged only',
          hint: 'Deletes locals whose commits are already in HEAD',
        },
        ...(goneCount > 0
          ? [
              {
                value: 'gone',
                label: 'Remote deleted',
                hint: `Deletes ${goneCount} leftover local${goneCount === 1 ? '' : 's'} whose origin branch is gone`,
              },
            ]
          : []),
      ],
      initialValue: goneCount > 0 ? 'gone' : 'merged',
      confirmLabel: 'Continue',
    });
    if (mode !== 'merged' && mode !== 'gone') return;

    const selected =
      mode === 'gone'
        ? targets.filter((b) => b.upstreamGone)
        : targets.filter((b) => !b.upstreamGone);
    if (selected.length === 0) {
      this.showToast('No matching local branches to delete', { kind: 'info' });
      return;
    }

    const force = mode === 'gone';
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
        mode === 'merged'
          ? 'Nothing deleted — remaining branches are unmerged and still have an origin.'
          : `Could not delete ${skipped.length} branch${skipped.length === 1 ? '' : 'es'}.`,
      );
      return;
    }

    const parts = [`Deleted ${deleted} local branch${deleted === 1 ? '' : 'es'}`];
    if (skipped.length > 0) {
      parts.push(
        mode === 'merged' ? `skipped ${skipped.length} unmerged` : `failed ${skipped.length}`,
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
    willTag: activity.willTag !== false,
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

function firstNonEmptyUrl(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function hydrateReleaseActivity(activity: ReleaseActivity): ReleaseActivity {
  const deployJobs = adoptReleaseDeployJobs(activity.deployJobs);
  const hydrated = { ...activity, willTag: activity.willTag !== false, deployJobs };
  const looksIncomplete =
    activity.willPush &&
    !activity.needsPush &&
    !activity.releaseUrl &&
    activity.phase === 'done' &&
    /taking longer|Check GitHub Actions|installer builds|Link GitHub/i.test(activity.message ?? '');
  if (!looksIncomplete) return hydrated;
  return {
    ...hydrated,
    phase: 'deploying',
    needsRefresh: true,
    ok: null,
    finishedAt: null,
  };
}

function realJobTimestamp(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (
    trimmed.startsWith('0000-') ||
    trimmed.startsWith('0001-') ||
    trimmed.startsWith('1970-01-01')
  ) {
    return null;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms) || Number.isNaN(ms) || ms < Date.UTC(2010, 0, 1)) return null;
  return trimmed;
}

function sanitizeReleaseDeployJob(job: ReleaseDeployJob): ReleaseDeployJob {
  const status = (job.status ?? '').trim().toLowerCase();
  const live = status !== 'completed';
  return {
    ...job,
    status,
    conclusion: live ? null : job.conclusion,
    startedAt: realJobTimestamp(job.startedAt),
    completedAt: live ? null : realJobTimestamp(job.completedAt),
    steps: (job.steps ?? []).map((step) => {
      const stepStatus = (step.status ?? '').trim().toLowerCase();
      const stepLive = stepStatus !== 'completed';
      return {
        ...step,
        status: stepStatus,
        conclusion: stepLive ? null : step.conclusion,
        startedAt: realJobTimestamp(step.startedAt),
        completedAt: stepLive ? null : realJobTimestamp(step.completedAt),
      };
    }),
  };
}

function adoptReleaseDeployJobs(
  incoming: ReleaseDeployJob[] | undefined,
  previous?: ReleaseDeployJob[],
): ReleaseDeployJob[] {
  if (incoming && incoming.length > 0) {
    return incoming.map(sanitizeReleaseDeployJob);
  }
  return (previous ?? []).map(sanitizeReleaseDeployJob);
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

function deployOptionalJobName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('stabilize') || lower.includes('stable download');
}

function deployConclusionFailed(conclusion: string | null | undefined): boolean {
  const value = conclusion?.trim() ?? '';
  return (
    value === 'failure' ||
    value === 'cancelled' ||
    value === 'timed_out' ||
    value === 'startup_failure' ||
    value === 'action_required' ||
    value === 'stale'
  );
}

function deployJobActive(job: ReleaseDeployJob): boolean {
  if ((job.conclusion?.trim() ?? '') !== '') return false;
  return job.status.trim().toLowerCase() !== 'completed';
}

function deployJobsTerminalFailure(jobs: ReleaseDeployJob[] | undefined): boolean {
  if (!jobs?.length) return false;
  let failed = false;
  for (const job of jobs) {
    if (deployOptionalJobName(job.name)) continue;
    if (deployConclusionFailed(job.conclusion)) {
      failed = true;
      continue;
    }
    if (deployJobActive(job)) return false;
  }
  return failed;
}

function deployFailureMessage(tag: string, jobs: ReleaseDeployJob[]): string {
  const failed = jobs.find(
    (job) => !deployOptionalJobName(job.name) && deployConclusionFailed(job.conclusion),
  );
  if (failed) {
    const why = failed.conclusion?.trim() || 'failed';
    return `${failed.name} ${why} for ${tag}`;
  }
  return `Installer build failed for ${tag}`;
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

function buildReleaseSteps(willTag: boolean, willPush: boolean): ReleaseActivityStep[] {
  const steps: ReleaseActivityStep[] = [
    {
      id: 'preparing',
      phase: 'preparing',
      label: 'Check repo',
      message: 'Confirm branch, working tree, and next tag',
      status: 'pending',
    },
    {
      id: 'bumping',
      phase: 'bumping',
      label: 'Write versions',
      message: 'Update package, Tauri, and Cargo version files',
      status: 'pending',
    },
    {
      id: 'staging',
      phase: 'staging',
      label: 'Stage',
      message: 'git add the version files',
      status: 'pending',
    },
    {
      id: 'committing',
      phase: 'committing',
      label: 'Commit',
      message: 'git commit the release',
      status: 'pending',
    },
  ];
  if (willTag) {
    steps.push({
      id: 'tagging',
      phase: 'tagging',
      label: 'Tag',
      message: 'git tag -a the new version',
      status: 'pending',
    });
  }
  if (willPush) {
    steps.push({
      id: 'pushing',
      phase: 'pushing',
      label: 'Push',
      message: 'git push origin HEAD --tags',
      status: 'pending',
    });
    steps.push({
      id: 'deploying',
      phase: 'deploying',
      label: 'GitHub Actions',
      message: 'Watch GitHub until installer jobs appear',
      status: 'pending',
    });
    steps.push({
      id: 'ci',
      phase: 'ci',
      label: 'Installers',
      message: 'Build a package for each platform',
      status: 'pending',
    });
    steps.push({
      id: 'publishing',
      phase: 'publishing',
      label: 'Publish',
      message: 'GitHub release and download page',
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
      return {
        ...step,
        status: 'active',
        message,
        at: step.status === 'active' ? (step.at ?? Date.now()) : Date.now(),
      };
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
      baseUrl: '',
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

function clampSoundVolume(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function normalizeSettings(raw: Partial<AppSettings> | AppSettings): AppSettings {
  const base = defaultConnections();
  const incoming = Array.isArray(raw.connections) ? raw.connections : [];
  const connections =
    incoming.length === 0
      ? base
      : base.map((def) => {
          const found = incoming.find((c) => c.provider === def.provider || c.id === def.id);
          if (!found) return def;
          const merged = {
            ...def,
            ...found,
            organization: found.organization ?? '',
            project: found.project ?? '',
          };
          if (
            merged.provider === 'jira' &&
            /your-domain\.atlassian\.net/i.test(merged.baseUrl || '')
          ) {
            merged.baseUrl = '';
          }
          return merged;
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
    fetchAllRemotes: raw.fetchAllRemotes ?? true,
    fetchPrune: raw.fetchPrune ?? true,
    fetchTags: raw.fetchTags ?? false,
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
    keepGitProcessOpen: raw.keepGitProcessOpen ?? false,
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
    notifyPrReview: raw.notifyPrReview ?? true,
    notifyPrReady: raw.notifyPrReady ?? true,
    notifyRelease: raw.notifyRelease ?? true,
    notifySoundEnabled: raw.notifySoundEnabled ?? true,
    notifySoundVolume: clampSoundVolume(raw.notifySoundVolume),
    notifySoundPrReview: raw.notifySoundPrReview ?? true,
    notifySoundPrReady: raw.notifySoundPrReady ?? true,
    notifySoundPrCi: raw.notifySoundPrCi ?? true,
    notifySoundPrActivity: raw.notifySoundPrActivity ?? false,
    hideUntracked: raw.hideUntracked ?? false,
    uiDensity: raw.uiDensity === 'compact' ? 'compact' : 'comfortable',
    prTemplates: normalizePrTemplates(raw.prTemplates),
    prCreateMethod: raw.prCreateMethod === 'cli' ? 'cli' : 'browser',
    githubRepoAccounts: normalizeGithubRepoAccounts(raw.githubRepoAccounts),
    selectedRepoAccount: (raw.selectedRepoAccount ?? '').trim(),
    gitFlowMain: (raw.gitFlowMain ?? 'main').trim() || 'main',
    gitFlowDevelop: (raw.gitFlowDevelop ?? 'develop').trim() || 'develop',
    pinnedCommits: normalizePinnedCommits(raw.pinnedCommits),
    keyboardShortcuts: normalizeKeyboardShortcuts(raw.keyboardShortcuts),
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

function persistRepoWebUrls(
  urls: Record<string, string | null>,
  paths: string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const path of paths) {
    const key = path.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (urls[key] === undefined) continue;
    out[key] = urls[key];
    if (Object.keys(out).length >= 80) break;
  }
  return out;
}

function normalizeSessionRepoWebUrls(raw: unknown): Record<string, string | null> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = key.trim();
    if (!path) continue;
    if (value === null) {
      out[path] = null;
      continue;
    }
    if (typeof value === 'string' && value.trim()) out[path] = value.trim();
  }
  return out;
}

function normalizePinnedCommits(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const path = key.trim();
    if (!path || !Array.isArray(value)) continue;
    const shas = value
      .filter((sha): sha is string => typeof sha === 'string' && sha.trim().length > 0)
      .map((sha) => sha.trim())
      .slice(0, 20);
    if (shas.length) out[path] = shas;
  }
  return out;
}

function normalizeKeyboardShortcuts(raw: unknown): KeyboardShortcuts {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (key: keyof KeyboardShortcuts): string => {
    const value = src[key];
    return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_SHORTCUTS[key];
  };
  return {
    palette: pick('palette'),
    commit: pick('commit'),
    fetch: pick('fetch'),
    search: pick('search'),
    undo: pick('undo'),
    refresh: pick('refresh'),
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

function commitPrefixLength(current: CommitInfo[], next: CommitInfo[]): number {
  const n = Math.min(current.length, next.length);
  for (let i = 0; i < n; i++) {
    if (current[i].sha !== next[i].sha) return i;
  }
  return n;
}

function scheduleIdleWork(fn: () => void, timeout = 48): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
  if (ric) {
    const id = ric(() => fn(), { timeout });
    return () => {
      if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id);
    };
  }
  const id = window.setTimeout(fn, 0);
  return () => window.clearTimeout(id);
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
