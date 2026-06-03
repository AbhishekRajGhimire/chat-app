# File Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach files to messages (DMs + groups) — images render inline (grid + lightbox), other files as download chips — multiple per message, ≤25 MB each, on the existing `client_message_id` + layered `ChatApi`/`ChatStore` foundation.

**Architecture:** Upload-first: files POST to `/api/attachments` (bytes saved behind a swappable `storage` module, metadata in a `MessageAttachment` table), then the normal message send carries `attachment_ids` (linked server-side by `client_message_id`) + metadata (over the socket). Served via `GET /api/attachments/<id>?token=<jwt>` (reusing the socket's `?token=` pattern), membership-checked, images inline / other files `attachment`+`nosniff`.

**Tech Stack:** Flask + Flask-SocketIO + SQLite + Werkzeug (backend, `pytest`), Angular 21 / signals / `HttpClient` multipart (frontend).

---

## Verification model (read first)

- **Backend = TDD.** `cd backend; pytest -q` (run via `./.venv/Scripts/python.exe -m pytest -q` on Windows). Tests run against a temp DB + temp upload dir.
- **Frontend = production build + manual browser verification** (the Karma scaffold is pre-existing-broken; CLAUDE.md makes the prod build the gate). Every frontend task ends with `cd client; npm run build` → exit 0 (budget WARNINGS are fine; only non-zero exit / `Error:` lines fail). UI tasks have a browser checkpoint; do NOT self-verify with Playwright.

## Shared interfaces (define once — keep consistent across tasks)

**Backend helpers** (`chat/conversations.py`, pure-DB, no Flask — siblings of `reactions_for`):
```python
def attachments_for(client_message_id: str) -> list[dict]   # [{id, filename, mime, size, kind}]
def link_attachments(client_message_id: str, conversation_id: int, attachment_ids: list[int], uploader_id: int) -> None
```
**Storage module** (`chat/storage.py`):
```python
def save(file_storage) -> tuple[str, int]   # (storage_key, size_bytes)
def open_path(storage_key: str) -> str       # absolute path for send_file
def delete(storage_key: str) -> None
```
**Frontend model** (`core/models/message.model.ts`):
```typescript
export interface Attachment { id: number; filename: string; mime: string; size: number; kind: 'image' | 'file'; }
// Message gains: attachments?: Attachment[];
export interface PendingAttachment {
  localId: string; file: File; status: 'uploading' | 'done' | 'failed'; progress: number; attachment?: Attachment;
}
```
**ChatApi** (`core/chat-api.service.ts`): `uploadAttachment(file: File): Observable<HttpEvent<Attachment>>`, `attachmentUrl(id: number): string`.
**ChatStore** (`core/chat-store.service.ts`): `pendingAttachments = signal<PendingAttachment[]>([])`, `addFiles(files: FileList)`, `removePending(localId)`, `retryPending(localId)`, `hasUploading = computed(...)`; `sendMessage(entry, text, replyingTo)` consumes completed pending attachments and clears them.

---

## File structure

| File | Responsibility |
|------|----------------|
| `backend/chat/storage.py` | *create* — local-disk bytes I/O (the swappable seam) |
| `backend/chat/attachments.py` | *create* — `POST /api/attachments` (upload), `GET /api/attachments/<id>` (serve) |
| `backend/chat/database.py` | *modify* — `MessageAttachment` table |
| `backend/chat/conversations.py` | *modify* — `attachments_for`, `link_attachments`, `serialize_messages` includes attachments |
| `backend/chat/chatfunc.py`, `groups.py` | *modify* — accept `attachment_ids`, link, include metadata, relax empty-body |
| `backend/chat/__init__.py` | *modify* — import attachments, set `MAX_CONTENT_LENGTH` |
| `backend/tests/conftest.py` | *modify* — temp upload dir + wipe `MessageAttachment` |
| `backend/tests/test_attachments.py` | *create* — upload/link/serve/serialize tests |
| `.gitignore` | *modify* — `backend/uploads/` |
| `client/src/app/core/models/message.model.ts` | *modify* — `Attachment`, `PendingAttachment`, `Message.attachments` |
| `client/src/app/core/chat-api.service.ts` | *modify* — `uploadAttachment`, `attachmentUrl` |
| `client/src/app/core/chat-store.service.ts` | *modify* — pending tray + send threading + receive mapping |
| `client/src/app/chat/message-thread/*` | *modify* — image grid + lightbox + file chips + styles |
| `client/src/app/chat/attachment-tray/*` | *create* — shared composer pending-tray component |
| `client/src/app/chat/chat.component.{html,ts}` | *modify* — 📎 + tray (desktop composer) |
| `client/src/app/mobile/thread/mobile-thread.component.{html,ts}` | *modify* — 📎 + tray (mobile composer) |

---

## Phase 1 — Storage module + schema

### Task 1: Storage module + uploads gitignore + test wiring

**Files:** Create `backend/chat/storage.py`; modify `.gitignore`, `backend/tests/conftest.py`; test `backend/tests/test_attachments.py`.

- [ ] **Step 1: Point conftest at a temp upload dir + wipe the new table.** In `backend/tests/conftest.py`, after the existing `os.environ["CHAT_DB_PATH"] = ...` line add:
```python
os.environ["CHAT_UPLOAD_DIR"] = os.path.join(tempfile.mkdtemp(), "uploads")
```
and add `MessageAttachment` to the front of the `clean_db` wipe tuple:
```python
    for table in ("MessageAttachment", "MessageReaction", "Message", "ConversationMember", "Conversation", "UserProfile", "User"):
```

- [ ] **Step 2: Write the failing test.** Create `backend/tests/test_attachments.py`:
```python
import io
from werkzeug.datastructures import FileStorage

from chat import storage


def test_storage_save_and_read_roundtrip():
    fs = FileStorage(stream=io.BytesIO(b"hello-bytes"), filename="note.txt", content_type="text/plain")
    key, size = storage.save(fs)
    assert key and size == len(b"hello-bytes")
    with open(storage.open_path(key), "rb") as fh:
        assert fh.read() == b"hello-bytes"
    storage.delete(key)
```

- [ ] **Step 3: Run it to verify it fails.** `./.venv/Scripts/python.exe -m pytest tests/test_attachments.py -q` → ImportError (`chat.storage` missing).

- [ ] **Step 4: Implement `chat/storage.py`:**
```python
"""Local-disk attachment storage. The ONLY module that touches file bytes —
swap this for S3/MinIO in a multi-server deploy without changing callers."""
import os
import uuid
from pathlib import Path

_UPLOAD_DIR = Path(
    os.environ.get("CHAT_UPLOAD_DIR", Path(__file__).resolve().parent.parent / "uploads")
)


def _ensure_dir() -> None:
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def save(file_storage) -> tuple[str, int]:
    """Persist an uploaded Werkzeug FileStorage under a server-generated key
    (never the client filename → no path traversal). Returns (key, size)."""
    _ensure_dir()
    ext = os.path.splitext(file_storage.filename or "")[1][:12]
    key = uuid.uuid4().hex + ext
    dest = _UPLOAD_DIR / key
    file_storage.save(str(dest))
    return key, dest.stat().st_size


def open_path(storage_key: str) -> str:
    return str(_UPLOAD_DIR / storage_key)


def delete(storage_key: str) -> None:
    try:
        (_UPLOAD_DIR / storage_key).unlink()
    except FileNotFoundError:
        pass
```

- [ ] **Step 5: Add `backend/uploads/` to `.gitignore`** (a new line near the `*.db` entry).

- [ ] **Step 6: Run the test to verify it passes.** `./.venv/Scripts/python.exe -m pytest tests/test_attachments.py -q` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add backend/chat/storage.py backend/tests/conftest.py backend/tests/test_attachments.py .gitignore
git commit -m "feat(backend): local-disk attachment storage module (swappable seam)"
```

### Task 2: MessageAttachment table

**Files:** Modify `backend/chat/database.py`; test `backend/tests/test_attachments.py`.

- [ ] **Step 1: Write the failing test.** Append to `test_attachments.py`:
```python
from chat.database import cursor


def test_message_attachment_table_exists():
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageAttachment'")
    assert cursor.fetchone() is not None
    cursor.execute("PRAGMA table_info(MessageAttachment)")
    cols = {r[1] for r in cursor.fetchall()}
    assert {"client_message_id", "conversation_id", "uploader_user_id", "storage_key",
            "filename", "mime", "size", "kind", "created_at"} <= cols
```

- [ ] **Step 2: Run to verify it fails.** Same pytest command → AssertionError (no table).

- [ ] **Step 3: Add the table** inside `_create_conversation_schema()` in `backend/chat/database.py`, right after the `MessageReaction` index block:
```python
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS MessageAttachment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_message_id TEXT,
            conversation_id INTEGER REFERENCES Conversation(id) ON DELETE CASCADE,
            uploader_user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_attachment_cmid ON MessageAttachment(client_message_id)"
    )
