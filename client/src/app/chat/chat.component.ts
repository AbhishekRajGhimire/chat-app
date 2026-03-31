import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from '../auth.service';
import { DirectoryUser, ProfileService } from '../profile.service';
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
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('messageScrollHost')
  private messageScrollHost?: ElementRef<HTMLElement>;

  currentUser: any;
  /** Shown in toolbar; falls back to username. */
  toolbarLabel = '';
  chatUsers: DirectoryUser[] = [];
  chatHistory: { [username: string]: Message[] } = {};
  /** Everyone registered except you — used for New Chat search. */
  directoryUsers: DirectoryUser[] = [];
  directoryLoaded = false;
  onlineUsers: any[] = [];
  filteredUsers: DirectoryUser[] = [];
  socket: any;
  selectedUser: string = ''; // to store the user selected for direct messages
  searchInput = '';
  newMessage = '';
  /** True while DM POST is in flight (prevents double send). */
  isSendingMessage = false;

  /** Match `chat.component.scss` mobile breakpoint — short placeholders, no keyboard hints. */
  composerPlaceholder = 'Type a message (Enter to send, Shift+Enter for new line)';
  searchPlaceholder = 'Search registered users (online or offline)';

  /** Matches mobile breakpoint; hides brand tagline in toolbar when true. */
  compactToolbar = false;

  private mediaQuery?: MediaQueryList;
  private readonly mqHandler = () =>
    this.zone.run(() => this.applyViewportPlaceholders());

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private profileService: ProfileService,
    private router: Router,
    private zone: NgZone
  ) {
    const token = localStorage.getItem('access_token');
    this.currentUser = localStorage.getItem('username') || '';
    this.toolbarLabel = this.currentUser;
    const headers = new HttpHeaders().set('Authorization', 'Bearer ' + token);
    this.profileService.getMyProfile().subscribe({
      next: (p) => {
        this.toolbarLabel = p.display_name || this.currentUser;
      },
      error: () => {
        /* keep username */
      },
    });
    this.http.get<DirectoryUser[]>('/api/chats_history', { headers }).subscribe(
      (data: DirectoryUser[]) => {
        this.chatUsers = data ?? [];
      },
      (error) => {
        if (error.status === 401 || error.status === 422) {
          this.router.navigate(['/signin']);
        }
      }
    );

    this.http.get<DirectoryUser[]>('/api/directory_users', { headers }).subscribe(
      (data: DirectoryUser[]) => {
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

    // Socket.IO: JWT in query string (verified on connect); sender identity comes from the server.
    const accessToken = localStorage.getItem('access_token') || '';
    this.socket = io({
      query: { token: accessToken },
    });
    this.socket.on('connect', () => {
      this.zone.run(() => {
        /* presence registered in server connect handler */
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
    this.applyViewportPlaceholders();
  }

  ngOnInit(): void {
    if (typeof window === 'undefined') {
      return;
    }
    this.mediaQuery = window.matchMedia('(max-width: 768px)');
    if (this.mediaQuery.addEventListener) {
      this.mediaQuery.addEventListener('change', this.mqHandler);
    } else {
      this.mediaQuery.addListener(this.mqHandler as any);
    }
  }

  private applyViewportPlaceholders(): void {
    if (typeof window === 'undefined') {
      return;
    }
    const compact = window.matchMedia('(max-width: 768px)').matches;
    this.compactToolbar = compact;
    this.composerPlaceholder = compact
      ? 'Message'
      : 'Type a message (Enter to send, Shift+Enter for new line)';
    this.searchPlaceholder = compact
      ? 'Search people'
      : 'Search registered users (online or offline)';
  }

  ngOnDestroy(): void {
    if (this.mediaQuery) {
      if (this.mediaQuery.removeEventListener) {
        this.mediaQuery.removeEventListener('change', this.mqHandler);
      } else {
        this.mediaQuery.removeListener(this.mqHandler as any);
      }
    }
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
      ? this.directoryUsers.filter(
          (e) =>
            e.username.toLowerCase().includes(q) ||
            e.display_name.toLowerCase().includes(q)
        )
      : [...this.directoryUsers];
  }

  headerTitleFor(username: string): string {
    const e =
      this.chatUsers.find((u) => u.username === username) ||
      this.directoryUsers.find((u) => u.username === username);
    return e?.display_name ?? username;
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

  selectUser(username: string): void {
    this.selectedUser = username;
    this.searchInput = '';
    this.applyNewChatFilter();
    const headers = new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
    this.http
      .get<Message[]>(`/api/dm/messages/${encodeURIComponent(username)}`, {
        headers,
      })
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
    this.http
      .post<{ message: string }>(
        '/api/dm/messages',
        { to_username: peer, body: text },
        { headers }
      )
      .pipe(finalize(() => (this.isSendingMessage = false)))
      .subscribe({
        next: () => {
          if (!this.chatUsers.some((e) => e.username === peer)) {
            const fromDir = this.directoryUsers.find((e) => e.username === peer);
            const entry: DirectoryUser = fromDir ?? {
              username: peer,
              display_name: peer,
            };
            this.chatUsers = [...this.chatUsers, entry];
          }
        },
        error: (err) => {
          const thread = this.chatHistory[peer];
          const last = thread?.length ? thread[thread.length - 1] : null;
          if (
            last &&
            last.from === msg.from &&
            last.to === msg.to &&
            last.message === msg.message
          ) {
            this.chatHistory = {
              ...this.chatHistory,
              [peer]: thread!.slice(0, -1),
            };
          }
          if (err.status === 401 || err.status === 422) {
            this.router.navigate(['/signin']);
          }
        },
      });
  }
}