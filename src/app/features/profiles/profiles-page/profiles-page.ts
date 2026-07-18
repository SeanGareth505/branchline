import { Component, OnInit, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
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
  readonly profiles = signal<ProfileInfo[]>([]);

  async ngOnInit(): Promise<void> {
    this.profiles.set(await this.tauri.listProfiles());
  }
}
