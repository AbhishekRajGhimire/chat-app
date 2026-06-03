# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow rules

**Manual browser verification before commit.** Before creating any main commits that touches runtime behavior (backend routes, Socket.IO handlers, Angular components, templates, styles, or anything user-visible), the agent **must**:

1. Make sure both processes are running (`python main.py` in `backend/`, `npm run start` in `client/`) — start them if they're not.
2. Tell the user exactly what to click / type / navigate to in their browser at `http://localhost:4200` in order to exercise the change, including any edge cases or regressions worth checking.
3. **Wait for the user's explicit approval** before staging or committing.

Do **not** use Playwright, headless browsers, or any automated UI tool to self-verify in place of this step. The user wants to see the change in their own browser. Type-checks and tests are not a substitute — they verify correctness, not the feature.

For pure non-runtime edits (docs, comments, `.gitignore`, README), this rule does not apply.

## Stack at a glance

Real-time chat: **Angular 21 SPA** (`client/`) talking to a **Flask + Flask-SocketIO** backend (`backend/`) over **SQLite**. Dev runs as two processes; the Angular dev server proxies `/api` and `/socket.io` to Flask on the same host.

## Commands

The host environment is **Windows + PowerShell**. Use PowerShell syntax (`$env:VAR`, `.\.venv\Scripts\Activate.ps1`).

### Backend — `backend/`
```powershell
cd backend
python -m venv .venv                # first time only
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env              # then edit secrets
python main.py                      # serves on http://0.0.0.0:3000
```
**Backend tests** (pytest):
```powershell
pip install -r requirements-dev.txt   # first time only
pytest -q
```
Tests run against a throwaway DB via the `CHAT_DB_PATH` env var (set in `tests/conftest.py`), so they never touch `chat.db`. They cover auth, DM, group endpoints + membership, the conversation/room helpers, and a skippable Socket.IO smoke test.

### Frontend — `client/`
```powershell
cd client
npm install                         # first time only
npm run start                       # ng serve on :4200, proxy + --disable-host-check for LAN
npm run build                       # ng build
npm test                            # karma + jasmine (Chrome launcher)
```
Run a single spec by passing Karma a focused test (`fdescribe` / `fit` in the spec) — there is no test-name CLI flag wired up. The karma scaffold specs are pre-existing-broken and are **not** wired into CI.

### CI (`.github/workflows/ci.yml`)
On every push and PR, two parallel jobs must pass: **backend** (`pytest -q`) and **frontend** (`npm ci && npm run build`). The frontend gate is the production build (type/template check), not `npm test`.

### PWA
The client is an installable PWA via **`@angular/pwa`** (ngsw). The **service worker only runs in production builds** (`npm run build`), never under `ng serve`. It also needs a **secure context** — works on `localhost`; **LAN phone install requires HTTPS** (roadmap). The web app manifest + icons live in **`client/public/`** (wired into `angular.json` assets); the chat-bubble icon is authored as `public/icons/icon.svg` and rasterized to PNGs with **`node scripts/build-icons.mjs`** (needs the `sharp` dev dep). `ngsw-config.json` prefetches the app shell and lazy-caches images/fonts; **`/api` and `/socket.io` are never cached**. To test: `npm run build` then serve `dist/client` over `localhost`.

### LAN HTTPS harness (optional, for phone/PWA testing)
`deployment/serve-https.ps1` builds the client and runs **Caddy + mkcert** to serve the **production** PWA at **`https://Avi.local`**, proxying `/api` + `/socket.io` to Flask — this is what lets the service worker register and the app install on a phone (a SW needs a *trusted* secure context). It's **separate from `ng serve`** and fully reversible; first run needs an **Administrator** shell (mkcert CA install + 443 firewall rule). mkcert certs live in `deployment/certs/` (gitignored). Full guide: `deployment/https-tls.md`.

### Web Push notifications
Opt-in push (toggle in **Profile**) via VAPID + `pywebpush`. Backend: `chat/push.py` (`/api/push/vapid-key|subscribe|unsubscribe` + `send_push_to_user`, hooked into DM + group message sends), a `PushSubscription` table, and `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env (push disabled if unset). Client: a **custom service worker** `public/sw-custom.js` (registered instead of `ngsw-worker.js`) that `importScripts('ngsw-worker.js')` and adds focus-aware push display + click-to-open. Payloads omit a top-level `notification` key so ngsw doesn't double-show. **Only testable on a device via the HTTPS harness** (push needs a secure context; iOS needs the PWA installed).

### Environment knobs (`backend/.env`)
`SECRET_KEY`, `JWT_SECRET_KEY`, `JWT_ACCESS_TOKEN_DAYS` (default 7; `0` disables expiry — dev only), `CORS_ORIGINS` (comma-separated allow-list; unset → `*`), `HOST`, `PORT`, `FLASK_DEBUG`, and `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (Web Push; push disabled if unset).

