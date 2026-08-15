import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
} from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { AppStore } from '../../../core/app.store';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';

@Component({
  selector: 'app-lfs-panel',
  imports: [NgIcon, HelpTip],
  templateUrl: './lfs-panel.html',
  styleUrl: './lfs-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LfsPanel {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();
  readonly hide = output<void>();

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.store.lfsFiles();
    if (!q) return list;
    return list.filter((f) => f.path.toLowerCase().includes(q));
  });

  readonly open = computed(() => {
    if (this.filter().trim()) return this.filtered().length > 0;
    return this.expanded();
  });

  readonly worktreeLarge = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const lfsPaths = new Set(this.store.lfsFiles().map((f) => f.path));
    return this.store.largeFiles().filter((f) => {
      if (f.lfs || lfsPaths.has(f.path)) return false;
      if (!q) return true;
      return f.path.toLowerCase().includes(q);
    });
  });

  constructor() {
    effect(() => {
      if (!this.open()) return;
      void this.store.loadLargeFiles();
    });
  }

  toggle(event?: Event): void {
    event?.stopPropagation();
    if (this.filter().trim()) return;
    this.expandedChange.emit(!this.expanded());
  }

  chevron(): string {
    return this.open() ? 'lucideChevronDown' : 'lucideChevronRight';
  }

  requestHide(event?: Event): void {
    event?.stopPropagation();
    this.hide.emit();
  }

  fileName(path: string): string {
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts[parts.length - 1] || path;
  }

  async trackPattern(event?: Event): Promise<void> {
    event?.stopPropagation();
    const pattern = await this.prompts.ask({
      title: 'Track with Git LFS',
      message: 'Git will store matching files as LFS pointers. Example: *.psd or assets/video.mp4',
      label: 'Pattern',
      placeholder: '*.psd',
      confirmLabel: 'Track',
      mono: true,
    });
    if (!pattern?.trim()) return;
    void this.store.lfsTrack(pattern.trim());
  }

  lockFile(path: string, event?: Event): void {
    event?.stopPropagation();
    void this.store.lfsLock(path);
  }

  unlockFile(path: string, event?: Event): void {
    event?.stopPropagation();
    void this.store.lfsUnlock(path);
  }

  async untrackFile(path: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    void this.store.lfsUntrack(path);
  }
}
