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
- **JWT on some HTTP routes**: `GET /api/chats_history`, `GET /api/directory_users`, and `POST /api/signout` use **`@jwt_required()`** (`backend/chat/chatfunc.py`, `user.py`).
- **Sign-in**: Issues a JWT on successful password check; client sends `Authorization: Bearer …` on protected calls.

### Gaps you should know about

1. **Message API not tied to JWT**  
   - `POST /api/post_messages/<recipient>/&/<sender>/&/<message>` and `GET /api/message_history/<user1>/&/<user2>` are **not** protected by `@jwt_required()`.  
   - **Sender is taken from the URL**, not from the token. Anyone who can reach the server could try to post or fetch history **as arbitrary usernames** unless something else blocks them (e.g. firewall only).

2. **Message body in the URL**  
   - Long messages, special characters, and **sensitive content** can hit URL limits, encoding issues, and may appear in **proxy or server logs**.

3. **JWT and Flask secrets in code**  
   - `SECRET_KEY`, `JWT_SECRET_KEY` are fixed **development** strings in `backend/chat/__init__.py`.  
   - `JWT_ACCESS_TOKEN_EXPIRES = False` means tokens **do not expire** until you change that.

4. **CORS / Socket.IO**  
   - CORS is broad; Socket.IO uses **`cors_allowed_origins='*'`** in `__init__.py`. Fine for quick local dev; **too open** for production unless you lock origins deliberately.

5. **Socket identity**  
   - **`join_user`** trusts the **client-supplied username** to join a Socket.IO room. There is **no cryptographic proof** on the socket that the client is that user. On a hostile network, **impersonation** is possible.

6. **`send_message` over Socket.IO**  
   - Server should treat **`from`** as untrusted unless verified against a JWT (or drop `from` and use server-side identity only).

7. **Flask `debug=True`**  
   - `backend/main.py` runs with **`debug=True`**, which is **unsafe** on any shared or public network (interactive debugger exposure).

8. **Rate limiting & lockout**  
   - No built-in limits on sign-in, sign-up, or messaging → **brute-force** and **spam** are easier on an exposed deployment.

9. **Signup error shape**  
   - Duplicate username may return **non-JSON** responses in some paths; minor for security, relevant for robust clients.

---

## Recommendations: production (internet-facing)

Use this as a target architecture, not a single-day task.

### Authentication & authorization

- [ ] Require **`@jwt_required()`** on **all** endpoints that read or write user-specific data.
- [ ] **Never trust `sender` from the client** for `post_messages`. Set sender from **`get_jwt_identity()`** (or equivalent).
- [ ] Replace URL-encoded messages with **`POST /api/messages`** (JSON body: recipient + text), with a **max body size** and validation.
- [ ] Enable **JWT expiry** (`JWT_ACCESS_TOKEN_EXPIRES`) and implement **refresh tokens** or re-login UX if sessions should be long-lived.
- [ ] Load **`SECRET_KEY`**, **`JWT_SECRET_KEY`**, and DB URLs from **environment variables** (never commit real secrets).

### Transport & hosting

- [ ] Serve the API and app over **HTTPS** only; redirect HTTP → HTTPS.
- [ ] Run with **`debug=False`**; use a production WSGI/ASGI setup compatible with **Flask-SocketIO** (e.g. gunicorn with an appropriate worker).
- [ ] Restrict **CORS** to your real frontend origin(s).
- [ ] Set **Socket.IO** / engine allowed origins to those same origins (not `*`).

### Real-time layer

- [ ] Authenticate the socket: e.g. pass a **short-lived JWT** in the handshake (`auth` / query), verify on `connect`, then **`join_room(identity)`** from server-side claims only.
- [ ] Validate **`send_message`** so **`from`** matches the authenticated identity (or ignore client `from`).

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

- [ ] **JWT + sender from token** on message POST/GET (same as production API design); stops casual abuse from another employee’s browser.
- [ ] **Strong, unique** `JWT_SECRET_KEY` in env (even on LAN); rotate if anyone with access leaves.
- [ ] **`debug=False`** on any machine that is reachable from more than your own account.
- [ ] **Firewall**: allow app ports only on **Private** profile; avoid exposing the dev stack on **Public** Wi‑Fi.
- [ ] **No router port forwarding** unless you intentionally want the internet to reach the app; document who approved it.

### Socket.IO on org networks

- [ ] Prefer **JWT on connect** for `join_user` / rooms even on LAN, so a spoofed username cannot join someone else’s room from another PC.

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
| Messages, history, directory, socket handlers | `backend/chat/chatfunc.py` |
| Server entry (debug, host, port) | `backend/main.py` |
| Client token usage | `client/src/app/chat/chat.component.ts`, `auth.service.ts` |

---

## Summary

Today the app is appropriate for **learning and local demos** with **good password hashing** and **JWT on part of the API**, but **message HTTP routes and real-time identity** need hardening before you call it **secure for an organization or the internet**. Use the checklists above incrementally; the highest impact items are **JWT on all private APIs**, **sender derived only from the token**, **JSON bodies for messages**, **socket authentication**, **secrets from env**, **`debug=False`**, and **HTTPS + tight CORS** in production.