```

- [ ] **Step 4: Run to verify it passes.** → PASS.

- [ ] **Step 5: Commit.**
```bash
git add backend/chat/database.py backend/tests/test_attachments.py
git commit -m "feat(backend): MessageAttachment table"
```

---

## Phase 2 — Backend endpoints + linking

### Task 3: conversations helpers (attachments_for, link_attachments) + serialize

**Files:** Modify `backend/chat/conversations.py`; test `backend/tests/test_attachments.py`.

- [ ] **Step 1: Write the failing test.** Append:
```python
from chat.conversations import attachments_for, link_attachments, serialize_messages
from chat.database import connection


def _seed_group_with_attachment(cmid="am-1"):
    cursor.execute("INSERT INTO User (username, password) VALUES ('ann', 'x')"); ann = cursor.lastrowid
    cursor.execute("INSERT INTO User (username, password) VALUES ('bo', 'x')"); bo = cursor.lastrowid
    cursor.execute("INSERT INTO Conversation (type, title, created_at, created_by_user_id) "
                   "VALUES ('group', 'G', datetime('now'), ?)", (ann,)); cid = cursor.lastrowid
    for uid in (ann, bo):
        cursor.execute("INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at) "
                       "VALUES (?, ?, 'member', datetime('now'))", (cid, uid))
    cursor.execute("INSERT INTO Message (conversation_id, sender_user_id, body, created_at, client_message_id) "
                   "VALUES (?, ?, '', datetime('now'), ?)", (cid, ann, cmid))
    cursor.execute("INSERT INTO MessageAttachment (uploader_user_id, storage_key, filename, mime, size, kind, created_at) "
                   "VALUES (?, 'k1', 'a.png', 'image/png', 12, 'image', datetime('now'))", (ann,))
    aid = cursor.lastrowid
    connection.commit()
    return cid, ann, bo, aid


