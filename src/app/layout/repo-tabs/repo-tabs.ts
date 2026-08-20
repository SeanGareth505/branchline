import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  CdkConnectedOverlay,
  CdkOverlayOrigin,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../core/app.store';
import type { RepoSummary } from '../../core/models';
import { assignIdentityColors, repoIdentityKey } from '../../shared/ui/identity-color';

@Component({
  selector: 'app-repo-tabs',
  imports: [NgIcon, CdkConnectedOverlay, CdkOverlayOrigin],
  templateUrl: './repo-tabs.html',
  styleUrl: './repo-tabs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.empty]': '!count()',
  },
})
export class RepoTabs {
  readonly store = inject(AppStore);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly tabsRef = viewChild<ElementRef<HTMLElement>>('tabs');

  readonly menuOpen = signal(false);
  readonly query = signal('');
  readonly overflowStart = signal(false);
  readonly overflowEnd = signal(false);
  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
  ];

  readonly count = computed(() => this.store.visibleOpenRepos().length);
  readonly showPicker = computed(() => this.count() > 1);
  readonly showSearch = computed(() => this.count() >= 6);
  readonly filteredRepos = computed(() => {
    const q = this.query().trim().toLowerCase();
    const repos = this.store.visibleOpenRepos();
    if (!q) return repos;
    return repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(q) ||
        repo.path.toLowerCase().includes(q) ||
        (repo.branch ?? '').toLowerCase().includes(q),
    );
  });

  constructor() {
    const destroy = inject(DestroyRef);

    afterNextRender(() => {
      const onWheel = (event: WheelEvent) => {
        const from = event.target instanceof Element ? event.target : (event.target as Node).parentElement;
        const tabs = from?.closest('.tabs') as HTMLElement | null;
        if (!tabs || tabs.scrollWidth <= tabs.clientWidth + 1) return;
        const delta =
          Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
        if (!delta) return;
        const prev = tabs.scrollLeft;
        tabs.scrollLeft += delta;
        if (tabs.scrollLeft !== prev) event.preventDefault();
        this.syncOverflow();
      };
      this.host.nativeElement.addEventListener('wheel', onWheel, { passive: false });
      destroy.onDestroy(() =>
        this.host.nativeElement.removeEventListener('wheel', onWheel),
      );

      const observer = new ResizeObserver(() => this.syncOverflow());
      observer.observe(this.host.nativeElement);
      destroy.onDestroy(() => observer.disconnect());
    });

    effect(() => {
      const path = this.store.currentRepo()?.path;
      this.store.visibleOpenRepos();
      if (!path) return;
      untracked(() => {
        requestAnimationFrame(() => {
          this.scrollActiveIntoView();
          this.syncOverflow();
        });
      });
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.menuOpen.set(false);
  }

  private readonly tabColors = computed(() =>
    assignIdentityColors(this.store.visibleOpenRepos().map((repo) => repoIdentityKey(repo.name, repo.path))),
  );

  colorFor(repo: RepoSummary): string {
    const key = repoIdentityKey(repo.name, repo.path);
    return this.tabColors().get(key) ?? `var(--swatch-1)`;
  }

  select(path: string): void {
    this.closeMenu();
    void this.store.switchOpenRepo(path);
  }

  close(path: string, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    void this.store.closeOpenRepo(path);
  }

  closeOthers(): void {
    this.closeMenu();
    this.store.closeOtherOpenRepos();
  }

  tooltip(name: string, branch?: string | null): string {
    return branch ? `${name} · ${branch}` : name;
  }

  onScroll(): void {
    this.syncOverflow();
  }

  onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  toggleMenu(): void {
    this.menuOpen.update((open) => !open);
    if (this.menuOpen()) this.query.set('');
  }

  closeMenu(): void {
    this.menuOpen.set(false);
    this.query.set('');
  }

  private syncOverflow(): void {
    const tabs = this.tabsRef()?.nativeElement;
    if (!tabs) {
      this.overflowStart.set(false);
      this.overflowEnd.set(false);
      return;
    }
    const start = tabs.scrollLeft > 2;
    const end = tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 2;
    this.overflowStart.set(start);
    this.overflowEnd.set(end);
  }

  private scrollActiveIntoView(): void {
    const tabs = this.tabsRef()?.nativeElement;
    const active = tabs?.querySelector<HTMLElement>('.tab.active');
    if (!tabs || !active) return;
    const pad = 12;
    const left = active.offsetLeft;
    const right = left + active.offsetWidth;
    if (left < tabs.scrollLeft + pad) {
      tabs.scrollLeft = Math.max(0, left - pad);
      return;
    }
    if (right > tabs.scrollLeft + tabs.clientWidth - pad) {
      tabs.scrollLeft = right - tabs.clientWidth + pad;
    }
  }
}
