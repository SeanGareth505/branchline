import { ChangeDetectionStrategy, Component, HostListener, computed, inject } from '@angular/core';
import { AppStore } from '../../core/app.store';
import { formatShortcut, resolveShortcuts } from '../../shared/git/shortcuts';

@Component({
  selector: 'app-shortcut-overlay',
  imports: [],
  templateUrl: './shortcut-overlay.html',
  styleUrl: './shortcut-overlay.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShortcutOverlay {
  readonly store = inject(AppStore);

  readonly groups = computed(() => {
    const keys = resolveShortcuts(this.store.settings().keyboardShortcuts);
    return [
      {
        title: 'General',
        items: [
          { keys: formatShortcut(keys.palette), action: 'Command palette' },
          { keys: '?', action: 'This shortcut list' },
          { keys: 'Esc', action: 'Close dialogs' },
        ],
      },
      {
        title: 'Git',
        items: [
          { keys: formatShortcut(keys.commit), action: 'Commit' },
          { keys: formatShortcut(keys.fetch), action: 'Fetch' },
          { keys: formatShortcut(keys.refresh), action: 'Refresh repository' },
          { keys: formatShortcut(keys.undo), action: 'Undo last toast action' },
        ],
      },
      {
        title: 'Find',
        items: [{ keys: formatShortcut(keys.search), action: 'Search files in the repository' }],
      },
    ];
  });

  close(): void {
    this.store.closeShortcutOverlay();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}
