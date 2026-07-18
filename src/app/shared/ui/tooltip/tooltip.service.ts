import { Injectable, OnDestroy } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TooltipService implements OnDestroy {
  private tip: HTMLDivElement | null = null;
  private active: HTMLElement | null = null;
  private showTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs = 280;
  private bound = false;

  init(): void {
    if (this.bound || typeof document === 'undefined') {
      return;
    }
    this.bound = true;
    document.addEventListener('pointerover', this.onPointerOver, true);
    document.addEventListener('pointerout', this.onPointerOut, true);
    document.addEventListener('pointerdown', this.hide, true);
    document.addEventListener('keydown', this.hide, true);
    document.addEventListener('scroll', this.hide, true);
    window.addEventListener('blur', this.hide);
  }

  ngOnDestroy(): void {
    this.hide();
    if (!this.bound) {
      return;
    }
    document.removeEventListener('pointerover', this.onPointerOver, true);
    document.removeEventListener('pointerout', this.onPointerOut, true);
    document.removeEventListener('pointerdown', this.hide, true);
    document.removeEventListener('keydown', this.hide, true);
    document.removeEventListener('scroll', this.hide, true);
    window.removeEventListener('blur', this.hide);
    this.bound = false;
  }

  private readonly onPointerOver = (event: PointerEvent): void => {
    const el = this.findTarget(event.target);
    if (!el || el === this.active) {
      return;
    }

    const text = this.readText(el);
    if (!text) {
      return;
    }

    this.hide();
    this.active = el;
    this.stashNativeTitle(el);
    this.showTimer = setTimeout(() => {
      if (this.active === el) {
        this.render(el, text);
      }
    }, this.delayMs);
  };

  private readonly onPointerOut = (event: PointerEvent): void => {
    if (!this.active) {
      return;
    }
    const related = event.relatedTarget as Node | null;
    if (related && this.active.contains(related)) {
      return;
    }
    const from = this.findTarget(event.target);
    if (from !== this.active) {
      return;
    }
    this.hide();
  };

  private readonly hide = (): void => {
    if (this.showTimer) {
      clearTimeout(this.showTimer);
      this.showTimer = null;
    }
    if (this.active) {
      this.restoreNativeTitle(this.active);
      this.active = null;
    }
    if (this.tip) {
      this.tip.remove();
      this.tip = null;
    }
  };

  private findTarget(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) {
      return null;
    }
    return target.closest<HTMLElement>('[data-tooltip], [title], [data-bl-title]');
  }

  private readText(el: HTMLElement): string {
    return (
      el.getAttribute('data-tooltip')?.trim() ||
      el.getAttribute('data-bl-title')?.trim() ||
      el.getAttribute('title')?.trim() ||
      ''
    );
  }

  private stashNativeTitle(el: HTMLElement): void {
    const title = el.getAttribute('title');
    if (title) {
      el.setAttribute('data-bl-title', title);
      el.removeAttribute('title');
    }
  }

  private restoreNativeTitle(el: HTMLElement): void {
    const stored = el.getAttribute('data-bl-title');
    if (stored != null) {
      el.setAttribute('title', stored);
      el.removeAttribute('data-bl-title');
    }
  }

  private render(el: HTMLElement, text: string): void {
    const tip = document.createElement('div');
    tip.className = 'bl-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;
    document.body.appendChild(tip);

    const rect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    let top = rect.bottom + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    if (top + tipRect.height > window.innerHeight - 8) {
      top = rect.top - tipRect.height - 8;
      tip.classList.add('bl-tooltip-above');
    }
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    requestAnimationFrame(() => tip.classList.add('bl-tooltip-visible'));
    this.tip = tip;
  }
}
