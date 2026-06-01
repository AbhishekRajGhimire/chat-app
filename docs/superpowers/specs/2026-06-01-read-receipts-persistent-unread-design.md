# Read Receipts + Persistent Unread — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-01)
**Phase:** Phase 5, Sub-project 2 of 3 (Group chats ✓ → **Read receipts/persistent unread** → Notifications+PWA)
**Branch target:** new branch off `main`

---

## Goal

Make unread state reliable and add "seen" receipts: a single `last_read_at` marker per `ConversationMember` powers (a) unread counts that survive reload and count messages received while away, and (b) reader-avatar "seen" indicators under messages — in DMs and groups.

## Decisions (from brainstorming)

- **Group depth:** DMs show the peer's "seen"; groups show **"Seen by N" as reader avatars** (richer option).
- **Indicator style:** **reader avatars (style C)** — each reader's tiny avatar appears under the last message they've read.
- **Unread:** **replace** the current client-only unread with **server-backed** counts (persist across reload, include offline messages); live socket increments still apply on top.
- **Mark-read trigger:** opening a conversation **while the tab is visible** (and a new message arriving in the already-open, focused conversation).

## Non-goals / YAGNI

- No per-user "read receipts off" privacy toggle (always on for v1).
- No "delivered" vs "read" distinction (only "seen").
- No read state for the self-conversation entry.
- No schema change beyond the single `last_read_at` column.

---

## 1. Schema — one column + idempotent migration

Add `last_read_at TEXT` (NULL = never read) to `ConversationMember`.

- In `database.py`, `_create_conversation_schema` adds the column to the `CREATE TABLE ConversationMember` for fresh DBs.
- For existing DBs, an idempotent migration at startup:
  ```python
  cursor.execute("PRAGMA table_info(ConversationMember)")
  cols = {r[1] for r in cursor.fetchall()}
  if "last_read_at" not in cols:
      cursor.execute("ALTER TABLE ConversationMember ADD COLUMN last_read_at TEXT")
      connection.commit()
  ```
  Runs after `_create_conversation_schema()`; safe to re-run.

## 2. Backend — helpers (`conversations.py`)

- `mark_read(cid, user_id, when_iso)` → `UPDATE ConversationMember SET last_read_at=? WHERE conversation_id=? AND user_id=?`.
- `unread_count(cid, user_id)` → count of `Message` rows in `cid` with `created_at > member.last_read_at` (treat NULL last_read as "all unread") and `sender_user_id != user_id`.
- `read_state(cid)` → `[{username, last_read_at}]` for all members (drives "seen" rendering).

## 3. Backend — endpoints (`chatfunc.py`, `groups.py`)

- **Mark read:**
  - `POST /api/dm/<other_username>/read` — resolve the direct conversation for (me, other); `mark_read`; emit `conversation_read`.
  - `POST /api/groups/<cid>/read` — member-only; `mark_read`; emit `conversation_read`.
  - Both set `last_read_at = now` and `socketio.emit("conversation_read", {conversation_id, username, last_read_at}, room=conversation_room(cid))`.
- **Unread in `chats_history`:** add `unread_count` per entry (DM + group) via `unread_count(cid, me_id)`. (Replaces the client-only count.)
- **Read state in history:**
  - `GET /api/dm/messages/<other>` response gains a sibling field or the endpoint returns `{ messages: [...], read_state: [...] }`. To avoid breaking the existing array shape, return read state via a **separate lightweight field**: change the DM + group message endpoints to return `{ "messages": [...], "read_state": [{username, last_read_at}] }`. (Client updated in lockstep.)
  - Group `GET /api/groups/<cid>/messages` returns the same `{messages, read_state}` shape.

## 4. Frontend (`chat.component.ts`)

- **Unread:** seed `entry.unreadCount` from the server `unread_count` in `loadConversations()`. Keep live increments in `onReceive`; `selectConversation` resets to 0 locally and calls mark-read.
- **Read-state map:** `readState: { [conversationKey]: { [username]: lastReadAtISO } }`, populated from each message-fetch's `read_state` and updated by the `conversation_read` socket listener.
- **Mark read:** in `selectConversation` (when `!document.hidden`) and in `onReceive` when the message lands in the open, visible conversation → POST the appropriate read endpoint; optimistically set my own entry in `readState`.
- **Seen rendering helper:** `readersOf(thread, index)` → for the message at `index`, return the members (excluding the sender) whose `last_read_at >= message.datetime` **and** for whom this is the *last* such message (so each reader's avatar shows once, under the last message they've read).
- **Socket:** add `conversation_read` handler → merge into `readState`, re-render.

## 5. Frontend (`chat.component.html` / `.scss`)

- Under each message row, `@if (readersOf(thread, i).length)` render a right-aligned `.seen-row` of `<app-avatar size="16">` for each reader. DM → one peer avatar; group → a small avatar row ("Seen by N" made visual).
- Style `.seen-row` (gap, right-aligned, subtle) consistent with the bubble meta.

## 6. Tests (`backend/tests/`)

Extend the suite:
- `last_read_at` defaults NULL on new membership.
- `POST .../read` sets `last_read_at`; non-member → 403 (group).
- `unread_count`: a fresh recipient sees N unread; after read → 0; sender's own messages never count as unread.
- `chats_history` returns `unread_count` for DM + group entries.
- message endpoints return `{messages, read_state}` with the right member shape.

## Files touched

- **Backend:** `chat/database.py` (column + migration), `chat/conversations.py` (`mark_read`, `unread_count`, `read_state`), `chat/chatfunc.py` (DM read endpoint, `chats_history` unread, DM history `{messages, read_state}`, `conversation_read` already-emitted helper reuse), `chat/groups.py` (group read endpoint, group messages `{messages, read_state}`)
- **Frontend:** `chat/chat.component.{ts,html,scss}`, possibly `conversation.ts` (unread already on the model)
- **Tests:** extend `backend/tests/test_groups.py` + new `backend/tests/test_read.py`

## Error handling / edge cases

- NULL `last_read_at` ⇒ everything unread (correct for never-opened conversations).
- Mark-read is idempotent; emitting `conversation_read` to a room with no other live members is a harmless no-op.
- Message endpoints change response shape (`array` → `{messages, read_state}`) — the client is updated in the same change; this is an internal API, no external consumers.
- Read endpoints enforce membership (group) / valid pair (DM); 401/422 → `/signin` preserved.

## Risks / watch-items

- **Response-shape change** on the two message endpoints is the main coordination risk — backend + frontend must land together (and the backend tests assert the new shape).
- **`readersOf` "last message" logic** must show each reader once (under their latest-read message), not under every read message, to avoid avatar spam.
- Schema `ADD COLUMN` on a live DB — safe/idempotent, verified by re-running startup.
- Persistent unread relies on accurate `last_read_at`; if the client fails to mark-read, the count simply stays — acceptable (no data loss).
