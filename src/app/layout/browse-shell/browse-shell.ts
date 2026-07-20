import { Component, inject } from '@angular/core';
import { AngularSplitModule } from 'angular-split';
import { AppStore, type BrowseTab } from '../../core/app.store';
import { RefsPanel } from '../../features/branches/refs-panel/refs-panel';
import { BlameView } from '../../features/blame/blame-view/blame-view';
import { CommitPanel } from '../../features/commits/commit-panel/commit-panel';
import { ConflictBanner } from '../../features/conflicts/conflict-banner/conflict-banner';
import { DiffViewer } from '../../features/diff/diff-viewer/diff-viewer';
import { FileHistoryPanel } from '../../features/file-history/file-history-panel/file-history-panel';
import { ReflogPanel } from '../../features/reflog/reflog-panel/reflog-panel';
import { RevisionGrid } from '../../features/graph/revision-grid/revision-grid';
import { GitConsole } from '../../features/terminal/git-console/git-console';
import { FileTreePanel } from '../../features/files/file-tree-panel/file-tree-panel';
import { ReleasePanel } from '../../features/release/release-panel/release-panel';

@Component({
  selector: 'app-browse-shell',
  imports: [
    AngularSplitModule,
    RefsPanel,
    RevisionGrid,
    CommitPanel,
    DiffViewer,
    ConflictBanner,
    GitConsole,
    BlameView,
    FileHistoryPanel,
    ReflogPanel,
    FileTreePanel,
    ReleasePanel,
  ],
  templateUrl: './browse-shell.html',
  styleUrl: './browse-shell.scss',
})
export class BrowseShell {
  readonly store = inject(AppStore);

  setTab(tab: BrowseTab): void {
    this.store.setBrowseTab(tab);
  }

  onMainSplit(sizes: Array<number | '*'>): void {
    const nums = sizes.filter((s): s is number => typeof s === 'number');
    if (nums.length >= 2) this.store.setSplitSizes('main', nums);
  }

  onNestedSplit(sizes: Array<number | '*'>): void {
    const nums = sizes.filter((s): s is number => typeof s === 'number');
    if (nums.length >= 2) this.store.setSplitSizes('nested', nums);
  }
}
