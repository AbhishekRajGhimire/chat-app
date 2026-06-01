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
  status?: 'sending' | 'sent' | 'failed';
}

@Component({
    selector: 'app-chat',
    templateUrl: './chat.component.html',
    styleUrls: ['./chat.component.scss'],
    standalone: false
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
  /** Placeholder rows rendered while the directory is loading. */
  readonly skeletonRows = [0, 1, 2, 3];

  /** Username currently typing to us in the open conversation (null = nobody). */
  typingFrom: string | null = null;
  private typingClearTimer: any = null;
  private lastTypingEmit = 0;

  private static readonly BASE_TITLE = 'Rojin : the org chat';

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
        this.chatUsers = (data ?? []).map((e) => ({ ...e, unreadCount: 0 }));
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
        const msg: Message = {
          from,
          to: this.currentUser,
          message: String(data.message),
          // Keep the raw timestamp; formatting + day-grouping happen in the
          // template via formatMessageTime()/daySeparatorLabel().
          datetime: data.datetime ?? new Date().toISOString(),
        };
        const prev = this.chatHistory[from] ?? [];
        this.chatHistory = { ...this.chatHistory, [from]: [...prev, msg] };

        // A message from this peer means they've stopped "typing".
        if (from === this.typingFrom) {
          this.typingFrom = null;
        }

        // Find the sidebar entry, or create it live (new conversation).
        let entry = this.chatUsers.find((e) => e.username === from);
        if (!entry) {
          const dir = this.directoryUsers.find((e) => e.username === from);
          entry = {
            username: from,
            display_name: dir?.display_name ?? from,
            unreadCount: 0,
          };
          this.chatUsers = [...this.chatUsers, entry];
        }
        entry.last_message = msg.message;
        entry.last_message_at = msg.datetime;

        const isOpen = from === this.selectedUser && !document.hidden;
        if (isOpen) {
          this.scrollThreadToBottom();
        } else {
          entry.unreadCount = (entry.unreadCount || 0) + 1;
        }
        this.refreshTabTitle();
      });
    });

    this.socket.on('peer_typing', (data: any) => {
      this.zone.run(() => {
        const from = data?.from ? String(data.from) : '';
        if (!from || from !== this.selectedUser) {
          return;
        }
        this.typingFrom = from;
        if (this.typingClearTimer) {
          clearTimeout(this.typingClearTimer);
        }
        this.typingClearTimer = setTimeout(
          () => this.zone.run(() => (this.typingFrom = null)),
          3000
        );
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
    if (this.typingClearTimer) {
      clearTimeout(this.typingClearTimer);
    }
    document.title = ChatComponent.BASE_TITLE;
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

  private toDate(dt: any): Date | null {
    if (!dt) return null;
    const d = new Date(dt);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Short time for a message bubble, e.g. "9:42 AM". */
  formatMessageTime(dt: any): string {
    const d = this.toDate(dt);
    if (!d) return String(dt ?? '');
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  /** "Today" / "Yesterday" / "May 30, 2026" for a date divider. */
  daySeparatorLabel(dt: any): string {
    const d = this.toDate(dt);
    if (!d) return '';
    const startOfDay = (x: Date) =>
      new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round(
      (startOfDay(new Date()) - startOfDay(d)) / 86400000
    );
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  /** True when the message at `index` starts a new calendar day in the thread. */
  shouldShowDaySeparator(thread: Message[], index: number): boolean {
    if (index <= 0) return true;
    const cur = this.toDate(thread[index]?.datetime);
    const prev = this.toDate(thread[index - 1]?.datetime);
    if (!cur || !prev) return false;
    return cur.toDateString() !== prev.toDateString();
  }

  /** How far apart two timestamps are, in ms (Infinity if either is unparseable). */
  private gapMs(a: any, b: any): number {
    const da = this.toDate(a);
    const db = this.toDate(b);
    if (!da || !db) return Infinity;
    return Math.abs(da.getTime() - db.getTime());
  }

  /** Window within which same-sender messages collapse into one group. */
  private static readonly GROUP_WINDOW_MS = 5 * 60 * 1000;

  /** True when this message continues the previous one's group (same sender, same day, within the window). */
  isContinuation(thread: Message[], index: number): boolean {
    if (index <= 0) return false;
    const cur = thread[index];
    const prev = thread[index - 1];
    if (!cur || !prev || cur.from !== prev.from) return false;
    if (this.shouldShowDaySeparator(thread, index)) return false;
    return this.gapMs(cur.datetime, prev.datetime) <= ChatComponent.GROUP_WINDOW_MS;
  }

  /** True when this message is the last of its group — only then do we show the timestamp. */
  isGroupEnd(thread: Message[], index: number): boolean {
    if (index >= thread.length - 1) return true;
    return !this.isContinuation(thread, index + 1);
  }

  isUserOnline(username: string): boolean {
    return this.onlineUsers.some((u: any[]) => u[0] === username && u[1]);
  }

  /** Conversation list, most-recent-first. Null timestamps and self sort last. */
  get sortedChatUsers(): DirectoryUser[] {
    const ts = (e: DirectoryUser) =>
      e.username === this.currentUser
        ? -Infinity
        : e.last_message_at
        ? new Date(e.last_message_at).getTime()
        : 0;
    return [...this.chatUsers].sort((a, b) => ts(b) - ts(a));
  }

  /** Compact time for a DM row: "9:43", "Tue", or "May 30". */
  listTime(iso: any): string {
    const d = this.toDate(iso);
    if (!d) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    const diffDays = Math.round((now.getTime() - d.getTime()) / 86400000);
    if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  /** Sum of unread counts → browser tab title badge. */
  private refreshTabTitle(): void {
    const total = this.chatUsers.reduce((n, e) => n + (e.unreadCount || 0), 0);
    document.title = total > 0 ? `(${total}) Rojin` : ChatComponent.BASE_TITLE;
  }

  /** True when the open peer is currently typing to us. */
  get isPeerTyping(): boolean {
    return !!this.typingFrom && this.typingFrom === this.selectedUser;
  }

  /** Tell the open peer we're typing — throttled to at most once per 2s. */
  notifyTyping(): void {
    if (!this.selectedUser) return;
    const now = Date.now();
    if (now - this.lastTypingEmit < 2000) return;
    this.lastTypingEmit = now;
    this.socket.emit('typing', { recipient: this.selectedUser });
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
    this.typingFrom = null;
    const opened = this.chatUsers.find((e) => e.username === username);
    if (opened) {
      opened.unreadCount = 0;
    }
    this.refreshTabTitle();
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

    const msg: Message = {
      from: this.currentUser,
      to: peer,
      message: text,
      datetime: new Date().toISOString(),
      status: 'sending',
    };
    const threadBefore = this.chatHistory[peer] ?? [];
    this.chatHistory = {
      ...this.chatHistory,
      [peer]: [...threadBefore, msg],
    };
    // Reflect the new message in the sidebar (preview + recency reorder).
    const entry = this.chatUsers.find((e) => e.username === peer);
    if (entry) {
      entry.last_message = text;
      entry.last_message_at = msg.datetime;
    }
    this.scrollThreadToBottom();
    this.newMessage = '';

    this.postMessage(peer, text, msg);
  }

  /** Emit + POST a message, flipping its status on the result. Shared by send and retry. */
  private postMessage(peer: string, text: string, msg: Message): void {
    this.socket.emit('send_message', { recipient: peer, message: text });

    this.isSendingMessage = true;
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
          msg.status = 'sent';
          if (!this.chatUsers.some((e) => e.username === peer)) {
            const fromDir = this.directoryUsers.find((e) => e.username === peer);
            const newEntry: DirectoryUser = fromDir ?? {
              username: peer,
              display_name: peer,
            };
            newEntry.last_message = text;
            newEntry.last_message_at = msg.datetime;
            newEntry.unreadCount = 0;
            this.chatUsers = [...this.chatUsers, newEntry];
          }
        },
        error: (err) => {
          // Never silently drop the message — leave it visible and retryable.
          msg.status = 'failed';
          if (err.status === 401 || err.status === 422) {
            this.router.navigate(['/signin']);
          }
        },
      });
  }

  /** Re-send a message that previously failed. */
  retryMessage(peer: string, msg: Message): void {
    if (!peer || msg.status === 'sending') {
      return;
    }
    msg.status = 'sending';
    this.postMessage(peer, msg.message, msg);
  }
}