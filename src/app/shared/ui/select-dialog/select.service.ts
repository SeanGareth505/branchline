import { Injectable, signal } from '@angular/core';

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface SelectPromptOptions {
  title: string;
  message?: string;
  label?: string;
  placeholder?: string;
  options: SelectOption[];
  confirmLabel?: string;
  cancelLabel?: string;
  initialValue?: string;
  /** Show the filter box. Defaults to true when there are more than 6 options. */
  filterable?: boolean;
}

interface SelectRequest extends SelectPromptOptions {
  resolve: (value: string | null) => void;
}

@Injectable({ providedIn: 'root' })
export class SelectService {
  readonly request = signal<SelectRequest | null>(null);

  ask(options: SelectPromptOptions): Promise<string | null> {
    return new Promise((resolve) => {
      const current = this.request();
      if (current) {
        current.resolve(null);
      }
      this.request.set({
        confirmLabel: 'Continue',
        cancelLabel: 'Cancel',
        ...options,
        resolve,
      });
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
