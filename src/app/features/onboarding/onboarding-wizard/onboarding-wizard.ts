import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { OnboardingChecklistItem } from '../../../core/models';
import { BrandMark } from '../../../shared/ui/brand-mark/brand-mark';
import { SshSetupPanel } from '../ssh-setup-panel/ssh-setup-panel';

@Component({
  selector: 'app-onboarding-wizard',
  imports: [FormsModule, BrandMark, SshSetupPanel],
  templateUrl: './onboarding-wizard.html',
  styleUrl: './onboarding-wizard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OnboardingWizard implements OnInit {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);

  readonly items = signal<OnboardingChecklistItem[]>([]);
  readonly name = signal('');
  readonly email = signal('');
  readonly errorText = signal('');
  readonly busy = signal(false);

  async ngOnInit(): Promise<void> {
    await this.refreshChecklist(true);
  }

  statusLabel(status: string): string {
    if (status === 'verified') return 'Verified';
    if (status === 'skipped') return 'Skipped';
    return 'Needs attention';
  }

  async refreshChecklist(includeIdentity = false): Promise<void> {
    this.errorText.set('');
    try {
      const status = await this.tauri.getOnboardingStatus();
      this.items.set(status.items);
      if (includeIdentity) {
        const identity = await this.tauri.getGitIdentity();
        this.name.set(identity.name);
        this.email.set(identity.email);
      }
    } catch (err) {
      this.errorText.set(this.store.formatError(err));
    }
  }

  async saveIdentity(): Promise<void> {
    this.busy.set(true);
    this.errorText.set('');
    try {
      await this.tauri.setGitIdentity(this.name(), this.email());
      await this.store.refreshIdentity();
      await this.refreshChecklist();
    } catch (err) {
      this.errorText.set(this.store.formatError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async complete(): Promise<void> {
    this.busy.set(true);
    this.errorText.set('');
    try {
      await this.tauri.setGitIdentity(this.name(), this.email());
      await this.store.refreshIdentity();
      await this.tauri.completeOnboarding();
      this.store.repos.set(await this.tauri.listRecentRepos());
      this.store.goHome();
    } catch (err) {
      this.errorText.set(this.store.formatError(err));
    } finally {
      this.busy.set(false);
    }
  }

  async skip(): Promise<void> {
    this.busy.set(true);
    this.errorText.set('');
    try {
      await this.tauri.skipOnboarding();
      this.store.repos.set(await this.tauri.listRecentRepos());
      this.store.goHome();
    } catch (err) {
      this.errorText.set(this.store.formatError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
