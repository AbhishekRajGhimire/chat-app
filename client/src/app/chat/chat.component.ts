import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild,
  effect,
} from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { AuthService } from '../auth.service';
import { ProfileService } from '../profile.service';
import { Router } from '@angular/router';
import { ChatStore } from '../core/chat-store.service';
import { ChatApi } from '../core/chat-api.service';
import { ConversationEntry, DirectoryUser, toEntry } from '../core/models/conversation.model';
import { Message } from '../core/models/message.model';
import { GroupCreateDialogComponent } from './group-create-dialog/group-create-dialog.component';

// Mirrors the avatar palette so a sender's name color matches their avatar.
const SENDER_COLORS = [
  '#6a2c6c', '#7a4a1f', '#7a3450', '#355c34',
  '#43436f', '#84432a', '#5a3a6d', '#1f5f52',
];

/**
 * Thin VIEW over `ChatStore`. All chat state + data + business logic lives in
 * the store; this component owns only view concerns: toolbar label, viewport /
 * placeholder handling, scrolling, the document title, the service-worker
 * notification hook, dialogs, and the per-thread draft/overlay UI state
 * (reply / edit / action menus) that Phase 3 will extract.
 */
@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
  standalone: false,
})
export class ChatComponent implements OnInit, OnDestroy {
  @ViewChild('messageScrollHost')
  private messageScrollHost?: ElementRef<HTMLElement>;

  /** Convenience: my username (echoes the store; used in the template). */
  readonly currentUser: string;
  toolbarLabel = '';

  // --- New Chat directory + search (view state) ----------------------------
  directoryUsers: DirectoryUser[] = [];
  directoryLoaded = false;
  filteredUsers: DirectoryUser[] = [];
  searchInput = '';

  // --- composer (view state) -----------------------------------------------
  newMessage = '';
  readonly skeletonRows = [0, 1, 2, 3];

  /** Message being replied to (drives the composer chip + reply_to on send). */
  replyingTo: Message | null = null;
  /** Message id whose action overlay / menu / picker is open (mobile + click). */
  activeMsgId: string | null = null;
  menuOpenId: string | null = null;
  pickerOpenId: string | null = null;
  /** Message currently being edited inline ('' = none) + its draft text. */
  editingId: string | null = null;
  editText = '';
  /** Briefly-flashed message after a scroll-to-original. */
  highlightedId: string | null = null;

  readonly quickReactions = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly emojiPicker = [
    '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '👏', '🙌',
    '😍', '🤔', '😅', '😎', '😭', '😡', '👀', '💯', '✅', '❌',
    '🤝', '💪', '🙇', '☕', '🚀', '⭐', '💡', '📌', '👋', '🤷',
  ];

  /** Whether the group member panel is open. */
  membersOpen = false;
  groupMembers: DirectoryUser[] = [];

  private static readonly BASE_TITLE = 'Rojin : the org chat';

  composerPlaceholder = 'Type a message (Enter to send, Shift+Enter for new line)';
  searchPlaceholder = 'Search registered users (online or offline)';
  compactToolbar = false;

  private mediaQuery?: MediaQueryList;
  private readonly mqHandler = () =>
    this.zone.run(() => this.applyViewportPlaceholders());

  /** Notification-click → open that conversation (posted by the service worker). */
  private readonly swMessageHandler = (e: MessageEvent) => {
    const d: any = e.data;
    if (d?.type === 'open-conversation' && d.data?.conversationKey) {
      this.zone.run(() => {
        const entry = this.store
          .conversations()
          .find((c) => c.key === d.data.conversationKey);
        if (entry) this.selectConversation(entry);
      });
    }
  };

