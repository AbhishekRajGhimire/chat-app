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

> **Status:** the per-conversation room pattern (`conv:<id>`) is now **implemented** for group delivery; DMs still deliver via the per-username room (lowest-risk). Payloads carry `conversation_id` + `kind`.

---

## Messaging polish — delivered (reactions, reply, edit/delete)

Per-message actions now exist in both DMs and groups, live across clients:

- **Stable message id.** Every message carries a client-generated **`client_message_id`** (UUID), threaded through the existing socket-emit **and** persistence POST (no delivery refactor); pre-existing rows are **backfilled** at startup. All mutation endpoints key on this id.
- **Reactions.** `MessageReaction(client_message_id, user_id, emoji)`; **`POST /api/messages/<id>/react`** toggles; aggregated `[{emoji,count,mine}]`; broadcast via the **`reaction_updated`** socket event. UI: hover/long-press quick-react bar + a full emoji picker; pills under the bubble (own highlighted, tap-toggle).
- **Reply.** `Message.reply_to` stores the parent's id; payloads include a `reply_preview` snippet (suppressed if the parent was deleted). UI: a named "Replying to …" composer chip + a text-only in-thread quote that scrolls to the original.
- **Edit / delete (own only).** **`PATCH`** / **`DELETE /api/messages/<id>`** (owner-checked 403); edit sets `edited_at` ("(edited)" label), delete is a soft `deleted_at` tombstone; broadcast via **`message_edited`** / **`message_deleted`**.

Delivery rides the per-conversation room (`conv:<id>`) that both DM participants and group members join on connect, so the same caveat as DM live-delivery applies to a brand-new conversation (history is always correct). Backend covered by `tests/test_messages.py`.

---

## Native mobile UI — delivered

The Angular client is now structured in three explicit layers: a **transport SDK** (`ChatApi` for REST, `RealtimeClient` for Socket.IO streams), a **signal store** (`ChatStore`) that owns all state, business rules, and the single app-lifetime socket, and thin **presentation shells** that are pure views over store signals.

A **lazy-loaded `ChatMobileModule`** serves the phone form-factor at `/m` with a native-style full-screen list↔thread flow, a bottom tab bar (**Chats / Calls / People**), and Profile as a pushed screen from the top-bar avatar. The root route auto-redirects by viewport (`ShellRedirectComponent`). Four touch gestures are implemented via `GesturesModule`: swipe-back, swipe-to-reply, pull-to-refresh, and long-press. The desktop shell (`/chat`) is unchanged and shares `<app-message-thread>` with mobile.

The Calls tab is a placeholder today; **video calling** (WebRTC + Socket.IO signaling) is the next feature that will fill it — see below.

---

## File attachments — delivered

Images and files can now be sent in any DM or group conversation. Images render inline in a grid with a tap-to-open lightbox; other file types appear as chips with filename, size, and a download action. Multiple attachments per message are supported; the per-message limit is **25 MB**.

### How it works

- **Upload-first flow.** The client uploads bytes via `POST /api/attachments` before (or while) composing the message body. The server returns `{ id, filename, mime, size, kind }` immediately. When the user sends, `attachment_ids` travel with the message POST and the matching socket payload, and the backend **links** them to the persisted `Message` row by `client_message_id`. There is no separate polling — the link is atomic with send.
- **Pending-attachment tray.** Upload progress, per-file retry, and the 📎 button live in `ChatStore` (`addFiles` / `removePending` / `retryPending`), rendered by the shared `<app-attachment-tray>` component. Both the desktop and mobile composers host the same tray.
- **Serving.** `GET /api/attachments/<id>?token=<jwt>` decodes the JWT from the query string (reusing the Socket.IO `?token=` convention), checks conversation membership, and serves bytes. Images are served `inline`; all other types use `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff` as an XSS guard. Deleted-message files return 404.
- **Schema.** The `MessageAttachment` table (`client_message_id`, `conversation_id`, `uploader_user_id`, `storage_key`, `filename`, `mime`, `size`, `kind`, `created_at`) backs every upload. `conversations.serialize_messages` includes an `attachments` array in every message payload, so both REST history and live socket events carry the same data.

### Production evolution

The design isolates all byte I/O behind **`chat/storage.py`** — the rest of the codebase never touches files directly. A real deployment swaps the local-disk implementation for **object storage (S3, MinIO, GCS)** by replacing only that module. The token-in-URL serve pattern evolves naturally into **pre-signed URLs**: instead of proxying bytes through Flask, `storage.py` returns a short-lived signed URL from the object store and the serve route redirects to it — no change required in any other backend or client code. File metadata stays in SQLite throughout.

