# Group Avatars — Design

**Status:** Approved (brainstorm, 2026-06-04)
**Branch:** `feature/group-avatars`

---

## Goal

Let a group conversation have a **photo** (today groups show a gold monogram only). It reuses the **user-avatar machinery** built previously — the crop/zoom dialog, the `chat/storage.py` storage seam, the token-in-URL serve pattern, `avatarSrc()`, and `AvatarComponent` — and renders the group photo wherever the group monogram appears (desktop sidebar + header, mobile Chats + thread header), with the **monogram as the fallback**.

## Decisions (from brainstorming)

- **Set later only** by **any member** (consistent with the flat model where any member can already rename / add / remove). The New Group dialog is **unchanged**.
- **Served members-only** — a group photo is fetchable only by group members (decode token + `is_member`), **not** org-public like user avatars (only members ever see the group).
- **Monogram stays as the fallback** (no photo → existing gold monogram).
- **Reuse** `AvatarCropperComponent` (512×512 JPEG, EXIF-aware), `chat/storage.py`, `avatarSrc()`, `AvatarComponent`.
- **No live push** — a changed group photo appears for other members on their next data load (consistent with user avatars); the member who changed it sees it immediately.
- **Set affordances:** desktop = a control in the **member panel**; mobile = **tap the group avatar in the thread header** (there is no mobile manage panel).

---

## Backend (parallels user avatars; in `groups.py`)

### Schema
Add `avatar_key TEXT` + `avatar_mime TEXT` to the **`Conversation`** table (idempotent `ALTER` in `database.py`, mirroring the `UserProfile` avatar columns). Only group rows use them.

### Path helper
`_group_avatar_path(cid, avatar_key) -> str | None` → `/api/groups/<cid>/avatar?v=<avatar_key[:8]>` when set, else `None` (cache-buster; client appends `&token=`). Lives in `groups.py`.

### Endpoints (all `@jwt_required()` + `_require_member(cid)` except serve, which decodes the query token manually)
- **`POST /api/groups/<cid>/avatar`** (multipart `file`) — member-only; reject non-image mime (`400`); `storage.save` → `UPDATE Conversation SET avatar_key=?, avatar_mime=? WHERE id=?`; delete the old key; return the updated **group summary** (`_group_summary`, now with `avatar_url`).
- **`DELETE /api/groups/<cid>/avatar`** — member-only; clear `avatar_key`/`avatar_mime` + `storage.delete` the old file; return the group summary.
- **`GET /api/groups/<cid>/avatar?token=<jwt>`** — no `@jwt_required` (token in query for `<img>`); decode the token (reuse the manual decode pattern), resolve the caller's user id, and **`is_member(cid, uid)`** → else `403`; the group's `avatar_key` missing → `404`; bad/missing token → `401`. `send_file(..., mimetype=stored or image/jpeg, as_attachment=False)` + `X-Content-Type-Options: nosniff`.

