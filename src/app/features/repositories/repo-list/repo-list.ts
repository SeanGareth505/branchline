import { Component, inject } from '@angular/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-repo-list',
  imports: [],
  templateUrl: './repo-list.html',
  styleUrl: './repo-list.scss',
})
export class RepoList {
  readonly store = inject(AppStore);
}
