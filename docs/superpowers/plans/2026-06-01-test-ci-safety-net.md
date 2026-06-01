# Test + CI Safety Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend pytest coverage of the critical auth/DM/group/room paths against an isolated test DB, plus GitHub Actions CI gating backend tests and the frontend production build.

**Architecture:** Parameterize the SQLite path via `CHAT_DB_PATH` so tests use a temp DB; a `conftest.py` sets that + test secrets before importing the app and provides a Flask test client, a per-test table-wipe, and an auth helper. Tests verify *current* behavior (they should pass as written). CI runs backend pytest and `npm run build` in parallel.

**Tech Stack:** pytest, Flask test client, Flask-SocketIO test client (skippable), GitHub Actions.

**Verification model:** Each test task ends with `pytest -q` GREEN for that file. Final: full `pytest` + `npm run build` both green. These ARE the tests — no separate gate.

**Spec:** `docs/superpowers/specs/2026-06-01-test-ci-safety-net-design.md`
**Branch:** `feature/test-ci-safety-net` (created; spec committed).

---

### Task 1: Test DB isolation + pytest scaffolding

**Files:** Modify `backend/chat/database.py`; Create `backend/requirements-dev.txt`, `backend/pytest.ini`, `backend/tests/__init__.py`, `backend/tests/conftest.py`

- [ ] **Step 1:** In `database.py`, parameterize the path. Replace the top:

```python
import os
import sqlite3

# Path is overridable for tests (CHAT_DB_PATH); defaults to the dev/prod file.
connection = sqlite3.connect(os.environ.get("CHAT_DB_PATH", "chat.db"), check_same_thread=False)
cursor = connection.cursor()
cursor.execute("PRAGMA foreign_keys = ON")
```

- [ ] **Step 2:** Create `backend/requirements-dev.txt`:

```
pytest
```

- [ ] **Step 3:** Create `backend/pytest.ini`:

```ini
[pytest]
testpaths = tests
filterwarnings =
    ignore::DeprecationWarning
```

- [ ] **Step 4:** Create empty `backend/tests/__init__.py`.

- [ ] **Step 5:** Create `backend/tests/conftest.py`. Env setup MUST be at the very top, before importing `chat`:

```python
import os
import tempfile

# Set BEFORE importing the app so the DB + secret guards use test values.
os.environ["CHAT_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("JWT_SECRET_KEY", "test-jwt-secret")
os.environ.setdefault("FLASK_DEBUG", "true")

import pytest
from chat import app as flask_app
from chat.database import connection, cursor


@pytest.fixture
def app():
    flask_app.config.update(TESTING=True)
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def clean_db():
    """Wipe all rows between tests (single shared connection → must isolate)."""
    yield
    for table in ("Message", "ConversationMember", "Conversation", "UserProfile", "User"):
        cursor.execute(f"DELETE FROM {table}")
    connection.commit()


@pytest.fixture
def make_user(client):
    def _make(username="alice", password="pw"):
        client.post("/api/signup", json={"username": username, "password": password})
        resp = client.post("/api/signin", json={"username": username, "password": password})
        token = resp.get_json()["access_token"]
        return {
            "username": username,
            "headers": {"Authorization": f"Bearer {token}"},
        }
    return _make
```

- [ ] **Step 6:** Install dev deps and run the empty suite to prove collection works.
Run: `cd backend; .\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt; .\.venv\Scripts\python.exe -m pytest -q`
Expected: `no tests ran` (collection succeeds, no errors).
- [ ] **Step 7: Commit** `test(backend): pytest scaffolding + CHAT_DB_PATH isolation`

---

### Task 2: Helper unit tests

**Files:** Create `backend/tests/test_helpers.py`

- [ ] **Step 1:** Write the tests:

