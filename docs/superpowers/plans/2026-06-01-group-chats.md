# Group Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time multi-person group conversations alongside DMs, by refactoring Socket.IO delivery to per-conversation rooms, adding group REST endpoints, and building the group UI (unified sidebar, New-group dialog, avatar+name attribution, video-call placeholder).

**Architecture:** No DB schema change (schema is already conversation-first). Backend: per-conversation Socket.IO rooms (`conv:<id>`), a new `groups.py` for group REST, group helpers in `conversations.py`, and conversation-aware delivery in `chatfunc.py`. Frontend: a discriminated conversation model (direct|group), a Material dialog for group creation, and conversation-routed message handling in `chat.component.ts`.

**Tech Stack:** Flask + Flask-SocketIO (SQLite, single connection), Angular 21 (NgModules), Angular Material (MatDialog), socket.io-client.

**Verification model:** Each client task ends with `npm run build` GREEN; backend boots clean (FLASK_DEBUG=true dev). No per-task browser check (user waived); final review with **three accounts** after the last task, including a DM regression pass. `npm test` is the pre-existing-broken suite and is NOT a gate.

**Spec:** `docs/superpowers/specs/2026-06-01-group-chats-design.md`
**Branch:** `feature/group-chats` (created; spec committed).

---

### Task 1: Group + room helpers in `conversations.py`

**Files:** Modify `backend/chat/conversations.py`

