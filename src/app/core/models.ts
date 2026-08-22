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
  signature?: string | null;
}

export interface BranchHygieneEntry {
  name: string;
  reason: 'merged' | 'gone' | 'stale' | string;
  detail: string;
  safeToDelete: boolean;
  tipSha?: string;
  tipShortSha?: string;
}

export interface SyncCommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  timestamp: number;
}

export interface CleanEntry {
  path: string;
  kind: 'untracked' | 'ignored' | string;
  sizeLabel: string;
}

export interface LargeFileEntry {
  path: string;
  sizeLabel: string;
  bytes: number;
  lfs: boolean;
}

export interface FileFlagEntry {
  path: string;
  skipWorktree: boolean;
  assumeUnchanged: boolean;
}

export interface FormatPatchOutput {
  patch: string;
}

export interface CommitStatusInfo {
  sha: string;
  state: 'success' | 'failure' | 'pending' | 'unknown' | string;
}

export interface BlobPreview {
  kind: 'image' | 'binary' | 'missing' | string;
  mime: string;
  base64?: string | null;
}

export interface KeyboardShortcuts {
  palette: string;
  commit: string;
  fetch: string;
  search: string;
  undo: string;
  refresh: string;
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
  ahead: number;
  behind: number;
  tipSha: string | null;
  tipShortSha: string | null;
  tipSubject: string | null;
  tipAuthor: string | null;
  tipEmail: string | null;
  locked: boolean;
  lockReason: string | null;
  jiraKey?: string | null;
}

export interface BranchLockInfo {
  branchName: string;
  reason: string | null;
  lockedAt: string;
}