```python
from chat.conversations import (
    conversation_room,
    create_group_conversation,
    get_or_create_direct_conversation,
    group_members,
    is_member,
    user_conversation_ids,
)
from chat.database import connection, cursor


def _user(username):
    cursor.execute("INSERT INTO User (username, password) VALUES (?, 'x')", (username,))
    connection.commit()
    return cursor.lastrowid


def test_conversation_room():
    assert conversation_room(7) == "conv:7"


def test_direct_conversation_idempotent_and_normalized():
    a, b = _user("a"), _user("b")
    cid1 = get_or_create_direct_conversation(a, b)
    cid2 = get_or_create_direct_conversation(b, a)  # reversed order
    assert cid1 == cid2
    assert set(m["username"] for m in group_members(cid1)) == {"a", "b"}


def test_create_group_and_membership():
    creator, m1, m2 = _user("c"), _user("m1"), _user("m2")
    cid = create_group_conversation(creator, "Crew", [m1, m2])
    members = {m["username"] for m in group_members(cid)}
    assert members == {"c", "m1", "m2"}
    assert is_member(cid, creator) is True
    assert is_member(cid, _user("outsider")) is False
    assert cid in user_conversation_ids(creator)
```

- [ ] **Step 2:** Run: `cd backend; .\.venv\Scripts\python.exe -m pytest tests/test_helpers.py -q` → Expected: PASS (3 tests).
- [ ] **Step 3: Commit** `test(backend): conversation helper unit tests`

---

### Task 3: Auth tests

**Files:** Create `backend/tests/test_auth.py`

- [ ] **Step 1:** Write the tests:

```python
def test_signup_creates_user_and_profile(client):
    r = client.post("/api/signup", json={"username": "alice", "password": "pw"})
    assert r.status_code == 201
    from chat.database import cursor
    cursor.execute("SELECT id FROM User WHERE username='alice'")
    uid = cursor.fetchone()[0]
    cursor.execute("SELECT 1 FROM UserProfile WHERE user_id=?", (uid,))
    assert cursor.fetchone() is not None


def test_duplicate_username_conflicts(client):
    client.post("/api/signup", json={"username": "alice", "password": "pw"})
    r = client.post("/api/signup", json={"username": "alice", "password": "pw2"})
    assert r.status_code == 409


def test_signin_good_and_bad(client):
    client.post("/api/signup", json={"username": "alice", "password": "pw"})
    ok = client.post("/api/signin", json={"username": "alice", "password": "pw"})
    assert ok.status_code == 200 and "access_token" in ok.get_json()
    bad = client.post("/api/signin", json={"username": "alice", "password": "nope"})
    assert bad.status_code == 401


def test_protected_route_requires_token(client):
    r = client.get("/api/chats_history")
    assert r.status_code in (401, 422)
```

- [ ] **Step 2:** Run: `pytest tests/test_auth.py -q` → Expected: PASS (4 tests).
- [ ] **Step 3: Commit** `test(backend): auth flow tests`

---

### Task 4: DM tests

**Files:** Create `backend/tests/test_dm.py`

- [ ] **Step 1:** Write the tests:

```python
def test_dm_post_and_history(make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    r = make_user.__self__ if False else None  # noqa (placeholder removed below)
    from flask import current_app  # noqa

    # send alice -> bob
    import json
    # use the same client via fixture indirection:
def _send(client, sender, to, body):
    return client.post("/api/dm/messages", json={"to_username": to, "body": body},
                       headers=sender["headers"])
```

> NOTE for implementer: the snippet above shows intent only. Implement the file cleanly as:

