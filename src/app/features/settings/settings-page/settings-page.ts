import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore, normalizeSettingsSection, type SettingsSection } from '../../../core/app.store';
import { DEFAULT_COMMIT_TYPES, normalizeCommitTypeId } from '../../../core/commit-types';
import { TauriService } from '../../../core/tauri.service';
import type {
  AppSettings,
  CommitTypeOption,
  ConnectionConfig,
  DefaultPullAction,
  DefaultPushAction,
  GitEnvSnapshot,
  TestConnectionOutput,
} from '../../../core/models';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { Dashboard } from '../../../layout/dashboard/dashboard';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { UpdateService } from '../../../core/update.service';
import { DiagnosticsService } from '../../../core/diagnostics.service';
import { mergeToolPreset, type IdeEditor } from '../../../shared/git/open-in-editor';
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  isModifierOnly,
  normalizeShortcut,
  resolveShortcuts,
  type ShortcutId,
} from '../../../shared/git/shortcuts';
import { TicketFromBranch } from '../ticket-from-branch/ticket-from-branch';
import { GitAccountBar } from '../../remotes/git-account-bar/git-account-bar';

type ConfirmationKey =
  | 'confirmForcePush'
  | 'confirmDiscard'
  | 'confirmPushNewBranch'
  | 'confirmAddTrackingRef'
  | 'confirmAmend'
  | 'confirmUndoLastCommit'
  | 'confirmStashDrop'
  | 'confirmAbortOperation'
  | 'confirmAbortSecond'
  | 'confirmRemoveRemote';