**Secrets are fail-fast.** `FLASK_DEBUG` defaults to **false**. When debug is off, `chat/__init__.py` **refuses to start** unless both `SECRET_KEY` and `JWT_SECRET_KEY` are set — the committed dev fallbacks apply only when `FLASK_DEBUG=true`. So a real/LAN run can't silently sign JWTs with a repo-known secret, and the dev "just run it" path still works once you set `FLASK_DEBUG=true` locally. Rotating `JWT_SECRET_KEY` invalidates all live tokens (one re-login per user; `chat.db` data is untouched).

## Architecture

### Two-process dev with a proxy
`client/src/proxy.conf.json` forwards `/api/*` and `/socket.io/*` (WebSocket upgrade enabled) to `http://localhost:3000`. The SPA itself never knows the backend's URL — always call relative paths. Production is expected to serve the built SPA and the API under one origin.

### Conversation-centric SQLite (`backend/chat/database.py`)
Schema is **conversation-first**, not pairwise: `Conversation` (with `type IN ('direct','group')`), `ConversationMember`, `Message(conversation_id, sender_user_id, body, …)`. Direct conversations use normalized `(dm_user_low_id, dm_user_high_id)` columns with a partial unique index — always sort the pair via `conversations.normalized_pair()` before insert/lookup. A `UserProfile` row backs every `User` (auto-created at signup and backfilled on startup).

**Legacy migration**: on startup, if a pre-existing `Message` table is detected with the old pairwise shape (has `recipient_id`, no `conversation_id`), `database.py` **drops and recreates** the conversation tables. There is **no data backfill** — this is a dev convenience, not a production migration path.

**One shared SQLite connection** is opened with `check_same_thread=False` and reused across Flask and Socket.IO handlers. Don't introduce per-request connections without changing this module — and don't assume safety under heavy concurrency.

### Realtime delivery (`backend/chat/chatfunc.py`)
- The Socket.IO `connect` handler **rejects unauthenticated sockets**. The client sends the JWT as the Engine.IO query param `?token=…` (fallback: `Authorization: Bearer`). The server decodes it with `flask_jwt_extended.decode_token`, takes `sub` as the username, calls `join_room(username)`, and records `request.sid → username` in `socket_user_by_sid`.
- **Sender identity is taken only from the socket session.** `send_message` ignores any `from` field in the payload. When changing this handler, never trust client-supplied user identity.
- Delivery rooms are **keyed by username** (not user id or conversation id). Group chat would require moving to per-conversation rooms — see `docs/evolution.md`.
- `online_users` is an in-process list of `(username, sid_or_empty)` (defined in `chat/__init__.py`). It is **not shared across workers**, so the app is implicitly single-process. Don't add gunicorn workers without replacing this.