def test_link_attachments_owner_only():
    cid, ann, bo, aid = _seed_group_with_attachment()
    link_attachments("am-1", cid, [aid], bo)            # bo did NOT upload it → ignored
    assert attachments_for("am-1") == []
    link_attachments("am-1", cid, [aid], ann)           # owner links it
    got = attachments_for("am-1")
    assert got == [{"id": aid, "filename": "a.png", "mime": "image/png", "size": 12, "kind": "image"}]


def test_serialize_messages_includes_attachments():
    cid, ann, bo, aid = _seed_group_with_attachment(cmid="am-2")
    link_attachments("am-2", cid, [aid], ann)
    msgs = {m["id"]: m for m in serialize_messages(cid, ann)}
    assert msgs["am-2"]["attachments"] == [{"id": aid, "filename": "a.png", "mime": "image/png", "size": 12, "kind": "image"}]
```

- [ ] **Step 2: Run to verify it fails.** → ImportError (`attachments_for` missing).

- [ ] **Step 3: Implement the helpers** in `backend/chat/conversations.py` (place after `reactions_for`):
```python
def attachments_for(client_message_id: str) -> list:
    if not client_message_id:
        return []
    cursor.execute(
        "SELECT id, filename, mime, size, kind FROM MessageAttachment "
        "WHERE client_message_id = ? ORDER BY id",
        (client_message_id,),
    )
    return [
        {"id": r[0], "filename": r[1], "mime": r[2], "size": int(r[3]), "kind": r[4]}
        for r in cursor.fetchall()
    ]


def link_attachments(client_message_id: str, conversation_id: int,
                     attachment_ids: list, uploader_id: int) -> None:
    """Attach the caller's own, still-unlinked uploads to a message."""
    for aid in attachment_ids or []:
        cursor.execute(
            "UPDATE MessageAttachment SET client_message_id = ?, conversation_id = ? "
            "WHERE id = ? AND uploader_user_id = ? AND client_message_id IS NULL",
            (client_message_id, conversation_id, aid, uploader_id),
        )
    connection.commit()
```

- [ ] **Step 4: Add attachments to `serialize_messages`.** In the same file, in `serialize_messages`, in the per-row `out.append({...})` dict, add:
```python
                "attachments": attachments_for(cmid) if cmid else [],
```

- [ ] **Step 5: Run to verify it passes.** → PASS.

- [ ] **Step 6: Commit.**
```bash
git add backend/chat/conversations.py backend/tests/test_attachments.py
git commit -m "feat(backend): attachments_for + link_attachments + serialize includes attachments"
```

### Task 4: Upload endpoint + MAX_CONTENT_LENGTH + registration

**Files:** Create `backend/chat/attachments.py`; modify `backend/chat/__init__.py`; test `backend/tests/test_attachments.py`.

- [ ] **Step 1: Write the failing test.** Append:
```python
import io as _io


