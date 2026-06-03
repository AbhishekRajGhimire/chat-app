import { Injectable, NgZone, computed, signal } from '@angular/core';
import { HttpEventType } from '@angular/common/http';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { ChatApi } from './chat-api.service';
import { RealtimeClient } from './realtime-client.service';
import { Attachment, Message, PendingAttachment, Reaction } from './models/message.model';
import { ConversationEntry, toEntry } from './models/conversation.model';

/**
 * App-singleton holding ALL chat state (as signals) + business logic + the
 * socket lifecycle. Ported from the legacy `ChatComponent`. View concerns
 * (scrolling, document.title, reply/edit draft state, dialogs, navigation)
 * intentionally stay in components.
 */
@Injectable({ providedIn: 'root' })
export class ChatStore {
  // --- reactive state ------------------------------------------------------
  /** Sidebar: DMs + groups, keyed by `entry.key`. */
  readonly conversations = signal<ConversationEntry[]>([]);
  /** Threads keyed by conversation key (username for DM, `conv:<id>` for group). */
  readonly chatHistory = signal<Record<string, Message[]>>({});
  /** conversationKey -> { username -> lastReadAtISO|null } for "seen" rendering. */
  readonly readState = signal<Record<string, Record<string, string | null>>>({});
  readonly onlineUsers = signal<any[]>([]);
  /** Sender currently typing in the open conversation (null = nobody). */
  readonly typingFrom = signal<string | null>(null);
  /** Open conversation key ('' = none). */
  readonly selectedKey = signal<string>('');
  /** Attachment upload tray for the current compose box. */
  readonly pendingAttachments = signal<PendingAttachment[]>([]);
  readonly hasUploading = computed(() => this.pendingAttachments().some(p => p.status === 'uploading'));

  readonly currentUser: string = localStorage.getItem('username') || '';
  /** The current user's own avatar path (for self-avatars in toolbars/headers). */
  readonly myAvatarUrl = signal<string | null>(null);

  // --- derived state -------------------------------------------------------
  readonly sortedConversations = computed<ConversationEntry[]>(() => {
    const me = this.currentUser;
    const ts = (e: ConversationEntry) =>
      e.kind === 'direct' && e.username === me
        ? -Infinity
        : e.last_message_at
        ? new Date(e.last_message_at).getTime()
        : 0;
    return [...this.conversations()].sort((a, b) => ts(b) - ts(a));
  });

  readonly unreadTotal = computed<number>(() =>
    this.conversations().reduce((n, e) => n + (e.unreadCount || 0), 0)
  );

  readonly selectedEntry = computed<ConversationEntry | null>(
    () => this.conversations().find((c) => c.key === this.selectedKey()) || null
  );

  readonly openThread = computed<Message[]>(
    () => this.chatHistory()[this.selectedKey()] ?? []
  );

  // --- internal ------------------------------------------------------------
  private initialized = false;
  private typingClearTimer: any = null;
  private lastTypingEmit = 0;
  private isSendingMessage = false;

  constructor(
    private chatApi: ChatApi,
    private realtime: RealtimeClient,
    private zone: NgZone
  ) {}

