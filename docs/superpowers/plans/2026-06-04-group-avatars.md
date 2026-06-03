# Group Avatars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give group conversations an optional photo (monogram is the fallback), reusing the user-avatar machinery, settable later by any member.

**Architecture:** `Conversation` gains `avatar_key`/`avatar_mime`; member-only `POST`/`DELETE`/`GET /api/groups/<cid>/avatar` use the existing `chat/storage.py` seam; a computed cache-busted `avatar_url` rides on `_group_summary` + `chats_history` group rows; the four monogram render sites become photo-or-monogram via `AvatarComponent` + `avatarSrc()`; set affordances reuse `AvatarCropperComponent`.

**Tech Stack:** Flask + SQLite + Werkzeug (backend, `pytest`); Angular 21 / Material dialog (frontend).

---

## Verification model

- **Backend = TDD.** `cd backend; ./.venv/Scripts/python.exe -m pytest -q` (temp DB + temp upload dir).
- **Frontend = production build + manual browser verification** (Karma scaffold broken; prod build is the CI gate per CLAUDE.md). Each frontend task ends with `cd client; npm run build` → exit 0 (budget WARNINGS fine). One browser checkpoint at the end. No Playwright.

## Shared interfaces (define once)

**Backend** (`chat/conversations.py`, pure-string helper, no Flask — avoids a chatfunc↔groups import cycle):
```python
def group_avatar_path(cid: int, avatar_key) -> str | None   # "/api/groups/<cid>/avatar?v=<key[:8]>" or None
```
**Frontend** (`core/chat-api.service.ts`): `uploadGroupAvatar(cid: number, file: File): Observable<any>`, `deleteGroupAvatar(cid: number): Observable<any>`. `ConversationEntry.avatarUrl` (already exists) is populated for groups.

Existing reusables: `chat/storage.py` (`save`/`open_path`/`delete`), `is_member` (`conversations.py`), the manual token-decode pattern (`attachments.serve_attachment` / `profile.serve_avatar`), `AvatarCropperComponent` (in `UiModule`, returns a cropped `File`), `avatarSrc()` (`core/avatar-url.ts`), and `readonly avatarSrc = avatarSrc` already on `ChatComponent`, `MobileChatsComponent`, `MobileThreadComponent`.

---

## Phase 1 — Backend

### Task 1: Schema + `group_avatar_path` + `_group_summary` avatar

**Files:** Modify `backend/chat/database.py`, `backend/chat/conversations.py`, `backend/chat/groups.py`; test `backend/tests/test_group_avatars.py`.

- [ ] **Step 1: Write the failing test.** Create `backend/tests/test_group_avatars.py`:
```python
from chat.database import cursor
from chat.conversations import group_avatar_path


def test_conversation_has_avatar_columns():
    cursor.execute("PRAGMA table_info(Conversation)")
    cols = {r[1] for r in cursor.fetchall()}
    assert {"avatar_key", "avatar_mime"} <= cols


def test_group_avatar_path_or_none():
    assert group_avatar_path(7, None) is None
    assert group_avatar_path(7, "") is None
    assert group_avatar_path(7, "abcdef1234.jpg") == "/api/groups/7/avatar?v=abcdef12"
```

- [ ] **Step 2: Run → fails.** `./.venv/Scripts/python.exe -m pytest tests/test_group_avatars.py -q`.

- [ ] **Step 3: Add columns.** In `backend/chat/database.py`, near the existing avatar-columns migration for `UserProfile`, add:
```python
# Idempotent: avatar columns on Conversation (group photos).
cursor.execute("PRAGMA table_info(Conversation)")
_conv_cols = {row[1] for row in cursor.fetchall()}
for _col in ("avatar_key", "avatar_mime"):
    if _col not in _conv_cols:
        cursor.execute(f"ALTER TABLE Conversation ADD COLUMN {_col} TEXT")
connection.commit()
```

