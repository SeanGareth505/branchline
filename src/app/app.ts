import { ChangeDetectionStrategy, Component, HostListener, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppStore } from './core/app.store';
import { DiagnosticsService } from './core/diagnostics.service';
import { UpdateService } from './core/update.service';
import { PromptService } from './shared/ui/prompt-dialog/prompt.service';
import { SelectService } from './shared/ui/select-dialog/select.service';
import { ReleaseDialogService } from './features/release/release-dialog/release-dialog.service';
import { TooltipService } from './shared/ui/tooltip/tooltip.service';
import { resolveShortcuts, shortcutMatches } from './shared/git/shortcuts';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly store = inject(AppStore);
  private readonly updates = inject(UpdateService);
  private readonly diagnostics = inject(DiagnosticsService);
  private readonly tooltips = inject(TooltipService);
  private readonly prompts = inject(PromptService);
  private readonly selects = inject(SelectService);
  private readonly releaseDialog = inject(ReleaseDialogService);

  ngOnInit(): void {
    this.tooltips.init();
    this.diagnostics.bindGlobalHandlers();
    void this.store.init().then(() => void this.updates.init());
  }

  @HostListener('document:contextmenu', ['$event'])
  onContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      target?.closest('input, textarea, select, [contenteditable="true"]') ||
      !!window.getSelection()?.toString()
    ) {
      return;
    }
    event.preventDefault();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const shortcuts = resolveShortcuts(this.store.settings().keyboardShortcuts);
    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (shortcutMatches(event, shortcuts.palette)) {
      event.preventDefault();
      this.store.paletteOpen.update((v) => !v);
      return;
    }
    if (!typing && shortcutMatches(event, shortcuts.refresh)) {
      event.preventDefault();
      void this.store.refreshRepo({ notify: true });
      return;
    }
    if (!typing && shortcutMatches(event, shortcuts.fetch) && this.store.currentRepo()) {
      event.preventDefault();
      void this.store.fetchRemote();
      return;
    }
    if (!typing && shortcutMatches(event, shortcuts.commit) && this.store.currentRepo()) {
      event.preventDefault();
      this.store.openCommitModal();
      return;
    }
    if (!typing && shortcutMatches(event, shortcuts.undo) && this.store.toast()?.undo) {
      event.preventDefault();
      this.store.runUndoFromToast();
    }
    if (!typing && shortcutMatches(event, shortcuts.search)) {
      event.preventDefault();
      this.store.openFileSearch();
      return;
    }
    if (event.key === '?' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      this.store.openShortcutOverlay();
      return;
    }
    if (event.key === 'Escape') {
      if (this.prompts.request()) {
        this.prompts.cancel();
        return;
      }
      if (this.selects.request()) {
        this.selects.cancel();
        return;
      }
      if (this.releaseDialog.request()) {
        this.releaseDialog.cancel();
        return;
      }
      if (this.store.fileSearchOpen()) {
        this.store.closeFileSearch();
      } else if (this.store.shortcutOverlayOpen()) {
        this.store.closeShortcutOverlay();
      } else if (this.store.paletteOpen()) {
        this.store.paletteOpen.set(false);
      } else if (this.store.commitModalOpen()) {
        this.store.closeCommitModal();
      } else if (this.store.changelogModalOpen()) {
        this.store.closeChangelogModal();
      } else if (this.store.createBranchDialogOpen()) {
        this.store.closeCreateBranchDialog();
      } else if (this.store.createPrDialogOpen()) {
        this.store.closeCreatePrDialog();
      } else if (this.store.gitFlowDialogOpen()) {
        this.store.closeGitFlowDialog();
      } else if (this.store.branchHygieneDialogOpen()) {
        this.store.closeBranchHygieneDialog();
      } else if (this.store.gitCleanDialogOpen()) {
        this.store.closeGitCleanDialog();
      } else if (this.store.syncPreviewDialogOpen()) {
        this.store.closeSyncPreviewDialog();
      } else if (this.store.publishGithubDialogOpen()) {
        this.store.closePublishGithubDialog();
      } else if (this.store.githubDeviceLoginOpen()) {
        this.store.closeGithubDeviceLogin();
      } else if (this.store.safety()) {
        this.store.closeSafety();
      } else if (this.store.cherryPreviewOpen()) {
        this.store.closeCherryPick();
      } else if (this.store.conflictResolverOpen()) {
        this.store.closeConflictResolver();
      } else if (this.store.interactiveRebaseOpen()) {
        this.store.closeInteractiveRebase();
      } else if (this.store.ignoreEditorOpen()) {
        this.store.closeIgnoreEditor();
      }
    }
  }
}
