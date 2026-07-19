import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { formatDistanceToNowStrict } from 'date-fns';
import { AppStore } from '../../../core/app.store';
import type { JiraIssue, JiraTransition } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';

@Component({
  selector: 'app-jira-panel',
  imports: [FormsModule, NgIcon, LoadingBlock],
  templateUrl: './jira-panel.html',
  styleUrl: './jira-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class JiraPanel {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);

  readonly query = signal('');
  readonly status = signal('all');
  readonly type = signal('all');
  readonly assignee = signal('all');
  readonly priority = signal('all');
  readonly mineOnly = signal(false);
  readonly jql = signal('assignee = currentUser() ORDER BY updated DESC');
  readonly transitionKey = signal<string | null>(null);
  readonly transitions = signal<JiraTransition[]>([]);
  readonly transitionsLoading = signal(false);

  readonly showingDummy = computed(() => !this.store.hasLinkedJira());
  readonly issues = computed(() => this.store.jiraIssues());
  readonly loading = computed(() => this.store.jiraIssuesLoading());
  readonly error = computed(() => this.store.jiraIssuesError());

  readonly connectionLabel = computed(() => {
    if (this.showingDummy()) {
      return 'DUMMY DATA — sample issues for UI preview. Sign in below or link Jira under Settings → Connections.';
    }
    const jira = this.store
      .settings()
      .connections.find(
        (c) => c.provider === 'jira' && c.enabled && (c.hasToken || c.token.trim()),
      );
    return `Linked to ${jira?.baseUrl || 'Jira'} as ${jira?.username || 'user'}.`;
  });

  readonly statuses = computed(() => this.unique((i) => i.status));
  readonly types = computed(() => this.unique((i) => i.issueType));
  readonly assignees = computed(() => this.unique((i) => i.assignee));
  readonly priorities = computed(() => this.unique((i) => i.priority));

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.issues().filter((issue) => {
      if (this.mineOnly()) {
        const email = this.jiraEmail().toLowerCase();
        const local = email.split('@')[0] || '';
        const a = issue.assignee.toLowerCase();
        const mine =
          a === 'you' ||
          a === 'me' ||
          (local && (a.includes(local) || a.includes(email)));
        if (!mine) return false;
      }
      if (this.status() !== 'all' && issue.status !== this.status()) return false;
      if (this.type() !== 'all' && issue.issueType !== this.type()) return false;
      if (this.assignee() !== 'all' && issue.assignee !== this.assignee()) return false;
      if (this.priority() !== 'all' && issue.priority !== this.priority()) return false;
      if (!q) return true;
      const hay = [issue.key, issue.summary, issue.status, issue.assignee, issue.issueType, ...issue.labels]
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  });

  readonly stats = computed(() => {
    const all = this.filtered();
    return {
      total: all.length,
      inProgress: all.filter((i) => /progress|doing|development/i.test(i.status)).length,
      todo: all.filter((i) => /to\s*do|open|backlog|ready/i.test(i.status)).length,
      done: all.filter((i) => /done|resolved|closed|complete/i.test(i.status)).length,
    };
  });

  constructor() {
    effect(() => {
      this.store.settings();
      void this.store.refreshJiraIssues(this.showingDummy() ? undefined : this.jql());
    });
  }

  async reload(): Promise<void> {
    await this.store.refreshJiraIssues(this.showingDummy() ? undefined : this.jql());
  }

  async signIn(): Promise<void> {
    const existing = this.store.settings().connections.find((c) => c.provider === 'jira');
    const email = await this.prompts.ask({
      title: 'Sign in to Jira',
      message: 'Atlassian account email for API token auth.',
      label: 'Email',
      placeholder: 'you@company.com',
      confirmLabel: 'Next',
      initialValue: existing?.username ?? '',
    });
    if (!email?.trim()) return;
    const token = await this.prompts.ask({
      title: 'Jira API token',
      message: 'Create a token at id.atlassian.com → Security → API tokens.',
      label: 'API token',
      placeholder: 'ATATT…',
      confirmLabel: 'Sign in',
      mono: true,
    });
    if (!token?.trim()) return;
    let baseUrl = existing?.baseUrl ?? '';
    if (!baseUrl || baseUrl.includes('your-domain')) {
      const asked = await this.prompts.ask({
        title: 'Jira site URL',
        message: 'Your Atlassian Cloud site, e.g. https://company.atlassian.net',
        label: 'Base URL',
        placeholder: 'https://company.atlassian.net',
        confirmLabel: 'Continue',
        mono: true,
        initialValue: baseUrl.includes('your-domain') ? '' : baseUrl,
      });
      if (!asked?.trim()) return;
      baseUrl = asked.trim();
    }
    await this.store.signInJira(email.trim(), token.trim(), baseUrl);
  }

  goSettings(): void {
    this.store.openSettings('connections', 'jira');
  }

  openBrowser(issue: JiraIssue): void {
    if (!issue.url) {
      this.store.showWarning('No URL for this issue');
      return;
    }
    window.open(issue.url, '_blank', 'noopener');
  }

  async copyKey(issue: JiraIssue): Promise<void> {
    try {
      await navigator.clipboard.writeText(issue.key);
      this.store.showSuccess(`Copied ${issue.key}`);
    } catch {
      this.store.showError('Could not copy');
    }
  }

  async copyCommitLine(issue: JiraIssue): Promise<void> {
    const line = `${issue.key} ${issue.summary}`;
    try {
      await navigator.clipboard.writeText(line);
      this.store.showSuccess('Copied commit subject');
    } catch {
      this.store.showError('Could not copy');
    }
  }

  useForCommit(issue: JiraIssue): void {
    this.store.setActiveJiraKey(issue.key);
    this.store.showSuccess(`${issue.key} set for commit templates`);
    if (this.store.changeCount() > 0) {
      this.store.commitModalOpen.set(true);
    }
  }

  startWork(issue: JiraIssue): void {
    if (!this.store.currentRepo()) {
      this.store.showWarning('Open a repository first');
      return;
    }
    this.store.startWorkFromIssue(issue);
  }

  async openTransitions(issue: JiraIssue): Promise<void> {
    if (this.transitionKey() === issue.key) {
      this.transitionKey.set(null);
      this.transitions.set([]);
      return;
    }
    this.transitionKey.set(issue.key);
    this.transitionsLoading.set(true);
    try {
      if (this.showingDummy()) {
        this.transitions.set([
          { id: '11', name: 'Start Progress', toStatus: 'In Progress' },
          { id: '21', name: 'Resolve Issue', toStatus: 'Done' },
          { id: '31', name: 'Stop Progress', toStatus: 'To Do' },
        ]);
      } else {
        this.transitions.set(await this.tauri.listJiraTransitions(issue.key));
      }
    } catch (err) {
      this.transitions.set([]);
      this.store.showError(err);
    } finally {
      this.transitionsLoading.set(false);
    }
  }

  async applyTransition(issue: JiraIssue, transition: JiraTransition): Promise<void> {
    if (this.showingDummy()) {
      this.store.jiraIssues.update((list) =>
        list.map((i) =>
          i.key === issue.key
            ? { ...i, status: transition.toStatus || transition.name, updatedAt: new Date().toISOString() }
            : i,
        ),
      );
      this.store.showSuccess(`DUMMY: ${issue.key} → ${transition.toStatus || transition.name}`);
      this.transitionKey.set(null);
      this.transitions.set([]);
      return;
    }
    const ok = await this.store.transitionJiraIssue(issue.key, transition.id);
    if (ok) {
      this.transitionKey.set(null);
      this.transitions.set([]);
    }
  }

  time(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return formatDistanceToNowStrict(date, { addSuffix: true });
  }

  private jiraEmail(): string {
    return (
      this.store
        .settings()
        .connections.find((c) => c.provider === 'jira')
        ?.username.trim() ?? ''
    );
  }

  private unique(pick: (i: JiraIssue) => string): string[] {
    return [...new Set(this.issues().map(pick).filter(Boolean))].sort();
  }
}
