import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { MatDialog } from '@angular/material/dialog';
import { AuthService } from '../auth.service';
import { DirectoryUser, ProfileService } from '../profile.service';
import { Router } from '@angular/router';
import { io } from 'socket.io-client';
import { finalize } from 'rxjs/operators';
import {
  ConversationEntry,
  RawConversation,
  toEntry,
} from './conversation';
import { GroupCreateDialogComponent } from './group-create-dialog/group-create-dialog.component';

interface Message {
  from: string;
  to: string;
  message: string;
  datetime: any;
  status?: 'sending' | 'sent' | 'failed';
}

// Mirrors the avatar palette so a sender's name color matches their avatar.
const SENDER_COLORS = [
  '#6a2c6c', '#7a4a1f', '#7a3450', '#355c34',
  '#43436f', '#84432a', '#5a3a6d', '#1f5f52',
];

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
  standalone: false,
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('messageScrollHost')
  private messageScrollHost?: ElementRef<HTMLElement>;

  currentUser: any;
  toolbarLabel = '';
  /** Sidebar: DMs + groups, keyed by `entry.key`. */
  conversations: ConversationEntry[] = [];
  /** Threads keyed by conversation key (username for DM, `conv:<id>` for group). */
  chatHistory: { [key: string]: Message[] } = {};
  directoryUsers: DirectoryUser[] = [];
  directoryLoaded = false;
  onlineUsers: any[] = [];
  filteredUsers: DirectoryUser[] = [];
  socket: any;
  /** Open conversation key ('' = none). */
  selectedKey = '';
  searchInput = '';
  newMessage = '';
  isSendingMessage = false;
  readonly skeletonRows = [0, 1, 2, 3];

  /** Sender currently typing in the open conversation (null = nobody). */
  typingFrom: string | null = null;
  private typingClearTimer: any = null;
  private lastTypingEmit = 0;

  /** Whether the group member panel is open. */
  membersOpen = false;

  /** conversationKey -> { username -> lastReadAtISO|null } for "seen" rendering. */
  readState: { [key: string]: { [username: string]: string | null } } = {};

  private static readonly BASE_TITLE = 'Rojin : the org chat';

  composerPlaceholder = 'Type a message (Enter to send, Shift+Enter for new line)';
  searchPlaceholder = 'Search registered users (online or offline)';
  compactToolbar = false;

  private mediaQuery?: MediaQueryList;
  private readonly mqHandler = () =>
    this.zone.run(() => this.applyViewportPlaceholders());

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private profileService: ProfileService,
    private router: Router,
    private zone: NgZone,
    private dialog: MatDialog
  ) {
    this.currentUser = localStorage.getItem('username') || '';
    this.toolbarLabel = this.currentUser;
    this.profileService.getMyProfile().subscribe({
      next: (p) => {
        this.toolbarLabel = p.display_name || this.currentUser;
      },
      error: () => {
        /* keep username */
      },
    });

    this.loadConversations();

    this.http
      .get<DirectoryUser[]>('/api/directory_users', { headers: this.authHeaders() })
      .subscribe(
        (data) => {
          this.directoryUsers = data ?? [];
          this.directoryLoaded = true;
          this.applyNewChatFilter();
        },
        (error) => {
          this.directoryLoaded = true;
          this.redirectIfUnauth(error);
        }
      );

    const accessToken = localStorage.getItem('access_token') || '';
    this.socket = io({ query: { token: accessToken } });
    this.socket.on('connect', () => this.zone.run(() => {}));
    this.socket.on('online_users', (users: any) => {
      this.zone.run(() => {
        this.onlineUsers = Array.isArray(users) ? users : [];
        this.applyNewChatFilter();
      });
    });
    this.socket.on('receive_message', (data: any) => this.zone.run(() => this.onReceive(data)));
    this.socket.on('peer_typing', (data: any) => this.zone.run(() => this.onPeerTyping(data)));
    this.socket.on('conversation_added', () => this.zone.run(() => this.loadConversations()));
    this.socket.on('conversation_removed', (data: any) =>
      this.zone.run(() => this.onConversationRemoved(data))
    );
    this.socket.on('conversation_read', (data: any) =>
      this.zone.run(() => this.onConversationRead(data))
    );

    this.socket.connect();
    this.applyViewportPlaceholders();
  }

  // --- setup / teardown ----------------------------------------------------
  private authHeaders(): HttpHeaders {
    return new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
  }

  private redirectIfUnauth(error: any): void {
    if (error?.status === 401 || error?.status === 422) {
      this.router.navigate(['/signin']);
    }
  }

  /** (Re)load the sidebar, preserving live unread counts by key. */
  private loadConversations(): void {
    this.http
      .get<RawConversation[]>('/api/chats_history', { headers: this.authHeaders() })
      .subscribe(
        (data) => {
          // Server-backed unread is authoritative (persists across reload).
          this.conversations = (data ?? []).map((raw) => toEntry(raw));
          this.refreshTabTitle();
        },
        (error) => this.redirectIfUnauth(error)
      );
  }

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    this.mediaQuery = window.matchMedia('(max-width: 768px)');
    if (this.mediaQuery.addEventListener) {
      this.mediaQuery.addEventListener('change', this.mqHandler);
    } else {
      this.mediaQuery.addListener(this.mqHandler as any);
    }
  }

  private applyViewportPlaceholders(): void {
    if (typeof window === 'undefined') return;
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
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    document.title = ChatComponent.BASE_TITLE;
    if (this.socket) this.socket.disconnect();
  }

  logout() {
    this.authService.signout().subscribe(
      () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        this.router.navigate(['/signin']);
      },
      () => this.router.navigate(['/signin'])
    );
  }

  // --- New Chat search -----------------------------------------------------
  filterUsers(): void {
    this.applyNewChatFilter();
  }

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

  // --- selected conversation accessors ------------------------------------
  get selectedEntry(): ConversationEntry | null {
    return this.conversations.find((c) => c.key === this.selectedKey) || null;
  }

  /** DM peer username for the open conversation ('' for groups / none). */
  get selectedUser(): string {
    const e = this.selectedEntry;
    return e && e.kind === 'direct' ? e.username || '' : '';
  }

  get isGroupOpen(): boolean {
    return this.selectedEntry?.kind === 'group';
  }

  get headerTitle(): string {
    return this.selectedEntry?.displayName ?? '';
  }

  get openThread(): Message[] {
    return this.chatHistory[this.selectedKey] || [];
  }

  // --- date / grouping helpers --------------------------------------------
  private toDate(dt: any): Date | null {
    if (!dt) return null;
    const d = new Date(dt);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  formatMessageTime(dt: any): string {
    const d = this.toDate(dt);
    if (!d) return String(dt ?? '');
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  daySeparatorLabel(dt: any): string {
    const d = this.toDate(dt);
    if (!d) return '';
    const startOfDay = (x: Date) =>
      new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  }

  shouldShowDaySeparator(thread: Message[], index: number): boolean {
    if (index <= 0) return true;
    const cur = this.toDate(thread[index]?.datetime);
    const prev = this.toDate(thread[index - 1]?.datetime);
    if (!cur || !prev) return false;
    return cur.toDateString() !== prev.toDateString();
  }

  private gapMs(a: any, b: any): number {
    const da = this.toDate(a);
    const db = this.toDate(b);
    if (!da || !db) return Infinity;
    return Math.abs(da.getTime() - db.getTime());
  }

  private static readonly GROUP_WINDOW_MS = 5 * 60 * 1000;

  isContinuation(thread: Message[], index: number): boolean {
    if (index <= 0) return false;
    const cur = thread[index];
    const prev = thread[index - 1];
    if (!cur || !prev || cur.from !== prev.from) return false;
    if (this.shouldShowDaySeparator(thread, index)) return false;
    return this.gapMs(cur.datetime, prev.datetime) <= ChatComponent.GROUP_WINDOW_MS;
  }

  isGroupEnd(thread: Message[], index: number): boolean {
    if (index >= thread.length - 1) return true;
    return !this.isContinuation(thread, index + 1);
  }

  /** Show the sender name+avatar header above a received run in a group. */
  showSenderHeader(thread: Message[], index: number): boolean {
    if (!this.isGroupOpen) return false;
    const m = thread[index];
    if (!m || m.from === this.currentUser) return false;
    return !this.isContinuation(thread, index);
  }

  senderColor(name: string): string {
    const key = (name || '').toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
    return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
  }

  isUserOnline(username: string): boolean {
    return this.onlineUsers.some((u: any[]) => u[0] === username && u[1]);
  }

  monogram(title: string): string {
    const parts = (title || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  get sortedConversations(): ConversationEntry[] {
    const ts = (e: ConversationEntry) =>
      e.kind === 'direct' && e.username === this.currentUser
        ? -Infinity
        : e.last_message_at
        ? new Date(e.last_message_at).getTime()
        : 0;
    return [...this.conversations].sort((a, b) => ts(b) - ts(a));
  }

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

  private refreshTabTitle(): void {
    const total = this.conversations.reduce((n, e) => n + (e.unreadCount || 0), 0);
    document.title = total > 0 ? `(${total}) Rojin` : ChatComponent.BASE_TITLE;
  }

  get isPeerTyping(): boolean {
    return !!this.typingFrom;
  }

  notifyTyping(): void {
    const e = this.selectedEntry;
    if (!e) return;
    const now = Date.now();
    if (now - this.lastTypingEmit < 2000) return;
    this.lastTypingEmit = now;
    if (e.kind === 'group') {
      this.socket.emit('typing', { conversation_id: e.conversationId });
    } else {
      this.socket.emit('typing', { recipient: e.username });
    }
  }

  private scrollThreadToBottom(): void {
    setTimeout(() => {
      const el = this.messageScrollHost?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (this.isSendingMessage) return;
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    this.sendMessage();
  }

  // --- incoming socket events ---------------------------------------------
  private onReceive(data: any): void {
    if (!data?.username || data.message === undefined || data.message === null) return;
    const from = String(data.username);
    const isGroup = data.kind === 'group' && data.conversation_id != null;
    const key = isGroup ? `conv:${data.conversation_id}` : from;

    const msg: Message = {
      from,
      to: this.currentUser,
      message: String(data.message),
      datetime: data.datetime ?? new Date().toISOString(),
    };
    const prev = this.chatHistory[key] ?? [];
    this.chatHistory = { ...this.chatHistory, [key]: [...prev, msg] };

    if (from === this.typingFrom) this.typingFrom = null;

    let entry = this.conversations.find((e) => e.key === key);
    if (!entry) {
      if (isGroup) {
        // We belong to a group we don't have locally yet — refetch the list.
        this.loadConversations();
      } else {
        const dir = this.directoryUsers.find((e) => e.username === from);
        entry = {
          kind: 'direct',
          key: from,
          username: from,
          displayName: dir?.display_name ?? from,
          unreadCount: 0,
        };
        this.conversations = [...this.conversations, entry];
      }
    }
    if (entry) {
      entry.last_message = msg.message;
      entry.last_message_at = msg.datetime;
      if (key === this.selectedKey && !document.hidden) {
        this.scrollThreadToBottom();
        this.markRead(entry);
      } else {
        entry.unreadCount = (entry.unreadCount || 0) + 1;
      }
    }
    this.refreshTabTitle();
  }

  private onPeerTyping(data: any): void {
    const from = data?.from ? String(data.from) : '';
    if (!from || from === this.currentUser) return;
    const cid = data?.conversation_id;
    const matches =
      cid != null ? `conv:${cid}` === this.selectedKey : from === this.selectedKey;
    if (!matches) return;
    this.typingFrom = from;
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    this.typingClearTimer = setTimeout(
      () => this.zone.run(() => (this.typingFrom = null)),
      3000
    );
  }

  private onConversationRemoved(data: any): void {
    const cid = data?.conversation_id;
    if (cid == null) return;
    const key = `conv:${cid}`;
    this.conversations = this.conversations.filter((e) => e.key !== key);
    if (this.selectedKey === key) this.selectedKey = '';
    const { [key]: _drop, ...rest } = this.chatHistory;
    this.chatHistory = rest;
    this.refreshTabTitle();
  }

  // --- selecting / navigating ---------------------------------------------
  selectConversation(entry: ConversationEntry): void {
    this.selectedKey = entry.key;
    this.searchInput = '';
    this.typingFrom = null;
    this.membersOpen = false;
    entry.unreadCount = 0;
    this.refreshTabTitle();
    this.applyNewChatFilter();

    const url =
      entry.kind === 'group'
        ? `/api/groups/${entry.conversationId}/messages`
        : `/api/dm/messages/${encodeURIComponent(entry.username || '')}`;
    this.http.get<any>(url, { headers: this.authHeaders() }).subscribe(
      (data) => {
        const messages = data?.messages ?? [];
        this.chatHistory = { ...this.chatHistory, [entry.key]: messages };
        this.applyReadState(entry.key, data?.read_state ?? []);
        this.scrollThreadToBottom();
        this.markRead(entry);
      },
      (error) => this.redirectIfUnauth(error)
    );
  }

  /** Replace the read-state map for a conversation from a read_state payload. */
  private applyReadState(
    key: string,
    rows: { username: string; last_read_at: string | null }[]
  ): void {
    const m: { [u: string]: string | null } = {};
    for (const r of rows) m[r.username] = r.last_read_at;
    this.readState = { ...this.readState, [key]: m };
  }

  /** Tell the server we've read the open conversation (when the tab is visible). */
  markRead(entry: ConversationEntry): void {
    if (document.hidden) return;
    const url =
      entry.kind === 'group'
        ? `/api/groups/${entry.conversationId}/read`
        : `/api/dm/${encodeURIComponent(entry.username || '')}/read`;
    this.http.post(url, {}, { headers: this.authHeaders() }).subscribe({ error: () => {} });
  }

  /** Merge a live conversation_read event into the read-state map. */
  private onConversationRead(data: any): void {
    const cid = data?.conversation_id;
    const username = data?.username;
    const lastRead = data?.last_read_at;
    if (!username || lastRead === undefined) return;
    const groupKey = cid != null ? `conv:${cid}` : null;
    // Update whichever key holds this member (group conv key or a DM keyed by username).
    for (const key of Object.keys(this.readState)) {
      if ((groupKey && key === groupKey) || username in this.readState[key]) {
        this.readState = {
          ...this.readState,
          [key]: { ...this.readState[key], [username]: lastRead },
        };
      }
    }
  }

  /**
   * Readers (excluding me and the sender) whose last_read covers this message
   * AND for whom this is their latest-read message — so each reader's avatar
   * shows exactly once, under the last message they've seen.
   */
  readersOf(thread: Message[], index: number): string[] {
    const rs = this.readState[this.selectedKey];
    const msg = thread[index];
    if (!rs || !msg) return [];
    const msgTime = new Date(msg.datetime).getTime();
    const next = thread[index + 1];
    const nextTime = next ? new Date(next.datetime).getTime() : Infinity;
    const out: string[] = [];
    for (const [username, lastRead] of Object.entries(rs)) {
      if (username === this.currentUser || username === msg.from || !lastRead) continue;
      const read = new Date(lastRead).getTime();
      if (read >= msgTime && read < nextTime) out.push(username);
    }
    return out;
  }

  /** Open (or create locally) a DM from the New Chat search. */
  selectDirect(username: string): void {
    let entry = this.conversations.find(
      (e) => e.kind === 'direct' && e.username === username
    );
    if (!entry) {
      const dir = this.directoryUsers.find((e) => e.username === username);
      entry = {
        kind: 'direct',
        key: username,
        username,
        displayName: dir?.display_name ?? username,
        unreadCount: 0,
      };
      this.conversations = [...this.conversations, entry];
    }
    this.selectConversation(entry);
  }

  showSearch(): void {
    this.selectedKey = '';
    this.membersOpen = false;
    this.applyNewChatFilter();
  }

  backToInbox(): void {
    this.showSearch();
  }

  // --- creating a group ----------------------------------------------------
  openNewGroup(): void {
    const ref = this.dialog.open(GroupCreateDialogComponent, {
      data: { users: this.directoryUsers },
      width: '420px',
      panelClass: 'rojin-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (!result?.title || !result?.members?.length) return;
      this.http
        .post<any>(
          '/api/groups',
          { title: result.title, members: result.members },
          { headers: this.authHeaders() }
        )
        .subscribe(
          (group) => {
            const entry = toEntry({
              kind: 'group',
              conversation_id: group.conversation_id,
              title: group.title,
              member_count: group.member_count,
            });
            if (!this.conversations.some((e) => e.key === entry.key)) {
              this.conversations = [...this.conversations, entry];
            }
            this.selectConversation(entry);
          },
          (error) => this.redirectIfUnauth(error)
        );
    });
  }

  // --- member management ---------------------------------------------------
  toggleMembers(): void {
    this.membersOpen = !this.membersOpen;
    if (this.membersOpen) this.refreshMembers();
  }

  groupMembers: DirectoryUser[] = [];
  private refreshMembers(): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.http
      .get<any>(`/api/groups/${e.conversationId}`, { headers: this.authHeaders() })
      .subscribe(
        (g) => (this.groupMembers = g.members ?? []),
        (error) => this.redirectIfUnauth(error)
      );
  }

  addGroupMember(username: string): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.http
      .post<any>(
        `/api/groups/${e.conversationId}/members`,
        { members: [username] },
        { headers: this.authHeaders() }
      )
      .subscribe(
        (g) => {
          this.groupMembers = g.members ?? [];
          e.memberCount = g.member_count;
        },
        (error) => this.redirectIfUnauth(error)
      );
  }

  removeGroupMember(username: string): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.http
      .delete<any>(
        `/api/groups/${e.conversationId}/members/${encodeURIComponent(username)}`,
        { headers: this.authHeaders() }
      )
      .subscribe(
        (g) => {
          this.groupMembers = g.members ?? [];
          e.memberCount = g.member_count;
        },
        (error) => this.redirectIfUnauth(error)
      );
  }

  /** Members not already in the open group (candidates to add). */
  get addableUsers(): DirectoryUser[] {
    const have = new Set(this.groupMembers.map((m) => m.username));
    return this.directoryUsers.filter((u) => !have.has(u.username));
  }

  leaveGroup(): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.http
      .post<any>(`/api/groups/${e.conversationId}/leave`, {}, { headers: this.authHeaders() })
      .subscribe(
        () => {
          this.conversations = this.conversations.filter((c) => c.key !== e.key);
          this.selectedKey = '';
          this.membersOpen = false;
        },
        (error) => this.redirectIfUnauth(error)
      );
  }

  // --- sending -------------------------------------------------------------
  sendMessage(): void {
    const e = this.selectedEntry;
    if (this.isSendingMessage || !this.newMessage.trim() || !e) return;
    const text = this.newMessage;

    const msg: Message = {
      from: this.currentUser,
      to: e.key,
      message: text,
      datetime: new Date().toISOString(),
      status: 'sending',
    };
    const before = this.chatHistory[e.key] ?? [];
    this.chatHistory = { ...this.chatHistory, [e.key]: [...before, msg] };
    e.last_message = text;
    e.last_message_at = msg.datetime;
    this.scrollThreadToBottom();
    this.newMessage = '';

    this.postMessage(e, text, msg);
  }

  private postMessage(entry: ConversationEntry, text: string, msg: Message): void {
    this.isSendingMessage = true;
    let req;
    if (entry.kind === 'group') {
      this.socket.emit('send_message', {
        conversation_id: entry.conversationId,
        message: text,
      });
      req = this.http.post<any>(
        `/api/groups/${entry.conversationId}/messages`,
        { body: text },
        { headers: this.authHeaders() }
      );
    } else {
      this.socket.emit('send_message', { recipient: entry.username, message: text });
      req = this.http.post<any>(
        '/api/dm/messages',
        { to_username: entry.username, body: text },
        { headers: this.authHeaders() }
      );
    }
    req.pipe(finalize(() => (this.isSendingMessage = false))).subscribe({
      next: () => {
        msg.status = 'sent';
      },
      error: (err: any) => {
        msg.status = 'failed';
        this.redirectIfUnauth(err);
      },
    });
  }

  retryMessage(msg: Message): void {
    const e = this.selectedEntry;
    if (!e || msg.status === 'sending') return;
    msg.status = 'sending';
    this.postMessage(e, msg.message, msg);
  }
}
