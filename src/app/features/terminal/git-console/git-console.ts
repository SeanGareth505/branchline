import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AppStore } from '../../../core/app.store';
import { TauriService } from '../../../core/tauri.service';

@Component({
  selector: 'app-git-console',
  imports: [FormsModule],
  templateUrl: './git-console.html',
  styleUrl: './git-console.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GitConsole {
  private readonly tauri = inject(TauriService);
  readonly store = inject(AppStore);
  readonly lines = signal<string[]>([]);
  readonly command = signal('status -sb');
  readonly running = signal(false);
  private autoPath: string | null = null;

  constructor() {
    effect(() => {
      const path = this.store.currentRepo()?.path ?? null;
      const tab = this.store.browseTab();
      if (tab === 'console' && path && this.autoPath !== path) {
        this.autoPath = path;
        void this.runQuick('status -sb');
      }
    });
  }

  async runQuick(cmd: string): Promise<void> {
    this.command.set(cmd);
    await this.run();
  }

  async run(): Promise<void> {
    const path = this.store.currentRepo()?.path;
    const raw = this.command().trim();
    if (!path || !raw) return;
    const args = this.parseArgs(raw);
    this.running.set(true);
    const next = [...this.lines(), `$ git ${raw}`];
    try {
      const result = await this.tauri.runGitCommand(path, args, { console: true });
      const out = (result.stdout || result.stderr || (result.ok ? '(no output)' : 'failed'))
        .replace(/\r\n/g, '\n')
        .trimEnd();
      for (const line of out.split('\n')) {
        next.push(line);
      }
      if (!result.ok && result.stderr && result.stdout) {
        next.push(result.stderr.trimEnd());
      }
    } catch (err) {
      next.push(this.store.formatError(err));
    } finally {
      next.push('');
      this.lines.set(next.slice(-400));
      this.running.set(false);
    }
  }

  clear(): void {
    this.lines.set([]);
  }

  private parseArgs(raw: string): string[] {
    const cleaned = raw.replace(/^git\s+/i, '').trim();
    const args: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (const ch of cleaned) {
      if (quote) {
        if (ch === quote) {
          quote = null;
        } else {
          current += ch;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) {
        if (current) {
          args.push(current);
          current = '';
        }
        continue;
      }
      current += ch;
    }
    if (current) args.push(current);
    return args;
  }
}
