import { Component, Input } from '@angular/core';

/**
 * Brand-aligned palette for initials avatars. Saturated mid-darks so white
 * text stays AA-readable AND the circle is visible on both the purple sidebar
 * and white surfaces. Avoids the brand purple itself (would vanish on the
 * sidebar).
 */
// Muted jewel tones tuned for the Aubergine Atelier palette: deep enough that
// white initials stay AA-readable, and harmonious on both the ivory canvas and
// the plum sidebar (no bright web primaries, no brand-plum clash).
const AVATAR_COLORS = [
  '#6a2c6c', // aubergine
  '#7a4a1f', // bronze
  '#7a3450', // wine
  '#355c34', // forest
  '#43436f', // indigo slate
  '#84432a', // clay
  '#5a3a6d', // mauve
  '#1f5f52', // teal-pine
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
