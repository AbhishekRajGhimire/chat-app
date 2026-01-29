import { Component, NgZone, OnDestroy } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { AuthService } from '../auth.service';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
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
  currentUser: any; // to store the username of the currently logged-in user
  chatUsers: any; // to store the users with whom the current user has conversed before.
  chatHistory: { [username: string]: Message[] } = {}; // to store the chat history and chat users of the currently logged-in user
  onlineUsers!: any; // to store the online users
  filteredUsers: string[] = []; // to display the username for user search results
  socket: any;
  selectedUser: string = ''; // to store the user selected for direct messages
  searchInput = '';
  newMessage = ''; // to store the user input for a new message
  sid: any = ''; //socket ID of the recipient

  constructor(
    private http: HttpClient,
    private authService: AuthService,
    private router: Router,
    private zone: NgZone
  ) {
    const token = localStorage.getItem('access_token');
    this.currentUser = localStorage.getItem('username') || '';
    const headers = new HttpHeaders().set('Authorization', 'Bearer ' + token);
    this.http
      .get<string[]>('/api/chats_history', { headers })
      .subscribe(
        (data: any) => {
          this.chatUsers = data;
        },
        (error) => {
          if (error.status === 422) {
            this.router.navigate(['/signin']);
          }
        }
      );

    this.socket = io('https://ed-6129943822073856.educative.run:3000');
    this.socket.on('online_users', (users: any) => {
      if (users.length == 0) {
        this.router.navigate(['/signin']);
      } else {
        this.onlineUsers = users;
        this.filteredUsers = this.onlineUsers.map((user: any[]) => user[0]);
      }
    }),

    this.socket.on('receive_message', (data: any) => {
      console.log("message received")
      const messageDate = new Date(data.datetime);
      const formattedDate = messageDate.toLocaleString(); // Or any other format you prefer
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
    })

    this.socket.connect();
  }

  ngOnDestroy(): void {
    // Disconnect from the WebSocket server when the component is destroyed
    this.socket.disconnect();
    localStorage.removeItem('access_token');
    localStorage.removeItem('username') ;
    this.router.navigate(['/signin']);
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

  filterUsers() {
    this.filteredUsers = this.filteredUsers.filter((user: any) =>
      user.toLowerCase().includes(this.searchInput.toLowerCase())
    );
  }

  selectUser(username: any): void {
    this.selectedUser = username;
    this.searchInput = ''; // Clear search input
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
          this.router.navigate(['/signin']);
        }
      );
  }

  // Function to decide whether to display the search section or the chat section. You can implement your own solution and modify the html file accordingly
  showSearch() {
    this.selectedUser = '';
  }

  sendMessage(): void {
    if (!this.newMessage || !this.selectedUser) {
      console.error('Please select a recipient and enter a message.');
      return;
    }
    const foundPair = this.onlineUsers.find(
      (user: any) => user[0] == this.selectedUser
    );
    if (foundPair) {
      this.sid = foundPair[1];
      this.socket.emit('send_message', {
        from: this.currentUser,
        recipientsid: this.sid,
        message: this.newMessage,
      });
      const today = new Date();
      const formattedDatetime = today.toISOString(); // Convert date to ISO8601 string format

      const msg: Message = {
        from: this.currentUser,
        to: this.selectedUser,
        message: this.newMessage,
        datetime: formattedDatetime,
      };
      this.chatHistory[this.selectedUser].push(msg);

      const headers = new HttpHeaders().set(
        'Authorization',
        'Bearer ' + localStorage.getItem('access_token')
      );

      this.http.post(`/api/post_messages/${this.selectedUser}/&/${this.currentUser}/&/${this.newMessage}`,{headers}).subscribe((data:any)=>console.log(data));;

      this.newMessage = '';
    } else {
      window.alert(
        'This user is not online, cannot send message at the moment'
      );
    }
  }
}