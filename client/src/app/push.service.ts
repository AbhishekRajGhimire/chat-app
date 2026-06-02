import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class PushService {
  constructor(private http: HttpClient, private swPush: SwPush) {}

  private headers(): HttpHeaders {
    return new HttpHeaders().set(
      'Authorization',
      'Bearer ' + localStorage.getItem('access_token')
    );
  }

  /** True when a service worker is active (production build + secure context). */
  get supported(): boolean {
    return this.swPush.isEnabled;
  }

  /** 'default' | 'granted' | 'denied' | 'unsupported'. */
  get permission(): NotificationPermission | 'unsupported' {
    if (typeof Notification === 'undefined') return 'unsupported';
    return Notification.permission;
  }

  /** Is there a current push subscription? */
  async isSubscribed(): Promise<boolean> {
    if (!this.supported) return false;
    const sub = await firstValueFrom(this.swPush.subscription);
    return !!sub;
  }

  /** Request permission, subscribe, and register with the backend. */
  async enable(): Promise<void> {
    if (!this.supported) throw new Error('Notifications need the installed / HTTPS app.');
    const { publicKey } = await firstValueFrom(
      this.http.get<{ publicKey: string | null }>('/api/push/vapid-key', { headers: this.headers() })
    );
    if (!publicKey) throw new Error('Push is not configured on the server.');
    const sub = await this.swPush.requestSubscription({ serverPublicKey: publicKey });
    await firstValueFrom(
      this.http.post('/api/push/subscribe', { subscription: sub.toJSON() }, { headers: this.headers() })
    );
  }

  /** Unsubscribe locally and tell the backend to drop it. */
  async disable(): Promise<void> {
    const sub = await firstValueFrom(this.swPush.subscription);
    const endpoint = sub?.endpoint;
    if (endpoint) {
      await firstValueFrom(
        this.http.post('/api/push/unsubscribe', { endpoint }, { headers: this.headers() })
      );
    }
    try {
      await this.swPush.unsubscribe();
    } catch {
      /* already unsubscribed */
    }
  }
}
