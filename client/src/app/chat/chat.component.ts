import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from '../auth.service';
import { Router } from '@angular/router';
import { io } from 'socket.io-client';
import { finalize } from 'rxjs/operators';

interface Message {
  from: string;
  to: string;
  message: string;
  datetime: any;
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
})
export class ChatComponent implements OnDestroy {
  @ViewChild('messageScrollHost')
  private messageScrollHost?: ElementRef<HTMLElement>;

  currentUser: any;
  chatUsers: string[] = [];
  chatHistory: { [username: string]: Message[] } = {};
  /** Everyone registered except you — used for New Chat search. */
  directoryUsers: string[] = [];
  directoryLoaded = false;
  onlineUsers: any[] = [];
  filteredUsers: string[] = [];
  socket: any;
  selectedUser: string = ''; // to store the user selected for direct messages
  searchInput = '';
  newMessage = '';
  /** True while `post_messages` request is in flight (prevents double send). */
  isSendingMessage = false;

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private router: Router,
    private zone: NgZone
  ) {
    const token = localStorage.getItem('access_token');
    this.currentUser = localStorage.getItem('username') || '';
    const headers = new HttpHeaders().set('Authorization', 'Bearer ' + token);
    this.http.get<string[]>('/api/chats_history', { headers }).subscribe(
      (data: string[]) => {
        this.chatUsers = data ?? [];
      },
      (error) => {
        if (error.status === 401 || error.status === 422) {
          this.router.navigate(['/signin']);
        }
      }
    );

    this.http.get<string[]>('/api/directory_users', { headers }).subscribe(
      (data: string[]) => {
        this.directoryUsers = data ?? [];
        this.directoryLoaded = true;
        this.applyNewChatFilter();
      },
      (error) => {
        this.directoryLoaded = true;
        if (error.status === 401 || error.status === 422) {
          this.router.navigate(['/signin']);
        }
      }
    );

    // Local testing: connect to same-origin Socket.IO.
    // With `npm run start`, Angular proxies `/socket.io/*` to the backend at :3000.
    this.socket = io();
    this.socket.on('connect', () => {
      this.zone.run(() => {
        if (this.currentUser) {
          this.socket.emit('join_user', { username: this.currentUser });
        }
      });
    });
    this.socket.on('online_users', (users: any) => {
      this.zone.run(() => {
        this.onlineUsers = Array.isArray(users) ? users : [];
        this.applyNewChatFilter();
      });
    });

    this.socket.on('receive_message', (data: any) => {
      this.zone.run(() => {
        if (!data?.username || data.message === undefined || data.message === null) {
          return;
        }
        const from = String(data.username);
        const messageDate = new Date(data.datetime);
        const formattedDate = Number.isNaN(messageDate.getTime())
          ? String(data.datetime)
          : messageDate.toLocaleString();
        const msg: Message = {
          from,
          to: this.currentUser,
          message: String(data.message),
          datetime: formattedDate,
        };
        const prev = this.chatHistory[from] ?? [];
        this.chatHistory = { ...this.chatHistory, [from]: [...prev, msg] };
        if (from === this.selectedUser) {
          this.scrollThreadToBottom();
        }
      });
    });

    this.socket.connect();
  }

  ngOnDestroy(): void {
    if (this.socket) {
      this.socket.disconnect();
    }
  }

  logout() {
    this.authService.signout().subscribe(
      () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        this.router.navigate(['/signin']);
      },
      (error) => {
        this.router.navigate(['/signin']);
      }
    );
  }

  filterUsers(): void {
    this.applyNewChatFilter();
  }

  /** New Chat list: all registered users (except you), filtered by search text. */
  private applyNewChatFilter(): void {
    if (!this.directoryUsers.length) {
      this.filteredUsers = [];
      return;
    }
    const q = this.searchInput.trim().toLowerCase();
    this.filteredUsers = q
      ? this.directoryUsers.filter((name) =>
          name.toLowerCase().includes(q)
        )
      : [...this.directoryUsers];
  }

  isUserOnline(username: string): boolean {
    return this.onlineUsers.some((u: any[]) => u[0] === username && u[1]);
  }

  /** Scroll the open conversation panel to the latest message (after DOM update). */
  private scrollThreadToBottom(): void {
    setTimeout(() => {
      const el = this.messageScrollHost?.nativeElement;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (this.isSendingMessage) {
      return;
    }
    if (event.key !== 'Enter') {
      return;
    }
    if (event.shiftKey) {
      return;
    }
    event.preventDefault();
    this.sendMessage();
  }

  selectUser(username: any): void {
    this.selectedUser = username;
    this.searchInput = '';
    this.applyNewChatFilter();
    const headers = new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
    this.http
      .get<Message[]>(
        `/api/message_history/${username}/&/${this.currentUser}`,
        { headers }
      )
      .subscribe(
        (data) => {
          this.chatHistory = {
            ...this.chatHistory,
            [username]: data ?? [],
          };
          this.scrollThreadToBottom();
        },
        (error) => {
          if (error.status === 401 || error.status === 422) {
            this.router.navigate(['/signin']);
          }
        }
      );
  }

  showSearch() {
    this.selectedUser = '';
    this.applyNewChatFilter();
  }

  /** Mobile: leave conversation and return to inbox + search (master). */
  backToInbox(): void {
    this.showSearch();
  }

  sendMessage(): void {
    if (this.isSendingMessage || !this.newMessage.trim() || !this.selectedUser) {
      return;
    }
    const text = this.newMessage;
    const peer = this.selectedUser;

    this.socket.emit('send_message', {
      from: this.currentUser,
      recipient: peer,
      message: text,
    });

    const today = new Date();
    const formattedDatetime = today.toISOString();

    const msg: Message = {
      from: this.currentUser,
      to: peer,
      message: text,
      datetime: formattedDatetime,
    };
    const threadBefore = this.chatHistory[peer] ?? [];
    this.chatHistory = {
      ...this.chatHistory,
      [peer]: [...threadBefore, msg],
    };
    this.scrollThreadToBottom();

    this.isSendingMessage = true;
    this.newMessage = '';

    const headers = new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
    const url = `/api/post_messages/${encodeURIComponent(peer)}/&/${encodeURIComponent(this.currentUser)}/&/${encodeURIComponent(text)}`;
    this.http
      .post(url, {}, { headers })
      .pipe(finalize(() => (this.isSendingMessage = false)))
      .subscribe({
        next: () => {
          if (!this.chatUsers.includes(peer)) {
            this.chatUsers = [...this.chatUsers, peer];
          }
        },
        error: (err) => {
          const thread = this.chatHistory[peer];
          if (thread?.length && thread[thread.length - 1] === msg) {
            this.chatHistory = {
              ...this.chatHistory,
              [peer]: thread.slice(0, -1),
            };
          }
          if (err.status === 401 || err.status === 422) {
            this.router.navigate(['/signin']);
          }
        },
      });
  }
}