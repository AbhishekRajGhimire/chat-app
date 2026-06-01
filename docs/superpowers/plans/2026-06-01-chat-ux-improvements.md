# Chat UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unread badges + recency sort + last-message preview, reliable send (failed state + retry), live new conversations, and a typing indicator to the chat — with no DB schema change.

**Architecture:** One read-only `chats_history` query enhancement + one new Socket.IO `typing` relay on the backend; everything else is client state in `ChatComponent` (sorted list, client-only unread, message `status`, typing throttle/listen).

**Tech Stack:** Flask + Flask-SocketIO (SQLite), Angular 21 (NgModules), socket.io-client.

**Verification model:** Each task ends with `npm run build` GREEN. No per-task browser check (user waived); a single full browser review after Task 6. `npm test` is the pre-existing-broken suite and is NOT a gate.

**Spec:** `docs/superpowers/specs/2026-06-01-chat-ux-improvements-design.md`
**Branch:** `feature/chat-ux` (already created; spec committed).

---

### Task 1: Backend — last-message fields + typing relay

**Files:**
- Modify: `backend/chat/chatfunc.py`

- [ ] **Step 1: Add last message body + time to `/api/chats_history`.** Replace the peer query so each peer row also returns the latest message body and timestamp for that direct conversation. Keep the self-entry with null preview. New query for `peers`:

```python
cursor.execute(
    """
    SELECT u.username,
        COALESCE(NULLIF(TRIM(p.display_name), ''), u.username) AS display_name,
        (SELECT m.body FROM Message m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
        (SELECT m.created_at FROM Message m
         WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at
    FROM Conversation c
    JOIN ConversationMember ms ON ms.conversation_id = c.id AND ms.user_id = ?
    JOIN ConversationMember mp ON mp.conversation_id = c.id AND mp.user_id != ms.user_id
    JOIN User u ON u.id = mp.user_id
    LEFT JOIN UserProfile p ON p.user_id = u.id
    WHERE c.type = 'direct'
    """,
    (me_id,),
)
peers = [
    {"username": r[0], "display_name": r[1], "last_message": r[2], "last_message_at": r[3]}
    for r in cursor.fetchall()
]
self_entry = {"username": me_name, "display_name": self_display,
              "last_message": None, "last_message_at": None}
```

- [ ] **Step 2: Add the typing relay handler** near the `send_message` handler:

```python
@socketio.on("typing")
def handle_typing(data):
    sender = socket_user_by_sid.get(request.sid)
    if not sender:
        return
    data = data or {}
    recipient = data.get("recipient")
    if isinstance(recipient, str) and recipient.strip():
        emit("peer_typing", {"from": sender}, room=recipient.strip())
```

- [ ] **Step 3: Restart backend, confirm it boots** (the dev `.env` has FLASK_DEBUG=true). Expect: `wsgi starting up on http://0.0.0.0:3000`.
- [ ] **Step 4: Commit** `feat(backend): chats_history last-message fields + typing relay`

---

### Task 2: Frontend — entry model, recency sort, list-time helper

**Files:**
- Modify: `client/src/app/profile.service.ts`
- Modify: `client/src/app/chat/chat.component.ts`

- [ ] **Step 1:** Extend `DirectoryUser` in `profile.service.ts`:

```typescript
export interface DirectoryUser {
  username: string;
  display_name: string;
  last_message?: string | null;
  last_message_at?: string | null;
  unreadCount?: number;
}
```

- [ ] **Step 2:** In `chat.component.ts`, after loading `chats_history`, initialize unread to 0:

```typescript
this.chatUsers = (data ?? []).map((e) => ({ ...e, unreadCount: 0 }));
```

- [ ] **Step 3:** Add a `sortedChatUsers` getter (recency desc; null timestamps and the self-entry sort last):

```typescript
get sortedChatUsers(): DirectoryUser[] {
  const ts = (e: DirectoryUser) =>
    e.username === this.currentUser ? -Infinity : (e.last_message_at ? new Date(e.last_message_at).getTime() : 0);
  return [...this.chatUsers].sort((a, b) => ts(b) - ts(a));
}
```

- [ ] **Step 4:** Add a relative list-time helper:

```typescript
/** Compact time for a DM row: "9:43", "Tue", "May 30". */
listTime(iso: any): string {
  const d = this.toDate(iso);
  if (!d) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const diffDays = Math.round((now.getTime() - d.getTime()) / 86400000);
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
```

