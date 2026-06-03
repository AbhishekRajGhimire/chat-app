import { Component } from '@angular/core';
import { ChatStore } from '../../core/chat-store.service';
import { PendingAttachment } from '../../core/models/message.model';

@Component({
  selector: 'app-attachment-tray',
  templateUrl: './attachment-tray.component.html',
  styleUrls: ['./attachment-tray.component.scss'],
  standalone: false,
})
export class AttachmentTrayComponent {
  private urls = new Map<string, string>();
  constructor(public store: ChatStore) {}
  thumb(p: PendingAttachment): string {
    if (!this.urls.has(p.localId)) this.urls.set(p.localId, URL.createObjectURL(p.file));
    return this.urls.get(p.localId)!;
  }
  isImage(p: PendingAttachment): boolean { return p.file.type.startsWith('image/'); }
  remove(p: PendingAttachment): void {
    const u = this.urls.get(p.localId);
    if (u) { URL.revokeObjectURL(u); this.urls.delete(p.localId); }
    this.store.removePending(p.localId);
  }
}
