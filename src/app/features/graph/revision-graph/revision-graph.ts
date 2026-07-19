import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { CdkConnectedOverlay, type ConnectedPosition } from '@angular/cdk/overlay';
import { AppStore } from '../../../core/app.store';
import type { ArtificialCommit, CommitInfo } from '../../../core/models';

@Component({
  selector: 'app-revision-graph',
  imports: [CdkConnectedOverlay],
  templateUrl: './revision-graph.html',
  styleUrl: './revision-graph.scss',
})
export class RevisionGraph implements AfterViewInit, OnDestroy {
  readonly store = inject(AppStore);
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  readonly menu = signal({ open: false, x: 0, y: 0, sha: '' });
  private suppressMenuCloseUntil = 0;
  private resizeObserver?: ResizeObserver;

  readonly menuOrigin = computed(() => ({
    x: this.menu().x,
    y: this.menu().y,
  }));

  readonly menuPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'top' },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'top' },
  ];

  constructor() {
    effect(() => {
      this.store.commits();
      this.store.artificial();
      this.store.selectedSha();
      this.store.selectedShas();
      this.store.settings().focusMode;
      queueMicrotask(() => this.draw());
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  onClick(event: MouseEvent): void {
    const sha = this.hitTest(event);
    if (!sha) return;
    this.store.selectCommit(sha, event.metaKey || event.ctrlKey);
    this.closeMenu();
  }

  onContext(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const sha = this.hitTest(event);
    if (!sha) return;
    this.store.selectCommit(sha);
    this.suppressMenuCloseUntil = performance.now() + 500;
    this.menu.set({ open: true, x: event.clientX, y: event.clientY, sha });
  }

  closeMenu(): void {
    if (this.menu().open) this.menu.update((m) => ({ ...m, open: false }));
  }

  onMenuDismiss(event?: Event): void {
    if (performance.now() < this.suppressMenuCloseUntil) return;
    if (event instanceof MouseEvent && (event.type === 'auxclick' || event.button === 2)) return;
    this.closeMenu();
  }

  applyHere(): void {
    void this.store.openCherryPickPreview([this.menu().sha]);
    this.closeMenu();
  }

  undoCommit(): void {
    void this.store.revertSelected();
    this.closeMenu();
  }

  checkoutCommit(): void {
    const sha = this.menu().sha;
    const short = sha.slice(0, 7);
    void this.store.createBranch(`checkout/${short}`, sha);
    this.closeMenu();
  }

  private hitTest(event: MouseEvent): string | null {
    const row = Math.floor(event.offsetY / 28);
    const artificial = this.store.artificial();
    if (row < artificial.length) return null;
    const commit = this.store.commits()[row - artificial.length];
    return commit?.sha ?? null;
  }

  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    const parent = canvas.parentElement;
    const width = parent?.clientWidth || 120;
    const artificial = this.store.artificial();
    const commits = this.store.commits();
    const rowH = 28;
    const height = Math.max((artificial.length + commits.length) * rowH, parent?.clientHeight || 200);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const laneColors = [
      styles.getPropertyValue('--lane-1').trim() || '#3ecfff',
      styles.getPropertyValue('--lane-2').trim() || '#6b9fff',
      styles.getPropertyValue('--lane-3').trim() || '#e8b84a',
      styles.getPropertyValue('--lane-4').trim() || '#ff7b72',
      styles.getPropertyValue('--lane-5').trim() || '#5eead4',
      styles.getPropertyValue('--lane-6').trim() || '#34d399',
      styles.getPropertyValue('--lane-7').trim() || '#fb923c',
      styles.getPropertyValue('--lane-8').trim() || '#94a3b8',
    ];
    const focus = this.store.settings().focusMode;
    const selected = new Set(this.store.selectedShas());
    const selectedSha = this.store.selectedSha();

    artificial.forEach((a: ArtificialCommit, i: number) => {
      const y = i * rowH + rowH / 2;
      const color = a.kind === 'staged' ? laneColors[1] : laneColors[0];
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.setLineDash([3, 3]);
      ctx.moveTo(24, y);
      ctx.lineTo(24, y + rowH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(24, y, 5, 0, Math.PI * 2);
      ctx.fill();
    });

    const offset = artificial.length;
    commits.forEach((c: CommitInfo, i: number) => {
      const y = (offset + i) * rowH + rowH / 2;
      const lane = Math.max(0, c.laneHint % laneColors.length);
      const x = 24 + lane * 14;
      const dim = focus && !c.isRelativeToHead;
      ctx.globalAlpha = dim ? 0.22 : 1;
      const color = laneColors[lane];
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y - rowH / 2);
      ctx.lineTo(x, y + rowH / 2);
      ctx.stroke();
      if (c.parents.length > 1) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 14, y - 8);
        ctx.stroke();
      }
      const isSel = selected.has(c.sha) || c.sha === selectedSha;
      ctx.beginPath();
      ctx.arc(x, y, isSel ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = styles.getPropertyValue('--text-primary').trim() || '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
    ctx.globalAlpha = 1;
  }
}