export interface BranchJiraLink {
  branchName: string;
  issueKey: string;
  linkedAt: string;
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
  htmlUrl: string;
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

export type TicketCase = 'preserve' | 'upper' | 'lower';
export type CommitShortcutId = 'type' | 'scope' | 'topic' | 'fixes';

export interface TicketFromBranchSettings {
  enabled: boolean;
  matchTicketKey: boolean;
  useSegment: boolean;
  segmentIndex: number;
  customPattern: string;
  ticketCase: TicketCase;
  putInScope: boolean;
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
  fetchAllRemotes: boolean;
  fetchPrune: boolean;
  fetchTags: boolean;
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
  keepGitProcessOpen: boolean;
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
  ticketFromBranch: TicketFromBranchSettings;
  commitShortcutSequence: CommitShortcutId[];
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
  notifyPrReview: boolean;
  notifyPrReady: boolean;
  notifyRelease: boolean;
  notifySoundEnabled: boolean;
  notifySoundVolume: number;
  notifySoundPrReview: boolean;
  notifySoundPrReady: boolean;
  notifySoundPrCi: boolean;
  notifySoundPrActivity: boolean;
  hideUntracked: boolean;
  uiDensity: 'comfortable' | 'compact';
  prTemplates: SavedPrTemplate[];
  prCreateMethod: PrCreateMethod;
  githubRepoAccounts: Record<string, GithubRepoAccountPref>;
  selectedRepoAccount: string;
  gitFlowMain: string;
  gitFlowDevelop: string;
  pinnedCommits: Record<string, string[]>;
  keyboardShortcuts: KeyboardShortcuts;
}

export interface GitEnvSnapshot {
  credentialHelper: string;
  coreEditor: string;
  diffTool: string;
  mergeTool: string;
  sshKeysFound: boolean;
  sshKeyPaths: string[];
  sshAgent: boolean;
  commitGpgsign: boolean;
  gpgFormat: string;
  userSigningKey: string;
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

export interface SearchHit {
  path: string;
  line: number | null;
  text: string;
  kind: 'file' | 'content' | string;
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
  approvals?: number;
  changesRequested?: number;
  pendingReviewers?: number;
  approvedBy?: string[];
  requestedChangesBy?: string[];
  commentedBy?: string[];
  checkPassed?: number;
  checkFailed?: number;
  checkPending?: number;
  checkTotal?: number;
  mergeable?: boolean | null;
  mergeState?: string;
  readyToMerge?: boolean;
  checkSummary?: string;
  checkFailedNames?: string[];
  checkPendingNames?: string[];
  body?: string;
}

export type PrCommentKind = 'conversation' | 'review' | 'code';

export interface PrComment {
  id: string;
  kind: PrCommentKind;
  author: string;
  body: string;
  createdAt: string;
  path?: string | null;
  line?: number | null;
  diffHunk?: string | null;
  reviewState?: string | null;
  resolved?: boolean;
}

export interface PrCommentThread {
  id: string;
  kind: PrCommentKind;
  path?: string | null;
  line?: number | null;
  diffHunk?: string | null;
  resolved?: boolean;
  reviewState?: string | null;
  comments: PrComment[];
}

export type PrCopyFormat =
  | 'links'
  | 'markdown'
  | 'slack'
  | 'standup'
  | 'titles'
  | 'refs'
  | 'checkout'
  | 'csv';

export function prApprovals(pr: MockPullRequest): number {
  return pr.approvals ?? 0;
}

export function prChangesRequested(pr: MockPullRequest): number {
  return pr.changesRequested ?? 0;
}

export function prPendingReviewers(pr: MockPullRequest): number {
  if (typeof pr.pendingReviewers === 'number') return pr.pendingReviewers;
  const waiting = pr.reviewers.filter(
    (name) => !(pr.approvedBy ?? []).some((a) => a.toLowerCase() === name.toLowerCase()),
  );
  return waiting.length;
}

export function prCheckPassed(pr: MockPullRequest): number {
  return pr.checkPassed ?? 0;
}

export function prCheckFailed(pr: MockPullRequest): number {
  return pr.checkFailed ?? 0;
}

export function prCheckPending(pr: MockPullRequest): number {
  return pr.checkPending ?? 0;
}

export function prCheckTotal(pr: MockPullRequest): number {
  if (typeof pr.checkTotal === 'number' && pr.checkTotal > 0) return pr.checkTotal;
  return prCheckPassed(pr) + prCheckFailed(pr) + prCheckPending(pr);
}

export type PrCheckGroupState = 'failed' | 'pending' | 'passed';

export interface PrCheckGroup {
  state: PrCheckGroupState;
  label: string;
  count: number;
  names: string[];
}

export function prCheckGroups(pr: MockPullRequest): PrCheckGroup[] {
  const groups: PrCheckGroup[] = [];
  const failed = prCheckFailed(pr);
  const pending = prCheckPending(pr);
  const passed = prCheckPassed(pr);
  if (failed) {
    groups.push({
      state: 'failed',
      label: 'Failing',
      count: failed,
      names: pr.checkFailedNames ?? [],
    });
  }
  if (pending) {
    groups.push({
      state: 'pending',
      label: 'Running',
      count: pending,
      names: pr.checkPendingNames ?? [],
    });
  }
  if (passed) {
    groups.push({
      state: 'passed',
      label: 'Passed',
      count: passed,
      names: [],
    });
  }
  return groups;
}

export function prReadyToMerge(pr: MockPullRequest): boolean {
  if (typeof pr.readyToMerge === 'boolean') return pr.readyToMerge;
  return (
    pr.status === 'open' &&
    !pr.draft &&
    pr.reviewState === 'approved' &&
    pr.pipelineStatus !== 'failure' &&
    pr.pipelineStatus !== 'pending' &&
    prChangesRequested(pr) === 0
  );
}

export function prMergeBlockReason(pr: MockPullRequest): string | null {
  if (pr.status !== 'open') return `This pull request is ${pr.status}`;
  if (pr.draft) return 'Mark ready before merging';
  const state = (pr.mergeState ?? '').toLowerCase();
  if (pr.mergeable === false || state === 'dirty' || state === 'conflicting') {
    return 'Has merge conflicts';
  }
  if (prCheckFailed(pr) > 0 || pr.pipelineStatus === 'failure') return 'CI is failing';
  if (pr.reviewState === 'changesRequested' || prChangesRequested(pr) > 0) {
    return 'Requested changes are outstanding';
  }
  if (pr.reviewState !== 'approved' && prApprovals(pr) === 0) return 'Needs approval';
  if (state === 'blocked') return 'Merge is blocked';
  if (state === 'behind') return 'Branch is behind the base';
  return null;
}

export type PrReviewerState = 'approved' | 'changes' | 'commented' | 'pending';

export interface PrReviewerPerson {
  name: string;
  state: PrReviewerState;
}

export function prReviewerPeople(pr: MockPullRequest): PrReviewerPerson[] {
  const approved = new Set((pr.approvedBy ?? []).map((n) => n.toLowerCase()));
  const changes = new Set((pr.requestedChangesBy ?? []).map((n) => n.toLowerCase()));
  const commented = new Set((pr.commentedBy ?? []).map((n) => n.toLowerCase()));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const name of [
    ...pr.reviewers,
    ...(pr.approvedBy ?? []),
    ...(pr.requestedChangesBy ?? []),
    ...(pr.commentedBy ?? []),
  ]) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name.trim());
  }
  return names.map((name) => {
    const key = name.toLowerCase();
    const state: PrReviewerState = approved.has(key)
      ? 'approved'
      : changes.has(key)
        ? 'changes'
        : commented.has(key)
          ? 'commented'
          : 'pending';
    return { name, state };
  });
}

