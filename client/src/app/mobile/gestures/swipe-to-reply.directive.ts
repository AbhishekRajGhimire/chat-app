import { Directive, ElementRef, EventEmitter, HostListener, Output } from '@angular/core';
@Directive({ selector: '[appSwipeToReply]', standalone: false })
export class SwipeToReplyDirective {
  @Output() swipeReply = new EventEmitter<void>();
  private startX = 0; private startY = 0; private tracking = false;
  constructor(private ref: ElementRef<HTMLElement>) {}
  @HostListener('touchstart', ['$event']) start(e: TouchEvent) {
    const t = e.touches[0]; if (!t) return;
    this.startX = t.clientX; this.startY = t.clientY; this.tracking = true;
  }
  @HostListener('touchmove', ['$event']) move(e: TouchEvent) {
    if (!this.tracking) return;
    const t = e.touches[0]; if (!t) return;
    const dx = t.clientX - this.startX; const dy = Math.abs(t.clientY - this.startY);
    if (dy > Math.abs(dx)) { this.reset(); return; }            // vertical scroll wins
    if (dx > 0) this.ref.nativeElement.style.transform = `translateX(${Math.min(dx, 64)}px)`;
  }
  @HostListener('touchend', ['$event']) end(e: TouchEvent) {
    if (!this.tracking) return; this.tracking = false;
    const t = e.changedTouches[0]; const dx = t ? t.clientX - this.startX : 0;
    this.ref.nativeElement.style.transform = '';
    this.ref.nativeElement.style.transition = 'transform 0.15s ease';
    setTimeout(() => (this.ref.nativeElement.style.transition = ''), 160);
    if (dx > 56) this.swipeReply.emit();
  }
  private reset() { this.tracking = false; this.ref.nativeElement.style.transform = ''; }
}
