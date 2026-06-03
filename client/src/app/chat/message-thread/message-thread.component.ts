import { Component, EventEmitter, Input, Output } from '@angular/core';
import { Message } from '../../core/models/message.model';
import { ChatApi } from '../../core/chat-api.service';
import { avatarSrc } from '../../core/avatar-url';

// Mirrors the avatar palette so a sender's name color matches their avatar.
const SENDER_COLORS = [
  '#6a2c6c', '#7a4a1f', '#7a3450', '#355c34',
  '#43436f', '#84432a', '#5a3a6d', '#1f5f52',
];

/**
 * Presentational message-list. Renders bubbles, day separators, sender headers,
 * reactions, reply quotes, inline edit, tombstones, and seen receipts for a
 * single conversation's thread. Owns only message-level view state (open action
 * overlay / menu / picker, inline-edit draft). All actions are emitted to the
 * host, which owns the store, the composer, the empty-state, and typing.
 */
@Component({
  selector: 'app-message-thread',
  templateUrl: './message-thread.component.html',
  styleUrls: ['./message-thread.component.scss'],
  standalone: false,
})
export class MessageThreadComponent {
  constructor(public api: ChatApi) {}
  readonly avatarSrc = avatarSrc;

  @Input() thread: Message[] = [];
  /** The open conversation's read map: username → last_read_at ISO. */
  @Input() readState: Record<string, string | null> = {};
  @Input() currentUser = '';
  @Input() isGroup = false;

  @Output() react = new EventEmitter<{ msg: Message; emoji: string }>();
  @Output() reply = new EventEmitter<Message>();
  @Output() edit = new EventEmitter<{ msg: Message; body: string }>();
  @Output() remove = new EventEmitter<Message>();
  @Output() retry = new EventEmitter<Message>();
  /** cmid of the replied-to message to scroll to. */
  @Output() scrollToOriginal = new EventEmitter<string>();

  // --- message-level overlay view state ------------------------------------
  /** Message id whose action overlay / menu / picker is open (mobile + click). */
  activeMsgId: string | null = null;
  menuOpenId: string | null = null;
  pickerOpenId: string | null = null;
  /** Message currently being edited inline (null = none) + its draft text. */
  editingId: string | null = null;
  editText = '';

  // --- lightbox ----------------------------------------------------------------
  lightboxUrl: string | null = null;
  openLightbox(url: string) { this.lightboxUrl = url; }
  closeLightbox() { this.lightboxUrl = null; }
  prettySize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  fileIcon(_mime: string): string { return '📄'; }

  readonly quickReactions = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly emojiPicker = [
    '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '👏', '🙌',
    '😍', '🤔', '😅', '😎', '😭', '😡', '👀', '💯', '✅', '❌',
    '🤝', '💪', '🙇', '☕', '🚀', '⭐', '💡', '📌', '👋', '🤷',
  ];

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
    return this.gapMs(cur.datetime, prev.datetime) <= MessageThreadComponent.GROUP_WINDOW_MS;
  }

  isGroupEnd(thread: Message[], index: number): boolean {
    if (index >= thread.length - 1) return true;
    return !this.isContinuation(thread, index + 1);
  }

  /** Show the sender name+avatar header above a received run in a group. */
  showSenderHeader(thread: Message[], index: number): boolean {
    if (!this.isGroup) return false;
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

  /**
   * Readers (excluding me and the sender) whose last_read covers this message
   * AND for whom this is their latest-read message — so each reader's avatar
   * shows exactly once, under the last message they've seen.
   */
  readersOf(thread: Message[], index: number): string[] {
    const rs = this.readState;
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

  // --- action wrappers: emit to host --------------------------------------
  onReact(msg: Message, emoji: string): void {
    this.react.emit({ msg, emoji });
    this.closeOverlays();
  }

  onReply(msg: Message): void {
    this.reply.emit(msg);
    this.closeOverlays();
  }

  onRemove(msg: Message): void {
    this.remove.emit(msg);
    this.closeOverlays();
  }

  onRetry(msg: Message): void {
    this.retry.emit(msg);
  }

  onScrollToOriginal(id: string | null | undefined): void {
    if (id) this.scrollToOriginal.emit(id);
  }

  // --- inline edit ---------------------------------------------------------
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
    this.edit.emit({ msg, body: this.editText });
    this.cancelEdit();
  }
}