@Component({
  selector: 'app-settings-page',
  imports: [FormsModule, NgIcon, HelpTip, Dashboard, TicketFromBranch, GitAccountBar],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage implements OnInit {
  readonly store = inject(AppStore);
  readonly updates = inject(UpdateService);
  readonly diagnostics = inject(DiagnosticsService);
  private readonly tauri = inject(TauriService);
  private readonly prompts = inject(PromptService);

  readonly section = signal<SettingsSection>('repos');
  readonly gitEnv = signal<GitEnvSnapshot | null>(null);
  readonly identityName = signal('');
  readonly identityEmail = signal('');
  readonly editingConnectionId = signal<string | null>(null);
  readonly showTokens = signal(false);
  readonly newTypeId = signal('');
  readonly newTypeDescription = signal('');
  readonly savingTypes = signal(false);
  readonly connectingId = signal<string | null>(null);
  readonly testingId = signal<string | null>(null);
  readonly testingAll = signal(false);
  readonly testingSsh = signal(false);
  readonly connectionTests = signal<Record<string, TestConnectionOutput>>({});
  readonly sshTest = signal<TestConnectionOutput | null>(null);
  readonly capturingShortcut = signal<ShortcutId | null>(null);
  readonly formatShortcut = formatShortcut;
  readonly shortcutRows: { id: ShortcutId; label: string }[] = [
    { id: 'palette', label: 'Palette' },
    { id: 'commit', label: 'Commit' },
    { id: 'fetch', label: 'Fetch' },
    { id: 'search', label: 'Search' },
    { id: 'undo', label: 'Undo' },
    { id: 'refresh', label: 'Refresh' },
  ];

  readonly confirmations: { key: ConfirmationKey; label: string; hint: string }[] = [
    { key: 'confirmForcePush', label: 'Force push', hint: 'Safety dialog for force-with-lease / force' },
    { key: 'confirmDiscard', label: 'Discard changes', hint: 'Ask before discarding working-tree changes' },
    { key: 'confirmPushNewBranch', label: 'Push a new branch', hint: 'Warn when the remote branch does not exist yet' },
    { key: 'confirmAddTrackingRef', label: 'Add tracking reference', hint: 'Ask whether to set upstream on first push' },
    { key: 'confirmAmend', label: 'Amend last commit', hint: 'Warn that amending rewrites branch history' },
    { key: 'confirmUndoLastCommit', label: 'Undo last action', hint: 'Confirm before undoing from the journal' },
    { key: 'confirmStashDrop', label: 'Drop stash', hint: 'Confirm before permanently deleting a stash' },
    { key: 'confirmAbortOperation', label: 'Abort merge / rebase', hint: 'Warn before aborting an in-progress operation' },
    { key: 'confirmAbortSecond', label: 'Second abort confirmation', hint: 'Ask again before aborting (Git Extensions–style)' },
    { key: 'confirmRemoveRemote', label: 'Remove remote', hint: 'Confirm before deleting a remote entry' },
  ];

  readonly sections: { id: SettingsSection; label: string; hint: string; help: string }[] = [
    {
      id: 'repos',
      label: 'Repos',
      hint: 'Open, clone, and manage local repositories',
      help: 'Open a folder, clone from a URL, or pin repos you use often. The last repo you opened is offered first.',
    },
    {
      id: 'appearance',
      label: 'Appearance',
      hint: 'Theme, accent, and UI modes',
      help: 'Theme, accent, and Simple vs Advanced. Simple hides Identity, Automation, and extra inspect tabs like Blame and Reflog.',
    },
    {
      id: 'git',
      label: 'Git',
      hint: 'Identity, pull/push, commits, and external tools',
      help: 'Author identity, commit signing, pull and push defaults, safety confirmations, commit types, and which editor or diff tool to open.',
    },
    {
      id: 'notifications',
      label: 'Notifications',
      hint: 'Toasts, desktop alerts, Git and pull request events',
      help: 'In-app toasts and optional desktop alerts for Git and pull request events.',
    },
    {
      id: 'connections',
      label: 'Connections',
      hint: 'Git hosts, Jira, SSH keys, and credentials',
      help: 'GitHub accounts, Jira, SSH keys, and credentials used to talk to remotes and issue trackers.',
    },
    {
      id: 'about',
      label: 'About',
      hint: 'Version, updates, and crash diagnostics',
      help: 'App version, updates, and crash diagnostics if something goes wrong.',
    },
  ];

  readonly sectionMeta = computed(
    () => this.sections.find((s) => s.id === this.section()) ?? this.sections[0],
  );

  readonly linkedCount = computed(
    () => this.store.settings().connections.filter((c) => this.store.isConnectionLinked(c)).length,
  );

  constructor() {
    effect(() => {
      this.section.set(normalizeSettingsSection(this.store.settingsSection()));
    });
    effect(() => {
      const focus = this.store.settingsFocusConnectionId();
      if (!focus) return;
      this.section.set('connections');
      this.store.clearSettingsFocusConnection();
      if (focus === 'ssh' || focus === 'github-git') {
        const id = focus === 'ssh' ? 'settings-ssh' : 'settings-github-git';
        queueMicrotask(() =>
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
        return;
      }
      this.editingConnectionId.set(focus);
    });
    effect((onCleanup) => {
      const id = this.capturingShortcut();
      if (!id) return;
      const onKey = (event: KeyboardEvent) => this.onCaptureKey(event, id);
      window.addEventListener('keydown', onKey, true);
      onCleanup(() => window.removeEventListener('keydown', onKey, true));
    });
  }

  async ngOnInit(): Promise<void> {
    await this.refreshEnv();
    void this.store.refreshGithubGitStatus();
    const id = this.store.identity();
    this.identityName.set(id?.name ?? '');
    this.identityEmail.set(id?.email ?? '');
    if (this.section() === 'about') {
      void this.refreshDiagnostics();
    }
  }

  setSection(section: SettingsSection): void {
    const next = normalizeSettingsSection(section);
    this.section.set(next);
    this.store.setSettingsSection(next);
    if (next === 'about') {
      void this.refreshDiagnostics();
    }
    if (next === 'git' || next === 'connections') {
      void this.refreshEnv();
      void this.store.refreshGithubGitStatus();
    }
  }

  setConfirmation(key: ConfirmationKey, value: boolean): void {
    void this.store.saveSettings({ [key]: value } as Partial<AppSettings>);
  }

  async refreshDiagnostics(): Promise<void> {
    await this.diagnostics.refresh();
  }

  async copyDiagnostics(): Promise<void> {
    try {
      const text = await this.diagnostics.copyReport();
      await navigator.clipboard.writeText(text);
      this.store.showSuccess('Diagnostics copied to clipboard');
    } catch (err) {
      this.store.showError(err);
    }
  }

  async openDiagnosticsFolder(): Promise<void> {
    try {
      await this.diagnostics.openFolder();
    } catch (err) {
      this.store.showError(err);
    }
  }

  async clearDiagnostics(): Promise<void> {
    try {
      await this.diagnostics.clear();
      this.store.showSuccess('Cleared local crash and error history');
    } catch (err) {
      this.store.showError(err);
    }
  }

  setTheme(theme: string): void {
    void this.store.saveSettings({ theme });
  }

  shortcutAccel(id: ShortcutId): string {
    return resolveShortcuts(this.store.settings().keyboardShortcuts)[id];
  }

  startCapture(id: ShortcutId): void {
    this.capturingShortcut.set(this.capturingShortcut() === id ? null : id);
  }

  resetShortcuts(): void {
    this.capturingShortcut.set(null);
    void this.store.saveSettings({ keyboardShortcuts: { ...DEFAULT_SHORTCUTS } });
  }

  private onCaptureKey(event: KeyboardEvent, id: ShortcutId): void {
    if (isModifierOnly(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      this.capturingShortcut.set(null);
      return;
    }
    const accel = normalizeShortcut(event);
    if (!accel) return;
    const current = resolveShortcuts(this.store.settings().keyboardShortcuts);
    void this.store.saveSettings({ keyboardShortcuts: { ...current, [id]: accel } });
    this.capturingShortcut.set(null);
  }

  async onHideUntracked(hideUntracked: boolean): Promise<void> {
    await this.store.saveSettings({ hideUntracked });
    await this.store.refreshRepo();
  }

  setAccent(accent: string): void {
    void this.store.saveSettings({ accent });
  }

  setPullAction(defaultPullAction: DefaultPullAction): void {
    void this.store.saveSettings({ defaultPullAction });
  }

  setPushAction(defaultPushAction: DefaultPushAction): void {
    void this.store.saveSettings({ defaultPushAction });
  }

  onGitFlowMain(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim() || 'main';
    void this.store.saveSettings({ gitFlowMain: value });
  }

  onGitFlowDevelop(event: Event): void {
    const value = (event.target as HTMLInputElement).value.trim() || 'develop';
    void this.store.saveSettings({ gitFlowDevelop: value });
  }

  setSshClient(sshClient: string): void {
    void this.store.saveSettings({ sshClient });
  }

  async saveIdentity(): Promise<void> {
    try {
      await this.tauri.setGitIdentity(this.identityName().trim(), this.identityEmail().trim());
      await this.store.refreshIdentity();
      this.store.showSuccess('Git identity saved');
    } catch (err) {
      this.store.showError(err);
    }
  }

  connectionStatus(conn: ConnectionConfig): string {
    if (this.store.isConnectionLinked(conn)) return 'Connected';
    if (!conn.enabled) return 'Off';
    return 'Needs token';
  }

  connectionUses(provider: string): string {
    switch (provider) {
      case 'github':
        return 'Repo picker, clone from host, live pull requests';
      case 'gitlab':
        return 'Repo picker and clone. Merge requests open in the browser.';
      case 'azureDevOps':
        return 'Pull requests open in the browser.';
      case 'jira':
        return 'Issues panel, branch from ticket, commit keys';
      default:
        return '';
    }
  }

  editConnection(id: string): void {
    const closing = this.editingConnectionId() === id;
    this.editingConnectionId.set(closing ? null : id);
    if (closing) {
      const conn = this.store.settings().connections.find((c) => c.id === id);
      if (conn && this.connectionKind(conn.provider) && (conn.hasToken || conn.token.trim())) {
        void this.testConnection(conn);
      }
    }
  }

  updateConnection(id: string, patch: Partial<ConnectionConfig>): void {
    const connections = this.store.settings().connections.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch };
      if (patch.token !== undefined) {
        next.hasToken = !!patch.token.trim();
      }
      return next;
    });
    void this.store.saveSettings({ connections });
  }

  providerHint(provider: string): string {
    switch (provider) {
      case 'github':
        return 'Connect with GitHub (browser approval), or paste a PAT with repo scope.';
      case 'gitlab':
        return 'Personal access token with api scope. Self-hosted: change base URL.';
      case 'azureDevOps':
        return 'PAT with Code (read) + Pull Request scopes. Set organization and project.';
      case 'jira':
        return 'Atlassian API token (email + token). Powers the Jira panel, branch-from-ticket, and commit keys.';
      default:
        return '';
    }
  }

  async connect(conn: ConnectionConfig): Promise<void> {
    this.connectingId.set(conn.id);
    try {
      if (conn.provider === 'github') {
        this.store.openGithubDeviceLogin();
        return;
      }

      if (conn.provider === 'gitlab') {
        const token = await this.prompts.ask({
          title: 'Connect GitLab',
          message: this.providerHint(conn.provider),
          label: 'Personal access token',
          placeholder: 'glpat-…',
          confirmLabel: 'Connect',
          mono: true,
        });
        if (!token?.trim()) return;
        await this.store.signInGitHost(conn.provider, token.trim(), conn.username);
        return;
      }

      if (conn.provider === 'azureDevOps') {
        let org = conn.organization.trim();
        if (!org) {
          const asked = await this.prompts.ask({
            title: 'Azure DevOps organization',
            message: 'Organization name from dev.azure.com/{org}.',
            label: 'Organization',
            placeholder: 'contoso',
            confirmLabel: 'Next',
            initialValue: conn.organization,
          });
          if (!asked?.trim()) return;
          org = asked.trim();
        }
        const token = await this.prompts.ask({
          title: 'Connect Azure DevOps',
          message: this.providerHint(conn.provider),
          label: 'Personal access token',
          placeholder: 'PAT',
          confirmLabel: 'Connect',
          mono: true,
        });
        if (!token?.trim()) return;
        await this.store.signInAzureDevOps(token.trim(), org, conn.project);
        return;
      }

      if (conn.provider === 'jira') {
        const email = await this.prompts.ask({
          title: 'Connect Jira',
          message: 'Atlassian account email for API token auth.',
          label: 'Email',
          placeholder: 'you@company.com',
          confirmLabel: 'Next',
          initialValue: conn.username,
        });
        if (!email?.trim()) return;
        const token = await this.prompts.ask({
          title: 'Jira API token',
          message: 'Create a token at id.atlassian.com → Security → API tokens.',
          label: 'API token',
          placeholder: 'ATATT…',
          confirmLabel: 'Next',
          mono: true,
        });
        if (!token?.trim()) return;
        let baseUrl = conn.baseUrl;
        if (!baseUrl.trim() || baseUrl.includes('your-domain')) {
          const asked = await this.prompts.ask({
            title: 'Jira site URL',
            message: 'Your Atlassian Cloud site, e.g. https://company.atlassian.net',
            label: 'Base URL',
            placeholder: 'https://company.atlassian.net',
            confirmLabel: 'Connect',
            mono: true,
          });
          if (!asked?.trim()) return;
          baseUrl = asked.trim();
        }
        await this.store.signInJira(email.trim(), token.trim(), baseUrl);
        return;
      }

      this.editingConnectionId.set(conn.id);
      this.updateConnection(conn.id, { enabled: true });
      this.store.showInfo('Paste your PAT below, then enable the connection.');
    } finally {
      this.connectingId.set(null);
    }
  }

  async disconnect(conn: ConnectionConfig): Promise<void> {
    await this.store.disconnectConnection(conn.id);
    if (this.editingConnectionId() === conn.id) {
      this.editingConnectionId.set(null);
    }
  }

  async testConnection(conn: ConnectionConfig): Promise<void> {
    if (this.testingId()) return;
    const kind = this.connectionKind(conn.provider);
    if (!kind) return;
    this.testingId.set(conn.id);
    try {
      const result = await this.store.testConnection({ kind, connectionId: conn.id });
      this.connectionTests.update((current) => ({ ...current, [conn.id]: result }));
    } finally {
      this.testingId.set(null);
    }
  }

  async testAllConnections(): Promise<void> {
    if (this.testingAll()) return;
    this.testingAll.set(true);
    try {
      const results = await this.store.testAllConnections();
      const next: Record<string, TestConnectionOutput> = { ...this.connectionTests() };
      for (const result of results) {
        if (result.kind === 'ssh') this.sshTest.set(result);
        if (result.connectionId && result.kind !== 'ssh' && result.kind !== 'gitRemote') {
          next[result.connectionId] = result;
        }
      }
      this.connectionTests.set(next);
    } finally {
      this.testingAll.set(false);
    }
  }

  async testSsh(): Promise<void> {
    if (this.testingSsh()) return;
    this.testingSsh.set(true);
    try {
      this.sshTest.set(
        await this.store.testConnection({
          kind: 'ssh',
          path: this.store.currentRepo()?.path ?? '',
          remote: 'origin',
        }),
      );
    } finally {
      this.testingSsh.set(false);
    }
  }

  private connectionKind(
    provider: string,
  ): 'github' | 'gitlab' | 'azureDevOps' | 'jira' | null {
    if (
      provider === 'github' ||
      provider === 'gitlab' ||
      provider === 'azureDevOps' ||
      provider === 'jira'
    ) {
      return provider;
    }
    return null;
  }

  openFeature(provider: string): void {
    if (provider === 'jira') {
      this.store.setView('jira');
      return;
    }
    if (provider === 'github' || provider === 'gitlab' || provider === 'azureDevOps') {
      this.store.setView('prs');
    }
  }

  async updateCommitType(id: string, patch: Partial<CommitTypeOption>): Promise<void> {
    const commitTypes = this.store.settings().commitTypes.map((t) => {
      if (t.id !== id) return t;
      const next = { ...t, ...patch };
      if (patch.label !== undefined) {
        next.label = patch.label.trim() || t.id;
      }
      if (patch.description !== undefined) {
        next.description = patch.description.trim();
      }
      return next;
    });
    await this.persistCommitTypes(commitTypes);
  }

  async removeCommitType(id: string): Promise<void> {
    const commitTypes = this.store.settings().commitTypes.filter((t) => t.id !== id);
    if (!commitTypes.length) {
      this.store.showWarning('Keep at least one commit type');
      return;
    }
    await this.persistCommitTypes(commitTypes);
  }

  async addCommitType(): Promise<void> {
    const id = normalizeCommitTypeId(this.newTypeId());
    if (!id) {
      this.store.showWarning('Enter a type id like feat or hotfix');
      return;
    }
    const existing = this.store.settings().commitTypes;
    if (existing.some((t) => t.id === id)) {
      this.store.showWarning(`“${id}” already exists`);
      return;
    }
    const description = this.newTypeDescription().trim();
    await this.persistCommitTypes([...existing, { id, label: id, description }]);
    this.newTypeId.set('');
    this.newTypeDescription.set('');
    this.store.showSuccess(`Added “${id}”`);
  }

  async resetCommitTypes(): Promise<void> {
    await this.persistCommitTypes(DEFAULT_COMMIT_TYPES.map((t) => ({ ...t })));
    this.store.showSuccess('Commit types reset to defaults');
  }

  async refreshEnv(): Promise<void> {
    try {
      this.gitEnv.set(await this.tauri.getGitEnv());
    } catch {
      this.gitEnv.set(null);
    }
  }

  async saveGitConfig(key: string, value: string): Promise<void> {
    try {
      this.gitEnv.set(await this.tauri.setGitConfig(key, value));
      this.store.showSuccess(`Updated ${key}`);
    } catch (err) {
      this.store.showError(err);
    }
  }

  async useIdeMergePreset(editor: IdeEditor): Promise<void> {
    const preset = mergeToolPreset(editor);
    await this.store.saveSettings({
      mergeTool: preset.mergeTool,
      preferredEditor: editor,
    });
    try {
      await this.tauri.setGitConfig('merge.tool', preset.mergeTool);
      await this.tauri.setGitConfig(`mergetool.${preset.mergeTool}.cmd`, preset.cmd);
      await this.tauri.setGitConfig(
        `mergetool.${preset.mergeTool}.trustExitCode`,
        preset.trustExitCode,
      );
      await this.refreshEnv();
      this.store.showSuccess(
        editor === 'cursor'
          ? 'Cursor set as preferred editor and Git mergetool'
          : 'VS Code set as preferred editor and Git mergetool',
      );
    } catch (err) {
      this.store.showError(err);
    }
  }

  async applyToolSettings(): Promise<void> {
    const s = this.store.settings();
    try {
      if (s.editorCommand.trim()) {
        await this.tauri.setGitConfig('core.editor', s.editorCommand.trim());
      }
      if (s.diffTool.trim()) {
        await this.tauri.setGitConfig('diff.tool', s.diffTool.trim());
      }
      if (s.mergeTool.trim()) {
        const tool = s.mergeTool.trim().toLowerCase();
        await this.tauri.setGitConfig('merge.tool', tool);
        if (tool === 'cursor' || tool === 'vscode') {
          const preset = mergeToolPreset(tool);
          await this.tauri.setGitConfig(`mergetool.${preset.mergeTool}.cmd`, preset.cmd);
          await this.tauri.setGitConfig(
            `mergetool.${preset.mergeTool}.trustExitCode`,
            preset.trustExitCode,
          );
        }
      }
      await this.refreshEnv();
      this.store.showSuccess('Applied tool settings to Git config');
    } catch (err) {
      this.store.showError(err);
    }
  }

  async checkForUpdates(): Promise<void> {
    const found = await this.updates.checkForUpdates({ silent: false });
    if (found) {
      this.store.notifyEvent(
        'updates',
        'Update available',
        `Update ${this.updates.availableVersion()} is available`,
        { kind: 'info' },
      );
      return;
    }
    if (this.updates.phase() === 'error') {
      this.store.showError(this.updates.errorMessage() ?? 'Could not check for updates');
      return;
    }
    this.store.showSuccess('You are on the latest version', undefined, 'updates');
  }

  async setCredentialHelper(value: string): Promise<void> {
    await this.saveGitConfig('credential.helper', value);
  }

  async toggleCommitSigning(enabled: boolean): Promise<void> {
    await this.saveGitConfig('commit.gpgsign', enabled ? 'true' : 'false');
  }

  async setGpgFormat(value: string): Promise<void> {
    await this.saveGitConfig('gpg.format', value);
  }

  async setSigningKey(value: string): Promise<void> {
    await this.saveGitConfig('user.signingkey', value);
  }

  onSigningKeyChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    void this.setSigningKey(value);
  }

  async reportProblem(): Promise<void> {
    try {
      const text = await this.diagnostics.copyReport();
      await navigator.clipboard.writeText(text);
      await this.tauri.openExternalUrl(
        'https://github.com/SeanGareth505/branchline/issues/new?title=Bug%20report',
      );
      this.store.showSuccess('Diagnostics copied — paste them into the GitHub issue');
    } catch (err) {
      this.store.showError(err);
    }
  }

  openPrivacy(): void {
    void this.tauri.openExternalUrl('https://seangareth505.github.io/branchline/privacy.html');
  }

  openLicense(): void {
    void this.tauri.openExternalUrl('https://github.com/SeanGareth505/branchline/blob/main/LICENSE');
  }

  openSource(): void {
    void this.tauri.openExternalUrl('https://github.com/SeanGareth505/branchline');
  }

  private async persistCommitTypes(commitTypes: CommitTypeOption[]): Promise<void> {
    this.savingTypes.set(true);
    try {
      await this.store.saveSettings({ commitTypes });
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.savingTypes.set(false);
    }
  }
}
