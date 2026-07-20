import { Component, HostListener, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppStore } from './core/app.store';
import { DiagnosticsService } from './core/diagnostics.service';
import { UpdateService } from './core/update.service';
import { PromptService } from './shared/ui/prompt-dialog/prompt.service';
import { SelectService } from './shared/ui/select-dialog/select.service';
import { ReleaseDialogService } from './features/release/release-dialog/release-dialog.service';
import { TooltipService } from './shared/ui/tooltip/tooltip.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
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
    event.preventDefault();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const meta = event.metaKey || event.ctrlKey;
    const target = event.target as HTMLElement | null;
    const typing =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);

    if (meta && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      this.store.paletteOpen.update((v) => !v);
      return;
    }
    if (
      meta &&
      event.shiftKey &&
      event.key.toLowerCase() === 'c' &&
      !typing &&
      this.store.currentRepo()
    ) {
      event.preventDefault();
      this.store.openCommitModal();
      return;
    }
    if (meta && event.key.toLowerCase() === 'z' && !typing && this.store.toast()?.undo) {
      event.preventDefault();
      this.store.runUndoFromToast();
    }
    if (event.key === '?' && !typing && !meta && !event.altKey) {
      event.preventDefault();
      this.store.openShortcutPalette();
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
      if (this.store.paletteOpen()) {
        this.store.paletteOpen.set(false);
      } else if (this.store.commitModalOpen()) {
        this.store.closeCommitModal();
      } else if (this.store.changelogModalOpen()) {
        this.store.closeChangelogModal();
      } else if (this.store.createBranchDialogOpen()) {
        this.store.closeCreateBranchDialog();
      } else if (this.store.publishGithubDialogOpen()) {
        this.store.closePublishGithubDialog();
      } else if (this.store.githubDeviceLoginOpen()) {
        this.store.closeGithubDeviceLogin();
      } else if (this.store.safety()) {
        this.store.closeSafety();
      } else if (this.store.cherryPreviewOpen()) {
        this.store.closeCherryPick();
      }
    }
  }
}
