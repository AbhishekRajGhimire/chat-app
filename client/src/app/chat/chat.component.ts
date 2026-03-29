import { Component, NgZone, OnDestroy } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from '../auth.service';
import { Router } from '@angular/router';
import { io } from 'socket.io-client';

interface Message {
  from: string;
  to: string;
  message: string;
  datetime: any;
}

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.scss'],
})
export class ChatComponent implements OnDestroy {
  currentUser: any;
  chatUsers: string[] = [];
  chatHistory: { [username: string]: Message[] } = {};
  /** Everyone registered except you — used for New Chat search. */
  directoryUsers: string[] = [];
  directoryLoaded = false;
  onlineUsers: any[] = [];
  filteredUsers: string[] = [];
  socket: any;
  selectedUser: string = ''; // to store the user selected for direct messages
  searchInput = '';
  newMessage = '';

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private router: Router,
    private zone: NgZone
  ) {
    const token = localStorage.getItem('access_token');
    this.currentUser = localStorage.getItem('username') || '';
    const headers = new HttpHeaders().set('Authorization', 'Bearer ' + token);
    this.http.get<string[]>('/api/chats_history', { headers }).subscribe(
      (data: string[]) => {
        this.chatUsers = data ?? [];
      },
      (error) => {
        if (error.status === 401 || error.status === 422) {
          this.router.navigate(['/signin']);
        }
      }
    );

    this.http.get<string[]>('/api/directory_users', { headers }).subscribe(
      (data: string[]) => {
        this.directoryUsers = data ?? [];
        this.directoryLoaded = true;
        this.applyNewChatFilter();
      },
      (error) => {
        this.directoryLoaded = true;
        if (error.status === 401 || error.status === 422) {
          this.router.navigate(['/signin']);
        }
      }
    );

    // Local testing: connect to same-origin Socket.IO.
    // With `npm run start`, Angular proxies `/socket.io/*` to the backend at :3000.
    this.socket = io();
    this.socket.on('online_users', (users: any) => {
      this.zone.run(() => {
        this.onlineUsers = Array.isArray(users) ? users : [];
        this.applyNewChatFilter();
      });
    }),

    this.socket.on('receive_message', (data: any) => {
      this.zone.run(() => {
        const messageDate = new Date(data.datetime);
        const formattedDate = messageDate.toLocaleString();
        const msg: Message = {
          from: data.username,
          to: this.currentUser,
          message: data.message,
          datetime: formattedDate,
        };
        if (!this.chatHistory[data.username]) {
          this.chatHistory[data.username] = [];
        }
        this.chatHistory[data.username].push(msg);
      });
    })

    this.socket.connect();
  }

  ngOnDestroy(): void {
    if (this.socket) {
      this.socket.disconnect();
    }
  }

  logout() {
    this.authService.signout().subscribe(
      () => {
        localStorage.removeItem('access_token');
        localStorage.removeItem('username');
        this.router.navigate(['/signin']);
      },
      (error) => {
        this.router.navigate(['/signin']);
      }
    );
  }

  filterUsers(): void {
    this.applyNewChatFilter();
  }

  /** New Chat list: all registered users (except you), filtered by search text. */
  private applyNewChatFilter(): void {
    if (!this.directoryUsers.length) {
      this.filteredUsers = [];
      return;
    }
    const q = this.searchInput.trim().toLowerCase();
    this.filteredUsers = q
      ? this.directoryUsers.filter((name) =>
          name.toLowerCase().includes(q)
        )
      : [...this.directoryUsers];
  }

  isUserOnline(username: string): boolean {
    return this.onlineUsers.some((u: any[]) => u[0] === username && u[1]);
  }

  selectUser(username: any): void {
    this.selectedUser = username;
    this.searchInput = '';
    this.applyNewChatFilter();
    const headers = new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
    this.http
      .get<Message[]>(
        `/api/message_history/${username}/&/${this.currentUser}`,
        { headers }
      )
      .subscribe(
        (data) => {
          this.chatHistory[username] = data;
        },
        (error) => {
          if (error.status === 401 || error.status === 422) {
            this.router.navigate(['/signin']);
          }
        }
      );
  }

  showSearch() {
    this.selectedUser = '';
    this.applyNewChatFilter();
  }

  /** Mobile: leave conversation and return to inbox + search (master). */
  backToInbox(): void {
    this.showSearch();
  }

  sendMessage(): void {
    if (!this.newMessage || !this.selectedUser) {
      return;
    }
    const foundPair = this.onlineUsers.find(
      (user: any[]) => user[0] === this.selectedUser
    );
    const recipientSid = foundPair?.[1];
    if (recipientSid) {
      this.socket.emit('send_message', {
        from: this.currentUser,
        recipientsid: recipientSid,
        message: this.newMessage,
      });
    }

    const today = new Date();
    const formattedDatetime = today.toISOString();
    const text = this.newMessage;
    const peer = this.selectedUser;

    const msg: Message = {
      from: this.currentUser,
      to: peer,
      message: text,
      datetime: formattedDatetime,
    };
    if (!this.chatHistory[peer]) {
      this.chatHistory[peer] = [];
    }
    this.chatHistory[peer].push(msg);

    const headers = new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
    const url = `/api/post_messages/${encodeURIComponent(peer)}/&/${encodeURIComponent(this.currentUser)}/&/${encodeURIComponent(text)}`;
    this.http.post(url, {}, { headers }).subscribe({
      next: () => {
        if (!this.chatUsers.includes(peer)) {
          this.chatUsers = [...this.chatUsers, peer];
        }
      },
      error: (err) => {
        const thread = this.chatHistory[peer];
        if (thread?.length && thread[thread.length - 1] === msg) {
          this.chatHistory[peer] = thread.slice(0, -1);
        }
        if (err.status === 401 || err.status === 422) {
          this.router.navigate(['/signin']);
        }
      },
    });

    this.newMessage = '';
  }
}