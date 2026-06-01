# Chat UX Improvements — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-01)
**Phase:** Phase 4 — UX behavior (follows Phase 3 Aubergine Atelier visual system)
**Branch target:** new branch off `main`

---

## Goal

Make the chat *feel* reliable and alive: a smart conversation list (unread + recency + preview), messages that never silently vanish, conversations that appear the moment someone writes you, and a live typing indicator. Four features, one cohesive change, **no database schema migration**.

## Scope (the four features)

1. Conversation list: **recency sort + last-message preview + unread count badge** (style A — gold count pill).
2. **Unread tracking — client-only** (resets on reload; live socket messages increment).
3. **Live new conversations** — a chat from someone not yet in the sidebar appears immediately.
4. **Reliable send** — failed messages stay put with a Retry affordance instead of being deleted.
5. **Typing indicator** — style A (animated three-dot bubble), relayed over Socket.IO.

## Non-goals / YAGNI

- No persistent or cross-device unread state (no `last_read` schema). Accepted tradeoff: counts reset on reload and don't include messages received while the tab was fully closed.
- No delivery/read receipts ("sent/delivered" ticks on normal messages).
- No push/browser notifications beyond the **tab-title unread count**.
- No backend schema change of any kind. The only backend edits are a read-only query enhancement and one new socket relay handler.

---

## 1. Conversation list — recency, preview, unread badge

### Backend — `backend/chat/chatfunc.py`, `GET /api/chats_history` (read-only)
Enhance the existing peer query to also return each direct conversation's **last message body and timestamp**. Use a correlated lookup against existing `Message` rows (e.g. the latest `created_at` per conversation and its body) joined to the peer rows already produced. Return shape per entry becomes:
```json
{ "username": "amelia", "display_name": "Amelia Hart",
  "last_message": "Gold foil was the right call.", "last_message_at": "2026-06-01T09:43:00+00:00" }
```
`last_message`/`last_message_at` are `null` when a conversation has no messages yet. No new tables, no columns — purely a richer SELECT. The self-entry keeps `last_message: null`.

### Frontend — `client/src/app/chat/chat.component.ts`
- Extend the sidebar entry model (local interface, and optional fields on `DirectoryUser` in `profile.service.ts`) with: `lastMessage?: string | null`, `lastMessageAt?: string | null`, `unreadCount?: number`.
- Populate `lastMessage`/`lastMessageAt` from the enhanced `chats_history` payload; initialize `unreadCount = 0`.
- Add a getter `sortedChatUsers` that returns `chatUsers` ordered by `lastMessageAt` descending (entries with no timestamp sort last; the self-entry sorts last). The template iterates `sortedChatUsers` instead of `chatUsers`.
- Add a relative-time helper `listTime(iso)` → `9:43`, `Tue`, `Mon`, or a short date, for the row's right-aligned timestamp.

### Frontend — `chat.component.html` / `.scss`
- DM row gains a preview line (`dm-row__preview`, ellipsised) and a right-hand meta column (`dm-row__time` + `dm-row__badge`).
- The **gold count badge** (`.dm-row__badge`) renders only when `entry.unreadCount > 0`, showing the number; unread rows get bolder name + brighter preview (`.dm-row.is-unread`).

## 2. Unread tracking — client-only

In `receive_message` (already in the constructor):
- After appending the incoming message to `chatHistory[from]`, find the matching `chatUsers` entry and set `lastMessage`/`lastMessageAt` from the payload.
- If `from !== selectedUser` **or** `document.hidden`, increment that entry's `unreadCount`.
- If `from === selectedUser` and the tab is visible, leave `unreadCount` at 0 and scroll to bottom (existing behavior).

In `selectUser(username)`:
- Set the matching entry's `unreadCount = 0` (mark read on open).

**Tab title:** maintain `totalUnread = sum(unreadCount)`. A small effect sets `document.title = totalUnread > 0 ? '(' + totalUnread + ') Rojin' : 'Rojin : the org chat'`. Recompute whenever `unreadCount` changes (on receive and on select). Restore the base title in `ngOnDestroy`.

## 3. Live new conversations

In `receive_message`, before/while updating state: if no `chatUsers` entry exists for `from`:
- Resolve display name from `directoryUsers` (fallback to the username).
- Push a new entry `{ username: from, display_name, lastMessage, lastMessageAt, unreadCount: 1 }` into `chatUsers`.
This mirrors the existing "add to chatUsers on successful send" logic, applied to the receive path. The new entry sorts to the top via `sortedChatUsers`.

## 4. Reliable send — failed state + retry

