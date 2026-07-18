import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';

@Component({
  selector: 'app-repo-tabs',
  imports: [NgIcon],
  templateUrl: './repo-tabs.html',
  styleUrl: './repo-tabs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepoTabs {
  readonly store = inject(AppStore);

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
