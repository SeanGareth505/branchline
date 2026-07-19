export interface GitDetectOutput {
  installed: boolean;
  path: string | null;
  version: string | null;
  message: string;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export type ChecklistStatus = 'verified' | 'needsAttention' | 'skipped';

export interface OnboardingChecklistItem {
  id: string;
  label: string;
  description: string;
  status: ChecklistStatus;
}

export interface OnboardingStatusOutput {
  completed: boolean;
  skipped: boolean;
  items: OnboardingChecklistItem[];
}

export interface SshSetupOutput {
  keysFound: boolean;
  privateKeyPaths: string[];
  publicKeyPath: string | null;
  publicKey: string | null;
  preferredKeyName: string | null;
  generated: boolean;
  message: string;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpenedAt: string;
  pinned: boolean;
  isLast: boolean;
}

export interface RepoSummary {
  path: string;
  name: string;
  branch: string;
  ahead: number;
  behind: number;
  hasChanges: boolean;
}

export type FileStatusKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typeChanged'
  | 'ignored'
  | 'unknown';

export interface FileStatusEntry {
  path: string;
  status: FileStatusKind;
  originalPath?: string | null;
}

export interface RepoStatus {
  path: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  staged: FileStatusEntry[];
  unstaged: FileStatusEntry[];
  untracked: FileStatusEntry[];
  conflicted: FileStatusEntry[];
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  subject: string;
  author: string;
  email: string;
  timestamp: number;
  parents: string[];
  refs: string[];
  laneHint: number;
  isRelativeToHead: boolean;
}

export interface ArtificialCommit {
  id: string;
  kind: string;
  label: string;
  fileCount: number;
  added: number;
  modified: number;
  deleted: number;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  upstreamGone: boolean;
  tipSha: string | null;
  tipShortSha: string | null;
  tipSubject: string | null;
  tipAuthor: string | null;
  tipEmail: string | null;
  locked: boolean;
  lockReason: string | null;
}

export interface BranchLockInfo {
  branchName: string;
  reason: string | null;
  lockedAt: string;
}

export interface DiffFileEntry {
  path: string;
  status: string;
  additions?: number | null;
  deletions?: number | null;
}

export interface DiffOutput {
  unified: string;
  files: DiffFileEntry[];
}

export type SafetyAction =
  | 'deleteBranch'
  | 'hardReset'
  | 'forcePush'
  | 'discard'
  | 'deleteTag';

export interface SafetyCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface SafetyAnalysis {
  action: SafetyAction;
  title: string;
  severity: 'info' | 'warning' | 'danger' | string;
  target: string | null;
  consequence: string;
  advice: string;
  checks: SafetyCheck[];
  recommendedLabel: string;
  recommendedAction: string;
  proceedLabel: string;
  gitCommand: string;
  proceedGitCommand: string;
  confirmPrompt: string;
  requireTypedConfirm: boolean;
  blocked: boolean;
  canProceed: boolean;
}

export interface MutationOutput {
  ok: boolean;
  message: string;
}

export type DefaultPullAction = 'merge' | 'rebase' | 'fetch';
export type DefaultPushAction = 'upstream' | 'current' | 'matching';
export type SshClientPreference = 'openssh' | 'other';
export type ConnectionProvider = 'github' | 'gitlab' | 'azureDevOps' | 'jira';

export interface ConnectionConfig {
  id: string;
  provider: ConnectionProvider | string;
  label: string;
  enabled: boolean;
  baseUrl: string;
  username: string;
  token: string;
  organization: string;
  project: string;
  hasToken?: boolean;
}

export interface HostRepository {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  sshUrl: string;
  private: boolean;
  provider: string;
  updatedAt?: string | null;
}

export interface PublishToGithubOutput {
  ok: boolean;
  message: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  releaseUrl?: string | null;
  tagName?: string | null;
}

export interface GithubDeviceStartOutput {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  expiresIn: number;
  interval: number;
}

export interface GithubDevicePollOutput {
  status: string;
  accessToken?: string | null;
  tokenType?: string | null;
  scope?: string | null;
  errorDescription?: string | null;
  interval?: number | null;
}

export interface CommitTypeOption {
  id: string;
  label: string;
  description?: string;
}

export interface AppSettings {
  theme: string;
  accent: string;
  simpleMode: boolean;
  layout: Record<string, unknown>;
  focusMode: boolean;
  defaultPullAction: DefaultPullAction;
  defaultPushAction: DefaultPushAction;
  autoFetchOnOpen: boolean;
  confirmForcePush: boolean;
  confirmDiscard: boolean;
  signOffByDefault: boolean;
  pushAfterCommit: boolean;
  myBranchesOnly: boolean;
  branchPrefixEnabled: boolean;
  branchPrefix: string;
  branchPrefixes: string[];
  editorCommand: string;
  diffTool: string;
  mergeTool: string;
  sshClient: SshClientPreference | string;
  connections: ConnectionConfig[];
  commitTypes: CommitTypeOption[];
  githubOAuthClientId: string;
  notificationsEnabled: boolean;
  notifyToasts: boolean;
  notifyDesktop: boolean;
  notifyGitFetch: boolean;
  notifyGitPull: boolean;
  notifyGitPush: boolean;
  notifyGitCommit: boolean;
  notifyGitConflicts: boolean;
  notifyRemoteBehind: boolean;
  notifyAppUpdates: boolean;
  notifyPrActivity: boolean;
  notifyPrCi: boolean;
}

export interface GitEnvSnapshot {
  credentialHelper: string;
  coreEditor: string;
  diffTool: string;
  mergeTool: string;
  sshKeysFound: boolean;
  sshKeyPaths: string[];
}

export interface BlameLine {
  lineNumber: number;
  content: string;
  sha: string;
  author: string;
  email: string;
  timestamp: number;
  summary: string;
}

export interface FileHistoryEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: number;
}

