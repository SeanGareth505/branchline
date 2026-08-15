import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { AppStore } from '../../../core/app.store';
import { GitAccountBar } from '../git-account-bar/git-account-bar';
import { remoteProtocol } from '../../../shared/git/repo-links';

@Component({
  selector: 'app-remotes-panel',
  imports: [FormsModule, NgIcon, HelpTip, GitAccountBar],
  templateUrl: './remotes-panel.html',
  styleUrl: './remotes-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RemotesPanel {
  readonly store = inject(AppStore);
  readonly filter = input('');
  readonly expanded = input(false);
  readonly expandedChange = output<boolean>();
  readonly hide = output<void>();
  readonly drafting = signal(false);
  readonly name = signal('origin');
  readonly url = signal('');
  readonly testingName = signal<string | null>(null);

  readonly filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const remotes = this.store.remotes();
    if (!q) return remotes;
    return remotes.filter(
      (r) => r.name.toLowerCase().includes(q) || r.fetchUrl.toLowerCase().includes(q),
    );
  });

  readonly open = computed(() => {
    if (this.filter().trim()) return this.filtered().length > 0 || this.drafting();
    return this.expanded() || this.drafting();
  });

  toggle(event?: Event): void {
    event?.stopPropagation();
    if (this.filter().trim()) return;
    this.expandedChange.emit(!this.expanded());
  }

  chevron(): string {
    return this.open() ? 'lucideChevronDown' : 'lucideChevronRight';
  }

  protocolLabel(url: string): string {
    const protocol = remoteProtocol(url);
    if (protocol === 'other') return '';
    return protocol.toUpperCase();
  }

  requestHide(event?: Event): void {
    event?.stopPropagation();
    this.hide.emit();
  }

  startAdd(event?: Event): void {
    event?.stopPropagation();
    this.drafting.set(true);
    this.name.set(this.store.remotes().length ? '' : 'origin');
    this.url.set('');
    if (!this.expanded()) this.expandedChange.emit(true);
  }

  publish(event?: Event): void {
    event?.stopPropagation();
    this.store.openPublishGithubDialog();
  }

  async add(): Promise<void> {
    const name = this.name().trim();
    const url = this.url().trim();
    if (!name || !url) return;
    await this.store.addRemote(name, url);
    this.drafting.set(false);
  }

  async remove(name: string): Promise<void> {
    await this.store.removeRemote(name);
  }

  async test(name: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    if (this.testingName()) return;
    const remote = this.store.remotes().find((r) => r.name === name);
    this.testingName.set(name);
    try {
      await this.store.testConnection({
        kind: 'gitRemote',
        remote: name,
        url: remote?.fetchUrl,
      });
    } finally {
      this.testingName.set(null);
    }
  }
}
