# Messaging Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add emoji reactions, reply/quote, and edit/delete-own-message actions to the chat thread (DMs + groups), live across clients.

**Architecture:** A client-generated `client_message_id` (UUID) becomes every message's stable public id, threaded through the *existing* socket-emit + POST send paths (no delivery refactor). Three new REST endpoints (react / edit / delete) key on that id, verify conversation membership (and ownership for edit/delete), and broadcast `reaction_updated` / `message_edited` / `message_deleted` to the per-conversation Socket.IO room (`conv:<id>`) that both DM participants and group members already join on connect. A shared `serialize_messages()` helper gives history + live payloads identical shapes.

**Tech Stack:** Flask + Flask-SocketIO + SQLite (backend), Angular 21 / NgModules / socket.io-client (frontend), pytest (backend tests).

---

## Background the engineer needs

- **One shared SQLite connection** (`backend/chat/database.py` exports `connection`, `cursor`). All handlers reuse it; `cursor.execute(...)` then `connection.commit()`. No ORM.
- **Message table** already has a nullable `client_message_id TEXT` column (currently unused). `id` is the autoincrement PK; `conversation_id`, `sender_user_id`, `body`, `created_at` are the rest.
- **Per-conversation rooms:** `conversations.conversation_room(cid)` → `"conv:<cid>"`. On socket connect (`chatfunc.on_connect`) every user joins `conv:<id>` for every conversation they belong to. So emitting to `conversation_room(cid)` reaches both DM users and all group members. (Caveat: a conversation created mid-session isn't joined until the next connect — history is always correct, only live action events for a brand-new conversation may wait for a reload. This matches the existing DM-delivery caveat; do not try to "fix" it here.)
- **Sender identity** on sockets comes only from `socket_user_by_sid[request.sid]` — never trust a client-supplied user field.
- **Tests:** `backend/tests/conftest.py` sets `CHAT_DB_PATH` to a temp DB and wipes tables between tests. `make_user("alice")` returns `{"username", "headers"}` with a Bearer token. Run: `cd backend; pytest -q`.
- **Frontend auth:** every HTTP call builds `Authorization: Bearer` by hand via `this.authHeaders()`. No interceptor. On 401/422 call `this.redirectIfUnauth(err)`.
- **Manual browser verification rule (CLAUDE.md):** before committing any task that changes runtime/UI behavior, both processes must be running and the user must verify in their own browser and approve. Backend tasks (1–5) are gated by pytest; frontend tasks (6–9) are gated by **user browser approval before commit** — do not self-verify with Playwright. Task 6 has no visible change on its own, so verify it together with Task 7.

---

## File structure

**Backend**
- `backend/chat/database.py` — *modify*: add `MessageReaction` table + Message action columns to the schema; add `_backfill_client_message_ids()`; run column-migration + backfill at import.
- `backend/chat/conversations.py` — *modify*: add `reactions_for(cmid, me_id)` and `serialize_messages(cid, me_id)` (pure-DB, no Flask deps).
- `backend/chat/messages.py` — *create*: `/api/messages/<cmid>/react` (POST), `/api/messages/<cmid>` (PATCH, DELETE).
- `backend/chat/chatfunc.py` — *modify*: `post_dm_message` + `get_dm_messages` accept/return the new fields; socket `send_message` passes `client_message_id` / `reply_to` / `reply_preview` through; add `_reply_preview()` helper.
- `backend/chat/groups.py` — *modify*: `post_group_message` + `get_group_messages` accept/return the new fields.
- `backend/chat/__init__.py` — *modify*: `from chat import messages`.
- `backend/tests/conftest.py` — *modify*: add `MessageReaction` to the inter-test wipe list.
- `backend/tests/test_messages.py` — *create*: react/edit/delete + backfill + payload-shape tests.

**Frontend** (`client/src/app/chat/`)
- `chat.component.ts` — *modify*: `Message`/`Reaction` model, id threading on send/receive, `toMessage()` mapper, reaction/reply/edit/delete state + handlers, new socket listeners.
- `chat.component.html` — *modify*: per-message action overlay (quick-react bar + side ⋯ menu), reaction pills, in-thread reply quote, composer reply chip, inline edit, deleted tombstone.
- `chat.component.scss` — *modify*: styles for all of the above (Atelier tokens).

**Docs**
- `CLAUDE.md`, `docs/evolution.md` — *modify*: document the feature.

---

## Task 1: Schema — reactions table, action columns, id backfill

**Files:**
- Modify: `backend/chat/database.py`
- Test: `backend/tests/test_messages.py` (create)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_messages.py`:

```python
import uuid

from chat.database import connection, cursor, _backfill_client_message_ids


def _seed_message_without_cmid():
    """Insert a user, a direct conversation, and a Message with NULL client_message_id."""
    cursor.execute("INSERT INTO User (username, password) VALUES ('zoe', 'x')")
    uid = cursor.lastrowid
    cursor.execute("INSERT INTO User (username, password) VALUES ('yan', 'x')")
    uid2 = cursor.lastrowid
    lo, hi = sorted((uid, uid2))
    cursor.execute(
        "INSERT INTO Conversation (type, created_at, dm_user_low_id, dm_user_high_id) "
        "VALUES ('direct', datetime('now'), ?, ?)",
        (lo, hi),
    )
    cid = cursor.lastrowid
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at) "
        "VALUES (?, ?, 'hi', datetime('now'))",
        (cid, uid),
    )
    connection.commit()
    return cursor.lastrowid


def test_message_action_columns_exist():
    cursor.execute("PRAGMA table_info(Message)")
    cols = {row[1] for row in cursor.fetchall()}
    assert {"reply_to", "edited_at", "deleted_at"} <= cols


def test_message_reaction_table_exists():
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='MessageReaction'"
    )
    assert cursor.fetchone() is not None


def test_backfill_populates_null_client_message_ids():
    mid = _seed_message_without_cmid()
    cursor.execute("UPDATE Message SET client_message_id=NULL WHERE id=?", (mid,))
    connection.commit()
    _backfill_client_message_ids()
    cursor.execute("SELECT client_message_id FROM Message WHERE id=?", (mid,))
    value = cursor.fetchone()[0]
    assert value
    uuid.UUID(value)  # parses as a UUID
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: ImportError / FAIL — `_backfill_client_message_ids` does not exist and `MessageReaction` / columns are missing.

- [ ] **Step 3: Add the reactions table to the schema**

In `backend/chat/database.py`, inside `_create_conversation_schema()`, after the `ix_message_conv_created` index block (the `cursor.execute("""CREATE INDEX IF NOT EXISTS ix_message_conv_created ...""")` call) and before the `UserProfile` table, add:

```python
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS MessageReaction (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_message_id TEXT NOT NULL,
            user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            emoji TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (client_message_id, user_id, emoji)
        )
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_reaction_cmid
        ON MessageReaction(client_message_id)
        """
    )
```

- [ ] **Step 4: Add action columns to the fresh-DB Message table**

In the same file, in the `CREATE TABLE IF NOT EXISTS Message (...)` statement, change the body so the column list reads:

```python
        CREATE TABLE IF NOT EXISTS Message (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES Conversation(id) ON DELETE CASCADE,
            sender_user_id INTEGER NOT NULL REFERENCES User(id),
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            client_message_id TEXT,
            reply_to TEXT,
            edited_at TEXT,
            deleted_at TEXT
        )
```

- [ ] **Step 5: Add the backfill function + existing-DB migrations**

In `backend/chat/database.py`, add `import uuid` to the imports at the top (alongside `import os`, `import sqlite3`). Then, after the `_create_conversation_schema` function definition (before the `_create_conversation_schema()` call at module level), add:

