import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import type { ReleaseStatusOutput } from '../../../core/models';
import { TauriService } from '../../../core/tauri.service';
import { LoadingBlock } from '../../../shared/ui/loading-block/loading-block';
import { ReleasePanel } from '../release-panel/release-panel';

@Component({
  selector: 'app-release-page',
  imports: [NgIcon, LoadingBlock, ReleasePanel],
  templateUrl: './release-page.html',
  styleUrl: './release-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleasePage {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);

  readonly status = signal<ReleaseStatusOutput | null>(null);
  readonly loading = signal(false);

  readonly hasRepo = computed(() => !!this.store.currentRepo());
  readonly busy = computed(() => this.store.releaseBusy());
  readonly activity = computed(() => this.store.releaseActivity());

  readonly headline = computed(() => {
    const status = this.status();
    if (!status?.available) return 'Release not configured for this repo';
    const version = status.currentVersion;
    const name = status.config?.productName ?? 'App';
    return version ? `${name} · v${version}` : name;
  });

  readonly subtitle = computed(() => {
    const status = this.status();
    if (!this.hasRepo()) return 'Open a repository to ship a version.';
    if (!status) return 'Loading release configuration…';
    if (!status.available) {
      return 'Add release.config.json to enable in-app releases (see release.config.example.jsonc).';
    }
    const branch = status.currentBranch ?? status.config?.branch ?? 'main';
    const dirty = status.dirty ? ' · uncommitted changes' : '';
    return `Configured for branch ${branch}${dirty}. Bump versions, commit, tag, and optionally push.`;
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
        return;
      }
      void this.load(path);
    });
  }

  private async load(path: string): Promise<void> {
    this.loading.set(true);
    try {
      this.status.set(await this.tauri.getReleaseStatus(path));
    } catch {
      this.status.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  startRelease(): void {
    void this.store.startReleaseFlow();
  }
}
