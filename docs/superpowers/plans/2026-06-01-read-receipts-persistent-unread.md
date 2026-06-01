# Read Receipts + Persistent Unread Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-backed unread counts (survive reload, count offline messages) and reader-avatar "seen" receipts for DMs and groups, powered by one `last_read_at` column per `ConversationMember`.

**Architecture:** Schema gets one column + idempotent migration. `conversations.py` gains mark-read / unread / read-state helpers. `chatfunc.py` + `groups.py` add mark-read endpoints (emitting `conversation_read`), put `unread_count` in `chats_history`, and change the two message endpoints to return `{messages, read_state}`. The frontend seeds unread from the server, calls mark-read on opening a visible conversation, and renders reader avatars under each reader's last-read message.

**Tech Stack:** Flask + Flask-SocketIO (SQLite), pytest, Angular 21, socket.io-client.

**Verification model:** Backend tasks gate on `pytest -q` GREEN; frontend on `npm run build` GREEN. Final: full pytest + build green + a two-account browser review. The message-endpoint shape change (array → `{messages, read_state}`) must update backend tests AND the frontend in the same tasks.

**Spec:** `docs/superpowers/specs/2026-06-01-read-receipts-persistent-unread-design.md`
**Branch:** `feature/read-receipts` (created; spec committed).

---

### Task 1: Schema column + read/unread helpers (backend)

**Files:** Modify `backend/chat/database.py`, `backend/chat/conversations.py`; Create `backend/tests/test_read.py`

- [ ] **Step 1:** In `database.py`, add `last_read_at TEXT` to the `CREATE TABLE ConversationMember` (fresh DBs) and an idempotent migration after `_create_conversation_schema()` runs (near the existing `UserProfile` backfill):

```python
cursor.execute("PRAGMA table_info(ConversationMember)")
if "last_read_at" not in {r[1] for r in cursor.fetchall()}:
    cursor.execute("ALTER TABLE ConversationMember ADD COLUMN last_read_at TEXT")
    connection.commit()
```

(Also add `last_read_at TEXT` to the column list in the `CREATE TABLE IF NOT EXISTS ConversationMember` statement so fresh DBs have it.)

- [ ] **Step 2:** In `conversations.py`, add helpers:

```python
def mark_read(cid: int, user_id: int, when_iso: str) -> None:
    cursor.execute(
        "UPDATE ConversationMember SET last_read_at=? WHERE conversation_id=? AND user_id=?",
        (when_iso, cid, user_id),
    )
    connection.commit()


def unread_count(cid: int, user_id: int) -> int:
    cursor.execute(
        "SELECT last_read_at FROM ConversationMember WHERE conversation_id=? AND user_id=?",
        (cid, user_id),
    )
    row = cursor.fetchone()
    last = row[0] if row else None
    if last is None:
        cursor.execute(
            "SELECT COUNT(*) FROM Message WHERE conversation_id=? AND sender_user_id!=?",
            (cid, user_id),
        )
    else:
        cursor.execute(
            "SELECT COUNT(*) FROM Message WHERE conversation_id=? AND sender_user_id!=? AND created_at>?",
            (cid, user_id, last),
        )
    return int(cursor.fetchone()[0])


def read_state(cid: int) -> list:
    cursor.execute(
        "SELECT u.username, m.last_read_at FROM ConversationMember m "
        "JOIN User u ON u.id = m.user_id WHERE m.conversation_id=?",
        (cid,),
    )
    return [{"username": r[0], "last_read_at": r[1]} for r in cursor.fetchall()]
```

- [ ] **Step 3:** Create `backend/tests/test_read.py` covering the helpers + that new members start NULL:

