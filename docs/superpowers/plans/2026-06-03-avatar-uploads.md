# Avatar Uploads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users upload a cropped profile photo that appears wherever `<app-avatar>` renders a person (sidebar, header, thread sender headers, directory, member panel, profiles) on desktop + mobile.

**Architecture:** A custom EXIF-aware crop/zoom dialog exports a 512×512 JPEG client-side; it uploads via the existing `chat/storage.py` seam; the bytes are served org-public at `GET /api/avatars/<username>?token=<jwt>`. `UserProfile.avatar_key` holds the storage key; a computed, cache-busted `avatar_url` path is propagated through every person-data feed; `AvatarComponent` (already supports `imageUrl`) renders it via an `avatarSrc()` helper that appends the viewer's token.

**Tech Stack:** Flask + SQLite + Werkzeug (backend, `pytest`); Angular 21 / Material dialog / `<canvas>` + `createImageBitmap` (frontend).

---

## Verification model (read first)

- **Backend = TDD.** `cd backend; ./.venv/Scripts/python.exe -m pytest -q` (temp DB + temp upload dir; conftest already sets `CHAT_UPLOAD_DIR`).
- **Frontend = production build + manual browser verification** (Karma scaffold is broken; the prod build is the CI gate per CLAUDE.md). Each frontend task ends with `cd client; npm run build` → exit 0 (budget WARNINGS fine; only non-zero exit / `Error:` lines fail). One browser checkpoint at the end. No Playwright.

## Shared interfaces (define once — keep consistent)

**Backend** (`chat/profile.py`):
```python
def _avatar_path(username: str, avatar_key) -> str | None   # "/api/avatars/<username>?v=<key[:8]>" or None
```
**Frontend:**
- `client/src/app/core/avatar-url.ts`: `export function avatarSrc(path: string | null | undefined): string | null`
- `ChatApi`: `uploadAvatar(file: File): Observable<any>`, `deleteAvatar(): Observable<any>` (both return the updated profile).
- Models: `ConversationEntry.avatarUrl?: string | null`; `DirectoryUser.avatar_url?: string | null`; `Message.senderAvatarUrl?: string | null`.

