import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { AppStore } from '../../../core/app.store';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';

@Component({
  selector: 'app-open-repo-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './open-repo-dialog.html',
  styleUrl: './open-repo-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpenRepoDialog {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly path = signal('');
  readonly busy = signal(false);
  readonly dragging = signal(false);
  private unlistenDrag: (() => void) | null = null;

  readonly canSubmit = computed(() => !!this.path().trim() && !this.busy());

  constructor() {
    effect((onCleanup) => {
      if (!this.store.openRepoDialogOpen()) {
        this.unlistenDrag?.();
        this.unlistenDrag = null;
        return;
      }
      const seed = this.store.openRepoDialogPath().trim();
      if (seed) this.path.set(seed);
      void this.bindDrop();
      onCleanup(() => {
        this.unlistenDrag?.();
        this.unlistenDrag = null;
      });
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeOpenRepoDialog();
    this.path.set('');
    this.dragging.set(false);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(true);
  }

  onDragLeave(): void {
    this.dragging.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    const dropped = folderPathFromDrop(event);
    if (dropped) this.path.set(dropped);
  }

  async pickFolder(): Promise<void> {
    if (this.isTauri()) {
      try {
        const selected = await openDialog({ directory: true, multiple: false });
        if (typeof selected === 'string' && selected) this.path.set(selected);
      } catch (err) {
        this.store.showError(err);
      }
      return;
    }
    const picked = await this.prompts.ask({
      title: 'Open repository',
      message: 'Enter the full path to a folder.',
      label: 'Folder path',
      placeholder: '/Users/you/Projects/repo',
      confirmLabel: 'Use folder',
      mono: true,
    });
    if (picked?.trim()) this.path.set(picked.trim());
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    try {
      const opened = await this.store.openOrOfferInit(this.path().trim());
      if (opened) {
        this.store.closeOpenRepoDialog();
        this.path.set('');
      }
    } finally {
      this.busy.set(false);
    }
  }

  private isTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  private async bindDrop(): Promise<void> {
    if (!this.isTauri()) return;
    try {
      this.unlistenDrag = await getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'over' || event.payload.type === 'enter') {
          this.dragging.set(true);
          return;
        }
        if (event.payload.type === 'leave') {
          this.dragging.set(false);
          return;
        }
        if (event.payload.type === 'drop') {
          this.dragging.set(false);
          const next = event.payload.paths[0]?.trim();
          if (next) this.path.set(next);
        }
      });
    } catch {
      this.unlistenDrag = null;
    }
  }
}

function folderPathFromDrop(event: DragEvent): string | null {
  const files = event.dataTransfer?.files;
  if (!files?.length) return null;
  const file = files[0] as File & { path?: string };
  const fromPath = file.path?.trim();
  if (fromPath) return fromPath;
  const uri = event.dataTransfer?.getData('text/uri-list')?.trim();
  if (uri?.startsWith('file://')) {
    try {
      return decodeURIComponent(uri.replace(/^file:\/\//, ''));
    } catch {
      return uri.replace(/^file:\/\//, '');
    }
  }
  return null;
}
