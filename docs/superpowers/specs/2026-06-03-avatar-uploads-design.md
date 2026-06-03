# Avatar Uploads — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-03)
**Branch:** `feature/avatar-uploads`

---

## Goal

Let users upload a real profile photo (today avatars are initials-only). The user **crops & zooms** the photo client-side into a circular avatar; it uploads through the existing `chat/storage.py` seam, and the avatar then appears **everywhere `<app-avatar>` is already used** — sidebar, conversation header, group thread sender headers, People directory, member panel, and profiles — on desktop and mobile.

## Decisions (from brainstorming)

- **Crop & zoom, custom cropper** (no library): a circular-masked dialog with drag-to-pan + a zoom slider; **must handle EXIF orientation** (so phone portraits aren't sideways) **and touch pinch-zoom** (this app is mobile-heavy). Exports a **512×512 JPEG (quality ~0.9)** client-side — so the backend stores a small square and needs **no server-side image processing**.
- **Storage/serve reuses the attachments machinery:** `POST /api/me/avatar` saves via `chat/storage.py`; served at `GET /api/avatars/<username>?token=<jwt>`, **org-public** (any authenticated member can view any member's avatar — no conversation check), images **inline + `nosniff`**.
- **`AvatarComponent` already supports `imageUrl`** — propagation is just feeding the URL through the data feeds and passing `[imageUrl]` at each render site.
- **Scope (YAGNI):** changing your photo updates **your** views immediately; **other** users see it on their next data load (no live avatar push over the socket — a future add). **Groups have no avatar** (the monogram stays). No server-side resizing (the client already exports 512×512).

---

## Backend

### Schema
Add `avatar_key TEXT` to `UserProfile` (idempotent `ALTER` in `database.py`, like `last_read_at`). It holds the storage key. The pre-existing free-text `avatar_url` column stops being written (left in place, harmless).

The API's returned **`avatar_url` is computed**, not stored: a helper `_avatar_path(username, avatar_key)` returns `/api/avatars/<username>?v=<avatar_key[:8]>` when a key exists, else `None`. The `?v=` (first 8 chars of the key) is a **cache-buster** so a changed photo refreshes in `<img>`.

### Endpoints (`backend/chat/profile.py` — extends the existing profile module)
- **`POST /api/me/avatar`** (JWT, multipart `file`) — reject a non‑image mime (`400`); `storage.save(file)` → `UPDATE UserProfile SET avatar_key=?, updated_at=?`; if an old key existed, `storage.delete` it; return the updated profile (`avatar_url` = the new path). Size is bounded by the existing `MAX_CONTENT_LENGTH` (25 MB; a 512px JPEG is tiny).
- **`DELETE /api/me/avatar`** (JWT) — `storage.delete` the current key, set `avatar_key=NULL`, return the profile.
- **`GET /api/avatars/<username>?token=<jwt>`** — decode the token (reuse the manual decode pattern from `attachments.serve_attachment`; **no `@jwt_required`** because the token rides in the query for `<img>` compatibility); any valid user is allowed (org‑public). Look up that user's `avatar_key`; `404` if none; `send_file(..., mimetype=<stored or image/jpeg>, as_attachment=False)` (inline) + `X-Content-Type-Options: nosniff`. `401` if the token is missing/invalid.

Store the uploaded mime alongside the key (either reuse the existing `avatar_url` column to stash the mime, or add `avatar_mime TEXT`). **Decision:** add `avatar_mime TEXT` to `UserProfile` too (idempotent) — cleaner than overloading `avatar_url`.

### Propagation — every feed that drives an `<app-avatar>` returns the avatar path
Add a `LEFT JOIN UserProfile` (for `avatar_key`) and the computed `avatar_url` to:
- **`chatfunc.get_chats_history`** — the DM peer's `avatar_url` (on each direct entry). Groups: none.
- **`conversations.group_members`** — each member's `avatar_url`.
- **`chatfunc.directory_users`** — each user's `avatar_url`.
- **`conversations.serialize_messages`** — a per‑message **`sender_avatar_url`** (the sender's avatar), so group thread sender headers are accurate.
- **`profile.get_my_profile` / `get_user_public_profile`** — already return `avatar_url`; switch them to the computed path from `avatar_key`.

`_avatar_path` lives in `profile.py` (or `conversations.py` if cleaner for the imports — it's pure DB-string building); reuse it in all feeds.

### Tests (`backend/tests/test_avatars.py`)
- `POST /api/me/avatar` with an image → `avatar_key` set, `GET /api/me/profile` returns `avatar_url` like `/api/avatars/<me>?v=…`.
- `POST` with a non‑image mime → `400`.
- `DELETE /api/me/avatar` → `avatar_url` back to `null`.
- `GET /api/avatars/<user>?token=<valid>` → `200` + bytes + `Content-Disposition: inline`; **no token / bad token → 401**; user with no avatar → `404`.
- `directory_users`, `chats_history` (DM peer), `group_members`, and `serialize_messages` (`sender_avatar_url`) include the avatar path once a user has uploaded one.

---

## Frontend

### Custom cropper — `client/src/app/ui/avatar-cropper/avatar-cropper.component.{ts,html,scss}`
A `MatDialog` component (declared/exported via `UiModule` so both desktop and mobile profile screens can open it). Input (`MAT_DIALOG_DATA`): the picked `File`. Behavior:
- Load the image; **read EXIF orientation** (parse the JPEG APP1/Orientation tag, or use `createImageBitmap(file, { imageOrientation: 'from-image' })` where supported — prefer `createImageBitmap` with a manual-orientation fallback) so portraits draw upright.
- Render the image in a fixed circular-masked viewport; **drag to pan**; a **zoom slider**; **touch: one-finger drag + two-finger pinch-zoom** (pointer events).
- **Save:** draw the visible circle's square region onto a **512×512** `<canvas>` and `canvas.toBlob(blob => …, 'image/jpeg', 0.9)`; close the dialog returning a `File` (`new File([blob], 'avatar.jpg', {type:'image/jpeg'})`). **Cancel:** close with `undefined`.
- Atelier-styled (charcoal dialog chrome, gold Save), safe-area aware on mobile.

### Avatar URL helper — `client/src/app/core/avatar-url.ts`
```typescript
export function avatarSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  return `${path}&token=${localStorage.getItem('access_token')}`;   // path already has ?v=
}
```
(Pure function, no DI; imported wherever an avatar renders.)

### Profile flow (desktop `ProfileComponent` + mobile `MobileProfileComponent`)
- The avatar shows a **"change photo" affordance** (a camera-icon overlay button) → hidden `<input type="file" accept="image/*">` → on pick, open `AvatarCropperComponent` via `MatDialog` → on a returned `File`, `POST /api/me/avatar` (multipart) through `ChatApi` → on success, set the local profile `avatar_url` (so the preview updates immediately) and the toolbar/avatar refresh.
- A **"Remove photo"** button (shown when an avatar exists) → `DELETE /api/me/avatar` → revert to initials.
- `ChatApi` gains `uploadAvatar(file): Observable<Profile>` and `deleteAvatar(): Observable<Profile>` (multipart POST / DELETE with the Bearer header).

### Models + render sites
- Models gain the field: `ConversationEntry.avatarUrl`, `DirectoryUser.avatar_url`, group member objects `avatar_url`, `Message.senderAvatarUrl` (mapped in `toMessage` from `raw.sender_avatar_url`); `toEntry` maps `raw.avatar_url` → `avatarUrl`.
- Every existing `<app-avatar …>` that represents a person adds `[imageUrl]="avatarSrc(<thePath>)"`:
  - **Desktop:** sidebar conversation rows, conversation header (DM), thread **sender-head** (group), New‑Chat search results, member panel rows.
  - **Mobile:** Chats list rows, People rows, thread header, thread **sender-head**, Profile.
  - The shared `<app-message-thread>` sender-head uses `message.senderAvatarUrl`.
- Group monograms are unchanged (groups have no avatar).

### Verification
Frontend gate = `npm run build` exit 0 + manual browser verification (per CLAUDE.md). Backend = pytest.

---

## Files touched

- **Backend:** `chat/database.py` (`avatar_key` + `avatar_mime` columns), `chat/profile.py` (`_avatar_path`, `POST`/`DELETE /api/me/avatar`, computed `avatar_url`, avatar serve route — or put the serve route here), `chat/chatfunc.py` (`get_chats_history`, `directory_users` add avatar), `chat/conversations.py` (`group_members`, `serialize_messages` add avatar), `tests/test_avatars.py`. (Reuses `chat/storage.py` as-is.)
- **Frontend:** `core/avatar-url.ts` (new), `core/chat-api.service.ts` (`uploadAvatar`/`deleteAvatar`), `core/models/*` (avatar fields + mapping), `ui/avatar-cropper/*` (new, declared in `UiModule`), `profile/profile.component.*` + `mobile/profile/mobile-profile.component.*` (change/remove flow), and the `[imageUrl]` additions across the render sites listed above (`chat.component.html`, `message-thread.component.html`, `mobile/chats`, `mobile/people`, `mobile/thread`).
- **Docs:** `docs/system-design.md` (endpoints + columns), `CLAUDE.md` (avatar note), `docs/evolution.md` (delivered).

## Error handling

- Upload non‑image → `400` (and the picker uses `accept="image/*"`); cropper rejects a file that fails to load as an image.
- Serve: `401` bad/missing token, `404` no avatar.
- A changed avatar busts the `<img>` cache via `?v=<key[:8]>`.
- `avatarSrc(null)` → `null` → `<app-avatar>` falls back to initials (existing behavior).

## Risks / watch‑items

- **EXIF orientation** is the classic gotcha — prefer `createImageBitmap(file, { imageOrientation: 'from-image' })`; verify a portrait phone photo isn't sideways.
- **Touch cropping** (pinch-zoom + drag) needs real device testing — pointer events, not mouse-only.
- **Cache-busting:** every render site must use the `?v=`-bearing path (don't hand-build `/api/avatars/<user>` without the version) or stale photos linger.
- **Render-site breadth:** many `<app-avatar>` sites — easy to miss one; the spec lists them explicitly.
- **Org-public serve** is intentional (avatars aren't conversation-scoped); keep it token-gated (any valid member), not anonymous.

## Scope / YAGNI

- No live avatar push over the socket (others refresh on next load).
- No group avatars (monogram stays).
- No server-side resizing/thumbnails (client exports 512×512).
- One coherent project, one spec, one sequenced plan.
