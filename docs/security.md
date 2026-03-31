# Security notes — Rojin (org chat)

This document describes **what the project does today** for security, **gaps** to be aware of, and **recommended hardening** for **local development**, **organization / LAN** use, and **production** (internet-facing).

It is not a formal audit. Treat it as a living checklist when you change the stack or deploy.

---

## Threat models (short)

| Context | Who might attack | Typical goals |
|--------|-------------------|---------------|
| **Dev on one PC** | Mostly mistakes, rarely others | Accidental data loss, wrong config |
| **Org / office LAN** | Curious or malicious insiders, compromised laptops | Read chats, impersonate users, disrupt service |
| **Production (internet)** | Bots, opportunistic attackers, targeted abuse | Account takeover, data theft, spam, DoS |

Controls that are “enough” on localhost are often **not** enough on the internet.

---

## Current behavior (as implemented)

### What works well

- **Password storage**: Passwords are hashed with **bcrypt** before insert (`backend/chat/user.py`). Plain-text passwords are not stored in SQLite.
- **SQL injection (parameterized queries)**: User and message routes use **`?` placeholders** with SQLite; this is the right pattern for those queries.
- **JWT on user-scoped HTTP routes**: `GET/POST` DM APIs, `GET /api/chats_history`, `GET /api/directory_users`, profile routes, and `POST /api/signout` use **`@jwt_required()`** where applicable (`backend/chat/chatfunc.py`, `profile.py`, `user.py`).
- **Sign-in**: Issues a JWT on successful password check; client sends `Authorization: Bearer …` on protected calls.
- **Socket.IO connect**: Connections are **rejected** without a valid access token (same secret as REST). The token is sent in the Engine.IO handshake **`token`** query param; the server decodes it with **`flask_jwt_extended.decode_token`**, joins **`join_room(username)`** from the JWT **`sub`**, and tracks **`request.sid → username`** for the session.
- **`send_message`**: The server **ignores any client `from` field** and uses the authenticated username bound to the socket session only.
- **JWT expiry (LAN default)**: Access tokens expire after **`JWT_ACCESS_TOKEN_DAYS`** (default **7**); set to **`0`** / **`never`** in `.env` to disable expiry for local dev only.
- **Secrets**: **`SECRET_KEY`** and **`JWT_SECRET_KEY`** load from the environment (optional **`backend/.env`** via **`python-dotenv`**); dev fallbacks remain in code but should be overridden on office/LAN machines.

### Gaps you should know about

1. **JWT in the Socket.IO query string**  
   - The access token may appear in **URLs/proxy logs** on the handshake. Acceptable on many LANs; avoid logging query strings at the edge, or move to a hardened transport/session design if that becomes a concern.

2. **Stale or invalid tokens**  
   - If the socket **cannot connect** (e.g. expired JWT after **`JWT_ACCESS_TOKEN_DAYS`**), presence and realtime delivery stop; **sign in again** or refresh the page after obtaining a new token. REST calls that return **401** already redirect the SPA to sign-in.

3. **CORS / Socket.IO (optional lockdown)**  
   - Without **`CORS_ORIGINS`** in `.env`, CORS and Socket.IO stay **permissive** (`*`) for easy multi-device LAN dev. Set **`CORS_ORIGINS`** to a comma-separated list of real UI origins when you want a stricter boundary.

4. **Flask `debug`**  
   - Defaults to **`FLASK_DEBUG=true`** for local demos. Set **`FLASK_DEBUG=false`** in `.env` on shared office machines (disables the interactive debugger).

5. **Rate limiting & lockout**  
   - No built-in limits on sign-in, sign-up, or messaging → **brute-force** and **spam** are easier on an exposed deployment.

6. **Signup error shape**  
   - Duplicate username may return **non-JSON** responses in some paths; minor for security, relevant for robust clients.

---

## Recommendations: production (internet-facing)

Use this as a target architecture, not a single-day task.

### Authentication & authorization

- [ ] Require **`@jwt_required()`** on **all** endpoints that read or write user-specific data.
- [x] **DM HTTP API**: sender from **`get_jwt_identity()`**; JSON body on **`POST /api/dm/messages`** (still add **max body size** / validation in production).
- [x] **JWT expiry** enabled by default (configurable **`JWT_ACCESS_TOKEN_DAYS`**); add **refresh tokens** if you need long sessions without periodic sign-in.
- [x] Load **`SECRET_KEY`** / **`JWT_SECRET_KEY`** from **environment** (see **`backend/.env.example`**); still load DB path from env if you move beyond file SQLite.

