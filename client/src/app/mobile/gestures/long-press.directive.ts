import { Directive, EventEmitter, HostListener, Output } from '@angular/core';
@Directive({ selector: '[appLongPress]', standalone: false })
export class LongPressDirective {
  @Output() longPress = new EventEmitter<void>();
  private timer: any = null;
  @HostListener('touchstart') start() { this.clear(); this.timer = setTimeout(() => this.longPress.emit(), 450); }
  @HostListener('touchend') end() { this.clear(); }
  @HostListener('touchmove') move() { this.clear(); }
  private clear() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
