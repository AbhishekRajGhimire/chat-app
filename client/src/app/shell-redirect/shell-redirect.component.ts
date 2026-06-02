import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';

@Component({ selector: 'app-shell-redirect', template: '', standalone: false })
export class ShellRedirectComponent implements OnInit, OnDestroy {
  private mq = window.matchMedia('(max-width: 768px)');
  private handler = () => this.go();
  constructor(private router: Router) {}
  ngOnInit() { this.go(); this.mq.addEventListener('change', this.handler); }
  ngOnDestroy() { this.mq.removeEventListener('change', this.handler); }
  private go() {
    this.router.navigate([this.mq.matches ? '/m/chats' : '/chat'], { replaceUrl: true });
  }
}