```python
def _backfill_client_message_ids():
    """Give every message a stable public id (UUID) so it can be reacted to /
    edited / deleted. Runs once for rows predating the client_message_id era."""
    cursor.execute(
        "SELECT id FROM Message WHERE client_message_id IS NULL OR client_message_id = ''"
    )
    rows = cursor.fetchall()
    for (mid,) in rows:
        cursor.execute(
            "UPDATE Message SET client_message_id=? WHERE id=?",
            (str(uuid.uuid4()), mid),
        )
    if rows:
        connection.commit()
```

Then, near the bottom of the module — after the existing `last_read_at` idempotent-migration block and before the `UserProfile` backfill INSERT — add:

```python
# Idempotent: add message-action columns to pre-existing Message tables.
cursor.execute("PRAGMA table_info(Message)")
_msg_cols = {row[1] for row in cursor.fetchall()}
for _col in ("reply_to", "edited_at", "deleted_at"):
    if _col not in _msg_cols:
        cursor.execute(f"ALTER TABLE Message ADD COLUMN {_col} TEXT")
connection.commit()

# Give pre-existing messages stable public ids.
_backfill_client_message_ids()
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: PASS (3 passed).

- [ ] **Step 7: Run the full backend suite (no regressions)**

Run: `cd backend; pytest -q`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add backend/chat/database.py backend/tests/test_messages.py
git commit -m "feat(backend): message-action schema (reactions, reply/edit/delete cols, id backfill)"
```

---

## Task 2: Reaction helpers + serialize_messages (conversations.py)

**Files:**
- Modify: `backend/chat/conversations.py`
- Test: `backend/tests/test_messages.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_messages.py`:

```python
from chat.conversations import reactions_for, serialize_messages


def _seed_group_with_message(body="hello", cmid="cmid-1"):
    cursor.execute("INSERT INTO User (username, password) VALUES ('amy', 'x')")
    amy = cursor.lastrowid
    cursor.execute("INSERT INTO User (username, password) VALUES ('ben', 'x')")
    ben = cursor.lastrowid
    cursor.execute(
        "INSERT INTO Conversation (type, title, created_at, created_by_user_id) "
        "VALUES ('group', 'Crew', datetime('now'), ?)",
        (amy,),
    )
    cid = cursor.lastrowid
    for uid in (amy, ben):
        cursor.execute(
            "INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at) "
            "VALUES (?, ?, 'member', datetime('now'))",
            (cid, uid),
        )
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at, client_message_id) "
        "VALUES (?, ?, ?, datetime('now'), ?)",
        (cid, amy, body, cmid),
    )
    connection.commit()
    return cid, amy, ben


def test_reactions_for_aggregates_and_marks_mine():
    cid, amy, ben = _seed_group_with_message(cmid="cmid-react")
    for uid in (amy, ben):
        cursor.execute(
            "INSERT INTO MessageReaction (client_message_id, user_id, emoji, created_at) "
            "VALUES ('cmid-react', ?, '👍', datetime('now'))",
            (uid,),
        )
    connection.commit()
    result = reactions_for("cmid-react", amy)
    assert result == [{"emoji": "👍", "count": 2, "mine": True}]
    assert reactions_for("cmid-react", ben)[0]["mine"] is True


def test_serialize_messages_includes_action_fields():
    cid, amy, ben = _seed_group_with_message(body="hi", cmid="cmid-ser")
    msgs = serialize_messages(cid, amy)
    assert len(msgs) == 1
    m = msgs[0]
    assert m["from"] == "amy"
    assert m["message"] == "hi"
    assert m["id"] == "cmid-ser"
    assert m["reactions"] == []
    assert m["reply_to"] is None
    assert m["reply_preview"] is None
    assert m["edited_at"] is None
    assert m["deleted"] is False


def test_serialize_messages_reply_preview_and_deleted():
    cid, amy, ben = _seed_group_with_message(body="parent", cmid="p1")
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at, client_message_id, reply_to) "
        "VALUES (?, ?, 'child', datetime('now'), 'c1', 'p1')",
        (cid, ben),
    )
    cursor.execute("UPDATE Message SET deleted_at=datetime('now'), body='' WHERE client_message_id='p1'")
    connection.commit()
    msgs = {m["id"]: m for m in serialize_messages(cid, amy)}
    assert msgs["p1"]["deleted"] is True
    assert msgs["p1"]["message"] == ""
    # child still resolves; preview is suppressed because the parent is deleted
    assert msgs["c1"]["reply_to"] == "p1"
    assert msgs["c1"]["reply_preview"] is None
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: ImportError — `reactions_for` / `serialize_messages` not defined.

- [ ] **Step 3: Implement the helpers**

In `backend/chat/conversations.py`, add these two functions (place them after `read_state` and before `_utc_now_iso`):

```python
_PREVIEW_MAX = 120


def reactions_for(client_message_id: str, me_id: int) -> list:
    """[{emoji, count, mine}] aggregated across users for one message."""
    if not client_message_id:
        return []
    cursor.execute(
        """
        SELECT emoji, COUNT(*),
               MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END)
        FROM MessageReaction
        WHERE client_message_id = ?
        GROUP BY emoji
        ORDER BY MIN(id)
        """,
        (me_id, client_message_id),
    )
    return [
        {"emoji": r[0], "count": int(r[1]), "mine": bool(r[2])}
        for r in cursor.fetchall()
    ]


def serialize_messages(cid: int, me_id: int) -> list:
    """Full message payloads for a conversation: text + id + reactions + reply +
    edited/deleted markers. Shared by DM and group history endpoints."""
    cursor.execute(
        """
        SELECT u.username, m.body, m.created_at, m.client_message_id,
               m.reply_to, m.edited_at, m.deleted_at
        FROM Message m
        JOIN User u ON u.id = m.sender_user_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at, m.id
        """,
        (cid,),
    )
    rows = cursor.fetchall()
    body_by_cmid = {r[3]: r[1] for r in rows if r[3]}
    deleted_cmids = {r[3] for r in rows if r[3] and r[6] is not None}
    out = []
    for username, body, ts, cmid, reply_to, edited_at, deleted_at in rows:
        deleted = deleted_at is not None
        preview = None
        if reply_to and reply_to not in deleted_cmids:
            parent = body_by_cmid.get(reply_to)
            if parent:
                preview = parent[:_PREVIEW_MAX]
        out.append(
            {
                "from": username,
                "message": "" if deleted else body,
                "datetime": ts,
                "id": cmid,
                "reply_to": reply_to,
                "reply_preview": preview,
                "edited_at": edited_at,
                "deleted": deleted,
                "reactions": reactions_for(cmid, me_id) if cmid else [],
            }
        )
    return out
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/chat/conversations.py backend/tests/test_messages.py
git commit -m "feat(backend): reactions_for + serialize_messages helpers"
```

---

## Task 3: React endpoint (messages.py) + registration + test cleanup

**Files:**
- Create: `backend/chat/messages.py`
- Modify: `backend/chat/__init__.py`, `backend/tests/conftest.py`
- Test: `backend/tests/test_messages.py`

- [ ] **Step 1: Add MessageReaction to the inter-test wipe list**

In `backend/tests/conftest.py`, change the `clean_db` table tuple to include `MessageReaction` first (children before parents):

```python
    for table in ("MessageReaction", "Message", "ConversationMember", "Conversation", "UserProfile", "User"):
        cursor.execute(f"DELETE FROM {table}")
