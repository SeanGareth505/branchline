import { Component, computed, effect, inject, signal } from '@angular/core';
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
})
export class CommandPalette {
  readonly store = inject(AppStore);
  private readonly prompts = inject(PromptService);
  private readonly updates = inject(UpdateService);
  readonly query = signal('');

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
        id: 'stash-pop',
        label: 'Pop latest stash',
        group: 'Git',
        run: () => void store.stashPop(0),
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
        id: 'continue',
        label: 'Continue merge / rebase / cherry-pick',
        group: 'Git',
        run: () => void store.continueOperation(),
      },
      {
        id: 'abort',
        label: 'Abort merge / rebase / cherry-pick',
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
        label: 'Create pull request in browser…',
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
        label: 'Apply this commit here…',
        group: 'Git',
        run: () => void store.openCherryPickPreview(),
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

  readonly results = computed(() => {
    const q = this.query().trim();
    const items = this.actions();
    if (!q) return items.slice(0, 12);
    const fuse = new Fuse(items, { keys: ['label', 'group'], threshold: 0.35 });
    return fuse.search(q).map((r) => r.item).slice(0, 16);
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
}
