import { Component, OnInit, inject, signal } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';
import type { TemplateInfo } from '../../../core/models';

@Component({
  selector: 'app-templates-page',
  imports: [NgIcon],
  templateUrl: './templates-page.html',
  styleUrl: './templates-page.scss',
})
export class TemplatesPage implements OnInit {
  private readonly tauri = inject(TauriService);
  private readonly store = inject(AppStore);
  readonly templates = signal<TemplateInfo[]>([]);

  async ngOnInit(): Promise<void> {
    this.templates.set(await this.tauri.listTemplates());
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
}
