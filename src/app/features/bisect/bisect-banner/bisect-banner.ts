import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { NgIcon } from '@ng-icons/core';
import { AppStore } from '../../../core/app.store';

@Component({
  selector: 'app-bisect-banner',
  imports: [NgIcon],
  templateUrl: './bisect-banner.html',
  styleUrl: './bisect-banner.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BisectBanner {
  readonly store = inject(AppStore);

  readonly status = computed(() => this.store.bisectStatus());

  readonly title = computed(() => {
    const s = this.status();
    if (!s?.active) return 'Bisect';
    const sha = s.currentShortSha || s.currentSha.slice(0, 7);
    return sha ? `Bisecting ${sha}` : 'Bisect in progress';
  });

  readonly hint = computed(() => {
    const s = this.status();
    if (!s?.active) return '';
    if (s.stepsLeft) return s.stepsLeft;
    if (s.logTail) {
      const last = s.logTail.trim().split('\n').at(-1);
      if (last) return last;
    }
    return 'Mark this commit good, bad, or skip. Reset to leave bisect.';
  });
}