export interface MockPullRequest {
  id: string;
  number: number;
  title: string;
  author: string;
  assignees: string[];
  reviewers: string[];
  team: string;
  repo: string;
  sourceBranch: string;
  targetBranch: string;
  status: string;
  url: string;
  labels: string[];
  updatedAt: string;
  draft: boolean;
  reviewState: string;
  pipelineStatus: string;
  additions: number;
  deletions: number;
  commentCount: number;
  isMine: boolean;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string;
  priority: string;
  issueType: string;
  url: string;
  updatedAt: string;
  labels: string[];
}

export type MockJiraIssue = JiraIssue;

export interface JiraTransition {
  id: string;
  name: string;
  toStatus: string;
}

export interface ProfileInfo {
  id: string;
  name: string;
  email: string;
  kind: string;
}

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  steps: string[];
  builtin: boolean;
  enabled: boolean;
}

export interface TemplateInfo {
  id: string;
  kind: string;
  name: string;
  pattern: string;
}

export interface UndoEntry {
  id: string;
  repoPath: string;
  action: string;
  label: string;
  payload: unknown;
  createdAt: string;
  restored: boolean;
}

export interface CherryPickPreviewCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  alreadyApplied: boolean;
}

export interface CherryPickPreview {
  commits: CherryPickPreviewCommit[];
  estimatedConflicts: boolean;
  message: string;
}

export interface StashEntry {
  index: number;
  id: string;
  message: string;
  branch?: string | null;
}

export interface TagInfo {
  name: string;
  sha: string;
  shortSha: string;
  message?: string | null;
}

export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface ReflogEntry {
  index: number;
  sha: string;
  shortSha: string;
  selector: string;
  action: string;
  subject: string;
  timestamp: number;
}

export interface RunGitOutput {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface HistoryFilter {
  query: string;
  author: string;
  currentBranchOnly: boolean;
  mineOnly: boolean;
}

export interface UiSession {
  view?: string;
  browseTab?: string;
  automationFilter?: 'all' | 'custom' | 'builtin';
  historyCurrentBranchOnly?: boolean;
  historyMineOnly?: boolean;
  prStatus?: string;
  prMineOnly?: boolean;
  prNeedsMyReview?: boolean;
  prReview?: string;
  prSortKey?: string;
  splitMain?: number[];
  splitNested?: number[];
  openRepoPaths?: string[];
  activeRepoPath?: string | null;
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseCommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
}

export interface RebasePreview {
  onto: string;
  ontoShort: string;
  commits: RebaseCommitInfo[];
}

export interface RebaseStep {
  sha: string;
  action: RebaseAction;
  message?: string | null;
  shortSha: string;
  subject: string;
  author: string;
}

export interface WorktreeInfo {
  path: string;
  head: string;
  shortHead: string;
  branch?: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

export type IgnoreKind = 'gitignore' | 'exclude';

export interface IgnoreFileOutput {
  kind: IgnoreKind | string;
  filePath: string;
  content: string;
  exists: boolean;
}
