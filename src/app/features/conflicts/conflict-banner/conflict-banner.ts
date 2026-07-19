import { Component, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';

@Component({
  selector: 'app-conflict-banner',
  imports: [NgIcon],
  templateUrl: './conflict-banner.html',
  styleUrl: './conflict-banner.scss',
})
export class ConflictBanner {
  readonly store = inject(AppStore);
  private readonly tauri = inject(TauriService);

  async open(tool: 'cursor' | 'vscode' | 'merge'): Promise<void> {
    const repo = this.store.currentRepo()?.path;
    const conflicted = this.store.status()?.conflicted.map((f) => f.path) ?? [];
    if (!repo) {
      this.store.showWarning('Open a repository first');
      return;
    }

    if (tool === 'merge') {
      await this.openMergeTool(repo, conflicted);
      return;
    }

    const target = conflicted[0]
      ? `${repo.replace(/\/+$/, '')}/${conflicted[0]}`
      : repo;
    const scheme = tool === 'cursor' ? 'cursor' : 'vscode';
    const url = `${scheme}://file${this.asAbsoluteUriPath(target)}`;
    try {
      await this.tauri.openExternalUrl(url);
      if (conflicted.length > 1) {
        this.store.showInfo(`Opened ${conflicted[0]} — ${conflicted.length - 1} more conflicted file(s)`);
      }
    } catch (err) {
      this.store.showError(err);
    }
  }

  continueOp(): void {
    void this.store.continueOperation();
  }

  abortOp(): void {
    void this.store.abortOperation();
  }

  private async openMergeTool(repo: string, conflicted: string[]): Promise<void> {
    const configured = this.store.settings().mergeTool?.trim();
    try {
      if (configured) {
        const result = await this.tauri.runGitCommand(repo, [
          '-c',
          `merge.tool=${configured}`,
          'mergetool',
          '--no-prompt',
          ...conflicted,
        ]);
        if (!result.ok) {
          this.store.showWarning(result.stderr || result.stdout || 'Merge tool exited with errors');
        } else {
          this.store.showSuccess(result.stdout || 'Opened merge tool');
        }
      } else {
        const result = await this.tauri.runGitCommand(repo, ['mergetool', '--no-prompt', ...conflicted]);
        if (!result.ok) {
          this.store.showWarning(
            result.stderr ||
              result.stdout ||
              'No merge tool configured — set one in Settings → Tools',
          );
        } else {
          this.store.showSuccess(result.stdout || 'Opened merge tool');
        }
      }
      await this.store.refreshRepo();
    } catch (err) {
      this.store.showError(err);
    }
  }

  private asAbsoluteUriPath(path: string): string {
    const normalized = path.replace(/\\/g, '/');
    return normalized.startsWith('/') ? normalized : `/${normalized}`;
  }
}