  // --- lifecycle -----------------------------------------------------------
  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.realtime.connect(localStorage.getItem('access_token') || '');
    // socket.io callbacks fire OUTSIDE Angular's zone; wrap handlers in
    // zone.run so signal writes schedule change detection (Zone.js app).
    this.realtime.receiveMessage$.subscribe((d) => this.zone.run(() => this.onReceive(d)));
    this.realtime.onlineUsers$.subscribe((u) =>
      this.zone.run(() => this.onlineUsers.set(Array.isArray(u) ? u : []))
    );
    this.realtime.peerTyping$.subscribe((d) => this.zone.run(() => this.onPeerTyping(d)));
    this.realtime.conversationAdded$.subscribe(() => this.zone.run(() => this.loadConversations()));
    this.realtime.conversationRemoved$.subscribe((d) => this.zone.run(() => this.onConversationRemoved(d)));
    this.realtime.conversationRead$.subscribe((d) => this.zone.run(() => this.onConversationRead(d)));
    this.realtime.reactionUpdated$.subscribe((d) => this.zone.run(() => this.onReactionUpdated(d)));
    this.realtime.messageEdited$.subscribe((d) => this.zone.run(() => this.onMessageEdited(d)));
    this.realtime.messageDeleted$.subscribe((d) => this.zone.run(() => this.onMessageDeleted(d)));
    this.loadConversations();
    this.chatApi.getMyProfile().subscribe({
      next: (p) => this.myAvatarUrl.set(p?.avatar_url ?? null),
      error: () => {},
    });
  }

  /** Update the cached own-avatar (call after the profile screen uploads/removes). */
  setMyAvatarUrl(url: string | null): void {
    this.myAvatarUrl.set(url ?? null);
  }

  /** (Re)load the sidebar. Server-backed unread is authoritative. */
  loadConversations(): void {
    this.chatApi.getConversations().subscribe({
      next: (data) => {
        this.conversations.set((data ?? []).map((raw) => toEntry(raw)));
      },
      error: () => {
        /* navigation is a view concern; swallow */
      },
    });
  }

  // --- selecting / loading a conversation ----------------------------------
  openConversation(entry: ConversationEntry): void {
    this.selectedKey.set(entry.key);
    this.typingFrom.set(null);
    entry.unreadCount = 0;

    const req =
      entry.kind === 'group'
        ? this.chatApi.getGroupMessages(entry.conversationId as number)
        : this.chatApi.getDmMessages(entry.username || '');
    req.subscribe({
      next: (data: any) => {
        const messages = (data?.messages ?? []).map((m: any) => this.toMessage(m));
        this.chatHistory.update((h) => ({ ...h, [entry.key]: messages }));
        this.applyReadState(entry.key, data?.read_state ?? []);
        this.markRead(entry);
      },
      error: () => {
        /* swallow */
      },
    });
  }

  /** Deselect the open conversation (back to the inbox / search view). */
  clearSelection(): void {
    this.selectedKey.set('');
  }

  /** Find-or-create a local DM entry (no navigation). */
  ensureDirectEntry(username: string): ConversationEntry {
    let entry = this.conversations().find(
      (e) => e.kind === 'direct' && e.username === username
    );
    if (!entry) {
      entry = {
        kind: 'direct',
        key: username,
        username,
        displayName: username,
        unreadCount: 0,
      };
      const created = entry;
      this.conversations.update((cs) => [...cs, created]);
    }
    return entry;
  }

  // --- sending -------------------------------------------------------------
  sendMessage(entry: ConversationEntry, text: string, replyingTo: Message | null): void {
    const ready = this.pendingAttachments().filter(p => p.status === 'done' && p.attachment);
    const attachments = ready.map(p => p.attachment!) as Attachment[];
    if (this.isSendingMessage || (!text.trim() && attachments.length === 0) || !entry) return;

    const msg: Message = {
      id: this.newId(),
      from: this.currentUser,
      to: entry.key,
      message: text,
      datetime: new Date().toISOString(),
      status: 'sending',
      reactions: [],
      replyTo: replyingTo?.id ?? null,
      replyPreview: replyingTo ? replyingTo.message : null,
      attachments,
    };
    this.chatHistory.update(h => ({ ...h, [entry.key]: [...(h[entry.key] ?? []), msg] }));
    entry.last_message = text || (attachments.length ? '📎 Attachment' : '');
    entry.last_message_at = msg.datetime;
    const sentIds = new Set(ready.map(p => p.localId));
    this.pendingAttachments.update(list => list.filter(p => !sentIds.has(p.localId)));

    this.postMessage(entry, text, msg);
  }

  addFiles(files: FileList | File[]): void {
    Array.from(files).forEach((file) => {
      const localId = this.newId();
      this.pendingAttachments.update(p => [...p, { localId, file, status: 'uploading', progress: 0 }]);
      this.uploadOne(localId, file);
    });
  }

  private uploadOne(localId: string, file: File): void {
    this.chatApi.uploadAttachment(file).subscribe({
      next: (ev: any) => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          this.patchPending(localId, { progress: Math.round((100 * ev.loaded) / ev.total) });
        } else if (ev.type === HttpEventType.Response) {
          this.patchPending(localId, { status: 'done', progress: 100, attachment: ev.body });
        }
      },
      error: () => this.patchPending(localId, { status: 'failed' }),
    });
  }

  private patchPending(localId: string, patch: Partial<PendingAttachment>): void {
    this.pendingAttachments.update(list =>
      list.map(p => (p.localId === localId ? { ...p, ...patch } : p)));
  }

  removePending(localId: string): void {
    this.pendingAttachments.update(list => list.filter(p => p.localId !== localId));
  }

  retryPending(localId: string): void {
    const p = this.pendingAttachments().find(x => x.localId === localId);
    if (!p) return;
    this.patchPending(localId, { status: 'uploading', progress: 0 });
    this.uploadOne(localId, p.file);
  }

  retry(entry: ConversationEntry, msg: Message): void {
    if (!entry || msg.status === 'sending') return;
    msg.status = 'sending';
    this.chatHistory.update((h) => ({ ...h }));
    this.postMessage(entry, msg.message, msg);
  }

  private postMessage(entry: ConversationEntry, text: string, msg: Message): void {
    this.isSendingMessage = true;
    const attachmentIds = (msg.attachments ?? []).map(a => a.id);
    const attachmentsMeta = msg.attachments ?? [];
    let req: Observable<any>;
    if (entry.kind === 'group') {
      this.realtime.emitSend({
        conversation_id: entry.conversationId,
        message: text,
        client_message_id: msg.id,
        reply_to: msg.replyTo ?? null,
        attachments: attachmentsMeta,
      });
      req = this.chatApi.postGroup(
        entry.conversationId as number,
        text,
        msg.id as string,
        msg.replyTo ?? null,
        attachmentIds
      );
    } else {
      this.realtime.emitSend({
        recipient: entry.username,
        message: text,
        client_message_id: msg.id,
        reply_to: msg.replyTo ?? null,
        attachments: attachmentsMeta,
      });
      req = this.chatApi.postDm(
        entry.username || '',
        text,
        msg.id as string,
        msg.replyTo ?? null,
        attachmentIds
      );
    }
    req.pipe(finalize(() => (this.isSendingMessage = false))).subscribe({
      next: () => {
        msg.status = 'sent';
        this.chatHistory.update((h) => ({ ...h }));
      },
      error: () => {
        msg.status = 'failed';
        this.chatHistory.update((h) => ({ ...h }));
      },
    });
  }

  // --- read tracking -------------------------------------------------------
  markRead(entry: ConversationEntry): void {
    if (typeof document !== 'undefined' && document.hidden) return;
    const req =
      entry.kind === 'group'
        ? this.chatApi.markGroupRead(entry.conversationId as number)
        : this.chatApi.markDmRead(entry.username || '');
    req.subscribe({ error: () => {} });
  }

  /** Replace the read-state map for a conversation from a read_state payload. */
  private applyReadState(
    key: string,
    rows: { username: string; last_read_at: string | null }[]
  ): void {
    const m: { [u: string]: string | null } = {};
    for (const r of rows) m[r.username] = r.last_read_at;
    this.readState.update((rs) => ({ ...rs, [key]: m }));
  }

  // --- typing --------------------------------------------------------------
  notifyTyping(entry: ConversationEntry): void {
    if (!entry) return;
    const now = Date.now();
    if (now - this.lastTypingEmit < 2000) return;
    this.lastTypingEmit = now;
    if (entry.kind === 'group') {
      this.realtime.emitTyping({ conversation_id: entry.conversationId });
    } else {
      this.realtime.emitTyping({ recipient: entry.username });
    }
  }

  // --- reactions -----------------------------------------------------------
  toggleReaction(msg: Message, emoji: string): void {
    if (!msg.id || msg.deleted) return;
    const list = (msg.reactions ?? []).map((r) => ({ ...r }));
    const found = list.find((r) => r.emoji === emoji);
    if (found && found.mine) {
      found.count -= 1;
      found.mine = false;
    } else if (found) {
      found.count += 1;
      found.mine = true;
    } else {
      list.push({ emoji, count: 1, mine: true });
    }
    msg.reactions = list.filter((r) => r.count > 0);
    this.chatHistory.update((h) => ({ ...h }));
    this.chatApi.react(msg.id, emoji).subscribe({
      next: (res: any) => {
        msg.reactions = this.mergeReactions(res?.reactions ?? [], msg.reactions);
        this.chatHistory.update((h) => ({ ...h }));
      },
      error: () => {},
    });
  }

  /** Merge authoritative counts while preserving *my* reaction flags locally
   * (only my own toggles ever change my `mine`, so it's safe to keep them). */
  private mergeReactions(
    incoming: Reaction[],
    current: Reaction[] | undefined
  ): Reaction[] {
    const cur = current ?? [];
    return (incoming ?? []).map((r) => ({
      emoji: r.emoji,
      count: r.count,
      mine: cur.find((c) => c.emoji === r.emoji)?.mine ?? false,
    }));
  }

  // --- edit + delete -------------------------------------------------------
  editMessage(msg: Message, body: string): void {
    const text = body.trim();
    if (!msg.id || !text) return;
    this.chatApi.editMessage(msg.id, text).subscribe({
      next: (res: any) => {
        msg.message = res?.body ?? text;
        msg.editedAt = res?.edited_at ?? new Date().toISOString();
        this.chatHistory.update((h) => ({ ...h }));
      },
      error: () => {},
    });
  }

  deleteMessage(msg: Message): void {
    if (msg.from !== this.currentUser || !msg.id) return;
    if (typeof confirm === 'function' && !confirm('Delete this message?')) return;
    this.chatApi.deleteMessage(msg.id).subscribe({
      next: () => {
        msg.deleted = true;
        msg.message = '';
        msg.reactions = [];
        this.chatHistory.update((h) => ({ ...h }));
      },
      error: () => {},
    });
  }

  // --- group creation ------------------------------------------------------
  createGroup(title: string, members: string[]): Observable<any> {
    return this.chatApi.createGroup(title, members);
  }

  // --- presence ------------------------------------------------------------
  isOnline(username: string): boolean {
    return this.onlineUsers().some((u: any[]) => u[0] === username && u[1]);
  }

  // --- incoming socket handlers --------------------------------------------
  private onReceive(data: any): void {
    if (!data?.username || data.message === undefined || data.message === null) return;
    const from = String(data.username);
    const isGroup = data.kind === 'group' && data.conversation_id != null;
    const key = isGroup ? `conv:${data.conversation_id}` : from;

    const msg: Message = this.toMessage({
      from,
      to: this.currentUser,
      message: data.message,
      datetime: data.datetime,
      id: data.id,
      reply_to: data.reply_to,
      reply_preview: data.reply_preview,
      reactions: data.reactions,
      edited_at: data.edited_at,
      deleted: data.deleted,
    });
    this.chatHistory.update((h) => ({
      ...h,
      [key]: [...(h[key] ?? []), msg],
    }));

    if (from === this.typingFrom()) this.typingFrom.set(null);

    let entry = this.conversations().find((e) => e.key === key);
    if (!entry) {
      if (isGroup) {
        // We belong to a group we don't have locally yet — refetch the list.
        this.loadConversations();
      } else {
        const created: ConversationEntry = {
          kind: 'direct',
          key: from,
          username: from,
          displayName: from,
          unreadCount: 0,
        };
        entry = created;
        this.conversations.update((cs) => [...cs, created]);
      }
    }
    if (entry) {
      entry.last_message = msg.message;
      entry.last_message_at = msg.datetime;
      const visible = typeof document === 'undefined' || !document.hidden;
      if (key === this.selectedKey() && visible) {
        this.markRead(entry);
      } else {
        entry.unreadCount = (entry.unreadCount || 0) + 1;
      }
      this.conversations.update((cs) => [...cs]);
    }
  }

  private onPeerTyping(data: any): void {
    const from = data?.from ? String(data.from) : '';
    if (!from || from === this.currentUser) return;
    const cid = data?.conversation_id;
    const matches =
      cid != null ? `conv:${cid}` === this.selectedKey() : from === this.selectedKey();
    if (!matches) return;
    this.typingFrom.set(from);
    if (this.typingClearTimer) clearTimeout(this.typingClearTimer);
    this.typingClearTimer = setTimeout(() => this.typingFrom.set(null), 3000);
  }

  private onConversationRemoved(data: any): void {
    const cid = data?.conversation_id;
    if (cid == null) return;
    const key = `conv:${cid}`;
    this.conversations.update((cs) => cs.filter((e) => e.key !== key));
    if (this.selectedKey() === key) this.selectedKey.set('');
    this.chatHistory.update((h) => {
      const { [key]: _drop, ...rest } = h;
      return rest;
    });
  }

  /** Merge a live conversation_read event into the read-state map. */
  private onConversationRead(data: any): void {
    const cid = data?.conversation_id;
    const username = data?.username;
    const lastRead = data?.last_read_at;
    if (!username || lastRead === undefined) return;
    const groupKey = cid != null ? `conv:${cid}` : null;
    this.readState.update((rs) => {
      const next = { ...rs };
      for (const key of Object.keys(next)) {
        if ((groupKey && key === groupKey) || username in next[key]) {
          next[key] = { ...next[key], [username]: lastRead };
        }
      }
      return next;
    });
  }

  private onReactionUpdated(d: any): void {
    const msg = this.findMessage(d?.client_message_id);
    if (!msg) return;
    msg.reactions = this.mergeReactions(d?.reactions ?? [], msg.reactions);
    this.chatHistory.update((h) => ({ ...h }));
  }

  private onMessageEdited(d: any): void {
    const msg = this.findMessage(d?.client_message_id);
    if (!msg) return;
    msg.message = d?.body ?? msg.message;
    msg.editedAt = d?.edited_at ?? msg.editedAt;
    this.chatHistory.update((h) => ({ ...h }));
  }

  private onMessageDeleted(d: any): void {
    const msg = this.findMessage(d?.client_message_id);
    if (!msg) return;
    msg.deleted = true;
    msg.message = '';
    msg.reactions = [];
    this.chatHistory.update((h) => ({ ...h }));
  }

  // --- helpers -------------------------------------------------------------
  /** Locate a message across every loaded thread by its globally-unique id. */
  private findMessage(id: string | null | undefined): Message | null {
    if (!id) return null;
    const h = this.chatHistory();
    for (const key of Object.keys(h)) {
      const hit = h[key].find((m) => m.id === id);
      if (hit) return hit;
    }
    return null;
  }

  private newId(): string {
    const c: any = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'm-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  private toMessage(raw: any): Message {
    return {
      id: raw.id ?? undefined,
      from: String(raw.from),
      to: raw.to ?? this.currentUser,
      message: String(raw.message ?? ''),
      datetime: raw.datetime ?? new Date().toISOString(),
      reactions: Array.isArray(raw.reactions) ? raw.reactions : [],
      replyTo: raw.reply_to ?? null,
      replyPreview: raw.reply_preview ?? null,
      editedAt: raw.edited_at ?? null,
      deleted: !!raw.deleted,
      attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
      senderAvatarUrl: raw.sender_avatar_url ?? null,
    };
  }
}