  constructor(
    public store: ChatStore,
    private chatApi: ChatApi,
    private authService: AuthService,
    private profileService: ProfileService,
    private router: Router,
    private zone: NgZone,
    private dialog: MatDialog
  ) {
    this.currentUser = this.store.currentUser;
    this.toolbarLabel = this.currentUser;
    this.profileService.getMyProfile().subscribe({
      next: (p) => {
        this.toolbarLabel = p.display_name || this.currentUser;
      },
      error: () => {
        /* keep username */
      },
    });

    this.store.init();

    this.chatApi.directoryUsers().subscribe({
      next: (data) => {
        this.directoryUsers = data ?? [];
        this.directoryLoaded = true;
        this.applyNewChatFilter();
      },
      error: (error) => {
        this.directoryLoaded = true;
        this.redirectIfUnauth(error);
      },
    });

    // Keep the thread scrolled to the bottom whenever the open thread changes
    // (new messages) or we switch conversations. Effects run in injection ctx.
    effect(() => {
      this.store.openThread();
      this.store.selectedKey();
      queueMicrotask(() => this.scrollThreadToBottom());
    });

    // Tab title reflects the unread total from the store.
    effect(() => {
      const t = this.store.unreadTotal();
      document.title = t > 0 ? `(${t}) Rojin` : ChatComponent.BASE_TITLE;
    });

    this.applyViewportPlaceholders();
  }

  // --- setup / teardown ----------------------------------------------------
  private redirectIfUnauth(error: any): void {
    if (error?.status === 401 || error?.status === 422) {
      this.router.navigate(['/signin']);
    }
  }

  ngOnInit(): void {
    if (typeof window === 'undefined') return;
    this.mediaQuery = window.matchMedia('(max-width: 768px)');
    if (this.mediaQuery.addEventListener) {
      this.mediaQuery.addEventListener('change', this.mqHandler);
    } else {
      this.mediaQuery.addListener(this.mqHandler as any);
    }
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', this.swMessageHandler);
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
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.removeEventListener('message', this.swMessageHandler);
    }
    document.title = ChatComponent.BASE_TITLE;
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

  // --- selected conversation accessors (derive from the store) -------------
  get selectedEntry(): ConversationEntry | null {
    return this.store.selectedEntry();
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
    return this.store.isOnline(username);
  }