### Message model
Extend the local `Message` interface with `status?: 'sending' | 'sent' | 'failed'`. Optimistically-appended outgoing messages start as `'sending'`; received messages have no status (treated as `sent`).

### Send path — `sendMessage()`
- Keep the optimistic append, but tag the appended message `status: 'sending'`.
- On HTTP **success**: set that message's `status = 'sent'` (no visible tick — status drives only the failed UI).
- On HTTP **error**: **do not remove** the message. Set its `status = 'failed'`. Keep the existing 401/422 → `/signin` redirect.
- Identify the message to update by reference/identity within `chatHistory[peer]` (the current last-message match logic, but flipping status instead of slicing).

### Retry — `retryMessage(peer, msg)`
- Guard against double-retry; set `msg.status = 'sending'`.
- Re-emit the socket `send_message` and re-POST `/api/dm/messages` with the same `to_username`/`body`.
- Success → `status = 'sent'`; failure → `status = 'failed'`.

### Template / styles
- A `--sent` bubble with `status === 'failed'` renders the muted error tint (`.message-bubble--failed`) plus a `.message-failed` row beneath it: "⚠ Couldn't send · ↻ Retry" calling `retryMessage(...)`.
- Error tint color must stay readable on the canvas; verify AA in the build (error text `#a23b4d` family on canvas).

## 5. Typing indicator — animated dot bubble (A)

### Backend — `backend/chat/chatfunc.py`
New handler:
```python
@socketio.on('typing')
def handle_typing(data):
    sender = socket_user_by_sid.get(request.sid)
    if not sender:
        return
    data = data or {}
    recipient = data.get('recipient')
    if isinstance(recipient, str) and recipient.strip():
        emit('peer_typing', {'from': sender}, room=recipient.strip())
```
Sender identity comes only from the socket session (same trust model as `send_message`; never trust a client-supplied `from`). The event carries no message content. Out of scope: a "stopped typing" event — the client self-expires (below).

### Frontend — `chat.component.ts`
- Composer `(input)` (or within `onComposerKeydown`) calls `notifyTyping()`, **throttled** to emit `typing` at most once per ~2s while the user is actively typing, only when `selectedUser` is set.
- Listen for `peer_typing`: when `data.from === selectedUser`, set `typingFrom = data.from` and (re)start a ~3s timer that clears `typingFrom`. Clear immediately when a `receive_message` from that user arrives, and on `selectUser` change.
- Expose `isPeerTyping` (`typingFrom === selectedUser`).

### Frontend — `chat.component.html` / `.scss`
- At the bottom of the open thread (after the `@for`, inside `.chat-container`), render `@if (isPeerTyping)` a `.typing-bubble` with three `<i>` dots.
- `.typing-bubble` styled like a received bubble; dots animate via a `bounce` keyframe gated behind `prefers-reduced-motion: no-preference` (reduced-motion shows static dots).

---

## Files touched

- `backend/chat/chatfunc.py` — `chats_history` last-message fields; new `typing` → `peer_typing` relay
- `client/src/app/chat/chat.component.ts` — entry model, `sortedChatUsers`, `listTime`, unread + tab title, live-add, message `status` + `retryMessage`, typing throttle/listen
- `client/src/app/chat/chat.component.html` — preview/time/badge, failed bubble + retry, typing bubble
- `client/src/app/chat/chat.component.scss` — `.dm-row__preview/time/badge`, `.is-unread`, `.message-bubble--failed` + `.message-failed`, `.typing-bubble`
- `client/src/app/profile.service.ts` — optional `last_message`/`last_message_at`/`unreadCount` on `DirectoryUser`

## Error handling

- Failed sends surface visibly (no silent loss) and are retryable.
- `chats_history` enhancement tolerates conversations with no messages (`null` preview/time).
- Typing relay ignores unauthenticated sockets and missing/blank recipients.
- All existing 401/422 → `/signin` redirects preserved.

## Testing / verification

Per `CLAUDE.md`, this touches runtime behavior (a socket handler, a route, the chat component). Verify in the browser before commit: two accounts, send/receive across them to exercise unread badges, recency reorder, live new conversation, typing indicator, and a forced failed-send (e.g. stop the backend mid-send) → retry. Build must stay green (`npm run build`).

## Risks / watch-items

- **Throttle correctness:** typing emits must be throttled, not per-keystroke, to avoid socket spam.
- **AA contrast** on the failed-bubble error tint — verify.
- **Tab-title restore** on destroy so navigating away doesn't leave a stale `(n)`.
- `chats_history` query: keep it a single round trip; avoid N+1 per peer.