- [ ] **Step 4: Add `group_avatar_path`.** In `backend/chat/conversations.py`, after `reactions_for` (or near the other helpers), add:
```python
def group_avatar_path(cid: int, avatar_key) -> str | None:
    """Cache-busted group-avatar URL path (or None). Caller appends &token=."""
    if not avatar_key:
        return None
    return f"/api/groups/{cid}/avatar?v={avatar_key[:8]}"
```

- [ ] **Step 5: `_group_summary` returns `avatar_url`.** In `backend/chat/groups.py`, add `group_avatar_path` to the `from .conversations import (...)` block. Change `_group_summary` to also select `avatar_key` and include the path:
```python
def _group_summary(cid: int) -> dict:
    cursor.execute("SELECT title, avatar_key FROM Conversation WHERE id=? AND type='group'", (cid,))
    row = cursor.fetchone()
    members = group_members(cid)
    return {
        "kind": "group",
        "conversation_id": cid,
        "title": (row[0] if row else None) or "Group",
        "avatar_url": group_avatar_path(cid, row[1] if row else None),
        "members": members,
        "member_count": len(members),
    }
```

- [ ] **Step 6: Run → passes.** Commit:
```bash
git add backend/chat/database.py backend/chat/conversations.py backend/chat/groups.py backend/tests/test_group_avatars.py
git commit -m "feat(backend): Conversation avatar columns + group_avatar_path + summary avatar"
```

### Task 2: Group avatar endpoints + chats_history propagation

**Files:** Modify `backend/chat/groups.py`, `backend/chat/chatfunc.py`; test `backend/tests/test_group_avatars.py`.

- [ ] **Step 1: Write the failing tests.** Append:
```python
import io as _io


def _grp(client, owner, members=("bob",)):
    return client.post("/api/groups", json={"title": "G", "members": list(members)},
                       headers=owner["headers"]).get_json()["conversation_id"]


def test_group_avatar_upload_serve_delete(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    cid = _grp(client, alice)
    r = client.post(f"/api/groups/{cid}/avatar",
                    data={"file": (_io.BytesIO(b"GIMG"), "g.jpg", "image/jpeg")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 200
    url = r.get_json()["avatar_url"]
    assert url and url.startswith(f"/api/groups/{cid}/avatar?v=")
    btok = bob["headers"]["Authorization"].split()[1]
    ok = client.get(f"/api/groups/{cid}/avatar?token={btok}")
    assert ok.status_code == 200 and ok.data == b"GIMG" and "inline" in ok.headers.get("Content-Disposition", "")
    d = client.delete(f"/api/groups/{cid}/avatar", headers=alice["headers"])
    assert d.status_code == 200 and d.get_json()["avatar_url"] is None


def test_group_avatar_non_member_forbidden_and_validation(client, make_user):
    alice = make_user("alice"); make_user("bob"); carol = make_user("carol")
    cid = _grp(client, alice)
    # non-member cannot upload
    assert client.post(f"/api/groups/{cid}/avatar",
                       data={"file": (_io.BytesIO(b"x"), "g.jpg", "image/jpeg")},
                       content_type="multipart/form-data", headers=carol["headers"]).status_code == 403
    # non-image rejected
    assert client.post(f"/api/groups/{cid}/avatar",
                       data={"file": (_io.BytesIO(b"x"), "g.pdf", "application/pdf")},
                       content_type="multipart/form-data", headers=alice["headers"]).status_code == 400
    # set then non-member serve forbidden
    client.post(f"/api/groups/{cid}/avatar",
                data={"file": (_io.BytesIO(b"x"), "g.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=alice["headers"])
    ctok = carol["headers"]["Authorization"].split()[1]
    assert client.get(f"/api/groups/{cid}/avatar?token={ctok}").status_code == 403


def test_group_avatar_in_chats_history(client, make_user):
    alice = make_user("alice"); make_user("bob")
    cid = _grp(client, alice)
    client.post(f"/api/groups/{cid}/avatar",
                data={"file": (_io.BytesIO(b"x"), "g.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=alice["headers"])
    hist = client.get("/api/chats_history", headers=alice["headers"]).get_json()
    grow = next(e for e in hist if e.get("conversation_id") == cid)
    assert grow["avatar_url"] and grow["avatar_url"].startswith(f"/api/groups/{cid}/avatar?v=")
```

