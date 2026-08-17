import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AppStore } from '../../core/app.store';
import { ALL_REPO_ACCOUNTS } from '../../shared/git/repo-accounts';

@Component({
  selector: 'app-repo-account-bar',
  imports: [],
  templateUrl: './repo-account-bar.html',
  styleUrl: './repo-account-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RepoAccountBar {
  readonly store = inject(AppStore);
  readonly allKey = ALL_REPO_ACCOUNTS;
}
