import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

export type HelpTopicId =
  | 'overview'
  | 'repos'
  | 'browse'
  | 'branches'
  | 'graph'
  | 'changes'
  | 'sync'
  | 'prs'
  | 'release'
  | 'integrations'
  | 'advanced'
  | 'settings'
  | 'shortcuts';

@Component({
  selector: 'app-help-page',
  imports: [],
  templateUrl: './help-page.html',
  styleUrl: './help-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpPage {
  readonly activeTopic = signal<HelpTopicId>('overview');

  readonly topics: { id: HelpTopicId; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'repos', label: 'Repositories' },
    { id: 'browse', label: 'Repo view' },
    { id: 'branches', label: 'Branches & refs' },
    { id: 'graph', label: 'Commit graph' },
    { id: 'changes', label: 'Commits & changes' },
    { id: 'sync', label: 'Fetch, pull & push' },
    { id: 'prs', label: 'Pull requests' },
    { id: 'release', label: 'Release' },
    { id: 'integrations', label: 'Connections' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'settings', label: 'Settings' },
    { id: 'shortcuts', label: 'Shortcuts' },
  ];

  scrollTo(id: HelpTopicId): void {
    this.activeTopic.set(id);
    document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}
