import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-empty-state',
  imports: [],
  templateUrl: './empty-state.html',
  styleUrl: './empty-state.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmptyState {
  @Input() title = 'Nothing here yet';
  @Input() message = '';
  @Input() ctaLabel = '';
  @Output() cta = new EventEmitter<void>();
}
