import { Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { IdentityCandidate, IdentityContexts } from '../../../core/models';

type ProfileFilter = 'all' | 'config' | 'history';

@Component({
  selector: 'app-profiles-page',
  imports: [FormsModule, NgIcon],
  templateUrl: './profiles-page.html',
  styleUrl: './profiles-page.scss',
})
export class ProfilesPage implements OnInit {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);

  readonly contexts = signal<IdentityContexts | null>(null);
  readonly loading = signal(true);
  readonly applyingId = signal<string | null>(null);
  readonly draftName = signal('');
  readonly draftEmail = signal('');
  readonly saving = signal(false);
  readonly filter = signal<ProfileFilter>('all');
  private lastRepoPath: string | null | undefined = undefined;

  readonly candidateCount = computed(() => this.contexts()?.candidates.length ?? 0);

  readonly repoName = computed(() => this.store.currentRepo()?.name ?? null);

  readonly visibleCandidates = computed(() => {
    const list = this.contexts()?.candidates ?? [];
    const filter = this.filter();
    if (filter === 'config') {
      return list.filter((c) => c.source === 'local' || c.source === 'global');
    }
    if (filter === 'history') {
      return list.filter((c) => c.source === 'history');
    }
    return list;
  });

  readonly filterHint = computed(() => {
    const filter = this.filter();
    if (filter === 'config') return 'Local override and global Git default.';
    if (filter === 'history') return 'Authors already recorded in this repository’s commits.';
    return 'From Git config and authors seen in this repository.';
  });

  readonly scopeLabel = computed(() => {
    const scope = this.contexts()?.effectiveScope;
    if (scope === 'local') return 'This repository';
    if (scope === 'global') return 'Global Git default';
    return 'Not set';
  });

  readonly canSave = computed(
    () => !!this.draftName().trim() && !!this.draftEmail().trim() && !this.saving(),
  );

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
      const effective = contexts.effective;
      this.draftName.set(effective.name || '');
      this.draftEmail.set(effective.email || '');
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.loading.set(false);
    }
  }

  initials(name: string, email: string): string {
    const fromName = name
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('');
    if (fromName) return fromName;
    const local = email.trim().split('@')[0] ?? '';
    if (local.length >= 2) return local.slice(0, 2).toUpperCase();
    if (local.length === 1) return local.toUpperCase();
    return '?';
  }

  sourceIcon(source: string): string {
    if (source === 'local') return 'lucideFolderGit2';
    if (source === 'global') return 'lucideGlobe';
    return 'lucideGitCommitHorizontal';
  }

  sourceLabel(candidate: IdentityCandidate): string {
    if (candidate.source === 'local') return 'This repository';
    if (candidate.source === 'global') return 'Global default';
    return candidate.label || 'Seen in commits';
  }

  fillDraft(candidate: IdentityCandidate): void {
    this.draftName.set(candidate.name || '');
    this.draftEmail.set(candidate.email || '');
  }

  async useForRepo(candidate: IdentityCandidate): Promise<void> {
    const path = this.store.currentRepo()?.path;
    if (!path) {
      this.store.showWarning('Open a repository to set a local identity');
      return;
    }
    await this.applyIdentity(candidate.name, candidate.email, 'local', path, candidate.id);
  }

  async useGlobal(candidate: IdentityCandidate): Promise<void> {
    await this.applyIdentity(candidate.name, candidate.email, 'global', undefined, candidate.id);
  }

  async saveForRepo(): Promise<void> {
    const path = this.store.currentRepo()?.path;
    if (!path) {
      this.store.showWarning('Open a repository to set a local identity');
      return;
    }
    await this.applyIdentity(this.draftName().trim(), this.draftEmail().trim(), 'local', path, 'draft');
  }

  async saveGlobal(): Promise<void> {
    await this.applyIdentity(
      this.draftName().trim(),
      this.draftEmail().trim(),
      'global',
      undefined,
      'draft',
    );
  }

  private async applyIdentity(
    name: string,
    email: string,
    scope: 'global' | 'local',
    path: string | undefined,
    applyingKey: string,
  ): Promise<void> {
    if (!name.trim() || !email.trim() || this.applyingId()) return;
    this.applyingId.set(applyingKey);
    this.saving.set(true);
    try {
      await this.tauri.setGitIdentity(name.trim(), email.trim(), scope, path);
      await this.store.refreshIdentity();
      await this.reload();
      this.store.showSuccess(
        scope === 'local'
          ? `Using ${name} <${email}> for this repository`
          : `Global Git identity set to ${name} <${email}>`,
      );
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.applyingId.set(null);
      this.saving.set(false);
    }
  }
}