def test_upload_returns_metadata_and_kind(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/attachments",
                    data={"file": (_io.BytesIO(b"\x89PNG..."), "pic.png", "image/png")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 201
    body = r.get_json()
    assert body["filename"] == "pic.png" and body["mime"] == "image/png"
    assert body["kind"] == "image" and body["size"] > 0 and isinstance(body["id"], int)


def test_upload_non_image_is_file_kind(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/attachments",
                    data={"file": (_io.BytesIO(b"%PDF-1.5"), "doc.pdf", "application/pdf")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.get_json()["kind"] == "file"
```

- [ ] **Step 2: Run to verify it fails.** → 404 (route missing).

- [ ] **Step 3: Create `backend/chat/attachments.py`** (upload only for now; serve added in Task 5):
```python
"""Attachment upload + serve. Bytes go through chat.storage; access is
membership-checked via the linked message's conversation."""
import datetime

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app
from . import storage
from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _uid(username):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    row = cursor.fetchone()
    return int(row[0]) if row else None


@app.route("/api/attachments", methods=["POST"])
@jwt_required()
def upload_attachment():
    me = _uid(get_jwt_identity())
    if me is None:
        return jsonify({"error": "User not found"}), 404
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    key, size = storage.save(f)
    mime = f.mimetype or "application/octet-stream"
    kind = "image" if mime.startswith("image/") else "file"
    cursor.execute(
        "INSERT INTO MessageAttachment "
        "(uploader_user_id, storage_key, filename, mime, size, kind, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (me, key, f.filename, mime, size, kind, _utc_now_iso()),
    )
    connection.commit()
    return jsonify({"id": cursor.lastrowid, "filename": f.filename,
                    "mime": mime, "size": size, "kind": kind}), 201
```

- [ ] **Step 4: Register + cap upload size.** In `backend/chat/__init__.py`: add `app.config["MAX_CONTENT_LENGTH"] = 26 * 1024 * 1024` (25 MB + margin) near the other `app.config[...]` lines, and add `from chat import attachments` to the bottom import block (after `from chat import messages`).

- [ ] **Step 5: Run to verify it passes.** → PASS.

- [ ] **Step 6: Commit.**
```bash
git add backend/chat/attachments.py backend/chat/__init__.py backend/tests/test_attachments.py
git commit -m "feat(backend): POST /api/attachments upload + 25MB cap"
```

### Task 5: Serve endpoint (membership + disposition + nosniff)

**Files:** Modify `backend/chat/attachments.py`; test `backend/tests/test_attachments.py`.

- [ ] **Step 1: Write the failing test.** Append (uses helpers from earlier in the file):
```python
def test_serve_member_gets_bytes_and_disposition(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    # group via existing endpoint so both are members
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"PNGDATA"), "p.png", "image/png")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    client.post(f"/api/groups/{cid}/messages",
                json={"body": "", "client_message_id": "att-msg", "attachment_ids": [up["id"]]},
                headers=alice["headers"])
    token = bob["headers"]["Authorization"].split()[1]
    r = client.get(f"/api/attachments/{up['id']}?token={token}")
    assert r.status_code == 200 and r.data == b"PNGDATA"
    assert "inline" in r.headers.get("Content-Disposition", "")


def test_serve_non_member_forbidden(client, make_user):
    alice = make_user("alice"); make_user("bob"); carol = make_user("carol")
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"x"), "d.pdf", "application/pdf")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    client.post(f"/api/groups/{cid}/messages",
                json={"body": "", "client_message_id": "att-2", "attachment_ids": [up["id"]]},
                headers=alice["headers"])
    token = carol["headers"]["Authorization"].split()[1]
    r = client.get(f"/api/attachments/{up['id']}?token={token}")
    assert r.status_code == 403
```
(These also exercise Task 6's send-linking; if Task 6 isn't done yet they'll fail on linking — implement Task 6 first if you prefer, or run these after Task 6. Order note: **do Task 6 before running Step 2** since serve depends on a linked attachment.)

- [ ] **Step 2: Implement serve** — append to `backend/chat/attachments.py`:
```python
from flask import send_file
from flask_jwt_extended import decode_token
from .conversations import is_member


def _username_from_token(token):
    try:
        sub = decode_token(token).get("sub")
        return sub.strip() if isinstance(sub, str) and sub.strip() else None
    except Exception:
        return None


@app.route("/api/attachments/<int:aid>", methods=["GET"])
def serve_attachment(aid):
    token = request.args.get("token", "")
    username = _username_from_token(token)
    me = _uid(username) if username else None
    if me is None:
        return jsonify({"error": "auth required"}), 401
    cursor.execute(
        "SELECT a.storage_key, a.filename, a.mime, a.kind, a.conversation_id, m.deleted_at "
        "FROM MessageAttachment a "
        "LEFT JOIN Message m ON m.client_message_id = a.client_message_id "
        "WHERE a.id = ?",
        (aid,),
    )
    row = cursor.fetchone()
    if not row or row[4] is None or row[5] is not None:   # unlinked or deleted message
        return jsonify({"error": "not found"}), 404
    storage_key, filename, mime, kind, conv_id, _deleted = row
    if not is_member(int(conv_id), me):
        return jsonify({"error": "forbidden"}), 403
    resp = send_file(storage.open_path(storage_key), mimetype=mime,
                     as_attachment=(kind != "image"), download_name=filename)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp
```
(Note: `serve_attachment` has **no `@jwt_required()`** because the token rides in the query string for `<img>` compatibility — it's decoded manually.)

- [ ] **Step 3: Run to verify it passes** (after Task 6 exists). → PASS.

- [ ] **Step 4: Commit.**
```bash
git add backend/chat/attachments.py backend/tests/test_attachments.py
git commit -m "feat(backend): GET /api/attachments/<id> serve (membership + inline/attachment + nosniff)"
```

### Task 6: Thread attachment_ids through sends (DM + group)

**Files:** Modify `backend/chat/chatfunc.py`, `backend/chat/groups.py`; test `backend/tests/test_attachments.py`.
**Do this before running Task 5 Step 3.**

- [ ] **Step 1: Write the failing test.** Append:
```python
def test_group_send_links_attachment_and_serializes(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"img"), "p.png", "image/png")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    r = client.post(f"/api/groups/{cid}/messages",
                    json={"body": "", "client_message_id": "g-att", "attachment_ids": [up["id"]]},
                    headers=alice["headers"])
    assert r.status_code == 201
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    m = next(x for x in msgs if x["id"] == "g-att")
    assert [a["id"] for a in m["attachments"]] == [up["id"]]


