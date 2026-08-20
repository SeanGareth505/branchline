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
import { HelpTip } from '../../../shared/ui/help-tip/help-tip';
import { ReleaseDialogService } from './release-dialog.service';

type BumpKind = 'patch' | 'minor' | 'major' | 'custom';

@Component({
  selector: 'app-release-dialog',
  imports: [FormsModule, NgIcon, HelpTip],
  templateUrl: './release-dialog.html',
  styleUrl: './release-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleaseDialog {
  readonly dialog = inject(ReleaseDialogService);

  readonly bump = signal<BumpKind>('patch');
  readonly customVersion = signal('');
  readonly branch = signal('');
  readonly push = signal(true);
  readonly allowDirty = signal(false);
  readonly preid = signal('');
  readonly tagMessage = signal('');
  readonly notes = signal('');
  readonly settingsOpen = signal(false);

  readonly nextVersion = computed(() => {
    const req = this.dialog.request();
    if (!req) return '';
    return previewBump(req.currentVersion, this.bump(), this.customVersion(), this.preid());
  });

  readonly bumpOptions = computed(() => {
    const req = this.dialog.request();
    const current = req?.currentVersion || '0.0.0';
    const preid = this.preid();
    return [
      {
        kind: 'patch' as const,
        label: 'Patch',
        hint: `Bug fixes — ${current} → ${previewBump(current, 'patch', '', preid)}`,
      },
      {
        kind: 'minor' as const,
        label: 'Minor',
        hint: `New features — ${current} → ${previewBump(current, 'minor', '', preid)}`,
      },
      {
        kind: 'major' as const,
        label: 'Major',
        hint: `Breaking changes — ${current} → ${previewBump(current, 'major', '', preid)}`,
      },
      {
        kind: 'custom' as const,
        label: 'Custom',
        hint: 'Set an explicit x.y.z version',
      },
    ];
  });

  readonly dirtyBlocked = computed(() => {
    const req = this.dialog.request();
    if (!req) return false;
    return req.dirty && req.config.requireClean && !this.allowDirty();
  });

  readonly canSubmit = computed(() => {
    if (this.dirtyBlocked()) return false;
    if (this.bump() === 'custom') {
      return !!this.customVersion().trim();
    }
    return !!this.bump();
  });

  readonly submitLabel = computed(() => {
    const next = this.nextVersion();
    const verb = this.push() ? 'Release & deploy' : 'Create release';
    return next ? `${verb} ${next}` : verb;
  });

  constructor() {
    effect(() => {
      const req = this.dialog.request();
      if (!req) return;
      this.bump.set(req.preferredBump ?? 'patch');
      this.customVersion.set('');
      this.branch.set(req.config.branch || req.currentBranch);
      this.push.set(req.config.pushDefault);
      this.allowDirty.set(false);
      this.preid.set('');
      this.tagMessage.set('');
      this.notes.set(req.config.commitMessage || '');
      this.settingsOpen.set(false);
    });
  }

  toggleSettings(): void {
    this.settingsOpen.update((v) => !v);
  }

  pickBump(kind: BumpKind): void {
    this.bump.set(kind);
  }

  submit(): void {
    if (!this.canSubmit()) return;
    const req = this.dialog.request();
    if (!req) return;
    const bump = this.bump() === 'custom' ? this.customVersion().trim() : this.bump();
    const branch = this.branch().trim();
    const notes = this.notes().trim();
    const defaultNotes = req.config.commitMessage.trim();
    this.dialog.submit({
      bump,
      branch: (() => {
        const picked = branch.trim();
        if (!picked || picked === req.config.branch) return null;
        return picked;
      })(),
      push: this.push(),
      allowDirty: this.allowDirty(),
      preid: this.preid().trim() || null,
      message: !notes || notes === defaultNotes ? null : notes,
      tagMessage: this.tagMessage().trim() || null,
    });
  }

  cancel(): void {
    this.dialog.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.dialog.request()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter' && !this.settingsOpen()) {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === 'TEXTAREA' ||
        (target?.tagName === 'INPUT' && target.getAttribute('type') !== 'checkbox')
      ) {
        return;
      }
      event.preventDefault();
      this.submit();
    }
  }
}

function previewBump(current: string, bump: BumpKind, custom: string, preid: string): string {
  if (bump === 'custom') return custom.trim();
  const trimmed = current.trim();
  const [coreRaw, preRaw] = trimmed.split('-');
  const core = (coreRaw ?? trimmed).split('+')[0] ?? trimmed;
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return '';
  let [major, minor, patch] = parts;
  const id = preid.trim();
  if (id) {
    const pre = (preRaw ?? '').split('+')[0] ?? '';
    const segs = pre.split('.').filter(Boolean);
    const samePre = segs[0] === id && segs.length >= 2 && /^\d+$/.test(segs[1] ?? '');
    if (samePre) {
      const n = Number.parseInt(segs[1] ?? '0', 10) + 1;
      return `${major}.${minor}.${patch}-${id}.${n}`;
    }
    if (bump === 'major') {
      major += 1;
      minor = 0;
      patch = 0;
    } else if (bump === 'minor') {
      minor += 1;
      patch = 0;
    } else {
      patch += 1;
    }
    return `${major}.${minor}.${patch}-${id}.0`;
  }
  if (preRaw) return `${major}.${minor}.${patch}`;
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
