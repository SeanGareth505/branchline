import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { ConnectionConfig, GitEnvSnapshot, TestConnectionOutput } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { GitAccountBar } from '../../remotes/git-account-bar/git-account-bar';

type AccessState = 'ready' | 'missing' | 'token-off';

interface AccessRow {
  id: string;
  label: string;
  state: AccessState;
  detail: string;
}

@Component({
  selector: 'app-connections-panel',
  imports: [FormsModule, NgIcon, GitAccountBar],
  templateUrl: './connections-panel.html',
  styleUrl: './connections-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionsPanel implements OnInit {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);
  private readonly prompts = inject(PromptService);

  readonly gitEnv = signal<GitEnvSnapshot | null>(null);
  readonly editingConnectionId = signal<string | null>(null);
  readonly showTokens = signal(false);
  readonly connectingId = signal<string | null>(null);
  readonly testingId = signal<string | null>(null);
  readonly testingAll = signal(false);
  readonly testingSsh = signal(false);
  readonly connectionTests = signal<Record<string, TestConnectionOutput>>({});
  readonly sshTest = signal<TestConnectionOutput | null>(null);

  readonly githubConn = computed(
    () => this.store.settings().connections.find((c) => c.provider === 'github') ?? null,
  );
  readonly otherConns = computed(() =>
    this.store.settings().connections.filter((c) => c.provider !== 'github'),
  );
  readonly githubAccounts = computed(() => this.store.githubGitStatus()?.accounts ?? []);
  readonly githubActiveLogin = computed(() => this.store.githubGitStatus()?.activeLogin ?? '');
  readonly ghAvailable = computed(() => !!this.store.githubGitStatus()?.ghAvailable);

  readonly githubGitReady = computed(() => this.store.hasGithubCliLogin());
  readonly githubPrReady = computed(() => this.store.hasGithubApiAccess());
  readonly githubPatLinked = computed(() => {
    const conn = this.githubConn();
    return !!conn && this.store.isConnectionLinked(conn);
  });
  readonly githubTokenSavedOff = computed(() => {
    const conn = this.githubConn();
    if (!conn || conn.enabled) return false;
    return !!(conn.hasToken || conn.token.trim());
  });

  readonly githubStatus = computed(() => {
    if (this.githubGitReady() && this.githubPrReady()) return 'Connected';
    if (this.githubGitReady()) return 'Git ready';
    if (this.githubPrReady()) return 'API ready';
    if (this.githubTokenSavedOff()) return 'Token saved';
    return 'Not set up';
  });

  readonly githubAccess = computed((): AccessRow[] => {
    const accounts = this.githubAccounts().filter((account) => account.ok);
    const active = this.githubActiveLogin();
    const patUser = this.githubConn()?.username.trim() ?? '';
    const gitDetail = accounts.length
      ? active
        ? `HTTPS fetch and push use ${active}${
            accounts.length > 1 ? ` (${accounts.length} accounts)` : ''
          }.`
        : `${accounts.length} GitHub CLI account${accounts.length === 1 ? '' : 's'} ready.`
      : this.ghAvailable()
        ? 'Add a GitHub account to fetch and push over HTTPS. SSH can still use keys below.'
        : 'Install GitHub CLI, then add an account — or use SSH keys below.';

    let prState: AccessState = 'missing';
    let prDetail =
      'Pull requests need a GitHub login. Add an account (uses GitHub CLI) or paste a PAT with repo scope.';
    if (this.githubPatLinked()) {
      prState = 'ready';
      prDetail = patUser
        ? `Ready as ${patUser}. Branchline is using the saved GitHub token.`
        : 'Ready. Branchline is using the saved GitHub token.';
    } else if (this.githubTokenSavedOff()) {
      prState = 'token-off';
      prDetail = 'A token is saved but GitHub API is off. Turn it on to load pull requests.';
    } else if (this.githubGitReady()) {
      prState = 'ready';
      prDetail = active
        ? `Ready via GitHub CLI as ${active}. Same login as fetch and push.`
        : 'Ready via GitHub CLI. Same accounts as fetch and push.';
    }

    const cloneDetail =
      prState === 'ready'
        ? 'Ready. The project menu can list and clone GitHub repos.'
        : 'Repo picker and clone-from-host use the same GitHub access as pull requests.';

    return [
      {
        id: 'git',
        label: 'Fetch & push',
        state: this.githubGitReady() ? 'ready' : 'missing',
        detail: gitDetail,
      },
      {
        id: 'prs',
        label: 'Pull requests',
        state: prState,
        detail: prDetail,
      },
      {
        id: 'clone',
        label: 'Repo picker & clone',
        state: prState === 'token-off' ? 'token-off' : prState === 'ready' ? 'ready' : 'missing',
        detail: cloneDetail,
      },
    ];
  });

  constructor() {
    effect(() => {
      const focus = this.store.settingsFocusConnectionId();
      if (!focus || focus === 'ssh' || focus === 'github-git') return;
      this.editingConnectionId.set(focus);
      this.store.clearSettingsFocusConnection();
    });
  }

  async ngOnInit(): Promise<void> {
    await this.refreshEnv();
    void this.store.refreshGithubGitStatus();
  }

  connectionStatus(conn: ConnectionConfig): string {
    if (this.store.isConnectionLinked(conn)) return 'Connected';
    if (conn.hasToken || conn.token.trim()) return 'Token saved';
    if (!conn.enabled) return 'Off';
    return 'Needs token';
  }

  connectionUses(provider: string): string {
    switch (provider) {
      case 'gitlab':
        return 'Merge requests and clone from GitLab need a token. Git fetch/push still uses SSH or HTTPS credentials.';
      case 'azureDevOps':
        return 'Pull requests open in the browser until a PAT is added.';
      case 'jira':
        return 'Issues panel, branch from ticket, and commit keys.';
      default:
        return '';
    }
  }

  providerHint(provider: string): string {
    switch (provider) {
      case 'github':
        return 'Optional. Use this when an org requires a Branchline GitHub App approval, or you want a PAT instead of GitHub CLI.';
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

  glyph(provider: string): string {
    switch (provider) {
      case 'github':
        return 'lucideGitPullRequest';
      case 'gitlab':
        return 'lucideGitBranch';
      case 'azureDevOps':
        return 'lucideCloud';
      case 'jira':
        return 'lucideTicket';
      default:
        return 'lucideLink';
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
        if (next.hasToken) next.enabled = true;
      }
      return next;
    });
    void this.store.saveSettings({ connections });
  }

  enableConnection(conn: ConnectionConfig): void {
    this.updateConnection(conn.id, { enabled: true });
    void this.testConnection({ ...conn, enabled: true });
  }

  async connect(conn: ConnectionConfig): Promise<void> {
    this.connectingId.set(conn.id);
    try {
      if (conn.provider === 'github') {
        const token = conn.token.trim();
        if (token || conn.hasToken) {
          if (token) {
            await this.store.signInGitHost('github', token, conn.username);
          } else {
            this.updateConnection(conn.id, { enabled: true });
          }
          return;
        }
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

  addGithubAccount(): void {
    void this.store.addGithubCliAccount();
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

  openFeature(provider: string): void {
    if (provider === 'jira') {
      this.store.setView('jira');
      return;
    }
    if (provider === 'github' || provider === 'gitlab' || provider === 'azureDevOps') {
      this.store.setView('prs');
    }
  }

  setSshClient(sshClient: string): void {
    void this.store.saveSettings({ sshClient });
  }

  async setCredentialHelper(value: string): Promise<void> {
    try {
      this.gitEnv.set(await this.tauri.setGitConfig('credential.helper', value));
      this.store.showSuccess(value ? `Credential helper: ${value}` : 'Cleared credential helper');
    } catch (err) {
      this.store.showError(err);
    }
  }

  async refreshEnv(): Promise<void> {
    try {
      this.gitEnv.set(await this.tauri.getGitEnv());
    } catch (err) {
      this.gitEnv.set(null);
      this.store.showError(err);
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
}