```python
from chat.conversations import (
    create_group_conversation,
    mark_read,
    read_state,
    unread_count,
)
from chat.database import connection, cursor


def _user(username):
    cursor.execute("INSERT INTO User (username, password) VALUES (?, 'x')", (username,))
    connection.commit()
    return cursor.lastrowid


def _msg(cid, sender_id, body, ts):
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at) VALUES (?,?,?,?)",
        (cid, sender_id, body, ts),
    )
    connection.commit()


def test_new_member_starts_unread_null_and_counts_all():
    a, b = _user("a"), _user("b")
    cid = create_group_conversation(a, "G", [b])
    _msg(cid, a, "hi", "2026-06-01T10:00:00")
    _msg(cid, a, "again", "2026-06-01T10:01:00")
    # b has never read -> both count; a's own never count
    assert unread_count(cid, b) == 2
    assert unread_count(cid, a) == 0


def test_mark_read_clears_unread():
    a, b = _user("a"), _user("b")
    cid = create_group_conversation(a, "G", [b])
    _msg(cid, a, "hi", "2026-06-01T10:00:00")
    mark_read(cid, b, "2026-06-01T10:30:00")
    assert unread_count(cid, b) == 0
    _msg(cid, a, "later", "2026-06-01T11:00:00")
    assert unread_count(cid, b) == 1


def test_read_state_shape():
    a, b = _user("a"), _user("b")
    cid = create_group_conversation(a, "G", [b])
    mark_read(cid, a, "2026-06-01T10:30:00")
    rs = {r["username"]: r["last_read_at"] for r in read_state(cid)}
    assert rs["a"] == "2026-06-01T10:30:00"
    assert rs["b"] is None
```

- [ ] **Step 4:** Run: `cd backend; .\.venv\Scripts\python.exe -m pytest tests/test_read.py -q` → Expected: PASS (3).
- [ ] **Step 5: Commit** `feat(backend): last_read_at column + read/unread helpers`

---

### Task 2: Mark-read endpoints, unread in history, read_state in messages (backend)

**Files:** Modify `backend/chat/chatfunc.py`, `backend/chat/groups.py`, `backend/tests/test_dm.py`, `backend/tests/test_groups.py`; extend `backend/tests/test_read.py`

- [ ] **Step 1:** In `chatfunc.py`, import the helpers (`mark_read, unread_count, read_state` alongside the existing `conversations` imports). Add the DM mark-read route:

```python
@app.route("/api/dm/<other_username>/read", methods=["POST"])
@jwt_required()
def mark_dm_read(other_username):
    me = get_jwt_identity()
    cursor.execute("SELECT id FROM User WHERE username=?", (me,))
    me_row = cursor.fetchone()
    cursor.execute("SELECT id FROM User WHERE username=?", (other_username,))
    other_row = cursor.fetchone()
    if not me_row or not other_row:
        return jsonify({"error": "Unknown user"}), 400
    cid = _direct_conversation_id_for_pair(int(me_row[0]), int(other_row[0]))
    if cid is None:
        return jsonify({"message": "no conversation"}), 200
    now = _utc_now_iso()
    mark_read(cid, int(me_row[0]), now)
    socketio.emit("conversation_read",
                  {"conversation_id": cid, "username": me, "last_read_at": now},
                  room=conversation_room(cid))
    return jsonify({"message": "ok", "last_read_at": now}), 200
```

- [ ] **Step 2:** In `chatfunc.py` `get_chats_history`, add `unread_count` to each DM and group entry. For DM peers, resolve the conversation id and call `unread_count(cid, me_id)`; for groups, call `unread_count(c.id, me_id)` (the group query already has `c.id`). Add `"unread_count": <n>` to each dict; self-entry gets `0`.
- [ ] **Step 3:** In `chatfunc.py` `get_dm_messages`, change the return to the new shape:

```python
return jsonify({"messages": formatted, "read_state": read_state(cid)})
```

(When `cid is None` early-returns, return `{"messages": [], "read_state": []}`.)

- [ ] **Step 4:** In `groups.py`, import helpers; add the group mark-read route + change group messages GET shape:

