import { Directive, EventEmitter, HostListener, Output } from '@angular/core';
@Directive({ selector: '[appSwipeBack]', standalone: false })
export class SwipeBackDirective {
  @Output() swipeBack = new EventEmitter<void>();
  private startX = 0; private startY = 0; private tracking = false;
  @HostListener('touchstart', ['$event']) onStart(e: TouchEvent) {
    const t = e.touches[0]; if (!t) return;
    if (t.clientX <= 28) { this.tracking = true; this.startX = t.clientX; this.startY = t.clientY; }
  }
  @HostListener('touchend', ['$event']) onEnd(e: TouchEvent) {
    if (!this.tracking) return; this.tracking = false;
    const t = e.changedTouches[0]; if (!t) return;
    const dx = t.clientX - this.startX; const dy = Math.abs(t.clientY - this.startY);
    if (dx > 70 && dy < 60) this.swipeBack.emit();
  }
}
