# Web Push Notifications — Design

**Status:** Approved (decisions captured 2026-06-02)
**Phase:** Phase 5, Sub-project 3b — the finale of the Notifications+PWA arc (PWA shell ✓ → HTTPS ✓ → **Web Push**).
**Branch target:** new branch off `main`

---

## Goal

Deliver real push notifications for new messages — even when Rojin is fully closed — using the Web Push standard: VAPID-authenticated pushes from Flask to the browser's push service, surfaced by the service worker. Opt-in per device; tapping a notification opens the conversation. Builds on the PWA service worker + the HTTPS harness (a secure context is required).

## Decisions (from brainstorming)

- **Push policy:** **always send** a push to the recipient's devices for every message they receive (not their own); the **service worker suppresses** the banner only if a focused Rojin window is already on that conversation.
- **Opt-in UX:** an **"Enable notifications" toggle in Profile** (deliberate, reversible).
- **Content:** **sender name + message preview** (groups: "Group · Sender: text").
- **Service worker:** a thin **custom SW** wrapping ngsw (`importScripts('ngsw-worker.js')`) to add focus-aware push handling. Fallback if it misbehaves: ngsw's built-in always-show.

## Non-goals / YAGNI

- No notification grouping/threads, no reply-from-notification, no per-conversation mute, no "hide preview" privacy mode (all future).
- No notification when *you* send (only recipients).
- No cross-process fan-out (single Flask process sends pushes inline — consistent with the app's single-process model).

---

## 1. Keys & configuration (VAPID)

Generate one VAPID keypair (via `py-vapid`/`pywebpush`). Backend `.env`:
- `VAPID_PRIVATE_KEY` (secret — never committed),
- `VAPID_PUBLIC_KEY` (shipped to the client),
- `VAPID_SUBJECT` (e.g. `mailto:admin@rojin.local`).
`.env.example` documents all three as placeholders. If the keys are unset, push is simply disabled (endpoints return a clear "push not configured" state) — the app still works.

## 2. Schema — one table + idempotent migration

```sql
CREATE TABLE IF NOT EXISTS PushSubscription (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```
Added to `database.py`'s schema (fresh DBs) and created idempotently at startup (the table is new, so a plain `CREATE TABLE IF NOT EXISTS` suffices — no `ALTER`).

## 3. Backend (`backend/chat/push.py`, new)

Dependency: add **`pywebpush`** to `requirements.txt`.

JWT-protected endpoints:
- `GET /api/push/vapid-key` → `{ "publicKey": <VAPID_PUBLIC_KEY or null> }`.
- `POST /api/push/subscribe` `{ subscription: { endpoint, keys: { p256dh, auth } } }` → upsert by `endpoint` for the JWT user → 201.
- `POST /api/push/unsubscribe` `{ endpoint }` → delete that row → 200.

Helper:
```python
def send_push_to_user(user_id: int, payload: dict) -> None
```
Loads the user's subscriptions, sends each via `pywebpush.webpush(...)` with the VAPID claims and the JSON payload; on a `WebPushException` with status **404/410** (gone), deletes that subscription (pruning). No-op if VAPID is unconfigured. Wrapped so a push failure never breaks message delivery.

**Hooks:** after a message is persisted —
- `post_dm_message` (`chatfunc.py`): `send_push_to_user(peer_id, payload)` where `conversationKey` = the sender's username (the recipient keys the DM by sender).
- `post_group_message` (`groups.py`): for each group member except the sender, `send_push_to_user(member_id, payload)` with `conversationKey` = `conv:<cid>`.

Payload shape (no top-level `notification` key, so ngsw won't auto-show — our custom SW does):
```json
{ "title": "Amelia", "body": "Gold foil was the right call.",
  "conversationKey": "amelia", "kind": "direct", "url": "/" }
```
(Group: `title` = group title, `body` = "Sender: text".)

## 4. Service worker — `client/public/sw-custom.js` (new)

Registered instead of `ngsw-worker.js`. It keeps all ngsw behavior and adds focus-aware push:
```javascript
importScripts('./ngsw-worker.js');

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data.json(); } catch (e) {}
  if (!data.title) return;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const focusedHere = wins.some((c) => c.focused);
    // Suppress only if a focused Rojin window exists (it shows the message live).
    if (focusedHere) return;
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) { await wins[0].focus(); wins[0].postMessage({ type: 'open-conversation', data: event.notification.data }); }
    else { await self.clients.openWindow('/'); }
  })());
});
```
- `angular.json`'s `serviceWorker` build keeps generating `ngsw-worker.js`; we register `sw-custom.js`. (ngsw's own push handler ignores payloads lacking a `notification` key, so no double banner.)
- The app listens for `message` events (`open-conversation`) and routes to the conversation.

## 5. Frontend

- **`push.service.ts`** (Angular `SwPush`): `isEnabled`, `enable()` (GET vapid-key → `swPush.requestSubscription({ serverPublicKey })` → POST `/api/push/subscribe`), `disable()` (unsubscribe + POST `/api/push/unsubscribe`), and current state from `Notification.permission` + existing subscription.
- **Profile** (`profile.component`): an "Enable notifications" toggle (Atelier-styled) bound to the service; shows enabled/blocked/unsupported states.
- **ChatComponent**: handle the SW `open-conversation` message → `selectConversation` for that key (navigate to `/` first if needed).

## 6. Tests (`backend/tests/test_push.py`)

- `vapid-key` returns the configured public key (set test env VAPID vars in conftest).
- `subscribe` inserts a row; duplicate endpoint upserts (no dup); `unsubscribe` removes it.
- `send_push_to_user` (with `pywebpush.webpush` monkeypatched) is called once per subscription with the right payload; a 410 prunes the sub.
- Endpoints require auth.

## Files touched

- **Backend:** `requirements.txt`, `.env.example`, `chat/__init__.py` (VAPID env), `chat/database.py` (table), new `chat/push.py`, `chat/chatfunc.py` + `chat/groups.py` (hooks), `chat/__init__.py` (import push); `backend/tests/conftest.py` (VAPID test env) + `test_push.py`.
- **Frontend:** `client/public/sw-custom.js`, `client/src/app/app.module.ts` (register sw-custom), new `client/src/app/push.service.ts`, `client/src/app/profile/profile.component.{ts,html,scss}`, `client/src/app/chat/chat.component.ts` (open-conversation handler).
- **Docs:** `CLAUDE.md`, `docs/evolution.md`.

## Error handling / edge cases

- VAPID unconfigured → push disabled gracefully; `vapid-key` returns `null`; the Profile toggle shows "not available".
- Dead/expired subscriptions pruned on 404/410.
- Push send failures are caught and logged, never block message persistence/delivery.
- `SwPush.isEnabled` is false under `ng serve` (dev, no SW) → toggle shows "available only in the installed/HTTPS app".

## Testing / verification

`pytest` for the backend (mocked pywebpush). End-to-end requires the **HTTPS harness** (`deployment/serve-https.ps1`) + a real device that's subscribed: send from account A → account B (app closed/backgrounded) gets a banner; tapping opens the conversation; focused-on-that-chat is suppressed. Build green.

## Risks / watch-items

- **Custom SW wrapping ngsw** — main risk. If dual push handlers or `importScripts` misbehave, fall back to ngsw's built-in push (always-show, drop focus-suppression). Verify no double banners.
- **Secure context required** — only testable via the HTTPS harness / installed PWA, not `ng serve`.
- **`pywebpush` on Windows** pulls `cryptography` (prebuilt wheels exist) — low risk.
- **iOS** requires the PWA be **installed** (16.4+) for Web Push; document this.
- Payload must omit a top-level `notification` key so ngsw doesn't also show a banner.
