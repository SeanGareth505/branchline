import { Component, OnInit, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { TemplateInfo } from '../../../core/models';
import { PageSkeleton } from '../../../shared/ui/page-skeleton/page-skeleton';

@Component({
  selector: 'app-templates-page',
  imports: [NgIcon, PageSkeleton],
  templateUrl: './templates-page.html',
  styleUrl: './templates-page.scss',
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
    return kind === 'commit' ? 'lucideGitCommitHorizontal' : 'lucideGitBranch';
  }

  kindHint(kind: string): string {
    return kind === 'commit' ? 'Commit message pattern' : 'Branch name pattern';
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
    this.store.applyCommitTemplate(template);
  }
}
