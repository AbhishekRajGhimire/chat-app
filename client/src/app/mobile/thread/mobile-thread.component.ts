import { Component, ElementRef, OnInit, ViewChild, effect } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Location } from '@angular/common';
import { MatDialog } from '@angular/material/dialog';
import { ChatStore } from '../../core/chat-store.service';
import { ChatApi } from '../../core/chat-api.service';
import { ConversationEntry } from '../../core/models/conversation.model';
import { Message } from '../../core/models/message.model';
import { avatarSrc } from '../../core/avatar-url';
import { AvatarCropperComponent } from '../../ui/avatar-cropper/avatar-cropper.component';

@Component({
  selector: 'app-mobile-thread',
  templateUrl: './mobile-thread.component.html',
  styleUrls: ['./mobile-thread.component.scss'],
  standalone: false,
})
export class MobileThreadComponent implements OnInit {
  @ViewChild('scrollHost') private scrollHost?: ElementRef<HTMLElement>;
  @ViewChild('groupPhotoInput') groupPhotoInput?: ElementRef<HTMLInputElement>;
  readonly avatarSrc = avatarSrc;
  key = '';
  newMessage = '';
  replyingTo: Message | null = null;

  constructor(
    public store: ChatStore,
    private route: ActivatedRoute,
    private location: Location,
    private dialog: MatDialog,
    private api: ChatApi,
  ) {
    effect(() => { this.store.openThread(); this.store.selectedKey(); queueMicrotask(() => this.scrollToBottom()); });
  }

  ngOnInit(): void {
    this.key = this.route.snapshot.paramMap.get('key') || '';
    this.store.openConversation(this.resolveEntry());
  }

  private resolveEntry(): ConversationEntry {
    const found = this.store.conversations().find(c => c.key === this.key);
    if (found) return found;
    if (this.key.startsWith('conv:')) {
      return { kind: 'group', key: this.key, displayName: 'Group', conversationId: Number(this.key.slice(5)), unreadCount: 0 };
    }
    return this.store.ensureDirectEntry(this.key);
  }

  get entry(): ConversationEntry {
    return this.store.conversations().find(c => c.key === this.key) ?? this.resolveEntry();
  }
  get isGroup(): boolean { return this.entry.kind === 'group'; }
  get title(): string { return this.entry.displayName; }
  get peerUsername(): string { return this.entry.username || ''; }

  back(): void { this.location.back(); }

  pickGroupPhoto(): void {
    if (this.isGroup) this.groupPhotoInput?.nativeElement.click();
  }

  onPickGroupAvatar(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    const entry = this.entry;
    if (!file || entry.kind !== 'group' || !entry.conversationId) return;
    this.dialog.open(AvatarCropperComponent, { data: { file }, panelClass: 'rojin-dialog', autoFocus: false })
      .afterClosed().subscribe((cropped?: File) => {
        if (cropped) this.api.uploadGroupAvatar(entry.conversationId!, cropped)
          .subscribe({ next: (g) => { entry.avatarUrl = g.avatar_url ?? null; } });
      });
  }

  monogram(title: string): string {
    const p = (title || '?').trim().split(/\s+/).filter(Boolean);
    if (!p.length) return '?';
    return (p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p[p.length - 1][0]).toUpperCase();
  }

  send(): void {
    const hasReady = this.store.pendingAttachments().some((p) => p.status === 'done');
    if (!this.newMessage.trim() && !hasReady) return;
    this.store.sendMessage(this.entry, this.newMessage, this.replyingTo);
    this.newMessage = '';
    this.replyingTo = null;
  }

  onFilesPicked(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.store.addFiles(input.files);
    input.value = '';
  }

  onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(); }
  }

  onRetry(msg: Message): void { this.store.retry(this.entry, msg); }

  replyName(msg: Message): string {
    if (msg.from === this.store.currentUser) return 'yourself';
    return msg.from;
  }

  scrollToMessage(id: string | null): void {
    if (!id) return;
    const el = document.getElementById('msg-' + id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('message-row--flash');
      setTimeout(() => el.classList.remove('message-row--flash'), 1200);
    }
  }

  private scrollToBottom(): void {
    const el = this.scrollHost?.nativeElement;
    if (el) el.scrollTop = el.scrollHeight;
  }
}