```python
@app.route("/api/groups/<int:cid>/read", methods=["POST"])
@jwt_required()
def mark_group_read(cid):
    uid, err = _require_member(cid)
    if err:
        return err
    now = _utc_now_iso()
    mark_read(cid, uid, now)
    socketio.emit("conversation_read",
                  {"conversation_id": cid, "username": get_jwt_identity(), "last_read_at": now},
                  room=conversation_room(cid))
    return jsonify({"message": "ok", "last_read_at": now}), 200
```

In `get_group_messages`, return `jsonify({"messages": [...], "read_state": read_state(cid)})` instead of the bare list.

- [ ] **Step 5:** Update existing tests for the new message shape: in `test_dm.py`, every `.get_json()` on a `/api/dm/messages/<x>` GET becomes `.get_json()["messages"]`. In `test_groups.py`, the `get_group_messages` reads become `["messages"]`.
- [ ] **Step 6:** Extend `test_read.py` with endpoint tests:

```python
def test_chats_history_has_unread(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    client.post("/api/dm/messages", json={"to_username": "bob", "body": "hi"},
                headers=alice["headers"])
    hist = client.get("/api/chats_history", headers=bob["headers"]).get_json()
    dm = next(e for e in hist if e.get("username") == "alice")
    assert dm["unread_count"] == 1
    client.post("/api/dm/alice/read", headers=bob["headers"])
    hist2 = client.get("/api/chats_history", headers=bob["headers"]).get_json()
    dm2 = next(e for e in hist2 if e.get("username") == "alice")
    assert dm2["unread_count"] == 0


def test_group_read_endpoint_and_state(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    client.post(f"/api/groups/{cid}/messages", json={"body": "yo"}, headers=alice["headers"])
    body = client.get(f"/api/groups/{cid}/messages", headers=alice["headers"]).get_json()
    assert "messages" in body and "read_state" in body
    assert client.post(f"/api/groups/{cid}/read", headers=alice["headers"]).status_code == 200
    # non-member can't mark read
    carol = make_user("carol")
    assert client.post(f"/api/groups/{cid}/read", headers=carol["headers"]).status_code == 403
```

- [ ] **Step 7:** Run: `cd backend; .\.venv\Scripts\python.exe -m pytest -q` → Expected: ALL PASS (existing + new).
- [ ] **Step 8: Commit** `feat(backend): mark-read endpoints, unread in history, read_state in messages`

---

### Task 3: Frontend — unread seeding, mark-read, reader-avatar receipts

**Files:** Modify `client/src/app/chat/chat.component.ts`, `chat.component.html`, `chat.component.scss`

- [ ] **Step 1:** `loadConversations()` — seed `unreadCount` from the server's `unread_count` (instead of forcing 0): in the `toEntry` mapping, set `e.unreadCount = raw.unread_count ?? (prevUnread.get(e.key) || 0)`. (Add `unread_count?: number` to `RawConversation` in `conversation.ts`.)
- [ ] **Step 2:** Message fetch shape — `selectConversation` now parses `{messages, read_state}`:

```typescript
this.http.get<any>(url, { headers: this.authHeaders() }).subscribe(
  (data) => {
    const messages = data?.messages ?? [];
    this.chatHistory = { ...this.chatHistory, [entry.key]: messages };
    this.applyReadState(entry.key, data?.read_state ?? []);
    this.scrollThreadToBottom();
    this.markRead(entry);
  },
  (error) => this.redirectIfUnauth(error)
);
```

- [ ] **Step 3:** Add read-state map + helpers in `chat.component.ts`:

