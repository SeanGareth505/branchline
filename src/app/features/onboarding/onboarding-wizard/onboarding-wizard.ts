import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { OnboardingChecklistItem } from '../../../core/models';
import { BrandMark } from '../../../shared/ui/brand-mark/brand-mark';

@Component({
  selector: 'app-onboarding-wizard',
  imports: [FormsModule, BrandMark],
  templateUrl: './onboarding-wizard.html',
  styleUrl: './onboarding-wizard.scss',
})
export class OnboardingWizard implements OnInit {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);

  readonly items = signal<OnboardingChecklistItem[]>([]);
  readonly name = signal('');
  readonly email = signal('');

  async ngOnInit(): Promise<void> {
    const status = await this.tauri.getOnboardingStatus();
    this.items.set(status.items);
    const identity = await this.tauri.getGitIdentity();
    this.name.set(identity.name);
    this.email.set(identity.email);
  }

  statusLabel(status: string): string {
    if (status === 'verified') return 'Verified';
    if (status === 'skipped') return 'Skipped';
    return 'Needs attention';
  }

  async saveIdentity(): Promise<void> {
    await this.tauri.setGitIdentity(this.name(), this.email());
    await this.store.refreshIdentity();
    const status = await this.tauri.getOnboardingStatus();
    this.items.set(status.items);
  }

  async complete(): Promise<void> {
    await this.saveIdentity();
    await this.tauri.completeOnboarding();
    this.store.repos.set(await this.tauri.listRecentRepos());
    this.store.goHome();
  }

  async skip(): Promise<void> {
    await this.tauri.skipOnboarding();
    this.store.repos.set(await this.tauri.listRecentRepos());
    this.store.goHome();
  }
}
