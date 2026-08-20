import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AngularSplitModule } from 'angular-split';
import { AppStore, type BrowseTab } from '../../core/app.store';
import { RefsPanel } from '../../features/branches/refs-panel/refs-panel';
import { BlameView } from '../../features/blame/blame-view/blame-view';
import { CommitPanel } from '../../features/commits/commit-panel/commit-panel';
import { ConflictBanner } from '../../features/conflicts/conflict-banner/conflict-banner';
import { BisectBanner } from '../../features/bisect/bisect-banner/bisect-banner';
import { DiffViewer } from '../../features/diff/diff-viewer/diff-viewer';
import { FileHistoryPanel } from '../../features/file-history/file-history-panel/file-history-panel';
import { ReflogPanel } from '../../features/reflog/reflog-panel/reflog-panel';
import { RevisionGrid } from '../../features/graph/revision-grid/revision-grid';
import { GitConsole } from '../../features/terminal/git-console/git-console';
import { FileTreePanel } from '../../features/files/file-tree-panel/file-tree-panel';
import { Spinner } from '../../shared/ui/spinner/spinner';

@Component({
  selector: 'app-browse-shell',
  imports: [
    AngularSplitModule,
    RefsPanel,
    RevisionGrid,
    CommitPanel,
    DiffViewer,
    ConflictBanner,
    BisectBanner,
    GitConsole,
    BlameView,
    FileHistoryPanel,
    ReflogPanel,
    FileTreePanel,
    Spinner,
  ],
  templateUrl: './browse-shell.html',
  styleUrl: './browse-shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BrowseShell {
  readonly store = inject(AppStore);

  openRelease(event?: Event): void {
    if (!this.store.releasingLocally()) return;
    event?.preventDefault();
    this.store.setView('release');
  }

  setTab(tab: BrowseTab): void {
    this.store.setBrowseTab(tab);
  }

  showInspectTab(tab: BrowseTab): boolean {
    if (!this.store.settings().simpleMode) return true;
    if (tab === 'history' || tab === 'blame') return true;
    return this.store.browseTab() === tab;
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
