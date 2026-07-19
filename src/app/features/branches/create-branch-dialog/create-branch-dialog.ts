import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-create-branch-dialog',
  imports: [FormsModule, NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './create-branch-dialog.html',
  styleUrl: './create-branch-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateBranchDialog {
  readonly store = inject(AppStore);
  readonly name = signal('');
  readonly checkout = signal(true);
  readonly push = signal(true);
  readonly usePrefix = signal(true);
  readonly prefix = signal('feature');
  readonly busy = signal(false);
  readonly prefixOpen = signal(false);
  readonly addingPrefix = signal(false);
  readonly newPrefix = signal('');
  readonly startRef = signal('');
  readonly startOpen = signal(false);
  readonly startQuery = signal('');

  readonly prefixMenuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
  ];

  readonly startMenuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
  ];

  readonly prefixes = computed(() => this.store.settings().branchPrefixes);

  readonly currentBranch = computed(() => {
    const status = this.store.status();
    if (!status || status.isDetached) return null;
    return status.branch || null;
  });

  readonly startOptions = computed(() => {
    const q = this.startQuery().trim().toLowerCase();
    const current = this.currentBranch();
    const selected = this.startRef();
    const locals = this.store.localBranches();
    const remotes = this.store.branches().filter((b) => b.isRemote);
    const options: { value: string; label: string; kind: 'local' | 'remote' | 'commit'; current: boolean }[] =
      [];

    if (selected && /^[0-9a-f]{7,40}$/i.test(selected) && !locals.some((b) => b.name === selected)) {
      options.push({
        value: selected,
        label: selected.slice(0, 7),
        kind: 'commit',
        current: false,
      });
    }

    for (const branch of locals) {
      if (q && !branch.name.toLowerCase().includes(q)) continue;
      options.push({
        value: branch.name,
        label: branch.name,
        kind: 'local',
        current: branch.name === current || branch.isCurrent,
      });
    }

    for (const branch of remotes) {
      if (q && !branch.name.toLowerCase().includes(q)) continue;
      options.push({
        value: branch.name,
        label: branch.name,
        kind: 'remote',
        current: false,
      });
    }

    return options;
  });

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
    return !!preview && !preview.includes('{') && !this.busy() && !!this.startRef();
  });

  readonly baseLabel = computed(() => {
    const start = this.startRef();
    if (/^[0-9a-f]{7,40}$/i.test(start)) return start.slice(0, 7);
    return start || this.currentBranch() || 'HEAD';
  });

  readonly startIsCurrent = computed(() => {
    const current = this.currentBranch();
    return !!current && this.startRef() === current;
  });

  readonly canAddPrefix = computed(() => {
    const cleaned = this.cleanPrefix(this.newPrefix());
    if (!cleaned) return false;
    return !this.prefixes().some((p) => p.toLowerCase() === cleaned.toLowerCase());
  });

  readonly hasRemote = computed(() => this.store.remotes().length > 0);

  readonly submitLabel = computed(() => {
    if (this.busy()) {
      return this.push() && this.hasRemote() ? 'Creating & pushing…' : 'Creating…';
    }
    return this.push() && this.hasRemote() ? 'Create & push' : 'Create branch';
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
      this.push.set(this.store.remotes().length > 0);
      this.prefix.set(settings.branchPrefix || 'feature');
      this.busy.set(false);
      this.prefixOpen.set(false);
      this.addingPrefix.set(false);
      this.newPrefix.set('');
      this.startOpen.set(false);
      this.startQuery.set('');
      const passed = this.store.createBranchStartPoint();
      this.startRef.set(passed || this.currentBranch() || 'HEAD');
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeCreateBranchDialog();
  }

  onUsePrefixChange(value: boolean): void {
    this.usePrefix.set(value);
    if (!value) this.closePrefixMenu();
    void this.store.saveSettings({ branchPrefixEnabled: value });
  }

  togglePrefixMenu(event: MouseEvent): void {
    event.stopPropagation();
    if (!this.usePrefix()) return;
    if (this.prefixOpen()) {
      this.closePrefixMenu();
      return;
    }
    this.closeStartMenu();
    this.prefixOpen.set(true);
  }

  closePrefixMenu(): void {
    this.prefixOpen.set(false);
    this.addingPrefix.set(false);
    this.newPrefix.set('');
  }

  selectPrefix(value: string): void {
    const cleaned = this.cleanPrefix(value) || 'feature';
    this.prefix.set(cleaned);
    this.closePrefixMenu();
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
    this.closePrefixMenu();
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

  toggleStartMenu(event: MouseEvent): void {
    event.stopPropagation();
    if (this.startOpen()) {
      this.closeStartMenu();
      return;
    }
    this.closePrefixMenu();
    this.startQuery.set('');
    this.startOpen.set(true);
  }

  closeStartMenu(): void {
    this.startOpen.set(false);
    this.startQuery.set('');
  }

  selectStart(value: string): void {
    this.startRef.set(value);
    this.closeStartMenu();
  }

  async submit(): Promise<void> {
    if (!this.canCreate()) return;
    this.busy.set(true);
    try {
      const start = this.startRef().trim() || undefined;
      const ok = await this.store.createBranch(this.preview(), start, this.checkout(), {
        push: this.push() && this.hasRemote(),
      });
      if (ok) this.store.closeCreateBranchDialog(true);
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
        this.closePrefixMenu();
        return;
      }
      if (this.startOpen()) {
        this.closeStartMenu();
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

  private normalizedPrefix(): string {
    return this.cleanPrefix(this.prefix());
  }

  private cleanPrefix(value: string): string {
    return value.trim().replace(/^\/+|\/+$/g, '');
  }
}
