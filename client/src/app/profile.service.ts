import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface UserProfile {
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  updated_at: string | null;
}

export interface DirectoryUser {
  username: string;
  display_name: string;
  last_message?: string | null;
  last_message_at?: string | null;
  unreadCount?: number;
}

@Injectable({
  providedIn: 'root',
})
export class ProfileService {
  constructor(private http: HttpClient) {}

  private authHeaders(): HttpHeaders {
    const token = localStorage.getItem('access_token');
    return new HttpHeaders().set('Authorization', 'Bearer ' + token);
  }

  getMyProfile(): Observable<UserProfile> {
    return this.http.get<UserProfile>('/api/me/profile', {
      headers: this.authHeaders(),
    });
  }

  patchMyProfile(body: {
    display_name?: string | null;
    avatar_url?: string | null;
    bio?: string | null;
  }): Observable<UserProfile> {
    return this.http.patch<UserProfile>('/api/me/profile', body, {
      headers: this.authHeaders(),
    });
  }
}
