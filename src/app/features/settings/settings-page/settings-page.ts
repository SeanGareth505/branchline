import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore, normalizeSettingsSection, type SettingsSection } from '../../../core/app.store';
import { DEFAULT_COMMIT_TYPES, normalizeCommitTypeId } from '../../../core/commit-types';
import { TauriService } from '../../../core/tauri.service';
import type {
  AppSettings,
  CommitTypeOption,
  DefaultPullAction,
  DefaultPushAction,
  GitEnvSnapshot,
} from '../../../core/models';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { Dashboard } from '../../../layout/dashboard/dashboard';
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
import { HelpPage } from '../../help/help-page/help-page';
import { ConnectionsPanel } from '../connections-panel/connections-panel';

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
  imports: [FormsModule, HelpTip, Dashboard, TicketFromBranch, ConnectionsPanel, HelpPage],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage implements OnInit {
  readonly store = inject(AppStore);
  readonly updates = inject(UpdateService);
  readonly diagnostics = inject(DiagnosticsService);
  private readonly tauri = inject(TauriService);

  readonly section = signal<SettingsSection>('repos');
  readonly gitEnv = signal<GitEnvSnapshot | null>(null);
  readonly identityName = signal('');
  readonly identityEmail = signal('');
  readonly newTypeId = signal('');
  readonly newTypeDescription = signal('');
  readonly savingTypes = signal(false);
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
      help: 'GitHub accounts for fetch, push, and pull requests. Jira, SSH keys, and credentials.',
    },
    {
      id: 'help',
      label: 'Help',
      hint: 'Guide to Branchline features and workflows',
      help: 'Full reference for navigation, Git workflows, connections, and keyboard shortcuts.',
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

  constructor() {
    effect(() => {
      this.section.set(normalizeSettingsSection(this.store.settingsSection()));
    });
    effect(() => {
      const focus = this.store.settingsFocusConnectionId();
      if (!focus) return;
      this.section.set('connections');
      if (focus === 'ssh' || focus === 'github-git') {
        const id = focus === 'ssh' ? 'settings-ssh' : 'settings-github-git';
        queueMicrotask(() =>
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        );
        this.store.clearSettingsFocusConnection();
      }
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

  async saveIdentity(): Promise<void> {
    try {
      await this.tauri.setGitIdentity(this.identityName().trim(), this.identityEmail().trim());
      await this.store.refreshIdentity();
      this.store.showSuccess('Git identity saved');
    } catch (err) {
      this.store.showError(err);
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
    } catch (err) {
      this.gitEnv.set(null);
      this.store.showError(err);
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
