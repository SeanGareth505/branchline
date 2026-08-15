import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { sanitizeBranchName } from '../../../core/workflow-placeholders';

type FlowKind = 'feature' | 'release' | 'hotfix';
type FlowAction = 'start' | 'finish';

@Component({
  selector: 'app-git-flow-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './git-flow-dialog.html',
  styleUrl: './git-flow-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitFlowDialog {
  readonly store = inject(AppStore);
  readonly kind = signal<FlowKind>('feature');
  readonly action = signal<FlowAction>('start');
  readonly name = signal('');
  readonly deleteBranch = signal(true);
  readonly tag = signal(true);
  readonly push = signal(false);
  readonly busy = signal(false);
  private primed = false;

  readonly hasRemote = computed(() => this.store.remotes().length > 0);

  readonly preview = computed(() => {
    const raw = sanitizeBranchName(this.name());
    if (!raw) return `${this.kind()}/{name}`;
    if (raw.includes('/')) return raw;
    return `${this.kind()}/${raw}`;
  });

  readonly canSubmit = computed(() => {
    const preview = this.preview();
    return !!preview && !preview.includes('{') && !this.busy();
  });

  readonly submitLabel = computed(() => {
    if (this.busy()) return this.action() === 'start' ? 'Starting…' : 'Finishing…';
    return this.action() === 'start' ? 'Start' : 'Finish';
  });

  constructor() {
    effect(() => {
      const open = this.store.gitFlowDialogOpen();
      if (!open) {
        this.primed = false;
        return;
      }
      if (this.primed) return;
      this.primed = true;
      const branch = this.store.status()?.branch ?? '';
      const kind = this.kindFromBranch(branch);
      this.kind.set(kind ?? 'feature');
      this.action.set(kind ? 'finish' : 'start');
      this.name.set(kind ? this.stripPrefix(branch, kind) : '');
      this.deleteBranch.set(true);
      this.tag.set(true);
      this.push.set(this.hasRemote());
      this.busy.set(false);
    });
  }

  close(): void {
    if (this.busy()) return;
    this.store.closeGitFlowDialog();
  }

  setKind(kind: FlowKind): void {
    this.kind.set(kind);
  }

  setAction(action: FlowAction): void {
    this.action.set(action);
  }

  onNameChange(value: string): void {
    this.name.set(sanitizeBranchName(value));
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.busy.set(true);
    try {
      const ok = await this.store.runGitFlow({
        kind: this.kind(),
        action: this.action(),
        name: this.preview(),
        deleteBranch: this.deleteBranch(),
        tag: this.kind() !== 'feature' && this.tag(),
        push: this.push() && this.hasRemote(),
      });
      if (ok) this.store.closeGitFlowDialog();
    } finally {
      this.busy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.gitFlowDialogOpen()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.submit();
    }
  }

  private kindFromBranch(branch: string): FlowKind | null {
    if (branch.startsWith('feature/')) return 'feature';
    if (branch.startsWith('release/')) return 'release';
    if (branch.startsWith('hotfix/')) return 'hotfix';
    return null;
  }

  private stripPrefix(branch: string, kind: FlowKind): string {
    return branch.startsWith(`${kind}/`) ? branch.slice(kind.length + 1) : branch;
  }
}
