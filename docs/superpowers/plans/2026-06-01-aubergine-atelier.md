# Aubergine Atelier Visual System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved "Aubergine Atelier" quiet-luxury editorial visual system across all four Rojin client screens (sign-in, sign-up, chat, profile) plus shared UI, with refined + signature motion.

**Architecture:** Token-first. `_tokens.scss` is the single source of truth every feature SCSS already `@use`s; we overhaul it once (palette, type, shape, motion), retune the M3 theme + global canvas, then restyle each screen and shared component to consume the new tokens. No behavior/logic changes — presentation only.

**Tech Stack:** Angular 21 (NgModules), Angular Material MDC + M3 token theming, Dart Sass, Google Fonts (Libre Baskerville, Fraunces, Hanken Grotesk).

**Verification model:** Each task ends with `npm run build` GREEN (esbuild type + budget check). No per-task browser check this build (user waived it); a single full browser review happens after Task 9 before final commit/squash decisions. `npm test` is the pre-existing-broken suite and is NOT a gate.

**Spec:** `docs/superpowers/specs/2026-06-01-aubergine-atelier-visual-system-design.md`
**Branch:** `feature/aubergine-atelier` (already created; spec committed at 2d3a445).

---

### Task 1: Token layer overhaul

**Files:**
- Modify: `client/src/app/ui/styles/_tokens.scss`

- [ ] **Step 1: Replace the palette + add type/shape/motion tokens.** Re-point existing token NAMES used by consumers (`$rojin-text-body`, `$rojin-text-muted`, `$rojin-text-meta`, `$rojin-bg-app`, `$rojin-bg-thread`, `$rojin-bg-elevated`, `$rojin-border`, `$rojin-primary`, `$rojin-text-on-brand`, `$rojin-online*`, `$rojin-font-brand`, `$rojin-tap-min`, `$rojin-breakpoint-mobile`, toolbar/sidebar sizing, the two viewport mixins) at the new values so no consumer breaks. New values:
  - `$rojin-ink:#3a0e3c; $rojin-ink-soft:#6b4a6d; $rojin-primary:#4a154b; $rojin-primary-dark:#2b0a2c;`
  - `$rojin-canvas:#f7f2e8; $rojin-paper:#fffdf8; $rojin-gold:#b08d57; $rojin-gold-soft:rgba(176,141,87,.38); $rojin-line:rgba(176,141,87,.32);`
  - `$rojin-text-on-brand:#f7f2e8; $rojin-online:#3f5a3a; $rojin-online-soft:rgba(63,90,58,.10);`
  - Map legacy names: `$rojin-bg-app:$rojin-canvas; $rojin-bg-thread:$rojin-canvas; $rojin-bg-elevated:$rojin-paper; $rojin-bg-search:#efe7d9; $rojin-border:$rojin-line; $rojin-text-body:$rojin-ink; $rojin-text-muted:$rojin-ink-soft; $rojin-text-meta:#5c4a5e;` (meta must be ≥4.5:1 on canvas+paper — verify in Task 9).
  - Fonts: `$rojin-font-display:"Libre Baskerville",Georgia,serif; $rojin-font-accent:"Fraunces",Georgia,serif; $rojin-font-body:"Hanken Grotesk",system-ui,sans-serif; $rojin-font-brand:$rojin-font-display;`
  - Shape: `$rojin-radius-sm:11px; $rojin-radius-md:14px; $rojin-radius-lg:18px; $rojin-shadow-card:0 18px 50px rgba(43,10,44,.10);`
  - Motion: `$rojin-dur-fast:150ms; $rojin-dur-base:240ms; $rojin-dur-slow:520ms; $rojin-ease:cubic-bezier(.22,.61,.36,1); $rojin-ease-emphasis:cubic-bezier(.34,1.36,.64,1);`
  - Keep `$rojin-focus-ring` but set to `rgba(176,141,87,.45)` (gold). Keep bubble shadow tokens; set `$rojin-bubble-received-border:$rojin-gold-soft;`.
- [ ] **Step 2:** `cd client; npm run build` → Expected: GREEN (or only pre-existing budget warnings). Fix any Sass "undefined variable" errors by adding the missing legacy alias.
- [ ] **Step 3: Commit** `feat(client): Atelier design tokens (palette, type, motion)`