def test_dm_send_allows_empty_body_with_attachment(client, make_user):
    alice = make_user("alice"); make_user("bob")
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"img"), "p.png", "image/png")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    r = client.post("/api/dm/messages",
                    json={"to_username": "bob", "body": "", "client_message_id": "d-att",
                          "attachment_ids": [up["id"]]}, headers=alice["headers"])
    assert r.status_code == 201
    msgs = client.get("/api/dm/messages/bob", headers=alice["headers"]).get_json()["messages"]
    assert any(x["id"] == "d-att" and len(x["attachments"]) == 1 for x in msgs)
```

- [ ] **Step 2: Run to verify it fails.** → empty body rejected / no attachments linked.

- [ ] **Step 3: Group send.** In `backend/chat/groups.py`, add `link_attachments` to the `from .conversations import (...)` block. In `post_group_message`, replace the body-validation + insert region:
```python
    data = request.get_json(silent=True) or {}
    body = data.get("body")
    attachment_ids = data.get("attachment_ids") or []
    if not isinstance(attachment_ids, list):
        attachment_ids = []
    has_body = isinstance(body, str) and body.strip()
    if not has_body and not attachment_ids:
        return jsonify({"error": "body or attachment required"}), 400
    body = body.strip() if isinstance(body, str) else ""
    now = _utc_now_iso()
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
    connection.commit()
    link_attachments(cmid, cid, attachment_ids, uid)
```
and change its return to include attachments:
```python
    from .conversations import attachments_for
    return jsonify({"message": "ok", "datetime": now, "client_message_id": cmid,
                    "attachments": attachments_for(cmid)}), 201
```

- [ ] **Step 4: DM send.** In `backend/chat/chatfunc.py`, add `attachments_for, link_attachments` to the `from .conversations import (...)` block. In `post_dm_message`, replace the body check + insert similarly:
```python
    body = data.get("body")
    attachment_ids = data.get("attachment_ids") or []
    if not isinstance(attachment_ids, list):
        attachment_ids = []
    if (not isinstance(body, str) or not body.strip()) and not attachment_ids:
        return jsonify({"error": "body or attachment required"}), 400
    body = body.strip() if isinstance(body, str) else ""
```
(Keep the existing `to_username` validation above it; remove the old `body required` 400.) After the `INSERT INTO Message (...)` + `connection.commit()`, add:
```python
    link_attachments(cmid, cid, attachment_ids, int(me_row[0]))
```
and add `"attachments": attachments_for(cmid)` to the success `jsonify({...})` response dict.

- [ ] **Step 5: Pass attachment metadata over the socket.** In `chatfunc.py` `handle_message`, in the `extra` dict add `"attachments": data.get("attachments") or []` (the client emits the metadata array; the server just relays it).

- [ ] **Step 6: Run the attachment + dm + group tests.**
```
./.venv/Scripts/python.exe -m pytest tests/test_attachments.py tests/test_dm.py tests/test_groups.py -q
```
Expected: PASS (Task 5's serve tests now pass too).

- [ ] **Step 7: Full suite.** `./.venv/Scripts/python.exe -m pytest -q` → all green.

- [ ] **Step 8: Commit.**
```bash
git add backend/chat/chatfunc.py backend/chat/groups.py backend/tests/test_attachments.py
git commit -m "feat(backend): link attachment_ids through DM + group sends; relay over socket"
```

---

## Phase 3 — Frontend transport + store

### Task 7: Models + ChatApi upload/url

**Files:** Modify `client/src/app/core/models/message.model.ts`, `client/src/app/core/chat-api.service.ts`.

- [ ] **Step 1: Models.** In `message.model.ts` add the `Attachment` + `PendingAttachment` interfaces from "Shared interfaces" and add `attachments?: Attachment[];` to `Message`.

- [ ] **Step 2: ChatApi.** In `chat-api.service.ts` add (import `HttpEvent` from `@angular/common/http` and `Attachment` from the model):
```typescript
  uploadAttachment(file: File): Observable<HttpEvent<Attachment>> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Attachment>('/api/attachments', form, {
      headers: this.headers(), reportProgress: true, observe: 'events',
    });
  }
  attachmentUrl(id: number): string {
    return `/api/attachments/${id}?token=${localStorage.getItem('access_token')}`;
  }
```

- [ ] **Step 3: Build.** `cd client; npm run build` → exit 0.

- [ ] **Step 4: Commit.**
```bash
git add client/src/app/core/models/message.model.ts client/src/app/core/chat-api.service.ts
git commit -m "feat(client): Attachment model + ChatApi upload/url"
```

### Task 8: ChatStore pending tray + send threading + receive mapping

**Files:** Modify `client/src/app/core/chat-store.service.ts`.

- [ ] **Step 1: Add pending state + computed.** Import `HttpEventType` from `@angular/common/http` and `Attachment, PendingAttachment` from the model. Add fields:
```typescript
  readonly pendingAttachments = signal<PendingAttachment[]>([]);
  readonly hasUploading = computed(() => this.pendingAttachments().some(p => p.status === 'uploading'));
