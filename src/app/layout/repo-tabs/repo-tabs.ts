import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';
import type { RepoSummary } from '../../core/models';
import { assignIdentityColors, repoIdentityKey } from '../../shared/ui/identity-color';

@Component({
  selector: 'app-repo-tabs',
  imports: [NgIcon],
  templateUrl: './repo-tabs.html',
  styleUrl: './repo-tabs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepoTabs {
  readonly store = inject(AppStore);

  private readonly tabColors = computed(() =>
    assignIdentityColors(this.store.openRepos().map((repo) => repoIdentityKey(repo.name, repo.path))),
  );

  colorFor(repo: RepoSummary): string {
    const key = repoIdentityKey(repo.name, repo.path);
    return this.tabColors().get(key) ?? `var(--swatch-1)`;
  }

  select(path: string): void {
    void this.store.switchOpenRepo(path);
  }

  close(path: string, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    void this.store.closeOpenRepo(path);
  }

  tooltip(path: string, branch?: string | null): string {
    return branch ? `${path}\non ${branch}` : path;
  }
}
