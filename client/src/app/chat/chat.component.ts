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
  /** Briefly-flashed message after a scroll-to-original. */
  highlightedId: string | null = null;

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

  // --- date helpers (sidebar list timestamps) -----------------------------
  private toDate(dt: any): Date | null {
    if (!dt) return null;
    const d = new Date(dt);
    return Number.isNaN(d.getTime()) ? null : d;
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

  /** Retry handler bridged from `<app-message-thread>`. */
  onThreadRetry(msg: Message): void {
    const e = this.store.selectedEntry();
    if (e) this.store.retry(e, msg);
  }

  // --- reply composer chip (host-owned) -----------------------------------
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

  /**
   * Scroll to (and briefly flash) the original of a reply. The flash class is
   * toggled on the row element directly — the row lives inside
   * `<app-message-thread>`, so the host can't bind it via a template input.
   */
  scrollToMessage(id: string | null | undefined): void {
    if (!id) return;
    const el = document.getElementById('msg-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlightedId = id;
    el.classList.add('message-row--flash');
    setTimeout(
      () =>
        this.zone.run(() => {
          this.highlightedId = null;
          el.classList.remove('message-row--flash');
        }),
      1200
    );
  }
}
