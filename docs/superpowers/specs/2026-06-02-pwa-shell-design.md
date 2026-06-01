# PWA Shell — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-02)
**Phase:** Phase 5, Sub-project 3a of the Notifications+PWA arc (PWA shell → HTTPS → Web Push)
**Branch target:** new branch off `main`

---

## Goal

Turn the Rojin SPA into an installable Progressive Web App: a web app manifest, a service worker that caches the app shell for instant/offline loads, and a branded home-screen icon — so it installs and launches fullscreen like a native app. (Web Push notifications are the next sub-project and reuse this service worker.)

## Decisions (from brainstorming)

- **Scope:** PWA shell only. Web Push is a separate, later sub-project.
- **Icon:** option **C — chat bubble**: a gold speech bubble with an aubergine "R", on charcoal.
- **Theme/splash color:** charcoal **`#241121`** (matches the app chrome).
- **Install UX:** **native browser install UI only** — no custom in-app install button/banner.
- **Phone install deferred:** service workers need a secure context (HTTPS or `localhost`). The PWA is built and verified on desktop `localhost` now; **phone install over LAN waits for the HTTPS step** (the immediate follow-on, also a prerequisite for Web Push).

## Non-goals / YAGNI

- No custom install prompt / `beforeinstallprompt` handling.
- No Web Push / notifications (next sub-project).
- No HTTPS/LAN-TLS setup in this spec (separate follow-on).
- No caching of `/api` or `/socket.io` responses (auth'd + live).
- No offline message queue / background sync.

---

## 1. Tooling — `@angular/pwa`

Run `ng add @angular/pwa` in `client/`. It:
- adds `@angular/service-worker` to `package.json`,
- creates `src/manifest.webmanifest` + default icons under `src/assets/icons/` (we replace these),
- sets `"serviceWorker": true` + `"ngswConfigPath": "ngsw-config.json"` on the production build target in `angular.json`,
- adds `src/manifest.webmanifest` to assets,
- registers the SW (`ServiceWorkerModule.register('ngsw-worker.js', { enabled: !isDevMode() })`) in `app.module.ts`.

Works with the existing webpack `@angular-devkit/build-angular:browser` builder. The SW only activates in production builds.

## 2. Manifest (`src/manifest.webmanifest`)

```json
{
  "name": "Rojin",
  "short_name": "Rojin",
  "description": "Conversations worth keeping.",
  "theme_color": "#241121",
  "background_color": "#241121",
  "display": "standalone",
  "scope": "/",
  "start_url": "/",
  "icons": [
    { "src": "assets/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "assets/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "assets/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

## 3. Icon assets

Author the chat-bubble icon **once as an SVG** (`src/assets/icons/icon.svg`): charcoal `#241121` background (full-bleed), a gold `#b08d57` rounded speech bubble, an aubergine `#3a0e3c`/charcoal Libre-Baskerville-style "R" centered in the bubble. Rasterize to PNGs with a small one-off Node script using **`sharp`** (added as a client devDependency):
- `icon-192.png` (192×192), `icon-512.png` (512×512) — bubble fills ~70% (normal icon).
- `icon-maskable-512.png` (512×512) — bubble scaled into the **safe zone** (~60% centered) so Android adaptive masks don't clip it.
- `apple-touch-icon.png` (180×180) — for iOS home screen.

Output to `src/assets/icons/`, replacing the `ng add` defaults. The rasterizer script lives at `client/scripts/build-icons.mjs` and is run manually when the icon changes (output PNGs are committed).

## 4. Service worker config (`ngsw-config.json`)

```json
{
  "$schema": "./node_modules/@angular/service-worker/config/schema.json",
  "index": "/index.html",
  "assetGroups": [
    {
      "name": "app",
      "installMode": "prefetch",
      "resources": { "files": ["/favicon.ico", "/index.html", "/manifest.webmanifest", "/*.css", "/*.js"] }
    },
    {
      "name": "assets",
      "installMode": "lazy",
      "updateMode": "prefetch",
      "resources": { "files": ["/assets/**", "/media/**"] }
    }
  ]
}
```

No `dataGroups` — `/api/*` and `/socket.io/*` are never cached and always hit the network. (ngsw only intercepts navigation + the configured asset files; API/socket requests pass through.)

## 5. `index.html`

Add inside `<head>`:
```html
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#241121">
<link rel="apple-touch-icon" href="assets/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Rojin">
```

## 6. Verification

ngsw is inactive under `ng serve`. Verify via a **production build served on localhost**:
- `npm run build` → `cd dist/<project> && npx http-server -p 8080` (or any static server).
- In Chrome on `http://localhost:8080`: DevTools → Application → **Manifest** shows Rojin + the icon and "installable"; **Service Workers** shows `ngsw-worker.js` activated; toggling offline still loads the app shell.
- Confirm `/api` calls are NOT served from cache (Network tab).

## Files touched

- **Create:** `client/src/manifest.webmanifest`, `client/ngsw-config.json`, `client/src/assets/icons/icon.svg`, `client/src/assets/icons/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png`, `client/scripts/build-icons.mjs`
- **Modify:** `client/angular.json` (serviceWorker + ngswConfigPath + manifest asset), `client/package.json` (+ `@angular/service-worker`, dev `sharp`), `client/src/app/app.module.ts` (register SW), `client/src/index.html` (manifest + meta tags)
- **Modify:** `CLAUDE.md` (note PWA: prod-build-only SW, localhost-secure-context caveat), `docs/evolution.md` (mark PWA shell done; note HTTPS unblocks phone install + push)

## Error handling / edge cases

- SW disabled in dev (`enabled: !isDevMode()`) so `ng serve` is unaffected.
- Secure-context requirement: works on `localhost` (desktop) now; phone needs HTTPS (deferred, documented).
- API/socket never cached → no stale-auth or stale-message bugs.
- `@angular/service-worker` version must match the installed Angular (21.x) — `ng add` handles this.

## Risks / watch-items

- **`ng add @angular/pwa`** may modify `angular.json`/`app.module.ts` in ways needing review (e.g., it edits the default build target — confirm it lands on the right configuration). Review its diff carefully.
- **SVG→PNG rasterization:** `sharp` install must succeed on Windows (prebuilt binaries) — if it fails, fall back to ImageMagick `magick` or an online export, but the committed PNGs are what matter.
- **Maskable safe zone:** if the bubble is too large, Android masks clip it — keep it ~60% centered.
- ngsw caching during active development can serve stale bundles; only an issue for prod-served testing — hard-refresh / "Update on reload" in DevTools.
