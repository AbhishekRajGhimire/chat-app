import { Component } from '@angular/core';
import { ChatStore } from '../../core/chat-store.service';
import { avatarSrc } from '../../core/avatar-url';

@Component({
  selector: 'app-mobile-calls',
  templateUrl: './mobile-calls.component.html',
  styleUrls: ['./mobile-calls.component.scss'],
  standalone: false,
})
export class MobileCallsComponent {
  readonly avatarSrc = avatarSrc;
  constructor(public store: ChatStore) {}
}
