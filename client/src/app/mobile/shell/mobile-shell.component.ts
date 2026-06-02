import { Component, OnInit } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { ChatStore } from '../../core/chat-store.service';

@Component({
  selector: 'app-mobile-shell',
  templateUrl: './mobile-shell.component.html',
  styleUrls: ['./mobile-shell.component.scss'],
  standalone: false,
})
export class MobileShellComponent implements OnInit {
  showTabBar = true;

  constructor(private router: Router, private store: ChatStore) {}

  ngOnInit(): void {
    this.store.init();
    this.update(this.router.url);
    this.router.events.pipe(filter(e => e instanceof NavigationEnd))
      .subscribe((e: any) => this.update(e.urlAfterRedirects || e.url));
  }

  private update(url: string): void {
    // Tab bar only on the three tab screens; hidden on thread + pushed profile.
    this.showTabBar = /\/m\/(chats|calls|people)(\?|$)/.test(url);
  }
}