```

- [ ] **Step 2: Add upload actions:**
```typescript
  addFiles(files: FileList | File[]): void {
    Array.from(files).forEach((file) => {
      const localId = this.newId();
      this.pendingAttachments.update(p => [...p, { localId, file, status: 'uploading', progress: 0 }]);
      this.uploadOne(localId, file);
    });
  }

  private uploadOne(localId: string, file: File): void {
    this.chatApi.uploadAttachment(file).subscribe({
      next: (ev: any) => {
        if (ev.type === HttpEventType.UploadProgress && ev.total) {
          const progress = Math.round((100 * ev.loaded) / ev.total);
          this.patchPending(localId, { progress });
        } else if (ev.type === HttpEventType.Response) {
          this.patchPending(localId, { status: 'done', progress: 100, attachment: ev.body });
        }
      },
      error: () => this.patchPending(localId, { status: 'failed' }),
    });
  }

  private patchPending(localId: string, patch: Partial<PendingAttachment>): void {
    this.pendingAttachments.update(list =>
      list.map(p => (p.localId === localId ? { ...p, ...patch } : p)));
  }

  removePending(localId: string): void {
    this.pendingAttachments.update(list => list.filter(p => p.localId !== localId));
  }

  retryPending(localId: string): void {
    const p = this.pendingAttachments().find(x => x.localId === localId);
    if (!p) return;
    this.patchPending(localId, { status: 'uploading', progress: 0 });
    this.uploadOne(localId, p.file);
  }
```

- [ ] **Step 3: Thread attachments through `sendMessage`.** Change the guard + optimistic message + payloads so completed attachments are included and the tray clears. Replace the body of `sendMessage`:
```typescript
  sendMessage(entry: ConversationEntry, text: string, replyingTo: Message | null): void {
    const ready = this.pendingAttachments().filter(p => p.status === 'done' && p.attachment);
    const attachments = ready.map(p => p.attachment!) as Attachment[];
    if (this.isSendingMessage || (!text.trim() && attachments.length === 0) || !entry) return;

    const msg: Message = {
      id: this.newId(),
      from: this.currentUser,
      to: entry.key,
      message: text,
      datetime: new Date().toISOString(),
      status: 'sending',
      reactions: [],
      replyTo: replyingTo?.id ?? null,
      replyPreview: replyingTo ? replyingTo.message : null,
      attachments,
    };
    this.chatHistory.update(h => ({ ...h, [entry.key]: [...(h[entry.key] ?? []), msg] }));
    entry.last_message = text || (attachments.length ? '📎 Attachment' : '');
    entry.last_message_at = msg.datetime;
    // clear only the attachments we just sent (keep any still uploading/failed)
    const sentIds = new Set(ready.map(p => p.localId));
    this.pendingAttachments.update(list => list.filter(p => !sentIds.has(p.localId)));

    this.postMessage(entry, text, msg);
  }
```

- [ ] **Step 4: Include ids + metadata in `postMessage`.** In the group branch's emit + POST and the direct branch's emit + POST, add the attachment fields. The POST bodies get `attachment_ids`, the socket emits get `attachments`:
```typescript
    const attachmentIds = (msg.attachments ?? []).map(a => a.id);
    const attachmentsMeta = msg.attachments ?? [];
```
then in each `emitSend({...})` add `attachments: attachmentsMeta`, and in each `postGroup`/`postDm` call append the ids. Update the `ChatApi.postGroup`/`postDm` signatures (and the calls) to accept a trailing `attachmentIds: number[]`:
  - In `chat-api.service.ts`: `postDm(toUsername, body, clientMessageId, replyTo, attachmentIds: number[] = [])` → add `attachment_ids: attachmentIds` to the JSON body; same for `postGroup`.
  - In `postMessage`, pass `attachmentIds` as the new arg.

- [ ] **Step 5: Map incoming attachments.** In `toMessage`, add `attachments: Array.isArray(raw.attachments) ? raw.attachments : [],`. (The history rows and the socket `receive_message` both carry `attachments` now.)

- [ ] **Step 6: Build.** `npm run build` → exit 0.

- [ ] **Step 7: Commit.**
```bash
git add client/src/app/core/chat-store.service.ts client/src/app/core/chat-api.service.ts
git commit -m "feat(client): ChatStore pending-attachment tray + send threading"
```

---

## Phase 4 — Rendering + composer (browser-verified)

### Task 9: Render attachments in the thread (grid + lightbox + chips)

**Files:** Modify `client/src/app/chat/message-thread/message-thread.component.{ts,html,scss}`.

- [ ] **Step 1: Component.** In `message-thread.component.ts` inject `ChatApi` (public, for the template `attachmentUrl`), add lightbox state + a size formatter + a file-icon helper:
```typescript
  lightboxUrl: string | null = null;
  constructor(public api: ChatApi) {}   // (merge into existing constructor if present)
  openLightbox(url: string) { this.lightboxUrl = url; }
  closeLightbox() { this.lightboxUrl = null; }
  prettySize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  fileIcon(_mime: string): string { return '📄'; }
