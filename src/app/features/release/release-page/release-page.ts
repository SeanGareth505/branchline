import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type {
  ReleaseSetupFileHint,
  ReleaseSetupHintsOutput,
  ReleaseStatusOutput,
} from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';
import { ReleasePanel } from '../release-panel/release-panel';

@Component({
  selector: 'app-release-page',
  imports: [FormsModule, NgIcon, LoadingBlock, ReleasePanel],
  templateUrl: './release-page.html',
  styleUrl: './release-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleasePage {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);

  readonly status = signal<ReleaseStatusOutput | null>(null);
  readonly setupHints = signal<ReleaseSetupHintsOutput | null>(null);
  readonly loading = signal(false);
  readonly setupBusy = signal(false);

  readonly productName = signal('');
  readonly branch = signal('main');
  readonly pushDefault = signal(true);
  readonly selectedFiles = signal<Record<string, boolean>>({});

  readonly hasRepo = computed(() => !!this.store.currentRepo());
  readonly busy = computed(() => this.store.releaseBusy());
  readonly activity = computed(() => this.store.releaseActivity());

  readonly configured = computed(() => !!this.status()?.available);

  readonly headline = computed(() => {
    const status = this.status();
    if (!status?.available) return 'Set up release for this repo';
    const version = status.currentVersion;
    const name = status.config?.productName ?? 'App';
    return version ? `${name} · v${version}` : name;
  });

  readonly subtitle = computed(() => {
    const activity = this.activity();
    if (
      activity?.phase === 'done' &&
      activity.ok !== false &&
      !activity.needsPush &&
      (activity.willPush || !!activity.releaseUrl)
    ) {
      return 'Waiting for users to get the update banner (next app launch/check)';
    }
    const status = this.status();
    if (!this.hasRepo()) return 'Open a repository to ship a version.';
    if (!status) return 'Loading release configuration…';
    if (!status.available) {
      return 'Configure release once for this project, then bump, commit, tag, push, and track CI from here.';
    }
    const branch = status.currentBranch ?? status.config?.branch ?? 'main';
    const dirty = status.dirty ? ' · uncommitted changes' : '';
    const push = status.config?.pushDefault ? ' · auto push & deploy' : '';
    return `Configured for branch ${branch}${dirty}${push}.`;
  });

  readonly selectedFileList = computed(() => {
    const hints = this.setupHints()?.suggestedFiles ?? [];
    const selected = this.selectedFiles();
    return hints.filter((file) => selected[file.path]);
  });

  readonly canSaveSetup = computed(() => {
    return !!this.productName().trim() && !!this.branch().trim() && this.selectedFileList().length > 0;
  });

  constructor() {
    effect(() => {
      const view = this.store.view();
      const path = this.store.currentRepo()?.path;
      if (view !== 'release') {
        return;
      }
      if (!path) {
        this.status.set(null);
        this.setupHints.set(null);
        return;
      }
      void this.load(path);
    });
  }

  private async load(path: string): Promise<void> {
    this.loading.set(true);
    try {
      const status = await this.tauri.getReleaseStatus(path);
      this.status.set(status);
      if (!status.available) {
        const hints = await this.tauri.getReleaseSetupHints(path);
        this.setupHints.set(hints);
        this.productName.set(hints.productName);
        this.branch.set(hints.branch);
        this.pushDefault.set(hints.pushDefault);
        const selected: Record<string, boolean> = {};
        for (const file of hints.suggestedFiles) {
          selected[file.path] = true;
        }
        this.selectedFiles.set(selected);
      } else {
        this.setupHints.set(null);
      }
    } catch {
      this.status.set(null);
      this.setupHints.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  setFileSelected(path: string, selected: boolean): void {
    this.selectedFiles.update((current) => ({
      ...current,
      [path]: selected,
    }));
  }

  async saveSetup(): Promise<void> {
    if (!this.canSaveSetup() || this.setupBusy()) return;
    this.setupBusy.set(true);
    try {
      const ok = await this.store.saveReleaseSetup({
        productName: this.productName().trim(),
        branch: this.branch().trim(),
        push: this.pushDefault(),
        files: this.selectedFileList(),
      });
      if (!ok) return;
      const path = this.store.currentRepo()?.path;
      if (path) {
        await this.load(path);
      }
    } finally {
      this.setupBusy.set(false);
    }
  }

  startRelease(): void {
    void this.store.startReleaseFlow();
  }
}
