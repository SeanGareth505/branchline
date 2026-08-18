import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { Spinner } from '../../../shared/ui/spinner/spinner';

@Component({
  selector: 'app-git-process-dialog',
  imports: [FormsModule, NgIcon, Spinner],
  templateUrl: './git-process-dialog.html',
  styleUrl: './git-process-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitProcessDialog {
  readonly store = inject(AppStore);
  private readonly logRef = viewChild<ElementRef<HTMLPreElement>>('log');

  constructor() {
    effect(() => {
      const output = this.store.gitProcess()?.output;
      if (output == null) return;
      queueMicrotask(() => {
        const el = this.logRef()?.nativeElement;
        if (el) el.scrollTop = el.scrollHeight;
      });
    });
  }

  close(): void {
    this.store.closeGitProcess();
  }

  onKeepOpen(value: boolean): void {
    this.store.setKeepGitProcessOpen(value);
  }

  async copyOutput(): Promise<void> {
    const text = this.store.gitProcess()?.output?.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.store.showSuccess('Copied Git output');
    } catch {
      this.store.showError('Could not copy output');
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.store.gitProcess()?.running) return;
    this.close();
  }
}