---

### Task 2: Fonts

**Files:**
- Modify: `client/src/index.html`

- [ ] **Step 1:** Replace the Google Fonts `<link>` with one loading Libre Baskerville (400/700 + italic 400), Fraunces (opsz, upright 400/500/600 + italic 400), Hanken Grotesk (400/500/600/700). Remove Montserrat.
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400&family=Hanken+Grotesk:wght@400;500;600;700&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  ```
- [ ] **Step 2:** `npm run build` → GREEN.
- [ ] **Step 3: Commit** `feat(client): load Atelier font families`

---

### Task 3: Material M3 theme + global canvas

**Files:**
- Modify: `client/src/app/ui/styles/_m3-theme.scss`
- Modify: `client/src/styles.scss`
- Create: `client/src/app/ui/styles/_motion.scss`

- [ ] **Step 1:** In `_m3-theme.scss`, keep the generated plum primary/tertiary palettes; ensure tertiary hue reads gold-adjacent (override tertiary key colors toward `#b08d57` if needed).
- [ ] **Step 2:** In `styles.scss`, extend `mat.define-theme(...)` with a `typography` config: `brand-family: 'Libre Baskerville'`, `plain-family: 'Hanken Grotesk'` (use `mat.define-typography` / M3 typography tokens appropriate to the installed Material version — verify the exact API against the installed `@angular/material` before writing).
- [ ] **Step 3:** In `styles.scss` global layer: set body `background:$rojin-canvas; color:$rojin-ink; font-family:$rojin-font-body;`; add paper grain `background-image:radial-gradient(rgba(58,14,60,.035) 1px,transparent 1px); background-size:4px 4px;`; custom thin scrollbar (gold-soft thumb); `::selection{background:rgba(74,21,75,.18);}`; a global `:focus-visible` gold ring.
- [ ] **Step 4:** Create `_motion.scss` with keyframes consumed later: `rojin-fade-rise`, `rojin-pop-in`, `rojin-hairline-draw`, `rojin-grain-shimmer`, `rojin-send-flight`; wrap all in `@media (prefers-reduced-motion: no-preference)` mixins so reduced-motion no-ops. `@use` it from `styles.scss`.
- [ ] **Step 5:** `npm run build` → GREEN. If MDC form-field/button regress, retarget MDC element/attribute selectors (lesson from Phase 2).
- [ ] **Step 6: Commit** `feat(client): Atelier M3 theme, global canvas + motion partial`

---

### Task 4: Sign-in & Sign-up

**Files:**
- Modify: `client/src/app/signin/signin.component.{html,scss}`
- Modify: `client/src/app/signup/signup.component.{html,scss}`

- [ ] **Step 1:** Restructure both templates into hero panel (plum, Libre Baskerville brand + Fraunces italic tagline + gold hairline) + paper form (serif heading, uppercase gold micro-labels, paper inputs, plum CTA, gold-underlined footer link to the other screen). Keep all `ngModel`, submit handlers, validation, and 401→`/signin` logic untouched.
- [ ] **Step 2:** SCSS for both consuming tokens; gold hairline uses `rojin-hairline-draw`; inputs get gold focus-ring bloom; staggered `rojin-fade-rise` on load.
- [ ] **Step 3:** `npm run build` → GREEN (watch `anyComponentStyle` budget).
- [ ] **Step 4: Commit** `feat(client): Atelier sign-in and sign-up screens`

---

### Task 5: Chat (centerpiece)

**Files:**
- Modify: `client/src/app/chat/chat.component.{html,scss}`

- [ ] **Step 1:** Restyle top-bar (plum, serif brand + italic tagline, pill actions), sidebar (paper New-conversation button, Fraunces uppercase section header, DM rows = avatar + serif name + preview line, gold inset active rule), conversation header (serif name + online pill), thread (Fraunces italic date separators with hairlines, paper+gold-hairline received bubbles, plum sent bubbles, grouped meta in ink-soft), composer (paper field + gold Send). Preserve ALL existing template logic: `@for` threads, grouping helpers (`isContinuation`/`isGroupEnd`/`shouldShowDaySeparator`), avatars, empty/skeleton states, `sendMessage`, keydown.
- [ ] **Step 2:** Add `rojin-pop-in` to message rows and `rojin-send-flight` trigger on send; restyle empty-thread + search-empty + skeleton shimmer to Atelier palette.
- [ ] **Step 3:** `npm run build` → GREEN. Raise `angular.json` `anyComponentStyle` budget only if chat SCSS legitimately exceeds 10kb.
- [ ] **Step 4: Commit** `feat(client): Atelier chat experience`

