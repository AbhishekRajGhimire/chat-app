import { Injectable } from '@angular/core';
import { HttpClient, HttpEvent, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { RawConversation, DirectoryUser } from './models/conversation.model';
import { Attachment, Reaction, ReadRow } from './models/message.model';

@Injectable({ providedIn: 'root' })
export class ChatApi {
  constructor(private http: HttpClient) {}

  private headers(): HttpHeaders {
    return new HttpHeaders().set('Authorization', 'Bearer ' + localStorage.getItem('access_token'));
  }

  getConversations(): Observable<RawConversation[]> {
    return this.http.get<RawConversation[]>('/api/chats_history', { headers: this.headers() });
  }
  getDmMessages(other: string): Observable<{ messages: any[]; read_state: ReadRow[] }> {
    return this.http.get<any>(`/api/dm/messages/${encodeURIComponent(other)}`, { headers: this.headers() });
  }
  getGroupMessages(cid: number): Observable<{ messages: any[]; read_state: ReadRow[] }> {
    return this.http.get<any>(`/api/groups/${cid}/messages`, { headers: this.headers() });
  }
  postDm(toUsername: string, body: string, clientMessageId: string, replyTo: string | null, attachmentIds: number[] = []): Observable<any> {
    return this.http.post<any>('/api/dm/messages',
      { to_username: toUsername, body, client_message_id: clientMessageId, reply_to: replyTo, attachment_ids: attachmentIds },
      { headers: this.headers() });
  }
  postGroup(cid: number, body: string, clientMessageId: string, replyTo: string | null, attachmentIds: number[] = []): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/messages`,
      { body, client_message_id: clientMessageId, reply_to: replyTo, attachment_ids: attachmentIds }, { headers: this.headers() });
  }
  uploadAttachment(file: File): Observable<HttpEvent<Attachment>> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Attachment>('/api/attachments', form, {
      headers: this.headers(), reportProgress: true, observe: 'events',
    });
  }
  attachmentUrl(id: number): string {
    return `/api/attachments/${id}?token=${localStorage.getItem('access_token')}`;
  }
  markDmRead(other: string): Observable<any> {
    return this.http.post<any>(`/api/dm/${encodeURIComponent(other)}/read`, {}, { headers: this.headers() });
  }
  markGroupRead(cid: number): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/read`, {}, { headers: this.headers() });
  }
  react(cmid: string, emoji: string): Observable<{ reactions: Reaction[] }> {
    return this.http.post<any>(`/api/messages/${cmid}/react`, { emoji }, { headers: this.headers() });
  }
  editMessage(cmid: string, body: string): Observable<{ body: string; edited_at: string }> {
    return this.http.patch<any>(`/api/messages/${cmid}`, { body }, { headers: this.headers() });
  }
  deleteMessage(cmid: string): Observable<any> {
    return this.http.delete<any>(`/api/messages/${cmid}`, { headers: this.headers() });
  }
  directoryUsers(): Observable<DirectoryUser[]> {
    return this.http.get<DirectoryUser[]>('/api/directory_users', { headers: this.headers() });
  }
  createGroup(title: string, members: string[]): Observable<any> {
    return this.http.post<any>('/api/groups', { title, members }, { headers: this.headers() });
  }
  getGroup(cid: number): Observable<any> {
    return this.http.get<any>(`/api/groups/${cid}`, { headers: this.headers() });
  }
  addMembers(cid: number, members: string[]): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/members`, { members }, { headers: this.headers() });
  }
  removeMember(cid: number, username: string): Observable<any> {
    return this.http.delete<any>(`/api/groups/${cid}/members/${encodeURIComponent(username)}`, { headers: this.headers() });
  }
  leaveGroup(cid: number): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/leave`, {}, { headers: this.headers() });
  }
  uploadAvatar(file: File): Observable<any> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<any>('/api/me/avatar', form, { headers: this.headers() });
  }
  deleteAvatar(): Observable<any> {
    return this.http.delete<any>('/api/me/avatar', { headers: this.headers() });
  }
}
