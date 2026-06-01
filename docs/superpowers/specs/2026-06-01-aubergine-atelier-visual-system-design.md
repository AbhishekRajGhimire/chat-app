# Aubergine Atelier — Premium Visual System Design

**Status:** Approved (direction + scope + motion confirmed via brainstorm visual companion, 2026-06-01)
**Phase:** Phase 3 visual system (follows Phase 1 Angular 13→21 upgrade and Phase 2 "Refined Material+" refresh)
**Branch target:** new branch off `feature/visual-refresh`

---

## Goal

Elevate the Rojin chat client into a cohesive, premium, "quiet-luxury editorial" interface — **Aubergine Atelier** — applied across all four screens (sign-in, sign-up, chat, profile). Deliberately avoid generic AI aesthetics (purple-on-white, Inter/Roboto, predictable layouts) through distinctive serif typography, an ivory-paper canvas, gold-leaf accents, and the brand aubergine reserved for emphasis.

## Aesthetic direction (chosen)

Light, editorial, refined. Ivory paper canvas; deep aubergine ink; **Libre Baskerville** serif for brand/names/headings; **Fraunces** italic for accents (taglines, date separators, eyebrows); **Hanken Grotesk** for all functional/body text; gold-leaf (`#b08d57`) hairlines and accents; brand plum (`#4a154b`) reserved for chrome, the user's own message bubbles, and primary buttons. Calm, lots of air, subtle paper grain.

**Motion level:** Refined **+ signature moments** (see §7). All motion gated behind `prefers-reduced-motion`.

## Non-goals / YAGNI

- No dark mode toggle (Atelier is a light system; out of scope).
- No new app features, routes, or backend changes — this is presentation only.
- No standalone-component migration; stays on NgModules.
- No change to the dual-write send logic, socket wiring, or auth patterns.

---

## 1. Token layer — `client/src/app/ui/styles/_tokens.scss`

The single source of truth. Every feature SCSS already `@use`s it, so changes here propagate. Redefine/extend:

### Color
```
$rojin-ink:           #3a0e3c;   // primary text (deep aubergine)
$rojin-ink-soft:      #6b4a6d;   // muted text / previews / meta
$rojin-primary:       #4a154b;   // brand plum — chrome, sent bubbles, primary CTA
$rojin-primary-dark:  #2b0a2c;
$rojin-canvas:        #f7f2e8;   // ivory paper (app background)
$rojin-paper:         #fffdf8;   // elevated surfaces (cards, received bubbles, fields)
$rojin-gold:          #b08d57;   // gold-leaf accent
$rojin-gold-soft:     rgba(176,141,87,0.38);
$rojin-line:          rgba(176,141,87,0.32);   // hairline borders
$rojin-text-on-brand: #f7f2e8;   // ivory text on plum
$rojin-online:        #3f5a3a;   // muted forest green (presence)
$rojin-online-soft:   rgba(63,90,58,0.10);
```
Retain existing token *names* where feature components already reference them (e.g. `$rojin-text-meta`, `$rojin-text-body`, `$rojin-bg-app`, `$rojin-bg-thread`, `$rojin-border`) by re-pointing them at the new palette, so we don't have to touch every consumer at once. `$rojin-text-meta` must stay ≥4.5:1 on both `$rojin-canvas` and `$rojin-paper`.

### Typography
```
$rojin-font-display: "Libre Baskerville", Georgia, serif;   // brand, names, headings
$rojin-font-accent:  "Fraunces", Georgia, serif;            // italic taglines, date sep, eyebrows
$rojin-font-body:    "Hanken Grotesk", system-ui, sans-serif;
$rojin-font-brand:   $rojin-font-display;   // brand lockup switches Montserrat → Libre Baskerville
```
Add a type scale (display/title/body/meta/label sizes, weights, letter-spacing) as tokens so components don't hard-code.

### Shape, elevation, motion
```
$rojin-radius-sm: 11px;  $rojin-radius-md: 14px;  $rojin-radius-lg: 18px;
$rojin-shadow-card: 0 18px 50px rgba(43,10,44,0.10);
$rojin-bubble-received-border: $rojin-gold-soft;
// Motion tokens
$rojin-dur-fast: 150ms;  $rojin-dur-base: 240ms;  $rojin-dur-slow: 520ms;
$rojin-ease: cubic-bezier(0.22, 0.61, 0.36, 1);          // gentle ease-out
$rojin-ease-emphasis: cubic-bezier(0.34, 1.36, 0.64, 1); // slight overshoot for pop-in
```

## 2. Material M3 + global styles

- **`client/src/app/ui/styles/_m3-theme.scss` / `client/src/styles.scss`:** retune the M3 theme so Material components inherit the Atelier palette — `primary` = plum, a `tertiary` that reads as gold. Add an **M3 typography config** mapping Material type levels to Hanken Grotesk (body) and Libre Baskerville (headings). (Today the theme is color-only — this is the upgrade.) Verify `mat-form-field`, `button[mat-raised-button]`, `button[mat-stroked-button]`, `mat-list-item`, `mat-icon-button` all render correctly under MDC.
- **Global (`styles.scss`):** ivory `--canvas` body background with a subtle paper-grain (`radial-gradient(rgba(58,14,60,.035) 1px, transparent 1px); background-size:4px 4px;`), custom thin scrollbars (gold-soft thumb on canvas), aubergine `::selection`, and a global gold focus-ring utility. Honor `prefers-reduced-motion`.
- **`client/src/index.html`:** load `Fraunces` (opsz, italic + upright 400/500/600) and `Hanken Grotesk` (400–700); keep `Libre Baskerville` (already present); remove now-unused families (Montserrat) once the brand lockup is switched.

