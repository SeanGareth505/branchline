import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AngularSplitModule } from 'angular-split';
import { NgIcon } from '@ng-icons/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import type { CommitShortcutId, FileStatusEntry, FileStatusKind, TemplateInfo } from '../../../core/models';
import { AppStore } from '../../../core/app.store';
import {
  DEFAULT_COMMIT_TYPES,
  formatConventionalHead,
  lintConventionalMessage,
  mergeCommitTypes,
  normalizeCommitTypeId,
  parseConventionalSubject,
  suggestCommitType,
} from '../../../core/commit-types';
import { extractBranchTopic, extractTicketFromBranch } from '../../../shared/git/ticket-from-branch';
import {
  orderByCommitShortcutSequence,
  recordCommitShortcut,
} from '../../../shared/git/commit-shortcuts';
import { TauriService } from '../../../core/tauri.service';
import { PromptService } from '../../../shared/ui/prompt-dialog/prompt.service';
import { Spinner } from '../../../shared/ui/spinner/spinner';
import {
  PatchLinesView,
  type PatchLinesLayout,
  type PatchLinesMode,
} from '../../diff/patch-lines-view/patch-lines-view';
import { CommitChecks } from '../commit-checks/commit-checks';

type FileKey = `${'s' | 'u' | 'c'}:${string}`;
type CommitPhase = 'checking' | 'staging' | 'committing' | 'pushing';

