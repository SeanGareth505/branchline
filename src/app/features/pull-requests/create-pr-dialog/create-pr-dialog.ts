import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { PrCreateMethod, RepoPrTemplate, SavedPrTemplate } from '../../../core/models';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { Spinner } from '../../../shared/ui/spinner/spinner';
import { branchLeafName, isMainlineBranch } from '../../../shared/git/mainline-branch';

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

  readonly savedTemplates = computed(() => this.store.settings().prTemplates);
  readonly githubReady = computed(() => this.store.hasLinkedGithub());

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
      this.title.set(this.defaultTitle());
      this.body.set('');
      this.head.set(branch);
      this.base.set(this.defaultBase(branch));
      this.draft.set(false);
      this.method.set(this.store.settings().prCreateMethod);
      this.selectedId.set('blank');
      this.busy.set(false);
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
      this.body.set('');
      return;
    }
    const repo = this.repoTemplates().find((t) => t.id === id);
    if (repo) {
      this.body.set(repo.body);
      return;
    }
    const saved = this.savedTemplates().find((t) => t.id === id);
    if (saved) {
      if (saved.title.trim()) this.title.set(saved.title);
      this.body.set(saved.body);
    }
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

  private defaultTitle(): string {
    const subject = this.store.commits()[0]?.subject?.trim();
    if (subject) return subject;
    return (this.store.status()?.branch ?? '').replace(/\//g, ': ');
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
      if (auto && this.selectedId() === 'blank' && !this.body().trim()) {
        this.selectedId.set(auto.id);
        this.body.set(auto.body);
      }
    } catch {
      this.repoTemplates.set([]);
    } finally {
      this.loadingTemplates.set(false);
    }
  }
}
