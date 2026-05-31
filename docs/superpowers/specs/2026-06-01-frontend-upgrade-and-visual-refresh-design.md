# Frontend: Angular 13→21 upgrade + visual refresh ("Refined Material+")

**Date:** 2026-06-01
**Status:** Approved (design); pending implementation plan
**Scope:** Two sequenced phases on the `client/` Angular app.
1. **Phase 1 — Upgrade** Angular 13 → latest stable (21.2.x), stepwise.
2. **Phase 2 — Visual refresh** of all four screens (chat, sign-in, sign-up, profile) on the upgraded stack.

Backend (`backend/`) is **out of scope** — no API, schema, or Socket.IO changes.

---

## Why this order

The visual refresh must be built on the upgraded Material, not the old one. **Material 15 rewrote its components on MDC** (DOM structure and CSS class names change), and the **theming API later moved to the M3 token system**. Doing the refresh first would mean re-doing it after the upgrade. So: upgrade first, refresh second.

## Environment (verified 2026-06-01)

- Node **v24.12.0**, npm **11.7.0** — modern enough for Angular 21; toolchain is not a blocker.
- Installed: `@angular/core` **13.0.3**, `@angular/cli` **13.0.4**, `@angular/material` **13.3.9**, `typescript` **4.4.4**.
- `package.json` pins `@angular/*` to the prerelease tag `~13.0.0-next.0` — this gets un-pinned to real stable ranges during the upgrade.
- Target (npm `latest` today): `@angular/core` **21.2.15**, `@angular/cli`/`@angular/material` **21.2.13**.

## Constraints & non-goals

- **Keep Angular Material** as the component library (no swap to Tailwind/PrimeNG/etc.).
- **Keep the NgModule structure.** Migrating to standalone components/`provideRouter` is *optional* and explicitly **out of scope** for this work — limits blast radius. (Standalone is available in 21 but not required.)
- **No dark mode**, no new chat features. Phase 2 additions (avatars, message grouping, date separators) are presentation-only, derived from data existing endpoints already return.
- **No backend changes.**
- **Verification:** per `CLAUDE.md`, the user verifies in their own browser at `http://localhost:4200` before any commit touching runtime behavior. No Playwright/headless self-verification.

---

# Phase 1 — Angular 13 → 21 upgrade

## Approach: one major at a time, on a dedicated branch

Angular's `ng update` only supports a single major jump at a time and runs migration schematics per step. The chain is:

**13 → 14 → 15 → 16 → 17 → 18 → 19 → 20 → 21** (8 steps).

For each step `N → N+1`:

```powershell
cd client
ng update @angular/core@<N+1> @angular/cli@<N+1>
ng update @angular/cdk@<N+1> @angular/material@<N+1>
# review/commit schematic changes, then verify (below)
```

- Work on a dedicated branch (e.g. `chore/angular-21`) off `deploy`.
- **Commit after each successful major step** (`build` + `start` + browser smoke pass), so any breakage is bisectable and revert is one major, not eight. Each such commit touches runtime config/deps → falls under the browser-verification rule, so the user smoke-tests at each checkpoint before that commit.
- The Angular Update Guide (update.angular.io) is the per-step reference for breaking changes.

## Known hotspots (in chain order)

| Step | What to expect / handle |
|------|--------------------------|
| **Un-pin prerelease** | Before/at step 1, change `package.json` `~13.0.0-next.0` → `^13.x` stable so `ng update` has a clean base. |
| **14** | Typed Reactive Forms migration (the sign-in/sign-up/profile `FormGroup`s). Strict-typed forms schematic runs; verify form types still compile. `@angular/cdk`/`material` 14. |
| **15 (biggest)** | **Material MDC rewrite.** Components re-implemented; the schematic can leave you on `mat.legacy-*` imports as a bridge. Class names/DOM change → custom CSS targeting `.mat-*` internals (e.g. `.mat-list-item`, `.mat-list-item-content` in `chat.component.scss`) will break and need re-targeting. SCSS `@import` of Material begins deprecating in favor of `@use`. |
| **16** | Node/TS bumps; `ng update` handles most. Remove leftover `legacy-` Material usages where feasible. |
| **17** | **New build system** (esbuild/Vite) becomes default via `application` builder; `angular.json` builder targets change. Verify `npm run build` and the dev `start` (proxy + `--disable-host-check`, `--host 0.0.0.0`) still work — proxy config and flags must survive. New control flow (`@if/@for`) is available but **not required** (keep `*ngIf/*ngFor`). |
| **18** | Material theming API renames: old `mat.define-palette` / `mat.define-light-theme` / `mat.all-component-themes` become `m2-`-prefixed (`mat.m2-define-palette`, …) and the **M3** `mat.define-theme` / `mat.theme` system is introduced. `styles.scss` `$md-rojin` palette + theme need updating (see below). |
| **19 → 21** | Mostly mechanical (`ng update` migrations, TS/zone.js bumps). zone.js bump; confirm `polyfills` config. Confirm `socket.io-client` and CDK still compatible (they are framework-agnostic / tracked with Material). |

## Material theming decision (resolved at step 15–18)

`client/src/styles.scss` builds a custom `$md-rojin` palette via `mat.define-palette` and `mat.define-light-theme`, then `mat.all-component-themes`. On Angular 21 these are the deprecated/renamed M2 functions.

**Decision:** migrate to the **M3 token theming** (`mat.define-theme` + `mat.theme`) during the upgrade, because Phase 2 is reworking the visual language anyway — so we land directly on the modern system rather than via the `m2-` shims. The Rojin purple is expressed as an M3 palette (custom or generated from the brand hue `#4a154b`). Buttons/lists/inputs re-themed against the new tokens. This is the single largest hand-edit of the upgrade.