@Component({
  selector: 'app-commit-dialog',
  imports: [FormsModule, AngularSplitModule, NgIcon, PatchLinesView, Spinner, CommitChecks],
  templateUrl: './commit-dialog.html',
  styleUrl: './commit-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommitDialog {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);
  private readonly prompts = inject(PromptService);
  private readonly commitChecks = viewChild(CommitChecks);

  readonly subject = signal('');
  readonly body = signal('');
  readonly amend = signal(false);
  readonly signOff = signal(false);
  readonly pushAfter = signal(true);
  readonly commitType = signal('');
  readonly scope = signal('');
  readonly breaking = signal(false);
  private readonly scopeManual = signal(false);
  private readonly sessionSequence = signal<CommitShortcutId[]>([]);
  readonly fileFilter = signal('');
  readonly selectedPath = signal<string | null>(null);
  readonly selectedStaged = signal(false);
  readonly patch = signal('');
  readonly templates = signal<TemplateInfo[]>([]);
  readonly identity = signal<{ name: string; email: string } | null>(null);
  readonly committing = signal(false);
  readonly commitPhase = signal<CommitPhase | null>(null);
  readonly filesBusy = signal(false);
  readonly addingType = signal(false);
  readonly newTypeDraft = signal('');
  readonly savingType = signal(false);
  readonly focusPane = signal<'unstaged' | 'staged' | 'conflicted'>('unstaged');
  readonly selectedFiles = signal<Set<FileKey>>(new Set());
  readonly diffLayout = signal<PatchLinesLayout>('unified');
  private lastFileIndex: { pane: 'unstaged' | 'staged' | 'conflicted'; index: number } | null =
    null;

  readonly suggestedTicket = computed(() => {
    const picked = this.store.activeJiraKey()?.trim();
    if (picked) return picked;
    return extractTicketFromBranch(
      this.store.status()?.branch ?? '',
      this.store.settings().ticketFromBranch,
    );
  });

  readonly suggestedTopic = computed(() =>
    extractBranchTopic(this.store.status()?.branch ?? '', this.suggestedTicket()),
  );

  readonly jiraKeyHint = computed(() => this.suggestedTicket());

  readonly usesCommitlint = computed(() =>
    (this.store.repoChecks()?.checks ?? []).some(
      (c) => c.trigger === 'commit-msg' && /commitlint/i.test(`${c.command} ${c.name}`),
    ),
  );

  readonly suggestedType = computed(() => {
    const status = this.store.status();
    return suggestCommitType({
      branch: status?.branch ?? '',
      files: [
        ...(status?.staged ?? []),
        ...(status?.unstaged ?? []),
        ...(status?.untracked ?? []),
      ],
    });
  });

  readonly types = computed(() => {
    const configured = this.usesCommitlint()
      ? mergeCommitTypes(this.store.settings().commitTypes, DEFAULT_COMMIT_TYPES)
      : this.store.settings().commitTypes;
    const current = this.commitType();
    if (current && !configured.some((t) => t.id === current)) {
      return [...configured, { id: current, label: current, description: '' }];
    }
    return configured;
  });

  readonly staged = computed(() => this.filterFiles(this.store.status()?.staged ?? []));
  readonly unstaged = computed(() =>
    this.filterFiles([
      ...(this.store.status()?.unstaged ?? []),
      ...(this.store.status()?.untracked ?? []),
    ]),
  );
  readonly conflicted = computed(() => this.filterFiles(this.store.status()?.conflicted ?? []));

  readonly stagedCount = computed(() => this.store.status()?.staged.length ?? 0);
  readonly unstagedCount = computed(
    () =>
      (this.store.status()?.unstaged.length ?? 0) + (this.store.status()?.untracked.length ?? 0),
  );
  readonly conflictedCount = computed(() => this.store.status()?.conflicted.length ?? 0);

  readonly operationLabel = computed(() => {
    const label = this.store.status()?.operation?.label ?? '';
    const cleaned = label.replace(/ in progress$/i, '').trim().toLowerCase();
    return cleaned || 'the operation';
  });

  readonly unstagedSelectedCount = computed(
    () => [...this.selectedFiles()].filter((k) => k.startsWith('u:')).length,
  );
  readonly stagedSelectedCount = computed(
    () => [...this.selectedFiles()].filter((k) => k.startsWith('s:')).length,
  );
  readonly conflictedSelectedCount = computed(
    () => [...this.selectedFiles()].filter((k) => k.startsWith('c:')).length,
  );

  readonly linesMode = computed((): PatchLinesMode =>
    this.selectedStaged() ? 'staged' : 'unstaged',
  );

  readonly messagePreview = computed(() => {
    const subject = this.subject().trim();
    const type = this.commitType();
    const head = type
      ? formatConventionalHead({
          type,
          scope: this.scope(),
          breaking: this.breaking(),
          subject,
        })
      : subject;
    const body = this.body().trim();
    let msg = head;
    if (body) msg = `${head}\n\n${body}`;
    if (this.signOff() && this.identity()) {
      const id = this.identity()!;
      msg = `${msg}\n\nSigned-off-by: ${id.name} <${id.email}>`;
    }
    return msg;
  });

  readonly canCommit = computed(() => {
    if (this.conflictedCount() > 0) return false;
    if (!this.messagePreview().trim()) return false;
    if (this.lintIssues().some((i) => i.level === 'error')) return false;
    return true;
  });

  readonly commitBlockedReason = computed(() => {
    if (this.conflictedCount() > 0) return 'Resolve conflicts before committing';
    if (!this.messagePreview().trim()) return 'Write a commit message';
    const lintError = this.lintIssues().find((i) => i.level === 'error');
    if (lintError) return lintError.message;
    return null;
  });

  readonly isBusy = computed(() => this.committing() || this.filesBusy());

  readonly checkTriggers = computed(() => {
    const triggers = ['pre-commit', 'commit-msg'];
    if (this.pushAfter()) triggers.push('pre-push');
    return triggers;
  });

  readonly busyLabel = computed(() => {
    const phase = this.commitPhase();
    if (phase === 'checking') return 'Running checks…';
    if (phase === 'staging') return 'Staging files…';
    if (phase === 'committing') return this.amend() ? 'Amending commit…' : 'Creating commit…';
    if (phase === 'pushing') return 'Pushing to remote…';
    if (this.filesBusy()) return 'Updating staged files…';
    return null;
  });

  readonly commitButtonLabel = computed(() => {
    const phase = this.commitPhase();
    if (phase === 'checking') return 'Checking…';
    if (phase === 'staging') return 'Staging…';
    if (phase === 'committing') return this.amend() ? 'Amending…' : 'Committing…';
    if (phase === 'pushing') return 'Pushing…';
    return this.amend() ? 'Amend' : 'Commit';
  });

  readonly charHint = computed(() => {
    const subject = this.subject().trim();
    const type = this.commitType();
    const line = type
      ? formatConventionalHead({
          type,
          scope: this.scope(),
          breaking: this.breaking(),
          subject,
        })
      : subject;
    const len = line.length;
    const max = this.usesCommitlint() ? 100 : 72;
    if (!subject) return this.usesCommitlint() ? 'Lowercase summary, like add login' : 'Write a short summary';
    if (len <= 50) return `${len}/50 ideal`;
    if (len <= 72) return `${len}/72 ok`;
    if (len <= max) return `${len}/${max}`;
    return `${len} chars — shorten to ${max}`;
  });

  readonly headlineTooLong = computed(() => {
    const subject = this.subject().trim();
    if (!subject) return false;
    const type = this.commitType();
    const line = type
      ? formatConventionalHead({
          type,
          scope: this.scope(),
          breaking: this.breaking(),
          subject,
        })
      : subject;
    return line.length > (this.usesCommitlint() ? 100 : 72);
  });

  readonly lintIssues = computed(() => {
    const requireType = this.usesCommitlint() || !!this.commitType();
    if (!requireType && !this.subject().trim()) return [];
    return lintConventionalMessage(this.messagePreview(), {
      requireType,
      types: this.types(),
    });
  });

  readonly hasLintError = computed(() => this.lintIssues().some((i) => i.level === 'error'));

  readonly canAddType = computed(() => !!normalizeCommitTypeId(this.newTypeDraft()));

  readonly scopeWidthCh = computed(() => {
    const n = Math.max(this.scope().length, this.suggestedTicket()?.length ?? 0, 7);
    return Math.min(24, n + 1);
  });

  readonly ticketFromBranch = computed(
    () =>
      extractTicketFromBranch(
        this.store.status()?.branch ?? '',
        this.store.settings().ticketFromBranch,
      ),
  );

  readonly metaActionChips = computed(() => {
    const chips: { id: CommitShortcutId; label: string; title: string }[] = [];
    const key = this.suggestedTicket();
    const topic = this.suggestedTopic();
    if (key && this.commitType() && this.scope().trim() !== key) {
      chips.push({ id: 'scope', label: `Use ${key}`, title: `Put ${key} in the scope` });
    }
    if (topic) {
      chips.push({
        id: 'topic',
        label: topic,
        title: `Add “${topic}” to the description`,
      });
    }
    if (key) {
      chips.push({
        id: 'fixes',
        label: `Fixes ${key}`,
        title: `Add Fixes ${key} to the body`,
      });
    }
    return orderByCommitShortcutSequence(
      chips,
      this.store.settings().commitShortcutSequence,
    );
  });

  constructor() {
    effect(() => {
      if (!this.store.commitModalOpen()) return;
      void this.bootstrap();
    });

    effect(() => {
      const path = this.selectedPath();
      const staged = this.selectedStaged();
      if (!this.store.commitModalOpen() || !path) {
        this.patch.set('');
        return;
      }
      void this.loadDiff(path, staged);
    });
  }

  readonly isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

  readonly modKey = this.isMac ? '⌘' : 'Ctrl';
  readonly stageAllShortcut = `${this.modKey}+⇧S`;
  readonly selectAllShortcut = `${this.modKey}+A`;
  readonly commitShortcut = `${this.modKey}+Enter`;

  onPatchApplied(): void {
    const path = this.selectedPath();
    if (!path) return;
    void this.loadDiff(path, this.selectedStaged());
  }

  onFilesSplit(sizes: Array<number | '*'>): void {
    const nums = sizes.filter((s): s is number => typeof s === 'number');
    if (nums.length >= 2) this.store.setSplitSizes('commitFiles', nums);
  }

  onComposerSplit(sizes: Array<number | '*'>): void {
    const nums = sizes.filter((s): s is number => typeof s === 'number');
    if (nums.length >= 2) this.store.setSplitSizes('commitComposer', nums);
  }

  fileName(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
  }

  fileDir(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i) : '';
  }

  displayPath(entry: FileStatusEntry): string {
    if (entry.originalPath && (entry.status === 'renamed' || entry.status === 'copied')) {
      return `${this.fileName(entry.originalPath)} → ${this.fileName(entry.path)}`;
    }
    return this.fileName(entry.path);
  }

  close(completed = false): void {
    if (this.committing() && !completed) return;
    this.store.closeCommitModal(completed);
  }

  statusClass(status: FileStatusKind): string {
    switch (status) {
      case 'added':
      case 'untracked':
        return 'st-added';
      case 'deleted':
        return 'st-deleted';
      case 'renamed':
      case 'copied':
        return 'st-renamed';
      case 'conflicted':
        return 'st-conflict';
      default:
        return 'st-modified';
    }
  }

  statusGlyph(status: FileStatusKind): string {
    switch (status) {
      case 'untracked':
        return '?';
      case 'added':
        return 'A';
      case 'deleted':
        return 'D';
      case 'renamed':
      case 'copied':
        return 'R';
      case 'conflicted':
        return 'C';
      default:
        return 'M';
    }
  }

  fileKey(path: string, pane: 'unstaged' | 'staged' | 'conflicted'): FileKey {
    const prefix = pane === 'staged' ? 's' : pane === 'conflicted' ? 'c' : 'u';
    return `${prefix}:${path}`;
  }

  isFileSelected(path: string, pane: 'unstaged' | 'staged' | 'conflicted'): boolean {
    return this.selectedFiles().has(this.fileKey(path, pane));
  }

  paneFullySelected(pane: 'unstaged' | 'staged' | 'conflicted'): boolean {
    const list = this.listForPane(pane);
    if (!list.length) return false;
    const selected = this.selectedFiles();
    return list.every((f) => selected.has(this.fileKey(f.path, pane)));
  }

  panePartiallySelected(pane: 'unstaged' | 'staged' | 'conflicted'): boolean {
    const list = this.listForPane(pane);
    if (!list.length) return false;
    const selected = this.selectedFiles();
    const count = list.filter((f) => selected.has(this.fileKey(f.path, pane))).length;
    return count > 0 && count < list.length;
  }

  hasUnstagedSelection(): boolean {
    return this.unstagedSelectedCount() > 0;
  }

  hasStagedSelection(): boolean {
    return this.stagedSelectedCount() > 0;
  }

  hasConflictedSelection(): boolean {
    return this.conflictedSelectedCount() > 0;
  }

  hasUntrackedSelection(): boolean {
    const untracked = new Set((this.store.status()?.untracked ?? []).map((f) => f.path));
    return [...this.selectedFiles()].some((k) => {
      if (!k.startsWith('u:')) return false;
      return untracked.has(k.slice(2));
    });
  }

  hasDiscardableSelection(): boolean {
    const untracked = new Set((this.store.status()?.untracked ?? []).map((f) => f.path));
    return [...this.selectedFiles()].some((k) => {
      if (!k.startsWith('u:')) return false;
      return !untracked.has(k.slice(2));
    });
  }

  togglePaneSelectAll(pane: 'unstaged' | 'staged' | 'conflicted', event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.focusPane.set(pane);
    const list = this.listForPane(pane);
    if (!list.length) return;
    const allSelected = this.paneFullySelected(pane);
    const next = new Set(
      [...this.selectedFiles()].filter((k) => {
        if (pane === 'staged') return !k.startsWith('s:');
        if (pane === 'conflicted') return !k.startsWith('c:');
        return !k.startsWith('u:');
      }),
    );
    if (!allSelected) {
      for (const item of list) next.add(this.fileKey(item.path, pane));
      this.selectFile(list[0].path, pane === 'staged');
    }
    this.selectedFiles.set(next);
  }

  onCheckboxClick(
    entry: FileStatusEntry,
    pane: 'unstaged' | 'staged' | 'conflicted',
    event: MouseEvent,
    index: number,
  ): void {
    event.preventDefault();
    event.stopPropagation();
    this.focusPane.set(pane);
    const key = this.fileKey(entry.path, pane);
    const next = new Set(
      [...this.selectedFiles()].filter((k) => {
        if (pane === 'staged') return k.startsWith('s:');
        if (pane === 'conflicted') return k.startsWith('c:');
        return k.startsWith('u:');
      }),
    );
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.lastFileIndex = { pane, index };
    this.selectedFiles.set(next);
    this.selectFile(entry.path, pane === 'staged');
  }

  onFileClick(
    entry: FileStatusEntry,
    pane: 'unstaged' | 'staged' | 'conflicted',
    event: MouseEvent,
    index: number,
  ): void {
    this.focusPane.set(pane);
    const key = this.fileKey(entry.path, pane);
    const list = this.listForPane(pane);
    let next = new Set<FileKey>();

    if (event.shiftKey && this.lastFileIndex && this.lastFileIndex.pane === pane) {
      const from = Math.min(this.lastFileIndex.index, index);
      const to = Math.max(this.lastFileIndex.index, index);
      for (let i = from; i <= to; i++) {
        const item = list[i];
        if (item) next.add(this.fileKey(item.path, pane));
      }
    } else if (event.metaKey || event.ctrlKey) {
      next = new Set(
        [...this.selectedFiles()].filter((k) => {
          if (pane === 'staged') return k.startsWith('s:');
          if (pane === 'conflicted') return k.startsWith('c:');
          return k.startsWith('u:');
        }),
      );
      if (next.has(key)) next.delete(key);
      else next.add(key);
    } else {
      next = new Set([key]);
    }

    this.lastFileIndex = { pane, index };
    this.selectedFiles.set(next);
    this.selectFile(entry.path, pane === 'staged');
  }

  selectFile(path: string, staged: boolean): void {
    this.selectedPath.set(path);
    this.selectedStaged.set(staged);
  }

  async stage(entry: FileStatusEntry): Promise<void> {
    await this.runFilesOp(async () => {
      await this.store.stagePaths([entry.path]);
      this.selectedFiles.set(new Set([this.fileKey(entry.path, 'staged')]));
      this.selectFile(entry.path, true);
      this.focusPane.set('staged');
    });
  }

  async unstage(entry: FileStatusEntry): Promise<void> {
    await this.runFilesOp(async () => {
      await this.store.unstagePaths([entry.path]);
      this.selectedFiles.set(new Set([this.fileKey(entry.path, 'unstaged')]));
      this.selectFile(entry.path, false);
      this.focusPane.set('unstaged');
    });
  }

  async stageSelected(): Promise<void> {
    const paths = [
      ...[...this.selectedFiles()].filter((k) => k.startsWith('u:')).map((k) => k.slice(2)),
      ...[...this.selectedFiles()].filter((k) => k.startsWith('c:')).map((k) => k.slice(2)),
    ];
    if (!paths.length) return;
    await this.runFilesOp(async () => {
      await this.store.stagePaths(paths);
      this.selectedFiles.set(new Set(paths.map((p) => this.fileKey(p, 'staged'))));
      this.selectFile(paths[0], true);
      this.focusPane.set('staged');
    });
  }

  async unstageSelected(): Promise<void> {
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('s:'))
      .map((k) => k.slice(2));
    if (!paths.length) return;
    await this.runFilesOp(async () => {
      await this.store.unstagePaths(paths);
      this.selectedFiles.set(new Set(paths.map((p) => this.fileKey(p, 'unstaged'))));
      this.selectFile(paths[0], false);
      this.focusPane.set('unstaged');
    });
  }

  async resetSelected(): Promise<void> {
    const untracked = new Set((this.store.status()?.untracked ?? []).map((f) => f.path));
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('u:'))
      .map((k) => k.slice(2))
      .filter((p) => !untracked.has(p));
    if (!paths.length) {
      this.store.showWarning('Select modified unstaged files to reset');
      return;
    }
    await this.runFilesOp(async () => {
      await this.store.discardPaths(paths);
      this.selectedFiles.set(new Set());
    });
  }

  async deleteUntrackedSelected(): Promise<void> {
    const untracked = new Set((this.store.status()?.untracked ?? []).map((f) => f.path));
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('u:'))
      .map((k) => k.slice(2))
      .filter((p) => untracked.has(p));
    if (!paths.length) {
      this.store.showWarning('Select untracked files to delete');
      return;
    }
    await this.runFilesOp(async () => {
      await this.store.discardPaths(paths);
      this.selectedFiles.set(new Set());
    });
  }

  async ignoreSelected(): Promise<void> {
    const untracked = new Set((this.store.status()?.untracked ?? []).map((f) => f.path));
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('u:'))
      .map((k) => k.slice(2))
      .filter((p) => untracked.has(p));
    if (!paths.length) {
      this.store.showWarning('Select untracked files to ignore');
      return;
    }
    await this.runFilesOp(async () => {
      for (const path of paths) {
        await this.store.ignorePath(path);
      }
      this.selectedFiles.set(new Set());
    });
  }

  async stageAll(): Promise<void> {
    const status = this.store.status();
    if (!status) return;
    await this.runFilesOp(async () => {
      await this.store.stagePaths([
        ...status.unstaged.map((f) => f.path),
        ...status.untracked.map((f) => f.path),
        ...status.conflicted.map((f) => f.path),
      ]);
      this.selectedFiles.set(new Set());
    });
  }

  async unstageAll(): Promise<void> {
    const status = this.store.status();
    if (!status) return;
    await this.runFilesOp(async () => {
      await this.store.unstagePaths(status.staged.map((f) => f.path));
      this.selectedFiles.set(new Set());
    });
  }

  async copySelectedPaths(): Promise<void> {
    const paths = [...this.selectedFiles()].map((k) => k.slice(2));
    if (!paths.length && this.selectedPath()) paths.push(this.selectedPath()!);
    if (!paths.length) return;
    try {
      await navigator.clipboard.writeText(paths.join('\n'));
      this.store.showSuccess(paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`);
    } catch {
      this.store.showError('Could not copy path');
    }
  }

  async openSelected(): Promise<void> {
    const rel = this.selectedPath();
    if (!rel) return;
    await this.store.openPathsInEditor([rel]);
  }

  async revealSelected(): Promise<void> {
    const repo = this.store.currentRepo()?.path;
    const rel = this.selectedPath();
    if (!repo || !rel) return;
    try {
      await revealItemInDir(`${repo}/${rel}`);
    } catch (err) {
      this.store.showError(err);
    }
  }

  toggleDiffLayout(): void {
    this.diffLayout.set(this.diffLayout() === 'unified' ? 'sideBySide' : 'unified');
  }

  onFileListKey(event: KeyboardEvent, pane: 'unstaged' | 'staged' | 'conflicted'): void {
    const list = this.listForPane(pane);
    const key = event.key.toLowerCase();

    if ((event.metaKey || event.ctrlKey) && key === 'a') {
      event.preventDefault();
      this.togglePaneSelectAll(pane);
      return;
    }

    if (key === 'arrowdown' || key === 'arrowup') {
      event.preventDefault();
      if (!list.length) return;
      const current = this.selectedPath();
      let idx = list.findIndex((f) => f.path === current);
      if (idx < 0) idx = key === 'arrowdown' ? -1 : 0;
      const nextIdx =
        key === 'arrowdown' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
      const item = list[nextIdx];
      if (!item) return;
      if (event.shiftKey && this.lastFileIndex?.pane === pane) {
        const from = Math.min(this.lastFileIndex.index, nextIdx);
        const to = Math.max(this.lastFileIndex.index, nextIdx);
        const next = new Set<FileKey>();
        for (let i = from; i <= to; i++) {
          const entry = list[i];
          if (entry) next.add(this.fileKey(entry.path, pane));
        }
        this.selectedFiles.set(next);
      } else {
        this.lastFileIndex = { pane, index: nextIdx };
        this.selectedFiles.set(new Set([this.fileKey(item.path, pane)]));
      }
      this.selectFile(item.path, pane === 'staged');
      return;
    }

    if (key === 's' && (pane === 'unstaged' || pane === 'conflicted')) {
      event.preventDefault();
      void this.stageSelected();
      return;
    }
    if (key === 'u' && pane === 'staged') {
      event.preventDefault();
      void this.unstageSelected();
      return;
    }
    if (key === 'r' && pane === 'unstaged') {
      event.preventDefault();
      void this.resetSelected();
      return;
    }
    if (key === 'backspace' || key === 'delete') {
      if (pane === 'unstaged' && this.hasUntrackedSelection()) {
        event.preventDefault();
        void this.deleteUntrackedSelected();
      } else if (pane === 'unstaged' && this.hasDiscardableSelection()) {
        event.preventDefault();
        void this.resetSelected();
      }
    }
  }

  onSubjectChange(value: string): void {
    if (value.includes('\n')) {
      const [first, ...rest] = value.split('\n');
      this.applySubjectLine(first ?? '');
      const restText = rest.join('\n').replace(/^\n+/, '').trim();
      if (restText && !this.body().trim()) this.body.set(restText);
      return;
    }
    const types = this.store.settings().commitTypes;
    const parsed =
      parseConventionalSubject(value, types) ?? parseConventionalSubject(value, []);
    if (parsed) {
      this.applySubjectLine(value);
      return;
    }
    this.subject.set(value);
  }

  onScopeChange(value: string): void {
    this.scope.set(value);
    this.scopeManual.set(true);
  }

  setType(type: string): void {
    const next = this.commitType() === type ? '' : type;
    this.commitType.set(next);
    if (next) {
      this.noteShortcut('type');
      this.fillScopeFromTicket();
      if (this.scope().trim()) this.noteShortcut('scope');
      this.applyRememberedFlow();
    }
  }

  toggleBreaking(): void {
    this.breaking.set(!this.breaking());
  }

  startAddType(): void {
    this.addingType.set(true);
    this.newTypeDraft.set('');
  }

  cancelAddType(): void {
    this.addingType.set(false);
    this.newTypeDraft.set('');
  }

  async confirmAddType(): Promise<void> {
    const id = normalizeCommitTypeId(this.newTypeDraft());
    if (!id || this.savingType()) return;

    const existing = this.store.settings().commitTypes;
    if (existing.some((t) => t.id === id)) {
      this.commitType.set(id);
      this.cancelAddType();
      return;
    }

    this.savingType.set(true);
    try {
      await this.store.saveSettings({
        commitTypes: [...existing, { id, label: id, description: '' }],
      });
      this.commitType.set(id);
      this.cancelAddType();
      this.store.showSuccess(`Added commit type “${id}”`);
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.savingType.set(false);
    }
  }

  applyTemplate(template: TemplateInfo): void {
    const branch = this.store.status()?.branch ?? 'main';
    const types = this.store.settings().commitTypes;
    const jira = this.jiraKeyHint() || 'PROJ-0';
    const topic = this.suggestedTopic() || 'topic';
    const filled = template.pattern
      .replaceAll('{type}', this.commitType() || types[0]?.id || 'feat')
      .replaceAll('{summary}', this.subject() || 'summary')
      .replaceAll('{scope}', this.scope() || this.jiraKeyHint() || 'scope')
      .replaceAll('{name}', branch)
      .replaceAll('{jira}', jira)
      .replaceAll('{ticket}', jira)
      .replaceAll('{topic}', topic);
    if (filled.includes('\n')) {
      const [first, ...rest] = filled.split('\n');
      this.applySubjectLine(first);
      this.body.set(rest.join('\n').trim());
    } else {
      this.applySubjectLine(filled);
    }
  }

  useSuggestedTicket(): void {
    const key = this.suggestedTicket();
    if (!key) {
      this.store.showWarning(
        'No ticket found on this branch. Pick a Jira issue, or configure Ticket from branch in Settings → Git.',
      );
      return;
    }
    this.scope.set(key);
    this.scopeManual.set(true);
    this.noteShortcut('scope');
  }

  insertFixesFooter(): void {
    this.insertFixesLine();
    this.noteShortcut('fixes');
  }

  insertBranchTopic(): void {
    if (this.applyBranchTopic()) this.noteShortcut('topic');
  }

  runMetaShortcut(id: CommitShortcutId): void {
    if (id === 'scope') this.useSuggestedTicket();
    else if (id === 'topic') this.insertBranchTopic();
    else if (id === 'fixes') this.insertFixesFooter();
  }

  private fillScopeFromTicket(): void {
    const settings = this.store.settings().ticketFromBranch;
    if (!settings.enabled || !settings.putInScope) return;
    if (this.scopeManual()) return;
    const ticket = this.suggestedTicket();
    if (ticket) this.scope.set(ticket);
  }

  private noteShortcut(id: CommitShortcutId): void {
    this.sessionSequence.update((sequence) => recordCommitShortcut(sequence, id));
  }

  private applyRememberedFlow(): void {
    for (const id of this.store.settings().commitShortcutSequence) {
      if (id === 'scope') {
        this.fillScopeFromTicket();
        if (this.scope().trim()) this.noteShortcut('scope');
      } else if (id === 'topic') {
        if (this.applyBranchTopic({ onlyIfEmpty: true })) this.noteShortcut('topic');
      } else if (id === 'fixes') {
        if (this.insertFixesLine()) this.noteShortcut('fixes');
      }
    }
  }

  private applyBranchTopic(opts?: { onlyIfEmpty?: boolean }): boolean {
    const topic = this.suggestedTopic();
    if (!topic) return false;
    const body = this.body();
    const trimmed = body.trim();
    if (trimmed.includes(topic)) return false;
    if (opts?.onlyIfEmpty && trimmed && !/\{\s*(details|topic)\s*\}/i.test(trimmed)) {
      return false;
    }
    if (/\{\s*(details|topic)\s*\}/i.test(body)) {
      this.body.set(
        body.replace(/\{\s*details\s*\}/gi, topic).replace(/\{\s*topic\s*\}/gi, topic),
      );
      return true;
    }
    this.body.set(trimmed ? `${trimmed}\n\n${topic}` : topic);
    return true;
  }

  private insertFixesLine(): boolean {
    const key = this.suggestedTicket();
    if (!key) return false;
    const line = `Fixes ${key}`;
    const body = this.body().trim();
    if (body.includes(line)) return false;
    this.body.set(body ? `${body}\n\n${line}` : line);
    return true;
  }

  private sequenceToPersist(): CommitShortcutId[] {
    const topic = this.suggestedTopic();
    const ticket = this.suggestedTicket();
    const body = this.body();
    return this.sessionSequence().filter((id) => {
      if (id === 'type') return !!this.commitType();
      if (id === 'scope') return !!this.scope().trim();
      if (id === 'topic') return !!(topic && body.includes(topic));
      if (id === 'fixes') return !!(ticket && body.includes(`Fixes ${ticket}`));
      return false;
    });
  }

  toggleAmend(checked: boolean): void {
    this.amend.set(checked);
    if (checked && !this.subject().trim()) {
      const head = this.store.commits()[0];
      if (head) {
        const lines = head.message.split('\n');
        this.applySubjectLine(lines[0] ?? '');
        this.body.set(lines.slice(2).join('\n').trim());
      }
    }
  }

  async commit(): Promise<void> {
    if (!this.canCommit() || this.committing()) return;

    const needsStageAll =
      !this.amend() && this.stagedCount() === 0 && this.unstagedCount() > 0;

    if (needsStageAll) {
      const n = this.unstagedCount();
      const ok = await this.prompts.ask({
        title: 'Nothing staged',
        message: `Stage all ${n} file${n === 1 ? '' : 's'} and commit?`,
        confirmLabel: 'Stage & commit',
        cancelLabel: 'Cancel',
        confirmOnly: true,
      });
      if (ok === null) return;
    }

    this.committing.set(true);
    try {
      if (needsStageAll) {
        this.commitPhase.set('staging');
        await this.stageAll();
        if (this.stagedCount() === 0) {
          this.store.showWarning('Nothing was staged');
          return;
        }
      }

      const skipChecks = this.commitChecks()?.skip() ?? false;
      const willPush = this.pushAfter();
      const checkTriggers = willPush
        ? ['pre-commit', 'commit-msg', 'pre-push']
        : ['pre-commit', 'commit-msg'];
      if (!skipChecks && this.store.enabledChecks(checkTriggers).length) {
        this.commitPhase.set('checking');
        const ok = await this.store.runRepoChecks(checkTriggers, {
          commitMessage: this.messagePreview(),
          silent: true,
        });
        if (!ok) {
          this.store.showError('Checks failed — fix them or skip checks to commit');
          return;
        }
      }

      this.commitPhase.set('committing');
      const skipGitHooks =
        skipChecks || this.store.hasDetectedChecks(['pre-commit', 'commit-msg']);
      const commit = await this.store.createCommit(
        this.messagePreview(),
        this.amend(),
        true,
        { toast: !willPush, skipHooks: skipGitHooks },
      );
      if (!commit.ok) return;
      const remembered = this.sequenceToPersist();
      if (
        remembered.join('\0') !== this.store.settings().commitShortcutSequence.join('\0')
      ) {
        void this.store.saveSettings({ commitShortcutSequence: remembered });
      }
      if (willPush) {
        this.commitPhase.set('pushing');
        const pushed = await this.store.pushRemote({
          toast: false,
          runChecks: false,
          skipHooks: skipChecks || this.store.hasDetectedChecks(['pre-push']),
        });
        const short = commit.shortSha ?? 'commit';
        if (pushed) {
          this.store.showToast(`Committed ${short} and pushed`, {
            kind: 'success',
            category: 'commit',
            undo: () => void this.store.undoLastActionQuiet(),
          });
        } else {
          this.store.showToast(`Committed ${short} (push failed)`, {
            kind: 'warning',
            category: 'commit',
            undo: () => void this.store.undoLastActionQuiet(),
          });
        }
      }
      this.resetForm();
      const treeClean =
        this.stagedCount() === 0 &&
        this.unstagedCount() === 0 &&
        this.conflictedCount() === 0;
      if (needsStageAll || treeClean) {
        this.close(true);
      }
    } finally {
      this.commitPhase.set(null);
      this.committing.set(false);
    }
  }

  private async runFilesOp(fn: () => Promise<void>): Promise<void> {
    if (this.filesBusy()) return;
    const nestedUnderCommit = this.committing();
    if (!nestedUnderCommit) this.filesBusy.set(true);
    try {
      await fn();
    } finally {
      if (!nestedUnderCommit) this.filesBusy.set(false);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.store.commitModalOpen()) return;
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void this.commit();
      return;
    }

    if (event.key === 'Escape') {
      if (this.prompts.request()) return;
      if (this.committing()) return;
      event.preventDefault();
      this.close();
      return;
    }

    if (typing || this.isBusy()) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && event.shiftKey) {
      event.preventDefault();
      void this.stageAll();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      this.togglePaneSelectAll(this.focusPane());
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void this.copySelectedPaths();
      return;
    }

    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      void this.stageSelected();
      return;
    }
    if (key === 'u') {
      event.preventDefault();
      void this.unstageSelected();
      return;
    }
    if (key === 'r') {
      event.preventDefault();
      void this.resetSelected();
    }
  }

  private listForPane(pane: 'unstaged' | 'staged' | 'conflicted'): FileStatusEntry[] {
    if (pane === 'staged') return this.staged();
    if (pane === 'conflicted') return this.conflicted();
    return this.unstaged();
  }

  private applySubjectLine(line: string): void {
    const types = this.store.settings().commitTypes;
    const parsed =
      parseConventionalSubject(line, types) ?? parseConventionalSubject(line, []);
    if (parsed) {
      this.commitType.set(parsed.type);
      this.scope.set(parsed.scope);
      this.breaking.set(parsed.breaking);
      this.subject.set(parsed.summary);
      if (parsed.scope) this.scopeManual.set(true);
      return;
    }
    this.subject.set(line);
  }

  private async bootstrap(): Promise<void> {
    const [templates, identity] = await Promise.all([
      this.tauri.listTemplates(),
      this.tauri.getGitIdentity(this.store.currentRepo()?.path ?? null),
    ]);
    this.templates.set(templates.filter((t) => t.kind === 'commit'));
    this.identity.set(identity);
    const settings = this.store.settings();
    this.signOff.set(settings.signOffByDefault);
    await this.applyPushAfterDefault(settings.pushAfterCommit);
    this.diffLayout.set('unified');
    this.selectedFiles.set(new Set());
    this.sessionSequence.set([]);
    this.fillScopeFromTicket();
    if (this.scope().trim()) this.noteShortcut('scope');
    await this.store.loadRepoChecks();
    this.applySuggestedType();

    const status = this.store.status();
    const firstConflict = status?.conflicted[0]?.path ?? null;
    const firstUnstaged = status?.unstaged[0]?.path ?? status?.untracked[0]?.path ?? null;
    const firstStaged = status?.staged[0]?.path ?? null;
    if (firstConflict) {
      this.selectedFiles.set(new Set([this.fileKey(firstConflict, 'conflicted')]));
      this.selectFile(firstConflict, false);
      this.focusPane.set('conflicted');
    } else if (firstUnstaged) {
      this.selectedFiles.set(new Set([this.fileKey(firstUnstaged, 'unstaged')]));
      this.selectFile(firstUnstaged, false);
      this.focusPane.set('unstaged');
    } else if (firstStaged) {
      this.selectedFiles.set(new Set([this.fileKey(firstStaged, 'staged')]));
      this.selectFile(firstStaged, true);
      this.focusPane.set('staged');
    }

    const pending = this.store.pendingCommitTemplate();
    if (pending) {
      this.applyTemplate(pending);
      this.store.pendingCommitTemplate.set(null);
    }
    this.applyRememberedFlow();
  }

  private async applyPushAfterDefault(current: boolean): Promise<void> {
    if (current) {
      this.pushAfter.set(true);
      return;
    }
    try {
      if (localStorage.getItem('branchline.migratedPushAfterCommit') === '1') {
        this.pushAfter.set(false);
        return;
      }
      localStorage.setItem('branchline.migratedPushAfterCommit', '1');
      await this.store.saveSettings({ pushAfterCommit: true });
      this.pushAfter.set(true);
    } catch {
      this.pushAfter.set(true);
    }
  }

  private async loadDiff(path: string, staged: boolean): Promise<void> {
    const repo = this.store.currentRepo()?.path;
    if (!repo) return;
    try {
      const diff = await this.tauri.getDiff(repo, { pathspec: path, staged });
      this.patch.set(diff.unified || 'No textual diff for this file.');
    } catch (err) {
      this.patch.set(this.store.formatError(err) || 'Could not load diff.');
    }
  }

  private filterFiles(files: FileStatusEntry[]): FileStatusEntry[] {
    const q = this.fileFilter().trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }

  private applySuggestedType(): void {
    if (this.commitType() || !this.usesCommitlint()) return;
    const suggested = this.suggestedType();
    if (!suggested) return;
    this.commitType.set(suggested);
    this.noteShortcut('type');
    this.fillScopeFromTicket();
  }

  private resetForm(): void {
    this.subject.set('');
    this.body.set('');
    this.amend.set(false);
    this.signOff.set(false);
    this.pushAfter.set(this.store.settings().pushAfterCommit ?? true);
    this.commitType.set('');
    this.scope.set('');
    this.breaking.set(false);
    this.scopeManual.set(false);
    this.sessionSequence.set([]);
    this.cancelAddType();
    this.selectedFiles.set(new Set());
  }
}