## 3. Sign-in & Sign-up (`signin/`, `signup/`)

Shared language across both:
- **Hero panel** (plum background, ivory text): Libre Baskerville brand lockup + Fraunces italic tagline ("Conversations worth keeping."), with a **gold hairline that draws itself in** on load (animated `width`).
- **Form panel** (paper): Libre Baskerville section heading ("Welcome back" / "Create your account"), uppercase **gold micro-labels** above each field, paper inputs with gold focus-ring bloom, full-width plum CTA, and a footer link (gold-underlined) to the opposite screen.
- Preserve existing form logic, `ngModel`, validation, error handling, and the 401→`/signin` reactive redirect.

## 4. Chat (`chat/`) — the centerpiece

- **Top-bar** (`ToolbarShellComponent` + chat chrome): plum, serif brand + Fraunces italic tagline; right-aligned pill actions (Profile stroked, Welcome/user solid-gold).
- **Sidebar:** "New conversation" paper button; Fraunces uppercase "Direct messages" header; DM rows = avatar + **Libre Baskerville name** + Hanken preview line; active row gets a **gold inset rule** + faint plum tint.
- **Conversation header:** avatar + serif name + online pill.
- **Thread:** **Fraunces italic date separators** with hairline rules; received bubbles = paper + gold hairline + bottom-left clip; sent bubbles = plum + ivory text + bottom-right clip; grouped-message meta (`name · h:mm a`) once per group in ink-soft; message **pop-in** animation on arrival.
- **Composer:** paper textarea field + **gold Send button**; Send triggers an expressive send→bubble flight micro-animation.
- **Empty & loading states:** restyle the existing empty-thread badge, search empty/no-match states, and shimmer skeleton rows into the Atelier palette/type.
- Keep all existing behavior: message grouping helpers, day-separator logic, avatars, dual-write send, socket handlers.

## 5. Profile (`profile/`)

Editorial card matching the auth language: hero/header with avatar and serif name, gold-labelled editable fields (display name, bio, avatar URL), plum save button, consistent paper surfaces. Preserve existing profile load/save logic and JWT header pattern.

## 6. Shared UI components (`ui/`)

- **`BrandLockupComponent`:** switch brand font to Libre Baskerville; add the gold accent dot + optional Fraunces italic tagline styling.
- **`ToolbarShellComponent`:** plum chrome, ivory text, safe-area padding retained.
- **`AvatarComponent`:** harmonize the initials palette toward muted jewel tones (aubergine/gold/forest/clay) that sit well on ivory and plum, replacing the current bright web palette. Keep the deterministic hashing + initials logic and AA-readable white text.

## 7. Motion system

Centralized keyframes (in `styles.scss` or a `_motion.scss` partial) consuming the motion tokens, all wrapped so they no-op under `prefers-reduced-motion: reduce`:
- **Refined:** staggered fade/rise on screen load (`animation-delay` cascade), 150ms hover transitions, message pop-in (`$rojin-ease-emphasis`), focus-ring bloom.
- **Signature:** auth gold-hairline self-draw, faint paper-grain shimmer, expressive send animation (bubble lift/flight).

## 8. Accessibility

- WCAG AA (4.5:1 small text): ink `#3a0e3c` on canvas/paper and ivory on plum all pass; **verify computed** as in Phase 2. Gold is reserved for large/decorative/on-plum use — not small body text on light surfaces.
- Visible focus states on every interactive element (gold ring).
- `prefers-reduced-motion` honored throughout.
- Maintain tap targets (`$rojin-tap-min: 48px`) and existing keyboard behavior (composer Enter-to-send).

---

## File structure (created / modified)

**Modified:**
- `client/src/app/ui/styles/_tokens.scss` — palette, type, shape, motion tokens
- `client/src/app/ui/styles/_m3-theme.scss` — M3 palette + typography
- `client/src/styles.scss` — global canvas, grain, scrollbars, focus, keyframes
- `client/src/index.html` — fonts
- `client/src/app/signin/signin.component.{html,scss}`
- `client/src/app/signup/signup.component.{html,scss}`
- `client/src/app/chat/chat.component.{html,scss}`
- `client/src/app/profile/profile.component.{html,scss}`
- `client/src/app/ui/brand-lockup/brand-lockup.component.{html,scss}`
- `client/src/app/ui/toolbar-shell/toolbar-shell.component.scss`
- `client/src/app/ui/avatar/avatar.component.{ts,scss}`

**Possibly created:**
- `client/src/app/ui/styles/_motion.scss` — shared keyframes/mixins (if `styles.scss` grows unwieldy)

## Build order (each a verifiable checkpoint)

1. Token layer (`_tokens.scss`) — foundation
2. Fonts (`index.html`)
3. M3 theme + global (`_m3-theme.scss`, `styles.scss`)
4. Shared auth (sign-in + sign-up)
5. Chat (centerpiece)
6. Profile
7. UI components (brand-lockup, toolbar-shell, avatar)
8. Motion polish (refined + signature)
9. AA contrast + reduced-motion pass

## Verification

Per `CLAUDE.md`: this touches many runtime files. Run both processes (`python main.py`, `npm run start`) and get explicit user browser approval at each meaningful checkpoint before committing. Build must stay green (`npm run build`); `npm test` is the pre-existing-broken suite and is not a gate.

## Risks / watch-items

- Material MDC selectors can drift between color-only and typography-enabled theming — verify form fields/buttons after the M3 change (regression risk like Phase 2's `.mat-form-field` → `mat-form-field`).
- `anyComponentStyle` budget (currently 6kb/10kb) — Atelier SCSS may grow; raise the budget if a component legitimately exceeds it rather than cramming.
- Gold contrast: never use gold for small body text on light surfaces.
