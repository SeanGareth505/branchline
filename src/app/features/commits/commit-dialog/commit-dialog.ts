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
import type { FileStatusEntry, FileStatusKind, TemplateInfo } from '../../../core/models';
import { AppStore } from '../../../core/app.store';
import {
  normalizeCommitTypeId,
  parseConventionalSubject,
} from '../../../core/commit-types';
import { TauriService } from '../../../core/tauri.service';
import { PatchLinesView, type PatchLinesMode } from '../../diff/patch-lines-view/patch-lines-view';

type FileKey = `${'s' | 'u'}:${string}`;

@Component({
  selector: 'app-commit-dialog',
  imports: [FormsModule, NgIcon, PatchLinesView],
  templateUrl: './commit-dialog.html',
  styleUrl: './commit-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommitDialog {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  readonly subject = signal('');
  readonly body = signal('');
  readonly amend = signal(false);
  readonly signOff = signal(false);
  readonly pushAfter = signal(false);
  readonly commitType = signal('');
  readonly fileFilter = signal('');
  readonly selectedPath = signal<string | null>(null);
  readonly selectedStaged = signal(false);
  readonly patch = signal('');
  readonly templates = signal<TemplateInfo[]>([]);
  readonly identity = signal<{ name: string; email: string } | null>(null);
  readonly committing = signal(false);
  readonly addingType = signal(false);
  readonly newTypeDraft = signal('');
  readonly savingType = signal(false);
  readonly focusPane = signal<'unstaged' | 'staged'>('unstaged');
  readonly selectedFiles = signal<Set<FileKey>>(new Set());
  private lastFileIndex: { staged: boolean; index: number } | null = null;

  readonly jiraKeyHint = computed(
    () => this.store.activeJiraKey() || this.jiraFromBranch(this.store.status()?.branch ?? ''),
  );

  readonly types = computed(() => {
    const configured = this.store.settings().commitTypes;
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
  readonly conflicted = computed(() => this.store.status()?.conflicted ?? []);

  readonly stagedCount = computed(() => this.store.status()?.staged.length ?? 0);
  readonly unstagedCount = computed(
    () =>
      (this.store.status()?.unstaged.length ?? 0) + (this.store.status()?.untracked.length ?? 0),
  );

  readonly linesMode = computed((): PatchLinesMode =>
    this.selectedStaged() ? 'staged' : 'unstaged',
  );

  readonly messagePreview = computed(() => {
    const type = this.commitType();
    const subject = this.subject().trim();
    const body = this.body().trim();
    const head = type && subject ? `${type}: ${subject}` : subject;
    let msg = head;
    if (body) msg = `${head}\n\n${body}`;
    if (this.signOff() && this.identity()) {
      const id = this.identity()!;
      msg = `${msg}\n\nSigned-off-by: ${id.name} <${id.email}>`;
    }
    return msg;
  });

  readonly canCommit = computed(() => {
    if (!this.messagePreview().trim()) return false;
    if (this.amend()) return true;
    return this.stagedCount() > 0;
  });

  readonly charHint = computed(() => {
    const len = this.subject().trim().length;
    if (len === 0) return 'Write a commit message';
    if (len <= 50) return `${len}/50 ideal`;
    if (len <= 72) return `${len}/72 ok`;
    return `${len} chars — consider shortening`;
  });

  readonly canAddType = computed(() => !!normalizeCommitTypeId(this.newTypeDraft()));

  readonly commitMessageField = computed(() => {
    const type = this.commitType();
    const subject = this.subject();
    const body = this.body();
    const head = type ? `${type}: ${subject}` : subject;
    if (!body) return head;
    return `${head}\n\n${body}`;
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

  onPatchApplied(): void {
    const path = this.selectedPath();
    if (!path) return;
    void this.loadDiff(path, this.selectedStaged());
  }

  fileName(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(i + 1) : path;
  }

  fileDir(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i) : '';
  }

  close(): void {
    this.store.closeCommitModal();
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

  fileKey(path: string, staged: boolean): FileKey {
    return `${staged ? 's' : 'u'}:${path}`;
  }

  isFileSelected(path: string, staged: boolean): boolean {
    return this.selectedFiles().has(this.fileKey(path, staged));
  }

  hasUnstagedSelection(): boolean {
    return [...this.selectedFiles()].some((k) => k.startsWith('u:'));
  }

  hasStagedSelection(): boolean {
    return [...this.selectedFiles()].some((k) => k.startsWith('s:'));
  }

  onFileClick(entry: FileStatusEntry, staged: boolean, event: MouseEvent, index: number): void {
    this.focusPane.set(staged ? 'staged' : 'unstaged');
    const key = this.fileKey(entry.path, staged);
    const list = staged ? this.staged() : this.unstaged();
    let next = new Set<FileKey>();

    if (event.shiftKey && this.lastFileIndex && this.lastFileIndex.staged === staged) {
      const from = Math.min(this.lastFileIndex.index, index);
      const to = Math.max(this.lastFileIndex.index, index);
      for (let i = from; i <= to; i++) {
        const item = list[i];
        if (item) next.add(this.fileKey(item.path, staged));
      }
    } else if (event.metaKey || event.ctrlKey) {
      next = new Set(
        [...this.selectedFiles()].filter((k) => (staged ? k.startsWith('s:') : k.startsWith('u:'))),
      );
      if (next.has(key)) next.delete(key);
      else next.add(key);
    } else {
      next = new Set([key]);
    }

    this.lastFileIndex = { staged, index };
    this.selectedFiles.set(next);
    this.selectFile(entry.path, staged);
  }

  selectFile(path: string, staged: boolean): void {
    this.selectedPath.set(path);
    this.selectedStaged.set(staged);
  }

  async stage(entry: FileStatusEntry): Promise<void> {
    await this.store.stagePaths([entry.path]);
    this.selectedFiles.set(new Set([this.fileKey(entry.path, true)]));
    this.selectFile(entry.path, true);
    this.focusPane.set('staged');
  }

  async unstage(entry: FileStatusEntry): Promise<void> {
    await this.store.unstagePaths([entry.path]);
    this.selectedFiles.set(new Set([this.fileKey(entry.path, false)]));
    this.selectFile(entry.path, false);
    this.focusPane.set('unstaged');
  }

  async stageSelected(): Promise<void> {
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('u:'))
      .map((k) => k.slice(2));
    if (!paths.length) return;
    await this.store.stagePaths(paths);
    this.selectedFiles.set(new Set(paths.map((p) => this.fileKey(p, true))));
    this.selectFile(paths[0], true);
    this.focusPane.set('staged');
  }

  async unstageSelected(): Promise<void> {
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('s:'))
      .map((k) => k.slice(2));
    if (!paths.length) return;
    await this.store.unstagePaths(paths);
    this.selectedFiles.set(new Set(paths.map((p) => this.fileKey(p, false))));
    this.selectFile(paths[0], false);
    this.focusPane.set('unstaged');
  }

  async resetSelected(): Promise<void> {
    const paths = [...this.selectedFiles()]
      .filter((k) => k.startsWith('u:'))
      .map((k) => k.slice(2))
      .filter((p) => {
        const entry = this.unstaged().find((f) => f.path === p);
        return entry && entry.status !== 'untracked';
      });
    if (!paths.length) {
      this.store.showWarning('Select modified unstaged files to reset');
      return;
    }
    await this.store.discardPaths(paths);
    this.selectedFiles.set(new Set());
  }

  async stageAll(): Promise<void> {
    const status = this.store.status();
    if (!status) return;
    await this.store.stagePaths([
      ...status.unstaged.map((f) => f.path),
      ...status.untracked.map((f) => f.path),
    ]);
  }

  async unstageAll(): Promise<void> {
    const status = this.store.status();
    if (!status) return;
    await this.store.unstagePaths(status.staged.map((f) => f.path));
  }

  onFileListKey(event: KeyboardEvent, staged: boolean): void {
    const key = event.key.toLowerCase();
    if (key === 's' && !staged) {
      event.preventDefault();
      void this.stageSelected();
      return;
    }
    if (key === 'u' && staged) {
      event.preventDefault();
      void this.unstageSelected();
      return;
    }
    if (key === 'r' && !staged) {
      event.preventDefault();
      void this.resetSelected();
    }
  }

  onCommitMessageChange(value: string): void {
    const splitAt = value.indexOf('\n\n');
    const head = splitAt >= 0 ? value.slice(0, splitAt) : value;
    const rest = splitAt >= 0 ? value.slice(splitAt + 2).trim() : '';
    const subjectLine = head.split('\n')[0] ?? '';
    const match = subjectLine.match(/^([a-z][a-z0-9-]*)\s*:\s*(.*)$/i);
    if (match && this.store.settings().commitTypes.some((t) => t.id === match[1].toLowerCase())) {
      this.commitType.set(match[1].toLowerCase());
      this.subject.set(match[2] ?? '');
    } else if (this.commitType()) {
      this.subject.set(subjectLine.replace(new RegExp(`^${this.commitType()}:\\s*`, 'i'), ''));
    } else {
      this.subject.set(subjectLine);
    }
    this.body.set(rest);
  }

  setType(type: string): void {
    this.commitType.set(this.commitType() === type ? '' : type);
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
    const filled = template.pattern
      .replaceAll('{type}', this.commitType() || types[0]?.id || 'feat')
      .replaceAll('{summary}', this.subject() || 'summary')
      .replaceAll('{name}', branch)
      .replaceAll('{jira}', jira);
    if (filled.includes('\n')) {
      const [first, ...rest] = filled.split('\n');
      this.applySubjectLine(first);
      this.body.set(rest.join('\n').trim());
    } else {
      this.applySubjectLine(filled);
    }
  }

  insertJiraKey(): void {
    const key = this.jiraKeyHint();
    if (!key) {
      this.store.showWarning('Pick an issue in Jira first, or use a branch with an issue key');
      return;
    }
    const subject = this.subject().trim();
    if (!subject) {
      this.applySubjectLine(key);
      return;
    }
    if (subject.includes(key)) return;
    this.applySubjectLine(`${key} ${subject}`);
  }

  insertFixesFooter(): void {
    const key = this.jiraKeyHint();
    if (!key) {
      this.store.showWarning('Pick an issue in Jira first, or use a branch with an issue key');
      return;
    }
    const line = `Fixes ${key}`;
    const body = this.body().trim();
    if (body.includes(line)) return;
    this.body.set(body ? `${body}\n\n${line}` : line);
  }

  private jiraFromBranch(branch: string): string | null {
    const match = branch.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
    return match?.[1] ?? null;
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
    this.committing.set(true);
    try {
      await this.store.createCommit(this.messagePreview(), this.amend());
      if (this.pushAfter()) {
        await this.store.pushRemote();
      }
      this.resetForm();
      this.close();
    } finally {
      this.committing.set(false);
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
      event.preventDefault();
      this.close();
      return;
    }

    if (typing) return;

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

  private applySubjectLine(line: string): void {
    const types = this.store.settings().commitTypes;
    const parsed = parseConventionalSubject(line, types);
    if (parsed) {
      this.commitType.set(parsed.type);
      this.subject.set(parsed.summary);
      return;
    }
    const loose = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/i);
    if (loose) {
      this.commitType.set(loose[1].toLowerCase());
      this.subject.set(loose[2] ?? '');
      return;
    }
    this.subject.set(line);
  }

  private async bootstrap(): Promise<void> {
    const [templates, identity] = await Promise.all([
      this.tauri.listTemplates(),
      this.tauri.getGitIdentity(),
    ]);
    this.templates.set(templates.filter((t) => t.kind === 'commit'));
    this.identity.set(identity);
    const settings = this.store.settings();
    this.signOff.set(settings.signOffByDefault);
    this.pushAfter.set(settings.pushAfterCommit);
    this.selectedFiles.set(new Set());

    const status = this.store.status();
    const firstUnstaged = status?.unstaged[0]?.path ?? status?.untracked[0]?.path ?? null;
    const firstStaged = status?.staged[0]?.path ?? null;
    if (firstUnstaged) {
      this.selectedFiles.set(new Set([this.fileKey(firstUnstaged, false)]));
      this.selectFile(firstUnstaged, false);
      this.focusPane.set('unstaged');
    } else if (firstStaged) {
      this.selectedFiles.set(new Set([this.fileKey(firstStaged, true)]));
      this.selectFile(firstStaged, true);
      this.focusPane.set('staged');
    }
  }

  private async loadDiff(path: string, staged: boolean): Promise<void> {
    const repo = this.store.currentRepo()?.path;
    if (!repo) return;
    try {
      const diff = await this.tauri.getDiff(repo, { pathspec: path, staged });
      this.patch.set(diff.unified || 'No textual diff for this file.');
    } catch {
      this.patch.set('Could not load diff.');
    }
  }

  private filterFiles(files: FileStatusEntry[]): FileStatusEntry[] {
    const q = this.fileFilter().trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }

  private resetForm(): void {
    this.subject.set('');
    this.body.set('');
    this.amend.set(false);
    this.signOff.set(false);
    this.pushAfter.set(false);
    this.commitType.set('');
    this.cancelAddType();
    this.selectedFiles.set(new Set());
  }
}
