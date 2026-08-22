import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { TemplateInfo } from '../../../core/models';
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { PageSkeleton } from '../../../shared/ui/page-skeleton/page-skeleton';

@Component({
  selector: 'app-templates-page',
  imports: [NgIcon, HelpTip, PageSkeleton],
  templateUrl: './templates-page.html',
  styleUrl: './templates-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesPage implements OnInit {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);
  readonly templates = signal<TemplateInfo[]>([]);
  readonly loading = signal(true);

  async ngOnInit(): Promise<void> {
    this.loading.set(true);
    try {
      this.templates.set(await this.tauri.listTemplates());
    } catch (err) {
      this.store.showError(err);
    } finally {
      this.loading.set(false);
    }
  }

  iconFor(kind: string): string {
    if (kind === 'commit') return 'lucideGitCommitHorizontal';
    if (kind === 'pullRequest') return 'lucideGitPullRequest';
    return 'lucideGitBranch';
  }

  kindHint(kind: string): string {
    if (kind === 'commit') return 'Commit message pattern';
    if (kind === 'pullRequest') return 'Pull request description';
    return 'Branch name pattern';
  }

  async copy(pattern: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(pattern);
      this.store.showSuccess('Copied template pattern');
    } catch {
      this.store.showError('Could not copy pattern');
    }
  }

  use(template: TemplateInfo): void {
    if (template.kind === 'branch') {
      this.store.applyBranchTemplate(template);
      return;
    }
    if (template.kind === 'pullRequest') {
      this.store.applyPrTemplate(template);
      return;
    }
    this.store.applyCommitTemplate(template);
  }
}
