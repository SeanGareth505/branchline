import { Component, HostListener, computed, inject, signal } from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';
import type { DefaultPullAction } from '../../core/models';

type ToolMenu = 'pull' | 'push' | 'stash' | null;

@Component({
  selector: 'app-repo-toolbar',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './repo-toolbar.html',
  styleUrl: './repo-toolbar.scss',
})
export class RepoToolbar {
  readonly store = inject(AppStore);
  readonly menu = signal<ToolMenu>(null);

  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 4 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 4 },
  ];

  readonly pullLabel = computed(() => {
    const action = this.store.settings().defaultPullAction;
    if (action === 'fetch') return 'Fetch';
    return 'Pull';
  });

  readonly pullTitle = computed(() => {
    const action = this.store.settings().defaultPullAction;
    if (action === 'fetch') return 'Fetch from remote';
    if (action === 'rebase') return 'Pull and rebase';
    return 'Pull and merge';
  });

  readonly pullIcon = computed(() => {
    const action = this.store.settings().defaultPullAction;
    if (action === 'fetch') return 'lucideDownload';
    return 'lucideArrowDownUp';
  });

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.menu.set(null);
  }

  toggleMenu(which: Exclude<ToolMenu, null>, event: MouseEvent): void {
    event.stopPropagation();
    this.menu.update((current) => (current === which ? null : which));
  }

  closeMenu(): void {
    this.menu.set(null);
  }

  runDefaultPull(): void {
    this.menu.set(null);
    void this.applyPull(this.store.settings().defaultPullAction);
  }

  choosePull(action: DefaultPullAction): void {
    this.menu.set(null);
    void this.store.saveSettings({ defaultPullAction: action });
    void this.applyPull(action);
  }

  private async applyPull(action: DefaultPullAction): Promise<void> {
    if (action === 'fetch') {
      await this.store.fetchRemote();
      return;
    }
    await this.store.pullRemote(action === 'rebase');
  }

  runPush(): void {
    this.menu.set(null);
    void this.store.pushRemote();
  }

  runForcePush(): void {
    this.menu.set(null);
    void this.store.forcePush();
  }

  runSync(): void {
    this.menu.set(null);
    void this.store.syncRemote();
  }

  runStash(): void {
    this.menu.set(null);
    void this.store.stashPush();
  }

  runStashPop(): void {
    this.menu.set(null);
    void this.store.stashPop(0);
  }

  openConsole(): void {
    this.menu.set(null);
    this.store.setView('browse');
    this.store.setBrowseTab('console');
  }
}
