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
  ReleaseSetupHintsOutput,
  ReleaseStatusOutput,
} from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { ReleasePanel } from '../release-panel/release-panel';

@Component({
  selector: 'app-release-page',
  imports: [FormsModule, NgIcon, LoadingBlock, HelpTip, ReleasePanel],
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
  readonly findingLatest = signal(false);

  readonly productName = signal('');
  readonly branch = signal('main');
  readonly pushDefault = signal(true);
  readonly selectedFiles = signal<Record<string, boolean>>({});
  readonly loadError = signal<string | null>(null);

  readonly hasRepo = computed(() => !!this.store.currentRepo());
  readonly busy = computed(() => this.store.releaseBusy());
  readonly activity = computed(() => this.store.releaseActivity());
  readonly configured = computed(() => !!this.status()?.available);

  readonly subtitle = computed(() => {
    const activity = this.activity();
    if (
      activity?.phase === 'done' &&
      activity.ok !== false &&
      !activity.needsPush &&
      !activity.needsRefresh &&
      (activity.willPush || !!activity.releaseUrl)
    ) {
      return `${activity.productName} ${activity.nextVersion} is on GitHub. Users see the update on next launch.`;
    }
    if (activity?.needsRefresh) {
      return activity.message || 'Refresh to keep watching the installer builds.';
    }
    if (
      activity &&
      !activity.needsPush &&
      (activity.phase === 'deploying' || activity.phase === 'ci' || activity.phase === 'publishing') &&
      !(activity.deployJobs ?? []).length
    ) {
      return 'Tag is on origin. Waiting for GitHub to report installer jobs.';
    }
    if (activity?.phase === 'error') {
      return activity.message || 'The last release failed.';
    }
    if (activity && this.busy()) {
      return `${activity.productName} ${activity.currentVersion} → ${activity.nextVersion}`;
    }
    const status = this.status();
    if (!this.hasRepo()) return 'Open a repository to ship a version.';
    if (this.loadError()) return this.loadError();
    if (!status) return 'Loading…';
    if (!status.available) {
      return 'Tell Branchline which files hold the version, then you can ship from here.';
    }
    const name = status.config?.productName ?? 'App';
    const version = status.currentVersion ? `v${status.currentVersion}` : 'no version yet';
    const branch = status.currentBranch ?? status.config?.branch ?? 'main';
    const dirty = status.dirty ? ' · uncommitted changes' : '';
    return `${name} · ${version} on ${branch}${dirty}`;
  });

  readonly selectedFileList = computed(() => {
    const hints = this.setupHints()?.suggestedFiles ?? [];
    const selected = this.selectedFiles();
    return hints.filter((file) => selected[file.path]);
  });

  readonly canSaveSetup = computed(() => {
    return !!this.productName().trim() && !!this.branch().trim() && this.selectedFileList().length > 0;
  });

  private loadGen = 0;

  constructor() {
    effect(() => {
      const view = this.store.view();
      const path = this.store.currentRepo()?.path;
      if (view !== 'release') {
        this.loadGen += 1;
        return;
      }
      if (!path) {
        this.status.set(null);
        this.setupHints.set(null);
        this.loadError.set(null);
        return;
      }
      void this.load(path);
    });

    effect(() => {
      const activity = this.activity();
      const path = this.store.currentRepo()?.path;
      if (!path || this.store.view() !== 'release') return;
      if (activity?.phase !== 'done' && activity?.phase !== 'error') return;
      void this.load(path);
    });
  }

  private async load(path: string): Promise<void> {
    const gen = ++this.loadGen;
    const blocking = !this.status() && !this.activity();
    if (blocking) this.loading.set(true);
    this.loadError.set(null);
    try {
      const status = await this.tauri.getReleaseStatus(path);
      if (gen !== this.loadGen || this.store.view() !== 'release') return;
      this.status.set(status);
      if (!status.available) {
        const hints = await this.tauri.getReleaseSetupHints(path);
        if (gen !== this.loadGen || this.store.view() !== 'release') return;
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
        void this.store.attachLatestRelease();
      }
    } catch (err) {
      if (gen !== this.loadGen) return;
      this.status.set(null);
      this.setupHints.set(null);
      this.loadError.set(this.store.formatError(err));
    } finally {
      if (gen === this.loadGen) this.loading.set(false);
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

  async trackLatest(): Promise<void> {
    if (this.findingLatest()) return;
    this.findingLatest.set(true);
    try {
      await this.store.attachLatestRelease({ force: true });
    } finally {
      this.findingLatest.set(false);
    }
  }

  retry(): void {
    const path = this.store.currentRepo()?.path;
    if (path) void this.load(path);
  }
}