```
(If `MessageThreadComponent` has no constructor yet, add one injecting `ChatApi`. `ChatApi` is `providedIn: 'root'`, so no module change needed.)

- [ ] **Step 2: Template.** In `message-thread.component.html`, inside the `.message-bubble`, **before** the text block, add the attachments:
```html
                    @if (message.attachments && message.attachments.length && !message.deleted) {
                      <div class="msg-attach">
                        @for (a of message.attachments; track a.id) {
                          @if (a.kind === 'image') {
                            <button type="button" class="msg-attach__img" (click)="openLightbox(api.attachmentUrl(a.id)); $event.stopPropagation()">
                              <img [src]="api.attachmentUrl(a.id)" [alt]="a.filename" loading="lazy">
                            </button>
                          } @else {
                            <a class="msg-attach__file" [href]="api.attachmentUrl(a.id)" target="_blank" rel="noopener" (click)="$event.stopPropagation()">
                              <span class="msg-attach__ic">{{ fileIcon(a.mime) }}</span>
                              <span class="msg-attach__meta">
                                <span class="msg-attach__name">{{ a.filename }}</span>
                                <span class="msg-attach__size">{{ prettySize(a.size) }}</span>
                              </span>
                              <span class="msg-attach__dl">⤓</span>
                            </a>
                          }
                        }
                      </div>
                    }
```
Then at the very end of the component template add a lightbox overlay:
```html
@if (lightboxUrl) {
  <div class="lightbox" (click)="closeLightbox()">
    <img [src]="lightboxUrl" alt="">
    <button type="button" class="lightbox__x" (click)="closeLightbox()">✕</button>
  </div>
}
```

- [ ] **Step 3: Styles.** Append to `message-thread.component.scss` (Atelier tokens; `@import '../../ui/styles/tokens';` already present): a `.msg-attach` wrapper (gap, margin under), `.msg-attach__img img` (max-width ~240px, `border-radius: 10px`, `object-fit: cover`, multiple images flow as a wrap/grid), `.msg-attach__file` chip (flex row, icon tile, name/size, download glyph; a `--sent` variant via `.message-bubble--sent &` using ivory text), and a fixed full-screen `.lightbox` (dark scrim, centered `img { max-width:92vw; max-height:88vh }`, a `.lightbox__x` close button). Keep within the 20 kB component-style budget.

- [ ] **Step 4: Build.** `npm run build` → exit 0.

- [ ] **Step 5: Commit (rendering can be browser-verified together with Task 10).**
```bash
git add client/src/app/chat/message-thread
git commit -m "feat(client): render image grid + lightbox + file chips in the thread"
```

### Task 10: Shared attachment tray + composer paperclip (desktop + mobile)

**Files:** Create `client/src/app/chat/attachment-tray/attachment-tray.component.{ts,html,scss}`; modify `client/src/app/chat/shared-chat.module.ts`, `client/src/app/chat/chat.component.{html,ts}`, `client/src/app/mobile/thread/mobile-thread.component.{html,ts}`.

- [ ] **Step 1: Shared tray component.** Create `AttachmentTrayComponent` (`selector: app-attachment-tray`, `standalone: false`) that reads `store.pendingAttachments()` and renders thumbnails (image: `URL.createObjectURL(p.file)`; file: chip) with a progress bar, a ✕ (`store.removePending`), and a failed/retry state (`store.retryPending`). Inject `public store: ChatStore`. Build the object URL once per pending item (a `Map<string,string>` keyed by `localId`, revoked on remove) to avoid re-creating it each change-detection. Declare + export it in `SharedChatModule` (so both desktop AppModule and the mobile module get it).

```typescript
import { Component } from '@angular/core';
import { ChatStore } from '../../core/chat-store.service';
import { PendingAttachment } from '../../core/models/message.model';

@Component({ selector: 'app-attachment-tray', templateUrl: './attachment-tray.component.html',
  styleUrls: ['./attachment-tray.component.scss'], standalone: false })
export class AttachmentTrayComponent {
  private urls = new Map<string, string>();
  constructor(public store: ChatStore) {}
  thumb(p: PendingAttachment): string {
    if (!this.urls.has(p.localId)) this.urls.set(p.localId, URL.createObjectURL(p.file));
    return this.urls.get(p.localId)!;
  }
  isImage(p: PendingAttachment): boolean { return p.file.type.startsWith('image/'); }
  remove(p: PendingAttachment): void {
    const u = this.urls.get(p.localId);
    if (u) { URL.revokeObjectURL(u); this.urls.delete(p.localId); }
    this.store.removePending(p.localId);
  }
}
```
Template renders `@if (store.pendingAttachments().length) { <div class="tray"> @for (p of store.pendingAttachments(); track p.localId) { … } </div> }` with image thumb or a file chip, a `.tray__bar` progress (`[style.width.%]="p.progress"`) when `uploading`, a `✕` calling `remove(p)`, and a "Retry" link when `p.status === 'failed'`. SCSS: a horizontal wrapping row of 60×60 rounded thumbnails / chips, Atelier tokens.

- [ ] **Step 2: Desktop composer.** In `chat.component.html`, just above the `.message-input` block, add `<app-attachment-tray></app-attachment-tray>`. Inside `.message-input`, add a paperclip button + hidden input before the textarea:
```html
          <button type="button" class="composer-clip" (click)="fileInput.click()" aria-label="Attach files">
            <mat-icon>attach_file</mat-icon>
          </button>
          <input #fileInput type="file" multiple hidden (change)="onFilesPicked($event)">