  monogram(title: string): string {
    const parts = (title || '?').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

  get isPeerTyping(): boolean {
    return !!this.store.typingFrom();
  }

  notifyTyping(): void {
    const e = this.store.selectedEntry();
    if (e) this.store.notifyTyping(e);
  }

  private scrollThreadToBottom(): void {
    setTimeout(() => {
      const el = this.messageScrollHost?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    this.sendMessage();
  }

  // --- selecting / navigating ---------------------------------------------
  selectConversation(entry: ConversationEntry): void {
    this.store.openConversation(entry);
    this.searchInput = '';
    this.membersOpen = false;
    this.applyNewChatFilter();
  }

  /** Open (or create locally) a DM from the New Chat search. */
  selectDirect(username: string): void {
    const e = this.store.ensureDirectEntry(username);
    this.selectConversation(e);
  }

  showSearch(): void {
    this.store.clearSelection();
    this.membersOpen = false;
    this.applyNewChatFilter();
  }

  backToInbox(): void {
    this.showSearch();
  }

  markRead(entry: ConversationEntry): void {
    this.store.markRead(entry);
  }

  /**
   * Readers (excluding me and the sender) whose last_read covers this message
   * AND for whom this is their latest-read message — so each reader's avatar
   * shows exactly once, under the last message they've seen.
   */
  readersOf(thread: Message[], index: number): string[] {
    const rs = this.store.readState()[this.store.selectedKey()];
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

  // --- creating a group ----------------------------------------------------
  openNewGroup(): void {
    const ref = this.dialog.open(GroupCreateDialogComponent, {
      data: { users: this.directoryUsers },
      width: '420px',
      panelClass: 'rojin-dialog',
    });
    ref.afterClosed().subscribe((result) => {
      if (!result?.title || !result?.members?.length) return;
      this.store.createGroup(result.title, result.members).subscribe({
        next: (group) => {
          const entry = toEntry({
            kind: 'group',
            conversation_id: group.conversation_id,
            title: group.title,
            member_count: group.member_count,
          });
          this.selectConversation(entry);
        },
        error: (error) => this.redirectIfUnauth(error),
      });
    });
  }

  // --- member management ---------------------------------------------------
  toggleMembers(): void {
    this.membersOpen = !this.membersOpen;
    if (this.membersOpen) this.refreshMembers();
  }

  private refreshMembers(): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.chatApi.getGroup(e.conversationId as number).subscribe({
      next: (g) => (this.groupMembers = g.members ?? []),
      error: (error) => this.redirectIfUnauth(error),
    });
  }

  addGroupMember(username: string): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.chatApi.addMembers(e.conversationId as number, [username]).subscribe({
      next: (g) => {
        this.groupMembers = g.members ?? [];
        e.memberCount = g.member_count;
      },
      error: (error) => this.redirectIfUnauth(error),
    });
  }

  removeGroupMember(username: string): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.chatApi.removeMember(e.conversationId as number, username).subscribe({
      next: (g) => {
        this.groupMembers = g.members ?? [];
        e.memberCount = g.member_count;
      },
      error: (error) => this.redirectIfUnauth(error),
    });
  }

  /** Members not already in the open group (candidates to add). */
  get addableUsers(): DirectoryUser[] {
    const have = new Set(this.groupMembers.map((m) => m.username));
    return this.directoryUsers.filter((u) => !have.has(u.username));
  }

  leaveGroup(): void {
    const e = this.selectedEntry;
    if (!e || e.kind !== 'group') return;
    this.chatApi.leaveGroup(e.conversationId as number).subscribe({
      next: () => {
        // The server emits `conversation_removed`, which the store handles
        // (drops the entry + clears selection). We only tidy local view state.
        this.membersOpen = false;
      },
      error: (error) => this.redirectIfUnauth(error),
    });
  }

  // --- sending -------------------------------------------------------------
  sendMessage(): void {
    const e = this.store.selectedEntry();
    if (!e || !this.newMessage.trim()) return;
    this.store.sendMessage(e, this.newMessage, this.replyingTo);
    this.newMessage = '';
    this.replyingTo = null;
  }

  retryMessage(msg: Message): void {
    const e = this.store.selectedEntry();
    if (e) this.store.retry(e, msg);
  }

  // --- message actions: shared --------------------------------------------
  isOwn(msg: Message): boolean {
    return msg.from === this.currentUser;
  }

  // --- action overlay open/close ------------------------------------------
  toggleActions(msg: Message): void {
    this.activeMsgId = this.activeMsgId === msg.id ? null : msg.id ?? null;
    this.menuOpenId = null;
    this.pickerOpenId = null;
  }

  toggleMenu(msg: Message, event: Event): void {
    event.stopPropagation();
    this.menuOpenId = this.menuOpenId === msg.id ? null : msg.id ?? null;
    this.pickerOpenId = null;
  }

  togglePicker(msg: Message, event: Event): void {
    event.stopPropagation();
    this.pickerOpenId = this.pickerOpenId === msg.id ? null : msg.id ?? null;
  }

  closeOverlays(): void {
    this.activeMsgId = null;
    this.menuOpenId = null;
    this.pickerOpenId = null;
  }

  // --- message actions: reactions -----------------------------------------
  toggleReaction(msg: Message, emoji: string): void {
    this.store.toggleReaction(msg, emoji);
    this.closeOverlays();
  }

  // --- message actions: reply ---------------------------------------------
  startReply(msg: Message): void {
    this.replyingTo = msg;
    this.closeOverlays();
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.message-input__field');
      el?.focus();
    });
  }

  cancelReply(): void {
    this.replyingTo = null;
  }

  /** Display name to show in the composer "Replying to …" chip. */
  replyName(msg: Message): string {
    if (msg.from === this.currentUser) return 'yourself';
    const entry = this.store
      .conversations()
      .find((c) => c.kind === 'direct' && c.username === msg.from);
    return entry?.displayName ?? msg.from;
  }

  scrollToMessage(id: string | null | undefined): void {
    if (!id) return;
    const el = document.getElementById('msg-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlightedId = id;
    setTimeout(() => this.zone.run(() => (this.highlightedId = null)), 1200);
  }

  // --- message actions: edit + delete -------------------------------------
  startEdit(msg: Message): void {
    if (!this.isOwn(msg) || !msg.id) return;
    this.editingId = msg.id;
    this.editText = msg.message;
    this.closeOverlays();
  }

  cancelEdit(): void {
    this.editingId = null;
    this.editText = '';
  }

  saveEdit(msg: Message): void {
    this.store.editMessage(msg, this.editText);
    this.cancelEdit();
  }

  deleteMessage(msg: Message): void {
    this.closeOverlays();
    this.store.deleteMessage(msg);
  }
}
