# Messaging Polish (Reactions · Reply · Edit/Delete) — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-02)
**Phase:** Phase 6 — message‑level actions on the chat thread (DM + group)
**Branch target:** new branch off `main`

---

## Goal

Add the three message‑level actions every modern chat has: **emoji reactions**, **reply/quote**, and **edit/delete (own messages)** — in DMs and groups, live across clients.

## Decisions (from brainstorming)

- **Affordance:** hover (desktop) / long‑press (mobile) on a message shows a **quick‑react emoji bar above the bubble** and a **⋯ button in the side gutter** (opposite the bubble's side — right of others' messages, left of your own). The ⋯ menu: **Reply** on others' messages; **Reply · Edit · Delete** on your own.
- **Quick‑react set:** 👍 ❤️ 😂 😮 😢 🙏, plus a **"+"** opening a fuller emoji picker (any emoji).
- **Reactions render:** pills under the bubble (`emoji count`); your own is highlighted gold; tap a pill to toggle yours off. Multiple distinct emojis per message; counts aggregate across users.
- **Reply render:** in‑thread, a compact quote of the **original message text only** (gold left‑bar + ↩, no name) above the replying bubble; the **composer** shows a **"Replying to <name>" chip** (name kept) + snippet + ✕. Tapping the in‑thread quote highlights/jumps to the original.
- **Edit:** own messages only; shows a quiet **"(edited)"** in the meta.
- **Delete:** own messages only; leaves a **"This message was deleted" tombstone** (soft delete; replies pointing at it still resolve).

## Foundation — a stable, live message id (`client_message_id`)

Today message payloads carry **no id**, so nothing can target a single message. We use a **client‑generated UUID** as the public id, threaded through the *existing* delivery paths (no delivery refactor):

- The `Message` table already has a `client_message_id` column. **Backfill** NULLs at startup (generate a UUID per row) so every existing message is actionable.
- On send, the client generates `client_message_id = crypto.randomUUID()` and includes it in **both** the socket `send_message` emit and the persistence POST. The server stores it; the socket relay **passes it through** on `receive_message`; the POST returns it.
- Result: both sender (generated it) and recipient (got it live) hold the id immediately. All message responses (history + live) include it as `id`.
- All mutation endpoints below key on this `client_message_id`, and verify the caller is a **member of that message's conversation** (and the **owner** for edit/delete).

## Schema (idempotent; `CREATE TABLE IF NOT EXISTS` + guarded `ALTER`)

