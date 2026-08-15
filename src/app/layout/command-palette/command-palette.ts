import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import Fuse from 'fuse.js';
import { AppStore, type AppView } from '../../core/app.store';
import { UpdateService } from '../../core/update.service';
import { PromptService } from '../../shared/ui/prompt-dialog/prompt.service';

interface PaletteItem {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

@Component({
  selector: 'app-command-palette',
  imports: [FormsModule, NgIcon],
  templateUrl: './command-palette.html',
  styleUrl: './command-palette.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommandPalette {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  private readonly updates = inject(UpdateService);
  readonly query = signal('');
  readonly activeIndex = signal(0);

  constructor() {
    effect(() => {
      const seed = this.store.paletteSeedQuery();
      if (!this.store.paletteOpen() || !seed) return;
      this.query.set(seed);
      this.store.paletteSeedQuery.set(null);
    });
  }

  private readonly actions = computed<PaletteItem[]>(() => {
    const store = this.store;
    const prompts = this.prompts;
    const updates = this.updates;
    const items: PaletteItem[] = [
      {
        id: 'repos',
        label: 'Open Repos',
        group: 'Navigate',
        run: () => store.goHome(),
      },
      {
        id: 'browse',
        label: 'Browse repository',
        group: 'Navigate',
        run: () => {
          if (store.currentRepo()) store.setView('browse');
        },
      },
      { id: 'prs', label: 'Open Pull Requests', group: 'Navigate', run: () => store.setView('prs') },
      { id: 'jira', label: 'Open Jira', group: 'Navigate', run: () => store.setView('jira') },
      {
        id: 'release-view',
        label: 'Open Release',
        group: 'Navigate',
        run: () => store.openReleaseTab(),
      },
      {
        id: 'settings',
        label: 'Open Settings',
        group: 'Navigate',
        run: () => store.openSettings('appearance'),
      },
      {
        id: 'notifications',
        label: 'Open Notification settings',
        group: 'Navigate',
        run: () => store.openSettings('notifications'),
      },
      {
        id: 'about',
        label: 'Open About / Updates',
        group: 'Navigate',
        run: () => store.openSettings('about'),
      },
      {
        id: 'check-updates',
        label: 'Check for updates',
        group: 'App',
        run: () => {
          void updates.checkForUpdates({ silent: false }).then((found) => {
            if (found) {
              store.notifyEvent(
                'updates',
                'Update available',
                `Update ${updates.availableVersion()} is available`,
                { kind: 'info' },
              );
            } else if (updates.phase() === 'error') {
              store.showError(updates.errorMessage() ?? 'Could not check for updates');
            } else {
              store.showSuccess('You are on the latest version', undefined, 'updates');
            }
          });
        },
      },
      {
        id: 'connections',
        label: 'Open Connections',
        group: 'Navigate',
        run: () => store.openSettings('connections'),
      },
      {
        id: 'connect-github',
        label: 'Connect GitHub',
        group: 'Integrations',
        run: () => store.openGithubDeviceLogin(),
      },
      {
        id: 'publish-github',
        label: 'Publish to GitHub…',
        group: 'Repository',
        run: () => {
          if (store.currentRepo()) store.openPublishGithubDialog();
        },
      },
      {
        id: 'connect-gitlab',
        label: 'Connect GitLab',
        group: 'Integrations',
        run: () => store.openSettings('connections', 'gitlab'),
      },
      {
        id: 'connect-jira',
        label: 'Connect Jira',
        group: 'Integrations',
        run: () => store.openSettings('connections', 'jira'),
      },
      {
        id: 'profiles',
        label: 'Open Profiles',
        group: 'Navigate',
        run: () => store.setView('profiles'),
      },
      {
        id: 'automation',
        label: 'Open Automation',
        group: 'Navigate',
        run: () => store.setView('automation'),
      },
      {
        id: 'checks',
        label: 'Open commit checks',
        group: 'Navigate',
        run: () => store.setAutomationSection('checks'),
      },
      {
        id: 'new-check-script',
        label: 'New check script',
        group: 'Automation',
        run: () => store.setAutomationSection('checks'),
      },
      {
        id: 'templates',
        label: 'Open Templates',
        group: 'Navigate',
        run: () => store.setView('templates'),
      },
      {
        id: 'fetch',
        label: 'Fetch from remote',
        group: 'Git',
        run: () => void store.fetchRemote(),
      },
      { id: 'pull', label: 'Pull updates', group: 'Git', run: () => void store.pullRemote() },
      {
        id: 'pull-rebase',
        label: 'Pull with rebase',
        group: 'Git',
        run: () => void store.pullRemote(true),
      },
      { id: 'push', label: 'Push commits', group: 'Git', run: () => void store.pushRemote() },
      {
        id: 'refresh',
        label: 'Refresh repository',
        group: 'Git',
        run: () => void store.refreshRepo({ notify: true }),
      },
      {
        id: 'create-branch',
        label: 'Create branch…',
        group: 'Git',
        run: () => {
          if (store.currentRepo()) store.openCreateBranchDialog();
        },
      },
      {
        id: 'force-push',
        label: 'Force push with lease…',
        group: 'Git',
        run: () => void store.forcePush(),
      },
      { id: 'sync', label: 'Sync with remote', group: 'Git', run: () => void store.syncRemote() },
      {
        id: 'stash',
        label: 'Stash working changes',
        group: 'Git',
        run: () => void store.stashPush(),
      },
      {
        id: 'stash-untracked',
        label: 'Stash including untracked',
        group: 'Git',
        run: () => void store.stashPush(undefined, true),
      },
      {
        id: 'stash-apply',
        label: 'Apply latest stash',
        group: 'Git',
        run: () => void store.stashApply(0),
      },
      {
        id: 'stash-pop',
        label: 'Pop latest stash',
        group: 'Git',
        run: () => void store.stashPop(0),
      },
      {
        id: 'stash-drop-all',
        label: 'Drop all stashes…',
        group: 'Git',
        run: () => void store.stashClear(),
      },
      {
        id: 'reflog',
        label: 'Open reflog',
        group: 'Git',
        run: () => {
          store.setView('browse');
          store.setBrowseTab('reflog');
        },
      },
      {
        id: 'squash',
        label: 'Squash recent commits…',
        group: 'Git',
        run: () => {
          void (async () => {
            const countRaw = await prompts.ask({
              title: 'Squash commits',
              message: 'How many recent commits should be combined?',
              label: 'Commit count',
              initialValue: '2',
              confirmLabel: 'Next',
              mono: true,
            });
            const count = Number(countRaw);
            if (!Number.isFinite(count) || count < 2) return;
            const message = await prompts.ask({
              title: 'Squash commit message',
              message: `Combining the last ${count} commits.`,
              label: 'Message',
              placeholder: 'Summarize the squashed changes',
              confirmLabel: 'Squash',
              multiline: true,
            });
            if (!message?.trim()) return;
            void store.squashSelected(count, message.trim());
          })();
        },
      },
      {
        id: 'resolve-conflicts',
        label: 'Resolve conflicts…',
        group: 'Git',
        run: () => void store.openConflictResolver(),
      },
      {
        id: 'interactive-rebase',
        label: 'Interactive rebase from selected…',
        group: 'Git',
        run: () => {
          const sha = store.selectedSha();
          if (sha) void store.openInteractiveRebase(sha);
        },
      },
      {
        id: 'hide-untracked',
        label: store.settings().hideUntracked
          ? 'Show untracked files'
          : 'Hide untracked files (faster)',
        group: 'View',
        run: () => {
          void store.saveSettings({ hideUntracked: !store.settings().hideUntracked }).then(() =>
            store.refreshRepo(),
          );
        },
      },
      {
        id: 'density-compact',
        label: 'Use compact density',
        group: 'View',
        run: () => void store.saveSettings({ uiDensity: 'compact' }),
      },
      {
        id: 'density-comfortable',
        label: 'Use comfortable density',
        group: 'View',
        run: () => void store.saveSettings({ uiDensity: 'comfortable' }),
      },
      ...[
        ...store.status()?.staged ?? [],
        ...store.status()?.unstaged ?? [],
        ...store.status()?.untracked ?? [],
        ...store.status()?.conflicted ?? [],
      ]
        .slice(0, 60)
        .map((f) => ({
          id: `file:${f.path}`,
          label: f.path,
          group: 'Changed files',
          run: () => {
            store.setView('browse');
            store.setBrowseTab('diff');
            store.selectedDiffPath.set(f.path);
          },
        })),
      {
        id: 'release',
        label: 'Release…',
        group: 'Git',
        run: () => void store.startReleaseFlow(),
      },
      {
        id: 'release-progress',
        label: 'Open release progress',
        group: 'Git',
        run: () => store.openReleaseTab(),
      },
      {
        id: 'release-track',
        label: 'Track latest deploy',
        group: 'Git',
        run: () => void store.attachLatestRelease({ force: true }),
      },
      {
        id: 'release-refresh',
        label: 'Refresh release status',
        group: 'Git',
        run: () => void store.refreshReleaseDeploy(),
      },
      {
        id: 'continue',
        label: 'Continue merge / rebase / cherry-pick / revert',
        group: 'Git',
        run: () => void store.continueOperation(),
      },
      {
        id: 'abort',
        label: 'Abort merge / rebase / cherry-pick / revert',
        group: 'Git',
        run: () => void store.abortOperation(),
      },
      {
        id: 'commit-focus',
        label: 'Focus commit panel',
        group: 'Git',
        run: () => store.focusCommitPanel(),
      },
      {
        id: 'create-pr',
        label: 'Create pull request…',
        group: 'Git',
        run: () => void store.openCreatePullRequest(),
      },
      {
        id: 'shortcut-commit',
        label: 'Shortcut · ⌘⇧C / Ctrl+Shift+C — Commit',
        group: 'Shortcuts',
        run: () => store.focusCommitPanel(),
      },
      {
        id: 'shortcut-palette',
        label: 'Shortcut · ⌘K / Ctrl+K — Command palette',
        group: 'Shortcuts',
        run: () => undefined,
      },
      {
        id: 'shortcut-refresh',
        label: 'Shortcut · F5 — Refresh repository',
        group: 'Shortcuts',
        run: () => void store.refreshRepo({ notify: true }),
      },
      {
        id: 'shortcut-fetch',
        label: 'Shortcut · ⌘⇧F / Ctrl+Shift+F — Fetch',
        group: 'Shortcuts',
        run: () => void store.fetchRemote(),
      },
      {
        id: 'shortcut-help',
        label: 'Shortcut · ? — Show shortcuts',
        group: 'Shortcuts',
        run: () => store.openShortcutPalette(),
      },
      {
        id: 'shortcut-undo',
        label: 'Shortcut · ⌘Z / Ctrl+Z — Undo toast action',
        group: 'Shortcuts',
        run: () => store.runUndoFromToast(),
      },
      {
        id: 'cherry',
        label: 'Cherry-pick commit(s) onto HEAD…',
        group: 'Git',
        run: () => void store.openCherryPickPreview(),
      },
      {
        id: 'cherry-file',
        label: 'Apply selected file from commit',
        group: 'Git',
        run: () => {
          const file = store.selectedDiffPath();
          if (!file || !store.selectedSha()) {
            store.showWarning('Select a commit and a file in the Diff tab first');
            return;
          }
          void store.cherryPickPathsFromCommit([file], 'both');
        },
      },
      {
        id: 'cherry-file-wt',
        label: 'Apply selected file to my files (unstaged)',
        group: 'Git',
        run: () => {
          const file = store.selectedDiffPath();
          if (!file || !store.selectedSha()) {
            store.showWarning('Select a commit and a file in the Diff tab first');
            return;
          }
          void store.cherryPickPathsFromCommit([file], 'worktree');
        },
      },
      {
        id: 'cherry-file-index',
        label: 'Apply selected file and stage it',
        group: 'Git',
        run: () => {
          const file = store.selectedDiffPath();
          if (!file || !store.selectedSha()) {
            store.showWarning('Select a commit and a file in the Diff tab first');
            return;
          }
          void store.cherryPickPathsFromCommit([file], 'index');
        },
      },
      {
        id: 'interactive-rebase',
        label: 'Interactive rebase from selected…',
        group: 'Git',
        run: () => void store.openInteractiveRebase(),
      },
      {
        id: 'edit-gitignore',
        label: 'Edit .gitignore…',
        group: 'Git',
        run: () => void store.openIgnoreEditor('gitignore'),
      },
      {
        id: 'edit-exclude',
        label: 'Edit local exclude rules…',
        group: 'Git',
        run: () => void store.openIgnoreEditor('exclude'),
      },
      {
        id: 'prune-worktrees',
        label: 'Prune stale worktrees',
        group: 'Git',
        run: () => void store.pruneWorktrees(),
      },
      {
        id: 'prune-remotes',
        label: 'Prune stale remote-tracking branches',
        group: 'Git',
        run: () => void store.pruneAllRemotes(),
      },
      {
        id: 'undo-commit',
        label: 'Create undo commit (revert)',
        group: 'Git',
        run: () => void store.revertSelected(),
      },
      {
        id: 'reset-soft',
        label: 'Reset soft to selected commit',
        group: 'Git',
        run: () => {
          const sha = store.selectedSha();
          if (sha) void store.resetTo(sha, 'soft');
        },
      },
      {
        id: 'reset-mixed',
        label: 'Reset mixed to selected commit',
        group: 'Git',
        run: () => {
          const sha = store.selectedSha();
          if (sha) void store.resetTo(sha, 'mixed');
        },
      },
      {
        id: 'reset-hard',
        label: 'Hard reset to selected commit…',
        group: 'Git',
        run: () => {
          const sha = store.selectedSha();
          if (sha) void store.resetTo(sha, 'hard');
        },
      },
      {
        id: 'tag',
        label: 'Create tag at selected commit…',
        group: 'Git',
        run: () => {
          void (async () => {
            const sha = store.selectedSha();
            const name = await prompts.ask({
              title: 'Create tag',
              message: sha ? `Tag commit ${sha.slice(0, 7)}.` : 'Select a commit first.',
              label: 'Tag name',
              placeholder: 'v1.0.0',
              confirmLabel: 'Create tag',
              mono: true,
            });
            if (name?.trim() && sha) void store.createTag(name.trim(), sha);
          })();
        },
      },
      {
        id: 'changelog',
        label: 'Extract changelog…',
        group: 'Git',
        run: () => store.openChangelogModal(),
      },
      {
        id: 'close-repo',
        label: 'Disconnect current repository',
        group: 'Repositories',
        run: () => store.closeRepo(),
      },
      {
        id: 'clone',
        label: 'Clone repository…',
        group: 'Repositories',
        run: () => store.openCloneDialog(),
      },
      {
        id: 'theme',
        label: 'Toggle theme',
        group: 'Preferences',
        run: () => void store.toggleTheme(),
      },
      {
        id: 'simple',
        label: 'Toggle Simple / Advanced',
        group: 'Preferences',
        run: () => void store.toggleSimpleMode(),
      },
      {
        id: 'focus',
        label: 'Toggle focus mode',
        group: 'Preferences',
        run: () => void store.toggleFocusMode(),
      },
    ];

    for (const repo of store.repos()) {
      const isOpen = store.currentRepo()?.path === repo.path;
      items.push({
        id: `repo:${repo.path}`,
        label: isOpen ? `Reconnect ${repo.name}` : `Open ${repo.name}`,
        group: 'Repositories',
        run: () => void store.openRepo(repo.path),
      });
    }

    for (const commit of store.commits().slice(0, 80)) {
      items.push({
        id: `commit:${commit.sha}`,
        label: `${commit.shortSha} · ${commit.subject}`,
        group: 'Commits',
        run: () => {
          store.selectCommit(commit.sha);
          store.setView('browse');
          store.setBrowseTab('diff');
        },
      });
    }

    return items;
  });

  private readonly fuse = computed(
    () => new Fuse(this.actions(), { keys: ['label', 'group'], threshold: 0.35 }),
  );

  readonly results = computed(() => {
    const q = this.query().trim();
    const items = this.actions();
    if (!q) return items.slice(0, 12);
    return this.fuse()
      .search(q)
      .map((r) => r.item)
      .slice(0, 16);
  });

  private readonly resetActive = effect(() => {
    this.results();
    this.activeIndex.set(0);
  });

  run(item: PaletteItem): void {
    item.run();
    this.store.paletteOpen.set(false);
    this.query.set('');
  }

  close(): void {
    this.store.paletteOpen.set(false);
    this.query.set('');
  }

  setView(view: AppView): void {
    this.store.setView(view);
  }

  onQueryKeydown(event: KeyboardEvent): void {
    const items = this.results();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!items.length) return;
      this.activeIndex.update((i) => Math.min(items.length - 1, i + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!items.length) return;
      this.activeIndex.update((i) => Math.max(0, i - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[this.activeIndex()];
      if (item) this.run(item);
    }
  }

  @HostListener('document:keydown', ['$event'])
  onDocumentKey(event: KeyboardEvent): void {
    if (!this.store.paletteOpen()) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter') {
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT') return;
      this.onQueryKeydown(event);
    }
  }
}
