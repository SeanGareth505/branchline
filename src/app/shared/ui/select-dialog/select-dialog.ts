import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgIcon } from '@ng-icons/core';
import { SelectService, type SelectOption } from './select.service';

@Component({
  selector: 'app-select-dialog',
  imports: [FormsModule, NgIcon],
  templateUrl: './select-dialog.html',
  styleUrl: './select-dialog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelectDialog {
  readonly selects = inject(SelectService);
  readonly filter = signal('');
  readonly selected = signal('');
  private readonly filterRef = viewChild<ElementRef<HTMLInputElement>>('filterField');

  readonly visibleOptions = computed(() => {
    const req = this.selects.request();
    if (!req) return [] as SelectOption[];
    const q = this.filter().trim().toLowerCase();
    if (!q) return req.options;
    return req.options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.hint?.toLowerCase().includes(q) ?? false),
    );
  });

  readonly showFilter = computed(() => {
    const req = this.selects.request();
    if (!req) return false;
    if (typeof req.filterable === 'boolean') return req.filterable;
    return req.options.length > 6;
  });

  constructor() {
    effect(() => {
      const req = this.selects.request();
      if (!req) return;
      this.filter.set('');
      const initial = req.initialValue;
      const match = req.options.find((o) => o.value === initial && !o.disabled);
      this.selected.set(match?.value ?? req.options.find((o) => !o.disabled)?.value ?? '');
      queueMicrotask(() => {
        if (this.showFilter()) {
          this.filterRef()?.nativeElement.focus();
        }
      });
    });
  }

  canSubmit(): boolean {
    const value = this.selected();
    if (!value) return false;
    const opt = this.selects.request()?.options.find((o) => o.value === value);
    return !!opt && !opt.disabled;
  }

  pick(option: SelectOption): void {
    if (option.disabled) return;
    this.selected.set(option.value);
  }

  submit(): void {
    if (!this.canSubmit()) return;
    this.selects.submit(this.selected());
  }

  cancel(): void {
    this.selects.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (!this.selects.request()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.submit();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    }
  }

  private moveSelection(delta: number): void {
    const opts = this.visibleOptions().filter((o) => !o.disabled);
    if (opts.length === 0) return;
    const idx = opts.findIndex((o) => o.value === this.selected());
    const next = opts[(idx < 0 ? 0 : idx + delta + opts.length) % opts.length];
    this.selected.set(next.value);
  }
}
