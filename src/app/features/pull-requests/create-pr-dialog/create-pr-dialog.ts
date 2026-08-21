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
import { branchLeafName, isMainlineBranch } from '../../../shared/git/mainline-branch';
import { defaultPrTitle, fallbackPrTitle } from '../../../shared/git/pr-title';
import {
  defaultPrDescription,
  fallbackPrDescription,
} from '../../../shared/git/pr-description';
import {
  PR_TEMPLATE_TOKENS,
  STARTER_PR_TEMPLATE_BODY,
  STARTER_PR_TEMPLATE_TITLE,
  buildPrTemplateContext,
  fillPrTemplate,
  insertAtCaret,
} from '../../../shared/git/pr-template';

@Component({
  selector: 'app-create-pr-dialog',
  imports: [FormsModule, NgIcon, Spinner],
  templateUrl: './create-pr-dialog.html',
  styleUrl: './create-pr-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreatePrDialog {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);
  private readonly prompts = inject(PromptService);
  private primed = false;

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
  readonly tokens = PR_TEMPLATE_TOKENS;
  private readonly bodyField = viewChild<ElementRef<HTMLTextAreaElement>>('bodyField');
  private titleTouched = false;
  private bodyTouched = false;
  private draftToken = 0;

  readonly savedTemplates = computed(() => this.store.settings().prTemplates);
  readonly hostReady = computed(() => this.store.hasLinkedPrHost());

  readonly branchOptions = computed(() => {
    const locals = this.store.localBranches().map((b) => b.name);
    const remotes = this.store
      .remoteBranches()
      .map((b) => branchLeafName(b.name))
      .filter((name) => !!name && !locals.includes(name));
    return [...new Set([...locals, ...remotes])];
  });

  readonly canSubmit = computed(() => {
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
      this.body.set('');
      this.head.set(head);
      this.base.set(base);
      this.draft.set(false);
      this.method.set(this.store.settings().prCreateMethod);
      this.selectedId.set('blank');
      this.busy.set(false);
      this.title.set(fallbackPrTitle(head));
      void this.loadRepoTemplates();
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeCreatePrDialog();
  }

  selectTemplate(id: string): void {
    this.selectedId.set(id);
    if (id === 'blank') {
      this.bodyTouched = false;
      void this.refreshDraft();
      return;
    }
    const repo = this.repoTemplates().find((t) => t.id === id);
    if (repo) {
      void this.applyFilled(this.title(), repo.body);
      return;
    }
    const saved = this.savedTemplates().find((t) => t.id === id);
    if (saved) {
      void this.applyFilled(saved.title, saved.body);
    }
  }

  startNewTemplate(): void {
    this.selectedId.set('new');
    this.titleTouched = false;
    this.bodyTouched = false;
    this.title.set(STARTER_PR_TEMPLATE_TITLE);
    this.body.set(STARTER_PR_TEMPLATE_BODY);
  }

  insertToken(token: string): void {
    const field = this.bodyField()?.nativeElement;
    const applied = insertAtCaret(this.body(), token, field?.selectionStart, field?.selectionEnd);
    this.bodyTouched = true;
    this.body.set(applied.next);
    queueMicrotask(() => {
      const next = this.bodyField()?.nativeElement;
      if (!next) return;
      next.focus();
      next.setSelectionRange(applied.caret, applied.caret);
    });
  }

  onHeadChange(value: string): void {
    this.head.set(value);
    void this.refreshDraft();
    void this.refillSelectedTemplate();
  }

  onBaseChange(value: string): void {
    this.base.set(value);
    void this.refreshDraft();
    void this.refillSelectedTemplate();
  }

  onTitleChange(value: string): void {
    this.titleTouched = true;
    this.title.set(value);
  }

  onBodyChange(value: string): void {
    this.bodyTouched = true;
    this.body.set(value);
  }

  async saveCurrentTemplate(): Promise<void> {
    const name = await this.prompts.ask({
      title: 'Save pull request template',
      message: 'This title and body will show up next time you open the PR dialog.',
      label: 'Template name',
      placeholder: 'Bugfix',
      confirmLabel: 'Save',
    });
    if (!name?.trim()) return;
    await this.store.savePrTemplate({
      name: name.trim(),
      title: this.title(),
      body: this.body(),
    });
    const saved = this.store.settings().prTemplates.at(-1);
    if (saved) this.selectedId.set(saved.id);
  }

  async removeSaved(template: SavedPrTemplate, event: Event): Promise<void> {
    event.stopPropagation();
    await this.store.deletePrTemplate(template.id);
    if (this.selectedId() === template.id) this.selectedId.set('blank');
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

  private async refreshDraft(): Promise<void> {
    const head = this.head().trim();
    const base = this.base().trim();
    if (!this.titleTouched) {
      this.title.set(fallbackPrTitle(head));
    }
    if (!this.bodyTouched && this.selectedId() === 'blank') {
      this.body.set(fallbackPrDescription(head, base));
    }
    const path = this.store.currentRepo()?.path;
    if (!path || !head || !base || head === base) return;
    const token = ++this.draftToken;
    try {
      const commits = await this.tauri.getCommitRange(path, base, head, 100);
      if (token !== this.draftToken) return;
      if (!this.titleTouched) {
        this.title.set(defaultPrTitle(commits, head));
      }
      if (!this.bodyTouched && this.selectedId() === 'blank') {
        this.body.set(defaultPrDescription(commits, head, base));
      }
    } catch {
      if (token !== this.draftToken) return;
      if (!this.titleTouched) {
        this.title.set(fallbackPrTitle(head));
      }
      if (!this.bodyTouched && this.selectedId() === 'blank') {
        this.body.set(fallbackPrDescription(head, base));
      }
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
      return;
    }
    this.loadingTemplates.set(true);
    try {
      const templates = await this.tauri.listPrTemplates(path);
      this.repoTemplates.set(templates);
      const auto = templates.find((t) => t.name === 'Repo default') ?? templates[0];
      if (auto && this.selectedId() === 'blank' && !this.bodyTouched) {
        this.selectedId.set(auto.id);
        await this.applyFilled(this.title(), auto.body);
        return;
      }
      if (this.selectedId() === 'blank' && !this.bodyTouched) {
        await this.refreshDraft();
      }
    } catch {
      this.repoTemplates.set([]);
      if (this.selectedId() === 'blank' && !this.bodyTouched) {
        await this.refreshDraft();
      }
    } finally {
      this.loadingTemplates.set(false);
    }
  }

  private async refillSelectedTemplate(): Promise<void> {
    const id = this.selectedId();
    if (id === 'blank' || id === 'new' || this.bodyTouched) return;
    const repo = this.repoTemplates().find((t) => t.id === id);
    if (repo) {
      await this.applyFilled(this.title(), repo.body);
      return;
    }
    const saved = this.savedTemplates().find((t) => t.id === id);
    if (saved) await this.applyFilled(saved.title, saved.body);
  }

  private async applyFilled(titleSource: string, bodySource: string): Promise<void> {
    const ctx = await this.templateContext();
    const title = fillPrTemplate(titleSource, ctx).trim();
    if (title && title !== STARTER_PR_TEMPLATE_TITLE) {
      this.titleTouched = true;
      this.title.set(title);
    }
    this.body.set(fillPrTemplate(bodySource, ctx));
  }

  private async templateContext() {
    const head = this.head().trim();
    const base = this.base().trim();
    const ticket = this.store.ticketForBranch(head) ?? '';
    const ticketUrl = ticket ? this.store.jiraBrowseUrl(ticket) ?? '' : '';
    const ticketSummary =
      this.store.jiraIssues().find((issue) => issue.key.toLowerCase() === ticket.toLowerCase())
        ?.summary ?? '';
    const commitsNewestFirst = await this.loadCommits();
    let author = '';
    let email = '';
    const path = this.store.currentRepo()?.path;
    if (path) {
      try {
        const ident = await this.tauri.getGitIdentity(path);
        author = ident.name;
        email = ident.email;
      } catch {
        author = '';
        email = '';
      }
    }
    return buildPrTemplateContext({
      head,
      base,
      title: this.title(),
      ticket,
      ticketUrl,
      ticketSummary,
      commitsNewestFirst,
      author,
      email,
      repo: this.store.currentRepo()?.name ?? '',
    });
  }

  private async loadCommits(): Promise<CommitInfo[]> {
    const path = this.store.currentRepo()?.path;
    const head = this.head().trim();
    const base = this.base().trim();
    if (!path || !head || !base || head === base) return [];
    try {
      return await this.tauri.getCommitRange(path, base, head, 100);
    } catch {
      return [];
    }
  }
}
