import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { format } from 'date-fns';
import type { RepoReleaseApp, RepoReleaseEvent } from '../../../core/models';

@Component({
  selector: 'app-release-apps',
  imports: [NgIcon],
  templateUrl: './release-apps.html',
  styleUrl: './release-apps.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseApps {
  readonly apps = input<RepoReleaseApp[]>([]);
  readonly selectedId = input<string | null>(null);
  readonly loading = input(false);
  readonly message = input('');
  readonly selectApp = output<string>();
  readonly openEvent = output<RepoReleaseEvent>();
  readonly openWorkflow = output<RepoReleaseApp>();

  readonly selected = computed(() => {
    const id = this.selectedId();
    const apps = this.apps();
    return apps.find((app) => app.id === id) ?? apps[0] ?? null;
  });

  statusLabel(status: string): string {
    if (status === 'success') return 'Live';
    if (status === 'failure') return 'Failed';
    if (status === 'pending') return 'Running';
    return 'Unknown';
  }

  kindLabel(kind: string): string {
    return kind === 'tag' ? 'Tag' : 'Deploy';
  }

  whenLabel(value: string | null | undefined): string {
    if (!value?.trim()) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return format(date, 'd MMM yyyy, HH:mm');
  }

  statusIcon(status: string): string {
    if (status === 'success') return 'lucideCheck';
    if (status === 'failure') return 'lucideX';
    if (status === 'pending') return 'lucideRefreshCw';
    return 'lucideCircleAlert';
  }
}
