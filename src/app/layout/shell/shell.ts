import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore, type AppView } from '../../core/app.store';
import { WorkflowsPage } from '../../features/automation/workflows-page/workflows-page';
import { CherryPickPreview } from '../../features/cherry-pick/cherry-pick-preview/cherry-pick-preview';
import { ChangelogDialog } from '../../features/changelog/changelog-dialog/changelog-dialog';
import { CommitDialog } from '../../features/commits/commit-dialog/commit-dialog';
import { JiraPanel } from '../../features/jira/jira-panel/jira-panel';
import { OnboardingWizard } from '../../features/onboarding/onboarding-wizard/onboarding-wizard';
import { ProfilesPage } from '../../features/profiles/profiles-page/profiles-page';
import { PrPanel } from '../../features/pull-requests/pr-panel/pr-panel';
import { SettingsPage } from '../../features/settings/settings-page/settings-page';
import { TemplatesPage } from '../../features/templates/templates-page/templates-page';
import { BrandMark } from '../../shared/ui/brand-mark/brand-mark';
import { PromptDialog } from '../../shared/ui/prompt-dialog/prompt-dialog';
import { SelectDialog } from '../../shared/ui/select-dialog/select-dialog';
import { SafetyDialog } from '../../shared/ui/safety-dialog/safety-dialog';
import { Spinner } from '../../shared/ui/spinner/spinner';
import { CloneDialog } from '../../features/repositories/clone-dialog/clone-dialog';
import { CreateBranchDialog } from '../../features/branches/create-branch-dialog/create-branch-dialog';
import { InteractiveRebaseDialog } from '../../features/rebase/interactive-rebase-dialog/interactive-rebase-dialog';
import { ConflictResolverDialog } from '../../features/conflicts/conflict-resolver-dialog/conflict-resolver-dialog';
import { IgnoreEditorDialog } from '../../features/ignore/ignore-editor-dialog/ignore-editor-dialog';
import { PublishGithubDialog } from '../../features/publish/publish-github-dialog/publish-github-dialog';
import { CreatePrDialog } from '../../features/pull-requests/create-pr-dialog/create-pr-dialog';
import { GithubDeviceLoginDialog } from '../../features/auth/github-device-login-dialog/github-device-login-dialog';
import { RemoteTroubleshootDialog } from '../../features/remotes/remote-troubleshoot-dialog/remote-troubleshoot-dialog';
import { ReleaseDialog } from '../../features/release/release-dialog/release-dialog';
import { ReleasePage } from '../../features/release/release-page/release-page';
import { BrowseShell } from '../browse-shell/browse-shell';
import { CommandPalette } from '../command-palette/command-palette';
import { FileSearchDialog } from '../../features/search/file-search-dialog/file-search-dialog';
import { ShortcutOverlay } from '../shortcut-overlay/shortcut-overlay';
import { ProjectSwitcher } from '../project-switcher/project-switcher';
import { RepoTabs } from '../repo-tabs/repo-tabs';
import { RepoToolbar } from '../repo-toolbar/repo-toolbar';
import { StatusBar } from '../status-bar/status-bar';
import { ToastHost } from '../toast-host/toast-host';
import { UpdateBanner } from '../../features/updates/update-banner/update-banner';
import { UpdateService } from '../../core/update.service';

type ReleaseNavStatus = 'running' | 'success' | 'failure' | 'paused';

@Component({
  selector: 'app-shell',
  imports: [
    NgIcon,
    BrandMark,
    Spinner,
    ProjectSwitcher,
    RepoTabs,
    RepoToolbar,
    BrowseShell,
    OnboardingWizard,
    SettingsPage,
    PrPanel,
    JiraPanel,
    ReleasePage,
    ProfilesPage,
    WorkflowsPage,
    TemplatesPage,
    StatusBar,
    CommandPalette,
    ShortcutOverlay,
    FileSearchDialog,
    ToastHost,
    SafetyDialog,
    PromptDialog,
    SelectDialog,
    CherryPickPreview,
    CommitDialog,
    ChangelogDialog,
    CloneDialog,
    CreateBranchDialog,
    InteractiveRebaseDialog,
    ConflictResolverDialog,
    IgnoreEditorDialog,
    PublishGithubDialog,
    CreatePrDialog,
    GithubDeviceLoginDialog,
    RemoteTroubleshootDialog,
    ReleaseDialog,
    UpdateBanner,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  readonly store = inject(AppStore);
  readonly updates = inject(UpdateService);

  readonly appliedTheme = computed(() => {
    const preference = this.store.settings().theme;
    if (preference === 'dark' || preference === 'light') return preference;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  readonly themeToggleIcon = computed(() =>
    this.appliedTheme() === 'light' ? 'lucideMoon' : 'lucideSun',
  );

  readonly themeToggleLabel = computed(() =>
    this.appliedTheme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme',
  );

  nav(view: AppView): void {
    if (view === 'settings') {
      const section = this.store.settingsSection();
      this.store.openSettings(section === 'repos' ? 'appearance' : section);
      return;
    }
    this.store.setView(view);
  }

  goRepos(): void {
    if (this.store.currentRepo()) {
      this.store.setView('browse');
      return;
    }
    this.store.goHome();
  }

  isActive(view: AppView): boolean {
    return this.store.view() === view;
  }

  readonly releaseNavStatus = computed((): ReleaseNavStatus | null => {
    if (this.store.view() === 'release' && this.store.releaseAttaching()) return 'running';
    const activity = this.store.visibleReleaseActivity();
    if (!activity) return null;
    if (activity.phase === 'error' || activity.ok === false) return 'failure';
    const jobs = activity.deployJobs ?? [];
    let pending = false;
    let failed = false;
    for (const job of jobs) {
      const conclusion = job.conclusion?.trim() ?? '';
      if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') {
        failed = true;
        continue;
      }
      if (conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral') {
        continue;
      }
      if (job.status.trim() !== 'completed') pending = true;
    }
    if (this.store.releaseBusy() || pending) return 'running';
    if (failed) return 'failure';
    if (activity.needsRefresh) return 'paused';
    if (activity.phase === 'done') return 'success';
    return 'running';
  });

  readonly releaseNavLabel = computed(() => {
    switch (this.releaseNavStatus()) {
      case 'running':
        return 'Release in progress';
      case 'success':
        return 'Last release succeeded';
      case 'failure':
        return 'Release failed';
      case 'paused':
        return 'Release tracking paused';
      default:
        return '';
    }
  });

  readonly releaseNavTitle = computed(() => {
    const label = this.releaseNavLabel();
    return label
      ? `Ship versions, track release progress — ${label}`
      : 'Ship versions, track release progress';
  });
}
