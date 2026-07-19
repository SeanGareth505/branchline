import { Component, HostListener, OnInit, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppStore } from './core/app.store';
import { TooltipService } from './shared/ui/tooltip/tooltip.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  private readonly store = inject(AppStore);
  private readonly tooltips = inject(TooltipService);

  ngOnInit(): void {
    this.tooltips.init();
    void this.store.init();
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
    if (meta && event.key.toLowerCase() === 'z' && !typing && this.store.toast()?.undo) {
      event.preventDefault();
      this.store.runUndoFromToast();
    }
    if (event.key === 'Escape') {
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