```sql
CREATE TABLE IF NOT EXISTS MessageReaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_message_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (client_message_id, user_id, emoji)
);
-- Message gains (guarded ADD COLUMN): reply_to TEXT, edited_at TEXT, deleted_at TEXT
```
(`client_message_id` is the join key; `reply_to` stores the replied‑to message's `client_message_id`.)

## Backend — endpoints (`backend/chat/messages.py`, new)

All JWT + membership‑checked; resolve the conversation from the message row.
- `POST /api/messages/<cmid>/react` `{emoji}` — **toggle**: insert if absent, delete if present. Emits `reaction_updated`.
- `PATCH /api/messages/<cmid>` `{body}` — **owner only**; updates body, sets `edited_at`. Emits `message_edited`.
- `DELETE /api/messages/<cmid>` — **owner only**; sets `deleted_at`, blanks the body. Emits `message_deleted`.

Helpers: `reactions_for(cmid, me_id)` → `[{emoji, count, mine}]`; `conversation_of(cmid)` + `owner_of(cmid)`.

### Threading id + reply through creates
- `post_dm_message` / `post_group_message` accept `client_message_id` and optional `reply_to`; store them; return `client_message_id`.
- The socket `send_message` handler passes `client_message_id` + `reply_to` straight into the `receive_message` payload.

### Message payload (history + live) gains
`id` (client_message_id), `reactions: [{emoji,count,mine}]`, `reply_to` (cmid|null), `reply_preview` (original text snippet|null), `edited_at` (iso|null), `deleted: bool`. Deleted messages return with `deleted:true` and empty body.

### New socket events (emitted to the conversation room — both DM participants and group members are joined)
- `reaction_updated` `{conversation_id, client_message_id, reactions}`
- `message_edited` `{conversation_id, client_message_id, body, edited_at}`
- `message_deleted` `{conversation_id, client_message_id}`

## Frontend (`client/src/app/chat/`)

- **Message model** gains `id`, `reactions`, `replyTo`, `replyPreview`, `editedAt`, `deleted`. `sendMessage` generates the UUID and includes `id` + `reply_to` in the emit + POST; sets it on the optimistic message.
- **Action affordance:** on a message row, hover/long‑press reveals the quick‑react bar (above) + the side ⋯. Quick‑react → toggle that emoji; "+" → an emoji‑picker popover. ⋯ → a menu (`Reply`; +`Edit`/`Delete` when `from === currentUser`).
- **Reactions:** pills under the bubble from `reactions`; click toggles. Optimistic, reconciled by `reaction_updated`.
- **Reply:** menu→Reply sets `replyingTo`; the composer renders the "Replying to <name>" chip; send includes `reply_to`; clear after. In‑thread, render the `reply_preview` quote above bubbles that have a `replyTo`; clicking it scrolls to + briefly highlights the original (if loaded).
- **Edit:** menu→Edit opens an inline edit (prefill the bubble text into the composer in "editing" mode or an inline field); PATCH on save; `(edited)` shows from `editedAt`.
- **Delete:** menu→Delete (confirm) → DELETE → the row renders the tombstone (`deleted`).
- **Socket handlers:** `reaction_updated` / `message_edited` / `message_deleted` patch the matching message (by `id`) in `chatHistory`.
- **SCSS:** hover toolbar, side ⋯, menu, reaction pills, reply quote (in‑thread + composer chip), tombstone, edit mode — all Atelier‑styled.

## Tests (`backend/tests/test_messages.py`)

- React toggles on/off; aggregation `{emoji,count,mine}`; non‑member → 403.
- Edit: owner updates body + sets `edited_at`; non‑owner → 403.
- Delete: owner sets `deleted_at` + blanks body; non‑owner → 403; the message still returns (with `deleted:true`).
- `client_message_id` backfill populates NULLs; create stores the provided id + `reply_to`; payloads include the new fields.

## Files touched

- **Backend:** `chat/database.py` (MessageReaction + Message columns + backfill), new `chat/messages.py`, `chat/chatfunc.py` + `chat/groups.py` (accept/return `client_message_id` + `reply_to`; message payloads include the new fields), `chat/__init__.py` (import messages); `tests/test_messages.py` (+ update existing message‑shape assertions).
- **Frontend:** `chat/chat.component.{ts,html,scss}`, `chat/conversation.ts` or a `message` model, possibly a small `emoji-picker` component.
- **Docs:** `CLAUDE.md`, `docs/evolution.md`.

## Scope note

This is sizable (a foundation + three features). The implementation plan sequences it: **(1) id foundation + payload fields → (2) reactions → (3) reply → (4) edit/delete → (5) docs**, each independently testable, so it can pause cleanly between features if needed.

## Risks / watch‑items

- **`client_message_id` consistency** across optimistic‑sender, persisted row, and live recipient — the linchpin; covered by threading the same UUID through all three.
- **Message‑shape change** (new fields) — update the existing backend message‑shape tests in lockstep.
- **Hover/long‑press UI** on the existing large `chat.component` thread — keep the affordance logic small and CSS‑driven where possible; ensure it doesn't fight the message‑grouping/auto‑scroll behavior.
- **Old messages** with backfilled ids are reactable, but a deleted/edited very old message is fine (soft markers only).
- **Emoji picker** — use a lightweight approach (a curated grid or a tiny library) rather than a heavy dependency.
