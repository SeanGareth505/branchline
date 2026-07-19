import { Component, inject } from '@angular/core';
import { UpdateService } from '../../../core/update.service';

@Component({
  selector: 'app-update-banner',
  imports: [],
  templateUrl: './update-banner.html',
  styleUrl: './update-banner.scss',
})
export class UpdateBanner {
  readonly updates = inject(UpdateService);
}
