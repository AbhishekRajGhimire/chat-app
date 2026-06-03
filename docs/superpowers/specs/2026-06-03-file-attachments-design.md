# File Attachments — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-03)
**Branch:** `feature/file-attachments`

---

## Goal

Let people attach **files** to messages in DMs and groups — **images render inline** (thumbnail → tap to enlarge), **any other file** type shows as a **download chip** — with **multiple attachments per message**, rendered identically on desktop and mobile. Built on the existing `client_message_id` + layered `ChatApi`/`ChatStore` foundation, with file storage isolated behind a seam so a future S3/object-store deployment is a localized swap.

## Decisions (from brainstorming)

- **What's attachable:** images (jpg/png/gif/webp) **and any other file type**. Images inline; everything else a download chip (icon + name + size).
- **Count:** **multiple** attachments per message (a pending tray in the composer; send together).
- **Size cap:** **25 MB per file**, enforced server-side.
- **Approach A** (chosen): files on **local disk** (behind a storage module), **metadata in the DB**, served via a **token-in-URL** route that reuses the existing Socket.IO `?token=<jwt>` pattern; membership-checked.
- **Rendering:** single image = inline thumbnail; multiple images = grid in one bubble with a "+N" overflow; other files = download chip; optional text below. Shared `<app-message-thread>` so both shells match.
- **Composer:** a 📎 paperclip opens the picker; chosen files upload immediately into a **pending tray** (thumbnails / file chips) with per-file progress + remove (✕); text is optional.

## Production evolution (note for later — do NOT build now)

