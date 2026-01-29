import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AuthService {

  constructor(private http: HttpClient) {}

  // Task 4: Add signup method here
  signup(username: string, password: string): Observable<any> {
    return this.http.post(
      `/api/signup`,
      { username, password },
      {}
    );
  }
  // Task 4: Add signin method here
  signin(username: string, password: string): Observable<any> {
    return this.http.post(
      `/api/signin`,
      {username, password},
      {}
    );
  }

  // Task 4: Add signout method here
  signout(): Observable<any> {
    const headers = new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
    return this.http.post(`/api/signout`, {}, { headers });
  }


}