- [ ] **Step 2: Run → fails** (routes missing / no avatar in history).

- [ ] **Step 3: Endpoints.** In `backend/chat/groups.py`: extend imports — add `send_file` to the flask import, `from flask_jwt_extended import decode_token` (extend the existing jwt import), and `from . import storage`. Add the routes (after the existing group routes):
```python
@app.route("/api/groups/<int:cid>/avatar", methods=["POST"])
@jwt_required()
def upload_group_avatar(cid):
    _, err = _require_member(cid)
    if err:
        return err
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    mime = f.mimetype or ""
    if not mime.startswith("image/"):
        return jsonify({"error": "image required"}), 400
    cursor.execute("SELECT avatar_key FROM Conversation WHERE id=? AND type='group'", (cid,))
    row = cursor.fetchone()
    old_key = row[0] if row else None
    key, _size = storage.save(f)
    cursor.execute("UPDATE Conversation SET avatar_key=?, avatar_mime=? WHERE id=?", (key, mime, cid))
    connection.commit()
    if old_key:
        storage.delete(old_key)
    return jsonify(_group_summary(cid))


@app.route("/api/groups/<int:cid>/avatar", methods=["DELETE"])
@jwt_required()
def delete_group_avatar(cid):
    _, err = _require_member(cid)
    if err:
        return err
    cursor.execute("SELECT avatar_key FROM Conversation WHERE id=? AND type='group'", (cid,))
    row = cursor.fetchone()
    old_key = row[0] if row else None
    cursor.execute("UPDATE Conversation SET avatar_key=NULL, avatar_mime=NULL WHERE id=?", (cid,))
    connection.commit()
    if old_key:
        storage.delete(old_key)
    return jsonify(_group_summary(cid))


@app.route("/api/groups/<int:cid>/avatar", methods=["GET"])
def serve_group_avatar(cid):
    token = request.args.get("token", "")
    try:
        sub = decode_token(token).get("sub")
    except Exception:
        sub = None
    uid = _uid(sub) if sub else None
    if uid is None:
        return jsonify({"error": "auth required"}), 401
    if not is_member(cid, uid):
        return jsonify({"error": "forbidden"}), 403
    cursor.execute("SELECT avatar_key, avatar_mime FROM Conversation WHERE id=? AND type='group'", (cid,))
    row = cursor.fetchone()
    if not row or not row[0]:
        return jsonify({"error": "not found"}), 404
    resp = send_file(storage.open_path(row[0]), mimetype=row[1] or "image/jpeg", as_attachment=False)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp
```
(`_require_member`, `_uid`, `is_member`, `_group_summary` already exist in `groups.py`. Confirm `is_member` is imported there — it is, via the `from .conversations import (...)` block.)

- [ ] **Step 4: chats_history group rows.** In `backend/chat/chatfunc.py`, add `group_avatar_path` to the `from .conversations import (...)` block. **Read `get_chats_history` first.** In its **group** query, add `c.avatar_key` to the SELECT, and add `"avatar_url": group_avatar_path(int(r[0]), <avatar_key col>)` to each `groups` dict (use the right tuple index for the new column).

- [ ] **Step 5: Run → passes.** Full suite `./.venv/Scripts/python.exe -m pytest -q` → green. Commit:
```bash
git add backend/chat/groups.py backend/chat/chatfunc.py backend/tests/test_group_avatars.py
git commit -m "feat(backend): group avatar upload/delete/serve (member-only) + chats_history"
```

