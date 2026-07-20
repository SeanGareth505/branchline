import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { ReleaseDialogService } from './release-dialog.service';

type BumpKind = 'patch' | 'minor' | 'major' | 'custom';

@Component({
  selector: 'app-release-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './release-dialog.html',
  styleUrl: './release-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseDialog {
  readonly dialog = inject(ReleaseDialogService);

  readonly bump = signal<BumpKind>('patch');
  readonly customVersion = signal('');
  readonly branch = signal('');
  readonly push = signal(false);
  readonly allowDirty = signal(false);
  readonly preid = signal('');
  readonly tagMessage = signal('');
  readonly settingsOpen = signal(false);

  readonly summaryDetails = computed(() => {
    const req = this.dialog.request();
    if (!req) return [] as string[];
    const cfg = req.config;
    const lines = [
      `Branch: ${this.branch().trim() || cfg.branch}`,
      `Tag prefix: ${cfg.tagPrefix}`,
      `Files: ${cfg.files.join(', ')}`,
      this.push() ? 'Will push to origin after tag' : 'Will not push automatically',
    ];
    if (this.allowDirty()) {
      lines.push('Allows dirty working tree');
    }
    if (this.preid().trim()) {
      lines.push(`Pre-release id: ${this.preid().trim()}`);
    }
    if (this.tagMessage().trim()) {
      lines.push('Custom tag message');
    }
    return lines;
  });

  readonly canSubmit = computed(() => {
    if (this.bump() === 'custom') {
      return !!this.customVersion().trim();
    }
    return !!this.bump();
  });

  constructor() {
    effect(() => {
      const req = this.dialog.request();
      if (!req) return;
      this.bump.set('patch');
      this.customVersion.set('');
      this.branch.set(req.config.branch || req.currentBranch);
      this.push.set(req.config.pushDefault);
      this.allowDirty.set(false);
      this.preid.set('');
      this.tagMessage.set('');
      this.settingsOpen.set(false);
    });
  }

  toggleSettings(): void {
    this.settingsOpen.update((v) => !v);
  }

  pickBump(kind: BumpKind): void {
    this.bump.set(kind);
    if (kind === 'custom') {
      this.settingsOpen.set(true);
    }
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const req = this.dialog.request();
    if (!req) return;
    const bump =
      this.bump() === 'custom' ? this.customVersion().trim() : this.bump();
    const branch = this.branch().trim();
    this.dialog.submit({
      bump,
      branch: (() => {
      const picked = branch.trim();
      if (!picked || picked === req.config.branch) return null;
      return picked;
    })(),
      push: this.push(),
      allowDirty: this.allowDirty(),
      preid: this.preid().trim() || null,
      tagMessage: this.tagMessage().trim() || null,
    });
  }

  cancel(): void {
    this.dialog.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.dialog.request()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter' && !this.settingsOpen()) {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'TEXTAREA' ||
        (target?.tagName === 'INPUT' && target.getAttribute('type') !== 'checkbox')
      ) {
        return;
      }
      event.preventDefault();
      this.submit();
    }
  }
}
