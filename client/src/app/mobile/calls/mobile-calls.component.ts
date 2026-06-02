import { Component } from '@angular/core';
import { ChatStore } from '../../core/chat-store.service';

@Component({
  selector: 'app-mobile-calls',
  templateUrl: './mobile-calls.component.html',
  styleUrls: ['./mobile-calls.component.scss'],
  standalone: false,
})
export class MobileCallsComponent {
  constructor(public store: ChatStore) {}
}
