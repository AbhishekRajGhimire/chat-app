import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { ChatStore } from '../../core/chat-store.service';
import { ChatApi } from '../../core/chat-api.service';
import { ConversationEntry } from '../../core/models/conversation.model';
import { GroupCreateDialogComponent } from '../../chat/group-create-dialog/group-create-dialog.component';

@Component({
  selector: 'app-mobile-chats',
  templateUrl: './mobile-chats.component.html',
  styleUrls: ['./mobile-chats.component.scss'],
  standalone: false,
})
export class MobileChatsComponent {
  constructor(public store: ChatStore, private router: Router,
              private dialog: MatDialog, private chatApi: ChatApi) {}

  open(entry: ConversationEntry): void {
    this.router.navigate(['/m/c', entry.key]);
  }

  monogram(title: string): string {
    const parts = (title || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  listTime(iso: any): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const days = Math.round((now.getTime() - d.getTime()) / 86400000);
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  newGroup(): void {
    this.chatApi.directoryUsers().subscribe((users) => {
      const ref = this.dialog.open(GroupCreateDialogComponent, {
        data: { users }, width: '92vw', maxWidth: '420px', panelClass: 'rojin-dialog',
      });
      ref.afterClosed().subscribe((result: any) => {
        if (!result?.title || !result?.members?.length) return;
        this.store.createGroup(result.title, result.members).subscribe((group: any) => {
          this.router.navigate(['/m/c', 'conv:' + group.conversation_id]);
        });
      });
    });
  }
}