export interface PrReviewerGroup {
  state: PrReviewerState;
  label: string;
  people: PrReviewerPerson[];
}

export function prReviewerStateLabel(state: PrReviewerState): string {
  switch (state) {
    case 'approved':
      return 'Approved';
    case 'changes':
      return 'Requested changes';
    case 'commented':
      return 'Commented';
    default:
      return 'Waiting to review';
  }
}

export function prReviewerGroups(people: PrReviewerPerson[]): PrReviewerGroup[] {
  return (['approved', 'changes', 'commented', 'pending'] as const)
    .map((state) => ({
      state,
      label: prReviewerStateLabel(state),
      people: people.filter((person) => person.state === state),
    }))
    .filter((group) => group.people.length > 0);
}

export function prReviewerSummary(people: PrReviewerPerson[], emptyLabel = 'No reviewers'): string {
  if (!people.length) return emptyLabel;
  const changes = people.filter((person) => person.state === 'changes').length;
  if (changes) return `${changes} requested changes`;
  const approved = people.filter((person) => person.state === 'approved').length;
  return `${approved} of ${people.length} approved`;
}

export function prReviewerInitials(name: string): string {
  const cleaned = name.replace(/^@/, '').trim();
  const parts = cleaned.split(/[._\-\s]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return cleaned.slice(0, 2).toUpperCase() || '?';
}

const PR_BODY_TRACKING_PARAMS = new Set(['atlOrigin', 'atl_f', 'focusedCommentId', 'pageId']);

export function prBodyDisplay(body?: string | null): string {
  if (!body) return '';
  return body.replace(/https?:\/\/[^\s)<>\]]+/g, (url) => {
    try {
      const parsed = new URL(url);
      let changed = false;
      for (const key of [...parsed.searchParams.keys()]) {
        if (PR_BODY_TRACKING_PARAMS.has(key) || key.startsWith('utm_')) {
          parsed.searchParams.delete(key);
          changed = true;
        }
      }
      if (!changed) return url;
      parsed.hash = '';
      return parsed.toString().replace(/\?$/, '');
    } catch {
      return url;
    }
  });
}

export interface PrBodySegment {
  kind: 'text' | 'link';
  text: string;
  href?: string;
}

