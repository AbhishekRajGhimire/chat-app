# Evolution roadmap — beyond today’s DM + profiles baseline

This document is **what could come next**, not the live spec. For **what exists today** (REST routes, schema, Socket.IO, `ui/` layer, JWT), see [`system-design.md`](./system-design.md). For **security checklists**, see [`security.md`](./security.md). For **ports, firewall, LAN access**, see [`../deployment/home-deployment.md`](../deployment/home-deployment.md).

---

## Delivered baseline (no longer tracked here)

The following are **already in the repo**; details live in system-design / security docs rather than this roadmap:

- **Identity**: `User.id` for keys; `username` for login; **`UserProfile`** for optional `display_name`, `avatar_url`, `bio`.
- **Profile APIs**: `GET` / `PATCH /api/me/profile` (JWT-bound); public card `GET /api/users/<username>/profile`.
- **Directory / sidebar**: `chats_history` and `directory_users` already return **`display_name`** (fallback to username).
- **DM storage**: **`Conversation`** (direct), **`ConversationMember`**, **`Message`** with **`conversation_id`**; legacy pairwise `Message` shape is **dropped on startup** in `database.py` when present (no backfill).
- **Realtime DMs**: JWT on Socket.IO **connect**; **`send_message`** sender from socket session only; per-**username** rooms for delivery.
- **Client**: shared **`ui/`** tokens + toolbar shell; Material theme aligned with brand; mobile viewport / safe-area handling.

---

## Goals (still ahead)

- **Group chat**: multiple participants in one thread using the same conversation-centric tables (`type=group`, many members).
- **Realtime for groups**: move from username-only rooms to **per-conversation** (and optionally per-user) channels.
- **Policy (optional)**: contacts / invites if DMs should require accept.
- **Deployment (optional)**: **HTTPS on LAN/org** via internal CA or tools like **mkcert**, reverse proxy, and strict **`CORS_ORIGINS`**.

---

## Group chat (target shape)

The schema already allows `Conversation.type = 'group'`; **APIs and UI** are the gap.

| Piece | Direction |
|-------|-----------|
| **`Conversation`** | `type=group`, optional `title`, `created_at`; members in **`ConversationMember`**. |
| **`Message`** | Same as today: `conversation_id`, `sender_user_id`, `body`, timestamps; paginate long threads. |
| **APIs** | Create group, list my groups, list members, add/remove (with roles), list/post messages by **`conversation_id`**. |
| **Uniqueness** | DMs stay enforced by normalized pair; groups are many-to-many via membership. |

---

## Realtime (Socket.IO) evolution

Today: **per-username** rooms for DM delivery. For groups and clearer scaling:

| Pattern | Use |
|---------|-----|
| **Per-user notify channel** | `join_room` keyed by **`user_id`** (or session) — unread / activity signals. |
| **Per-conversation channel** | `join_room("conv:" + conversation_id)` while the thread is open; **`emit`** live messages (and typing) there. |

Payloads should carry **`conversation_id`** and **`sender_user_id`** (plus display hints as needed). Keep **JWT-authenticated connect** and server-side sender identity (see [`security.md`](./security.md)).

---

## Discovery: directory vs contacts (optional)

- **Open directory** (current **`directory_users`**) fits small orgs.
- **Contacts / friend requests** (optional later): e.g. **`Contact`** or **`FriendRequest`** if DMs require **accept** before messaging.

---

## LAN / organization: internal HTTPS (optional)

For **trusted** HTTPS **without** exposing the app to the public internet, encryption and naming are separate concerns:

- **Name**: internal DNS (router, Pi-hole, AD DNS, etc.) so e.g. `https://rojin.corp.lan` resolves to the server.
- **Certificate**: either **org PKI** / AD CS (machines already trust the root), **mkcert** (install the local CA on each device), or **self-signed** (browsers warn until trusted manually).
- **Serving**: usually a **reverse proxy** (Caddy, nginx, …) terminates TLS, serves the **built** Angular app, and proxies **`/api`** and **`/socket.io`** to Flask with **WebSocket** upgrades enabled.
- **App config**: set **`CORS_ORIGINS`** (and matching Socket.IO allowed origins) to that **`https://…`** origin — see [`security.md`](./security.md).

This is **optional hardening** for office Wi‑Fi; HTTP on a trusted LAN remains common for internal demos.

---

## Suggested implementation order (remaining)

1. **Group APIs** — create/list/join, members, messages by `conversation_id`.
2. **Socket.IO** — conversation rooms (and optional user-level notify); align payloads with group HTTP API.
3. **Optional** — contacts / friend requests; richer search (beyond directory list).
4. **Optional** — internal HTTPS + reverse proxy + env hardening for org LAN.

---

## Non-goals (for this roadmap doc)

- **End-to-end encryption** — orthogonal; server still routes ciphertext if added later.
- **Multi-region / sharding** — out of scope here; pagination and conversation ids are the near-term scale lever.
- **Exact API shapes** — finalize when implementing; this doc stays architectural.

---

## Related documentation

- [`system-design.md`](./system-design.md) — current components and flows.
- [`security.md`](./security.md) — JWT, CORS, socket auth, production/LAN checklists.
- [`../deployment/home-deployment.md`](../deployment/home-deployment.md) — LAN deployment steps.
- [`glossary.md`](./glossary.md) — terms (JWT, CORS, SPA, etc.).
