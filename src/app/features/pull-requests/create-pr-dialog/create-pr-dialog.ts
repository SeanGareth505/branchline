import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { CommitInfo, PrCreateMethod, RepoPrTemplate, SavedPrTemplate } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { Spinner } from '../../../shared/ui/spinner/spinner';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { branchLeafName, isMainlineBranch } from '../../../shared/git/mainline-branch';
import { defaultPrTitle, fallbackPrTitle } from '../../../shared/git/pr-title';
import {
  defaultPrDescription,
  fallbackPrDescription,
} from '../../../shared/git/pr-description';
import { extractTicketFromBranch } from '../../../shared/git/ticket-from-branch';
import {
  PR_TEMPLATE_TOKENS,
  STARTER_PR_TEMPLATE_BODY,
  STARTER_PR_TEMPLATE_TITLE,
  buildPrTemplateContext,
  emptyPrTemplateContext,
  fillPrTemplate,
  insertAtCaret,
  type PrTemplateContext,
} from '../../../shared/git/pr-template';

@Component({
  selector: 'app-create-pr-dialog',
  imports: [FormsModule, NgIcon, Spinner, HelpTip],
  templateUrl: './create-pr-dialog.html',
  styleUrl: './create-pr-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreatePrDialog {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);
  private readonly prompts = inject(PromptService);
  private primed = false;
  private rawTitle = '';
  private rawBody = '';
  private titleTouched = false;
  private bodyTouched = false;
  private draftToken = 0;
  private lastCommits: CommitInfo[] = [];

  readonly title = signal('');
  readonly body = signal('');
  readonly head = signal('');
  readonly base = signal('');
  readonly draft = signal(false);
  readonly method = signal<PrCreateMethod>('browser');
  readonly selectedId = signal('blank');
  readonly repoTemplates = signal<RepoPrTemplate[]>([]);
  readonly loadingTemplates = signal(false);
  readonly busy = signal(false);
  readonly composing = signal(false);
  readonly draftId = signal<string | null>(null);
  readonly draftName = signal('');
  readonly draftTitle = signal('');
  readonly draftBody = signal('');
  readonly insertTarget = signal<'title' | 'body'>('body');
  readonly fillContext = signal<PrTemplateContext>(emptyPrTemplateContext());
  readonly tokens = PR_TEMPLATE_TOKENS;
  readonly tokenSample = '{jira}';
  readonly templateHelp =
    'Saved templates can use tokens like {jira}, {branch}, {first_commit}, and {commits}. Repo templates also replace KEY-123 with the ticket from this branch. New starts a reusable template; Save current snapshots what you see now.';

  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');
  private readonly bodyInput = viewChild<ElementRef<HTMLTextAreaElement>>('bodyInput');
  private readonly draftTitleInput = viewChild<ElementRef<HTMLInputElement>>('draftTitleInput');
  private readonly draftBodyInput = viewChild<ElementRef<HTMLTextAreaElement>>('draftBodyInput');

  readonly savedTemplates = computed(() => this.store.settings().prTemplates);
  readonly hostReady = computed(() => this.store.hasLinkedPrHost());
  readonly insertChips = computed(() => {
    const ctx = this.fillContext() as unknown as Record<string, string>;
    return PR_TEMPLATE_TOKENS.map((token) => ({
      ...token,
      value: ctx[token.token.slice(1, -1)] ?? '',
    }));
  });

  readonly branchOptions = computed(() => {
    const locals = this.store.localBranches().map((b) => b.name);
    const remotes = this.store
      .remoteBranches()
      .map((b) => branchLeafName(b.name))
      .filter((name) => !!name && !locals.includes(name));
    return [...new Set([...locals, ...remotes])];
  });

  readonly canSubmit = computed(() => {
    if (this.composing()) return false;
    const title = this.title().trim();
    const head = this.head().trim();
    const base = this.base().trim();
    return !!title && !!head && !!base && head !== base && !this.busy();
  });

  readonly submitLabel = computed(() => {
    if (this.busy()) {
      return this.method() === 'browser' ? 'Opening…' : 'Creating…';
    }
    return this.method() === 'browser' ? 'Open in browser' : 'Create pull request';
  });

  constructor() {
    effect(() => {
      const open = this.store.createPrDialogOpen();
      if (!open) {
        this.primed = false;
        return;
      }
      if (this.primed) return;
      this.primed = true;
      const status = this.store.status();
      const branch = status?.branch ?? '';
      const preferred = this.store.createPrPreferredHead()?.trim();
      const head = preferred || branch;
      const base = this.defaultBase(head);
      this.titleTouched = false;
      this.bodyTouched = false;
      this.composing.set(false);
      this.body.set('');
      this.head.set(head);
      this.base.set(base);
      this.draft.set(false);
      this.method.set(this.store.settings().prCreateMethod);
      this.busy.set(false);
      this.lastCommits = [];
      const pending = this.store.pendingPrTemplate();
      if (pending) {
        this.store.pendingPrTemplate.set(null);
        this.selectedId.set('starter');
        this.rawTitle = pending.title;
        this.rawBody = pending.body;
      } else {
        this.selectedId.set('blank');
        this.rawTitle = '';
        this.rawBody = '';
      }
      this.title.set(fallbackPrTitle(head));
      void this.loadRepoTemplates();
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeCreatePrDialog();
  }

  selectTemplate(id: string): void {
    if (this.composing()) return;
    this.selectedId.set(id);
    this.titleTouched = false;
    this.bodyTouched = false;
    this.bindRawFromId(id);
    void this.refreshDraft();
  }

  onHeadChange(value: string): void {
    this.head.set(value);
    void this.refreshDraft();
  }

  onBaseChange(value: string): void {
    this.base.set(value);
    void this.refreshDraft();
  }

  onTitleChange(value: string): void {
    this.titleTouched = true;
    this.title.set(value);
  }

  onBodyChange(value: string): void {
    this.bodyTouched = true;
    this.body.set(value);
  }

  startNewTemplate(): void {
    this.composing.set(true);
    this.draftId.set(null);
    this.draftName.set('');
    this.draftTitle.set(STARTER_PR_TEMPLATE_TITLE);
    this.draftBody.set(STARTER_PR_TEMPLATE_BODY);
    this.insertTarget.set('body');
  }

  editSaved(template: SavedPrTemplate, event: Event): void {
    event.stopPropagation();
    this.composing.set(true);
    this.draftId.set(template.id);
    this.draftName.set(template.name);
    this.draftTitle.set(template.title.trim() || STARTER_PR_TEMPLATE_TITLE);
    this.draftBody.set(template.body);
    this.insertTarget.set('body');
  }

  cancelCompose(): void {
    this.composing.set(false);
  }

  async saveDraftTemplate(): Promise<void> {
    const name = this.draftName().trim();
    if (!name) {
      this.store.showWarning('Name the template before saving');
      return;
    }
    const id = await this.store.savePrTemplate({
      id: this.draftId() ?? undefined,
      name,
      title: this.draftTitle(),
      body: this.draftBody(),
    });
    if (!id) return;
    this.composing.set(false);
    this.selectedId.set(id);
    this.titleTouched = false;
    this.bodyTouched = false;
    this.bindRawFromId(id);
    void this.refreshDraft();
  }

  async saveCurrentTemplate(): Promise<void> {
    const name = await this.prompts.ask({
      title: 'Save pull request template',
      message: 'Saves this title and body. Use {jira}, {branch}, {first_commit} and other tokens if you want them filled next time.',
      label: 'Template name',
      placeholder: 'Bugfix',
      confirmLabel: 'Save',
    });
    if (!name?.trim()) return;
    const id = await this.store.savePrTemplate({
      name: name.trim(),
      title: this.title(),
      body: this.body(),
    });
    if (id) this.selectedId.set(id);
  }

  async removeSaved(template: SavedPrTemplate, event: Event): Promise<void> {
    event.stopPropagation();
    await this.store.deletePrTemplate(template.id);
    if (this.selectedId() === template.id) this.selectTemplate('blank');
  }

  insertToken(token: string): void {
    if (this.composing()) {
      if (this.insertTarget() === 'title') {
        this.replaceField('draftTitle', this.draftTitleInput()?.nativeElement, token, this.draftTitle());
      } else {
        this.replaceField('draftBody', this.draftBodyInput()?.nativeElement, token, this.draftBody());
      }
      return;
    }
    const chips = this.insertChips();
    const chip = chips.find((item) => item.token === token);
    const value = chip?.value || token;
    if (this.insertTarget() === 'title') {
      this.titleTouched = true;
      this.replaceField('title', this.titleInput()?.nativeElement, value, this.title());
    } else {
      this.bodyTouched = true;
      this.replaceField('body', this.bodyInput()?.nativeElement, value, this.body());
    }
  }

  markInsertTarget(target: 'title' | 'body'): void {
    this.insertTarget.set(target);
  }

  setMethod(method: PrCreateMethod): void {
    this.method.set(method);
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    try {
      await this.store.submitCreatePullRequest({
        title: this.title(),
        body: this.body(),
        head: this.head(),
        base: this.base(),
        draft: this.draft(),
        method: this.method(),
      });
    } finally {
      this.busy.set(false);
    }
  }

  private replaceField(
    field: 'title' | 'body' | 'draftTitle' | 'draftBody',
    el: HTMLInputElement | HTMLTextAreaElement | undefined,
    insert: string,
    current: string,
  ): void {
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const { next, caret } = insertAtCaret(current, insert, start, end);
    if (field === 'title') this.title.set(next);
    else if (field === 'body') this.body.set(next);
    else if (field === 'draftTitle') this.draftTitle.set(next);
    else this.draftBody.set(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  private bindRawFromId(id: string): void {
    if (id === 'blank') {
      this.rawTitle = '';
      this.rawBody = '';
      return;
    }
    if (id === 'starter') {
      this.rawTitle = STARTER_PR_TEMPLATE_TITLE;
      this.rawBody = STARTER_PR_TEMPLATE_BODY;
      return;
    }
    const repo = this.repoTemplates().find((t) => t.id === id);
    if (repo) {
      this.rawTitle = '';
      this.rawBody = repo.body;
      return;
    }
    const saved = this.savedTemplates().find((t) => t.id === id);
    this.rawTitle = saved?.title ?? '';
    this.rawBody = saved?.body ?? '';
  }

  private applyFill(commits: CommitInfo[]): void {
    const head = this.head().trim();
    const base = this.base().trim();
    const suggested = commits.length ? defaultPrTitle(commits, head) : fallbackPrTitle(head);
    if (!this.titleTouched) {
      const raw = this.rawTitle.trim();
      const ctx = this.makeContext(commits, suggested);
      this.title.set(raw ? fillPrTemplate(raw, ctx).trim() || suggested : suggested);
    }
    const ctx = this.makeContext(commits, this.title());
    this.fillContext.set(ctx);
    if (this.bodyTouched) return;
    if (this.selectedId() === 'blank' && !this.rawBody.trim()) {
      this.body.set(
        commits.length ? defaultPrDescription(commits, head, base) : fallbackPrDescription(head, base),
      );
      return;
    }
    this.body.set(fillPrTemplate(this.rawBody, ctx));
  }

  private makeContext(commits: CommitInfo[], title: string): PrTemplateContext {
    const head = this.head().trim();
    const fromBranch =
      extractTicketFromBranch(head, this.store.settings().ticketFromBranch)?.trim() || '';
    const current = this.store.status()?.branch?.trim() || '';
    const ticket =
      fromBranch || (head === current ? this.store.activeJiraKey()?.trim() || '' : '');
    const issue = this.store
      .jiraIssues()
      .find((item) => item.key.toLowerCase() === ticket.toLowerCase());
    const identity = this.store.identity();
    return buildPrTemplateContext({
      head,
      base: this.base().trim(),
      title,
      ticket,
      ticketUrl: issue?.url?.trim() || this.store.jiraBrowseUrl(ticket) || '',
      ticketSummary: issue?.summary ?? '',
      commitsNewestFirst: commits,
      author: identity?.name,
      email: identity?.email,
      repo: this.store.currentRepo()?.name,
    });
  }

  private async refreshDraft(): Promise<void> {
    const head = this.head().trim();
    const base = this.base().trim();
    if (!this.titleTouched) {
      this.title.set(fallbackPrTitle(head));
    }
    this.applyFill(this.lastCommits);
    const path = this.store.currentRepo()?.path;
    if (!path || !head || !base || head === base) return;
    const token = ++this.draftToken;
    try {
      const commits = await this.tauri.getCommitRange(path, base, head, 100);
      if (token !== this.draftToken) return;
      this.lastCommits = commits;
      this.applyFill(commits);
    } catch {
      if (token !== this.draftToken) return;
      this.lastCommits = [];
      this.applyFill([]);
    }
  }

  private defaultBase(head: string): string {
    const status = this.store.status();
    if (status?.upstream) {
      const leaf = branchLeafName(status.upstream);
      if (leaf && leaf !== head) return leaf;
    }
    const mainline = this.store
      .localBranches()
      .find((b) => isMainlineBranch(b.name) && b.name !== head);
    return mainline?.name ?? (head === 'main' ? 'master' : 'main');
  }

  private async loadRepoTemplates(): Promise<void> {
    const path = this.store.currentRepo()?.path;
    if (!path) {
      this.repoTemplates.set([]);
      await this.refreshDraft();
      return;
    }
    this.loadingTemplates.set(true);
    try {
      const templates = await this.tauri.listPrTemplates(path);
      this.repoTemplates.set(templates);
      if (this.selectedId() === 'blank' && !this.bodyTouched && !this.rawBody.trim()) {
        const auto = templates.find((t) => t.name === 'Repo default') ?? templates[0];
        if (auto) {
          this.selectedId.set(auto.id);
          this.bindRawFromId(auto.id);
        }
      }
      await this.refreshDraft();
    } catch {
      this.repoTemplates.set([]);
      await this.refreshDraft();
    } finally {
      this.loadingTemplates.set(false);
    }
  }
}