export function prBodySegments(body?: string | null): PrBodySegment[] {
  const display = prBodyDisplay(body);
  if (!display) return [];
  const segments: PrBodySegment[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<>\]]+)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(display))) {
    if (match.index > last) {
      segments.push({ kind: 'text', text: display.slice(last, match.index) });
    }
    if (match[1] && match[2]) {
      segments.push({ kind: 'link', text: match[1], href: match[2] });
    } else if (match[3]) {
      segments.push({ kind: 'link', text: match[3], href: match[3] });
    }
    last = match.index + match[0].length;
  }
  if (last < display.length) {
    segments.push({ kind: 'text', text: display.slice(last) });
  }
  return segments;
}

export function prBodyExcerpt(body?: string | null, max = 160): string {
  if (!body) return '';
  const text = prBodyDisplay(body)
    .replace(/\r/g, '')
    .split('\n')
    .map((part) =>
      part
        .replace(/^#+\s*/, '')
        .replace(/[*_`>#]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join(' ');
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

export function prConversationThreads(threads: PrCommentThread[]): PrCommentThread[] {
  return threads.filter((thread) => thread.kind !== 'code');
}

export function prCodeThreads(threads: PrCommentThread[]): PrCommentThread[] {
  return threads.filter((thread) => thread.kind === 'code');
}

export function prDiffHunkPreview(hunk?: string | null, maxLines = 6): string {
  if (!hunk) return '';
  const lines = hunk.replace(/\r/g, '').split('\n').filter((line) => line.length > 0);
  return lines.slice(-maxLines).join('\n');
}

export function prReviewStateLabel(state?: string | null): string | null {
  switch ((state ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'Approved';
    case 'CHANGES_REQUESTED':
      return 'Requested changes';
    case 'COMMENTED':
      return 'Commented';
    case 'DISMISSED':
      return 'Dismissed';
    default:
      return null;
  }
}

export function normalizePullRequest(pr: MockPullRequest): MockPullRequest {
  const approvals =
    pr.approvals ??
    (pr.reviewState === 'approved' ? Math.max(1, pr.reviewers.length || 1) : 0);
  const changesRequested =
    pr.changesRequested ?? (pr.reviewState === 'changesRequested' ? 1 : 0);
  const approvedBy =
    pr.approvedBy ??
    (approvals > 0 ? pr.reviewers.slice(0, approvals) : []);
  const requestedChangesBy =
    pr.requestedChangesBy ??
    (changesRequested > 0 ? pr.reviewers.slice(0, 1) : []);
  let checkPassed = pr.checkPassed;
  let checkFailed = pr.checkFailed;
  let checkPending = pr.checkPending;
  if (checkPassed == null && checkFailed == null && checkPending == null) {
    if (pr.pipelineStatus === 'success') checkPassed = 3;
    else if (pr.pipelineStatus === 'failure') {
      checkFailed = 1;
      checkPassed = 2;
    } else if (pr.pipelineStatus === 'pending') {
      checkPending = 2;
      checkPassed = 1;
    } else if (pr.pipelineStatus === 'cancelled') {
      checkFailed = 1;
    }
  }
  checkPassed ??= 0;
  checkFailed ??= 0;
  checkPending ??= 0;
  const checkTotal = pr.checkTotal ?? checkPassed + checkFailed + checkPending;
  const pendingReviewers =
    pr.pendingReviewers ??
    pr.reviewers.filter(
      (name) => !approvedBy.some((a) => a.toLowerCase() === name.toLowerCase()),
    ).length;
  const mergeState = pr.mergeState ?? (pr.mergeable === false ? 'dirty' : '');
  const readyToMerge =
    pr.readyToMerge ??
    (pr.status === 'open' &&
      !pr.draft &&
      changesRequested === 0 &&
      approvals > 0 &&
      checkFailed === 0 &&
      checkPending === 0 &&
      mergeState !== 'dirty' &&
      mergeState !== 'blocked' &&
      mergeState !== 'conflicting');
  const checkSummary =
    pr.checkSummary ||
    (checkTotal > 0 ? `${checkPassed}/${checkTotal} checks` : '');
  return {
    ...pr,
    approvals,
    changesRequested,
    pendingReviewers,
    approvedBy,
    requestedChangesBy,
    commentedBy: pr.commentedBy ?? [],
    checkPassed,
    checkFailed,
    checkPending,
    checkTotal,
    mergeable: pr.mergeable ?? null,
    mergeState,
    readyToMerge,
    checkSummary,
    checkFailedNames: pr.checkFailedNames ?? [],
    checkPendingNames: pr.checkPendingNames ?? [],
  };
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

export type CheckTrigger = 'pre-commit' | 'commit-msg' | 'pre-push' | 'manual' | string;
export type CheckRunStatus = 'idle' | 'running' | 'pass' | 'fail' | 'skipped';

export interface RepoCheck {
  id: string;
  name: string;
  command: string;
  trigger: CheckTrigger;
  source: string;
  sourceLabel: string;
  enabled: boolean;
  builtin: boolean;
}

export interface CheckManager {
  id: string;
  label: string;
  detail: string;
}

export interface RepoChecksOutput {
  path: string;
  managers: CheckManager[];
  checks: RepoCheck[];
  newlyDetected: string[];
}

export interface RunCheckOutput {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CheckRunState {
  status: CheckRunStatus;
  output: string;
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
  sha?: string | null;
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

export interface ProbeRemoteOutput {
  ok: boolean;
  url: string;
  protocol: string;
  message: string;
}

export interface GithubCliAccount {
  login: string;
  active: boolean;
  ok: boolean;
}

export interface GithubGitStatus {
  sshLogin: string;
  usesGhHelper: boolean;
  ghAvailable?: boolean;
  accounts: GithubCliAccount[];
  activeLogin: string;
}

export interface GithubRepoAccountPref {
  login: string;
  protocol: 'https' | 'ssh';
}

export interface TestConnectionInput {
  kind: 'github' | 'gitlab' | 'azureDevOps' | 'jira' | 'gitRemote' | 'ssh';
  connectionId?: string;
  path?: string;
  remote?: string;
  url?: string;
  host?: string;
}

export interface TestConnectionOutput {
  ok: boolean;
  kind: string;
  connectionId?: string;
  account: string;
  message: string;
  detail: string;
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
  firstParent: boolean;
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
  releaseAppId?: string;
  releaseAppIdByRepo?: Record<string, string>;
  releaseQuery?: string;
  releaseStatus?: string;
  releaseEnvironment?: string;
  releaseKind?: string;
  releaseSort?: string;
  releaseJobFilter?: string;
  splitMain?: number[];
  splitNested?: number[];
  commitSplitFiles?: number[];
  commitSplitComposer?: number[];
  revisionGridColumns?: RevisionGridColumns;
  openRepoPaths?: string[];
  activeRepoPath?: string | null;
  activeRepoPathByAccount?: Record<string, string>;
  repoWebUrls?: Record<string, string | null>;
}

export interface RevisionGridColumns {
  graph?: number;
  message?: number;
  author: number;
  date: number;
  sha: number;
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
  lockOwner?: string;
  size: string;
}

export interface BisectStatus {
  active: boolean;
  currentSha: string;
  currentShortSha: string;
  terms: string;
  stepsLeft?: string | null;
  logTail: string;
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
  createTagDefault: boolean;
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
  willTag: boolean;
  willPush: boolean;
  commitMessage: string;
  tagMessage: string;
  files: string[];
  devSkippedFiles?: string[];
  backgroundFinish?: boolean;
  blockers: string[];
}

export interface ReleaseRunOptions {
  bump: string;
  preid?: string | null;
  createTag?: boolean;
  push?: boolean;
  message?: string | null;
  tagMessage?: string | null;
  allowDirty?: boolean;
  branch?: string | null;
}

export type ReleasePhase =
  | 'idle'
  | 'preparing'
  | 'bumping'
  | 'staging'
  | 'committing'
  | 'tagging'
  | 'pushing'
  | 'deploying'
  | 'ci'
  | 'publishing'
  | 'done'
  | 'error';

export interface ReleaseSetupFileHint {
  path: string;
  kind: string;
  keys?: string[] | null;
  package?: string | null;
  label: string;
}

export interface ReleaseSetupHintsOutput {
  productName: string;
  branch: string;
  currentVersion?: string | null;
  createTagDefault: boolean;
  pushDefault: boolean;
  suggestedFiles: ReleaseSetupFileHint[];
}

export interface ReleaseDeployJobStep {
  name: string;
  status: string;
  conclusion?: string | null;
  number?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ReleaseDeployJob {
  name: string;
  status: string;
  conclusion?: string | null;
  url?: string | null;
  steps?: ReleaseDeployJobStep[];
  startedAt?: string | null;
  completedAt?: string | null;
  typicalMs?: number | null;
}

export interface PollReleaseDeployOutput {
  status: 'pending' | 'running' | 'success' | 'failure' | 'unavailable' | string;
  phase: ReleasePhase | string;
  message: string;
  runUrl?: string | null;
  releaseUrl?: string | null;
  websiteUrl?: string | null;
  actionsPageUrl?: string | null;
  repoUrl?: string | null;
  jobs?: ReleaseDeployJob[];
}

export interface ReleaseProgressEvent {
  path: string;
  phase: ReleasePhase | string;
  message: string;
  version?: string | null;
  tag?: string | null;
}

export interface ReleaseActivityStep {
  id: string;
  phase: ReleasePhase;
  label: string;
  message: string;
  status: 'pending' | 'active' | 'done' | 'error';
  at?: number | null;
}

export interface ReleaseActivity {
  path: string;
  productName: string;
  currentVersion: string;
  nextVersion: string;
  tag: string;
  willTag?: boolean;
  willPush: boolean;
  needsPush?: boolean;
  deployRunUrl?: string | null;
  releaseUrl?: string | null;
  websiteUrl?: string | null;
  actionsPageUrl?: string | null;
  repoUrl?: string | null;
  deployJobs?: ReleaseDeployJob[];
  needsRefresh?: boolean;
  phase: ReleasePhase;
  message: string;
  notes?: string | null;
  notesSynced?: boolean;
  steps: ReleaseActivityStep[];
  startedAt: number;
  finishedAt?: number | null;
  ok?: boolean | null;
}

export interface GithubReleaseNotesOutput {
  ok: boolean;
  found: boolean;
  message: string;
  tag: string;
  body: string;
  htmlUrl?: string | null;
  draft: boolean;
}

export interface LatestGithubReleaseOutput {
  found: boolean;
  message: string;
  tag: string;
  version: string;
  name?: string | null;
  htmlUrl?: string | null;
}

export interface RepoReleaseEvent {
  kind: string;
  title: string;
  detail: string;
  status: string;
  tag?: string | null;
  environment?: string | null;
  url?: string | null;
  at?: string | null;
  runId?: number | null;
}

export interface PollRepoReleaseRunOutput {
  status: string;
  message: string;
  url?: string | null;
  title?: string | null;
  detail?: string | null;
  jobs?: ReleaseDeployJob[];
}

export interface RepoReleaseApp {
  id: string;
  name: string;
  path: string;
  workflowFile?: string | null;
  workflowUrl?: string | null;
  createsTags: boolean;
  latest?: RepoReleaseEvent | null;
  events: RepoReleaseEvent[];
}

export interface RepoReleaseAppsOutput {
  apps: RepoReleaseApp[];
  repoUrl?: string | null;
  tagsUrl?: string | null;
  message: string;
}

export interface CreatePullRequestOutput {
  ok: boolean;
  message: string;
  url?: string | null;
  number?: number | null;
}

export type PrCreateMethod = 'cli' | 'browser';

export interface SavedPrTemplate {
  id: string;
  name: string;
  title: string;
  body: string;
}

export interface RepoPrTemplate {
  id: string;
  name: string;
  relativePath: string;
  body: string;
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
