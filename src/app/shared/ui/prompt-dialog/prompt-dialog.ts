import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { PromptService } from './prompt.service';

@Component({
  selector: 'app-prompt-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './prompt-dialog.html',
  styleUrl: './prompt-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PromptDialog {
  readonly prompts = inject(PromptService);
  readonly value = signal('');
  private readonly inputRef = viewChild<ElementRef<HTMLInputElement | HTMLTextAreaElement>>('field');

  constructor() {
    effect(() => {
      const req = this.prompts.request();
      if (!req) return;
      this.value.set(req.initialValue ?? '');
      queueMicrotask(() => {
        const el = this.inputRef()?.nativeElement;
        if (!el) return;
        el.focus();
        if ('select' in el && typeof el.select === 'function' && !req.multiline) {
          el.select();
        }
      });
    });
  }

  canSubmit(): boolean {
    const req = this.prompts.request();
    if (!req) return false;
    if (req.required === false) return true;
    return this.value().trim().length > 0;
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const req = this.prompts.request();
    const raw = this.value();
    this.prompts.submit(req?.required === false ? raw : raw.trim());
  }

  cancel(): void {
    this.prompts.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.prompts.request()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      const multiline = this.prompts.request()?.multiline;
      if (multiline && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      this.submit();
    }
  }
}