```python
def test_dm_post_and_history(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    r = client.post("/api/dm/messages",
                    json={"to_username": "bob", "body": "hi bob"},
                    headers=alice["headers"])
    assert r.status_code == 201
    # both participants see it
    a_hist = client.get("/api/dm/messages/bob", headers=alice["headers"]).get_json()
    b_hist = client.get("/api/dm/messages/alice", headers=bob["headers"]).get_json()
    assert any(m["message"] == "hi bob" for m in a_hist)
    assert any(m["message"] == "hi bob" for m in b_hist)


def test_cannot_message_self(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/dm/messages", json={"to_username": "alice", "body": "x"},
                    headers=alice["headers"])
    assert r.status_code == 400


def test_unknown_recipient(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/dm/messages", json={"to_username": "ghost", "body": "x"},
                    headers=alice["headers"])
    assert r.status_code == 400


def test_third_user_cannot_see_pair_messages(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    carol = make_user("carol")
    client.post("/api/dm/messages", json={"to_username": "bob", "body": "secret"},
                headers=alice["headers"])
    # carol's view of her conversation with alice is empty
    hist = client.get("/api/dm/messages/alice", headers=carol["headers"]).get_json()
    assert all(m["message"] != "secret" for m in hist)
```

- [ ] **Step 2:** Run: `pytest tests/test_dm.py -q` → Expected: PASS (4 tests). Delete the intent-only placeholder snippet; keep only the clean implementations.
- [ ] **Step 3: Commit** `test(backend): direct-message tests`

---

### Task 5: Group tests

**Files:** Create `backend/tests/test_groups.py`

- [ ] **Step 1:** Write the tests:

```python
def _make_group(client, owner, title="Crew", members=None):
    return client.post("/api/groups",
                       json={"title": title, "members": members or []},
                       headers=owner["headers"])


def test_create_group(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    r = _make_group(client, alice, members=["bob"])
    assert r.status_code == 201
    g = r.get_json()
    assert g["title"] == "Crew"
    assert g["member_count"] == 2
    assert {m["username"] for m in g["members"]} == {"alice", "bob"}


def test_non_member_forbidden(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    cid = _make_group(client, alice, members=["bob"]).get_json()["conversation_id"]
    carol = make_user("carol")
    assert client.get(f"/api/groups/{cid}", headers=carol["headers"]).status_code == 403
    assert client.post(f"/api/groups/{cid}/messages", json={"body": "x"},
                       headers=carol["headers"]).status_code == 403


def test_add_remove_leave(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    make_user("carol")
    cid = _make_group(client, alice, members=["bob"]).get_json()["conversation_id"]
    add = client.post(f"/api/groups/{cid}/members", json={"members": ["carol"]},
                      headers=alice["headers"]).get_json()
    assert {m["username"] for m in add["members"]} == {"alice", "bob", "carol"}
    rem = client.delete(f"/api/groups/{cid}/members/bob", headers=alice["headers"]).get_json()
    assert "bob" not in {m["username"] for m in rem["members"]}
    client.post(f"/api/groups/{cid}/leave", headers=alice["headers"])
    # alice no longer a member -> 403
    assert client.get(f"/api/groups/{cid}", headers=alice["headers"]).status_code == 403


def test_group_message_persists(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    cid = _make_group(client, alice, members=["bob"]).get_json()["conversation_id"]
    assert client.post(f"/api/groups/{cid}/messages", json={"body": "hello crew"},
                       headers=alice["headers"]).status_code == 201
    msgs = client.get(f"/api/groups/{cid}/messages", headers=alice["headers"]).get_json()
    assert any(m["message"] == "hello crew" for m in msgs)


def test_chats_history_includes_dms_and_groups(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    client.post("/api/dm/messages", json={"to_username": "bob", "body": "hi"},
                headers=alice["headers"])
    _make_group(client, alice, members=["bob"], title="Crew")
    hist = client.get("/api/chats_history", headers=alice["headers"]).get_json()
    kinds = {e["kind"] for e in hist}
    assert "direct" in kinds and "group" in kinds
    grp = next(e for e in hist if e["kind"] == "group")
    assert grp["title"] == "Crew" and "conversation_id" in grp
```

- [ ] **Step 2:** Run: `pytest tests/test_groups.py -q` → Expected: PASS (5 tests).
- [ ] **Step 3: Commit** `test(backend): group endpoint + membership tests`

