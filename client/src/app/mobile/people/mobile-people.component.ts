import { Component, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { ChatStore } from '../../core/chat-store.service';
import { ChatApi } from '../../core/chat-api.service';
import { DirectoryUser } from '../../core/models/conversation.model';

@Component({
  selector: 'app-mobile-people',
  templateUrl: './mobile-people.component.html',
  styleUrls: ['./mobile-people.component.scss'],
  standalone: false,
})
export class MobilePeopleComponent implements OnInit {
  all: DirectoryUser[] = [];
  filtered: DirectoryUser[] = [];
  search = '';
  loaded = false;

  constructor(public store: ChatStore, private chatApi: ChatApi, private router: Router) {}

  ngOnInit(): void {
    this.chatApi.directoryUsers().subscribe({
      next: (u) => { this.all = u || []; this.apply(); this.loaded = true; },
      error: () => { this.loaded = true; },
    });
  }

  apply(): void {
    const q = this.search.trim().toLowerCase();
    this.filtered = q
      ? this.all.filter(u => u.username.toLowerCase().includes(q) || u.display_name.toLowerCase().includes(q))
      : [...this.all];
  }

  openDm(u: DirectoryUser): void {
    const e = this.store.ensureDirectEntry(u.username);
    e.displayName = u.display_name || u.username;
    this.router.navigate(['/m/c', u.username]);
  }
}