`avatarSrc` (used everywhere):
```typescript
export function avatarSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${path}&token=${localStorage.getItem('access_token')}`;   // path already carries ?v=
}
```

---

## File structure

| File | Responsibility |
|------|----------------|
| `backend/chat/database.py` | *modify* — `avatar_key` + `avatar_mime` columns on `UserProfile` |
| `backend/chat/profile.py` | *modify* — `_avatar_path`, `POST`/`DELETE /api/me/avatar`, `GET /api/avatars/<username>`, computed `avatar_url` |
| `backend/chat/chatfunc.py` | *modify* — `get_chats_history` + `directory_users` include `avatar_url` |
| `backend/chat/conversations.py` | *modify* — `group_members` + `serialize_messages` include avatar |
| `backend/tests/test_avatars.py` | *create* |
| `client/src/app/core/avatar-url.ts` | *create* — `avatarSrc` |
| `client/src/app/core/chat-api.service.ts` | *modify* — `uploadAvatar`/`deleteAvatar` |
| `client/src/app/core/models/conversation.model.ts`, `message.model.ts` | *modify* — avatar fields + mapping |
| `client/src/app/ui/avatar-cropper/*` | *create* — crop/zoom dialog |
| `client/src/app/ui/ui.module.ts` | *modify* — declare/export cropper |
| `client/src/app/profile/profile.component.*`, `client/src/app/mobile/profile/mobile-profile.component.*` | *modify* — change/remove flow |
| render sites (`chat.component.html`, `message-thread.component.html`, `mobile/chats`, `mobile/people`, `mobile/thread`) | *modify* — `[imageUrl]` |

---

## Phase 1 — Backend

### Task 1: Schema + `_avatar_path`

**Files:** Modify `backend/chat/database.py`, `backend/chat/profile.py`; test `backend/tests/test_avatars.py`.

- [ ] **Step 1: Write the failing test.** Create `backend/tests/test_avatars.py`:
```python
from chat.database import cursor
from chat.profile import _avatar_path


def test_userprofile_has_avatar_columns():
    cursor.execute("PRAGMA table_info(UserProfile)")
    cols = {r[1] for r in cursor.fetchall()}
    assert {"avatar_key", "avatar_mime"} <= cols


def test_avatar_path_builds_versioned_path_or_none():
    assert _avatar_path("alice", None) is None
    assert _avatar_path("alice", "") is None
    p = _avatar_path("alice", "abcdef1234567890.jpg")
    assert p == "/api/avatars/alice?v=abcdef12"
```

- [ ] **Step 2: Run → fails** (`./.venv/Scripts/python.exe -m pytest tests/test_avatars.py -q`): columns missing / `_avatar_path` import error.

- [ ] **Step 3: Add columns.** In `backend/chat/database.py`, near the existing idempotent `last_read_at` migration block, add:
```python
# Idempotent: avatar columns on UserProfile.
cursor.execute("PRAGMA table_info(UserProfile)")
_profile_cols = {row[1] for row in cursor.fetchall()}
for _col in ("avatar_key", "avatar_mime"):
    if _col not in _profile_cols:
        cursor.execute(f"ALTER TABLE UserProfile ADD COLUMN {_col} TEXT")
connection.commit()
```

- [ ] **Step 4: Add `_avatar_path`.** In `backend/chat/profile.py`, after `_utc_now_iso`, add:
```python
def _avatar_path(username: str, avatar_key) -> str | None:
    """Public, cache-busted avatar URL path (or None). Caller appends &token=."""
    if not avatar_key:
        return None
    return f"/api/avatars/{username}?v={avatar_key[:8]}"
```

- [ ] **Step 5: Run → passes.** Commit:
```bash
git add backend/chat/database.py backend/chat/profile.py backend/tests/test_avatars.py
git commit -m "feat(backend): UserProfile avatar_key/avatar_mime columns + _avatar_path"
```

### Task 2: Upload, delete, serve endpoints

**Files:** Modify `backend/chat/profile.py`; test `backend/tests/test_avatars.py`.

- [ ] **Step 1: Write the failing tests.** Append:
```python
import io as _io


def test_upload_avatar_sets_path_then_delete_clears(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/me/avatar",
                    data={"file": (_io.BytesIO(b"JPEGDATA"), "a.jpg", "image/jpeg")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 200
    url = r.get_json()["avatar_url"]
    assert url and url.startswith("/api/avatars/alice?v=")
    prof = client.get("/api/me/profile", headers=alice["headers"]).get_json()
    assert prof["avatar_url"] == url
    d = client.delete("/api/me/avatar", headers=alice["headers"])
    assert d.status_code == 200 and d.get_json()["avatar_url"] is None


def test_upload_avatar_rejects_non_image(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/me/avatar",
                    data={"file": (_io.BytesIO(b"%PDF"), "a.pdf", "application/pdf")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 400


def test_serve_avatar_token_gated(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    client.post("/api/me/avatar",
                data={"file": (_io.BytesIO(b"IMG"), "a.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=alice["headers"])
    btok = bob["headers"]["Authorization"].split()[1]
    ok = client.get(f"/api/avatars/alice?token={btok}")          # org-public: bob can view alice
    assert ok.status_code == 200 and ok.data == b"IMG"
    assert "inline" in ok.headers.get("Content-Disposition", "")
    assert client.get("/api/avatars/alice").status_code == 401   # no token
    assert client.get(f"/api/avatars/bob?token={btok}").status_code == 404  # bob has no avatar
```

- [ ] **Step 2: Run → fails** (routes missing).

- [ ] **Step 3: Implement.** In `backend/chat/profile.py` add imports at the top: `from flask import send_file` (extend the existing flask import), `from flask_jwt_extended import decode_token` (extend), and `from . import storage`. Then add the three routes (place after `patch_my_profile`):
```python
def _avatar_key_for(user_id):
    cursor.execute("SELECT avatar_key, avatar_mime FROM UserProfile WHERE user_id=?", (user_id,))
    row = cursor.fetchone()
    return (row[0], row[1]) if row else (None, None)


@app.route("/api/me/avatar", methods=["POST"])
@jwt_required()
def upload_my_avatar():
    me = get_jwt_identity()
    cursor.execute("SELECT id, username FROM User WHERE username=?", (me,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    mime = f.mimetype or ""
    if not mime.startswith("image/"):
        return jsonify({"error": "image required"}), 400
    _ensure_profile_row(user_id, username)
    old_key, _old_mime = _avatar_key_for(user_id)
    key, _size = storage.save(f)
    cursor.execute(
        "UPDATE UserProfile SET avatar_key=?, avatar_mime=?, updated_at=? WHERE user_id=?",
        (key, mime, _utc_now_iso(), user_id),
    )
    connection.commit()
    if old_key:
        storage.delete(old_key)
    cursor.execute("SELECT display_name, avatar_url, bio, updated_at, avatar_key FROM UserProfile WHERE user_id=?", (user_id,))
    return jsonify(_row_to_public(username, cursor.fetchone()))


@app.route("/api/me/avatar", methods=["DELETE"])
@jwt_required()
def delete_my_avatar():
    me = get_jwt_identity()
    cursor.execute("SELECT id, username FROM User WHERE username=?", (me,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    old_key, _ = _avatar_key_for(user_id)
    cursor.execute("UPDATE UserProfile SET avatar_key=NULL, avatar_mime=NULL, updated_at=? WHERE user_id=?",
                   (_utc_now_iso(), user_id))
    connection.commit()
    if old_key:
        storage.delete(old_key)
    cursor.execute("SELECT display_name, avatar_url, bio, updated_at, avatar_key FROM UserProfile WHERE user_id=?", (user_id,))
    return jsonify(_row_to_public(username, cursor.fetchone()))


@app.route("/api/avatars/<username>", methods=["GET"])
def serve_avatar(username):
    token = request.args.get("token", "")
    try:
        ok = bool(decode_token(token).get("sub"))
    except Exception:
        ok = False
    if not ok:
        return jsonify({"error": "auth required"}), 401
    cursor.execute(
        "SELECT p.avatar_key, p.avatar_mime FROM User u "
        "JOIN UserProfile p ON p.user_id = u.id WHERE u.username=?",
        (username,),
    )
    row = cursor.fetchone()
    if not row or not row[0]:
        return jsonify({"error": "not found"}), 404
    resp = send_file(storage.open_path(row[0]), mimetype=row[1] or "image/jpeg", as_attachment=False)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp
```

- [ ] **Step 4: Make `_row_to_public` compute `avatar_url` from `avatar_key`.** It currently takes a 4-tuple `(display_name, avatar_url, bio, updated_at)`. Change it to take the username + a row whose **5th element is `avatar_key`** and compute the path. Replace the function body:
```python
def _row_to_public(username, prof_row):
    if not prof_row:
        return {"username": username, "display_name": username,
                "avatar_url": None, "bio": None, "updated_at": None}
    dn, _legacy_url, bio, up, avatar_key = prof_row
    return {
        "username": username,
        "display_name": (dn or "").strip() or username,
        "avatar_url": _avatar_path(username, avatar_key),
        "bio": bio,
        "updated_at": up,
    }
```
Then update the three existing profile reads (`get_my_profile`, `patch_my_profile` final select, `get_user_public_profile`) to `SELECT display_name, avatar_url, bio, updated_at, avatar_key FROM UserProfile WHERE user_id=?` (add `avatar_key` as the 5th column) so the tuple matches.

- [ ] **Step 5: Run → passes.** Then full suite `./.venv/Scripts/python.exe -m pytest -q` → green (existing profile tests still pass with the new shape). Commit:
```bash
git add backend/chat/profile.py backend/tests/test_avatars.py
git commit -m "feat(backend): avatar upload/delete + org-public serve; computed avatar_url"
```

### Task 3: Propagate `avatar_url` through person feeds

**Files:** Modify `backend/chat/chatfunc.py`, `backend/chat/conversations.py`; test `backend/tests/test_avatars.py`.

- [ ] **Step 1: Write the failing tests.** Append:
```python
def _set_avatar(client, user):
    client.post("/api/me/avatar",
                data={"file": (_io.BytesIO(b"IMG"), "a.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=user["headers"])


def test_directory_and_history_include_avatar(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    _set_avatar(client, bob)
    diru = client.get("/api/directory_users", headers=alice["headers"]).get_json()
    assert any(u["username"] == "bob" and u["avatar_url"] for u in diru)
    client.post("/api/dm/messages", json={"to_username": "bob", "body": "hi"}, headers=alice["headers"])
    hist = client.get("/api/chats_history", headers=alice["headers"]).get_json()
    bob_row = next(e for e in hist if e.get("username") == "bob")
    assert bob_row["avatar_url"]


def test_group_members_and_sender_avatar(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    _set_avatar(client, alice)
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    g = client.get(f"/api/groups/{cid}", headers=alice["headers"]).get_json()
    assert any(m["username"] == "alice" and m["avatar_url"] for m in g["members"])
    client.post(f"/api/groups/{cid}/messages", json={"body": "yo", "client_message_id": "gm"},
                headers=alice["headers"])
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    assert next(m for m in msgs if m["id"] == "gm")["sender_avatar_url"]
```

- [ ] **Step 2: Run → fails** (`KeyError`/`None`).

- [ ] **Step 3: `directory_users` + `chats_history`** (`backend/chat/chatfunc.py`). Add `from .profile import _avatar_path` near the top imports. Read each query first, then:
  - In `directory_users`, the query already `LEFT JOIN UserProfile p`. Add `p.avatar_key` to the SELECT and include `"avatar_url": _avatar_path(row_username, row_avatar_key)` in each returned dict.
  - In `get_chats_history`, the direct-peers query already `LEFT JOIN UserProfile p ON p.user_id = u.id`. Add `p.avatar_key` to its SELECT and add `"avatar_url": _avatar_path(<peer username col>, <avatar_key col>)` to each `peers` dict. (Groups + the self entry don't need it; leave them — but you MAY add `"avatar_url": None` to the group/self dicts for shape uniformity. Not required.)

- [ ] **Step 4: `group_members` + `serialize_messages`** (`backend/chat/conversations.py`). Add `from .profile import _avatar_path` — **watch for circular import**: `profile.py` imports from `chat` (app) and `database`, not from `conversations`, so `conversations` importing `_avatar_path` from `profile` is safe **only if** `profile` is importable at call time. To be safe, do the import **inside** the functions (local import) rather than at module top. Then:
  - `group_members`: the query already `LEFT JOIN UserProfile p`. Add `p.avatar_key`; include `"avatar_url": _avatar_path(username, avatar_key)` in each member dict.
  - `serialize_messages`: the main query joins `User u ON u.id = m.sender_user_id`. Add `LEFT JOIN UserProfile p ON p.user_id = m.sender_user_id` and select `p.avatar_key`; add `"sender_avatar_url": _avatar_path(username, avatar_key)` to each message dict.

- [ ] **Step 5: Run the avatar + dm + group + profile tests:**
```
./.venv/Scripts/python.exe -m pytest tests/test_avatars.py tests/test_dm.py tests/test_groups.py -q
```
then full suite `./.venv/Scripts/python.exe -m pytest -q` → all green.

- [ ] **Step 6: Commit.**
```bash
git add backend/chat/chatfunc.py backend/chat/conversations.py backend/tests/test_avatars.py
git commit -m "feat(backend): propagate avatar_url through directory, history, members, messages"
```

---

## Phase 2 — Frontend

### Task 4: avatarSrc helper + ChatApi + models

**Files:** Create `client/src/app/core/avatar-url.ts`; modify `client/src/app/core/chat-api.service.ts`, `core/models/conversation.model.ts`, `core/models/message.model.ts`, and the `toEntry`/`toMessage` mappers.

- [ ] **Step 1: Helper.** Create `client/src/app/core/avatar-url.ts`:
```typescript
export function avatarSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${path}&token=${localStorage.getItem('access_token')}`;
}
```

- [ ] **Step 2: ChatApi.** In `chat-api.service.ts` add:
```typescript
  uploadAvatar(file: File): Observable<any> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<any>('/api/me/avatar', form, { headers: this.headers() });
  }
  deleteAvatar(): Observable<any> {
    return this.http.delete<any>('/api/me/avatar', { headers: this.headers() });
  }
```

- [ ] **Step 3: Models + mapping.**
  - `conversation.model.ts`: add `avatarUrl?: string | null;` to `ConversationEntry` and `avatar_url?: string | null;` to `RawConversation` and `DirectoryUser`. In `toEntry`, for the direct branch add `avatarUrl: raw.avatar_url ?? null,`.
  - `message.model.ts`: add `senderAvatarUrl?: string | null;` to `Message`.
  - In `ChatStore.toMessage`, add `senderAvatarUrl: raw.sender_avatar_url ?? null,`.

- [ ] **Step 4: Build** → exit 0. Commit:
```bash
git add client/src/app/core
git commit -m "feat(client): avatarSrc helper + ChatApi avatar upload/delete + model fields"
```

### Task 5: Custom crop/zoom dialog

**Files:** Create `client/src/app/ui/avatar-cropper/avatar-cropper.component.{ts,html,scss}`; modify `client/src/app/ui/ui.module.ts`.

- [ ] **Step 1: Component.** Create the cropper. It takes a `File`, shows it in a fixed circular viewport, supports drag + zoom (slider and wheel/pinch), is **EXIF-correct** via `createImageBitmap(file, { imageOrientation: 'from-image' })`, and exports a 512×512 JPEG.
```typescript
import { Component, ElementRef, Inject, ViewChild } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';

@Component({
  selector: 'app-avatar-cropper',
  templateUrl: './avatar-cropper.component.html',
  styleUrls: ['./avatar-cropper.component.scss'],
  standalone: false,
})
export class AvatarCropperComponent {
  @ViewChild('view', { static: true }) view!: ElementRef<HTMLDivElement>;
  private bitmap?: ImageBitmap;
  readonly VIEW = 260;                 // circular viewport px
  baseScale = 1; zoom = 1; tx = 0; ty = 0;     // image transform within the viewport
  private dragging = false; private lastX = 0; private lastY = 0;
  private pinchStart = 0; private pinchZoom0 = 1;

  constructor(private ref: MatDialogRef<AvatarCropperComponent, File>,
              @Inject(MAT_DIALOG_DATA) public data: { file: File }) {
    this.load(data.file);
  }

  private async load(file: File): Promise<void> {
    // imageOrientation:'from-image' applies EXIF so portraits aren't sideways.
    this.bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as any);
    // cover: scale so the smaller dimension fills the circle
    this.baseScale = this.VIEW / Math.min(this.bitmap.width, this.bitmap.height);
    this.zoom = 1; this.tx = 0; this.ty = 0;
  }

  get scale(): number { return this.baseScale * this.zoom; }
  get imgStyle() {
    if (!this.bitmap) return {};
    const w = this.bitmap.width * this.scale, h = this.bitmap.height * this.scale;
    return { width: `${w}px`, height: `${h}px`,
             transform: `translate(${this.tx}px, ${this.ty}px)` };
  }
  get imgSrc(): string { return this.data.file ? URL.createObjectURL(this.data.file) : ''; }

  onPointerDown(e: PointerEvent) { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId); }
  onPointerMove(e: PointerEvent) {
    if (!this.dragging) return;
    this.tx += e.clientX - this.lastX; this.ty += e.clientY - this.lastY;
    this.lastX = e.clientX; this.lastY = e.clientY; this.clamp();
  }
  onPointerUp() { this.dragging = false; }
  onZoomInput(v: number) { this.zoom = v; this.clamp(); }
  onWheel(e: WheelEvent) { e.preventDefault(); this.zoom = Math.min(4, Math.max(1, this.zoom * (e.deltaY < 0 ? 1.08 : 0.92))); this.clamp(); }

  private clamp(): void {
    if (!this.bitmap) return;
    const w = this.bitmap.width * this.scale, h = this.bitmap.height * this.scale;
    const maxX = Math.max(0, (w - this.VIEW) / 2), maxY = Math.max(0, (h - this.VIEW) / 2);
    this.tx = Math.min(maxX, Math.max(-maxX, this.tx));
    this.ty = Math.min(maxY, Math.max(-maxY, this.ty));
  }

  cancel(): void { this.ref.close(undefined); }

  save(): void {
    if (!this.bitmap) return;
    const OUT = 512;
    const canvas = document.createElement('canvas');
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext('2d')!;
    // map the circular viewport region back to source pixels
    const srcSize = this.VIEW / this.scale;                       // source px shown across the viewport
    const cx = this.bitmap.width / 2 - this.tx / this.scale;
    const cy = this.bitmap.height / 2 - this.ty / this.scale;
    ctx.drawImage(this.bitmap, cx - srcSize / 2, cy - srcSize / 2, srcSize, srcSize, 0, 0, OUT, OUT);
    canvas.toBlob((blob) => {
      if (blob) this.ref.close(new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.9);
  }
}
```
Template `avatar-cropper.component.html` (circular masked viewport + the image + a zoom range + actions):
```html
<div class="cropper">
  <h3 class="cropper__title">Adjust photo</h3>
  <div #view class="cropper__view"
       (pointerdown)="onPointerDown($event)" (pointermove)="onPointerMove($event)"
       (pointerup)="onPointerUp()" (pointerleave)="onPointerUp()" (wheel)="onWheel($event)">
    <img class="cropper__img" [src]="imgSrc" [ngStyle]="imgStyle" draggable="false" alt="">
    <div class="cropper__ring"></div>
  </div>
  <input class="cropper__zoom" type="range" min="1" max="4" step="0.01"
         [value]="zoom" (input)="onZoomInput(+$any($event.target).value)">
  <div class="cropper__actions">
    <button type="button" class="cropper__cancel" (click)="cancel()">Cancel</button>
    <button type="button" class="cropper__save" (click)="save()">Save</button>
  </div>
</div>
```
SCSS `avatar-cropper.component.scss` (`@import '../styles/tokens';`): `.cropper` padded charcoal/paper panel; `.cropper__view { width:260px; height:260px; position:relative; overflow:hidden; touch-action:none; margin:0 auto; }`; `.cropper__img { position:absolute; left:50%; top:50%; margin-left:0; transform-origin:center; will-change:transform; }` — **note:** position the image centered: set `left:50%; top:50%` then offset by half its size; simpler: wrap so the image is centered then translated. Use: `.cropper__img { position:absolute; left:50%; top:50%; transform: translate(-50%,-50%); }` and apply the drag translate ON TOP by composing in `imgStyle` (change `imgStyle.transform` to `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`). `.cropper__ring { position:absolute; inset:0; border-radius:50%; box-shadow:0 0 0 999px rgba(20,8,20,.55) inset; pointer-events:none; }` to mask to a circle; `.cropper__zoom` full-width gold range; `.cropper__save` gold, `.cropper__cancel` subdued. Center everything; mobile-friendly width (`max-width:88vw`).

  **(Implementer: apply the `translate(-50%,-50%)` centering note above — update `imgStyle.transform` to `translate(calc(-50% + ${this.tx}px), calc(-50% + ${this.ty}px))` so the math matches a center-anchored image.)**

- [ ] **Step 2: Declare in `UiModule`** (`client/src/app/ui/ui.module.ts`): add `AvatarCropperComponent` to `declarations` and `exports`; ensure `MatDialogModule`, `FormsModule`, `CommonModule` are imported by `UiModule` (add any missing).

- [ ] **Step 3: Build** → exit 0. Commit:
```bash
git add client/src/app/ui/avatar-cropper client/src/app/ui/ui.module.ts
git commit -m "feat(client): custom EXIF-aware avatar crop/zoom dialog"
```

### Task 6: Profile change/remove flow (desktop + mobile)

**Files:** Modify `client/src/app/profile/profile.component.{ts,html,scss}`, `client/src/app/mobile/profile/mobile-profile.component.{ts,html,scss}`.

- [ ] **Step 1: Desktop profile.** In `profile.component.ts` inject `MatDialog` and `ChatApi`; import `AvatarCropperComponent` and `avatarSrc`. Add:
```typescript
  get avatarImage(): string | null { return avatarSrc(this.profile?.avatar_url); }
  onPickAvatar(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    this.dialog.open(AvatarCropperComponent, { data: { file }, panelClass: 'rojin-dialog', autoFocus: false })
      .afterClosed().subscribe((cropped?: File) => {
        if (cropped) this.api.uploadAvatar(cropped).subscribe({
          next: (p) => { this.profile = p; }, error: (err) => this.redirectIfUnauth?.(err),
        });
      });
  }
  removeAvatar(): void {
    this.api.deleteAvatar().subscribe({ next: (p) => { this.profile = p; } });
  }
```
(Adapt `this.profile` to the component's actual profile field name — read the file first. If it stores fields separately, set `avatar_url` accordingly.)
In `profile.component.html`, wrap the avatar with a "change photo" overlay button + hidden input, and a Remove link when `avatarImage`:
```html
<div class="avatar-edit">
  <app-avatar [name]="..." [seed]="..." [imageUrl]="avatarImage" [size]="96"></app-avatar>
  <button type="button" class="avatar-edit__btn" (click)="avatarInput.click()" aria-label="Change photo"><mat-icon>photo_camera</mat-icon></button>
  <input #avatarInput type="file" accept="image/*" hidden (change)="onPickAvatar($event)">
  @if (avatarImage) { <button type="button" class="avatar-edit__remove" (click)="removeAvatar()">Remove photo</button> }
</div>
```
(Use the component's existing name/seed bindings for `<app-avatar>`.) Add small SCSS for `.avatar-edit` (relative wrapper) + `.avatar-edit__btn` (gold camera badge bottom-right of the circle) + `.avatar-edit__remove` (subdued link).

- [ ] **Step 2: Mobile profile.** Apply the same pattern in `mobile-profile.component.{ts,html,scss}` (it already shows `<app-avatar>` and uses `ProfileService`/`ChatApi`-style calls — inject `MatDialog` + `ChatApi`, add `onPickAvatar`/`removeAvatar`/`avatarImage`, the overlay button + hidden input, and styles).

- [ ] **Step 3: Build** → exit 0. Commit:
```bash
git add client/src/app/profile client/src/app/mobile/profile
git commit -m "feat(client): profile avatar change/remove flow (desktop + mobile)"
```

### Task 7: Render avatars across the app

**Files:** Modify `client/src/app/chat/chat.component.html`, `client/src/app/chat/message-thread/message-thread.component.{ts,html}`, `client/src/app/mobile/chats/mobile-chats.component.html`, `client/src/app/mobile/people/mobile-people.component.html`, `client/src/app/mobile/thread/mobile-thread.component.{ts,html}`.

For each `<app-avatar>` that represents a **person**, add `[imageUrl]="avatarSrc(<path>)"`. Expose `avatarSrc` to each template via a thin class member `readonly avatarSrc = avatarSrc;` (import it) on the component that owns the template, OR call a component method. Concretely:

- [ ] **Step 1: Desktop `chat.component`.** Import `avatarSrc`; add `readonly avatarSrc = avatarSrc;` to the class. In `chat.component.html`:
  - Sidebar DM rows: `[imageUrl]="avatarSrc(entry.avatarUrl)"`.
  - Conversation header (DM): `[imageUrl]="avatarSrc(selectedEntry?.avatarUrl)"`.
  - New-Chat search results: `[imageUrl]="avatarSrc(entry.avatar_url)"` (the `DirectoryUser`).
  - Member panel rows: `[imageUrl]="avatarSrc(m.avatar_url)"`.

- [ ] **Step 2: Shared thread sender-head.** In `message-thread.component.ts` add `readonly avatarSrc = avatarSrc;` (import it). In `message-thread.component.html`, the sender-head `<app-avatar>` gets `[imageUrl]="avatarSrc(message.senderAvatarUrl)"`.

- [ ] **Step 3: Mobile.** Add `readonly avatarSrc = avatarSrc;` to `MobileChatsComponent`, `MobilePeopleComponent`, `MobileThreadComponent` and set `[imageUrl]` on their `<app-avatar>`s:
  - `mobile-chats`: row avatar `[imageUrl]="avatarSrc(entry.avatarUrl)"`.
  - `mobile-people`: `[imageUrl]="avatarSrc(u.avatar_url)"`.
  - `mobile-thread`: header avatar `[imageUrl]="avatarSrc(entry.avatarUrl)"`.

- [ ] **Step 4: Build** → exit 0.

- [ ] **Step 5: Browser checkpoint (desktop + mobile).** Start both processes. With two users: set a photo via **Profile → change photo** (crop dialog: drag + zoom, Save). Confirm it appears in your profile, the other user's **sidebar / People / conversation header / group thread sender header**, on desktop and on a phone (DevTools device toolbar). Test a **portrait phone photo** (should not be sideways). **Remove photo** → back to initials. **Wait for approval.**

- [ ] **Step 6: Commit (after approval).**
```bash
git add client/src/app/chat client/src/app/mobile
git commit -m "feat(client): render uploaded avatars across sidebar, thread, directory, header"
```

---

## Phase 3 — Docs + final

### Task 8: Docs
**Files:** Modify `docs/system-design.md`, `CLAUDE.md`, `docs/evolution.md`.
- [ ] **Step 1:** `docs/system-design.md` — add `POST`/`DELETE /api/me/avatar` and `GET /api/avatars/<username>?token=` to the HTTP table; note `UserProfile.avatar_key`/`avatar_mime` and the `avatar_url`/`sender_avatar_url` fields in the person feeds.
- [ ] **Step 2:** `CLAUDE.md` — short "Avatars" note: stored via `chat/storage.py` (`avatar_key`), org-public token-in-URL serve, computed cache-busted `avatar_url` propagated through the feeds, `AvatarComponent` `imageUrl` + `avatarSrc()`, custom EXIF-aware cropper.
- [ ] **Step 3:** `docs/evolution.md` — "Avatar uploads — delivered" note (mention no live push / no group avatars as the remaining future bits).
- [ ] **Step 4: Commit** `docs: avatar uploads`.

### Task 9: Final review
- [ ] **Step 1:** `cd backend; ./.venv/Scripts/python.exe -m pytest -q` → all green.
- [ ] **Step 2:** `cd client; npm run build` → exit 0.
- [ ] **Step 3:** Final code review over the branch, then `superpowers:finishing-a-development-branch`.

---

## Self-review (plan vs spec)

- **Custom EXIF + touch crop/zoom, 512×512 JPEG** → Task 5 (`createImageBitmap` orientation, pointer drag + zoom + wheel, `toBlob`). ✓
- **Storage reuse + POST/DELETE/serve org-public, inline+nosniff, 404/401** → Task 2. ✓
- **`avatar_key`/`avatar_mime` schema + computed cache-busted `avatar_url`** → Task 1 + 2 (`_avatar_path`, `?v=key[:8]`). ✓
- **Propagation across chats_history / directory_users / group_members / serialize_messages / profiles** → Task 2 (profiles) + Task 3. ✓
- **`AvatarComponent` imageUrl + `avatarSrc`** → Task 4 helper + Task 7 render sites (all sites listed). ✓
- **Profile change/remove flow desktop + mobile** → Task 6. ✓
- **Tests** → Tasks 1–3 (pytest). **Docs** → Task 8. ✓
- **Type consistency:** `_avatar_path`, `avatarSrc`, `uploadAvatar`/`deleteAvatar`, `ConversationEntry.avatarUrl`, `DirectoryUser.avatar_url`, `Message.senderAvatarUrl`, `sender_avatar_url` payload key — named once, reused. ✓
- **Circular-import watch:** `conversations.py` imports `_avatar_path` **locally inside the functions** (Task 3 Step 4) to avoid an import cycle with `profile.py`. ✓
- **Cropper centering math:** Task 5 explicitly notes the `translate(-50%,-50%)` center-anchor + the `imgStyle.transform` composition so drag math matches. ✓
