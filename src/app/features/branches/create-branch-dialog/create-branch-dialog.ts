import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-create-branch-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './create-branch-dialog.html',
  styleUrl: './create-branch-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateBranchDialog {
  readonly store = inject(AppStore);
  readonly name = signal('');
  readonly checkout = signal(true);
  readonly usePrefix = signal(true);
  readonly prefix = signal('feature');
  readonly busy = signal(false);
  readonly prefixOpen = signal(false);
  readonly addingPrefix = signal(false);
  readonly newPrefix = signal('');
  private readonly prefixMenu = viewChild<ElementRef<HTMLElement>>('prefixMenu');

  readonly prefixes = computed(() => this.store.settings().branchPrefixes);

  readonly preview = computed(() => {
    const raw = this.name().trim().replace(/^\/+|\/+$/g, '');
    if (!raw) {
      if (!this.usePrefix()) return '{name}';
      const p = this.normalizedPrefix();
      return p ? `${p}/{name}` : '{name}';
    }
    if (raw.includes('/')) return raw;
    if (!this.usePrefix()) return raw;
    const p = this.normalizedPrefix();
    return p ? `${p}/${raw}` : raw;
  });

  readonly canCreate = computed(() => {
    const preview = this.preview();
    return !!preview && !preview.includes('{') && !this.busy();
  });

  readonly baseLabel = computed(() => {
    const start = this.store.createBranchStartPoint();
    if (start) return start.slice(0, 7);
    return this.store.status()?.branch || 'HEAD';
  });

  readonly canAddPrefix = computed(() => {
    const cleaned = this.cleanPrefix(this.newPrefix());
    if (!cleaned) return false;
    return !this.prefixes().some((p) => p.toLowerCase() === cleaned.toLowerCase());
  });

  constructor() {
    effect(() => {
      if (!this.store.createBranchDialogOpen()) return;
      const settings = this.store.settings();
      const suggested = this.store.createBranchSuggestedName().trim();
      if (suggested) {
        this.name.set(suggested);
        this.usePrefix.set(false);
      } else {
        this.name.set('');
        this.usePrefix.set(settings.branchPrefixEnabled);
      }
      this.checkout.set(true);
      this.prefix.set(settings.branchPrefix || 'feature');
      this.busy.set(false);
      this.prefixOpen.set(false);
      this.addingPrefix.set(false);
      this.newPrefix.set('');
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeCreateBranchDialog();
  }

  onUsePrefixChange(value: boolean): void {
    this.usePrefix.set(value);
    if (!value) this.prefixOpen.set(false);
    void this.store.saveSettings({ branchPrefixEnabled: value });
  }

  togglePrefixMenu(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.usePrefix()) return;
    const next = !this.prefixOpen();
    this.prefixOpen.set(next);
    if (!next) {
      this.addingPrefix.set(false);
      this.newPrefix.set('');
    }
  }

  selectPrefix(value: string): void {
    const cleaned = this.cleanPrefix(value) || 'feature';
    this.prefix.set(cleaned);
    this.prefixOpen.set(false);
    this.addingPrefix.set(false);
    this.newPrefix.set('');
    void this.store.saveSettings({ branchPrefix: cleaned });
  }

  startAddPrefix(event: MouseEvent): void {
    event.stopPropagation();
    this.addingPrefix.set(true);
    this.newPrefix.set('');
  }

  async addPrefix(): Promise<void> {
    const cleaned = this.cleanPrefix(this.newPrefix());
    if (!cleaned || !this.canAddPrefix()) return;
    const next = [...this.prefixes(), cleaned];
    this.prefix.set(cleaned);
    this.addingPrefix.set(false);
    this.newPrefix.set('');
    this.prefixOpen.set(false);
    await this.store.saveSettings({
      branchPrefix: cleaned,
      branchPrefixes: next,
    });
  }

  async removePrefix(value: string, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    const list = this.prefixes();
    if (list.length <= 1) return;
    const next = list.filter((p) => p !== value);
    const selected = this.prefix() === value ? next[0] : this.prefix();
    this.prefix.set(selected);
    await this.store.saveSettings({
      branchPrefix: selected,
      branchPrefixes: next,
    });
  }

  async submit(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy.set(true);
    try {
      const start = this.store.createBranchStartPoint() ?? undefined;
      const ok = await this.store.createBranch(this.preview(), start, this.checkout());
      if (ok) this.store.closeCreateBranchDialog();
    } finally {
      this.busy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.createBranchDialogOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.prefixOpen()) {
        this.prefixOpen.set(false);
        this.addingPrefix.set(false);
        return;
      }
      this.close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.submit();
    }
  }

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    if (!this.prefixOpen()) return;
    const menu = this.prefixMenu()?.nativeElement;
    if (menu && !menu.contains(event.target as Node)) {
      this.prefixOpen.set(false);
      this.addingPrefix.set(false);
    }
  }

  private normalizedPrefix(): string {
    return this.cleanPrefix(this.prefix());
  }

  private cleanPrefix(value: string): string {
    return value.trim().replace(/^\/+|\/+$/g, '');
  }
}
