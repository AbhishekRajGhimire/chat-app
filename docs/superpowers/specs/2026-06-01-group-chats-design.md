# Group Chats — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-01)
**Phase:** Phase 5, Sub-project 1 of 3 (Group chats → Read receipts/persistent unread → Notifications+PWA)
**Branch target:** new branch off `main`

---

## Goal

Add multi-person group conversations alongside DMs, delivered in real time. The database is already conversation-first, so the core work is refactoring Socket.IO delivery from username-keyed rooms to per-conversation rooms, adding group REST endpoints, and building the group UI. Also lay a non-functional placeholder for future video calling.

## Decisions (from brainstorming)

- **Membership model:** flat / everyone equal. Anyone in a group can add/remove members and rename it. `created_by_user_id` is still stored (for display/history), just not enforced.
- **Create flow:** a dedicated "New group" dialog (name + multi-select members).
- **In-group attribution:** received messages show a small **sender avatar + colored sender name**; the user's own messages stay plain plum on the right.
- **Sidebar:** one unified, recency-sorted list of DMs + groups.
- **Video calling:** placeholder only this phase (disabled control + roadmap note); real WebRTC implementation is a separate future sub-project.

## Non-goals / YAGNI

- No roles/permissions enforcement (flat model).
- No persistent/cross-device unread or read receipts (next sub-project; groups use the existing client-only unread for now).
- No message reactions/replies/edits, no attachments.
- No multi-process/worker support (in-memory presence unchanged; still single-process).
- No actual video calling — placeholder UI + roadmap note only.

---

## 1. Data model — no schema change

The existing schema already supports groups:
- `Conversation(type='group', title, created_by_user_id, …)`
- `ConversationMember(conversation_id, user_id, role DEFAULT 'member', joined_at)` — every member inserted as `member`; role unused for permissions in v1.
- `Message(conversation_id, sender_user_id, body, created_at)` — group messages are messages with a group `conversation_id`.

No migration required. (`conversations.py` already has DM helpers; group helpers are added alongside.)

## 2. Socket.IO: per-conversation rooms (the keystone)

**Today:** `connect` does `join_room(username)`; `send_message` emits `receive_message` to `room=recipient_username`. This cannot fan out to a group.

**New model:**
- A helper `conversation_room(cid)` → `f"conv:{cid}"`.
- On `connect` (after auth), in addition to `join_room(username)`, query all conversations the user is a member of and `join_room(conversation_room(cid))` for each.
- All message delivery emits `receive_message` to `room=conversation_room(cid)`. DMs are delivered the same way (their 2-member conversation room), replacing username-room message delivery. The username room is retained for presence (`online_users`) and for signaling brand-new conversations to a user who isn't in the new room yet.
- **Live membership:** when a group is created or a member is added, for each affected member who is currently connected, the server calls `socketio.server.enter_room(sid, conversation_room(cid))` (looked up via `online_users`/`socket_user_by_sid`) so they join the room **without reconnecting**. It also emits a `conversation_added` event to those users' username rooms so the client inserts the conversation into the sidebar live.
- The `receive_message` payload gains conversation identity so the client routes it: `{ conversation_id, kind: 'direct'|'group', from, message, datetime, ... }`. For DMs the client may continue to key by peer username; for groups it keys by `conversation_id`.

**Security:** sender identity still comes only from the socket session (never trust a client `from`). Membership is checked server-side before delivering/sending to a conversation.

## 3. Backend REST endpoints (`backend/chat/`)

Add a `groups.py` module (keep `chatfunc.py` from growing unwieldy) with these JWT-protected routes; reuse `conversations.py` helpers:

- `POST /api/groups` `{ "title": str, "members": [username, …] }` → create `Conversation(type='group')`, insert `ConversationMember` rows for creator + listed members (deduped, must exist), enter online members into the room, emit `conversation_added`. Returns the group summary.
- `GET /api/groups/<cid>` → group detail: `{ id, title, members: [{username, display_name}], created_by }`. Caller must be a member (else 403).
- `PATCH /api/groups/<cid>` `{ "title": str }` → rename (member-only).
- `POST /api/groups/<cid>/members` `{ "members": [username, …] }` → add members (member-only); enter their online sockets into the room; emit `conversation_added` to them.
- `DELETE /api/groups/<cid>/members/<username>` → remove a member (member-only); the removed member's online sockets leave the room; emit `conversation_removed` to them.
- `POST /api/groups/<cid>/leave` → remove self.
- `GET /api/groups/<cid>/messages` / `POST /api/groups/<cid>/messages` `{ "body": str }` → group history + send (member-only). POST persists then emits `receive_message` to the conversation room (mirrors the DM dual-path, but socket emit is server-side here).