```typescript
/** conversationKey -> { username -> lastReadAtISO|null } */
readState: { [key: string]: { [username: string]: string | null } } = {};

private applyReadState(key: string, rows: { username: string; last_read_at: string | null }[]): void {
  const m: { [u: string]: string | null } = {};
  for (const r of rows) m[r.username] = r.last_read_at;
  this.readState = { ...this.readState, [key]: m };
}

/** Mark the open conversation read (server) when the tab is visible. */
markRead(entry: ConversationEntry): void {
  if (document.hidden) return;
  const url = entry.kind === 'group'
    ? `/api/groups/${entry.conversationId}/read`
    : `/api/dm/${encodeURIComponent(entry.username || '')}/read`;
  this.http.post(url, {}, { headers: this.authHeaders() }).subscribe({ error: () => {} });
}

/** Readers (excluding sender + me) whose last_read >= this message AND for whom
 *  this is their latest-read message in the thread → avatar shown once. */
readersOf(thread: Message[], index: number): string[] {
  const key = this.selectedKey;
  const rs = this.readState[key];
  if (!rs) return [];
  const msg = thread[index];
  if (!msg) return [];
  const msgTime = new Date(msg.datetime).getTime();
  const result: string[] = [];
  for (const [username, lastRead] of Object.entries(rs)) {
    if (username === this.currentUser || username === msg.from || !lastRead) continue;
    if (new Date(lastRead).getTime() < msgTime) continue;
    // this message is the reader's latest-read one if the NEXT message is unread by them
    const next = thread[index + 1];
    if (next && new Date(lastRead).getTime() >= new Date(next.datetime).getTime()) continue;
    result.push(username);
  }
  return result;
}
```

- [ ] **Step 4:** Socket listener — in the constructor's socket setup, add:

```typescript
this.socket.on('conversation_read', (data: any) => this.zone.run(() => {
  const cid = data?.conversation_id;
  const username = data?.from ?? data?.username;
  if (cid == null || !username) return;
  const key = `conv:${cid}`;
  // groups keyed by conv:<id>; DMs keyed by username — update whichever exists
  for (const k of [key, ...Object.keys(this.readState)]) {
    if (this.readState[k] && username in this.readState[k]) {
      this.readState = { ...this.readState, [k]: { ...this.readState[k], [username]: data.last_read_at } };
    }
  }
}));
```

(Note: the backend sends `username`; keep the `data.username` path.)

- [ ] **Step 5:** Template — under each message row, render reader avatars:

```html
@if (message.from === currentUser && readersOf(thread, i).length) {
  <div class="seen-row">
    @for (r of readersOf(thread, i); track r) {
      <app-avatar [name]="r" [seed]="r" [size]="16"></app-avatar>
    }
  </div>
}
```

(Place it right after the `.message-row` closing, inside the `@for`.)

- [ ] **Step 6:** SCSS:

```scss
.seen-row {
  display: flex;
  justify-content: flex-end;
  gap: 3px;
  margin: 2px 2px 0;
}
```

- [ ] **Step 7:** `cd client; npm run build` → Expected: GREEN.
- [ ] **Step 8: Commit** `feat(client): server unread + reader-avatar read receipts`

---

## Final verification (after Task 3)

`cd backend && pytest -q` → all green. `cd client && npm run build` → green. Start both servers; with **two accounts**: send a message → the other's sidebar shows a persistent unread badge that **survives reload**; open the conversation → the sender sees the **reader's avatar** appear under their last message; in a group, multiple readers' avatars appear ("Seen by N"). Present to the user before push.

## Self-review notes
- **Spec coverage:** schema+migration (T1) ✓ helpers (T1) ✓ mark-read endpoints + conversation_read (T2) ✓ unread in history (T2) ✓ read_state in messages + shape change w/ test updates (T2) ✓ frontend unread seed + mark-read + readersOf + socket + render (T3) ✓ tests (T1,T2) ✓.
- **Consistency:** `mark_read`/`unread_count`/`read_state` defined in T1, used in T2; `{messages, read_state}` shape produced in T2 and consumed in T3; `conversation_read` payload `{conversation_id, username, last_read_at}` emitted in T2, handled in T3; `unread_count` server field seeds `entry.unreadCount` in T3.
- **No placeholder:** all code blocks complete; test updates spelled out.