```

- [ ] **Step 2: Write the failing test**

Append to `backend/tests/test_messages.py`:

```python
def _make_group(client, owner, member, title="Crew"):
    """owner creates a group containing member; returns conversation_id."""
    r = client.post(
        "/api/groups",
        json={"title": title, "members": [member["username"]]},
        headers=owner["headers"],
    )
    return r.get_json()["conversation_id"]


def _post_group_msg(client, sender, cid, body="hi", cmid="m-1"):
    client.post(
        f"/api/groups/{cid}/messages",
        json={"body": body, "client_message_id": cmid},
        headers=sender["headers"],
    )
    return cmid


def test_react_toggles_on_and_off(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="react-1")

    r1 = client.post(f"/api/messages/{cmid}/react", json={"emoji": "👍"}, headers=bob["headers"])
    assert r1.status_code == 200
    assert r1.get_json()["reactions"] == [{"emoji": "👍", "count": 1, "mine": True}]

    r2 = client.post(f"/api/messages/{cmid}/react", json={"emoji": "👍"}, headers=bob["headers"])
    assert r2.status_code == 200
    assert r2.get_json()["reactions"] == []  # toggled off


def test_react_requires_membership(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    carol = make_user("carol")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="react-2")
    r = client.post(f"/api/messages/{cmid}/react", json={"emoji": "👍"}, headers=carol["headers"])
    assert r.status_code == 403


