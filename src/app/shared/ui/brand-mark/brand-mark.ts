import { Component, Input } from '@angular/core';

let markSeq = 0;

@Component({
  selector: 'app-brand-mark',
  templateUrl: './brand-mark.html',
  styleUrl: './brand-mark.scss',
})
export class BrandMark {
  @Input() size: number | string = 20;
  @Input() title = 'Branchline';

  private readonly uid = ++markSeq;

  readonly gradBg = `bl-bg-${this.uid}`;
  readonly gradStroke = `bl-stroke-${this.uid}`;
  readonly gradNode = `bl-node-${this.uid}`;

  get dimension(): string {
    return typeof this.size === 'number' ? `${this.size}px` : this.size;
  }
}
