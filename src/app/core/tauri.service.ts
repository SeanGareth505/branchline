import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type {
  AppSettings,
  BlameLine,
  BranchInfo,
  BranchLockInfo,
  CherryPickPreview,
  CommitInfo,
  DiffOutput,
  DetectedEditors,
  DiagnosticsSummary,
  FileHistoryEntry,
  GitDetectOutput,
  GitEnvSnapshot,
  GitIdentity,
  IdentityContexts,
  IgnoreFileOutput,
  IgnoreKind,
  MockJiraIssue,
  MockPullRequest,
  HostRepository,
  JiraIssue,
  JiraTransition,
  MutationOutput,
  OnboardingStatusOutput,
  PublishToGithubOutput,
  GithubDeviceStartOutput,
  GithubDevicePollOutput,
  RecentRepo,
  RebasePreview,
  RebaseStep,
  ReflogEntry,
  RemoteInfo,
  RepoStatus,
  RepoSummary,
  ResetMode,
  RunGitOutput,
  SafetyAction,
  SafetyAnalysis,
  SshSetupOutput,
  StashEntry,
  TagInfo,
  TemplateInfo,
  UndoEntry,
  WorkflowInfo,
  WorktreeInfo,
  FileStatusEntry,
  SubmoduleInfo,
  LfsFileInfo,
  ConflictSidesOutput,
  CreatePullRequestOutput,
  ReleaseStatusOutput,
  ReleasePreviewOutput,
  ReleaseRunOptions,
} from './models';