---

## Phase 2 — Frontend

### Task 3: Model mapping + ChatApi

**Files:** Modify `client/src/app/core/models/conversation.model.ts`, `client/src/app/core/chat-api.service.ts`.

- [ ] **Step 1: Map group avatar.** In `conversation.model.ts`, in `toEntry`, the **group** branch (`raw.kind === 'group'`) adds `avatarUrl: raw.avatar_url ?? null,` to the returned object. (`ConversationEntry.avatarUrl` and `RawConversation.avatar_url` already exist.)

- [ ] **Step 2: ChatApi methods.** In `chat-api.service.ts` add:
```typescript
  uploadGroupAvatar(cid: number, file: File): Observable<any> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<any>(`/api/groups/${cid}/avatar`, form, { headers: this.headers() });
  }
  deleteGroupAvatar(cid: number): Observable<any> {
    return this.http.delete<any>(`/api/groups/${cid}/avatar`, { headers: this.headers() });
  }
```

- [ ] **Step 3: Build** → exit 0. Commit:
```bash
git add client/src/app/core
git commit -m "feat(client): map group avatarUrl + ChatApi group avatar upload/delete"
```

### Task 4: Render photo-or-monogram at the four sites

**Files:** Modify `client/src/app/chat/chat.component.html`, `client/src/app/mobile/chats/mobile-chats.component.html`, `client/src/app/mobile/thread/mobile-thread.component.html`.

All three components already expose `readonly avatarSrc = avatarSrc` and a `monogram(...)` helper.

- [ ] **Step 1: Desktop sidebar group row.** In `chat.component.html`, find the group monogram span `<span class="group-mono">{{ monogram(entry.displayName) }}</span>` and replace it with:
```html
              @if (entry.avatarUrl) {
                <app-avatar [name]="entry.displayName" [seed]="entry.key" [imageUrl]="avatarSrc(entry.avatarUrl)" [size]="34"></app-avatar>
              } @else {
                <span class="group-mono">{{ monogram(entry.displayName) }}</span>
              }
```

- [ ] **Step 2: Desktop conversation header.** Replace `<span class="chat-header__mono">{{ monogram(headerTitle) }}</span>` with:
```html
            @if (selectedEntry?.avatarUrl) {
              <app-avatar class="chat-header__avatar" [name]="headerTitle" [seed]="selectedEntry?.key || ''" [imageUrl]="avatarSrc(selectedEntry?.avatarUrl)" [size]="34"></app-avatar>
            } @else {
              <span class="chat-header__mono">{{ monogram(headerTitle) }}</span>
            }
```

- [ ] **Step 3: Mobile chats group row.** In `mobile-chats.component.html`, replace `<span class="m-row__mono">{{ monogram(entry.displayName) }}</span>` with:
```html
          @if (entry.avatarUrl) {
            <app-avatar [name]="entry.displayName" [seed]="entry.key" [imageUrl]="avatarSrc(entry.avatarUrl)" [size]="46"></app-avatar>
          } @else {
            <span class="m-row__mono">{{ monogram(entry.displayName) }}</span>
          }
```

- [ ] **Step 4: Mobile thread header.** In `mobile-thread.component.html`, replace `<span class="mt-mono">{{ monogram(title) }}</span>` with:
```html
      @if (entry.avatarUrl) {
        <app-avatar [name]="title" [seed]="entry.key" [imageUrl]="avatarSrc(entry.avatarUrl)" [size]="34"></app-avatar>
      } @else {
        <span class="mt-mono">{{ monogram(title) }}</span>
      }
```

- [ ] **Step 5: Build** → exit 0. Commit:
```bash
git add client/src/app/chat/chat.component.html client/src/app/mobile/chats/mobile-chats.component.html client/src/app/mobile/thread/mobile-thread.component.html
git commit -m "feat(client): render group photo (monogram fallback) at all four sites"
```