---

### Task 6: Skippable Socket.IO smoke test

**Files:** Create `backend/tests/test_socket.py`

- [ ] **Step 1:** Write a guarded smoke test that skips if the test client can't run:

```python
import pytest


def _client_for(make_user, username):
    user = make_user(username)
    token = user["headers"]["Authorization"].split(" ", 1)[1]
    return user, token


def test_socket_rejects_without_token(app, make_user):
    from chat import socketio
    try:
        c = socketio.test_client(app, query_string="")
    except Exception as e:
        pytest.skip(f"socketio test client unavailable: {e}")
    assert c.is_connected() is False


def test_socket_group_delivery(app, make_user, client):
    from chat import socketio
    alice = make_user("alice")
    make_user("bob")
    cid = client.post("/api/groups", json={"title": "Crew", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    a_tok = alice["headers"]["Authorization"].split(" ", 1)[1]
    bob_signin = client.post("/api/signin", json={"username": "bob", "password": "pw"}).get_json()
    b_tok = bob_signin["access_token"]
    try:
        ca = socketio.test_client(app, query_string=f"token={a_tok}")
        cb = socketio.test_client(app, query_string=f"token={b_tok}")
    except Exception as e:
        pytest.skip(f"socketio test client unavailable: {e}")
    if not (ca.is_connected() and cb.is_connected()):
        pytest.skip("socket clients did not connect in this environment")
    cb.get_received()  # drain
    ca.emit("send_message", {"conversation_id": cid, "message": "yo"})
    received = cb.get_received()
    assert any(
        pkt["name"] == "receive_message" and pkt["args"][0].get("message") == "yo"
        for pkt in received
    )
```

- [ ] **Step 2:** Run: `pytest tests/test_socket.py -q` → Expected: PASS or SKIP (never fail). If it fails on an assertion (not a skip), investigate before continuing.
- [ ] **Step 3: Commit** `test(backend): skippable Socket.IO smoke tests`

---

### Task 7: CI workflow + docs

**Files:** Create `.github/workflows/ci.yml`; Modify `CLAUDE.md`

- [ ] **Step 1:** Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: pip install -r requirements.txt -r requirements-dev.txt
      - run: pytest -q

  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: client
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run build
```

- [ ] **Step 2:** Update `CLAUDE.md` backend section: replace "There is **no separate lint/test setup** for the backend." with the pytest commands (`pip install -r requirements-dev.txt`, then `pytest`), note `CHAT_DB_PATH` overrides the SQLite file (tests use a temp DB), and mention CI runs pytest + the frontend build on push/PR.
- [ ] **Step 3:** Run the full suite: `cd backend; .\.venv\Scripts\python.exe -m pytest -q` → Expected: all PASS (socket may SKIP). Then `cd client; npm run build` → green.
- [ ] **Step 4: Commit** `ci: GitHub Actions (backend pytest + frontend build); docs`

---

## Final verification (after Task 7)

`cd backend && pytest -q` → all green (socket tests pass or skip). `cd client && npm run build` → green. Show the user the pytest summary + the workflow file. Present for approval before push/merge.

## Self-review notes
- **Spec coverage:** DB isolation + scaffolding (T1) ✓ helpers (T2) ✓ auth (T3) ✓ DM (T4) ✓ groups + chats_history kind (T5) ✓ skippable socket (T6) ✓ CI + docs (T7) ✓.
- **Placeholder:** T4 contains an explicit intent-only snippet clearly marked to be deleted; the clean implementation immediately follows. No other placeholders.
- **Consistency:** fixtures `client`, `app`, `make_user`, `clean_db` defined in T1 conftest and used consistently in T2–T6; `make_user` returns `{username, headers}` everywhere; endpoints/JSON shapes match the implemented backend (`kind`, `conversation_id`, `member_count`, `members`).