**Redis** enters the picture separately as the **Socket.IO pub/sub adapter** for multi-server realtime (to replace the in-process `online_users` list). Attachments ride the same `receive_message` / group message socket events unchanged — no attachment-specific realtime changes are needed when adding Redis.

---

## Avatar uploads — delivered

Users can set a profile photo via a custom **crop/zoom dialog** (`AvatarCropperComponent`). The client exports a **512×512 JPEG** using `createImageBitmap` (EXIF-aware), so the server receives a normalised image regardless of camera orientation. Bytes flow through the existing `chat/storage.py` seam (`UserProfile.avatar_key` + `avatar_mime`), keeping byte I/O isolated from the rest of the backend.

Avatars are rendered everywhere a person appears: the sidebar, conversation header, group thread sender rows, People directory, member panel, and profile screens. `AvatarComponent` + the `avatarSrc()` token-appending helper are shared across desktop and mobile shells.

### Intentional scope limits (deferred)

- **No live avatar push.** Other members see a new photo on their next data load (sidebar refresh, thread open, etc.) — no real-time broadcast event was added.

---

## Group avatars — delivered

Group conversations can now have an uploaded photo, with a monogram fallback when none is set. The feature reuses the existing avatar machinery end-to-end:

- **Schema**: `Conversation.avatar_key` + `avatar_mime` (via `chat/storage.py`); computed cache-busted `avatar_url` rides on `_group_summary` and `chats_history` group rows.
- **Endpoints**: `POST` / `DELETE /api/groups/<id>/avatar` (multipart, image-only, member-only); `GET /api/groups/<id>/avatar?token=<jwt>` — **members-only** (`is_member` check), not org-public; 403 non-member, 404 no photo, 401 bad token.
- **Upload UX**: any group member can set or remove the photo. Desktop: via the member panel. Mobile: tap the group avatar in the conversation header.
- **Render**: all four monogram render sites (desktop sidebar + conversation header, mobile Chats list + thread header) now show the photo through `AvatarComponent` / `avatarSrc()`, falling back to the initial-letter monogram when no photo is set.

---

## Video calling (planned — placeholder in UI today)

A disabled **"🎥 Call — coming soon"** control already sits in the conversation header (both DMs and groups) so the seam exists. The intended implementation, as its own future sub-project:

- **Signaling over the existing Socket.IO connection** — new events (e.g. `call_offer`, `call_answer`, `ice_candidate`, `call_end`) relayed to the callee's username room / the conversation room, with sender identity taken from the socket session (same trust model as `send_message`).
- **Media via WebRTC** `RTCPeerConnection` directly between browsers; the server only brokers signaling. 1:1 first (DM), then small-group mesh or an SFU if needed.
- **STUN/TURN**: a public STUN server for NAT traversal on the LAN; TURN only if relaying becomes necessary off-LAN.
- No media ever touches the Flask process; keep it signaling-only to preserve the single-process model.

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

> **Now also a blocker for two features:** the **PWA service worker** and **Web Push** both require a **secure context**. So HTTPS is the prerequisite that unlocks **installing Rojin on a phone** and **push notifications** off `localhost`.

> **Delivered (testing harness):** `deployment/serve-https.ps1` + `deployment/Caddyfile` serve the built PWA at **`https://Avi.local`** via **Caddy + mkcert**, proxying `/api` + `/socket.io` to Flask — enough to install the PWA on a phone and (next) build Web Push. See [`deployment/https-tls.md`](../deployment/https-tls.md). A full reverse-proxy production deployment (real domain/cert, process manager) remains optional, as above.

---

## PWA & notifications

- **PWA shell — delivered.** The client is installable via `@angular/pwa` (ngsw): web app manifest (charcoal theme, chat-bubble icon), app-shell prefetch caching, `/api` + `/socket.io` never cached. Works on `localhost` today; **phone install needs the HTTPS step above** (service workers require a secure context).
- **Web Push — code delivered; activation pending.** True notifications when the app is closed: VAPID keys, a `PushSubscription` table per user, a custom service worker (`public/sw-custom.js`) wrapping ngsw with focus-aware push + click-to-open, and the Flask backend sending pushes via `pywebpush` on new DM + group messages (opt-in via the Profile toggle). The code is implemented and unit-tested (27 backend tests green), but:
>   **Where we left off (pick up here):** no VAPID keys are configured yet, so push is currently **disabled at runtime** (the Profile toggle shows "not available" until keys exist). To turn it on: generate a VAPID keypair into `backend/.env` (one-liner in `backend/.env.example`), then test on a real device via the HTTPS harness (`deployment/serve-https.ps1` → install the PWA → Profile → Enable notifications). The end-to-end banner has **not been verified on a device yet**.
>
>   This completes the Notifications + PWA **build** arc; only the key-generation + on-device verification remain.

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
