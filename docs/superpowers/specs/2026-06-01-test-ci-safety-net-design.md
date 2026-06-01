# Test + CI Safety Net — Design

**Status:** Approved (decisions captured 2026-06-01)
**Phase:** Engineering health (parallel to the feature arc; precedes read receipts)
**Branch target:** new branch off `main`

---

## Goal

Establish a lean, high-value automated safety net so regressions — especially in the recently-refactored Socket.IO room / group logic — get caught automatically. Backend pytest on critical paths against an isolated test database, plus GitHub Actions CI gating the backend tests and the frontend production build.

## Decisions (from brainstorming)

- **Lean scope:** backend pytest on refactor-risk paths + CI; **no new frontend unit tests** this pass (CI gates `npm run build`, which type-checks every component/template).
- **Test DB isolation:** add a `CHAT_DB_PATH` env var to `database.py` (default `"chat.db"`); tests point it at a throwaway temp file. Production unaffected.
- **Socket.IO tests:** included as a small smoke test but **skippable** (guarded), so an unsupported CI async environment can't make the suite flaky.

## Non-goals / YAGNI

- No frontend unit-test rehabilitation (the broken `app`/`chat`/`signin`/`signup` scaffold specs stay as-is; `ng test` is not wired into CI).
- No coverage thresholds/gates, no mutation testing.
- No app-factory refactor — keep the single shared-connection design; only parameterize the DB path.
- No deployment/release automation — CI is build + test only.

---

## 1. Backend test database isolation

`backend/chat/database.py` currently opens `sqlite3.connect("chat.db", check_same_thread=False)` at import. Change line 5 to:
```python
import os
_DB_PATH = os.environ.get("CHAT_DB_PATH", "chat.db")
connection = sqlite3.connect(_DB_PATH, check_same_thread=False)
```
Nothing else in the module changes. Production/dev (no env var) behave exactly as today.

Tests set `CHAT_DB_PATH` to a per-session temp file **before importing the app**, in `conftest.py`, alongside test secrets so the fail-fast guard in `chat/__init__.py` is satisfied:
```python
# conftest.py — runs before any `from chat import ...`
import os, tempfile
os.environ["CHAT_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ["SECRET_KEY"] = "test-secret"
os.environ["JWT_SECRET_KEY"] = "test-jwt-secret"
os.environ["FLASK_DEBUG"] = "true"
```

## 2. Backend pytest structure

- **Dev deps:** new `backend/requirements-dev.txt` containing `pytest`. (Runtime `requirements.txt` stays clean.)
- **Config:** `backend/pytest.ini` with `testpaths = tests` and `filterwarnings` as needed.
- **`backend/tests/conftest.py`** provides:
  - The env setup above (module top, before importing `chat`).
  - `app` / `client` — Flask test client (`chat.app.test_client()`).
  - `clean_db` — autouse fixture that wipes `Message`, `ConversationMember`, `Conversation`, `UserProfile`, `User` between tests (DELETE, committed) so tests are independent.
  - `make_user(client, username, password)` helper — POST `/api/signup` then `/api/signin`, returns `{username, headers}` with the `Authorization: Bearer` header.

### Coverage (critical, refactor-risk paths)

**`tests/test_auth.py`**
- signup creates a `User` row and a backing `UserProfile`; returns 201.
- duplicate username → 409.
- signin with correct creds → 200 + `access_token`; wrong password → 401.
- a `@jwt_required` route (e.g. `/api/chats_history`) without a token → 401/422.

**`tests/test_dm.py`**
- POST `/api/dm/messages` persists; the message appears in GET `/api/dm/messages/<peer>` for both participants.
- messaging yourself → 400; unknown recipient → 400.
- a third user does **not** see the pair's messages (scoping).

**`tests/test_groups.py`**
- POST `/api/groups` creates a group with creator + listed members; creator is a member; `member_count` correct.
- non-member gets 403 on GET/`messages`/`PATCH`/`members` for that group.
- add member → appears in members; remove member → gone; leave → caller removed.
- POST `/api/groups/<id>/messages` persists and is returned by GET for members.
- `/api/chats_history` returns the user's DMs **and** groups, each tagged `kind` (`direct`/`group`) with the group's `conversation_id`, `title`, `member_count`.

**`tests/test_helpers.py`** (direct unit tests of `conversations.py`)
- `create_group_conversation` inserts the Conversation + ConversationMember rows.
- `conversation_room(7) == "conv:7"`.
- `is_member` true/false; `user_conversation_ids` returns the right ids; `group_members` shape; `get_or_create_direct_conversation` idempotent (same pair → same id, normalized order).

**`tests/test_socket.py`** (skippable smoke — guarded with `pytest.importorskip`/try-skip)
- `socketio.test_client(app)` with no token → not connected (rejected).
- with a valid token → connected; emitting `send_message` for a group the user belongs to results in a `receive_message` to other members' test clients. If the async mode / environment can't support the test client, the module skips cleanly.

## 3. CI — GitHub Actions

`.github/workflows/ci.yml`, triggered on `push` and `pull_request`:

- **`backend` job** (ubuntu, Python 3.12): checkout → setup-python → `pip install -r backend/requirements.txt -r backend/requirements-dev.txt` → `cd backend && pytest -q`. (conftest sets all needed env; no real secrets required.)
- **`frontend` job** (ubuntu, Node 20): checkout → setup-node → `cd client && npm ci && npm run build`.

Both jobs run in parallel; both must pass for a green check.

## 4. Docs

Update `CLAUDE.md`:
- Replace "There is **no separate lint/test setup** for the backend" with the pytest commands (`pip install -r requirements-dev.txt`, `pytest`) and the `CHAT_DB_PATH` knob.
- Note the new CI workflow and that `npm run build` is the frontend gate.

## Files touched

- Modify: `backend/chat/database.py` (CHAT_DB_PATH env var)
- Create: `backend/requirements-dev.txt`, `backend/pytest.ini`
- Create: `backend/tests/__init__.py`, `conftest.py`, `test_auth.py`, `test_dm.py`, `test_groups.py`, `test_helpers.py`, `test_socket.py`
- Create: `.github/workflows/ci.yml`
- Modify: `CLAUDE.md`

## Error handling / edge cases

- conftest must set `CHAT_DB_PATH` + secrets **before** the first `import chat` (module-level, top of conftest).
- `clean_db` runs per test to guarantee isolation despite the single shared connection.
- Socket tests degrade to `skip` rather than fail when the environment can't host the test client.

## Risks / watch-items

- **Import-order dependency:** if any test imports `chat` before conftest sets env, it would use `chat.db`. Mitigation: all env setup at the very top of `conftest.py`, which pytest imports first; tests import `chat` only inside fixtures/functions.
- **eventlet in CI:** Flask-SocketIO's test client may pick an async mode that differs from runtime; the socket suite is therefore skippable and non-blocking. REST + helper tests carry the safety-net value regardless.
- **Single shared connection under pytest:** tests run sequentially by default — safe. Don't add `pytest-xdist` parallelism without rethinking DB isolation.