---

### Task 6: Profile

**Files:**
- Modify: `client/src/app/profile/profile.component.{html,scss}`

- [ ] **Step 1:** Editorial card matching auth: hero/header with avatar + serif name, gold-labelled editable fields (display name, bio, avatar URL), plum save button, paper surfaces. Preserve profile load/save logic + JWT header pattern.
- [ ] **Step 2:** `npm run build` → GREEN.
- [ ] **Step 3: Commit** `feat(client): Atelier profile screen`

---

### Task 7: Shared UI components

**Files:**
- Modify: `client/src/app/ui/brand-lockup/brand-lockup.component.{html,scss}`
- Modify: `client/src/app/ui/toolbar-shell/toolbar-shell.component.scss`
- Modify: `client/src/app/ui/avatar/avatar.component.{ts,scss}`

- [ ] **Step 1:** Brand lockup → Libre Baskerville + gold accent dot + optional Fraunces italic tagline. Toolbar shell → plum chrome, ivory text, keep safe-area padding.
- [ ] **Step 2:** Avatar → replace `AVATAR_COLORS` with muted jewel tones harmonizing on ivory+plum (e.g. `#6a2c6c,#8a6d3b,#7a3450,#3f5a3a,#5a3a6d,#9a6a3a,#4a5a7a,#7a4a2a`); keep hashing + initials + AA-readable white text.
- [ ] **Step 3:** `npm run build` → GREEN.
- [ ] **Step 4: Commit** `feat(client): Atelier brand lockup, toolbar, avatar palette`

---

### Task 8: Motion polish pass

**Files:**
- Modify: `client/src/styles.scss`, `client/src/app/ui/styles/_motion.scss`, and any per-screen SCSS needing wiring.

- [ ] **Step 1:** Verify the signature moments are wired: auth gold-hairline self-draw, faint paper-grain shimmer, expressive send animation; refined moments: staggered load fade-rise, 150ms hovers, message pop-in, focus bloom. Ensure every animation sits behind `prefers-reduced-motion: no-preference`.
- [ ] **Step 2:** `npm run build` → GREEN.
- [ ] **Step 3: Commit** `feat(client): refined + signature motion polish`

---

### Task 9: Accessibility + reduced-motion pass

**Files:**
- Modify: `client/src/app/ui/styles/_tokens.scss` (only if a contrast value fails)

- [ ] **Step 1:** Compute WCAG AA for: `$rojin-ink` on canvas + paper; `$rojin-text-meta` on canvas + paper; ivory on plum; online color on its soft bg. Use the Node relative-luminance method from Phase 2. Any small-text pair <4.5:1 → darken the token until ≥4.5:1.
- [ ] **Step 2:** Confirm gold is never used for small body text on light surfaces; confirm every interactive element has a visible focus state; confirm reduced-motion disables all keyframe animation.
- [ ] **Step 3:** `npm run build` → GREEN.
- [ ] **Step 4: Commit** `fix(client): WCAG AA contrast + reduced-motion pass`

---

## Final review (after Task 9)

Start both processes (`python main.py` in `backend/`, `npm run start` in `client/`) and present the full app to the user in the browser at `http://localhost:4200` — sign-in, sign-up, chat (with a live conversation), and profile — for explicit approval before any push/PR decision.

## Self-review notes

- **Spec coverage:** tokens(T1) ✓ fonts(T2) ✓ M3+global+motion partial(T3) ✓ auth(T4) ✓ chat(T5) ✓ profile(T6) ✓ ui/brand/toolbar/avatar(T7) ✓ motion(T8) ✓ a11y(T9) ✓ — all spec sections mapped.
- **Token-name consistency:** legacy names retained as aliases in T1 so T4–T7 consumers compile unchanged; new names (`$rojin-canvas/paper/gold/ink/ink-soft/line`, font + motion tokens) used consistently in later tasks.
- **No fabricated tests:** visual work verified by build-green + final browser review per the user's waiver.
