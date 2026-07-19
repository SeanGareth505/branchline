import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { IdentityCandidate, IdentityContexts } from '../../../core/models';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';

@Component({
  selector: 'app-profiles-page',
  imports: [FormsModule, LoadingBlock],
  templateUrl: './profiles-page.html',
  styleUrl: './profiles-page.scss',
})
export class ProfilesPage implements OnInit {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);

  readonly contexts = signal<IdentityContexts | null>(null);
  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly name = signal('');
  readonly email = signal('');
  private lastRepoPath: string | null | undefined = undefined;

  readonly hasRepo = computed(() => !!this.contexts()?.hasRepo);
  readonly hasOverride = computed(() => this.contexts()?.effectiveScope === 'local');
  readonly canSave = computed(
    () => !!this.name().trim() && !!this.email().trim() && !this.saving(),
  );

  readonly suggestions = computed(() => {
    const ctx = this.contexts();
    if (!ctx) return [];
    const seen = new Set<string>();
    const out: IdentityCandidate[] = [];
    for (const c of ctx.candidates) {
      const key = c.email.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      if (this.isPlaceholderEmail(key)) continue;
      seen.add(key);
      out.push(c);
      if (out.length >= 8) break;
    }
    return out;
  });

  private isPlaceholderEmail(email: string): boolean {
    const e = email.trim().toLowerCase();
    return (
      !e ||
      e.endsWith('@personal.dev') ||
      e.endsWith('@example.com') ||
      e.endsWith('@example.org') ||
      e.endsWith('@example.net') ||
      e.endsWith('@localhost') ||
      e.endsWith('@test.com') ||
      e.startsWith('noreply@') ||
      e.includes('users.noreply.github.com')
    );
  }

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path ?? null;
      if (this.lastRepoPath === undefined) {
        this.lastRepoPath = path;
        return;
      }
      if (this.lastRepoPath === path) return;
      this.lastRepoPath = path;
      void this.reload();
    });
  }

  async ngOnInit(): Promise<void> {
    this.lastRepoPath = this.store.currentRepo()?.path ?? null;
    await this.reload();
  }

  async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const path = this.store.currentRepo()?.path ?? null;
      const contexts = await this.tauri.listIdentityContexts(path);
      this.contexts.set(contexts);
      this.name.set(contexts.effective.name || '');
      this.email.set(contexts.effective.email || '');
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.loading.set(false);
    }
  }

  pick(candidate: IdentityCandidate): void {
    this.name.set(candidate.name || '');
    this.email.set(candidate.email || '');
  }

  isSelected(candidate: IdentityCandidate): boolean {
    return (
      this.email().trim().toLowerCase() === candidate.email.trim().toLowerCase() &&
      this.name().trim().toLowerCase() === candidate.name.trim().toLowerCase()
    );
  }

  async saveDefault(): Promise<void> {
    await this.apply('global');
  }

  async saveRepoOnly(): Promise<void> {
    if (!this.store.currentRepo()?.path) {
      this.store.showWarning('Open a repository first');
      return;
    }
    await this.apply('local');
  }

  async clearOverride(): Promise<void> {
    const global = this.contexts()?.global;
    if (!global?.name || !global?.email) {
      this.store.showWarning('Set a global default first');
      return;
    }
    this.name.set(global.name);
    this.email.set(global.email);
    await this.apply('global');
  }

  private async apply(scope: 'global' | 'local'): Promise<void> {
    const name = this.name().trim();
    const email = this.email().trim();
    if (!name || !email || this.saving()) return;
    this.saving.set(true);
    try {
      const path = this.store.currentRepo()?.path;
      await this.tauri.setGitIdentity(name, email, scope, path);
      await this.store.refreshIdentity();
      await this.reload();
      this.store.showSuccess(
        scope === 'local'
          ? `This repo commits as ${name} <${email}>`
          : `Default for all repos: ${name} <${email}>`,
      );
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.saving.set(false);
    }
  }
}