### Propagation
- **`_group_summary(cid)`** adds `"avatar_url": _group_avatar_path(cid, avatar_key)` (select the conversation's `avatar_key`).
- **`get_chats_history`** (in `chatfunc.py`) — the **group** rows add `"avatar_url"` (select `c.avatar_key`, compute via `_group_avatar_path`). DM rows already carry their own `avatar_url`; groups simply join their own column.

### Tests (`backend/tests/test_group_avatars.py`)
- `POST /api/groups/<cid>/avatar` (member, image) → `avatar_url` like `/api/groups/<cid>/avatar?v=…`; non-image → `400`; non-member → `403`.
- `DELETE` clears it (`avatar_url` null).
- `GET …?token=<member>` → `200` + bytes + `inline`; non-member token → `403`; no avatar → `404`; no token → `401`.
- `chats_history` group rows include the group `avatar_url` once set.

---

## Frontend (reuses cropper + `avatarSrc` + `AvatarComponent`)

### Model
`ConversationEntry.avatarUrl` already exists (DM avatars). In `toEntry`, the **group** branch now maps `avatarUrl: raw.avatar_url ?? null` (the group `chats_history` row). The group summary returned by the group endpoints also carries `avatar_url`, used to update the open entry after a change.

### Render — the four monogram sites become photo-or-monogram
At each site, if the entry has `avatarUrl`, render `<app-avatar [name]="<title>" [seed]="<key>" [imageUrl]="avatarSrc(entry.avatarUrl)" [size]=…>`; else keep the existing gold monogram span:
- `chat.component.html` sidebar group rows (`group-mono`) and conversation header (`chat-header__mono`).
- `mobile-chats.component.html` group rows (`m-row__mono`) and `mobile-thread.component.html` header (`mt-mono`).

### API
`ChatApi.uploadGroupAvatar(cid: number, file: File): Observable<any>` (multipart POST) and `deleteGroupAvatar(cid: number): Observable<any>`.

### Set affordances
- **Desktop — member panel** (`chat.component`): add a "Change group photo" button (camera) + a hidden `accept="image/*"` input + a "Remove photo" link (shown when the group has one). On pick → open `AvatarCropperComponent` → `uploadGroupAvatar(cid, file)` → on success, set the open entry's `avatarUrl` from the returned summary (so the header + sidebar update live) and refresh the members view.
- **Mobile — tap the group avatar in the thread header** (`mobile-thread.component`): tapping the group's header avatar opens a hidden file input → cropper → `uploadGroupAvatar` → update the entry's `avatarUrl`. Provide remove via a small confirm (e.g. long-press or a tiny action) — keep it minimal; a long-press → "Remove photo" confirm is enough. (Only show this affordance for groups, not DMs.)

Both reuse the existing `AvatarCropperComponent` (already in `UiModule`).

### Verification
Frontend gate = `npm run build` exit 0 + manual browser verification (per CLAUDE.md). Backend = pytest.

---

## Files touched

- **Backend:** `chat/database.py` (Conversation `avatar_key`/`avatar_mime`), `chat/groups.py` (`_group_avatar_path`, the 3 endpoints, `_group_summary` avatar), `chat/chatfunc.py` (`get_chats_history` group rows add `avatar_url`), `tests/test_group_avatars.py`. (Reuses `chat/storage.py`.)
- **Frontend:** `core/models/conversation.model.ts` (`toEntry` group branch), `core/chat-api.service.ts` (`uploadGroupAvatar`/`deleteGroupAvatar`), `chat/chat.component.{ts,html}` (header + sidebar render + member-panel set/remove), `mobile/chats/mobile-chats.component.html` (group rows render), `mobile/thread/mobile-thread.component.{ts,html}` (header render + tap-to-set). Reuses `ui/avatar-cropper`.
- **Docs:** `docs/system-design.md` (endpoints + Conversation columns), `CLAUDE.md` (group-avatar note), `docs/evolution.md` (delivered).

## Error handling

- Upload non-image → `400` (+ `accept="image/*"` on the picker).
- Serve: `401` bad/missing token, `403` non-member, `404` no avatar.
- Changed photo busts the `<img>` cache via `?v=<key[:8]>`.
- `avatarSrc(null)` → null → the monogram fallback renders (existing behavior).

## Risks / watch-items

- **Members-only serve** is the key difference from user avatars (which are org-public) — keep the `is_member` check on the group serve route.
- **Render-site parity:** all four monogram sites must switch to the photo-or-monogram pattern, or a group photo appears in some places and not others.
- **Mobile set affordance** is a new interaction (tap header avatar) — verify it only triggers for groups and doesn't fight the existing header tap targets (back button / call icon).
- **Cache-busting:** the propagated `avatar_url` must carry `?v=`; don't hand-build the bare path.

## Scope / YAGNI

- Set later only (no New Group dialog photo step); any member; members-only serve.
- No live avatar push; monogram remains the fallback; no server-side resizing (client exports 512×512).
- One coherent project, one spec, one sequenced plan.
