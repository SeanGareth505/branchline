import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore, type SettingsSection } from '../../../core/app.store';
import { DEFAULT_COMMIT_TYPES, normalizeCommitTypeId } from '../../../core/commit-types';
import { TauriService } from '../../../core/tauri.service';
import type {
  CommitTypeOption,
  ConnectionConfig,
  DefaultPullAction,
  DefaultPushAction,
  GitEnvSnapshot,
} from '../../../core/models';
import { Dashboard } from '../../../layout/dashboard/dashboard';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { UpdateService } from '../../../core/update.service';

@Component({
  selector: 'app-settings-page',
  imports: [FormsModule, NgIcon, Dashboard],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.scss',
})
export class SettingsPage implements OnInit {
  readonly store = inject(AppStore);
  readonly updates = inject(UpdateService);
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

  readonly sections: { id: SettingsSection; label: string; hint: string }[] = [
    { id: 'repos', label: 'Repos', hint: 'Open, clone, and manage local repositories' },
    { id: 'appearance', label: 'Appearance', hint: 'Theme, accent, and UI modes' },
    { id: 'git', label: 'Git', hint: 'Identity, pull/push, safety, commit types' },
    {
      id: 'notifications',
      label: 'Notifications',
      hint: 'Toasts, desktop alerts, Git and pull request events',
    },
    { id: 'connections', label: 'Connections', hint: 'Link GitHub, GitLab, Azure DevOps, and Jira' },
    { id: 'ssh', label: 'SSH', hint: 'Keys and credential helper' },
    { id: 'tools', label: 'Tools', hint: 'Editor, diff, and merge tools' },
    { id: 'about', label: 'About', hint: 'Version and updates' },
  ];

  readonly sectionMeta = computed(
    () => this.sections.find((s) => s.id === this.section()) ?? this.sections[0],
  );

  readonly linkedCount = computed(
    () => this.store.settings().connections.filter((c) => this.store.isConnectionLinked(c)).length,
  );

  constructor() {
    effect(() => {
      const next = this.store.settingsSection();
      this.section.set(next);
    });
    effect(() => {
      const focus = this.store.settingsFocusConnectionId();
      if (!focus) return;
      this.section.set('connections');
      this.editingConnectionId.set(focus);
      this.store.clearSettingsFocusConnection();
    });
  }

  async ngOnInit(): Promise<void> {
    await this.refreshEnv();
    const id = this.store.identity();
    this.identityName.set(id?.name ?? '');
    this.identityEmail.set(id?.email ?? '');
  }

  setSection(section: SettingsSection): void {
    this.section.set(section);
    this.store.setSettingsSection(section);
  }

  setTheme(theme: string): void {
    void this.store.saveSettings({ theme });
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
        return 'Repo picker, clone from host, pull requests';
      case 'gitlab':
        return 'Repo picker, clone from host, pull requests';
      case 'azureDevOps':
        return 'Pull requests (repo listing coming soon)';
      case 'jira':
        return 'Issues panel, branch from ticket, commit keys';
      default:
        return '';
    }
  }

  editConnection(id: string): void {
    this.editingConnectionId.set(this.editingConnectionId() === id ? null : id);
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
        await this.tauri.setGitConfig('merge.tool', s.mergeTool.trim());
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