```
In `chat.component.ts` add:
```typescript
  onFilesPicked(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) this.store.addFiles(input.files);
    input.value = '';
  }
```
Update the send button's `[disabled]` to also allow attachments: `[disabled]="!newMessage.trim() && !store.pendingAttachments().length"` (and the `sendMessage()` wrapper already calls `store.sendMessage(...)`, which now handles attachments).

- [ ] **Step 3: Mobile composer.** In `mobile-thread.component.html`, add `<app-attachment-tray></app-attachment-tray>` just inside `.mt-composer` (above `.mt-inputrow`), and a paperclip button + hidden input inside `.mt-inputrow` before the textarea (same pattern). In `mobile-thread.component.ts` add the same `onFilesPicked` method, and update the send button `[disabled]` to `!newMessage.trim() && !store.pendingAttachments().length`.

- [ ] **Step 4: Build.** `npm run build` → exit 0.

- [ ] **Step 5: Browser checkpoint (desktop + mobile).** Start both processes (`python main.py`, `npm run start`). Verify, on desktop (full width) and mobile (DevTools device toolbar):
  - 📎 → pick image(s) + a non-image file → they appear in the tray with progress, then "done"; ✕ removes one.
  - Send (with or without text) → the message shows the image grid + file chip; the peer (second window) receives them live; clicking an image opens the lightbox; clicking a file downloads it.
  - Reload → attachments still render (served via token URL).
  - A >25 MB file → friendly failure in the tray (server 413). A non‑member can't fetch the URL (manently: paste an attachment URL while logged in as a non‑member → blocked).

  **Wait for approval before committing.**

- [ ] **Step 6: Commit (after approval).**
```bash
git add client/src/app/chat client/src/app/mobile/thread
git commit -m "feat(client): composer attach (📎) + shared pending tray on desktop + mobile"
```

---

## Phase 5 — Docs + final

### Task 11: Documentation

**Files:** Modify `docs/system-design.md`, `docs/evolution.md`, `CLAUDE.md`.

- [ ] **Step 1:** `docs/system-design.md` — add `POST /api/attachments` + `GET /api/attachments/<id>?token=` to the HTTP table, the `MessageAttachment` table to the schema section, and note `attachment_ids` on the send endpoints + `attachments` in message payloads.
- [ ] **Step 2:** `docs/evolution.md` — add a "File attachments — delivered" note **including the production-evolution paragraph** (disk → S3/MinIO via the `chat/storage.py` seam + pre-signed URLs; Redis Socket.IO adapter for multi-server realtime).
- [ ] **Step 3:** `CLAUDE.md` — under Architecture, a short "Attachments" note: upload-first flow, `chat/storage.py` is the only bytes seam, token-in-URL serve with inline-images / attachment+nosniff, `MessageAttachment` keyed on `client_message_id`, pending tray owned by `ChatStore`.
- [ ] **Step 4: Commit.**
```bash
git add docs/system-design.md docs/evolution.md CLAUDE.md
git commit -m "docs: file attachments + storage-seam production note"
```

### Task 12: Final review

- [ ] **Step 1:** `cd backend; ./.venv/Scripts/python.exe -m pytest -q` → all green (existing 42 + the new attachment tests).
- [ ] **Step 2:** `cd client; npm run build` → exit 0.
- [ ] **Step 3:** Final dispatch a code review over the branch, then `superpowers:finishing-a-development-branch` (PR/merge per the user's preference).

---

## Self-review (plan vs spec)

- **Images + any file; multiple per message; 25 MB** → Task 4 (`MAX_CONTENT_LENGTH`, kind), Task 8 (multi pending), Task 9 (grid/chip). ✓
- **Storage seam** → Task 1 (`chat/storage.py`, only bytes I/O). ✓
- **`MessageAttachment` keyed on `client_message_id`** → Task 2 + Task 3. ✓
- **Upload-first + link on send** → Task 4 (upload), Task 6 (link through DM+group), Task 8 (client threading). ✓
- **Token-in-URL serve, membership, inline/attachment+nosniff, deleted refuse** → Task 5. ✓
- **Pending tray owned by ChatStore; both composers thin** → Task 8 (store) + Task 10 (shared tray on desktop + mobile). ✓
- **Render grid + lightbox + chips in shared thread** → Task 9. ✓
- **Tests** → Tasks 1–6. **Production note** → Task 11. ✓
- **Type consistency:** `Attachment {id,filename,mime,size,kind}` identical backend↔frontend; `attachments_for`/`link_attachments`/`storage.save|open_path|delete`/`uploadAttachment`/`attachmentUrl`/`pendingAttachments`/`addFiles`/`removePending`/`retryPending` named once and reused. ✓
- **Ordering caveat fixed:** Task 5's serve tests depend on Task 6's linking — flagged to implement Task 6 before running them. ✓