def test_react_unknown_message_404(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/messages/nope/react", json={"emoji": "👍"}, headers=alice["headers"])
    assert r.status_code == 404
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: FAIL (404/route missing → the react tests error).

- [ ] **Step 4: Create the messages blueprint with the react endpoint**

Create `backend/chat/messages.py`:

```python
"""Message-level actions (reactions, edit, delete), keyed on client_message_id.

Membership/ownership is resolved from the message's own conversation row — the
caller never supplies a conversation id. Mutations broadcast to the per-
conversation room so every participant updates live.
"""
import datetime

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app, socketio
from .conversations import conversation_room, is_member, reactions_for
from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _uid(username):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    row = cursor.fetchone()
    return int(row[0]) if row else None


def _message_meta(cmid):
    """(conversation_id, sender_user_id, deleted_at) for a client_message_id."""
    cursor.execute(
        "SELECT conversation_id, sender_user_id, deleted_at "
        "FROM Message WHERE client_message_id=?",
        (cmid,),
    )
    row = cursor.fetchone()
    if not row:
        return (None, None, None)
    return (int(row[0]), int(row[1]), row[2])


@app.route("/api/messages/<cmid>/react", methods=["POST"])
@jwt_required()
def react_message(cmid):
    me = _uid(get_jwt_identity())
    if me is None:
        return jsonify({"error": "User not found"}), 404
    conv_id, _sender, _deleted = _message_meta(cmid)
    if conv_id is None:
        return jsonify({"error": "Unknown message"}), 404
    if not is_member(conv_id, me):
        return jsonify({"error": "Not a member"}), 403
    data = request.get_json(silent=True) or {}
    emoji = data.get("emoji")
    if not isinstance(emoji, str) or not emoji.strip():
        return jsonify({"error": "emoji required"}), 400
    emoji = emoji.strip()

    cursor.execute(
        "SELECT id FROM MessageReaction "
        "WHERE client_message_id=? AND user_id=? AND emoji=?",
        (cmid, me, emoji),
    )
    existing = cursor.fetchone()
    if existing:
        cursor.execute("DELETE FROM MessageReaction WHERE id=?", (existing[0],))
    else:
        cursor.execute(
            "INSERT INTO MessageReaction (client_message_id, user_id, emoji, created_at) "
            "VALUES (?, ?, ?, ?)",
            (cmid, me, emoji, _utc_now_iso()),
        )
    connection.commit()

    reactions = reactions_for(cmid, me)
    socketio.emit(
        "reaction_updated",
        {"conversation_id": conv_id, "client_message_id": cmid, "reactions": reactions},
        room=conversation_room(conv_id),
    )
    return jsonify({"reactions": reactions}), 200
```

- [ ] **Step 5: Register the blueprint**

In `backend/chat/__init__.py`, in the import block at the bottom, add `messages` after `groups`:

```python
from chat import user
from chat import chatfunc
from chat import profile
from chat import groups
from chat import messages
from chat import push
from chat import database
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/chat/messages.py backend/chat/__init__.py backend/tests/conftest.py backend/tests/test_messages.py
git commit -m "feat(backend): POST /api/messages/<id>/react (toggle + broadcast)"
```

---

## Task 4: Edit + delete endpoints (messages.py)

**Files:**
- Modify: `backend/chat/messages.py`
- Test: `backend/tests/test_messages.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_messages.py`:

```python
def test_edit_owner_updates_body_and_sets_edited(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, body="frist", cmid="edit-1")
    r = client.patch(f"/api/messages/{cmid}", json={"body": "first"}, headers=alice["headers"])
    assert r.status_code == 200
    body = r.get_json()
    assert body["body"] == "first"
    assert body["edited_at"]
    msgs = client.get(f"/api/groups/{cid}/messages", headers=alice["headers"]).get_json()["messages"]
    edited = next(m for m in msgs if m["id"] == cmid)
    assert edited["message"] == "first"
    assert edited["edited_at"]


def test_edit_non_owner_forbidden(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="edit-2")
    r = client.patch(f"/api/messages/{cmid}", json={"body": "nope"}, headers=bob["headers"])
    assert r.status_code == 403


def test_delete_owner_soft_deletes(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, body="secret", cmid="del-1")
    r = client.delete(f"/api/messages/{cmid}", headers=alice["headers"])
    assert r.status_code == 200
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    tomb = next(m for m in msgs if m["id"] == cmid)
    assert tomb["deleted"] is True
    assert tomb["message"] == ""


def test_delete_non_owner_forbidden(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="del-2")
    r = client.delete(f"/api/messages/{cmid}", headers=bob["headers"])
    assert r.status_code == 403
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: FAIL (405/404 — PATCH/DELETE routes missing).

- [ ] **Step 3: Implement edit + delete**

Append to `backend/chat/messages.py`:

```python
@app.route("/api/messages/<cmid>", methods=["PATCH"])
@jwt_required()
def edit_message(cmid):
    me = _uid(get_jwt_identity())
    conv_id, sender, deleted_at = _message_meta(cmid)
    if conv_id is None:
        return jsonify({"error": "Unknown message"}), 404
    if me != sender:
        return jsonify({"error": "Not your message"}), 403
    if deleted_at is not None:
        return jsonify({"error": "Message deleted"}), 400
    data = request.get_json(silent=True) or {}
    body = data.get("body")
    if not isinstance(body, str) or not body.strip():
        return jsonify({"error": "body required"}), 400
    body = body.strip()
    now = _utc_now_iso()
    cursor.execute(
        "UPDATE Message SET body=?, edited_at=? WHERE client_message_id=?",
        (body, now, cmid),
    )
    connection.commit()
    socketio.emit(
        "message_edited",
        {"conversation_id": conv_id, "client_message_id": cmid, "body": body, "edited_at": now},
        room=conversation_room(conv_id),
    )
    return jsonify({"client_message_id": cmid, "body": body, "edited_at": now}), 200


@app.route("/api/messages/<cmid>", methods=["DELETE"])
@jwt_required()
def delete_message(cmid):
    me = _uid(get_jwt_identity())
    conv_id, sender, _deleted = _message_meta(cmid)
    if conv_id is None:
        return jsonify({"error": "Unknown message"}), 404
    if me != sender:
        return jsonify({"error": "Not your message"}), 403
    now = _utc_now_iso()
    cursor.execute(
        "UPDATE Message SET deleted_at=?, body='' WHERE client_message_id=?",
        (now, cmid),
    )
    connection.commit()
    socketio.emit(
        "message_deleted",
        {"conversation_id": conv_id, "client_message_id": cmid},
        room=conversation_room(conv_id),
    )
    return jsonify({"client_message_id": cmid, "deleted": True}), 200
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/chat/messages.py backend/tests/test_messages.py
git commit -m "feat(backend): PATCH/DELETE /api/messages/<id> (edit + soft delete)"
```

---

## Task 5: Thread id/reply through creates + reads (chatfunc.py, groups.py)

**Files:**
- Modify: `backend/chat/chatfunc.py`, `backend/chat/groups.py`
- Test: `backend/tests/test_messages.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_messages.py`:

```python
def test_dm_post_stores_client_message_id_and_reply(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    r = client.post(
        "/api/dm/messages",
        json={"to_username": "bob", "body": "parent", "client_message_id": "dm-p"},
        headers=alice["headers"],
    )
    assert r.status_code == 201
    assert r.get_json()["client_message_id"] == "dm-p"
    client.post(
        "/api/dm/messages",
        json={"to_username": "bob", "body": "child", "client_message_id": "dm-c", "reply_to": "dm-p"},
        headers=bob["headers"],
    )
    msgs = client.get("/api/dm/messages/bob", headers=alice["headers"]).get_json()["messages"]
    by_id = {m["id"]: m for m in msgs}
    assert by_id["dm-p"]["id"] == "dm-p"
    assert by_id["dm-c"]["reply_to"] == "dm-p"
    assert by_id["dm-c"]["reply_preview"] == "parent"
    # DM payloads still carry `to`
    assert by_id["dm-p"]["to"] == "bob"


def test_group_post_stores_client_message_id(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    client.post(
        f"/api/groups/{cid}/messages",
        json={"body": "yo", "client_message_id": "g-1"},
        headers=alice["headers"],
    )
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    assert any(m["id"] == "g-1" and m["reactions"] == [] for m in msgs)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend; pytest tests/test_messages.py -q`
Expected: FAIL — DM response lacks `client_message_id`; history lacks `id`/`reply_to`/`reply_preview`.

- [ ] **Step 3: DM create — accept + store id/reply, return id**

In `backend/chat/chatfunc.py`, in `post_dm_message`, replace the INSERT block (the `cursor.execute("""INSERT INTO Message (conversation_id, sender_user_id, body, created_at) ...""", (cid, me_row[0], body, now))` call) with:

```python
    cmid = data.get("client_message_id")
    cmid = cmid.strip() if isinstance(cmid, str) and cmid.strip() else None
    reply_to = data.get("reply_to")
    reply_to = reply_to.strip() if isinstance(reply_to, str) and reply_to.strip() else None
    cursor.execute(
        """
        INSERT INTO Message
            (conversation_id, sender_user_id, body, created_at, client_message_id, reply_to)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (cid, me_row[0], body, now, cmid, reply_to),
    )
```

Then in the same function's `return jsonify({...})`, add `client_message_id` to the response dict:

```python
    return (
        jsonify(
            {
                "message": "Message posted successfully",
                "conversation_id": cid,
                "message_id": cursor.lastrowid,
                "client_message_id": cmid,
            }
        ),
        201,
    )
```

- [ ] **Step 4: DM read — use serialize_messages**

In `backend/chat/chatfunc.py`, add `serialize_messages` to the import from `.conversations` (the existing `from .conversations import (...)` block). Then replace the body of `get_dm_messages` from the `cursor.execute("""SELECT u.username, m.sender_user_id, ...""")` call through the `return jsonify(...)` with:

```python
    msgs = serialize_messages(cid, me_id)
    for m in msgs:
        m["to"] = other_username if m["from"] == me_username else me_username
    return jsonify({"messages": msgs, "read_state": read_state(cid)})
```

(Delete the now-unused `rows = cursor.fetchall()` / `formatted` loop.)

- [ ] **Step 5: Socket send_message — pass id/reply/preview through**

In `backend/chat/chatfunc.py`, add a helper near `_sender_user_id`:

```python
def _reply_preview(cmid):
    if not cmid:
        return None
    cursor.execute(
        "SELECT body, deleted_at FROM Message WHERE client_message_id=?", (cmid,)
    )
    row = cursor.fetchone()
    if not row or row[1] is not None:
        return None
    body = row[0] or ""
    return body[:120]
```

Then in `handle_message`, after `now = datetime.datetime.now(...)`, add:

```python
    cmid = data.get("client_message_id")
    cmid = cmid.strip() if isinstance(cmid, str) and cmid.strip() else None
    reply_to = data.get("reply_to")
    reply_to = reply_to.strip() if isinstance(reply_to, str) and reply_to.strip() else None
    preview = _reply_preview(reply_to)
    extra = {
        "id": cmid,
        "reply_to": reply_to,
        "reply_preview": preview,
        "reactions": [],
        "edited_at": None,
        "deleted": False,
    }
```

Then change the two `emit("receive_message", {...})` payloads to include `**extra`. The group emit becomes:

```python
        emit(
            "receive_message",
            {"username": sender, "message": message, "datetime": now,
             "kind": "group", "conversation_id": cid, **extra},
            room=conversation_room(cid),
            skip_sid=request.sid,
        )
```

and the direct emit becomes:

```python
    emit(
        "receive_message",
        {"username": sender, "message": message, "datetime": now,
         "kind": "direct", **extra},
        room=recipient,
    )
```

- [ ] **Step 6: Group create + read**

In `backend/chat/groups.py`, add `serialize_messages` to the `from .conversations import (...)` block.

In `post_group_message`, replace the INSERT (`cursor.execute("INSERT INTO Message (conversation_id, sender_user_id, body, created_at) VALUES (?, ?, ?, ?)", (cid, uid, body, now))`) with:

```python
    cmid = data.get("client_message_id")
    cmid = cmid.strip() if isinstance(cmid, str) and cmid.strip() else None
    reply_to = data.get("reply_to")
    reply_to = reply_to.strip() if isinstance(reply_to, str) and reply_to.strip() else None
    cursor.execute(
        "INSERT INTO Message "
        "(conversation_id, sender_user_id, body, created_at, client_message_id, reply_to) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (cid, uid, body, now, cmid, reply_to),
    )
```

and change its final return to include the id:

```python
    return jsonify({"message": "ok", "datetime": now, "client_message_id": cmid}), 201
```

In `get_group_messages`, replace the `cursor.execute("""SELECT u.username, m.body, m.created_at ...""")` + `messages = [...]` + return with:

```python
    uid, err = _require_member(cid)
    if err:
        return err
    return jsonify({"messages": serialize_messages(cid, uid), "read_state": read_state(cid)})
```

(Note: change `_, err = _require_member(cid)` at the top of `get_group_messages` to `uid, err = _require_member(cid)` so `uid` is available for `serialize_messages`.)

- [ ] **Step 7: Run the messages + dm + group tests**

Run: `cd backend; pytest tests/test_messages.py tests/test_dm.py tests/test_groups.py -q`
Expected: PASS (existing dm/group tests assert on `m["message"]`, which `serialize_messages` still provides).

- [ ] **Step 8: Run the full suite**

Run: `cd backend; pytest -q`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add backend/chat/chatfunc.py backend/chat/groups.py backend/tests/test_messages.py
git commit -m "feat(backend): thread client_message_id + reply through send paths and history"
```

---

## Task 6: Frontend foundation — model + id threading on send/receive

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`

No standalone visible change; verify together with Task 7 in the browser.

- [ ] **Step 1: Extend the Message model**

In `client/src/app/chat/chat.component.ts`, replace the `interface Message { ... }` block with:

```typescript
interface Reaction {
  emoji: string;
  count: number;
  mine: boolean;
}

interface Message {
  id?: string;
  from: string;
  to: string;
  message: string;
  datetime: any;
  status?: 'sending' | 'sent' | 'failed';
  reactions?: Reaction[];
  replyTo?: string | null;
  replyPreview?: string | null;
  editedAt?: string | null;
  deleted?: boolean;
}
```

- [ ] **Step 2: Add a raw→Message mapper + a new-id helper**

In the `ChatComponent` class, add these private methods (place them near `toDate`, in the "date / grouping helpers" region):

```typescript
  private newId(): string {
    const c: any = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'm-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  private toMessage(raw: any): Message {
    return {
      id: raw.id ?? undefined,
      from: String(raw.from),
      to: raw.to ?? this.currentUser,
      message: String(raw.message ?? ''),
      datetime: raw.datetime ?? new Date().toISOString(),
      reactions: Array.isArray(raw.reactions) ? raw.reactions : [],
      replyTo: raw.reply_to ?? null,
      replyPreview: raw.reply_preview ?? null,
      editedAt: raw.edited_at ?? null,
      deleted: !!raw.deleted,
    };
  }
```

- [ ] **Step 3: Map history through toMessage**

In `selectConversation`, change the success handler's first line from `const messages = data?.messages ?? [];` to:

```typescript
        const messages = (data?.messages ?? []).map((m: any) => this.toMessage(m));
```

- [ ] **Step 4: Map incoming socket messages through toMessage**

In `onReceive`, replace the `const msg: Message = { from, to: ..., message: ..., datetime: ... };` literal with:

```typescript
    const msg: Message = this.toMessage({
      from,
      to: this.currentUser,
      message: data.message,
      datetime: data.datetime,
      id: data.id,
      reply_to: data.reply_to,
      reply_preview: data.reply_preview,
      reactions: data.reactions,
      edited_at: data.edited_at,
      deleted: data.deleted,
    });
```

- [ ] **Step 5: Generate + thread the id on send**

In `sendMessage`, replace the `const msg: Message = { from: ..., to: e.key, message: text, datetime: ..., status: 'sending' };` literal with:

```typescript
    const msg: Message = {
      id: this.newId(),
      from: this.currentUser,
      to: e.key,
      message: text,
      datetime: new Date().toISOString(),
      status: 'sending',
      reactions: [],
      replyTo: this.replyingTo?.id ?? null,
      replyPreview: this.replyingTo ? this.replyingTo.message : null,
    };
```

(Adds `replyingTo` — declared in Task 8. To keep Task 6 compiling on its own, also add the field now: in the class fields near `newMessage`, add `replyingTo: Message | null = null;`.)

- [ ] **Step 6: Send id + reply_to in emit + POST**

In `postMessage`, change the four wire payloads to carry the id and reply target. The group branch:

```typescript
      this.socket.emit('send_message', {
        conversation_id: entry.conversationId,
        message: text,
        client_message_id: msg.id,
        reply_to: msg.replyTo ?? null,
      });
      req = this.http.post<any>(
        `/api/groups/${entry.conversationId}/messages`,
        { body: text, client_message_id: msg.id, reply_to: msg.replyTo ?? null },
        { headers: this.authHeaders() }
      );
```

The direct branch:

```typescript
      this.socket.emit('send_message', {
        recipient: entry.username,
        message: text,
        client_message_id: msg.id,
        reply_to: msg.replyTo ?? null,
      });
      req = this.http.post<any>(
        '/api/dm/messages',
        { to_username: entry.username, body: text, client_message_id: msg.id, reply_to: msg.replyTo ?? null },
        { headers: this.authHeaders() }
      );
```

- [ ] **Step 7: Clear the reply draft after sending**

At the end of `sendMessage` (after `this.newMessage = '';`), add:

```typescript
    this.replyingTo = null;
```

- [ ] **Step 8: Type-check**

Run: `cd client; npm run build`
Expected: build succeeds (no visible behavior change yet).

- [ ] **Step 9: Commit**

```bash
git add client/src/app/chat/chat.component.ts
git commit -m "feat(client): thread client_message_id + reply through send/receive; message model"
```

---

## Task 7: Frontend reactions — pills, quick-react bar, picker, live updates

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`, `chat.component.html`, `chat.component.scss`

**Browser verification gate:** before committing, both processes must run and the user must approve in their browser.

- [ ] **Step 1: Add reaction state + handlers (TS)**

In `chat.component.ts`, add class fields (near `membersOpen`):

```typescript
  /** Message id whose action overlay / menu / picker is open (mobile + click). */
  activeMsgId: string | null = null;
  menuOpenId: string | null = null;
  pickerOpenId: string | null = null;

  readonly quickReactions = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  readonly emojiPicker = [
    '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '🎉', '👏', '🙌',
    '😍', '🤔', '😅', '😎', '😭', '😡', '👀', '💯', '✅', '❌',
    '🤝', '💪', '🙇', '☕', '🚀', '⭐', '💡', '📌', '👋', '🤷',
  ];
```

Add the methods (in a new "message actions" region near `retryMessage`):

```typescript
  // --- message actions: reactions ------------------------------------------
  private findMessage(id: string): Message | null {
    if (!id) return null;
    for (const key of Object.keys(this.chatHistory)) {
      const hit = this.chatHistory[key].find((m) => m.id === id);
      if (hit) return hit;
    }
    return null;
  }

  /** Merge authoritative counts while preserving *my* reaction flags locally
   * (only my own toggles ever change my `mine`, so it's safe to keep them). */
  private mergeReactions(incoming: Reaction[], current: Reaction[] | undefined): Reaction[] {
    const cur = current ?? [];
    return (incoming ?? []).map((r) => ({
      emoji: r.emoji,
      count: r.count,
      mine: cur.find((c) => c.emoji === r.emoji)?.mine ?? false,
    }));
  }

  toggleReaction(msg: Message, emoji: string): void {
    if (!msg.id || msg.deleted) return;
    const list = (msg.reactions ?? []).map((r) => ({ ...r }));
    const found = list.find((r) => r.emoji === emoji);
    if (found && found.mine) {
      found.count -= 1;
      found.mine = false;
    } else if (found) {
      found.count += 1;
      found.mine = true;
    } else {
      list.push({ emoji, count: 1, mine: true });
    }
    msg.reactions = list.filter((r) => r.count > 0);
    this.menuOpenId = null;
    this.pickerOpenId = null;
    this.activeMsgId = null;
    this.http
      .post<any>(`/api/messages/${msg.id}/react`, { emoji }, { headers: this.authHeaders() })
      .subscribe({
        next: (res) => {
          msg.reactions = this.mergeReactions(res?.reactions ?? [], msg.reactions);
        },
        error: (err) => this.redirectIfUnauth(err),
      });
  }

  private onReactionUpdated(d: any): void {
    const msg = this.findMessage(d?.client_message_id);
    if (!msg) return;
    msg.reactions = this.mergeReactions(d?.reactions ?? [], msg.reactions);
    this.chatHistory = { ...this.chatHistory };
  }

  // --- action overlay open/close -------------------------------------------
  toggleActions(msg: Message): void {
    this.activeMsgId = this.activeMsgId === msg.id ? null : (msg.id ?? null);
    this.menuOpenId = null;
    this.pickerOpenId = null;
  }

  toggleMenu(msg: Message, event: Event): void {
    event.stopPropagation();
    this.menuOpenId = this.menuOpenId === msg.id ? null : (msg.id ?? null);
    this.pickerOpenId = null;
  }

  togglePicker(msg: Message, event: Event): void {
    event.stopPropagation();
    this.pickerOpenId = this.pickerOpenId === msg.id ? null : (msg.id ?? null);
  }

  closeOverlays(): void {
    this.activeMsgId = null;
    this.menuOpenId = null;
    this.pickerOpenId = null;
  }

  isOwn(msg: Message): boolean {
    return msg.from === this.currentUser;
  }
```

- [ ] **Step 2: Wire the socket listener + close-on-outside-click**

In the constructor, after the existing `this.socket.on('conversation_read', ...)` line, add:

```typescript
    this.socket.on('reaction_updated', (data: any) =>
      this.zone.run(() => this.onReactionUpdated(data))
    );
```

(The `message_edited` / `message_deleted` listeners are added in Task 9.)

- [ ] **Step 3: Render the action overlay + pills (HTML)**

In `chat.component.html`, replace the whole `<div class="message-bubble" ...> ... </div>` element (the bubble block inside `message-row`) with:

```html
                  <div
                    class="message-bubble"
                    [class.message-bubble--failed]="message.status === 'failed'"
                    [class.message-bubble--deleted]="message.deleted"
                    [class.message-bubble--active]="activeMsgId === message.id"
                    (click)="message.id && !message.deleted && toggleActions(message)"
                    [ngClass]="message.from === currentUser ? 'message-bubble--sent' : 'message-bubble--received'">

                    @if (message.replyTo && message.replyPreview) {
                      <button type="button" class="reply-quote" (click)="scrollToMessage(message.replyTo); $event.stopPropagation()">
                        <span class="reply-quote__icon">↩</span>
                        <span class="reply-quote__text">{{ message.replyPreview }}</span>
                      </button>
                    }

                    @if (message.deleted) {
                      <div class="message-bubble__tomb">🚫 This message was deleted</div>
                    } @else if (editingId === message.id) {
                      <div class="message-edit">
                        <textarea class="message-edit__field" [(ngModel)]="editText" rows="1"
                          (click)="$event.stopPropagation()"></textarea>
                        <div class="message-edit__actions">
                          <button type="button" class="message-edit__save" (click)="saveEdit(message); $event.stopPropagation()">Save</button>
                          <button type="button" class="message-edit__cancel" (click)="cancelEdit(); $event.stopPropagation()">Cancel</button>
                        </div>
                      </div>
                    } @else {
                      <div class="message-bubble__text">{{ message.message }}</div>
                    }

                    @if (message.from === currentUser && message.status === 'failed') {
                      <button type="button" class="message-failed" (click)="retryMessage(message); $event.stopPropagation()">
                        ⚠ Couldn't send · <span class="message-failed__retry">↻ Retry</span>
                      </button>
                    } @else if (isGroupEnd(thread, i) && !message.deleted && editingId !== message.id) {
                      <div class="message-bubble__meta">
                        {{ message.from }} · {{ formatMessageTime(message.datetime) }}@if (message.editedAt) {<span class="message-bubble__edited"> · (edited)</span>}
                      </div>
                    }

                    @if (!message.deleted && message.id && (activeMsgId === message.id || menuOpenId === message.id || pickerOpenId === message.id)) {
                      <div class="msg-actions" (click)="$event.stopPropagation()">
                        <div class="msg-actions__react">
                          @for (e of quickReactions; track e) {
                            <button type="button" class="msg-actions__emoji" (click)="toggleReaction(message, e)">{{ e }}</button>
                          }
                          <button type="button" class="msg-actions__more" (click)="togglePicker(message, $event)">＋</button>
                        </div>
                      </div>
                    }

                    @if (pickerOpenId === message.id) {
                      <div class="emoji-picker" (click)="$event.stopPropagation()">
                        @for (e of emojiPicker; track e) {
                          <button type="button" class="emoji-picker__item" (click)="toggleReaction(message, e)">{{ e }}</button>
                        }
                      </div>
                    }
                  </div>

                  @if (!message.deleted && message.id) {
                    <div class="msg-dots-wrap">
                      <button type="button" class="msg-dots" (click)="toggleMenu(message, $event)" aria-label="Message actions">⋯</button>
                      @if (menuOpenId === message.id) {
                        <div class="msg-menu" (click)="$event.stopPropagation()">
                          <button type="button" class="msg-menu__item" (click)="startReply(message)">↩ Reply</button>
                          @if (isOwn(message)) {
                            <button type="button" class="msg-menu__item" (click)="startEdit(message)">✏️ Edit</button>
                            <button type="button" class="msg-menu__item msg-menu__item--danger" (click)="deleteMessage(message)">🗑 Delete</button>
                          }
                        </div>
                      }
                    </div>
                  }
```

Then, immediately after the closing `</div>` of `message-bubble` handling — i.e. right before the `@if (message.from === currentUser && readersOf(...))` seen-row block — add the reaction pills row:

```html
                  @if (message.reactions && message.reactions.length) {
                    <div class="reaction-pills"
                      [class.reaction-pills--sent]="message.from === currentUser">
                      @for (r of message.reactions; track r.emoji) {
                        <button type="button" class="reaction-pill" [class.reaction-pill--mine]="r.mine"
                          (click)="toggleReaction(message, r.emoji)">
                          {{ r.emoji }} <span class="reaction-pill__n">{{ r.count }}</span>
                        </button>
                      }
                    </div>
                  }
```

Also add a backdrop to close overlays: add `(click)="closeOverlays()"` to the `<div class="chat-container" #messageScrollHost>` opening tag.

- [ ] **Step 4: Add the id anchor for scroll-to (HTML)**

On the `<div class="message-row" ...>` opening tag, add `[attr.id]="message.id ? 'msg-' + message.id : null"`.

- [ ] **Step 5: Style reactions + overlay (SCSS)**

Append to `client/src/app/chat/chat.component.scss` (uses the Atelier palette already used elsewhere in this file; if `_tokens` is `@use`d at top, prefer tokens — otherwise these literals match the existing file's bubble colors):

```scss
.message-row { position: relative; }

.message-bubble { position: relative; cursor: default; }

.msg-actions {
  position: absolute;
  top: -18px;
  left: 6px;
  display: inline-flex;
  align-items: center;
  gap: 1px;
  background: #fffdf8;
  border: 1px solid rgba(176, 141, 87, 0.32);
  border-radius: 999px;
  padding: 2px 5px;
  box-shadow: 0 6px 18px rgba(43, 10, 44, 0.18);
  z-index: 6;

  .message-bubble--sent & { left: auto; right: 6px; }

  &__emoji, &__more {
    border: none; background: none; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 3px; border-radius: 50%;
  }
  &__emoji:hover, &__more:hover { background: rgba(176, 141, 87, 0.18); transform: scale(1.12); }
  &__more { color: #6b4a6d; font-weight: 700; }
}

.emoji-picker {
  position: absolute; top: -8px; left: 6px; transform: translateY(-100%);
  display: grid; grid-template-columns: repeat(10, 1fr); gap: 2px;
  width: 260px; max-width: 70vw;
  background: #fffdf8; border: 1px solid rgba(176, 141, 87, 0.32);
  border-radius: 12px; padding: 6px; box-shadow: 0 12px 28px rgba(43, 10, 44, 0.22);
  z-index: 7;
  .message-bubble--sent & { left: auto; right: 6px; }
  &__item { border: none; background: none; cursor: pointer; font-size: 17px; padding: 4px; border-radius: 7px; }
  &__item:hover { background: rgba(176, 141, 87, 0.18); }
}

.msg-dots-wrap {
  position: absolute; top: 0; bottom: 0; display: flex; align-items: center;
  right: -34px;
  .message-row--sent & { right: auto; left: -34px; }
}
.msg-dots {
  width: 26px; height: 26px; border-radius: 50%; border: none; cursor: pointer;
  background: rgba(58, 14, 60, 0.05); color: #6b4a6d; font-size: 17px; line-height: 1;
  opacity: 0; transition: opacity 0.12s;
}
.message-row:hover .msg-dots, .message-bubble--active ~ * .msg-dots { opacity: 1; }
.msg-dots:hover { background: rgba(176, 141, 87, 0.18); }

.msg-menu {
  position: absolute; top: 28px; right: 0; z-index: 8;
  background: #fffdf8; border: 1px solid rgba(176, 141, 87, 0.32);
  border-radius: 10px; box-shadow: 0 10px 24px rgba(43, 10, 44, 0.22); padding: 5px; min-width: 132px;
  .message-row--sent & { right: auto; left: 0; }
  &__item {
    display: block; width: 100%; text-align: left; border: none; background: none;
    cursor: pointer; padding: 7px 12px; font-size: 13px; color: #3a0e3c; border-radius: 7px;
  }
  &__item:hover { background: rgba(176, 141, 87, 0.12); }
  &__item--danger { color: #a23b4d; }
}

.reaction-pills {
  display: flex; gap: 5px; margin: 4px 2px 0; flex-wrap: wrap;
  &--sent { justify-content: flex-end; }
}
.reaction-pill {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  background: #fffdf8; border: 1px solid rgba(176, 141, 87, 0.32);
  border-radius: 999px; padding: 1px 8px; font-size: 12px; color: #3a0e3c;
  &--mine { background: rgba(176, 141, 87, 0.18); border-color: #b08d57; }
  &__n { font-weight: 700; font-size: 11px; color: #6b4a6d; }
}
```

- [ ] **Step 6: Browser verification**

Make sure `python main.py` (backend) and `npm run start` (client) are running. Then ask the user to:
- Open `http://localhost:4200`, open a DM and a group in two browser profiles/windows logged in as different users.
- Hover a message → confirm the quick-react bar appears above the bubble and the ⋯ appears in the side gutter.
- Click an emoji on your own and the other user's message → a pill appears under the bubble; it shows live in the other window.
- Click the pill again → it toggles off (count decrements / pill disappears) in both windows.
- Click ＋ → the picker opens; pick an emoji → adds a pill.
- Reload → reactions persist.

**Wait for explicit approval before committing.**

- [ ] **Step 7: Commit (after approval)**

```bash
git add client/src/app/chat/chat.component.ts client/src/app/chat/chat.component.html client/src/app/chat/chat.component.scss
git commit -m "feat(client): emoji reactions — quick-react bar, pills, picker, live sync"
```

---

## Task 8: Frontend reply — composer chip + in-thread quote + scroll-to

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`, `chat.component.html`, `chat.component.scss`

**Browser verification gate** before commit.

- [ ] **Step 1: Reply state + scroll helper (TS)**

`replyingTo` was added in Task 6. Add the supporting members. Add a field near `activeMsgId`:

```typescript
  highlightedId: string | null = null;
```

Add methods to the message-actions region:

```typescript
  // --- message actions: reply ----------------------------------------------
  startReply(msg: Message): void {
    this.replyingTo = msg;
    this.closeOverlays();
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>('.message-input__field');
      el?.focus();
    });
  }

  cancelReply(): void {
    this.replyingTo = null;
  }

  /** Display name to show in the composer "Replying to …" chip. */
  replyName(msg: Message): string {
    if (msg.from === this.currentUser) return 'yourself';
    const entry = this.conversations.find((c) => c.kind === 'direct' && c.username === msg.from);
    return entry?.displayName ?? msg.from;
  }

  scrollToMessage(id: string | null | undefined): void {
    if (!id) return;
    const el = document.getElementById('msg-' + id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    this.highlightedId = id;
    setTimeout(() => this.zone.run(() => (this.highlightedId = null)), 1200);
  }
```

- [ ] **Step 2: Highlight binding on the row (HTML)**

On the `<div class="message-row" ...>` opening tag, add `[class.message-row--flash]="highlightedId === message.id"`.

- [ ] **Step 3: Composer reply chip (HTML)**

In `chat.component.html`, inside the `<div class="message-input">` block, immediately before the `<textarea ...>`, add:

```html
          @if (replyingTo) {
            <div class="reply-chip">
              <div class="reply-chip__body">
                <span class="reply-chip__who">Replying to {{ replyName(replyingTo) }}</span>
                <span class="reply-chip__text">{{ replyingTo.message }}</span>
              </div>
              <button type="button" class="reply-chip__x" (click)="cancelReply()" aria-label="Cancel reply">✕</button>
            </div>
          }
```

(The in-thread `.reply-quote` and the `scrollToMessage` wiring were already added in Task 7's bubble markup.)

- [ ] **Step 4: Make the composer column stack the chip (HTML)**

The `.message-input` is currently a row (textarea + button). Wrap so the chip sits above. Change the opening `<div class="message-input">` to `<div class="message-input" [class.message-input--replying]="!!replyingTo">`. (Styling in the next step handles layout via the modifier.)

- [ ] **Step 5: Style reply quote + chip + flash (SCSS)**

Append to `chat.component.scss`:

```scss
.reply-quote {
  display: flex; align-items: center; gap: 6px; width: 100%;
  text-align: left; border: none; cursor: pointer;
  background: rgba(74, 21, 75, 0.06); border-left: 3px solid #b08d57;
  border-radius: 8px; padding: 4px 9px; margin-bottom: 4px;
  .message-bubble--sent & { background: rgba(255, 255, 255, 0.14); }
  &__icon { color: #b08d57; font-size: 12px; }
  &__text {
    font-size: 12px; color: #6b4a6d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    .message-bubble--sent & { color: rgba(247, 242, 232, 0.82); }
  }
}

.message-input--replying { flex-wrap: wrap; }
.reply-chip {
  display: flex; align-items: center; gap: 8px; width: 100%; margin-bottom: 6px;
  background: #fffdf8; border: 1px solid rgba(176, 141, 87, 0.32);
  border-left: 3px solid #b08d57; border-radius: 10px; padding: 6px 11px;
  &__body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  &__who { font-size: 11.5px; color: #4a154b; font-weight: 600; }
  &__text { font-size: 12px; color: #6b4a6d; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  &__x { border: none; background: none; cursor: pointer; color: #6b4a6d; font-size: 14px; }
}

.message-row--flash .message-bubble {
  animation: msg-flash 1.2s ease-out;
}
@keyframes msg-flash {
  0%, 30% { box-shadow: 0 0 0 3px rgba(176, 141, 87, 0.55); }
  100% { box-shadow: none; }
}
```

- [ ] **Step 6: Browser verification**

With both processes running, ask the user to:
- Open a conversation, hover a message → ⋯ → **Reply**. Confirm the composer shows a "Replying to <name>" chip with the quoted snippet + ✕.
- Send → the new bubble shows the small in-thread quote (↩ + text, no name) above it; appears for the other user too.
- Click the in-thread quote → the thread scrolls to and briefly highlights the original.
- ✕ on the chip cancels the reply.

**Wait for approval before committing.**

- [ ] **Step 7: Commit (after approval)**

```bash
git add client/src/app/chat/chat.component.ts client/src/app/chat/chat.component.html client/src/app/chat/chat.component.scss
git commit -m "feat(client): reply — composer chip, in-thread quote, scroll-to-original"
```

---

## Task 9: Frontend edit + delete — inline edit, tombstone, live sync

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`, `chat.component.html` (markup already added in Task 7)

**Browser verification gate** before commit.

- [ ] **Step 1: Edit/delete state + handlers (TS)**

Add fields near `activeMsgId`:

```typescript
  editingId: string | null = null;
  editText = '';
```

Add methods to the message-actions region:

```typescript
  // --- message actions: edit + delete --------------------------------------
  startEdit(msg: Message): void {
    if (!this.isOwn(msg) || !msg.id) return;
    this.editingId = msg.id;
    this.editText = msg.message;
    this.closeOverlays();
  }

  cancelEdit(): void {
    this.editingId = null;
    this.editText = '';
  }

  saveEdit(msg: Message): void {
    const text = this.editText.trim();
    if (!msg.id || !text) return;
    this.http
      .patch<any>(`/api/messages/${msg.id}`, { body: text }, { headers: this.authHeaders() })
      .subscribe({
        next: (res) => {
          msg.message = res?.body ?? text;
          msg.editedAt = res?.edited_at ?? new Date().toISOString();
          this.cancelEdit();
        },
        error: (err) => {
          this.cancelEdit();
          this.redirectIfUnauth(err);
        },
      });
  }

  deleteMessage(msg: Message): void {
    if (!this.isOwn(msg) || !msg.id) return;
    this.closeOverlays();
    if (!confirm('Delete this message?')) return;
    this.http
      .delete<any>(`/api/messages/${msg.id}`, { headers: this.authHeaders() })
      .subscribe({
        next: () => {
          msg.deleted = true;
          msg.message = '';
          msg.reactions = [];
        },
        error: (err) => this.redirectIfUnauth(err),
      });
  }

  private onMessageEdited(d: any): void {
    const msg = this.findMessage(d?.client_message_id);
    if (!msg) return;
    msg.message = d?.body ?? msg.message;
    msg.editedAt = d?.edited_at ?? msg.editedAt;
    this.chatHistory = { ...this.chatHistory };
  }

  private onMessageDeleted(d: any): void {
    const msg = this.findMessage(d?.client_message_id);
    if (!msg) return;
    msg.deleted = true;
    msg.message = '';
    msg.reactions = [];
    this.chatHistory = { ...this.chatHistory };
  }
```

- [ ] **Step 2: Wire the socket listeners (TS)**

In the constructor, after the `reaction_updated` listener added in Task 7, add:

```typescript
    this.socket.on('message_edited', (data: any) =>
      this.zone.run(() => this.onMessageEdited(data))
    );
    this.socket.on('message_deleted', (data: any) =>
      this.zone.run(() => this.onMessageDeleted(data))
    );
```

- [ ] **Step 3: Style inline edit + tombstone + edited label (SCSS)**

Append to `chat.component.scss`:

```scss
.message-bubble--deleted { opacity: 0.85; }
.message-bubble__tomb { font-style: italic; color: #6b4a6d; font-size: 13px; }
.message-bubble__edited { opacity: 0.7; font-style: italic; }

.message-edit {
  display: flex; flex-direction: column; gap: 6px;
  &__field {
    width: 100%; min-width: 200px; resize: vertical; font: inherit;
    border: 1px solid rgba(176, 141, 87, 0.4); border-radius: 8px; padding: 6px 8px;
    background: #fffdf8; color: #3a0e3c;
  }
  &__actions { display: flex; gap: 6px; }
  &__save, &__cancel {
    border: none; cursor: pointer; font-size: 12px; font-weight: 600;
    padding: 5px 12px; border-radius: 8px;
  }
  &__save { background: #b08d57; color: #2b1a06; }
  &__cancel { background: rgba(58, 14, 60, 0.08); color: #6b4a6d; }
}
```

(The edit textarea and tombstone markup were added to the bubble in Task 7 Step 3, so no further HTML change is needed here.)

- [ ] **Step 4: Type-check**

Run: `cd client; npm run build`
Expected: build succeeds.

- [ ] **Step 5: Browser verification**

With both processes running, ask the user to:
- Hover own message → ⋯ → **Edit** → the bubble becomes an inline textarea; change text → **Save**. The bubble updates and shows "· (edited)"; the other window updates live.
- ⋯ → **Delete** → confirm. The bubble becomes the "🚫 This message was deleted" tombstone in both windows; its reactions/menu disappear.
- Confirm a *received* message's ⋯ menu shows only **Reply** (no Edit/Delete).
- Reload → edited text + tombstone persist.

**Wait for approval before committing.**

- [ ] **Step 6: Commit (after approval)**

```bash
git add client/src/app/chat/chat.component.ts client/src/app/chat/chat.component.scss
git commit -m "feat(client): edit + delete own messages — inline edit, tombstone, live sync"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/evolution.md`

- [ ] **Step 1: Document the feature in CLAUDE.md**

In `CLAUDE.md`, add a subsection under "Architecture" (after the "Send-message dual-write" section) describing: the `client_message_id` foundation (client UUID threaded through emit + POST, backfilled at startup), the `MessageReaction` table + `reply_to`/`edited_at`/`deleted_at` columns, the `/api/messages/<id>` react/PATCH/DELETE endpoints keyed on that id, the `reaction_updated`/`message_edited`/`message_deleted` socket events broadcast to `conv:<id>`, and `serialize_messages()` as the shared payload shape. Note the brand-new-conversation live-delivery caveat.

- [ ] **Step 2: Mark the roadmap item in docs/evolution.md**

In `docs/evolution.md`, add/he move the "messaging polish (reactions, reply, edit/delete)" line to the done/shipped section with a one-line summary of the approach.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/evolution.md
git commit -m "docs: document messaging polish (reactions, reply, edit/delete)"
```

---

## Final review

- [ ] Run the full backend suite once more: `cd backend; pytest -q` — all green.
- [ ] Run the production frontend build: `cd client; npm run build` — succeeds.
- [ ] Dispatch a final code review over the whole branch, then use superpowers:finishing-a-development-branch to wrap up (open the PR / merge per the user's preference).

---

## Self-review notes (spec coverage)

- **Reactions** → Tasks 2, 3 (backend), 7 (frontend). Quick-react set, pills, picker, mine-highlight, toggle, live `reaction_updated` all covered.
- **Reply** → Tasks 5 (reply_to + reply_preview), 6 (send threading), 8 (composer chip with name, in-thread text-only quote, scroll-to). Matches the approved "text-only in-thread / named chip" decision.
- **Edit/Delete** → Tasks 4 (backend), 9 (frontend). Owner-only enforced server-side (403) and UI-side (menu only shows Edit/Delete when `isOwn`); "(edited)" label; soft-delete tombstone.
- **id foundation** → Task 1 (schema + backfill), 5 + 6 (threading). The linchpin (`client_message_id` consistency across optimistic sender / persisted row / live recipient) is satisfied by generating one UUID client-side and sending it in both the emit and the POST; the relay passes it through.
- **Affordance** → Task 7 markup: quick-react bar above bubble, ⋯ in the side gutter (`.msg-dots-wrap` flips side by sent/received), menu contents vary by ownership.
- **Type consistency:** server keys are snake_case (`reply_to`, `reply_preview`, `edited_at`, `client_message_id`); the `Message` model is camelCase (`replyTo`, `replyPreview`, `editedAt`, `id`); `toMessage()` is the single conversion point. Reaction shape `{emoji,count,mine}` is identical on both sides. `findMessage(id)` locates messages across all threads by the globally-unique id (no conv_id→key map needed on the client).