The design is production-shaped; for a real multi-server deploy:
1. **Metadata** moves to the real DB (Postgres/MySQL) unchanged.
2. **Bytes** move from local disk to **object storage (S3/MinIO/GCS)** by swapping the **storage module** (`chat/storage.py`) — one file; the table, linking, auth, and entire client/render layer are untouched. With S3 the serve route issues **pre-signed URLs** (the natural evolution of Approach A's token-in-URL).
3. **Redis** enters for **multi-process realtime** (Socket.IO pub/sub adapter) — a broader scaling step; attachments ride on the same message events without change.

This note also belongs in `docs/evolution.md`.

---

## Architecture & flow

Files can't ride the Socket.IO message (no bytes over the event), so it's **upload-first**:

1. **Pick → upload immediately.** The composer's 📎 picks one or more files. Each uploads via `POST /api/attachments` (multipart, ≤25 MB) which saves the bytes and returns a ref `{ id, filename, mime, size, kind }` (`kind` = `'image' | 'file'`). They sit in the **pending tray** (state owned by `ChatStore`, so both composers are thin views) with progress + remove.
2. **Send.** The existing send (`ChatStore.sendMessage`) runs its dual-write (socket emit + persistence POST), now also carrying `attachment_ids` (for the POST) and the attachment **metadata** (for the socket payload, so the recipient renders live).
3. **Link.** `post_dm_message` / `post_group_message` link the given attachments to the new message — set each row's `client_message_id` after verifying the caller **uploaded** them and they're unlinked. The message body may be empty (`''`).
4. **Render.** Recipients get metadata over the socket and render immediately; bytes load from `GET /api/attachments/<id>?token=<viewer's own token>` (membership-checked). History (`serialize_messages`) returns an `attachments` array per message.

### Storage module (the seam) — `backend/chat/storage.py`

The only code that touches bytes. Local-disk implementation now; swappable later.
```python
def save(file_storage) -> tuple[str, int]:   # returns (storage_key, size_bytes); writes to uploads/<uuid><ext>
def open_stream(storage_key) -> file-like     # for serving
def delete(storage_key) -> None               # for future cleanup
```
Local impl writes under `backend/uploads/` (gitignored), keyed by a server-generated UUID (never the client filename → no path traversal).

---

## Schema — `MessageAttachment` (idempotent create)

```sql
CREATE TABLE IF NOT EXISTS MessageAttachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_message_id TEXT,                 -- NULL until linked to a message on send
  conversation_id INTEGER,                -- set at link time (drives membership checks)
  uploader_user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,              -- opaque key for the storage module
  filename TEXT NOT NULL,                 -- original name, for display + download
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,                     -- 'image' | 'file'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attachment_cmid ON MessageAttachment(client_message_id);
```
`kind` is derived at upload from the mime (`image/*` → `'image'`, else `'file'`). `Message.body` stays `NOT NULL`; attachment-only messages store `''`.

## Backend endpoints — `backend/chat/attachments.py` (new)

- **`POST /api/attachments`** (JWT, multipart, field `file`) → save via storage module, insert a `MessageAttachment` row (uploader = caller, `client_message_id` NULL), return `{ id, filename, mime, size, kind }`. Rejects > 25 MB (see `MAX_CONTENT_LENGTH` → `413`).
- **`GET /api/attachments/<id>?token=<jwt>`** → decode the token (same helper the socket handshake uses), resolve the attachment → its message's `conversation_id`, verify the caller **is a member** (else `403`); refuse if the message is **deleted** (`404`). Stream the file with:
  - `Content-Type: <mime>`
  - **images:** `Content-Disposition: inline`
  - **all other types:** `Content-Disposition: attachment; filename="<original>"` **+ `X-Content-Type-Options: nosniff`** (prevents an uploaded `.html`/script from rendering in-page — the key XSS guard).
- Helper `attachments_for(client_message_id) -> list[dict]` → `[{id, filename, mime, size, kind}]`, used by `serialize_messages`.
- `link_attachments(cmid, conversation_id, attachment_ids, uploader_id)` → sets `client_message_id` + `conversation_id` for rows the caller uploaded and that are still unlinked (ignores others).

### Threading through sends (`chatfunc.py`, `groups.py`)
- `post_dm_message` / `post_group_message` accept `attachment_ids: [int]`; after inserting the message, call `link_attachments(...)`; allow an **empty body when attachment_ids is non-empty** (currently body is required — relax to "body OR attachments required").
- Both the POST response and the socket `receive_message` payload include the message's `attachments` metadata so the recipient renders without a refetch.
- `serialize_messages(cid, me_id)` adds `attachments` to each message dict.

### Wiring
- `chat/__init__.py`: `from chat import attachments`; set `app.config['MAX_CONTENT_LENGTH'] = 25 * 1024 * 1024` (with a small margin) so oversize uploads get a clean `413`.
- `.gitignore`: add `backend/uploads/`.

---

## Frontend

### Models (`core/models/message.model.ts`)
```typescript
export interface Attachment { id: number; filename: string; mime: string; size: number; kind: 'image' | 'file'; }
// Message gains: attachments?: Attachment[];
```

### Transport (`core/chat-api.service.ts`)
- `uploadAttachment(file: File): Observable<HttpEvent<Attachment>>` — multipart POST with `reportProgress: true` so the tray shows progress.
- `attachmentUrl(id: number): string` → `/api/attachments/${id}?token=${localStorage.getItem('access_token')}` (the viewer's own token; works in `<img src>` and download links).

### Store (`core/chat-store.service.ts`) — owns the pending tray (so both composers are thin)
- `pendingAttachments = signal<PendingAttachment[]>([])` where `PendingAttachment = { localId; file; status: 'uploading'|'done'|'failed'; progress; attachment?: Attachment }`.
- `addFiles(files: FileList)` → create pending entries, upload each via `ChatApi`, update progress/status.
- `removePending(localId)`, `retryPending(localId)`.
- `sendMessage(entry, text, replyingTo)` → include the **done** pending attachments' ids + metadata in the emit + POST, set them on the optimistic `Message.attachments`, then **clear** the tray. Guard: don't send while any pending upload is still in flight (or send only the completed ones — pick: send only `done`, keep `uploading`/`failed` in the tray).
- `onReceive` / `toMessage` map the incoming `attachments` array.

### Rendering (`chat/message-thread/`)
- In each bubble, above the text: render `message.attachments`.
  - **images** (`kind==='image'`): a grid (1 → full width; 2–4 → 2-col grid; >4 → 2-col with a "+N" overlay on the 4th), each `<img [src]="api.attachmentUrl(a.id)" loading="lazy">`; click → a simple **lightbox** overlay (full-size image + close).
  - **files** (`kind==='file'`): a download chip — type icon (by mime/extension), filename, human size; the whole chip is an `<a [href]="api.attachmentUrl(a.id)" download>`.
- A deleted message renders the tombstone and **no attachments** (existing `deleted` handling).
- Add the styles (image grid, chip, lightbox) to `message-thread.component.scss` (Atelier tokens), so desktop + mobile share them.

### Composer (desktop `chat.component.html` + mobile `mobile-thread.component.html`)
- Add a 📎 button → hidden `<input type="file" multiple>` → `store.addFiles($event.target.files)`.
- Render `store.pendingAttachments()` as the **tray** above the input (image thumbnails via `URL.createObjectURL(file)` for instant preview, or the uploaded url once done; file chips for non-images), each with progress + ✕ (`store.removePending`) and a failed/retry state.
- Send button enabled when there's text **or** ≥1 completed attachment.
- The tray markup/styles can live in a tiny shared `attachment-tray` partial/component used by both composers (avoid duplication); the upload logic is already shared in `ChatStore`.

---

## Error handling

- **Oversize** → server `413` → the pending item shows "Too large (max 25 MB)" with remove.
- **Upload network failure** → pending item `failed` + retry/remove; never blocks other attachments.
- **Send** only links/sends **completed** uploads; in-flight ones stay in the tray.
- **Serve** → `403` (non-member), `404` (missing or deleted-message attachment).

## Testing (`backend/tests/test_attachments.py`)

- Upload stores a file + returns `{id, filename, mime, size, kind}`; `kind` derived from mime.
- Send with `attachment_ids` links them (sets `client_message_id` + `conversation_id`); **a different user cannot link** someone else's attachment (ignored / not linked).
- `serialize_messages` / history includes the `attachments` array.
- Serve: member gets the bytes with correct `Content-Disposition` (inline for image, attachment+`nosniff` for a non-image); **non-member → 403**; deleted message's attachment → 404.
- Over-cap upload → 413 (or the configured rejection).
- Attachment-only message (empty body + attachment_ids) is accepted.

(Frontend gate stays the production build + manual browser verification, per CLAUDE.md.)

## Files touched

- **Backend:** `chat/database.py` (table + migration), new `chat/storage.py`, new `chat/attachments.py`, `chat/chatfunc.py` + `chat/groups.py` (accept/link `attachment_ids`, include metadata), `chat/conversations.py` (`serialize_messages` + `attachments_for`), `chat/__init__.py` (import + `MAX_CONTENT_LENGTH`), `.gitignore` (`backend/uploads/`), `tests/test_attachments.py`.
- **Frontend:** `core/models/message.model.ts`, `core/chat-api.service.ts`, `core/chat-store.service.ts`, `chat/message-thread/*` (render + lightbox + styles), `chat/chat.component.{html,ts}` + `mobile/thread/mobile-thread.component.{html,ts}` (composer 📎 + tray), optional shared `attachment-tray` partial.
- **Docs:** `docs/system-design.md` (endpoints + table), `docs/evolution.md` (delivered + the production-evolution note), `CLAUDE.md` (attachments + storage seam).

## Scope / YAGNI

- **No** server-side thumbnail generation (serve originals, CSS-size them) — note as a future optimization.
- **No** orphan-upload cleanup job (uploaded-but-never-sent rows linger harmlessly) — note as future.
- **No** audio/video players (files just download) — that was the larger "media players" scope we declined.
- One coherent project, one spec, one sequenced plan; storage stays behind the module seam for the future S3 swap.

## Risks / watch-items

- **Authenticated `<img>`** via token-in-URL — relies on the existing `?token=` decode path; keep the serve route's membership check strict.
- **Inline-vs-attachment disposition** is a security control, not cosmetic — non-images MUST be `attachment` + `nosniff`.
- **Composer duplication** — keep the tray/upload shared (`ChatStore` + a small shared partial) so desktop and mobile don't drift.
- **`MAX_CONTENT_LENGTH`** applies app-wide — confirm it doesn't clip other JSON endpoints (25 MB ceiling is far above any JSON body here).
