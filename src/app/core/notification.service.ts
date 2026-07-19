import { Injectable, inject } from '@angular/core';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { TauriService } from './tauri.service';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly tauri = inject(TauriService);
  private permissionRequested = false;

  async ensurePermission(): Promise<boolean> {
    if (this.tauri.isDummyBackend) return false;
    try {
      let granted = await isPermissionGranted();
      if (!granted && !this.permissionRequested) {
        this.permissionRequested = true;
        const permission = await requestPermission();
        granted = permission === 'granted';
      }
      return granted;
    } catch {
      return false;
    }
  }

  async sendDesktop(title: string, body?: string): Promise<void> {
    if (this.tauri.isDummyBackend) return;
    const granted = await this.ensurePermission();
    if (!granted) return;
    try {
      sendNotification(body ? { title, body } : { title });
    } catch {
      /* ignore permission / platform failures */
    }
  }
}