@Injectable({ providedIn: 'root' })
export class TauriService {
  readonly isDummyBackend =
    typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window);
  private readonly mockPreviewFlags = readMockPreviewFlags();
  private readonly mockLocks = new Map<string, { reason: string | null; lockedAt: string }>();
  private mockCustomWorkflows: WorkflowInfo[] = [];
  private mockDisabledBuiltinWorkflows = new Set<string>();

  private mockBuiltinWorkflows(): WorkflowInfo[] {
    return [
      {
        id: 'wf-feature',
        name: 'Create feature branch',
        description: 'Create feature/{jira}/{date}, then open commit',
        steps: [
          {
            id: 'createBranch',
            config: { namePattern: 'feature/{jira}/{date}', checkout: true },
          },
          'openCommit',
        ],
        builtin: true,
        enabled: true,
      },
      {
        id: 'wf-switch',
        name: 'Switch branch',
        description: 'Choose a local branch and check it out',
        steps: ['checkoutBranch'],
        builtin: true,
        enabled: true,
      },
      {
        id: 'wf-switch-sync',
        name: 'Switch and sync',
        description: 'Check out a branch, then fetch and pull',
        steps: ['checkoutBranch', 'fetch', 'pull'],
        builtin: true,
        enabled: true,
      },
      {
        id: 'wf-sync',
        name: 'Sync with remote',
        description: 'Fetch, pull, then push your current branch',
        steps: ['fetch', 'pull', 'push'],
        builtin: true,
        enabled: true,
      },
      {
        id: 'wf-hotfix',
        name: 'Hotfix release',
        description: 'Create hotfix/{date}, commit, and push',
        steps: [
          {
            id: 'createBranch',
            config: { namePattern: 'hotfix/{date}', checkout: true },
          },
          'openCommit',
          'push',
        ],
        builtin: true,
        enabled: true,
      },
      {
        id: 'wf-stash-pull',
        name: 'Stash and pull',
        description: 'Park local changes, pull, then refresh',
        steps: ['stash', 'pull', 'refresh'],
        builtin: true,
        enabled: true,
      },
    ];
  }

  private mockMergedWorkflows(): WorkflowInfo[] {
    const builtins = this.mockBuiltinWorkflows().map((w) => ({
      ...w,
      enabled: !this.mockDisabledBuiltinWorkflows.has(w.id),
    }));
    return [...builtins, ...this.mockCustomWorkflows.map((w) => ({ ...w }))];
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (this.isDummyBackend) {
      return this.mockInvoke<T>(cmd, args);
    }
    return invoke<T>(cmd, args);
  }

  async openExternalUrl(url: string): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      throw new Error('No URL to open.');
    }
    if (this.isDummyBackend) {
      const opened = window.open(trimmed, '_blank', 'noopener');
      if (!opened) {
        throw new Error('Could not open the browser. Check your popup blocker.');
      }
      return;
    }
    await openUrl(trimmed);
  }

  detectGit() {
    return this.invoke<GitDetectOutput>('detect_git');
  }

  detectEditors() {
    return this.invoke<DetectedEditors>('detect_editors');
  }

  openPathWithCommand(command: string, path: string) {
    return this.invoke<MutationOutput>('open_path_with_command', {
      input: { command, path },
    });
  }

  getGitIdentity(path?: string | null) {
    return this.invoke<GitIdentity>('get_git_identity', {
      input: { path: path ?? null },
    });
  }

  setGitIdentity(name: string, email: string, scope: 'global' | 'local' = 'global', path?: string) {
    return this.invoke<GitIdentity>('set_git_identity', {
      input: { name, email, scope, path: path ?? null },
    });
  }

  listIdentityContexts(path?: string | null) {
    return this.invoke<IdentityContexts>('list_identity_contexts', {
      input: { path: path ?? null },
    });
  }

  getOnboardingStatus() {
    return this.invoke<OnboardingStatusOutput>('get_onboarding_status');
  }

  completeOnboarding() {
    return this.invoke<OnboardingStatusOutput>('complete_onboarding');
  }

  skipOnboarding() {
    return this.invoke<OnboardingStatusOutput>('skip_onboarding');
  }

  getSshSetup() {
    return this.invoke<SshSetupOutput>('get_ssh_setup');
  }

  generateSshKey(comment = '') {
    return this.invoke<SshSetupOutput>('generate_ssh_key', {
      input: { comment },
    });
  }

  listRecentRepos() {
    return this.invoke<RecentRepo[]>('list_recent_repos');
  }

  openRepository(path: string) {
    return this.invoke<RepoSummary>('open_repository', { input: { path } });
  }

  cloneRepository(url: string, destination: string) {
    return this.invoke<RepoSummary>('clone_repository', { input: { url, destination } });
  }

  initRepository(path: string) {
    return this.invoke<RepoSummary>('init_repository', { input: { path } });
  }

  removeRecentRepo(path: string) {
    return this.invoke<RecentRepo[]>('remove_recent_repo', { input: { path } });
  }

  pinRepo(path: string, pinned: boolean) {
    return this.invoke<RecentRepo[]>('pin_repo', { input: { path, pinned } });
  }

  getRepoStatus(path: string) {
    return this.invoke<RepoStatus>('get_repo_status', { input: { path } });
  }

  getCommitLog(path: string, limit = 200) {
    return this.invoke<CommitInfo[]>('get_commit_log', { input: { path, limit } });
  }

  getDiff(
    path: string,
    opts: {
      pathspec?: string;
      staged?: boolean;
      commit?: string;
      compareFrom?: string;
      compareTo?: string;
    } = {},
  ) {
    return this.invoke<DiffOutput>('get_diff', {
      input: { path, ...opts },
    });
  }

  stagePaths(path: string, paths: string[]) {
    return this.invoke<MutationOutput>('stage_paths', { input: { path, paths } });
  }

  unstagePaths(path: string, paths: string[]) {
    return this.invoke<MutationOutput>('unstage_paths', { input: { path, paths } });
  }

  discardPaths(path: string, paths: string[]) {
    return this.invoke<MutationOutput>('discard_paths', { input: { path, paths } });
  }

  applyPatch(
    path: string,
    patch: string,
    mode: 'stage' | 'unstage' | 'discard' | 'apply' | 'apply-index',
  ) {
    return this.invoke<MutationOutput>('apply_patch', { input: { path, patch, mode } });
  }

  checkoutPathsFromRevision(
    path: string,
    revision: string,
    paths: string[],
    target: 'worktree' | 'index' | 'both' = 'both',
  ) {
    return this.invoke<MutationOutput>('checkout_paths_from_revision', {
      input: { path, revision, paths, target },
    });
  }

  createCommit(path: string, message: string, amend = false, allowEmpty = false) {
    return this.invoke<{ sha: string; shortSha?: string; message: string }>('create_commit', {
      input: { path, message, amend, allowEmpty },
    });
  }

  listStashes(path: string) {
    return this.invoke<StashEntry[]>('list_stashes', { input: { path } });
  }

  stashPush(path: string, message?: string, includeUntracked = false, paths?: string[]) {
    return this.invoke<MutationOutput>('stash_push', {
      input: {
        path,
        message: message ?? null,
        includeUntracked,
        paths: paths?.length ? paths : null,
      },
    });
  }

  stashPop(path: string, index: number) {
    return this.invoke<MutationOutput>('stash_pop', { input: { path, index } });
  }

  stashApply(path: string, index: number) {
    return this.invoke<MutationOutput>('stash_apply', { input: { path, index } });
  }

  stashDrop(path: string, index: number) {
    return this.invoke<MutationOutput>('stash_drop', { input: { path, index } });
  }

  mergeBranch(path: string, branch: string, noFf = false) {
    return this.invoke<MutationOutput>('merge_branch', { input: { path, branch, noFf } });
  }

  rebaseOnto(path: string, onto: string) {
    return this.invoke<MutationOutput>('rebase_onto', { input: { path, onto } });
  }

  previewInteractiveRebase(path: string, onto: string) {
    return this.invoke<RebasePreview>('preview_interactive_rebase', { input: { path, onto } });
  }

  startInteractiveRebase(
    path: string,
    onto: string,
    steps: Array<Pick<RebaseStep, 'sha' | 'action' | 'message'>>,
  ) {
    return this.invoke<MutationOutput>('start_interactive_rebase', {
      input: {
        path,
        onto,
        steps: steps.map((s) => ({
          sha: s.sha,
          action: s.action,
          message: s.message ?? null,
        })),
      },
    });
  }

  listWorktrees(path: string) {
    return this.invoke<WorktreeInfo[]>('list_worktrees', { input: { path } });
  }

  getConflictSides(path: string, filePath: string) {
    return this.invoke<ConflictSidesOutput>('get_conflict_sides', {
      input: { path, filePath },
    }).catch(async (err: unknown) => {
      if (!isMissingTauriCommand(err, 'get_conflict_sides')) throw err;
      return this.getConflictSidesFallback(path, filePath);
    });
  }

  private async getConflictSidesFallback(
    path: string,
    filePath: string,
  ): Promise<ConflictSidesOutput> {
    const stage = async (n: 1 | 2 | 3): Promise<string> => {
      const result = await this.runGitCommand(path, ['show', `:${n}:${filePath}`]);
      return result.ok ? result.stdout : '';
    };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    let working = '';
    try {
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const sep = path.includes('\\') ? '\\' : '/';
      working = await readTextFile(`${path.replace(/[/\\]$/, '')}${sep}${filePath}`);
    } catch {
      working = ours || theirs || base;
    }
    const binary =
      looksBinaryText(base) ||
      looksBinaryText(ours) ||
      looksBinaryText(theirs) ||
      looksBinaryText(working);
    const hasMarkers =
      !binary &&
      (/^<<<<<<< /m.test(working) || /^>>>>>>> /m.test(working) || /^=======\s*$/m.test(working));
    return {
      path: filePath,
      base: binary ? '' : base,
      ours: binary ? '' : ours,
      theirs: binary ? '' : theirs,
      working: binary ? '' : working,
      hasBase: base.length > 0,
      hasOurs: ours.length > 0,
      hasTheirs: theirs.length > 0,
      binary,
      unmerged: true,
      hasMarkers,
    };
  }

  resolveConflictFile(path: string, filePath: string, content: string) {
    return this.invoke<MutationOutput>('resolve_conflict_file', {
      input: { path, filePath, content },
    });
  }

  openConflictInIde(
    path: string,
    filePath: string,
    opts: {
      editor?: 'auto' | 'cursor' | 'vscode';
      mode?: 'file' | 'merge';
      cursorPath?: string | null;
      vscodePath?: string | null;
      wait?: boolean;
      stageIfResolved?: boolean;
    } = {},
  ) {
    return this.invoke<MutationOutput>('open_conflict_in_ide', {
      input: {
        path,
        filePath,
        editor: opts.editor ?? 'auto',
        mode: opts.mode ?? 'file',
        cursorPath: opts.cursorPath ?? null,
        vscodePath: opts.vscodePath ?? null,
        wait: opts.wait ?? false,
        stageIfResolved: opts.stageIfResolved ?? false,
      },
    });
  }

  listSubmodules(path: string) {
    return this.invoke<SubmoduleInfo[]>('list_submodules', { input: { path } });
  }

  updateSubmodules(path: string) {
    return this.invoke<MutationOutput>('update_submodules', { input: { path } });
  }

  syncSubmodules(path: string) {
    return this.invoke<MutationOutput>('sync_submodules', { input: { path } });
  }

  updateSubmodule(path: string, submodulePath: string) {
    return this.invoke<MutationOutput>('update_submodule', {
      input: { path, submodulePath },
    });
  }

  listLfsFiles(path: string) {
    return this.invoke<LfsFileInfo[]>('list_lfs_files', { input: { path } });
  }

  lfsPull(path: string) {
    return this.invoke<MutationOutput>('lfs_pull', { input: { path } });
  }

  listPullRequests(path: string, state: 'open' | 'closed' | 'all' = 'open') {
    return this.invoke<MockPullRequest[]>('list_pull_requests', {
      input: { path, state },
    });
  }

  createPullRequest(input: {
    path: string;
    title: string;
    body?: string;
    head: string;
    base: string;
    draft?: boolean;
  }) {
    return this.invoke<CreatePullRequestOutput>('create_pull_request', { input });
  }

  addWorktree(
    path: string,
    worktreePath: string,
    opts: { branch?: string; createBranch?: boolean; startPoint?: string } = {},
  ) {
    return this.invoke<MutationOutput>('add_worktree', {
      input: {
        path,
        worktreePath,
        branch: opts.branch ?? null,
        createBranch: opts.createBranch ?? false,
        startPoint: opts.startPoint ?? null,
      },
    });
  }

  removeWorktree(path: string, worktreePath: string, force = false) {
    return this.invoke<MutationOutput>('remove_worktree', {
      input: { path, worktreePath, force },
    });
  }

  pruneWorktrees(path: string) {
    return this.invoke<MutationOutput>('prune_worktrees', { input: { path } });
  }

  getIgnoreFile(path: string, kind: IgnoreKind = 'gitignore') {
    return this.invoke<IgnoreFileOutput>('get_ignore_file', { input: { path, kind } });
  }

  saveIgnoreFile(path: string, kind: IgnoreKind, content: string) {
    return this.invoke<MutationOutput>('save_ignore_file', { input: { path, kind, content } });
  }

  abortOperation(path: string) {
    return this.invoke<MutationOutput>('abort_operation', { input: { path } });
  }

  continueOperation(path: string) {
    return this.invoke<MutationOutput>('continue_operation', { input: { path } });
  }

  resetTo(path: string, target: string, mode: ResetMode) {
    return this.invoke<MutationOutput>('reset_to', { input: { path, target, mode } });
  }

  listTags(path: string) {
    return this.invoke<TagInfo[]>('list_tags', { input: { path } });
  }

  createTag(path: string, name: string, target?: string, message?: string) {
    return this.invoke<MutationOutput>('create_tag', {
      input: { path, name, target: target ?? null, message: message ?? null },
    });
  }

  deleteTag(path: string, name: string) {
    return this.invoke<MutationOutput>('delete_tag', { input: { path, name } });
  }

  getReleaseStatus(path: string) {
    return this.invoke<ReleaseStatusOutput>('get_release_status', { input: { path } });
  }

  previewRelease(path: string, opts: ReleaseRunOptions) {
    return this.invoke<ReleasePreviewOutput>('preview_release', {
      input: {
        path,
        bump: opts.bump,
        preid: opts.preid ?? null,
        push: opts.push ?? null,
        message: opts.message ?? null,
        tagMessage: opts.tagMessage ?? null,
        allowDirty: opts.allowDirty ?? null,
        branch: opts.branch ?? null,
      },
    });
  }

  runRelease(path: string, opts: ReleaseRunOptions) {
    return this.invoke<MutationOutput>('run_release', {
      input: {
        path,
        bump: opts.bump,
        preid: opts.preid ?? null,
        push: opts.push ?? null,
        message: opts.message ?? null,
        tagMessage: opts.tagMessage ?? null,
        allowDirty: opts.allowDirty ?? null,
        branch: opts.branch ?? null,
      },
    });
  }

  listBranches(path: string) {
    return this.invoke<BranchInfo[]>('list_branches', { input: { path } });
  }

  createBranch(path: string, name: string, checkout = true, startPoint?: string) {
    return this.invoke<MutationOutput>('create_branch', {
      input: { path, name, checkout, startPoint: startPoint ?? null },
    });
  }

  checkoutBranch(
    path: string,
    name: string,
    localChanges: 'keep' | 'merge' | 'force' = 'keep',
  ) {
    return this.invoke<MutationOutput>('checkout_branch', {
      input: { path, name, localChanges },
    });
  }

  deleteBranch(path: string, name: string, force = false) {
    return this.invoke<MutationOutput>('delete_branch', { input: { path, name, force } });
  }

  renameBranch(path: string, from: string, to: string) {
    return this.invoke<MutationOutput>('rename_branch', {
      input: { path, from, to },
    });
  }

  listBranchLocks(path: string) {
    return this.invoke<BranchLockInfo[]>('list_branch_locks', { input: { path } });
  }

  lockBranch(path: string, name: string, reason?: string) {
    return this.invoke<MutationOutput>('lock_branch', {
      input: { path, name, reason: reason ?? null },
    });
  }

  unlockBranch(path: string, name: string) {
    return this.invoke<MutationOutput>('unlock_branch', { input: { path, name } });
  }

  fetch(path: string) {
    return this.invoke<MutationOutput>('fetch', { input: { path } });
  }

  pull(path: string, remote?: string) {
    return this.invoke<MutationOutput>('pull', {
      input: { path, remote: remote ?? null },
    });
  }

  pullWithOptions(path: string, opts: { remote?: string; rebase?: boolean } = {}) {
    return this.invoke<MutationOutput>('pull_with_options', {
      input: { path, remote: opts.remote ?? null, rebase: opts.rebase ?? false },
    });
  }

  push(
    path: string,
    opts:
      | boolean
      | {
          forceWithLease?: boolean;
          setUpstream?: boolean;
          remote?: string;
          branch?: string;
        } = false,
  ) {
    const options =
      typeof opts === 'boolean'
        ? { forceWithLease: opts }
        : opts;
    return this.invoke<MutationOutput>('push', {
      input: {
        path,
        forceWithLease: options.forceWithLease ?? false,
        setUpstream: options.setUpstream ?? null,
        remote: options.remote ?? null,
        branch: options.branch ?? null,
      },
    });
  }

  listRemotes(path: string) {
    return this.invoke<RemoteInfo[]>('list_remotes', { input: { path } });
  }

  addRemote(path: string, name: string, url: string) {
    return this.invoke<MutationOutput>('add_remote', { input: { path, name, url } });
  }

  removeRemote(path: string, name: string) {
    return this.invoke<MutationOutput>('remove_remote', { input: { path, name } });
  }

  listReflog(path: string, limit = 80) {
    return this.invoke<ReflogEntry[]>('list_reflog', { input: { path, limit } });
  }

  squashCommits(path: string, count: number, message: string) {
    return this.invoke<MutationOutput>('squash_commits', { input: { path, count, message } });
  }

  runGitCommand(
    path: string,
    args: string[],
    opts?: { console?: boolean; externalTool?: boolean },
  ) {
    return this.invoke<RunGitOutput>('run_git_command', {
      input: {
        path,
        args,
        console: opts?.console ?? false,
        externalTool: opts?.externalTool ?? false,
      },
    });
  }

  cherryPickPreview(path: string, shas: string[]) {
    return this.invoke<CherryPickPreview>('cherry_pick_preview', { input: { path, shas } });
  }

  cherryPick(path: string, shas: string[]) {
    return this.invoke<MutationOutput & { completedShas?: string[] }>('cherry_pick', {
      input: { path, shas },
    });
  }

  revertCommit(path: string, sha: string) {
    return this.invoke<MutationOutput>('revert_commit', {
      input: { path, sha },
    });
  }

  analyzeSafety(path: string, action: SafetyAction, target?: string) {
    return this.invoke<SafetyAnalysis>('analyze_safety', {
      input: { path, action, target: target ?? null },
    });
  }

  executeSafeAction(
    path: string,
    action: SafetyAction,
    target: string | null,
    useRecommended: boolean,
    options?: {
      confirmationPhrase?: string;
      allowBareForce?: boolean;
      acknowledged?: boolean;
    },
  ) {
    return this.invoke<{ ok: boolean; message: string; undoable: boolean; analysis: SafetyAnalysis }>(
      'execute_safe_action',
      {
        input: {
          path,
          action,
          target,
          useRecommended,
          confirmationPhrase: options?.confirmationPhrase ?? null,
          allowBareForce: options?.allowBareForce ?? false,
          acknowledged: options?.acknowledged ?? false,
        },
      },
    );
  }

  getCommitRange(path: string, from?: string | null, to?: string | null, limit = 500) {
    return this.invoke<CommitInfo[]>('get_commit_range', {
      input: { path, from: from ?? null, to: to ?? null, limit },
    });
  }

  undoLast(path: string) {
    return this.invoke<UndoEntry | null>('undo_last', { input: { path } });
  }

  listUndoJournal(path: string) {
    return this.invoke<UndoEntry[]>('list_undo_journal', { input: { path } });
  }

  getSettings() {
    return this.invoke<AppSettings>('get_settings');
  }

  saveSettings(settings: AppSettings) {
    return this.invoke<AppSettings>('save_settings', { input: settings });
  }

  getDiagnosticsSummary() {
    return this.invoke<DiagnosticsSummary>('get_diagnostics_summary');
  }

  recordClientError(source: string, message: string, detail?: string) {
    return this.invoke<void>('record_client_error', {
      input: { source, message, detail: detail ?? null },
    });
  }

  getDiagnosticsText() {
    return this.invoke<string>('get_diagnostics_text');
  }

  clearDiagnostics() {
    return this.invoke<void>('clear_diagnostics');
  }

  openDiagnosticsFolder() {
    return this.invoke<void>('open_diagnostics_folder');
  }

  getGitEnv() {
    return this.invoke<GitEnvSnapshot>('get_git_env');
  }

  setGitConfig(key: string, value: string) {
    return this.invoke<GitEnvSnapshot>('set_git_config', { input: { key, value } });
  }

  getFileBlame(path: string, file: string, commit?: string | null) {
    return this.invoke<BlameLine[]>('get_file_blame', {
      input: { path, file, commit: commit?.trim() || undefined },
    });
  }

  getFileHistory(path: string, file: string) {
    return this.invoke<FileHistoryEntry[]>('get_file_history', { input: { path, file } });
  }

  listMockPullRequests() {
    return this.invoke<MockPullRequest[]>('list_mock_pull_requests');
  }

  listHostRepositories(connectionId?: string) {
    return this.invoke<HostRepository[]>('list_host_repositories', {
      input: connectionId ? { connectionId } : {},
    });
  }

  publishToGithub(input: {
    path: string;
    name: string;
    description?: string;
    private?: boolean;
    remoteName?: string;
    createReleaseTag?: boolean;
    tagName?: string;
  }) {
    return this.invoke<PublishToGithubOutput>('publish_to_github', { input });
  }

  githubDeviceLoginStart(clientId: string, scope?: string) {
    return this.invoke<GithubDeviceStartOutput>('github_device_login_start', {
      input: { clientId, scope },
    });
  }

  githubDeviceLoginPoll(clientId: string, deviceCode: string) {
    return this.invoke<GithubDevicePollOutput>('github_device_login_poll', {
      input: { clientId, deviceCode },
    });
  }

  listMockJiraIssues() {
    return this.invoke<JiraIssue[]>('list_mock_jira_issues');
  }

  listJiraIssues(jql?: string, maxResults?: number) {
    return this.invoke<JiraIssue[]>('list_jira_issues', {
      input: {
        jql: jql?.trim() || undefined,
        maxResults: maxResults ?? 50,
      },
    });
  }

  listJiraTransitions(issueKey: string) {
    return this.invoke<JiraTransition[]>('list_jira_transitions', {
      input: { issueKey },
    });
  }

  transitionJiraIssue(issueKey: string, transitionId: string) {
    return this.invoke<void>('transition_jira_issue', {
      input: { issueKey, transitionId },
    });
  }

  listWorkflows() {
    return this.invoke<WorkflowInfo[]>('list_workflows');
  }

  saveWorkflow(input: {
    id?: string;
    name: string;
    description: string;
    steps: WorkflowInfo['steps'];
    enabled?: boolean;
  }) {
    return this.invoke<WorkflowInfo>('save_workflow', { input });
  }

  deleteWorkflow(id: string) {
    return this.invoke<WorkflowInfo[]>('delete_workflow', { input: { id } });
  }

  setWorkflowEnabled(id: string, enabled: boolean) {
    return this.invoke<WorkflowInfo[]>('set_workflow_enabled', { input: { id, enabled } });
  }

  listTemplates() {
    return this.invoke<TemplateInfo[]>('list_templates');
  }

  private async mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const mutation = { ok: true, message: 'Done' };
    const lockKey = (path: string, name: string) => `${path}::${name}`;

    if (cmd === 'get_settings') {
      return this.mockSettings() as T;
    }

    if (cmd === 'save_settings') {
      const input = (args?.['input'] as AppSettings | undefined) ?? this.mockSettings();
      this.persistMockSettings(input);
      return { ...input } as T;
    }

    if (cmd === 'publish_to_github') {
      const input = (args?.['input'] as {
        name?: string;
        createReleaseTag?: boolean;
        tagName?: string;
      }) ?? {};
      const name = (input.name || 'branchline').trim() || 'branchline';
      const tag = input.createReleaseTag
        ? input.tagName?.startsWith('v')
          ? input.tagName
          : `v${input.tagName || '0.1.0'}`
        : null;
      return {
        ok: true,
        message: `Published demo/${name} to GitHub (mock)`,
        fullName: `demo/${name}`,
        htmlUrl: `https://github.com/demo/${name}`,
        cloneUrl: `https://github.com/demo/${name}.git`,
        releaseUrl: tag ? `https://github.com/demo/${name}/releases/tag/${tag}` : null,
        tagName: tag,
      } as T;
    }

    if (cmd === 'github_device_login_start') {
      return {
        deviceCode: 'mock-device-code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        verificationUriComplete: 'https://github.com/login/device?user_code=ABCD-1234',
        expiresIn: 900,
        interval: 5,
      } as T;
    }

    if (cmd === 'github_device_login_poll') {
      return {
        status: 'complete',
        accessToken: 'ghp_mock_token_for_browser_preview',
        tokenType: 'bearer',
        scope: 'repo workflow read:user',
        errorDescription: null,
        interval: null,
      } as T;
    }

    if (cmd === 'list_branch_locks') {
      const path = (args?.['input'] as { path?: string })?.path ?? '';
      const locks: BranchLockInfo[] = [];
      for (const [key, value] of this.mockLocks) {
        if (!key.startsWith(`${path}::`)) continue;
        locks.push({
          branchName: key.slice(path.length + 2),
          reason: value.reason,
          lockedAt: value.lockedAt,
        });
      }
      return locks as T;
    }

    if (cmd === 'lock_branch') {
      const input = args?.['input'] as { path?: string; name?: string; reason?: string | null };
      const path = input?.path ?? '';
      const name = input?.name?.trim() ?? '';
      this.mockLocks.set(lockKey(path, name), {
        reason: input?.reason?.trim() || null,
        lockedAt: new Date().toISOString(),
      });
      return { ok: true, message: `Locked branch ${name}` } as T;
    }

    if (cmd === 'unlock_branch') {
      const input = args?.['input'] as { path?: string; name?: string };
      const path = input?.path ?? '';
      const name = input?.name?.trim() ?? '';
      this.mockLocks.delete(lockKey(path, name));
      return { ok: true, message: `Unlocked branch ${name}` } as T;
    }

    if (cmd === 'list_branches') {
      const path = (args?.['input'] as { path?: string })?.path ?? '/Users/demo/projects/navigo';
      const branches = this.mockBranches().map((b) => {
        const lock = this.mockLocks.get(lockKey(path, b.name));
        return {
          ...b,
          locked: !!lock,
          lockReason: lock?.reason ?? null,
        };
      });
      return branches as T;
    }

    if (cmd === 'push') {
      const path = (args?.['input'] as { path?: string })?.path ?? '';
      const lock = this.mockLocks.get(lockKey(path, 'main'));
      if (lock) {
        throw new Error(
          lock.reason
            ? `Branch 'main' is locked: ${lock.reason}`
            : "Branch 'main' is locked. Unlock it before pushing, force-pushing, renaming, or deleting.",
        );
      }
      return { ok: true, message: 'Pushed' } as T;
    }

    if (cmd === 'rename_branch' || cmd === 'delete_branch') {
      const input = args?.['input'] as { path?: string; name?: string; from?: string };
      const path = input?.path ?? '';
      const name = (input?.name ?? input?.from ?? '').trim();
      const lock = this.mockLocks.get(lockKey(path, name));
      if (lock) {
        throw new Error(
          lock.reason
            ? `Branch '${name}' is locked: ${lock.reason}`
            : `Branch '${name}' is locked. Unlock it before pushing, force-pushing, renaming, or deleting.`,
        );
      }
    }

    const mocks: Record<string, unknown> = {
      detect_git: {
        installed: true,
        path: '/usr/bin/git',
        version: '2.49.0',
        message: 'Git 2.49.0 detected (browser preview)',
      },
      open_path_with_command: mutation,
      detect_editors: {
        cursor: true,
        vscode: true,
        cursorPath: '/usr/local/bin/cursor',
        vscodePath: '/usr/local/bin/code',
      },
      get_git_identity: { name: 'Sean', email: 'sean@example.com' },
      set_git_identity: args?.['input'] ?? { name: '', email: '' },
      get_onboarding_status: this.mockOnboardingStatus(),
      complete_onboarding: { completed: true, skipped: false, items: [] },
      skip_onboarding: { completed: false, skipped: true, items: [] },
      list_recent_repos: [
        {
          path: '/Users/demo/projects/navigo',
          name: '[DUMMY] navigo',
          lastOpenedAt: new Date().toISOString(),
          pinned: true,
          isLast: true,
        },
        {
          path: '/Users/demo/projects/lumora',
          name: '[DUMMY] lumora',
          lastOpenedAt: new Date(Date.now() - 86400000).toISOString(),
          pinned: false,
          isLast: false,
        },
      ],
      open_repository: {
        path: (args?.['input'] as { path?: string })?.path ?? '/Users/demo/projects/navigo',
        name: `[DUMMY] ${(((args?.['input'] as { path?: string })?.path ?? '/navigo').replace(/\\/g, '/').split('/').filter(Boolean).pop()) || 'repo'}`,
        branch: 'main',
        ahead: 0,
        behind: 1,
        hasChanges: true,
      },
      clone_repository: {
        path: (args?.['input'] as { destination?: string })?.destination ?? '/Users/demo/projects/cloned',
        name: '[DUMMY] cloned',
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasChanges: false,
      },
      init_repository: {
        path: (args?.['input'] as { path?: string })?.path ?? '/Users/demo/projects/new-repo',
        name: '[DUMMY] new-repo',
        branch: 'main',
        ahead: 0,
        behind: 0,
        hasChanges: false,
      },
      list_stashes: [
        {
          index: 0,
          id: 'stash@{0}',
          message: 'WIP on main: polish dashboard',
          branch: 'main',
        },
      ],
      stash_push: { ok: true, message: 'Saved working directory and index state' },
      stash_pop: { ok: true, message: 'Dropped stash@{0}' },
      stash_apply: { ok: true, message: 'Applied stash@{0}' },
      stash_drop: { ok: true, message: 'Dropped stash@{0}' },
      merge_branch: { ok: true, message: 'Merge made by the recursive strategy' },
      rebase_onto: { ok: true, message: 'Successfully rebased' },
      preview_interactive_rebase: {
        onto: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        ontoShort: 'b2c3d4e',
        commits: [
          {
            sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
            shortSha: 'a1b2c3d',
            subject: 'Polish dashboard',
            author: 'Sean',
          },
          {
            sha: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
            shortSha: 'c3d4e5f',
            subject: 'Fix status bar',
            author: 'Sean',
          },
        ],
      },
      start_interactive_rebase: { ok: true, message: 'Interactive rebase complete' },
      list_worktrees: [
        {
          path: '/Users/demo/projects/navigo',
          head: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          shortHead: 'a1b2c3d',
          branch: 'main',
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          isMain: true,
        },
        {
          path: '/Users/demo/projects/navigo-feature',
          head: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
          shortHead: 'c3d4e5f',
          branch: 'feature/login',
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          isMain: false,
        },
      ],
      add_worktree: { ok: true, message: 'Added worktree' },
      remove_worktree: { ok: true, message: 'Removed worktree' },
      prune_worktrees: { ok: true, message: 'Pruned stale worktrees' },
      get_ignore_file: {
        kind: 'gitignore',
        filePath: '/Users/demo/projects/navigo/.gitignore',
        content: 'node_modules/\ndist/\n.DS_Store\n',
        exists: true,
      },
      save_ignore_file: { ok: true, message: 'Saved gitignore' },
      abort_operation: { ok: true, message: 'Operation aborted' },
      continue_operation: { ok: true, message: 'Continued' },
      reset_to: { ok: true, message: 'Reset complete' },
      list_tags: [
        {
          name: 'v0.1.0',
          sha: '0102030405060708090a0b0c0d0e0f1011121314',
          shortSha: '0102030',
          message: 'Initial release',
        },
      ],
      create_tag: { ok: true, message: 'Created tag' },
      delete_tag: { ok: true, message: 'Deleted tag' },
      get_release_status: {
        available: true,
        message: 'Demo App release ready (currently 0.1.0)',
        config: {
          productName: 'Demo App',
          tagPrefix: 'v',
          branch: 'main',
          requireClean: true,
          pushDefault: false,
          commitMessage: 'Release {{version}}',
          tagMessage: '{{productName}} {{version}}',
          files: ['package.json'],
          configPath: '/demo/release.config.json',
        },
        currentVersion: '0.1.0',
        currentBranch: 'main',
        dirty: false,
      },
      preview_release: {
        ok: true,
        message: 'Ready to release Demo App 0.1.0 → 0.1.1',
        productName: 'Demo App',
        currentVersion: '0.1.0',
        nextVersion: '0.1.1',
        tag: 'v0.1.1',
        branch: 'main',
        currentBranch: 'main',
        requireClean: true,
        dirty: false,
        willPush: false,
        commitMessage: 'Release 0.1.1',
        tagMessage: 'Demo App 0.1.1',
        files: ['package.json'],
        devSkippedFiles: [],
        blockers: [],
      },
      run_release: { ok: true, message: 'Released Demo App 0.1.1 (v0.1.1) — push when ready' },
      list_remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://github.com/example/navigo.git',
          pushUrl: 'https://github.com/example/navigo.git',
        },
      ],
      add_remote: { ok: true, message: 'Added remote' },
      remove_remote: { ok: true, message: 'Removed remote' },
      pull_with_options: { ok: true, message: 'Pulled with rebase' },
      list_reflog: [
        {
          index: 0,
          sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
          shortSha: 'a1b2c3d',
          selector: 'HEAD@{0}',
          action: 'commit',
          subject: 'Polish dashboard',
          timestamp: Math.floor(Date.now() / 1000),
        },
        {
          index: 1,
          sha: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
          shortSha: 'b2c3d4e',
          selector: 'HEAD@{1}',
          action: 'checkout',
          subject: 'moving from feature/onboarding to main',
          timestamp: Math.floor(Date.now() / 1000) - 3600,
        },
      ],
      squash_commits: { ok: true, message: 'Squashed commits' },
      run_git_command: (() => {
        const input = args?.['input'] as { args?: string[] } | undefined;
        const gitArgs = input?.args ?? [];
        if (gitArgs[0] === 'rev-list' && gitArgs.includes('--left-right')) {
          return { ok: true, stdout: '0\t1\n', stderr: '' };
        }
        if (gitArgs[0] === 'pull') {
          return {
            ok: true,
            stdout: 'Updating a1b2c3d..b2c3d4e\nFast-forward\n',
            stderr: '',
          };
        }
        return {
          ok: true,
          stdout: '## main...origin/main [behind 1]\n M src/app.ts\n?? notes.md\n',
          stderr: '',
        };
      })(),
      get_repo_status: this.mockStatus(),
      get_commit_log: this.mockCommits(),
      get_commit_range: this.mockCommits(),
      get_artificial_commits: [
        {
          id: 'working',
          kind: 'working',
          label: 'Working directory',
          fileCount: 3,
          added: 1,
          modified: 2,
          deleted: 0,
        },
        {
          id: 'staged',
          kind: 'staged',
          label: 'Staged changes',
          fileCount: 1,
          added: 0,
          modified: 1,
          deleted: 0,
        },
      ],
      get_diff: this.mockDiff(args),
      stage_paths: mutation,
      unstage_paths: mutation,
      discard_paths: mutation,
      apply_patch: mutation,
      checkout_paths_from_revision: mutation,
      create_commit: { sha: 'abc1234deadbeef', shortSha: 'abc1234', message: 'commit' },
      create_branch: { ok: true, message: 'Created branch' },
      checkout_branch: { ok: true, message: 'Checked out' },
      delete_branch: { ok: true, message: 'Deleted branch' },
      rename_branch: { ok: true, message: 'Renamed branch' },
      fetch: { ok: true, message: 'Fetched' },
      pull: { ok: true, message: 'Already up to date' },
      cherry_pick_preview: {
        commits: [
          {
            sha: 'b2c3d4e5f6a1',
            shortSha: 'b2c3d4e',
            subject: 'Add onboarding wizard',
            author: 'Dev',
            alreadyApplied: false,
          },
        ],
        estimatedConflicts: false,
        message: 'Looks clean to cherry-pick',
      },
      cherry_pick: { ok: true, message: 'Cherry-picked', completedShas: [] },
      revert_commit: { ok: true, message: 'Reverted' },
      execute_safe_action: {
        ok: true,
        message: 'Done',
        undoable: false,
        analysis: this.mockSafetyAnalysis('forcePush', 'main'),
      },
      undo_last: {
        id: '1',
        repoPath: '/Users/demo/projects/navigo',
        action: 'commit',
        label: 'Undone last action',
        payload: null,
        createdAt: new Date().toISOString(),
        restored: true,
      },
      list_undo_journal: [],
      get_diagnostics_summary: {
        version: '0.1.6',
        os: 'browser',
        diagnosticsDir: '/Users/demo/Library/Application Support/branchline/diagnostics',
        logHint: 'Browser preview — diagnostics are mocked',
        lastCrash: null,
        recentErrors: [],
        lastUncleanShutdown: null,
      },
      record_client_error: null,
      get_diagnostics_text: 'Branchline diagnostics\nversion: 0.1.6\n(browser preview)\n',
      clear_diagnostics: null,
      open_diagnostics_folder: null,
      get_settings: {
        theme: 'light',
        accent: '#0EA5E9',
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
        branchPrefixes: ['feature', 'bugfix', 'hotfix', 'chore', 'release'],
        preferredEditor: 'auto',
        editorCommand: '',
        diffTool: '',
        mergeTool: '',
        sshClient: 'openssh',
        connections: [
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
        ],
        commitTypes: [
          { id: 'feat', label: 'feat', description: 'New feature' },
          { id: 'fix', label: 'fix', description: 'Bug fix' },
          { id: 'docs', label: 'docs', description: 'Documentation' },
          { id: 'refactor', label: 'refactor', description: 'Code change without behavior change' },
          { id: 'perf', label: 'perf', description: 'Performance improvement' },
          { id: 'test', label: 'test', description: 'Tests' },
          { id: 'build', label: 'build', description: 'Build system or dependencies' },
          { id: 'ci', label: 'ci', description: 'CI configuration' },
          { id: 'chore', label: 'chore', description: 'Maintenance' },
          { id: 'revert', label: 'revert', description: 'Revert a previous commit' },
        ],
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
      },
      save_settings: args?.['input'] ?? {},
      get_git_env: {
        credentialHelper: 'osxkeychain',
        coreEditor: 'code --wait',
        diffTool: '',
        mergeTool: '',
        sshKeysFound: true,
        sshKeyPaths: ['/Users/demo/.ssh/id_ed25519'],
      },
      get_ssh_setup: {
        keysFound: true,
        privateKeyPaths: ['/Users/demo/.ssh/id_ed25519'],
        publicKeyPath: '/Users/demo/.ssh/id_ed25519.pub',
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoBranchlinePreviewKey branchline@demo',
        preferredKeyName: 'id_ed25519',
        generated: false,
        message: 'SSH key ready (id_ed25519)',
      },
      generate_ssh_key: {
        keysFound: true,
        privateKeyPaths: ['/Users/demo/.ssh/id_ed25519'],
        publicKeyPath: '/Users/demo/.ssh/id_ed25519.pub',
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoBranchlinePreviewKey branchline@demo',
        preferredKeyName: 'id_ed25519',
        generated: true,
        message: 'Created ~/.ssh/id_ed25519 — copy the public key and add it on GitHub.',
      },
      set_git_config: {
        credentialHelper: 'osxkeychain',
        coreEditor: 'code --wait',
        diffTool: '',
        mergeTool: '',
        sshKeysFound: true,
        sshKeyPaths: ['/Users/demo/.ssh/id_ed25519'],
      },
      get_file_blame: [
        {
          lineNumber: 1,
          content: "export const title = 'Branchline';",
          sha: 'a1b2c3d',
          author: 'Sean',
          email: 'sean@example.com',
          timestamp: Math.floor(Date.now() / 1000),
          summary: 'Polish dashboard',
        },
        {
          lineNumber: 2,
          content: "export const accent = '#3ECFFF';",
          sha: 'b2c3d4e',
          author: 'Maya',
          email: 'maya@example.com',
          timestamp: Math.floor(Date.now() / 1000) - 3600,
          summary: 'Add OAuth providers',
        },
        {
          lineNumber: 3,
          content: 'export const focusMode = true;',
          sha: 'a1b2c3d',
          author: 'Sean',
          email: 'sean@example.com',
          timestamp: Math.floor(Date.now() / 1000),
          summary: 'Polish dashboard',
        },
        {
          lineNumber: 4,
          content: "export const theme = 'dark';",
          sha: 'c3d4e5f',
          author: 'Alex',
          email: 'alex@example.com',
          timestamp: Math.floor(Date.now() / 1000) - 7200,
          summary: 'Hotfix packaging',
        },
      ],
      get_file_history: [
        {
          sha: 'a1b2c3d4e5f6',
          shortSha: 'a1b2c3d',
          subject: 'Polish dashboard empty states',
          author: 'Sean',
          timestamp: Math.floor(Date.now() / 1000),
        },
      ],
      list_host_repositories: [
        {
          id: 'github:1',
          name: 'navigo',
          fullName: 'demo/navigo',
          cloneUrl: 'https://github.com/demo/navigo.git',
          sshUrl: 'git@github.com:demo/navigo.git',
          private: false,
          provider: 'github',
          updatedAt: new Date().toISOString(),
        },
        {
          id: 'github:2',
          name: 'lumora',
          fullName: 'demo/lumora',
          cloneUrl: 'https://github.com/demo/lumora.git',
          sshUrl: 'git@github.com:demo/lumora.git',
          private: true,
          provider: 'github',
          updatedAt: new Date(Date.now() - 86400000).toISOString(),
        },
        {
          id: 'github:3',
          name: 'branchline',
          fullName: 'sean/branchline',
          cloneUrl: 'https://github.com/sean/branchline.git',
          sshUrl: 'git@github.com:sean/branchline.git',
          private: false,
          provider: 'github',
          updatedAt: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
      list_mock_pull_requests: [
        {
          id: 'pr-101',
          number: 101,
          title: 'Improve commit graph focus mode',
          author: 'alex',
          assignees: ['alex'],
          reviewers: ['jamie', 'sam'],
          team: 'Platform',
          repo: 'branchline',
          sourceBranch: 'feature/graph-focus',
          targetBranch: 'main',
          status: 'open',
          url: 'https://github.com/example/branchline/pull/101',
          labels: ['ui', 'graph'],
          updatedAt: '2026-07-17T14:22:00Z',
          draft: false,
          reviewState: 'approved',
          pipelineStatus: 'success',
          additions: 420,
          deletions: 88,
          commentCount: 6,
          isMine: false,
          needsMyReview: false,
        },
        {
          id: 'pr-98',
          number: 98,
          title: 'Add safety preflight for force-with-lease',
          author: 'jamie',
          assignees: ['jamie'],
          reviewers: ['alex'],
          team: 'Platform',
          repo: 'branchline',
          sourceBranch: 'feature/safety-dialogs',
          targetBranch: 'main',
          status: 'open',
          url: 'https://github.com/example/branchline/pull/98',
          labels: ['safety'],
          updatedAt: '2026-07-16T09:10:00Z',
          draft: true,
          reviewState: 'pending',
          pipelineStatus: 'pending',
          additions: 210,
          deletions: 40,
          commentCount: 2,
          isMine: false,
          needsMyReview: false,
        },
        {
          id: 'pr-95',
          number: 95,
          title: 'Commit dialog with templates and amend',
          author: 'you',
          assignees: ['you'],
          reviewers: ['alex', 'jordan'],
          team: 'Product',
          repo: 'branchline',
          sourceBranch: 'feature/commit-modal',
          targetBranch: 'main',
          status: 'open',
          url: 'https://github.com/example/branchline/pull/95',
          labels: ['ux', 'commit'],
          updatedAt: '2026-07-18T11:00:00Z',
          draft: false,
          reviewState: 'changesRequested',
          pipelineStatus: 'failure',
          additions: 640,
          deletions: 120,
          commentCount: 11,
          isMine: true,
          needsMyReview: false,
        },
        {
          id: 'pr-92',
          number: 92,
          title: 'Dashboard fuzzy search for recent repos',
          author: 'sam',
          assignees: ['sam'],
          reviewers: ['you'],
          team: 'Product',
          repo: 'branchline',
          sourceBranch: 'feature/dashboard-search',
          targetBranch: 'develop',
          status: 'merged',
          url: 'https://github.com/example/branchline/pull/92',
          labels: ['dashboard'],
          updatedAt: '2026-07-12T18:40:00Z',
          draft: false,
          reviewState: 'approved',
          pipelineStatus: 'success',
          additions: 180,
          deletions: 22,
          commentCount: 4,
          isMine: false,
          needsMyReview: true,
        },
        {
          id: 'pr-88',
          number: 88,
          title: 'Azure DevOps PR adapter scaffold',
          author: 'jordan',
          assignees: ['jordan', 'alex'],
          reviewers: ['jamie'],
          team: 'Integrations',
          repo: 'branchline',
          sourceBranch: 'feature/ado-prs',
          targetBranch: 'main',
          status: 'open',
          url: 'https://github.com/example/branchline/pull/88',
          labels: ['integration', 'ado'],
          updatedAt: '2026-07-15T07:30:00Z',
          draft: false,
          reviewState: 'pending',
          pipelineStatus: 'success',
          additions: 510,
          deletions: 30,
          commentCount: 3,
          isMine: false,
          needsMyReview: false,
        },
        {
          id: 'pr-81',
          number: 81,
          title: 'Fix SSL path for corporate proxies',
          author: 'you',
          assignees: ['you'],
          reviewers: ['sam'],
          team: 'Platform',
          repo: 'branchline',
          sourceBranch: 'bug/ssl-proxy',
          targetBranch: 'release/1.0',
          status: 'closed',
          url: 'https://github.com/example/branchline/pull/81',
          labels: ['bug'],
          updatedAt: '2026-07-08T20:15:00Z',
          draft: false,
          reviewState: 'approved',
          pipelineStatus: 'cancelled',
          additions: 45,
          deletions: 12,
          commentCount: 1,
          isMine: true,
          needsMyReview: false,
        },
        {
          id: 'pr-77',
          number: 77,
          title: 'Jira branch-from-issue workflow',
          author: 'alex',
          assignees: ['alex'],
          reviewers: ['you', 'jamie'],
          team: 'Integrations',
          repo: 'navigo',
          sourceBranch: 'feature/jira-branch',
          targetBranch: 'main',
          status: 'open',
          url: 'https://github.com/example/navigo/pull/77',
          labels: ['jira', 'workflow'],
          updatedAt: '2026-07-18T09:45:00Z',
          draft: false,
          reviewState: 'pending',
          pipelineStatus: 'pending',
          additions: 300,
          deletions: 55,
          commentCount: 8,
          isMine: false,
          needsMyReview: true,
        },
        {
          id: 'pr-70',
          number: 70,
          title: 'Docs: onboarding SSH checklist',
          author: 'sam',
          assignees: [],
          reviewers: ['you'],
          team: 'Product',
          repo: 'branchline',
          sourceBranch: 'docs/onboarding-ssh',
          targetBranch: 'main',
          status: 'open',
          url: 'https://github.com/example/branchline/pull/70',
          labels: ['docs'],
          updatedAt: '2026-07-14T12:00:00Z',
          draft: true,
          reviewState: 'pending',
          pipelineStatus: 'success',
          additions: 90,
          deletions: 5,
          commentCount: 0,
          isMine: false,
          needsMyReview: true,
        },
      ],
      list_mock_jira_issues: [
        {
          key: 'BL-214',
          summary: 'Cherry-pick preview should estimate conflicts',
          status: 'In Progress',
          assignee: 'Alex Rivera',
          priority: 'High',
          issueType: 'Story',
          url: 'https://jira.example.com/browse/BL-214',
          updatedAt: '2026-07-18T08:00:00Z',
          labels: ['git', 'ux'],
        },
        {
          key: 'BL-201',
          summary: 'Persist layout per repository',
          status: 'Done',
          assignee: 'Jamie Chen',
          priority: 'Medium',
          issueType: 'Task',
          url: 'https://jira.example.com/browse/BL-201',
          updatedAt: '2026-07-15T16:20:00Z',
          labels: ['settings'],
        },
        {
          key: 'BL-188',
          summary: 'External merge tool launch for conflicts',
          status: 'To Do',
          assignee: 'Unassigned',
          priority: 'High',
          issueType: 'Bug',
          url: 'https://jira.example.com/browse/BL-188',
          updatedAt: '2026-07-10T11:05:00Z',
          labels: ['diff', 'conflicts'],
        },
        {
          key: 'BL-12',
          summary: 'Calm graph lanes for busy repos',
          status: 'In Progress',
          assignee: 'You',
          priority: 'Medium',
          issueType: 'Story',
          url: 'https://jira.example.com/browse/BL-12',
          updatedAt: '2026-07-17T12:00:00Z',
          labels: ['graph'],
        },
        {
          key: 'BL-9',
          summary: 'Onboarding identity form',
          status: 'To Do',
          assignee: 'You',
          priority: 'Low',
          issueType: 'Task',
          url: 'https://jira.example.com/browse/BL-9',
          updatedAt: '2026-07-16T09:00:00Z',
          labels: ['onboarding'],
        },
      ],
      list_jira_issues: [
        {
          key: 'BL-214',
          summary: 'Cherry-pick preview should estimate conflicts',
          status: 'In Progress',
          assignee: 'Alex Rivera',
          priority: 'High',
          issueType: 'Story',
          url: 'https://jira.example.com/browse/BL-214',
          updatedAt: '2026-07-18T08:00:00Z',
          labels: ['git', 'ux'],
        },
        {
          key: 'BL-201',
          summary: 'Persist layout per repository',
          status: 'Done',
          assignee: 'Jamie Chen',
          priority: 'Medium',
          issueType: 'Task',
          url: 'https://jira.example.com/browse/BL-201',
          updatedAt: '2026-07-15T16:20:00Z',
          labels: ['settings'],
        },
        {
          key: 'BL-188',
          summary: 'External merge tool launch for conflicts',
          status: 'To Do',
          assignee: 'Unassigned',
          priority: 'High',
          issueType: 'Bug',
          url: 'https://jira.example.com/browse/BL-188',
          updatedAt: '2026-07-10T11:05:00Z',
          labels: ['diff', 'conflicts'],
        },
      ],
      list_jira_transitions: [
        { id: '11', name: 'Start Progress', toStatus: 'In Progress' },
        { id: '21', name: 'Resolve Issue', toStatus: 'Done' },
        { id: '31', name: 'Stop Progress', toStatus: 'To Do' },
      ],
      transition_jira_issue: null,
      list_identity_contexts: {
        effective: { name: 'Sean Nortje', email: 'sean@company.com' },
        effectiveScope: 'global',
        local: null,
        global: { name: 'Sean Nortje', email: 'sean@company.com' },
        hasRepo: true,
        candidates: [
          {
            id: 'global:sean@company.com',
            name: 'Sean Nortje',
            email: 'sean@company.com',
            source: 'global',
            label: 'Global Git default',
            commitCount: 24,
            isActive: true,
            aliases: ['Sean'],
          },
          {
            id: 'history:sean@gmail.com',
            name: 'Sean Nortje',
            email: 'sean@gmail.com',
            source: 'history',
            label: 'Seen in commits',
            commitCount: 17,
            isActive: false,
            aliases: ['Sean Gareth'],
          },
        ],
      },
      list_workflows: this.mockMergedWorkflows(),
      list_templates: [
        { id: 'b1', kind: 'branch', name: 'Feature', pattern: 'feature/{jira}/{date}' },
        { id: 'c1', kind: 'commit', name: 'Conventional', pattern: '{type}: {summary}' },
      ],
      remove_recent_repo: [],
      pin_repo: [
        {
          path: '/Users/demo/projects/navigo',
          name: 'navigo',
          lastOpenedAt: new Date().toISOString(),
          pinned: true,
          isLast: true,
        },
      ],
    };

    if (cmd === 'save_workflow') {
      const input = args?.['input'] as {
        id?: string;
        name?: string;
        description?: string;
        steps?: WorkflowInfo['steps'];
        enabled?: boolean;
      };
      const name = (input?.name ?? '').trim();
      if (!name) throw new Error('Workflow name is required');
      if (!input?.steps?.length) throw new Error('Add at least one step');
      if (input.id) {
        const idx = this.mockCustomWorkflows.findIndex((w) => w.id === input.id);
        if (idx < 0) throw new Error('Workflow not found');
        const updated: WorkflowInfo = {
          ...this.mockCustomWorkflows[idx],
          name,
          description: (input.description ?? '').trim(),
          steps: [...input.steps],
          enabled: input.enabled ?? this.mockCustomWorkflows[idx].enabled,
        };
        this.mockCustomWorkflows[idx] = updated;
        return updated as T;
      }
      const created: WorkflowInfo = {
        id: `wf-${Date.now().toString(16)}`,
        name,
        description: (input.description ?? '').trim(),
        steps: [...input.steps],
        builtin: false,
        enabled: input.enabled ?? true,
      };
      this.mockCustomWorkflows.push(created);
      return created as T;
    }

    if (cmd === 'delete_workflow') {
      const id = (args?.['input'] as { id?: string } | undefined)?.id;
      if (!id) throw new Error('Workflow id required');
      if (this.mockBuiltinWorkflows().some((w) => w.id === id)) {
        throw new Error('Built-in workflows cannot be deleted — disable or duplicate them');
      }
      const before = this.mockCustomWorkflows.length;
      this.mockCustomWorkflows = this.mockCustomWorkflows.filter((w) => w.id !== id);
      if (this.mockCustomWorkflows.length === before) throw new Error('Workflow not found');
      return this.mockMergedWorkflows() as T;
    }

    if (cmd === 'set_workflow_enabled') {
      const input = args?.['input'] as { id?: string; enabled?: boolean } | undefined;
      const id = input?.id;
      if (!id) throw new Error('Workflow id required');
      const enabled = !!input?.enabled;
      if (this.mockBuiltinWorkflows().some((w) => w.id === id)) {
        if (enabled) this.mockDisabledBuiltinWorkflows.delete(id);
        else this.mockDisabledBuiltinWorkflows.add(id);
      } else {
        const wf = this.mockCustomWorkflows.find((w) => w.id === id);
        if (!wf) throw new Error('Workflow not found');
        wf.enabled = enabled;
      }
      return this.mockMergedWorkflows() as T;
    }

    if (cmd === 'analyze_safety') {
      const input = args?.['input'] as { action?: SafetyAction; target?: string; path?: string } | undefined;
      const path = input?.path ?? '';
      const target = input?.target ?? 'main';
      const locked = this.mockLocks.has(`${path}::${target}`);
      const reason = this.mockLocks.get(`${path}::${target}`)?.reason ?? null;
      return this.mockSafetyAnalysis(input?.action ?? 'forcePush', target, locked, reason) as T;
    }

    if (cmd === 'get_conflict_sides') {
      const filePath =
        (args?.['input'] as { filePath?: string } | undefined)?.filePath ?? 'src/app.ts';
      if (filePath === 'README.md') {
        return {
          path: filePath,
          base: '# Branchline\n\nA calm Git client.\n',
          ours: '# Branchline\n\nA calm Git client for everyday work.\n',
          theirs: '',
          working: '# Branchline\n\nA calm Git client for everyday work.\n',
          hasBase: true,
          hasOurs: true,
          hasTheirs: false,
          binary: false,
          unmerged: true,
          hasMarkers: false,
        } as T;
      }
      return {
        path: filePath,
        base:
          "export const value = 1;\nexport const title = 'App';\n\nexport function greet(name: string) {\n  return `Hi ${name}`;\n}\n",
        ours:
          "export const value = 2;\nexport const title = 'Branchline';\n\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n",
        theirs:
          "export const value = 3;\nexport const title = 'App';\n\nexport function greet(name: string) {\n  return `Welcome ${name}`;\n}\n",
        working:
          "<<<<<<< HEAD\nexport const value = 2;\n=======\nexport const value = 3;\n>>>>>>> feature/auth\nexport const title = 'Branchline';\n\n<<<<<<< HEAD\nexport function greet(name: string) {\n  return `Hello ${name}`;\n}\n=======\nexport function greet(name: string) {\n  return `Welcome ${name}`;\n}\n>>>>>>> feature/auth\n",
        hasBase: true,
        hasOurs: true,
        hasTheirs: true,
        binary: false,
        unmerged: true,
        hasMarkers: true,
      } as T;
    }

    if (cmd === 'resolve_conflict_file') {
      return { ok: true, message: 'Resolved (mock)' } as T;
    }

    if (cmd === 'open_conflict_in_ide') {
      const input = args?.['input'] as {
        filePath?: string;
        editor?: string;
        mode?: string;
        wait?: boolean;
      } | undefined;
      return {
        ok: true,
        message: input?.wait
          ? `Resolved ${input?.filePath ?? 'file'} after ${input?.editor ?? 'editor'} closed`
          : `Opened ${input?.filePath ?? 'file'} in ${input?.editor ?? 'editor'} (${input?.mode ?? 'file'})`,
      } as T;
    }

    if (cmd === 'list_submodules') {
      return [
        {
          name: 'vendor-ui',
          path: 'vendor/ui',
          url: 'https://github.com/demo/vendor-ui.git',
          head: 'abcdef1234567890',
          shortHead: 'abcdef1',
          status: 'ok',
          initialized: true,
        },
      ] as T;
    }

    if (
      cmd === 'update_submodules' ||
      cmd === 'sync_submodules' ||
      cmd === 'update_submodule' ||
      cmd === 'lfs_pull'
    ) {
      return mutation as T;
    }

    if (cmd === 'list_lfs_files') {
      return [
        { path: 'assets/hero.png', locked: false, size: '1.2 MB' },
        { path: 'assets/demo.mp4', locked: false, size: '24 MB' },
      ] as T;
    }

    if (cmd === 'list_pull_requests') {
      return mocks['list_mock_pull_requests'] as T;
    }

    if (cmd === 'create_pull_request') {
      return {
        ok: true,
        message: 'Opened PR #42 (mock)',
        url: 'https://github.com/demo/branchline/pull/42',
        number: 42,
      } as T;
    }

    if (cmd in mocks) {
      return mocks[cmd] as T;
    }
    console.warn('Unhandled mock command', cmd, args);
    return {} as T;
  }

  private mockBranches(): BranchInfo[] {
    return [
      {
        name: 'main',
        isCurrent: true,
        isRemote: false,
        upstream: 'origin/main',
        upstreamGone: false,
        tipSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        tipShortSha: 'a1b2c3d',
        tipSubject: "Merge branch 'feature/auth' into main",
        tipAuthor: 'Sean',
        tipEmail: 'sean@example.com',
        locked: false,
        lockReason: null,
      },
      {
        name: 'feature/auth',
        isCurrent: false,
        isRemote: false,
        upstream: null,
        upstreamGone: false,
        tipSha: 'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
        tipShortSha: 'f6a1b2c',
        tipSubject: 'Add OAuth providers',
        tipAuthor: 'Maya',
        tipEmail: 'maya@example.com',
        locked: false,
        lockReason: null,
      },
      {
        name: 'feature/onboarding',
        isCurrent: false,
        isRemote: false,
        upstream: null,
        upstreamGone: false,
        tipSha: 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        tipShortSha: 'c3d4e5f',
        tipSubject: 'Add onboarding wizard',
        tipAuthor: 'Sean',
        tipEmail: 'sean@example.com',
        locked: false,
        lockReason: null,
      },
      {
        name: 'release/1.0',
        isCurrent: false,
        isRemote: false,
        upstream: null,
        upstreamGone: false,
        tipSha: 'g7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5',
        tipShortSha: 'g7a8b9c',
        tipSubject: 'Hotfix packaging for release',
        tipAuthor: 'Alex',
        tipEmail: 'alex@example.com',
        locked: false,
        lockReason: null,
      },
      {
        name: 'origin/main',
        isCurrent: false,
        isRemote: true,
        upstream: null,
        upstreamGone: false,
        tipSha: 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
        tipShortSha: 'b2c3d4e',
        tipSubject: 'Polish dashboard empty states',
        tipAuthor: 'Sean',
        tipEmail: 'sean@example.com',
        locked: false,
        lockReason: null,
      },
    ];
  }

  private mockSafetyAnalysis(
    action: SafetyAction,
    target: string,
    locked = false,
    lockReason: string | null = null,
  ): SafetyAnalysis {
    if (action === 'forcePush') {
      const branch = target || 'main';
      const protectedBranch =
        ['main', 'master', 'develop', 'dev', 'release', 'trunk'].includes(branch) ||
        branch.startsWith('release/');
      const behind = 1;
      const leaseSafe = false;
      return {
        action: 'forcePush',
        title: `Force push '${branch}'?`,
        severity: locked || protectedBranch ? 'danger' : 'warning',
        target: branch,
        consequence: locked
          ? `Branch '${branch}' is locked. Push and force-push are blocked until unlocked.`
          : `This rewrites remote history on origin/${branch}. Collaborators who based work on the old tip will need to recover (rebase or reset).`,
        advice: locked
          ? 'This branch is locked in Branchline. Unlock it from the Branches panel before pushing.'
          : protectedBranch
            ? `Force-pushing '${branch}' can disrupt the whole team. Prefer a new branch + PR. If you must continue, use --force-with-lease and type the branch name.`
            : 'Fetch first so lease compares against the latest remote tip. Bare --force ignores collaborators\' new commits.',
        checks: [
          {
            id: 'not_locked',
            label: 'Branch is not locked',
            ok: !locked,
            detail: locked
              ? lockReason
                ? `Locked: ${lockReason}`
                : 'Unlock this branch before pushing'
              : 'No Branchline lock on this branch',
          },
          {
            id: 'not_protected',
            label: 'Not a protected branch',
            ok: !protectedBranch,
            detail: protectedBranch
              ? `'${branch}' is commonly protected — type the name to continue`
              : 'Branch name is not a common protected name',
          },
          {
            id: 'lease_safe',
            label: 'Remote has not moved ahead',
            ok: leaseSafe,
            detail: `Upstream is ${behind} commit(s) ahead — fetch first; --force-with-lease will refuse if remote moved`,
          },
          {
            id: 'has_local',
            label: 'Has local commits to publish',
            ok: true,
            detail: 'Ahead by 2 commit(s)',
          },
          {
            id: 'prefer_lease',
            label: 'Prefer --force-with-lease',
            ok: true,
            detail: 'Safer than --force: refuses if someone else pushed since your last fetch',
          },
        ],
        recommendedLabel: locked ? 'Close' : 'Push with --force-with-lease',
        recommendedAction: locked ? 'keep' : 'force_with_lease',
        proceedLabel: locked ? 'Close' : 'Push with --force',
        gitCommand: `git push --force-with-lease origin ${branch}`,
        proceedGitCommand: `git push --force origin ${branch}`,
        confirmPrompt: `I understand this rewrites remote history on '${branch}'`,
        requireTypedConfirm: !locked && (protectedBranch || !leaseSafe),
        blocked: locked,
        canProceed: !locked,
      };
    }

    if (action === 'hardReset') {
      return {
        action: 'hardReset',
        title: `Hard reset to '${target}'?`,
        severity: 'danger',
        target,
        consequence: `Hard reset moves HEAD to '${target}' and discards commits and working-tree changes from this branch tip.`,
        advice: 'Recommended path creates a backup branch first so you can recover with checkout.',
        checks: [
          {
            id: 'clean_tree',
            label: 'Working tree clean',
            ok: false,
            detail: 'Uncommitted changes will be discarded',
          },
          {
            id: 'not_ahead',
            label: 'Not ahead of upstream',
            ok: true,
            detail: 'Not ahead of upstream',
          },
        ],
        recommendedLabel: 'Backup branch, then hard reset',
        recommendedAction: 'backup_branch',
        proceedLabel: 'Hard reset without backup',
        gitCommand: `git branch backup/… && git reset --hard ${target}`,
        proceedGitCommand: `git reset --hard ${target}`,
        confirmPrompt: 'I understand commits and local changes may be lost',
        requireTypedConfirm: true,
        blocked: false,
        canProceed: true,
      };
    }

    if (action === 'discard') {
      return {
        action: 'discard',
        title: 'Discard uncommitted changes?',
        severity: 'warning',
        target,
        consequence: `Discard uncommitted changes for '${target || '.'}'. Staged changes are left alone.`,
        advice: 'Recommended path keeps an undo entry so you can restore from the journal.',
        checks: [
          {
            id: 'scope',
            label: 'Discard scope is limited',
            ok: !!target,
            detail: target ? `Only '${target}' will be discarded` : 'All unstaged changes may be discarded',
          },
          {
            id: 'size',
            label: 'Small change set',
            ok: true,
            detail: '3 file(s) with unstaged/untracked changes',
          },
        ],
        recommendedLabel: 'Discard (keep undo)',
        recommendedAction: 'discard_with_undo',
        proceedLabel: 'Discard without undo',
        gitCommand: `git checkout -- ${target || '.'}`,
        proceedGitCommand: `git checkout -- ${target || '.'}`,
        confirmPrompt: 'I understand these local changes may be lost',
        requireTypedConfirm: false,
        blocked: false,
        canProceed: true,
      };
    }

    if (action === 'deleteTag') {
      return {
        action: 'deleteTag',
        title: `Delete tag '${target}'?`,
        severity: 'warning',
        target,
        consequence: `Delete local tag '${target}'. The remote tag is unchanged unless you push a delete separately.`,
        advice: 'Remote cleanup is a separate step: git push origin :refs/tags/<tag>.',
        checks: [
          {
            id: 'exists',
            label: 'Tag exists locally',
            ok: true,
            detail: `Found tag '${target}'`,
          },
        ],
        recommendedLabel: 'Delete local tag',
        recommendedAction: 'delete_local',
        proceedLabel: 'Delete local tag',
        gitCommand: `git tag -d ${target}`,
        proceedGitCommand: `git tag -d ${target}`,
        confirmPrompt: `I understand I am deleting local tag '${target}'`,
        requireTypedConfirm: false,
        blocked: false,
        canProceed: true,
      };
    }

    const branch = target || 'feature/onboarding';
    return {
      action: 'deleteBranch',
      title: `Delete branch '${branch}'?`,
      severity: locked ? 'danger' : 'warning',
      target: branch,
      consequence: locked
        ? `Branch '${branch}' is locked and cannot be deleted until unlocked.`
        : `Delete local branch '${branch}'. Work appears merged into HEAD.`,
      advice: locked
        ? 'Unlock the branch from the Branches panel, then try again.'
        : 'Prefer deleting only after the branch is merged or you no longer need it.',
      checks: [
        {
          id: 'not_current',
          label: 'Not the current branch',
          ok: true,
          detail: 'Safe to delete a non-checked-out branch',
        },
        {
          id: 'not_locked',
          label: 'Branch is not locked',
          ok: !locked,
          detail: locked
            ? lockReason
              ? `Locked: ${lockReason}`
              : 'Unlock this branch before deleting'
            : 'No Branchline lock on this branch',
        },
        {
          id: 'merged',
          label: 'Merged into HEAD',
          ok: true,
          detail: 'Branch tip is reachable from HEAD',
        },
        {
          id: 'no_upstream',
          label: 'No remote tracking branch',
          ok: true,
          detail: 'Local-only branch',
        },
      ],
      recommendedLabel: locked ? 'Close' : 'Delete local branch',
      recommendedAction: locked ? 'keep' : 'delete',
      proceedLabel: locked ? 'Close' : 'Delete anyway',
      gitCommand: `git branch -d ${branch}`,
      proceedGitCommand: `git branch -D ${branch}`,
      confirmPrompt: `I understand I am deleting local branch '${branch}'`,
      requireTypedConfirm: false,
      blocked: locked,
      canProceed: !locked,
    };
  }

  private mockStatus(): RepoStatus {
    const conflicted = this.mockPreviewFlags.conflicts
      ? [
          {
            path: 'src/app.ts',
            status: 'conflicted' as const,
            conflictKind: 'bothModified',
            conflictLabel: 'both modified',
          },
          {
            path: 'README.md',
            status: 'conflicted' as const,
            conflictKind: 'deletedByUs',
            conflictLabel: 'deleted by us',
          },
        ]
      : [];
    return {
      path: '/Users/demo/projects/navigo',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      isDetached: false,
      staged: [
        { path: 'src/styles.scss', status: 'modified' },
        { path: 'src/app/layout/shell/shell.html', status: 'modified' },
      ],
      unstaged: (
        [
          { path: 'src/app.ts', status: 'modified' },
          { path: 'src/app/features/files/file-tree-panel/file-tree-panel.ts', status: 'added' },
          { path: 'src/app/core/app.store.ts', status: 'modified' },
          { path: 'README.md', status: 'modified' },
        ] as FileStatusEntry[]
      ).filter((f) => !conflicted.some((c) => c.path === f.path)),
      untracked: [
        { path: 'notes.md', status: 'untracked' },
        { path: 'docs/workflows.md', status: 'untracked' },
      ],
      conflicted,
      operation: conflicted.length
        ? { kind: 'merge', label: 'Merge in progress', detail: null }
        : null,
    };
  }

  private mockOnboardingStatus(): OnboardingStatusOutput {
    if (this.mockPreviewFlags.onboarding) {
      return {
        completed: false,
        skipped: false,
        items: [
          {
            id: 'git',
            label: 'Git installed',
            description: 'Git detected in browser preview mode',
            status: 'verified',
          },
          {
            id: 'identity',
            label: 'Git identity',
            description: 'Set your name and email',
            status: 'needsAttention',
          },
          {
            id: 'ssh',
            label: 'SSH for Git remotes',
            description: 'Add a key for GitHub / GitLab',
            status: 'needsAttention',
          },
          {
            id: 'credentialHelper',
            label: 'Credential helper',
            description: 'Configure git credential.helper',
            status: 'needsAttention',
          },
          {
            id: 'defaultTools',
            label: 'Editor & merge tools',
            description: 'Optional — configure in Settings → Tools',
            status: 'skipped',
          },
        ],
      };
    }
    return {
      completed: true,
      skipped: false,
      items: [
        {
          id: 'git',
          label: 'Git installed',
          description: 'Git detected in browser preview mode',
          status: 'verified',
        },
        {
          id: 'identity',
          label: 'Git identity',
          description: 'Name and email are set',
          status: 'verified',
        },
        {
          id: 'ssh',
          label: 'SSH for Git remotes',
          description: 'Preview mode — connect in the desktop app',
          status: 'needsAttention',
        },
        {
          id: 'credentialHelper',
          label: 'Credential helper',
          description: 'Preview mode',
          status: 'needsAttention',
        },
        {
          id: 'defaultTools',
          label: 'Editor & merge tools',
          description: 'Optional — configure later',
          status: 'skipped',
        },
      ],
    };
  }

  private mockDiff(args?: Record<string, unknown>): DiffOutput {
    const input = (args?.['input'] ?? args ?? {}) as { pathspec?: string };
    const pathspec = input.pathspec;
    if (!pathspec) {
      return {
        files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }],
        unified: '',
      };
    }
    if (this.mockPreviewFlags.conflicts && (pathspec === 'src/app.ts' || pathspec === 'README.md')) {
      return {
        files: [],
        unified:
          `diff --git a/${pathspec} b/${pathspec}\n--- a/${pathspec}\n+++ b/${pathspec}\n@@ -1,4 +1,7 @@\n export class App {\n<<<<<<< HEAD\n-  title = "Old";\n=======\n+  title = "Branchline";\n>>>>>>> feature/auth\n }\n`,
      };
    }
    return {
      files: [],
      unified:
        'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,4 @@\n export class App {\n+  title = "Branchline";\n }\n',
    };
  }

  private mockCommits(): CommitInfo[] {
    const now = Math.floor(Date.now() / 1000);
    const c = (
      sha: string,
      subject: string,
      author: string,
      ago: number,
      parents: string[],
      refs: string[],
      laneHint: number,
      isRelativeToHead: boolean,
      message = subject,
    ): CommitInfo => ({
      sha,
      shortSha: sha.slice(0, 7),
      message,
      subject,
      author,
      email: `${author.toLowerCase().replace(/\s+/g, '.')}@example.com`,
      timestamp: now - ago,
      parents,
      refs,
      laneHint,
      isRelativeToHead,
    });

    const m0 = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const m1 = 'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3';
    const auth1 = 'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1';
    const auth0 = 'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
    const base1 = 'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
    const rel1 = 'g7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5';
    const base0 = 'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5';
    const root = '0102030405060708090a0b0c0d0e0f1011121314';

    return [
      c(
        m0,
        "Merge branch 'feature/auth' into main",
        'Sean',
        1800,
        [m1, auth1],
        ['HEAD', 'main'],
        0,
        true,
      ),
      c(auth1, 'Add OAuth providers', 'Maya', 3600, [auth0], ['feature/auth'], 1, true),
      c(
        m1,
        'Polish dashboard empty states',
        'Sean',
        7200,
        [base1],
        [],
        0,
        true,
        'Polish dashboard empty states\n\nMake first-run clearer.',
      ),
      c(auth0, 'Auth scaffold and session store', 'Maya', 14400, [base1], [], 1, true),
      c(base1, 'Add onboarding wizard', 'Sean', 86400, [base0], ['feature/onboarding'], 0, true),
      c(rel1, 'Hotfix packaging for release', 'Alex', 100000, [base0], ['release/1.0'], 2, false),
      c(base0, 'Wire Tauri git commands', 'Sean', 172800, [root], [], 0, true),
      c(root, 'Initial commit', 'Sean', 604800, [], ['tag: v0.1.0'], 0, true),
    ];
  }

  private mockSettings(): AppSettings {
    const defaults: AppSettings = {
      theme: 'system',
      accent: '#0EA5E9',
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
      branchPrefixes: ['feature', 'bugfix', 'hotfix', 'chore', 'release'],
      preferredEditor: 'auto',
      editorCommand: '',
      diffTool: '',
      mergeTool: '',
      sshClient: 'openssh',
      connections: [
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
          id: 'azure',
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
          baseUrl: 'https://example.atlassian.net',
          username: '',
          token: '',
          organization: '',
          project: '',
        },
      ],
      commitTypes: [
        { id: 'feat', label: 'feat', description: 'New feature' },
        { id: 'fix', label: 'fix', description: 'Bug fix' },
        { id: 'docs', label: 'docs', description: 'Documentation' },
        { id: 'refactor', label: 'refactor', description: 'Code change without behavior change' },
        { id: 'perf', label: 'perf', description: 'Performance improvement' },
        { id: 'test', label: 'test', description: 'Tests' },
        { id: 'build', label: 'build', description: 'Build system or dependencies' },
        { id: 'ci', label: 'ci', description: 'CI configuration' },
        { id: 'chore', label: 'chore', description: 'Maintenance' },
        { id: 'revert', label: 'revert', description: 'Revert a previous commit' },
      ],
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
    };

    try {
      const raw = localStorage.getItem('branchline.settings');
      if (!raw) {
        const theme = localStorage.getItem('branchline.theme');
        const accent = localStorage.getItem('branchline.accent');
        return {
          ...defaults,
          theme: theme || defaults.theme,
          accent: accent || defaults.accent,
        };
      }
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  }

  private persistMockSettings(settings: AppSettings): void {
    try {
      localStorage.setItem('branchline.settings', JSON.stringify(settings));
      localStorage.setItem('branchline.theme', settings.theme || 'system');
      localStorage.setItem('branchline.accent', settings.accent || '#0EA5E9');
    } catch {
      /* ignore */
    }
  }
}

function isMissingTauriCommand(err: unknown, command: string): boolean {
  const text =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === 'object' && 'message' in err
          ? String((err as { message: unknown }).message)
          : String(err ?? '');
  const lower = text.toLowerCase();
  return (
    lower.includes('not found') &&
    (lower.includes(command.toLowerCase()) || lower.includes('command'))
  );
}

function looksBinaryText(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return true;
  const sample = value.slice(0, 8000);
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32) weird += 1;
  }
  return weird / Math.max(sample.length, 1) > 0.3;
}

function readMockPreviewFlags(): { conflicts: boolean; onboarding: boolean } {
  if (typeof window === 'undefined') {
    return { conflicts: false, onboarding: false };
  }
  try {
    const params = new URLSearchParams(window.location.search);
    const conflicts =
      params.get('mockConflicts') === '1' ||
      window.localStorage.getItem('branchline.mockConflicts') === '1';
    const onboarding =
      params.get('mockOnboarding') === '1' ||
      window.localStorage.getItem('branchline.mockOnboarding') === '1';
    return { conflicts, onboarding };
  } catch {
    return { conflicts: false, onboarding: false };
  }
}