- [ ] **Step 5:** `cd client; npm run build` → GREEN.
- [ ] **Step 6: Commit** `feat(client): conversation entry model + recency sort + list time`

---

### Task 3: Conversation list — preview, time, unread badge

**Files:**
- Modify: `client/src/app/chat/chat.component.html`
- Modify: `client/src/app/chat/chat.component.scss`

- [ ] **Step 1:** Replace the DM list `@for` (currently iterating `chatUsers`) to iterate `sortedChatUsers` and render preview + time + badge:

```html
@for (entry of sortedChatUsers; track entry.username) {
  <mat-list-item (click)="selectUser(entry.username)"
    [ngClass]="{ active: selectedUser === entry.username }">
    <span class="dm-row" [class.is-unread]="(entry.unreadCount || 0) > 0">
      <app-avatar [name]="entry.display_name" [seed]="entry.username" [size]="34"></app-avatar>
      <span class="dm-row__body">
        <span class="dm-row__name">{{ entry.display_name }}@if (entry.username === currentUser) {<span class="dm-row__you"> (You)</span>}</span>
        @if (entry.last_message) {
          <span class="dm-row__preview">{{ entry.last_message }}</span>
        }
      </span>
      <span class="dm-row__meta">
        @if (entry.last_message_at) { <span class="dm-row__time">{{ listTime(entry.last_message_at) }}</span> }
        @if ((entry.unreadCount || 0) > 0) { <span class="dm-row__badge">{{ entry.unreadCount }}</span> }
      </span>
    </span>
  </mat-list-item>
}
```

- [ ] **Step 2:** Update the DM-list height token and add row styles in `chat.component.scss`. Change `.chat-users-list` `--mdc-list-list-item-one-line-container-height` to `56px`, and add:

```scss
.dm-row {
  display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0;
}
.dm-row__body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dm-row__name {
  font-family: $rojin-font-display; font-size: 13.5px;
  color: $rojin-text-on-brand; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dm-row__preview {
  font-size: 12px; color: rgba(247, 242, 232, 0.5);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dm-row__meta { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
.dm-row__time { font-size: 10.5px; color: rgba(247, 242, 232, 0.45); }
.dm-row__badge {
  min-width: 19px; height: 19px; padding: 0 6px; border-radius: 999px;
  background: $rojin-gold; color: #2b1a06; font-size: 11px; font-weight: 700;
  display: grid; place-items: center; line-height: 1;
}
.dm-row.is-unread {
  .dm-row__name { font-weight: 700; color: #fff; }
  .dm-row__preview { color: rgba(247, 242, 232, 0.82); font-weight: 500; }
}
```

