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
There is **no separate lint/test setup** for the backend.

### Frontend — `client/`
```powershell
cd client
npm install                         # first time only
npm run start                       # ng serve on :4200, proxy + --disable-host-check for LAN
npm run build                       # ng build
npm test                            # karma + jasmine (Chrome launcher)
```
Run a single spec by passing Karma a focused test (`fdescribe` / `fit` in the spec) — there is no test-name CLI flag wired up.

### Environment knobs (`backend/.env`)
`SECRET_KEY`, `JWT_SECRET_KEY`, `JWT_ACCESS_TOKEN_DAYS` (default 7; `0` disables expiry — dev only), `CORS_ORIGINS` (comma-separated allow-list; unset → `*`), `HOST`, `PORT`, `FLASK_DEBUG`.

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

### Auth on the client
- **No HTTP interceptor.** Every component reads `access_token` from `localStorage` and builds the `Authorization: Bearer …` header by hand (see `auth.service.ts`, `profile.service.ts`, `chat.component.ts`). New API calls must do the same or you'll get 401s.
- **No route guard.** `app-routing.module.ts` has open routes. Auth enforcement is reactive: on a 401/422 from any backend call, components call `router.navigate(['/signin'])`. Preserve this pattern when adding screens.
- The Socket.IO connection is established in `ChatComponent`'s constructor and torn down in `ngOnDestroy` — don't move it into a service without handling re-connects on route changes.

### Shared UI layer (`client/src/app/ui/`)
- `UiModule` exports `ToolbarShellComponent` (the app-bar chrome with safe-area top padding) and `BrandLockupComponent` (brand title + tagline).
- `ui/styles/_tokens.scss` is the **single source of truth** for brand colors, breakpoints, toolbar/sidebar sizing, and viewport mixins. Feature SCSS and `client/src/styles.scss` `@use` it — never hard-code hex values or breakpoint widths in feature components.
- Mobile/notch handling uses `100dvh` / `-webkit-fill-available` and `env(safe-area-inset-*)`. `index.html` sets `viewport-fit=cover` for this to take effect.

### Angular version
`@angular/*` is on stable **21.2.x** (upgraded from a 13.0.0 prerelease via stepwise `ng update`). Material uses the **MDC** components with **M3** token theming — `mat.define-theme` in `client/src/styles.scss`, with the brand palette in `client/src/app/ui/styles/_m3-theme.scss` (generated from the seed `#4a154b`). The app still uses **NgModules** (no standalone migration) and the webpack `@angular-devkit/build-angular:browser` builder (esbuild/`application` builder intentionally not adopted). Upgrade one major at a time via `ng update`.

Known follow-ups left from the upgrade: the unit test suite is pre-existing broken (unmaintained scaffold specs missing test providers); component SCSS still uses Sass `@import` (Dart Sass deprecates it in favor of `@use`); and the M3 theme is color-only (no amber accent / typography / density yet) — all slated for the visual-refresh phase.

## Where to read next

`README.md` is setup-focused. The deeper architecture lives in `docs/`:
- `docs/system-design.md` — current architecture diagram, sequence diagrams, full HTTP + Socket.IO event tables, "what happens when…" walkthroughs.
- `docs/security.md` — threat models, current posture, hardening checklists for dev / LAN / production. Read before touching auth, CORS, or Socket.IO handshake code.
- `docs/evolution.md` — roadmap (group chat, per-conversation rooms, internal HTTPS). Useful to know what is intentionally **not** built yet.
- `docs/glossary.md` — JWT/CORS/SPA/Socket.IO definitions.
- `deployment/home-deployment.md` — Windows firewall rules, LAN binding (`0.0.0.0`), how to stop the processes cleanly.