### Task 5: Set affordances — desktop member panel + mobile header tap

**Files:** Modify `client/src/app/chat/chat.component.{ts,html}`, `client/src/app/mobile/thread/mobile-thread.component.{ts,html,scss}`.

- [ ] **Step 1: Desktop component logic.** In `chat.component.ts`, import `AvatarCropperComponent` (`../ui/avatar-cropper/avatar-cropper.component`). It already has `MatDialog` (`dialog`), `ChatApi` (`api` — verify the field name; the New-Chat/group-create dialog uses `this.dialog`, and `ChatApi` may be injected as `api` or accessed via `store`/`chatApi` — read the constructor and use the real names; if `ChatApi` isn't injected, add it). Add:
```typescript
  onPickGroupAvatar(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    const entry = this.store.selectedEntry();
    if (!file || !entry || entry.kind !== 'group' || !entry.conversationId) return;
    this.dialog.open(AvatarCropperComponent, { data: { file }, panelClass: 'rojin-dialog', autoFocus: false })
      .afterClosed().subscribe((cropped?: File) => {
        if (cropped) this.api.uploadGroupAvatar(entry.conversationId!, cropped)
          .subscribe({ next: (g) => { entry.avatarUrl = g.avatar_url ?? null; } });
      });
  }
  removeGroupAvatar(): void {
    const entry = this.store.selectedEntry();
    if (!entry || entry.kind !== 'group' || !entry.conversationId) return;
    this.api.deleteGroupAvatar(entry.conversationId).subscribe({ next: (g) => { entry.avatarUrl = g.avatar_url ?? null; } });
  }
```

- [ ] **Step 2: Desktop member-panel control.** In `chat.component.html`, in the `member-panel__head` (next to "Members" / "Leave group"), add a camera button + hidden input + a conditional remove:
```html
              <button type="button" class="member-panel__photo" (click)="groupPhotoInput.click()">Change photo</button>
              <input #groupPhotoInput type="file" accept="image/*" hidden (change)="onPickGroupAvatar($event)">
              @if (selectedEntry?.avatarUrl) {
                <button type="button" class="member-panel__photo" (click)="removeGroupAvatar()">Remove photo</button>
              }
```
(Style `.member-panel__photo` as a small subdued text/link button matching the existing `.member-panel__leave`.)

- [ ] **Step 3: Mobile thread logic + tap-to-set.** In `mobile-thread.component.ts`, inject `MatDialog` (`@angular/material/dialog`) and `ChatApi` (`../../core/chat-api.service`); import `AvatarCropperComponent`. Add:
```typescript
  @ViewChild('groupPhotoInput') groupPhotoInput?: ElementRef<HTMLInputElement>;
  pickGroupPhoto(): void {
    if (this.isGroup) this.groupPhotoInput?.nativeElement.click();
  }
  onPickGroupAvatar(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    const entry = this.entry;
    if (!file || entry.kind !== 'group' || !entry.conversationId) return;
    this.dialog.open(AvatarCropperComponent, { data: { file }, panelClass: 'rojin-dialog', autoFocus: false })
      .afterClosed().subscribe((cropped?: File) => {
        if (cropped) this.api.uploadGroupAvatar(entry.conversationId!, cropped)
          .subscribe({ next: (g) => { entry.avatarUrl = g.avatar_url ?? null; } });
      });
  }
```
(Import `ViewChild`, `ElementRef` from `@angular/core` if not already.)

- [ ] **Step 4: Mobile thread template.** Wrap the group header avatar so tapping it (groups only) opens the picker, and add the hidden input. Update the Task-4 header block to:
```html
      @if (isGroup) {
        <button type="button" class="mt-avatar-btn" (click)="pickGroupPhoto()" aria-label="Change group photo">
          @if (entry.avatarUrl) {
            <app-avatar [name]="title" [seed]="entry.key" [imageUrl]="avatarSrc(entry.avatarUrl)" [size]="34"></app-avatar>
          } @else {
            <span class="mt-mono">{{ monogram(title) }}</span>
          }
        </button>
        <input #groupPhotoInput type="file" accept="image/*" hidden (change)="onPickGroupAvatar($event)">
      } @else {
        <app-avatar [name]="title" [seed]="peerUsername" [imageUrl]="avatarSrc(entry.avatarUrl)" [size]="34"></app-avatar>
      }
```
Add `.mt-avatar-btn { border:none; background:none; padding:0; cursor:pointer; }` to `mobile-thread.component.scss`. (Removing a mobile group photo is out of scope for this minimal affordance — desktop covers removal; note it.)

- [ ] **Step 5: Build** → exit 0.

- [ ] **Step 6: Browser checkpoint (desktop + mobile).** Start both processes. With two users in a group: desktop → open the group → **Members → Change photo** → crop → Save; confirm the photo shows in the sidebar + header, and for the other member after refresh; **Remove photo** → back to monogram. Mobile → open the group → **tap the header avatar** → crop → Save → shows in the mobile chats list + thread header. DMs unaffected. **Wait for approval.**

- [ ] **Step 7: Commit (after approval).**
```bash
git add client/src/app/chat client/src/app/mobile/thread
git commit -m "feat(client): set group photo — desktop member panel + mobile header tap"
```

---

## Phase 3 — Docs + final

### Task 6: Docs
**Files:** Modify `docs/system-design.md`, `CLAUDE.md`, `docs/evolution.md`.
- [ ] **Step 1:** `docs/system-design.md` — add `POST`/`DELETE`/`GET /api/groups/<id>/avatar?token=` (member-only) to the HTTP table; note `Conversation.avatar_key`/`avatar_mime` and the group `avatar_url` on summary + history.
- [ ] **Step 2:** `CLAUDE.md` — a one-line addition to the Avatars note: group photos reuse the same machinery but the serve route is **members-only** (`is_member`), keyed on `Conversation.avatar_key`.
- [ ] **Step 3:** `docs/evolution.md` — mark group avatars delivered (monogram fallback; settable by any member; desktop panel + mobile header tap).
- [ ] **Step 4: Commit** `docs: group avatars`.

### Task 7: Final review
- [ ] **Step 1:** `cd backend; ./.venv/Scripts/python.exe -m pytest -q` → all green.
- [ ] **Step 2:** `cd client; npm run build` → exit 0.
- [ ] **Step 3:** Final code review over the branch, then `superpowers:finishing-a-development-branch`.

---

## Self-review (plan vs spec)

- **Conversation `avatar_key`/`avatar_mime` + `group_avatar_path` + summary avatar** → Task 1. ✓
- **Member-only POST/DELETE/GET serve (403 non-member, 400 non-image, 404 none, 401 bad token)** → Task 2. ✓
- **`chats_history` group rows carry `avatar_url`** → Task 2 Step 4. ✓
- **`toEntry` group branch + ChatApi upload/delete** → Task 3. ✓
- **Photo-or-monogram at all four sites** → Task 4 (sidebar, header, mobile chats, mobile thread). ✓
- **Set: desktop member panel + mobile header tap; remove on desktop** → Task 5. ✓
- **Tests** → Tasks 1–2. **Docs** → Task 6. ✓
- **Type consistency:** `group_avatar_path`, `uploadGroupAvatar`/`deleteGroupAvatar`, `entry.avatarUrl`, the `avatar_url` payload key — named once, reused. ✓
- **Import-cycle watch:** `group_avatar_path` lives in `conversations.py` (no Flask), imported by both `groups.py` and `chatfunc.py` — no cycle. ✓
- **Field-name caveat flagged:** Task 5 tells the implementer to read `chat.component.ts` for the real `ChatApi` field name (and inject it if missing) rather than assume `this.api`. ✓
