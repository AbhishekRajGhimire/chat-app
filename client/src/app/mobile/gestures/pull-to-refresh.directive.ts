import { Directive, ElementRef, EventEmitter, HostListener, Output } from '@angular/core';
@Directive({ selector: '[appPullToRefresh]', standalone: false })
export class PullToRefreshDirective {
  @Output() refresh = new EventEmitter<void>();
  private startY = 0; private pulling = false;
  constructor(private ref: ElementRef<HTMLElement>) {}
  @HostListener('touchstart', ['$event']) start(e: TouchEvent) {
    if (this.ref.nativeElement.scrollTop <= 0) { this.pulling = true; this.startY = e.touches[0]?.clientY ?? 0; }
  }
  @HostListener('touchmove', ['$event']) move(e: TouchEvent) {
    if (!this.pulling) return;
    const dy = (e.touches[0]?.clientY ?? 0) - this.startY;
    if (dy < 0) this.pulling = false;
  }
  @HostListener('touchend', ['$event']) end(e: TouchEvent) {
    if (!this.pulling) return; this.pulling = false;
    const dy = (e.changedTouches[0]?.clientY ?? 0) - this.startY;
    if (dy > 70) this.refresh.emit();
  }
}
