import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { io } from 'socket.io-client';

@Injectable({ providedIn: 'root' })
export class RealtimeClient {
  private socket: any = null;

  readonly receiveMessage$ = new Subject<any>();
  readonly onlineUsers$ = new Subject<any[]>();
  readonly peerTyping$ = new Subject<any>();
  readonly conversationAdded$ = new Subject<any>();
  readonly conversationRemoved$ = new Subject<any>();
  readonly conversationRead$ = new Subject<any>();
  readonly reactionUpdated$ = new Subject<any>();
  readonly messageEdited$ = new Subject<any>();
  readonly messageDeleted$ = new Subject<any>();

  connect(token: string): void {
    if (this.socket) return;
    this.socket = io({ query: { token } });
    this.socket.on('receive_message', (d: any) => this.receiveMessage$.next(d));
    this.socket.on('online_users', (d: any) => this.onlineUsers$.next(Array.isArray(d) ? d : []));
    this.socket.on('peer_typing', (d: any) => this.peerTyping$.next(d));
    this.socket.on('conversation_added', (d: any) => this.conversationAdded$.next(d));
    this.socket.on('conversation_removed', (d: any) => this.conversationRemoved$.next(d));
    this.socket.on('conversation_read', (d: any) => this.conversationRead$.next(d));
    this.socket.on('reaction_updated', (d: any) => this.reactionUpdated$.next(d));
    this.socket.on('message_edited', (d: any) => this.messageEdited$.next(d));
    this.socket.on('message_deleted', (d: any) => this.messageDeleted$.next(d));
    this.socket.connect();
  }

  disconnect(): void {
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
  }

  emitSend(payload: any): void { this.socket?.emit('send_message', payload); }
  emitTyping(payload: any): void { this.socket?.emit('typing', payload); }
}