(Remove the old `.dm-row__name` block's duplicate properties so this is the single definition.)

- [ ] **Step 3:** `npm run build` → GREEN (chat SCSS budget is 16kb error ceiling).
- [ ] **Step 4: Commit** `feat(client): DM list preview, time and unread badge`

---

### Task 4: Unread tracking, tab title, live new conversations

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`

- [ ] **Step 1:** Add a base-title constant and a helper that recomputes the tab title:

```typescript
private static readonly BASE_TITLE = 'Rojin : the org chat';

private refreshTabTitle(): void {
  const total = this.chatUsers.reduce((n, e) => n + (e.unreadCount || 0), 0);
  document.title = total > 0 ? `(${total}) Rojin` : ChatComponent.BASE_TITLE;
}
```

- [ ] **Step 2:** In the `receive_message` handler, after building `msg` and before/while updating `chatHistory`, update the matching entry (creating it if missing — live new conversation), bump unread, and refresh the title:

```typescript
const prev = this.chatHistory[from] ?? [];
this.chatHistory = { ...this.chatHistory, [from]: [...prev, msg] };

let entry = this.chatUsers.find((e) => e.username === from);
if (!entry) {
  const dir = this.directoryUsers.find((e) => e.username === from);
  entry = { username: from, display_name: dir?.display_name ?? from, unreadCount: 0 };
  this.chatUsers = [...this.chatUsers, entry];
}
entry.last_message = msg.message;
entry.last_message_at = msg.datetime;
const isOpen = from === this.selectedUser && !document.hidden;
if (isOpen) {
  this.scrollThreadToBottom();
} else {
  entry.unreadCount = (entry.unreadCount || 0) + 1;
}
this.refreshTabTitle();
```

(Replace the existing `chatHistory` append + `if (from === this.selectedUser) scroll` block with the above.)

- [ ] **Step 3:** In `selectUser(username)`, clear unread on open and refresh the title (add at the top, before the HTTP GET):

```typescript
const opened = this.chatUsers.find((e) => e.username === username);
if (opened) { opened.unreadCount = 0; }
this.refreshTabTitle();
```

- [ ] **Step 4:** In `ngOnDestroy`, restore the base title: `document.title = ChatComponent.BASE_TITLE;`
- [ ] **Step 5:** `npm run build` → GREEN.
- [ ] **Step 6: Commit** `feat(client): client-side unread counts, tab title, live new conversations`

---

### Task 5: Reliable send — failed state + retry

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`
- Modify: `client/src/app/chat/chat.component.html`
- Modify: `client/src/app/chat/chat.component.scss`

- [ ] **Step 1:** Extend the `Message` interface: add `status?: 'sending' | 'sent' | 'failed';`.
- [ ] **Step 2:** Refactor `sendMessage()` to mark `status` and stop deleting on error. The optimistic `msg` gets `status: 'sending'`. Replace the `.subscribe` next/error so success sets the message's status to `'sent'` (find by identity in the thread) and error sets it to `'failed'` (NOT slicing it off). Extract the POST into a private `postMessage(peer, text, msg)` so retry can reuse it:

```typescript
private postMessage(peer: string, text: string, msg: Message): void {
  this.socket.emit('send_message', { recipient: peer, message: text });
  const headers = new HttpHeaders().set('Authorization', 'Bearer ' + localStorage.getItem('access_token'));
  this.http.post<{ message: string }>('/api/dm/messages', { to_username: peer, body: text }, { headers })
    .subscribe({
      next: () => {
        msg.status = 'sent';
        if (!this.chatUsers.some((e) => e.username === peer)) {
          const fromDir = this.directoryUsers.find((e) => e.username === peer);
          this.chatUsers = [...this.chatUsers, fromDir ?? { username: peer, display_name: peer, unreadCount: 0 }];
        }
      },
      error: (err) => {
        msg.status = 'failed';
        if (err.status === 401 || err.status === 422) { this.router.navigate(['/signin']); }
      },
    });
}

retryMessage(peer: string, msg: Message): void {
  if (msg.status === 'sending') { return; }
  msg.status = 'sending';
  this.postMessage(peer, msg.message, msg);
}
```

Then `sendMessage()` builds the optimistic `msg` with `status: 'sending'`, appends it, clears the input, and calls `this.postMessage(peer, text, msg);` (drop the old `isSendingMessage`/`finalize` rollback flow; keep the `isSendingMessage` guard only to debounce the send button — set it true on send and false in both `postMessage` callbacks via a `finalize`, OR simpler: keep `isSendingMessage` toggling inside `postMessage`).

- [ ] **Step 3:** In the template, render the failed state. Inside the sent bubble block, after `message-bubble__text`, add (only when failed) and add a retry line after the bubble:

```html
<div class="message-bubble__text">{{ message.message }}</div>
@if (message.from === currentUser && message.status === 'failed') {
  <button type="button" class="message-failed" (click)="retryMessage(selectedUser, message)">
    ⚠ Couldn't send · <span class="message-failed__retry">↻ Retry</span>
  </button>
}
```

And add `[class.message-bubble--failed]="message.status === 'failed'"` to the sent `.message-bubble`.

- [ ] **Step 4:** SCSS for the failed states:

```scss
.message-bubble--failed.message-bubble--sent {
  background: rgba(162, 59, 77, 0.10);
  border-color: rgba(162, 59, 77, 0.5);
  color: $rojin-ink;
  box-shadow: none;
  .message-bubble__meta { color: rgba(162, 59, 77, 0.9); }
}
.message-failed {
  display: block; margin: 4px 2px 0; padding: 0; border: none; background: none;
  font-family: $rojin-font-body; font-size: 11.5px; color: #a23b4d; cursor: pointer; text-align: right; width: 100%;
  &__retry { font-weight: 700; border-bottom: 1px solid rgba(162, 59, 77, 0.5); }
}
```

- [ ] **Step 5:** `npm run build` → GREEN.
- [ ] **Step 6: Commit** `feat(client): reliable send — failed state with retry, no silent delete`

---

### Task 6: Typing indicator (animated dot bubble)

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`
- Modify: `client/src/app/chat/chat.component.html`
- Modify: `client/src/app/chat/chat.component.scss`

- [ ] **Step 1:** Add typing state + throttled emit + listener. Fields:

```typescript
typingFrom: string | null = null;
private typingClearTimer: any = null;
private lastTypingEmit = 0;
get isPeerTyping(): boolean { return !!this.typingFrom && this.typingFrom === this.selectedUser; }
```

`notifyTyping()` (throttled to once / 2s), called from the composer:

```typescript
notifyTyping(): void {
  if (!this.selectedUser) { return; }
  const now = Date.now();
  if (now - this.lastTypingEmit < 2000) { return; }
  this.lastTypingEmit = now;
  this.socket.emit('typing', { recipient: this.selectedUser });
}
```

- [ ] **Step 2:** In the constructor's socket setup, listen for `peer_typing`:

```typescript
this.socket.on('peer_typing', (data: any) => {
  this.zone.run(() => {
    const from = data?.from ? String(data.from) : '';
    if (!from || from !== this.selectedUser) { return; }
    this.typingFrom = from;
    if (this.typingClearTimer) { clearTimeout(this.typingClearTimer); }
    this.typingClearTimer = setTimeout(() => this.zone.run(() => (this.typingFrom = null)), 3000);
  });
});
```

In `receive_message`, clear typing when a message from that user arrives: `if (from === this.typingFrom) { this.typingFrom = null; }`. In `ngOnDestroy`, `clearTimeout(this.typingClearTimer)`.

- [ ] **Step 3:** Wire the composer to emit on input. In `chat.component.html` add `(input)="notifyTyping()"` to the `<textarea class="message-input__field" ...>`.
- [ ] **Step 4:** Render the typing bubble at the end of the thread (inside `.chat-container`, after the `@if (thread.length)` block):

```html
@if (isPeerTyping) {
  <div class="typing-bubble" aria-label="typing">
    <span></span><span></span><span></span>
  </div>
}
```

- [ ] **Step 5:** SCSS for the typing bubble:

```scss
.typing-bubble {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 5px;
  margin: 4px 0 0 2px; padding: 13px 15px;
  background: $rojin-paper; border: 1px solid $rojin-bubble-received-border;
  border-radius: $rojin-radius-md; border-bottom-left-radius: 5px;

  span { width: 7px; height: 7px; border-radius: 50%; background: $rojin-ink-soft; opacity: 0.45; }
}
@media (prefers-reduced-motion: no-preference) {
  .typing-bubble span { animation: rojin-typing 1.2s infinite; }
  .typing-bubble span:nth-child(2) { animation-delay: 0.18s; }
  .typing-bubble span:nth-child(3) { animation-delay: 0.36s; }
}
@keyframes rojin-typing {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.45; }
  30% { transform: translateY(-5px); opacity: 1; }
}
```

- [ ] **Step 6:** `npm run build` → GREEN.
- [ ] **Step 7: Commit** `feat: live typing indicator (animated dot bubble)`

---

## Final review (after Task 6)

Restart both processes; in the browser at `http://localhost:4200`, with **two accounts** (two browsers/profiles): verify unread badges + recency reorder + previews, a live new conversation appearing, the typing dot bubble, and a forced failed send (stop the backend mid-send) → Retry restoring the message. Present to the user for approval before any push.

## Self-review notes
- **Spec coverage:** list preview/sort/badge (T1–T3) ✓ client unread + tab title + live convo (T1,T4) ✓ reliable send/retry (T5) ✓ typing (T1,T6) ✓.
- **Type consistency:** `DirectoryUser` gains `last_message`/`last_message_at`/`unreadCount` (T2) used in T3/T4; `Message.status` (T5) used in T5 template; `peer_typing`/`typing` event names match backend (T1) and client (T6); `postMessage`/`retryMessage`/`notifyTyping`/`refreshTabTitle`/`isPeerTyping`/`sortedChatUsers`/`listTime` all defined once and referenced consistently.
- **No fabricated tests:** build-green + final two-account browser review per the user's waiver.
