import { Component, Input } from '@angular/core';

/**
 * Brand-aligned palette for initials avatars. Saturated mid-darks so white
 * text stays AA-readable AND the circle is visible on both the purple sidebar
 * and white surfaces. Avoids the brand purple itself (would vanish on the
 * sidebar).
 */
const AVATAR_COLORS = [
  '#2563eb',
  '#0d9488',
  '#b45309',
  '#be123c',
  '#1b5e20',
  '#7c3aed',
  '#c2410c',
  '#0369a1',
];

@Component({
  selector: 'app-avatar',
  templateUrl: './avatar.component.html',
  styleUrls: ['./avatar.component.scss'],
  standalone: false,
})
export class AvatarComponent {
  /** Display name; drives the initials. */
  @Input() name = '';
  /** Stable identity (username) used to pick a deterministic color. */
  @Input() seed = '';
  /** Optional image; when set, replaces the initials. */
  @Input() imageUrl: string | null = null;
  /** Diameter in px. */
  @Input() size = 32;

  get initials(): string {
    const src = (this.name || this.seed || '?').trim();
    const parts = src.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  get color(): string {
    const key = (this.seed || this.name || '').toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }
}