## Tests

- `npm test` (Karma + Jasmine, Chrome). The MDC migration (15) commonly breaks component specs that query old Material DOM. Update the `.spec.ts` selectors as needed so `npm test` passes on 21. Test tooling itself is bumped by `ng update`.

## Phase 1 done when

- `npm run build` succeeds on Angular 21; `npm run start` serves with the existing proxy + host flags intact.
- `npm test` passes.
- User browser smoke test passes: sign in, see DM list, open a thread, send/receive a live message (two accounts), edit profile, sign out — **no behavioral regression**.
- No `legacy-*` Material imports remain; theming is on M3.

---

# Phase 2 — Visual refresh ("Refined Material+")

Chosen direction **A — Refined Material+** (evolutionary; keeps the layout bones, raises the finish). User requirement: **all text visible — WCAG AA contrast is a hard rule**, no faint low-opacity text anywhere.

> Note: built against Angular 21 Material (MDC). Where Phase 2 styles target Material internals, use the MDC class names / theming tokens, not the old `.mat-*` ones.

## 2.1 Foundations — `client/src/app/ui/styles/_tokens.scss`

Add the structure the token file lacks (currently colors + a few sizing vars):

- **Type scale** (`display / title / body / meta / label` with size+weight+line-height).
- **Spacing scale** (`4 / 8 / 12 / 16 / 24`) to replace ad-hoc margins.
- **Radius scale** for bubbles, cards, inputs, buttons.
- **Elevation** shadow tokens (generalize the existing bubble shadows).

**Contrast (hard rule):** audit every text token against its background for WCAG AA (4.5:1 body, 3:1 large). Concrete fixes:
- Bubble metadata/timestamps (`opacity:.55`) → solid token meeting AA on both elevated (received) and purple (sent) bubbles.
- Sidebar "Direct Messages" label and `(You)` suffix → readable on purple.
- Search hints (`__hint`) and `$rojin-text-meta`/`$rojin-text-muted` → bumped until AA-passing.

**Typography:** one typeface system — **remove `Victor Mono`** from the DM list; Montserrat for brand/headings, clean system-sans for body. **Verify Montserrat is actually loaded** in `index.html`/`styles.scss` (tokens reference it but it may be silently falling back); add the font link if missing.

## 2.2 Chat screen — `client/src/app/chat/`

- **Avatars:** circular, **initials with a deterministic per-username color**; render the image when `avatar_url` is set, else initials. In the **DM sidebar list** and **conversation header** only — not on each bubble.
- **Message grouping:** consecutive same-sender messages collapse; show `name · time` meta **once per group**.
- **Date separators:** Today / Yesterday / date dividers in the thread.
- **Timestamps:** `9:42 AM` within the day (date otherwise) instead of full `toLocaleString()`. Requires preserving the **raw ISO timestamp** per message (the socket `receive_message` path in `chat.component.ts` currently formats to a locale string eagerly — keep raw, format in template).
- **Presence:** accessible green online dot in sidebar rows + header (with label), complementing existing text.
- **Empty / loading states:** styled empty-thread and contacts-loading treatments replacing bare text.

## 2.3 Auth & profile — `signin/`, `signup/`, `profile/`

Re-skin to match: Rojin brand lockup, consistent card/field styling on the (now M3) purple theme, AA contrast, responsive. Profile gets a **live avatar preview** (initials or entered `avatar_url`).

## 2.4 Cleanup folded in

In files being touched only: remove dead commented-out CSS in `chat.component.scss`; pull inline styles (`style="margin:10px"`) from templates; cut scattered `!important` made unnecessary by the token refactor. No unrelated refactoring.

---

## Affected files (anticipated)

| Area | Files |
|------|-------|
| Deps / builders / config | `client/package.json`, `client/angular.json`, `client/tsconfig*.json`, polyfills |
| Theme (M3 migration) | `client/src/styles.scss` |
| Tokens / type / spacing / contrast | `client/src/app/ui/styles/_tokens.scss` |
| Font load | `client/src/index.html` |
| Chat screen | `client/src/app/chat/chat.component.{html,scss,ts}` |
| Avatar helper | new small shared component/util under `client/src/app/ui/` + `ui.module.ts` |
| Auth / profile | `client/src/app/signin/`, `signup/`, `profile/` |
| Specs (MDC selector fixes) | affected `*.spec.ts` |
| Docs | update `CLAUDE.md` "Angular version pinning" note; `README.md` Node/Angular prereqs |

## Risks & rollback

- **MDC migration (15)** is the highest-risk step — custom CSS hooking Material internals will break and need re-targeting. Per-step commits make rollback one major.
- **Build-system switch (17)** can disturb the dev proxy / LAN host flags — verify `start` explicitly at that step.
- **Theming rework (18)** is hand-done; budget time and verify every Material control's color in-browser.
- Rollback unit = one major step (branch + per-step commits). Worst case, abandon the branch; `deploy` is untouched.

## Success criteria

1. App runs on **Angular 21** (`build`, `start`, `test` all green) with the dev proxy + LAN flags intact and no behavioral regression (user-verified in browser).
2. All four screens reflect direction A and feel like one product.
3. **No text fails WCAG AA** on any screen (the explicit requirement), confirmed visually.
4. Avatars in DM list + header; grouped bubbles with per-group meta + date separators; friendly timestamps.
5. Single typeface system; no `Victor Mono`; Montserrat confirmed loaded.
6. No dead commented CSS / inline styles left in touched files; theming on Material M3; no `legacy-*` Material imports.
