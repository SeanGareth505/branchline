import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { SafetyAnalysis } from '../../../core/models';
import {
  safetyRecommendedButtonKind,
  safetyRecommendedIsKeep,
  safetyShowsProceed,
} from './safety-dialog-actions';

type PushMode = 'lease' | 'force';

@Component({
  selector: 'app-safety-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './safety-dialog.html',
  styleUrl: './safety-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SafetyDialog {
  readonly store = inject(AppStore);
  readonly showCommand = signal(false);
  readonly acknowledged = signal(false);
  readonly typedConfirm = signal('');
  readonly pushMode = signal<PushMode>('lease');
  readonly busy = signal(false);

  constructor() {
    effect(() => {
      if (!this.store.safety()) return;
      this.showCommand.set(false);
      this.acknowledged.set(false);
      this.typedConfirm.set('');
      this.pushMode.set('lease');
      this.busy.set(false);
    });
  }

  isForcePush(safety: SafetyAnalysis): boolean {
    return safety.action === 'forcePush';
  }

  isSafeKeep(safety: SafetyAnalysis): boolean {
    return safetyRecommendedIsKeep(safety);
  }

  recommendedKind(safety: SafetyAnalysis): 'primary' | 'danger' {
    return safetyRecommendedButtonKind(safety);
  }

  behindRemote(safety: SafetyAnalysis): boolean {
    return safety.checks.some((c) => c.id === 'lease_safe' && !c.ok);
  }

  toggleCommand(): void {
    this.showCommand.update((v) => !v);
  }

  activeCommand(safety: SafetyAnalysis): string {
    if (this.isForcePush(safety)) {
      return this.pushMode() === 'lease' ? safety.gitCommand : safety.proceedGitCommand;
    }
    return safety.gitCommand;
  }

  needsTyped(safety: SafetyAnalysis): boolean {
    if (this.isForcePush(safety) && this.pushMode() === 'force') return true;
    return safety.requireTypedConfirm;
  }

  typedOk(safety: SafetyAnalysis): boolean {
    if (!this.needsTyped(safety)) return true;
    const expected = (safety.target ?? '').trim();
    if (!expected) return this.typedConfirm().trim().length > 0;
    return this.typedConfirm().trim() === expected;
  }

  gatesOk(safety: SafetyAnalysis, forRecommended: boolean): boolean {
    if (this.busy()) return false;
    if (forRecommended && this.isSafeKeep(safety)) return true;
    if (safety.blocked) return false;
    if (!forRecommended && !safety.canProceed) return false;
    if (this.isForcePush(safety) && !this.acknowledged()) return false;
    return this.typedOk(safety);
  }

  canRunRecommended(safety: SafetyAnalysis): boolean {
    if (this.isForcePush(safety) && this.pushMode() !== 'lease') return false;
    return this.gatesOk(safety, true);
  }

  canRunProceed(safety: SafetyAnalysis): boolean {
    if (!safety.canProceed) return false;
    if (this.isForcePush(safety) && this.pushMode() !== 'force') return false;
    if (safety.proceedLabel === safety.recommendedLabel && !this.isForcePush(safety)) return false;
    return this.gatesOk(safety, false);
  }

  showProceed(safety: SafetyAnalysis): boolean {
    return safetyShowsProceed(safety);
  }

  async run(recommended: boolean): Promise<void> {
    const safety = this.store.safety();
    if (!safety) return;
    if (recommended && !this.canRunRecommended(safety)) return;
    if (!recommended && !this.canRunProceed(safety)) return;
    this.busy.set(true);
    try {
      await this.store.executeSafety(recommended, {
        confirmationPhrase: this.typedConfirm().trim() || undefined,
        allowBareForce:
          !recommended && this.isForcePush(safety) && this.pushMode() === 'force',
        acknowledged: this.isForcePush(safety) ? this.acknowledged() : true,
      });
    } finally {
      this.busy.set(false);
    }
  }

  async fetchFirst(): Promise<void> {
    const target = this.store.safety()?.target ?? undefined;
    this.busy.set(true);
    try {
      await this.store.fetchRemote();
      await this.store.openSafety('forcePush', target);
    } finally {
      this.busy.set(false);
    }
  }
}