### Send-message dual-write (`client/src/app/chat/chat.component.ts` — `sendMessage`)
The client both **emits over the socket** (for live delivery to the peer's room) and **POSTs to `/api/dm/messages`** (for persistence). The optimistic UI append happens before either completes; on HTTP error the last appended message is rolled back. If you change the wire format, change both paths together.

If the peer is offline, the socket emit reaches an empty room — only the HTTP POST persists the message. The peer sees it the next time they call `GET /api/dm/messages/<other>`.

### Message-level actions (`backend/chat/messages.py`, `chat.component.ts`)
Reactions, reply, and edit/delete all key on a **`client_message_id`** — a UUID the client generates and sends in **both** the socket emit and the persistence POST (`sendMessage`/`postMessage`). The server stores it, the socket relay passes it straight through on `receive_message`, and `database.py` **backfills** it for pre-existing rows at startup. There is no other stable client-visible id; don't reintroduce one.
- **Schema:** `MessageReaction(client_message_id, user_id, emoji)` + `Message.reply_to / edited_at / deleted_at` (all added idempotently). `conversations.serialize_messages(cid, me_id)` is the **single shared payload shape** for DM + group history (id, reactions `[{emoji,count,mine}]`, reply_to, reply_preview, edited_at, deleted); use it rather than re-querying messages.
- **Endpoints** (all resolve conversation/ownership from the message row — the caller never supplies a conversation id): `POST /api/messages/<id>/react` (toggle), `PATCH /api/messages/<id>` (owner-only edit), `DELETE /api/messages/<id>` (owner-only soft delete).
- **Live sync:** `reaction_updated` / `message_edited` / `message_deleted` broadcast to the per-conversation room `conv:<id>` (both DM participants and group members join it on connect). The client locates the target by scanning all loaded threads for the globally-unique id (`findMessage`) — no conversation_id→key map needed. Reaction `mine` flags are preserved locally on broadcast (only your own toggle changes your `mine`), so the room payload's `mine` is ignored by other clients. Same brand-new-conversation caveat as DM delivery: live action events may wait for a reload, history is always correct.
- **UI affordance:** the bubble + a side-gutter ⋯ are wrapped in a `.message-cluster` so hover/tap only triggers over the message (not the full-width row); the quick-react bar floats above, the ⋯ menu varies by ownership (Reply vs Reply/Edit/Delete).

### Auth on the client
- **No HTTP interceptor.** Every component reads `access_token` from `localStorage` and builds the `Authorization: Bearer …` header by hand (see `auth.service.ts`, `profile.service.ts`, `chat.component.ts`). New API calls must do the same or you'll get 401s.
- **No route guard.** `app-routing.module.ts` has open routes. Auth enforcement is reactive: on a 401/422 from any backend call, components call `router.navigate(['/signin'])`. Preserve this pattern when adding screens.
- The Socket.IO connection is established in `ChatComponent`'s constructor and torn down in `ngOnDestroy` — don't move it into a service without handling re-connects on route changes.

### Shared UI layer (`client/src/app/ui/`)
- `UiModule` exports `ToolbarShellComponent` (the app-bar chrome with safe-area top padding) and `BrandLockupComponent` (brand title + tagline).
- `ui/styles/_tokens.scss` is the **single source of truth** for brand colors, breakpoints, toolbar/sidebar sizing, and viewport mixins. Feature SCSS and `client/src/styles.scss` `@use` it — never hard-code hex values or breakpoint widths in feature components.
- Mobile/notch handling uses `100dvh` / `-webkit-fill-available` and `env(safe-area-inset-*)`. `index.html` sets `viewport-fit=cover` for this to take effect.

### Client layering (core/ → shells)
- **`ChatApi`** (`core/chat-api.service.ts`) + **`RealtimeClient`** (`core/realtime-client.service.ts`) in `client/src/app/core/` own ALL backend I/O (REST and Socket.IO respectively). **`ChatStore`** (`core/chat-store.service.ts`, Angular signals) owns all state, business rules, and the **single app-lifetime socket** — socket-stream handlers are wrapped in `NgZone.run()` so signal writes trigger change detection. Components are **pure views**: no `HttpClient` or `socket.io-client` in components.
- Desktop chat is the route `/chat`; phones load the **lazy `ChatMobileModule`** at `/m` (child routes: `/m/chats`, `/m/calls`, `/m/people`, `/m/c/:key`). The root `''` route redirects by viewport via `ShellRedirectComponent` (`matchMedia('(max-width:768px)')`). Auth stays reactive (401/422 → `/signin`); no route guards.
- **`<app-message-thread>`** (`SharedChatModule`) is the shared message renderer used by both desktop and mobile — change message UI there, once. It reads from `ChatStore` signals.
- Mobile shell = bottom tab bar (**Chats / Calls / People**) + full-screen thread pushed on conversation open; Profile is a pushed screen reached from the top-bar avatar. Touch gestures (swipe-back, swipe-to-reply, pull-to-refresh, long-press) live in `client/src/app/mobile/gestures/` (`GesturesModule`).
- The backend REST + Socket.IO API is the **stable contract** — a future native app would re-implement only the transport layer (`ChatApi` + `RealtimeClient`) against the same endpoints and events.

### Avatars
- Photos are **cropped and exported client-side** (512×512 JPEG) by `AvatarCropperComponent` (in `UiModule`) using `createImageBitmap` for EXIF-aware orientation, then uploaded via `POST /api/me/avatar` (multipart). Bytes are stored through **`chat/storage.py`** (`UserProfile.avatar_key` + `avatar_mime`); swap that module for S3/MinIO without touching any other code.
- Avatars are **org-public**: `GET /api/avatars/<username>?token=<jwt>` accepts the JWT in the query string (same pattern as attachments and Socket.IO), requires any valid member token, and serves the image `inline` + `X-Content-Type-Options: nosniff`. 401 if the token is bad, 404 if no avatar is set.
- The `avatar_url` field is **computed and cache-busted** (`/api/avatars/<username>?v=<key[:8]>`) on every read — never stored. It is propagated through all person feeds: `chats_history`, `directory_users`, group members, and `serialize_messages` (`sender_avatar_url` per message).
- On the client, `AvatarComponent` renders any `imageUrl` binding; the pure helper **`avatarSrc(path)`** appends the viewer's JWT token to the path. Both are wired across the sidebar, conversation header, group thread sender headers, People directory, member panel, and profile screens.
- **Group photos reuse the same machinery** but are keyed on `Conversation.avatar_key` / `avatar_mime` (via `chat/storage.py`). The serve route `GET /api/groups/<id>/avatar?token=<jwt>` is **members-only** (`is_member` check, not org-public) — 403 for non-members, unlike user avatars which any authenticated member may view.

### Angular version
`@angular/*` is on stable **21.2.x** (upgraded from a 13.0.0 prerelease via stepwise `ng update`). Material uses the **MDC** components with **M3** token theming — `mat.define-theme` in `client/src/styles.scss`, with the brand palette in `client/src/app/ui/styles/_m3-theme.scss` (generated from the seed `#4a154b`). The app still uses **NgModules** (no standalone migration) and the webpack `@angular-devkit/build-angular:browser` builder (esbuild/`application` builder intentionally not adopted). Upgrade one major at a time via `ng update`.

Known follow-ups left from the upgrade: the unit test suite is pre-existing broken (unmaintained scaffold specs missing test providers); component SCSS still uses Sass `@import` (Dart Sass deprecates it in favor of `@use`); and the M3 theme is color-only (no amber accent / typography / density yet) — all slated for the visual-refresh phase.

### File attachments
- **Upload-first, keyed on `client_message_id`.** `POST /api/attachments` (multipart, ≤ 25 MB, JWT) uploads bytes and returns `{ id, filename, mime, size, kind }`. The normal send POST + socket payload carry `attachment_ids`; the backend links them to the `Message` row by `client_message_id` at send time.
- **`chat/storage.py` is the only code that touches file bytes.** All read/write goes through this module — swap it for an S3/MinIO implementation in production without touching any other backend or client code.
- **Token-in-URL serve, membership-checked.** `GET /api/attachments/<id>?token=<jwt>` decodes the JWT from the query string (same pattern as the Socket.IO `?token=` handshake), verifies the caller is a conversation member, and serves bytes. Images are served `inline`; all other files use `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` as an XSS guard. Files belonging to a deleted message return 404.
- **`MessageAttachment` table + `serialize_messages`.** Schema: `client_message_id`, `conversation_id`, `uploader_user_id`, `storage_key`, `filename`, `mime`, `size`, `kind`, `created_at`. `conversations.serialize_messages` includes an `attachments` array on every message, used for both REST history and live socket events — consistent payload in both paths.
- **Pending-tray upload state lives in `ChatStore`.** `addFiles` / `removePending` / `retryPending` manage per-file progress and retry. The shared `<app-attachment-tray>` component + 📎 button is mounted on both the desktop and mobile composers; `<app-message-thread>` renders the image grid + lightbox + file chips.

## Where to read next

`README.md` is setup-focused. The deeper architecture lives in `docs/`:
- `docs/system-design.md` — current architecture diagram, sequence diagrams, full HTTP + Socket.IO event tables, "what happens when…" walkthroughs.
- `docs/security.md` — threat models, current posture, hardening checklists for dev / LAN / production. Read before touching auth, CORS, or Socket.IO handshake code.
- `docs/evolution.md` — roadmap (group chat, per-conversation rooms, internal HTTPS). Useful to know what is intentionally **not** built yet.
- `docs/glossary.md` — JWT/CORS/SPA/Socket.IO definitions.
- `deployment/home-deployment.md` — Windows firewall rules, LAN binding (`0.0.0.0`), how to stop the processes cleanly.
