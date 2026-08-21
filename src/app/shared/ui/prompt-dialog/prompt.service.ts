import { ApplicationRef, Injectable, inject, signal } from '@angular/core';

export interface PromptOptions {
  title: string;
  message?: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  multiline?: boolean;
  required?: boolean;
  mono?: boolean;
  confirmOnly?: boolean;
}

interface PromptRequest extends PromptOptions {
  resolve: (value: string | null) => void;
}

@Injectable({ providedIn: 'root' })
export class PromptService {
  private readonly appRef = inject(ApplicationRef);
  readonly request = signal<PromptRequest | null>(null);

  ask(options: PromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      const current = this.request();
      if (current) {
        current.resolve(null);
      }
      this.request.set({
        confirmLabel: 'Continue',
        cancelLabel: 'Cancel',
        required: true,
        ...options,
        resolve,
      });
      this.appRef.tick();
    });
  }

  submit(value: string): void {
    const req = this.request();
    if (!req) return;
    this.request.set(null);
    req.resolve(value);
  }

  cancel(): void {
    const req = this.request();
    if (!req) return;
    this.request.set(null);
    req.resolve(null);
  }
}