- [ ] **Step 1:** Add helpers (reuse the module's `connection`, `cursor`, `_utc_now_iso`):

```python
def conversation_room(cid: int) -> str:
    return f"conv:{int(cid)}"


def user_conversation_ids(user_id: int) -> list[int]:
    cursor.execute(
        "SELECT conversation_id FROM ConversationMember WHERE user_id = ?",
        (user_id,),
    )
    return [int(r[0]) for r in cursor.fetchall()]


def is_member(cid: int, user_id: int) -> bool:
    cursor.execute(
        "SELECT 1 FROM ConversationMember WHERE conversation_id = ? AND user_id = ?",
        (cid, user_id),
    )
    return cursor.fetchone() is not None


def group_members(cid: int) -> list[dict]:
    cursor.execute(
        """
        SELECT u.username, COALESCE(NULLIF(TRIM(p.display_name],''), u.username)
        FROM ConversationMember m
        JOIN User u ON u.id = m.user_id
        LEFT JOIN UserProfile p ON p.user_id = u.id
        WHERE m.conversation_id = ?
        ORDER BY u.username
        """,
        (cid,),
    )
    return [{"username": r[0], "display_name": r[1]} for r in cursor.fetchall()]


def create_group_conversation(creator_id: int, title: str, member_ids: list[int]) -> int:
    now = _utc_now_iso()
    cursor.execute(
        "INSERT INTO Conversation (type, title, created_at, created_by_user_id) "
        "VALUES ('group', ?, ?, ?)",
        (title, now, creator_id),
    )
    cid = int(cursor.lastrowid)
    ids = {creator_id, *member_ids}
    for uid in ids:
        cursor.execute(
            "INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at) "
            "VALUES (?, ?, 'member', ?)",
            (cid, uid, now),
        )
    connection.commit()
    return cid
```

(Fix the obvious typo when writing: `COALESCE(NULLIF(TRIM(p.display_name),''), u.username)`.)

- [ ] **Step 2:** Restart backend, confirm boot. **Commit** `feat(backend): group + conversation-room helpers`

---

### Task 2: Per-conversation rooms + unified list in `chatfunc.py`

**Files:** Modify `backend/chat/chatfunc.py`

- [ ] **Step 1:** Import helpers: `from .conversations import (... conversation_room, user_conversation_ids, is_member, group_members)` and `from .database import connection, cursor`.
- [ ] **Step 2:** On connect, join all the user's conversation rooms. In `_register_socket_presence` (or `on_connect` after it), add:

```python
cursor.execute("SELECT id FROM User WHERE username=?", (username,))
row = cursor.fetchone()
if row:
    for cid in user_conversation_ids(int(row[0])):
        join_room(conversation_room(cid))
```

- [ ] **Step 3:** Add a module helper to push a (possibly offline) member into a live room + notify them:

```python
def add_user_to_live_room(username: str, cid: int) -> None:
    room = conversation_room(cid)
    for uname, sid in online_users:
        if uname == username and sid:
            socketio.server.enter_room(sid, room)
    socketio.emit("conversation_added", {"conversation_id": cid}, room=username)
```

- [ ] **Step 4:** Refactor `post_dm_message` to also emit to the conversation room so the peer gets it live via the unified path (in addition to existing persistence). After `connection.commit()`:

```python
emit_payload = {
    "conversation_id": cid, "kind": "direct",
    "from": me_username, "message": body, "datetime": now,
}
socketio.emit("receive_message", emit_payload, room=conversation_room(cid))
```

- [ ] **Step 5:** Extend `get_chats_history` to also return group conversations, tagged `kind`. Add after the DM peers query a groups query:

```python
cursor.execute(
    """
    SELECT c.id, c.title, COUNT(cm2.user_id) AS member_count,
        (SELECT m.body FROM Message m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
        (SELECT m.created_at FROM Message m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1)
    FROM Conversation c
    JOIN ConversationMember cm ON cm.conversation_id=c.id AND cm.user_id=?
    JOIN ConversationMember cm2 ON cm2.conversation_id=c.id
    WHERE c.type='group'
    GROUP BY c.id
    """,
    (me_id,),
)
groups = [
    {"kind": "group", "conversation_id": int(r[0]), "title": r[1] or "Group",
     "member_count": int(r[2]), "last_message": r[3], "last_message_at": r[4]}
    for r in cursor.fetchall()
]
```

Tag each DM peer dict with `"kind": "direct"` and return `peers + groups + [self_entry]` (self stays `kind:'direct'`).

- [ ] **Step 6:** Extend the socket `typing` handler to carry a conversation room for groups: accept `data.get("conversation_id")`; if present and the sender is a member, `emit("peer_typing", {"from": sender, "conversation_id": cid}, room=conversation_room(cid), include_self=False)`; else keep the existing DM `recipient` username path (add `conversation_id: null`, `kind:'direct'` to its payload for client routing).
- [ ] **Step 7:** Restart backend, confirm boot + existing DM still works. **Commit** `feat(backend): per-conversation rooms, unified history, live join`

---

### Task 3: Group REST endpoints in `groups.py`

**Files:** Create `backend/chat/groups.py`; Modify `backend/chat/__init__.py`

- [ ] **Step 1:** Create `groups.py` with JWT routes (member checks via `is_member`), using `create_group_conversation`, `group_members`, `add_user_to_live_room`, `conversation_room`. Routes:
  - `POST /api/groups` — validate `title` non-empty and `members` resolve to ≥1 real user; create; `add_user_to_live_room` for each member; return `{id, title, members, member_count}`.
  - `GET /api/groups/<int:cid>` — 403 if caller not member; return detail.
  - `PATCH /api/groups/<int:cid>` — rename (member-only).
  - `POST /api/groups/<int:cid>/members` — add members (member-only) + `add_user_to_live_room`.
  - `DELETE /api/groups/<int:cid>/members/<username>` — remove (member-only); `socketio.emit("conversation_removed", {"conversation_id": cid}, room=username)`.
  - `POST /api/groups/<int:cid>/leave` — remove self.
  - `GET /api/groups/<int:cid>/messages` — member-only; return `[{from, message, datetime}]` (join sender username) like `get_dm_messages`.
  - `POST /api/groups/<int:cid>/messages` — member-only; insert Message; `socketio.emit("receive_message", {conversation_id, kind:'group', from, message, datetime}, room=conversation_room(cid))`; return 201.
- [ ] **Step 2:** In `__init__.py`, add `from chat import groups` alongside the other imports.
- [ ] **Step 3:** Restart backend, confirm boot. **Commit** `feat(backend): group REST endpoints`

---

### Task 4: Frontend conversation model + unified sidebar

**Files:** Modify `client/src/app/chat/chat.component.ts`, `chat.component.html`, `chat.component.scss`; create `client/src/app/chat/conversation.ts`

- [ ] **Step 1:** Create `conversation.ts`:

```typescript
export interface ConversationEntry {
  kind: 'direct' | 'group';
  key: string;                 // username (direct) or 'conv:<id>' (group)
  displayName: string;
  username?: string;           // direct only
  conversationId?: number;     // group only
  memberCount?: number;        // group only
  last_message?: string | null;
  last_message_at?: string | null;
  unreadCount?: number;
}
```

- [ ] **Step 2:** Build `conversations: ConversationEntry[]` from the unified `chats_history` (map `kind:'direct'` → key=username, `kind:'group'` → key=`conv:<id>`, conversationId, memberCount). Replace `sortedChatUsers` with `sortedConversations` (same recency sort, self last). Add `selectedKey: string` replacing `selectedUser` for routing (keep `selectedUser` as a derived username for DM-only code paths, or migrate fully).
- [ ] **Step 3:** Update the sidebar `@for` to iterate `sortedConversations`; render a group monogram (first letters of title) vs `app-avatar` for direct; show `memberCount` hint for groups; preview/time/badge unchanged.
- [ ] **Step 4:** `npm run build` GREEN. **Commit** `feat(client): unified conversation model + sidebar (DMs + groups)`

---

### Task 5: New-group dialog

**Files:** Create `client/src/app/chat/group-create-dialog/group-create-dialog.component.{ts,html,scss}`; Modify `app.module.ts`, `chat.component.{ts,html}`

- [ ] **Step 1:** Generate a `MatDialog` component with a title input + a checkbox list of `directoryUsers` (passed in via `MAT_DIALOG_DATA`), returning `{ title, members: string[] }` on create (disabled until title non-empty and ≥1 member).
- [ ] **Step 2:** Declare it in `app.module.ts`; import `MatDialogModule`, `MatCheckboxModule`.
- [ ] **Step 3:** Add a "New group" button in the sidebar; `openNewGroup()` opens the dialog, and on result POSTs `/api/groups`, then selects the returned group.
- [ ] **Step 4:** `npm run build` GREEN. **Commit** `feat(client): new-group dialog`

---

### Task 6: Group conversation view + attribution + routing

**Files:** Modify `client/src/app/chat/chat.component.{ts,html,scss}`

- [ ] **Step 1:** `selectConversation(entry)` replaces `selectUser`: for `group`, GET `/api/groups/<id>/messages`; for `direct`, the DM endpoint. Store messages keyed by `entry.key`.
- [ ] **Step 2:** Header: monogram + title + "N members" + member sheet trigger for groups; existing avatar + name for DMs. Add the disabled video-call control to both: `<button mat-icon-button disabled matTooltip="Video calling — coming soon"><mat-icon>videocam</mat-icon></button>`.
- [ ] **Step 3:** Thread attribution for groups: for received messages, show `app-avatar` (size 24) + a colored sender name above each new run (color from the avatar hash). Own messages unchanged. Add `senderColor(name)` mirroring the avatar palette hash.
- [ ] **Step 4:** Route incoming `receive_message` by payload: groups → append to thread keyed by `conv:<conversation_id>` and update that conversation entry; direct → existing username path. Generalize unread/live-add/typing-clear to use `key`. Listen for `conversation_added` (refetch `chats_history`) and `conversation_removed` (drop the entry).
- [ ] **Step 5:** Typing: emit `{ conversation_id }` for groups (else `{ recipient }` for DMs); `peer_typing` with a `conversation_id` shows the dot bubble in the matching open group.
- [ ] **Step 6:** `npm run build` GREEN. **Commit** `feat(client): group conversation view, attribution, message routing`

---

### Task 7: Member sheet + video placeholder note

**Files:** Modify `client/src/app/chat/chat.component.{ts,html}`, `docs/evolution.md`

- [ ] **Step 1:** A simple member panel for the open group: list members, add (from directory), remove, and "Leave group" — calling the endpoints; refresh on success.
- [ ] **Step 2:** Add a "Video calling (planned)" subsection to `docs/evolution.md` describing the WebRTC-over-Socket.IO signaling approach as a future sub-project.
- [ ] **Step 3:** `npm run build` GREEN. **Commit** `feat(client): group member management + video roadmap note`

---

## Final review (after Task 7)

Restart both processes. With **three browser sessions** (three accounts): create a group from one → it appears live for the others (no reload); messages from each show correct avatar+name attribution and arrive live for all; add/remove/leave updates membership live; the video control shows the disabled "coming soon" tooltip. **DM regression:** confirm DM send/receive, typing, unread badges, and live-new-conversation still work. Build green. Present to the user for approval before push.

## Self-review notes
- **Spec coverage:** rooms refactor (T1,T2) ✓ group endpoints (T3) ✓ unified list/sidebar (T2,T4) ✓ new-group dialog (T5) ✓ group view + attribution + routing (T6) ✓ member mgmt (T7) ✓ video placeholder (T6,T7) ✓ no schema change ✓.
- **Type consistency:** `conversation_room`/`user_conversation_ids`/`is_member`/`group_members`/`create_group_conversation`/`add_user_to_live_room` defined in T1–T2 and used in T3; `ConversationEntry` (T4) used in T4–T6; events `receive_message`(+conversation_id,kind)/`conversation_added`/`conversation_removed`/`peer_typing`(+conversation_id) consistent backend (T2,T3) ↔ client (T6).
- **No fabricated tests:** build-green + three-account browser review per the user's waiver; DM regression explicitly included.
