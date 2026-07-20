import { Injectable, signal } from '@angular/core';
import type { ReleaseConfigInfo } from '../../../core/models';

export interface ReleaseDialogInput {
  productName: string;
  currentVersion: string;
  currentBranch: string;
  dirty: boolean;
  config: ReleaseConfigInfo;
  branches: string[];
}

export interface ReleaseDialogResult {
  bump: string;
  branch: string | null;
  push: boolean;
  allowDirty: boolean;
  preid: string | null;
  tagMessage: string | null;
}

interface ReleaseDialogRequest extends ReleaseDialogInput {
  resolve: (value: ReleaseDialogResult | null) => void;
}

@Injectable({ providedIn: 'root' })
export class ReleaseDialogService {
  readonly request = signal<ReleaseDialogRequest | null>(null);

  ask(input: ReleaseDialogInput): Promise<ReleaseDialogResult | null> {
    return new Promise((resolve) => {
      const current = this.request();
      if (current) {
        current.resolve(null);
      }
      this.request.set({ ...input, resolve });
    });
  }

  submit(value: ReleaseDialogResult): void {
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
