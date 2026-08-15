import { ChangeDetectionStrategy, Component, HostListener, inject } from '@angular/core';
import { AppStore } from '../../core/app.store';

@Component({
  selector: 'app-shortcut-overlay',
  imports: [],
  templateUrl: './shortcut-overlay.html',
  styleUrl: './shortcut-overlay.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShortcutOverlay {
  readonly store = inject(AppStore);

  readonly groups: { title: string; items: { keys: string; action: string }[] }[] = [
    {
      title: 'General',
      items: [
        { keys: '⌘K', action: 'Command palette' },
        { keys: '?', action: 'This shortcut list' },
        { keys: 'Esc', action: 'Close dialogs' },
      ],
    },
    {
      title: 'Git',
      items: [
        { keys: '⌘⇧C', action: 'Commit' },
        { keys: '⌘⇧F', action: 'Fetch' },
        { keys: 'F5', action: 'Refresh repository' },
        { keys: '⌘Z', action: 'Undo last toast action' },
      ],
    },
    {
      title: 'Find',
      items: [{ keys: '⌘P', action: 'Search files in the repository' }],
    },
  ];

  close(): void {
    this.store.closeShortcutOverlay();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}
