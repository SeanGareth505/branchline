import {
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import type { CommitInfo } from '../../../core/models';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import {
  ChangelogService,
  type ChangelogFormat,
  type ChangelogOptions,
} from '../changelog.service';

@Component({
  selector: 'app-changelog-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './changelog-dialog.html',
  styleUrl: './changelog-dialog.scss',
})
export class ChangelogDialog {
  readonly store = inject(AppStore);
  private readonly changelog = inject(ChangelogService);
  private readonly tauri = inject(TauriService);

  readonly format = signal<ChangelogFormat>('release');
  readonly version = signal('1.0.0');
  readonly title = signal('');
  readonly team = signal('');
  readonly preparedBy = signal('');
  readonly date = signal('');
  readonly includeAuthors = signal(false);
  readonly includeShas = signal(true);
  readonly includeContributors = signal(false);
  readonly excludeMerges = signal(true);
  readonly excludeChores = signal(false);
  readonly fromRef = signal('latest-tag');
  readonly toRef = signal('HEAD');
  readonly copied = signal(false);
  readonly rangeCommits = signal<CommitInfo[]>([]);

  readonly formats: { id: ChangelogFormat; label: string; hint: string }[] = [
    { id: 'release', label: 'Git release', hint: 'Ship notes from commits' },
    { id: 'team', label: 'Team update', hint: 'What shipped & who' },
    { id: 'credits', label: 'Made by', hint: 'Contributors & credits' },
    { id: 'engineering', label: 'Engineering', hint: 'Grouped by commit type' },
    { id: 'plain', label: 'Plain list', hint: 'Simple bullets' },
  ];

  readonly sortedTags = computed(() =>
    this.changelog.sortTagsNewestFirst(this.store.tags(), this.store.commits()),
  );

  readonly fromOptions = computed(() => {
    const tags = this.sortedTags();
    const opts: { id: string; label: string }[] = [
      { id: 'latest-tag', label: tags[0] ? `Latest tag (${tags[0].name})` : 'Latest tag (none)' },
      { id: 'root', label: 'Beginning of history' },
    ];
    if (this.store.compareSha()) {
      opts.push({ id: 'compare', label: `Compare marker (${this.store.compareSha()!.slice(0, 7)})` });
    }
    for (const tag of tags) {
      opts.push({ id: `tag:${tag.name}`, label: `Tag ${tag.name}` });
    }
    return opts;
  });

  readonly toOptions = computed(() => {
    const tags = this.sortedTags();
    const opts: { id: string; label: string }[] = [{ id: 'HEAD', label: 'HEAD (latest)' }];
    if (this.store.selectedSha()) {
      opts.push({
        id: 'selected',
        label: `Selected commit (${this.store.selectedSha()!.slice(0, 7)})`,
      });
    }
    for (const tag of tags) {
      opts.push({ id: `tag:${tag.name}`, label: `Tag ${tag.name}` });
    }
    return opts;
  });

  readonly resolvedRange = computed(() => {
    const commits = this.store.commits();
    const tags = this.store.tags();
    const fromId = this.fromRef();
    const toId = this.toRef();

    let fromSha: string | null = null;
    let fromLabel = 'start';
    if (fromId === 'latest-tag') {
      const tag = this.changelog.latestTag(tags, commits);
      fromSha = tag?.sha ?? null;
      fromLabel = tag?.name ?? 'start';
    } else if (fromId === 'root') {
      fromSha = null;
      fromLabel = 'start';
    } else if (fromId === 'compare') {
      fromSha = this.store.compareSha();
      fromLabel = fromSha ? fromSha.slice(0, 7) : 'compare';
    } else if (fromId.startsWith('tag:')) {
      const name = fromId.slice(4);
      const tag = tags.find((t) => t.name === name);
      fromSha = tag?.sha ?? null;
      fromLabel = name;
    }

    let toSha: string | null = null;
    let toLabel = 'HEAD';
    if (toId === 'HEAD') {
      toSha = null;
      toLabel = 'HEAD';
    } else if (toId === 'selected') {
      toSha = this.store.selectedSha();
      toLabel = toSha ? toSha.slice(0, 7) : 'selected';
    } else if (toId.startsWith('tag:')) {
      const name = toId.slice(4);
      const tag = tags.find((t) => t.name === name);
      toSha = tag?.sha ?? null;
      toLabel = name;
    }

    return { fromSha, toSha, fromLabel, toLabel };
  });

  readonly options = computed<ChangelogOptions>(() => ({
    format: this.format(),
    version: this.version(),
    title: this.title(),
    team: this.team(),
    preparedBy: this.preparedBy(),
    includeAuthors: this.includeAuthors(),
    includeShas: this.includeShas(),
    includeContributors: this.includeContributors(),
    excludeMerges: this.excludeMerges(),
    excludeChores: this.excludeChores(),
    date: this.date(),
  }));

  readonly result = computed(() => {
    const range = this.resolvedRange();
    return this.changelog.generate(
      this.rangeCommits(),
      this.options(),
      range.fromLabel,
      range.toLabel,
    );
  });

  readonly stats = computed(() => {
    const items = this.result().commits;
    const sections = new Map<string, number>();
    for (const item of items) {
      sections.set(item.section, (sections.get(item.section) ?? 0) + 1);
    }
    return {
      total: items.length,
      breaking: items.filter((i) => i.breaking).length,
      sections: [...sections.entries()].sort((a, b) => b[1] - a[1]),
    };
  });

  readonly previewName = computed(() => {
    switch (this.format()) {
      case 'team':
        return 'TEAM-UPDATE.md';
      case 'credits':
        return 'CREDITS.md';
      case 'engineering':
        return 'CHANGELOG-engineering.md';
      case 'plain':
        return 'changes.txt';
      default:
        return 'CHANGELOG.md';
    }
  });

  constructor() {
    effect(() => {
      if (!this.store.changelogModalOpen()) return;
      this.bootstrap();
    });

    effect(() => {
      if (!this.store.changelogModalOpen()) return;
      const range = this.resolvedRange();
      void this.loadRange(range.fromSha, range.toSha);
    });
  }

  close(): void {
    this.store.closeChangelogModal();
    this.copied.set(false);
  }

  setFormat(format: ChangelogFormat): void {
    this.format.set(format);
    const v = this.version().trim();
    const team = this.team().trim();
    if (format === 'team') {
      this.includeAuthors.set(true);
      this.includeContributors.set(true);
      this.includeShas.set(false);
      if (!this.title().trim()) {
        this.title.set(team ? `${team} update` : v ? `Team update · ${v}` : 'Team update');
      }
    } else if (format === 'credits') {
      this.includeAuthors.set(true);
      this.includeContributors.set(true);
      this.includeShas.set(false);
      if (!this.title().trim() || this.title().startsWith('Team update') || this.title().startsWith('Release')) {
        this.title.set(v ? `Made by · ${v}` : 'Made by');
      }
    } else if (format === 'release') {
      this.includeShas.set(true);
      this.includeAuthors.set(false);
      this.includeContributors.set(false);
      this.title.set('');
    } else if (format === 'engineering') {
      this.includeShas.set(true);
      this.includeAuthors.set(true);
      this.includeContributors.set(true);
      this.title.set('');
    } else {
      this.includeShas.set(false);
      this.includeAuthors.set(true);
      this.includeContributors.set(false);
      this.title.set('');
    }
  }

  async copy(): Promise<void> {
    const text = this.result().markdown;
    if (!text.trim()) {
      this.store.showWarning('Nothing to copy');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      this.store.showSuccess('Changelog copied');
      window.setTimeout(() => this.copied.set(false), 1600);
    } catch {
      this.store.showError('Could not copy to clipboard');
    }
  }

  async download(): Promise<void> {
    const text = this.result().markdown;
    if (!text.trim()) {
      this.store.showWarning('Nothing to download');
      return;
    }
    const version = this.version().trim() || 'changelog';
    const safe = version.replace(/[^\w.-]+/g, '-');
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.previewName().replace(/\.[^.]+$/, '')}-${safe}.md`;
    a.click();
    URL.revokeObjectURL(url);
    this.store.showSuccess('Changelog downloaded');
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.changelogModalOpen()) return;
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.copy();
    }
  }

  private bootstrap(): void {
    const commits = this.store.commits();
    const tags = this.store.tags();
    this.date.set(this.changelog.todayIso());
    this.version.set(this.changelog.suggestVersion(tags, commits));
    this.title.set('');
    this.team.set('');
    this.preparedBy.set(this.store.identity()?.name?.trim() ?? '');
    this.format.set('release');
    this.includeAuthors.set(false);
    this.includeShas.set(true);
    this.includeContributors.set(false);
    this.copied.set(false);

    const compare = this.store.compareSha();
    const selected = this.store.selectedSha();
    if (compare && selected) {
      this.fromRef.set('compare');
      this.toRef.set('selected');
    } else if (this.changelog.latestTag(tags, commits)) {
      this.fromRef.set('latest-tag');
      this.toRef.set('HEAD');
    } else {
      this.fromRef.set('root');
      this.toRef.set('HEAD');
    }
  }

  private async loadRange(fromSha: string | null, toSha: string | null): Promise<void> {
    const path = this.store.currentRepo()?.path;
    if (!path) {
      this.rangeCommits.set([]);
      return;
    }
    try {
      const commits = await this.tauri.getCommitRange(path, fromSha, toSha || 'HEAD', 500);
      this.rangeCommits.set(commits);
    } catch {
      this.rangeCommits.set(this.changelog.commitsBetween(this.store.commits(), fromSha, toSha));
    }
  }
}
