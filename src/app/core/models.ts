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
  conflictKind?: string | null;
  conflictLabel?: string | null;
  markersCleared?: boolean | null;
}

export interface GitOperationInfo {
  kind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | string;
  label: string;
  detail?: string | null;
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
  operation?: GitOperationInfo | null;
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

export type PreferredEditor = 'auto' | 'cursor' | 'vscode' | 'system' | 'command';

export interface DetectedEditors {
  cursor: boolean;
  vscode: boolean;
  cursorPath: string | null;
  vscodePath: string | null;
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
  confirmPushNewBranch: boolean;
  confirmAddTrackingRef: boolean;
  confirmAmend: boolean;
  confirmUndoLastCommit: boolean;
  confirmStashDrop: boolean;
  confirmAbortOperation: boolean;
  confirmAbortSecond: boolean;
  confirmRemoveRemote: boolean;
  signOffByDefault: boolean;
  pushAfterCommit: boolean;
  myBranchesOnly: boolean;
  branchPrefixEnabled: boolean;
  branchPrefix: string;
  branchPrefixes: string[];
  preferredEditor: PreferredEditor;
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
  needsMyReview: boolean;
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

export type IdentitySource = 'local' | 'global' | 'history';

export interface IdentityCandidate {
  id: string;
  name: string;
  email: string;
  source: IdentitySource | string;
  label: string;
  commitCount: number | null;
  isActive: boolean;
  aliases?: string[];
}

export interface IdentityContexts {
  effective: GitIdentity;
  effectiveScope: 'local' | 'global' | 'unset' | string;
  local: GitIdentity | null;
  global: GitIdentity | null;
  candidates: IdentityCandidate[];
  hasRepo: boolean;
}

export interface WorkflowStepConfig {
  namePattern?: string;
  startPoint?: string;
  checkout?: boolean;
  branch?: string;
  stashMessage?: string;
  skipPrompt?: boolean;
}

export interface WorkflowStep {
  id: string;
  config?: WorkflowStepConfig;
}

export type WorkflowStepJson = string | WorkflowStep;

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStepJson[];
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

export interface SubmoduleInfo {
  name: string;
  path: string;
  url: string;
  head: string;
  shortHead: string;
  status: string;
  initialized: boolean;
}

export interface LfsFileInfo {
  path: string;
  locked: boolean;
  size: string;
}

export interface ConflictSidesOutput {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  working: string;
  hasBase: boolean;
  hasOurs: boolean;
  hasTheirs: boolean;
  binary: boolean;
  unmerged?: boolean;
  hasMarkers?: boolean;
}

export interface ReleaseConfigInfo {
  productName: string;
  tagPrefix: string;
  branch: string;
  requireClean: boolean;
  pushDefault: boolean;
  commitMessage: string;
  tagMessage: string;
  files: string[];
  configPath: string;
}

export interface ReleaseStatusOutput {
  available: boolean;
  message: string;
  config?: ReleaseConfigInfo | null;
  currentVersion?: string | null;
  currentBranch?: string | null;
  dirty: boolean;
}

export interface ReleasePreviewOutput {
  ok: boolean;
  message: string;
  productName: string;
  currentVersion: string;
  nextVersion: string;
  tag: string;
  branch: string;
  currentBranch: string;
  requireClean: boolean;
  dirty: boolean;
  willPush: boolean;
  commitMessage: string;
  tagMessage: string;
  files: string[];
  blockers: string[];
}

export interface ReleaseRunOptions {
  bump: string;
  preid?: string | null;
  push?: boolean;
  message?: string | null;
  tagMessage?: string | null;
  allowDirty?: boolean;
  branch?: string | null;
}

export interface CreatePullRequestOutput {
  ok: boolean;
  message: string;
  url?: string | null;
  number?: number | null;
}

export type IgnoreKind = 'gitignore' | 'exclude';

export interface IgnoreFileOutput {
  kind: IgnoreKind | string;
  filePath: string;
  content: string;
  exists: boolean;
}

export interface CrashReport {
  at: string;
  message: string;
  location?: string | null;
  version: string;
  os: string;
}

export interface ClientErrorEntry {
  at: string;
  source: string;
  message: string;
  detail?: string | null;
}

export interface DiagnosticsSummary {
  version: string;
  os: string;
  diagnosticsDir: string;
  logHint: string;
  lastCrash: CrashReport | null;
  recentErrors: ClientErrorEntry[];
  lastUncleanShutdown?: string | null;
}
