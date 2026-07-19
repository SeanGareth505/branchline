import { Component, OnInit, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { ProfileInfo } from '../../../core/models';

@Component({
  selector: 'app-profiles-page',
  imports: [NgIcon],
  templateUrl: './profiles-page.html',
  styleUrl: './profiles-page.scss',
})
export class ProfilesPage implements OnInit {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);
  readonly profiles = signal<ProfileInfo[]>([]);
  readonly applyingId = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    this.profiles.set(await this.tauri.listProfiles());
  }

  async useProfile(profile: ProfileInfo): Promise<void> {
    if (this.applyingId()) return;
    this.applyingId.set(profile.id);
    try {
      await this.tauri.setGitIdentity(profile.name, profile.email);
      await this.store.refreshIdentity();
      this.store.showSuccess(`Using ${profile.name} <${profile.email}>`);
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.applyingId.set(null);
    }
  }
}