### Transport & hosting

- [ ] Serve the API and app over **HTTPS** only; redirect HTTP → HTTPS.
- [ ] Run with **`debug=False`**; use a production WSGI/ASGI setup compatible with **Flask-SocketIO** (e.g. gunicorn with an appropriate worker).
- [ ] Restrict **CORS** to your real frontend origin(s).
- [ ] Set **Socket.IO** / engine allowed origins to those same origins (not `*`).

### Real-time layer

- [x] Authenticate the socket: JWT in handshake **query `token`**, verify on **`connect`**, **`join_room`** from JWT **`sub`** only (`backend/chat/chatfunc.py`).
- [x] **`send_message`**: sender is **socket session identity only**; client **`from`** is ignored.

### Abuse & operations

- [ ] Add **rate limiting** (login, signup, messaging).
- [ ] Add **security headers** (via reverse proxy or Flask): e.g. `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options` / `frame-ancestors`, `Referrer-Policy`.
- [ ] Log **security-relevant events** (failed logins, 401 spikes) without logging message bodies or tokens.
- [ ] Keep **Python and npm dependencies** updated; monitor CVEs.
- [ ] If SQLite is not enough: move to a managed DB, backups, and least-privilege DB users for multi-instance setups.

---

## Recommendations: local / organization (trusted office LAN)

You may accept slightly more risk than production, but **insider threat** and **lateral movement** still matter.

### Minimum (still valuable on LAN)

- [x] **JWT + sender from token** on DM POST/GET; **JWT on socket connect** + server-side sender for **`send_message`**.
- [ ] **Strong, unique** `JWT_SECRET_KEY` in env (even on LAN); rotate if anyone with access leaves.
- [ ] **`debug=False`** on any machine that is reachable from more than your own account.
- [ ] **Firewall**: allow app ports only on **Private** profile; avoid exposing the dev stack on **Public** Wi‑Fi.
- [ ] **No router port forwarding** unless you intentionally want the internet to reach the app; document who approved it.

### Socket.IO on org networks

- [x] **JWT on connect** for rooms (no `join_user`); spoofed usernames cannot join another user’s delivery room without a valid token for that account.

### Policy

- [ ] Document **who may run** the server, **where data lives** (`chat.db`), and **retention** (chat export / deletion).
- [ ] For regulated environments, add **access control** and **audit** requirements beyond this app’s current scope.

---

## Local development (solo machine)

- [ ] Keep using **venv** and pinned dependencies; do not reuse production secrets in dev `.env` committed to git.
- [ ] Prefer a **`.env`** file (gitignored) for any secret you experiment with.
- [ ] Understand that **localhost-only** binding is safer than `0.0.0.0`; you already use `0.0.0.0` for LAN testing — that widens exposure to your LAN.

---

## Related files (quick map)

| Area | Location |
|------|----------|
| Flask + JWT + CORS + Socket.IO defaults | `backend/chat/__init__.py` |
| Sign up / sign in / sign out | `backend/chat/user.py` |
| DMs, history, directory, socket handlers | `backend/chat/chatfunc.py` |
| Direct conversation helpers | `backend/chat/conversations.py` |
| Profiles | `backend/chat/profile.py` |
| Schema / legacy reset | `backend/chat/database.py` |
| Server entry (debug, host, port) | `backend/main.py` |
| Client token usage | `client/src/app/chat/chat.component.ts`, `auth.service.ts` |

---

## See also

- [`evolution.md`](./evolution.md) — roadmap for profiles, groups, and scalable message modeling.
- [`glossary.md`](./glossary.md) — short definitions of **JWT**, **CORS**, **Socket.IO**, and related terms.
- [`system-design.md`](./system-design.md) — REST + Socket.IO flows (JWT on connect).

---

## Summary

For **home LAN and office intranets**, the app now ties **realtime presence and delivery** to the same **JWT** as REST (with configurable **expiry** and **env-backed secrets**). Remaining priorities for stricter environments are **`FLASK_DEBUG=false`**, optional **`CORS_ORIGINS`**, **rate limiting**, **HTTPS + tight CORS** if anything is ever internet-adjacent, and avoiding **token leakage** in proxy logs (handshake query string).
