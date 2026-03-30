# Evolution roadmap — profiles, groups, and scalable chat

This document captures a **recommended direction** for growing Rojin beyond the current **1:1 DM + SQLite + in-memory presence** design. It is a **planning reference**, not a commitment or task list. For the **current** architecture, see [`system-design.md`](./system-design.md). For **security** work that should accompany API changes, see [`security.md`](./security.md).

---

## Goals

- **Profiles**: per-user settings and display identity without breaking login or foreign keys.
- **Group chat**: multiple participants in one thread (direct DMs already use **`Conversation`** + **`Message.conversation_id`**).
- **Robust identity**: stable ids for APIs and data; human-friendly names for search and UI.
- **Scalability**: conversation-centric storage and realtime patterns that work as history grows and (optionally) multiple server processes appear later.

---

## Identity: user id, username, display name

The **`User`** table already has an integer **`id`** primary key. Use that as the **canonical identity** for all new features:

| Field | Role |
|-------|------|
| **`User.id`** | Foreign keys, memberships, message sender, internal APIs. Never shown as “type this to add me” unless you explicitly want that. |
| **`username`** (unique) | Login handle (e.g. `@alice`). Keep stable or change rarely by policy. |
| **`display_name`** (new, optional) | Search and UI; can change without breaking relations. |

**Search**: expose **display name + username** in directory/search APIs; resolve invites to **`user_id`** on the server. Users do not need to memorize numeric ids.

---

## Profiles

**Option A — columns on `User`**: `display_name`, `avatar_url`, `bio`, `updated_at`. Simple for SQLite demos.

**Option B — `UserProfile` table**: `user_id` PK / FK → `User(id)`. Cleaner if profiles grow large or you want optional profiles.

**APIs** (with JWT):

- `GET /api/me` or `GET /api/me/profile` — current user’s profile.
- `PATCH /api/me/profile` — updates; **never** trust client-sent `user_id` as “who to edit”; derive from **`get_jwt_identity()`** (then map to `user_id`).

**Public cards** (for search / member lists): `GET /api/users/:id/public` or search results embedding **limited** fields (no email unless policy allows).

---

## From pairwise DMs to conversations

**Current (DMs):** **`Conversation`**, **`ConversationMember`**, and **`Message`** with **`conversation_id`** are implemented for **direct** threads (normalized user pair + unique index). **Group** conversations are not exposed in the API yet.

### Target model (industry-standard pattern) — extended with groups

| Table | Purpose |
|-------|--------|
| **`Conversation`** | `id`, `type` (`direct` \| `group`), `title` (nullable for DMs), `created_at`, optional `created_by_user_id`. |
| **`ConversationMember`** | `conversation_id`, `user_id`, `role` (`owner`, `admin`, `member`), `joined_at`. Unique `(conversation_id, user_id)`. |
| **`Message`** (evolved) | `conversation_id`, `sender_user_id`, `body`, `created_at`; optional `client_message_id` for idempotent sends. |

**Direct messages**: one `Conversation` row with `type=direct` and **exactly two** members. Enforce **uniqueness of the pair** (e.g. normalized `(user_low_id, user_high_id)` with a unique constraint, or equivalent application logic) so the same two users don’t get duplicate DM threads.

**Group messages**: one `Conversation` with `type=group`, many **`ConversationMember`** rows, many **`Message`** rows sharing `conversation_id`.

**Reads**: index **`(conversation_id, created_at)`** or **`(conversation_id, id)`**; paginate (`LIMIT` / cursor) for long threads.

### Legacy SQLite files

Older dev databases used pairwise **`Message`** (`sender_id` / `recipient_id`). On startup, **`database.py`** detects that shape, **drops** the old conversation/message tables, and recreates the new schema (or delete **`chat.db`** manually). There is **no** automatic backfill of old pairwise rows into conversations.

---

## Discovery: directory vs contacts

- **Open directory** (similar to current **`directory_users`**): any registered user can start a chat — fine for **small orgs** and internal tools.
- **Contacts / friend requests** (optional): tables like **`Contact`** or **`FriendRequest`** (`from_user_id`, `to_user_id`, `status`) if DMs should require **accept** before messaging.
- **Groups**: create conversation, then **invite** by username or internal id; server resolves to **`user_id`** and inserts **`ConversationMember`**.

---

## Realtime (Socket.IO) evolution

Current design uses **per-username rooms** for DMs. For groups and cleaner scaling:

| Pattern | Use |
|--------|-----|
| **Per-user notify channel** | `join_room` keyed by **`user_id`** (or authenticated session) — “you have new activity” / unread counts. |
| **Per-conversation channel** | `join_room("conv:" + conversation_id)` when the client **opens** that thread; **`emit`** live messages and typing to that room. |

Payloads should include **`conversation_id`** and **`sender_user_id`** (and optionally denormalized username for display). Align with **JWT-authenticated sockets** (see [`security.md`](./security.md)) before exposing sensitive group metadata.

---

## Suggested implementation order

1. **Profiles** — extend schema + `GET/PATCH /api/me/profile` with strict JWT binding; minimal UI.
2. **Conversation + ConversationMember + message (direct)** — **done** for DMs; legacy pairwise DBs are reset on load (see above). **Group** chat still below.
3. **Group APIs** — create group, list members, add/remove member, post/list messages by **`conversation_id`**.
4. **Socket.IO** — conversation rooms; optional user-level notification channel.
5. **Search & social** — display name search, optional friend/contact flows.

---

## Non-goals (for this roadmap doc)

- **End-to-end encryption** — orthogonal; server still routes ciphertext if added later.
- **Multi-region / sharding** — out of scope; conversation + pagination is enough for “next step” scale.
- **Exact API shapes** — finalize when implementing; this doc is architectural guidance only.

---

## Related documentation

- [`system-design.md`](./system-design.md) — today’s components and flows.
- [`security.md`](./security.md) — JWT on all private routes, JSON bodies for messages, socket auth.
- [`glossary.md`](./glossary.md) — terms (JWT, CORS, SPA, etc.).