**Unified conversation list:** extend `GET /api/chats_history` to return groups too. Each entry tagged:
```json
{ "kind": "direct", "username": "amelia", "display_name": "Amelia Hart",
  "last_message": "...", "last_message_at": "..." }
{ "kind": "group", "conversation_id": 12, "title": "Design crew", "member_count": 4,
  "last_message": "...", "last_message_at": "..." }
```
Sorted client-side by recency (existing `sortedChatUsers` generalized).

## 4. Frontend (`client/src/app/`)

- **Conversation model:** generalize the sidebar entry to a discriminated shape `{ kind: 'direct'|'group', key, displayName, lastMessage?, lastMessageAt?, unreadCount?, memberCount?, conversationId? }` where `key` is the username (DM) or `conv:<id>` (group). `chat.component.ts` builds this from the unified `chats_history`.
- **New group dialog:** an Angular Material `MatDialog` component (`group-create-dialog`) with a title input + multi-select member list (reusing `directoryUsers`); on submit calls `POST /api/groups`, then selects the new group. A "New group" button sits beside "New Chat" in the sidebar.
- **Selecting a conversation:** `selectConversation(entry)` replaces the username-only `selectUser`; fetches `GET /api/groups/<cid>/messages` for groups or the DM endpoint for direct, and sets the open conversation key.
- **Group conversation view:** header with monogram avatar + title + member count (opens a member list/management sheet) + the disabled **"🎥 Call — soon"** placeholder; thread renders **sender avatar + colored name** above each new run of received messages (color derived from the existing avatar hash); own messages unchanged.
- **Incoming routing:** the `receive_message` handler routes by `conversation_id`/`kind` from the payload — appending to the group thread keyed by conversation id, or the DM thread keyed by username. Unread/typing/live-add logic generalized to work for both kinds.
- **Typing in groups:** `typing`/`peer_typing` payloads carry the conversation; the dot bubble shows "<name> is typing" scoped to the open conversation.
- **Member management:** a simple sheet listing members with add (from directory) / remove / leave actions calling the endpoints above.

## 5. Video calling placeholder

- A disabled call control (video icon, label/tooltip "Video calling — coming soon") in both DM and group conversation headers.
- A roadmap entry in `docs/evolution.md` describing the intended approach (WebRTC peer connections with Socket.IO signaling) as a future sub-project.
- No signaling, no media, no library added.

## Files touched

**Backend**
- Create: `backend/chat/groups.py` — group REST endpoints + helpers
- Modify: `backend/chat/conversations.py` — `create_group_conversation`, member helpers, `conversation_room`
- Modify: `backend/chat/chatfunc.py` — per-conversation room join on connect; conversation-room delivery; unified `chats_history`; conversation-aware `send_message`/`typing`; live `enter_room`/`conversation_added`
- Modify: `backend/chat/__init__.py` — import `groups`

**Frontend**
- Modify: `client/src/app/chat/chat.component.{ts,html,scss}` — unified list, group view, attribution, routing, member sheet
- Create: `client/src/app/chat/group-create-dialog/*` — new-group dialog component
- Modify: `client/src/app/app.module.ts` — declare the dialog, import `MatDialogModule`
- Modify: `client/src/app/profile.service.ts` (or a new `conversation` model file) — conversation entry types
- Modify: `docs/evolution.md` — video-calling roadmap note

## Error handling

- Membership enforced server-side on every group read/write (403 otherwise); existing 401/422 → `/signin` preserved client-side.
- Creating a group requires ≥1 other valid member; unknown usernames rejected.
- Removing/leaving updates rooms so stale sockets stop receiving.
- DM behavior (unread, typing, live-new-conversation, retry) must remain intact after the rooms refactor — explicit regression check.

## Testing / verification

Per `CLAUDE.md`, this is heavy runtime behavior (socket refactor + new routes + components). Verify in the browser with **three accounts**: create a group, all members receive messages live, sender attribution shows correctly, add/remove/leave updates membership live, a brand-new group appears for invitees without reload, and **DMs still work** (send/receive/typing/unread). Build stays green (`npm run build`).

## Risks / watch-items

- **Rooms refactor regressions** on DM delivery — the top risk; test DM + group paths together.
- **Live join via `enter_room`** depends on knowing members' current sids (`online_users`/`socket_user_by_sid`); members offline at add-time simply join on their next connect.
- **Single shared SQLite connection** under more concurrent socket traffic — unchanged assumption; keep queries short.
- `chat.component.ts` is already large; the new dialog is split into its own component, and group REST lives in `groups.py`, to avoid bloating existing files.
