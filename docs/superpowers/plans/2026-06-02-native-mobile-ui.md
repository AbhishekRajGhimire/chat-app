# Native-style Phone UI + Layered Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Angular client into clean layers (transport SDK → reactive store → presentation) and add a distinct, premium, native-style phone UI (lazy mobile module, bottom tab bar Chats/Calls/People, full-screen list↔thread, four touch gestures), leaving the desktop two-pane intact.

**Architecture:** `ChatApi` (REST) + `RealtimeClient` (Socket.IO) own all backend I/O; `ChatStore` (Angular signals) owns all state + business rules + the socket lifecycle; desktop and a lazy `ChatMobileModule` are pure views over the store, sharing one presentational `MessageThreadComponent`. Form-factor routing at the root sends phones to `/m/...` and desktops to `/chat`.

**Tech Stack:** Angular 21 (NgModules, webpack `browser` builder), Angular signals, `socket.io-client`, Material MDC/M3, Atelier SCSS tokens. Backend (Flask + Socket.IO) is **unchanged**.

---

## Verification model (read first)

Per `CLAUDE.md`: the **frontend CI gate is `npm run build`** (full AOT type + template check), **not** `npm test` (the Karma scaffold specs are pre-existing-broken). So:

- **Every frontend task ends with `cd client; npm run build` → must exit 0.** That is the "tests pass" step for this plan.
- **Runtime/UI changes require manual browser verification before commit** (no Playwright). Phase boundaries have explicit browser checkpoints; the implementer must start both processes (`python main.py`, `npm run start`), tell the user exactly what to exercise, and **wait for approval before committing** the UI-affecting tasks. Use Chrome DevTools device toolbar (e.g. iPhone 12 / 390×844) for the mobile screens, and full-width for desktop regression.
- **Backend regression only:** after the whole plan, run `cd backend; pytest -q` (expect 42 passed) to confirm nothing server-side drifted. The plan changes no backend code.
- The desktop UI is the **regression oracle** for the extraction phases (1–3): after each, desktop must behave **identically** to before.

`crypto.randomUUID()` is available (localhost/HTTPS secure context); keep the existing fallback.

---

## Shared interfaces (defined once — keep these signatures consistent across all tasks)

**Models** (`client/src/app/core/models/`):

```typescript
// message.model.ts
export interface Reaction { emoji: string; count: number; mine: boolean; }
export interface Message {
  id?: string;
  from: string;
  to: string;
  message: string;
  datetime: any;
  status?: 'sending' | 'sent' | 'failed';
  reactions?: Reaction[];
  replyTo?: string | null;
  replyPreview?: string | null;
  editedAt?: string | null;
  deleted?: boolean;
}
export interface ReadRow { username: string; last_read_at: string | null; }
```

`ConversationEntry`, `RawConversation`, `toEntry` move verbatim from `client/src/app/chat/conversation.ts` into `core/models/conversation.model.ts`. `DirectoryUser` is re-exported from there too (currently in `profile.service.ts`).

**`ChatApi`** (`core/chat-api.service.ts`) — every method returns an `Observable`, builds the Bearer header internally:

```typescript
getConversations(): Observable<RawConversation[]>
getDmMessages(other: string): Observable<{ messages: any[]; read_state: ReadRow[] }>
getGroupMessages(cid: number): Observable<{ messages: any[]; read_state: ReadRow[] }>
postDm(toUsername: string, body: string, clientMessageId: string, replyTo: string | null): Observable<any>
postGroup(cid: number, body: string, clientMessageId: string, replyTo: string | null): Observable<any>
markDmRead(other: string): Observable<any>
markGroupRead(cid: number): Observable<any>
react(cmid: string, emoji: string): Observable<{ reactions: Reaction[] }>
editMessage(cmid: string, body: string): Observable<{ body: string; edited_at: string }>
deleteMessage(cmid: string): Observable<any>
directoryUsers(): Observable<DirectoryUser[]>
createGroup(title: string, members: string[]): Observable<any>
getGroup(cid: number): Observable<any>
addMembers(cid: number, members: string[]): Observable<any>
removeMember(cid: number, username: string): Observable<any>
leaveGroup(cid: number): Observable<any>
```

**`RealtimeClient`** (`core/realtime-client.service.ts`) — exposes RxJS `Subject` streams + emit helpers:

```typescript
connect(token: string): void           // idempotent; builds the socket once
disconnect(): void
receiveMessage$: Subject<any>
onlineUsers$: Subject<any[]>
peerTyping$: Subject<any>
conversationAdded$: Subject<any>
conversationRemoved$: Subject<any>
conversationRead$: Subject<any>
reactionUpdated$: Subject<any>
messageEdited$: Subject<any>
messageDeleted$: Subject<any>
emitSend(payload: any): void
emitTyping(payload: any): void
```

**`ChatStore`** (`core/chat-store.service.ts`) — signals + actions:

```typescript
readonly conversations = signal<ConversationEntry[]>([]);
readonly chatHistory = signal<Record<string, Message[]>>({});
readonly readState = signal<Record<string, Record<string, string | null>>>({});
readonly onlineUsers = signal<any[]>([]);
readonly typingFrom = signal<string | null>(null);
readonly selectedKey = signal<string>('');
readonly currentUser: string;                       // from localStorage
readonly sortedConversations = computed(() => ...);  // recency sort, self pinned
readonly unreadTotal = computed(() => ...);

init(): void                  // connect socket, wire streams, loadConversations
loadConversations(): void
openConversation(entry: ConversationEntry): void     // sets selectedKey, fetches history, markRead
sendMessage(entry: ConversationEntry, text: string, replyingTo: Message | null): void
retry(entry: ConversationEntry, msg: Message): void
toggleReaction(msg: Message, emoji: string): void
editMessage(msg: Message, body: string): void
deleteMessage(msg: Message): void
markRead(entry: ConversationEntry): void
notifyTyping(entry: ConversationEntry): void
ensureDirectEntry(username: string): ConversationEntry  // find-or-create local DM entry
createGroup(title: string, members: string[]): Observable<any>
isOnline(username: string): boolean
```

These are the canonical names; later tasks reference them exactly.

---

## File structure

| File | Responsibility |
|------|----------------|
| `core/models/message.model.ts` | `Message`, `Reaction`, `ReadRow` |
| `core/models/conversation.model.ts` | `ConversationEntry`, `RawConversation`, `toEntry`, `DirectoryUser` |
| `core/chat-api.service.ts` | All REST calls (the SDK/contract) |
| `core/realtime-client.service.ts` | Socket.IO wrapper, typed streams |
| `core/chat-store.service.ts` | Reactive state + business rules + socket lifecycle |
| `chat/message-thread/message-thread.component.*` | Shared presentational thread (bubbles, reactions, reply, edit/delete, composer) |
| `chat/chat.component.*` → `DesktopChatComponent` | Desktop two-pane shell over the store |
| `app-routing.module.ts` + `shell-redirect/` | Form-factor routing |
| `mobile/chat-mobile.module.ts` | Lazy mobile module |
| `mobile/shell/` | Tab-bar layout + top app bar |
| `mobile/tab-bar/` | Bottom tab bar (Chats/Calls/People) |
| `mobile/chats/` | Conversation list (Chats tab) |
| `mobile/thread/` | Full-screen thread (embeds message-thread) |
| `mobile/people/` | Org directory (People tab) |
| `mobile/calls/` | "Coming soon" placeholder |
| `mobile/profile/` | Own profile (pushed from top-bar avatar) |
| `mobile/gestures/*.directive.ts` | swipe-back, swipe-to-reply, pull-to-refresh, long-press |

---

## Phase 1 — Transport layer (ChatApi + RealtimeClient + models)

No behavior change; nothing is wired in yet. Goal: the SDK compiles and is injectable.

### Task 1.1: Models module

**Files:**
- Create: `client/src/app/core/models/message.model.ts`, `client/src/app/core/models/conversation.model.ts`

- [ ] **Step 1: Create `message.model.ts`** with the `Reaction`, `Message`, `ReadRow` interfaces exactly as in "Shared interfaces" above.

- [ ] **Step 2: Create `conversation.model.ts`** by moving the entire contents of `client/src/app/chat/conversation.ts` (the `ConversationEntry`, `RawConversation`, `toEntry`) into it, and add:

```typescript
export interface DirectoryUser { username: string; display_name: string; }
```

- [ ] **Step 3: Re-point `conversation.ts` to re-export** (keeps existing imports working during the migration). Replace the contents of `client/src/app/chat/conversation.ts` with:

```typescript
export * from '../core/models/conversation.model';
```

- [ ] **Step 4: Build.** Run `cd client; npm run build` → exit 0.

- [ ] **Step 5: Commit.**
```bash
git add client/src/app/core/models client/src/app/chat/conversation.ts
git commit -m "refactor(client): extract shared models (message, conversation)"
```

### Task 1.2: ChatApi service

**Files:**
- Create: `client/src/app/core/chat-api.service.ts`

- [ ] **Step 1: Write `ChatApi`** implementing every signature in "Shared interfaces". Centralize the header (copied from the existing `authHeaders()` in `chat.component.ts`):

```typescript
import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { RawConversation, DirectoryUser } from './models/conversation.model';
import { Reaction, ReadRow } from './models/message.model';

@Injectable({ providedIn: 'root' })
export class ChatApi {
  constructor(private http: HttpClient) {}

  private headers(): HttpHeaders {
    return new HttpHeaders().set('Authorization', 'Bearer ' + localStorage.getItem('access_token'));
  }

  getConversations(): Observable<RawConversation[]> {
    return this.http.get<RawConversation[]>('/api/chats_history', { headers: this.headers() });
  }
  getDmMessages(other: string): Observable<{ messages: any[]; read_state: ReadRow[] }> {
    return this.http.get<any>(`/api/dm/messages/${encodeURIComponent(other)}`, { headers: this.headers() });
  }
  getGroupMessages(cid: number): Observable<{ messages: any[]; read_state: ReadRow[] }> {
    return this.http.get<any>(`/api/groups/${cid}/messages`, { headers: this.headers() });
  }
  postDm(toUsername: string, body: string, clientMessageId: string, replyTo: string | null): Observable<any> {
    return this.http.post<any>('/api/dm/messages',
      { to_username: toUsername, body, client_message_id: clientMessageId, reply_to: replyTo },
      { headers: this.headers() });
  }
  postGroup(cid: number, body: string, clientMessageId: string, replyTo: string | null): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/messages`,
      { body, client_message_id: clientMessageId, reply_to: replyTo }, { headers: this.headers() });
  }
  markDmRead(other: string): Observable<any> {
    return this.http.post<any>(`/api/dm/${encodeURIComponent(other)}/read`, {}, { headers: this.headers() });
  }
  markGroupRead(cid: number): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/read`, {}, { headers: this.headers() });
  }
  react(cmid: string, emoji: string): Observable<{ reactions: Reaction[] }> {
    return this.http.post<any>(`/api/messages/${cmid}/react`, { emoji }, { headers: this.headers() });
  }
  editMessage(cmid: string, body: string): Observable<{ body: string; edited_at: string }> {
    return this.http.patch<any>(`/api/messages/${cmid}`, { body }, { headers: this.headers() });
  }
  deleteMessage(cmid: string): Observable<any> {
    return this.http.delete<any>(`/api/messages/${cmid}`, { headers: this.headers() });
  }
  directoryUsers(): Observable<DirectoryUser[]> {
    return this.http.get<DirectoryUser[]>('/api/directory_users', { headers: this.headers() });
  }
  createGroup(title: string, members: string[]): Observable<any> {
    return this.http.post<any>('/api/groups', { title, members }, { headers: this.headers() });
  }
  getGroup(cid: number): Observable<any> {
    return this.http.get<any>(`/api/groups/${cid}`, { headers: this.headers() });
  }
  addMembers(cid: number, members: string[]): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/members`, { members }, { headers: this.headers() });
  }
  removeMember(cid: number, username: string): Observable<any> {
    return this.http.delete<any>(`/api/groups/${cid}/members/${encodeURIComponent(username)}`, { headers: this.headers() });
  }
  leaveGroup(cid: number): Observable<any> {
    return this.http.post<any>(`/api/groups/${cid}/leave`, {}, { headers: this.headers() });
  }
}
```

- [ ] **Step 2: Build** → exit 0.
- [ ] **Step 3: Commit.**
```bash
git add client/src/app/core/chat-api.service.ts
git commit -m "feat(client): ChatApi transport SDK (all REST endpoints)"
```

### Task 1.3: RealtimeClient service

**Files:**
- Create: `client/src/app/core/realtime-client.service.ts`

- [ ] **Step 1: Write `RealtimeClient`** — wrap `socket.io-client` and re-emit each server event onto a `Subject`. Connection is idempotent.

```typescript
import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { io } from 'socket.io-client';

@Injectable({ providedIn: 'root' })
export class RealtimeClient {
  private socket: any = null;

  readonly receiveMessage$ = new Subject<any>();
  readonly onlineUsers$ = new Subject<any[]>();
  readonly peerTyping$ = new Subject<any>();
  readonly conversationAdded$ = new Subject<any>();
  readonly conversationRemoved$ = new Subject<any>();
  readonly conversationRead$ = new Subject<any>();
  readonly reactionUpdated$ = new Subject<any>();
  readonly messageEdited$ = new Subject<any>();
  readonly messageDeleted$ = new Subject<any>();

  connect(token: string): void {
    if (this.socket) return;
    this.socket = io({ query: { token } });
    this.socket.on('receive_message', (d: any) => this.receiveMessage$.next(d));
    this.socket.on('online_users', (d: any) => this.onlineUsers$.next(Array.isArray(d) ? d : []));
    this.socket.on('peer_typing', (d: any) => this.peerTyping$.next(d));
    this.socket.on('conversation_added', (d: any) => this.conversationAdded$.next(d));
    this.socket.on('conversation_removed', (d: any) => this.conversationRemoved$.next(d));
    this.socket.on('conversation_read', (d: any) => this.conversationRead$.next(d));
    this.socket.on('reaction_updated', (d: any) => this.reactionUpdated$.next(d));
    this.socket.on('message_edited', (d: any) => this.messageEdited$.next(d));
    this.socket.on('message_deleted', (d: any) => this.messageDeleted$.next(d));
    this.socket.connect();
  }

  disconnect(): void {
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
  }

  emitSend(payload: any): void { this.socket?.emit('send_message', payload); }
  emitTyping(payload: any): void { this.socket?.emit('typing', payload); }
}
```

- [ ] **Step 2: Build** → exit 0.
- [ ] **Step 3: Commit.**
```bash
git add client/src/app/core/realtime-client.service.ts
git commit -m "feat(client): RealtimeClient socket wrapper with typed streams"
```

---

## Phase 2 — State layer (ChatStore) + desktop consumes it

The biggest task: move all state + logic out of `ChatComponent` into `ChatStore`, then make the desktop component a thin view. **Desktop must behave identically afterward.**

### Task 2.1: ChatStore with state, socket wiring, and all actions

**Files:**
- Create: `client/src/app/core/chat-store.service.ts`

The store reproduces the logic currently in `chat.component.ts`. Port these methods, changing `this.X` (component fields) to `this.X()` / `this.X.set(...)` (signals) and HTTP calls to `ChatApi`, socket emits to `RealtimeClient`:

| From `chat.component.ts` | Into `ChatStore` |
|--------------------------|------------------|
| `loadConversations()` | `loadConversations()` — `chatApi.getConversations()` → `conversations.set(data.map(toEntry))` |
| `selectConversation()` | `openConversation(entry)` — set `selectedKey`, fetch history via `chatApi`, `chatHistory.update(...)`, `applyReadState`, `markRead` |
| `sendMessage()` + `postMessage()` | `sendMessage(entry, text, replyingTo)` — generate `id` (`newId()`), optimistic append, `realtime.emitSend(...)`, `chatApi.postDm/postGroup(...)`, status reconcile/rollback |
| `retryMessage()` | `retry(entry, msg)` |
| `onReceive()` | private stream handler on `realtime.receiveMessage$` |
| `onPeerTyping()` / `notifyTyping()` | `notifyTyping(entry)` + stream handler on `peerTyping$` |
| `onConversationRemoved/Read` | stream handlers |
| `toggleReaction/onReactionUpdated/mergeReactions/findMessage` | same names |
| `editMessage/deleteMessage/onMessageEdited/onMessageDeleted` | `editMessage(msg, body)`, `deleteMessage(msg)`, stream handlers |
| `toMessage/newId` | private helpers |
| `markRead/applyReadState` | `markRead(entry)`, private `applyReadState` |
| `sortedConversations` getter | `sortedConversations` computed |
| `refreshTabTitle` | keep in the desktop component (document.title is a view concern) — expose `unreadTotal` computed instead |

- [ ] **Step 1: Write the store skeleton** (signals from "Shared interfaces") with `currentUser = localStorage.getItem('username') || ''`, inject `ChatApi` and `RealtimeClient`, and an `init()` that connects the socket and subscribes every stream to its handler:

```typescript
init(): void {
  this.realtime.connect(localStorage.getItem('access_token') || '');
  this.realtime.receiveMessage$.subscribe((d) => this.onReceive(d));
  this.realtime.onlineUsers$.subscribe((u) => this.onlineUsers.set(u));
  this.realtime.peerTyping$.subscribe((d) => this.onPeerTyping(d));
  this.realtime.conversationAdded$.subscribe(() => this.loadConversations());
  this.realtime.conversationRemoved$.subscribe((d) => this.onConversationRemoved(d));
  this.realtime.conversationRead$.subscribe((d) => this.onConversationRead(d));
  this.realtime.reactionUpdated$.subscribe((d) => this.onReactionUpdated(d));
  this.realtime.messageEdited$.subscribe((d) => this.onMessageEdited(d));
  this.realtime.messageDeleted$.subscribe((d) => this.onMessageDeleted(d));
  this.loadConversations();
}
```

- [ ] **Step 2: Port the data/action methods** per the table above. The signal idioms: read with `this.chatHistory()`, write immutably with `this.chatHistory.update(h => ({ ...h, [key]: next }))`. Example for the reaction handler (preserve `mine` locally — unchanged rule):

```typescript
private onReactionUpdated(d: any): void {
  const msg = this.findMessage(d?.client_message_id);
  if (!msg) return;
  msg.reactions = this.mergeReactions(d?.reactions ?? [], msg.reactions);
  this.chatHistory.update(h => ({ ...h }));   // nudge change detection
}
private findMessage(id: string | null | undefined): Message | null {
  if (!id) return null;
  const h = this.chatHistory();
  for (const key of Object.keys(h)) {
    const hit = h[key].find(m => m.id === id);
    if (hit) return hit;
  }
  return null;
}
```

`sendMessage` keeps the exact dual-write (emit + POST) and `client_message_id`/`reply_to` threading from the current `postMessage`. `ensureDirectEntry(username)` is the `selectDirect` find-or-create logic minus navigation.

- [ ] **Step 3: Add `createGroup`, `isOnline`, `markRead`, `notifyTyping`** (ports of the existing component methods, using `chatApi`/`realtime`).

- [ ] **Step 4: Build** → exit 0 (store compiles even though not yet consumed).

- [ ] **Step 5: Commit.**
```bash
git add client/src/app/core/chat-store.service.ts
git commit -m "feat(client): ChatStore — reactive state, rules, and socket lifecycle"
```

### Task 2.2: Desktop component consumes the store

**Files:**
- Modify: `client/src/app/chat/chat.component.ts`, `client/src/app/chat/chat.component.html`

- [ ] **Step 1: Gut the component's logic.** In `chat.component.ts`, remove the ported state fields, HTTP calls, socket setup, and the methods now living in the store. Inject `ChatStore` (public, so the template can read its signals) plus `Router`, `MatDialog`, `ProfileService`. Keep **view-only** concerns: `compactToolbar`/`applyViewportPlaceholders`, `refreshTabTitle` (driven by `store.unreadTotal()`), the members panel, `replyingTo`/`editingId`/`editText`/overlay state (these are view state — but since the thread is about to be extracted in Phase 3, keep them for now). Call `store.init()` in the constructor. Delegate: `sendMessage()` → `store.sendMessage(this.store.selectedEntry(), this.newMessage, this.replyingTo)` etc.

```typescript
constructor(public store: ChatStore, private router: Router,
            private profileService: ProfileService, private dialog: MatDialog, private zone: NgZone) {
  this.store.init();
  // ...toolbar label via profileService (unchanged)
}
```

- [ ] **Step 2: Rebind the template.** In `chat.component.html`, replace component-field reads with store signal reads: `conversations` → `store.sortedConversations()`, `chatHistory[selectedKey]` → `store.openThread()` (add a `openThread` computed to the store returning `chatHistory()[selectedKey()] ?? []`), `onlineUsers`/`isUserOnline` → `store.isOnline(...)`, `selectedKey` → `store.selectedKey()`, action handlers → `store.*`. Keep the markup otherwise identical.

- [ ] **Step 3: Build** → exit 0.

- [ ] **Step 4: Browser checkpoint (desktop regression).** Start both processes. Ask the user to verify at full width that DMs + groups still: load, send (optimistic + persist), receive live, react/reply/edit/delete, show typing + unread + seen, create groups, manage members. **Wait for approval.**

- [ ] **Step 5: Commit (after approval).**
```bash
git add client/src/app/chat/chat.component.ts client/src/app/chat/chat.component.html
git commit -m "refactor(client): desktop chat consumes ChatStore (no behavior change)"
```

---

## Phase 3 — Shared MessageThreadComponent

Extract the message list + composer markup so mobile reuses it verbatim.

### Task 3.1: Create the presentational thread component

**Files:**
- Create: `client/src/app/chat/message-thread/message-thread.component.{ts,html,scss}`

- [ ] **Step 1: Define the component API.** Inputs/outputs cover everything the thread needs; the host (desktop or mobile) passes store data in and forwards events to the store.

```typescript
@Component({ selector: 'app-message-thread', standalone: false, /* templateUrl, styleUrls */ })
export class MessageThreadComponent {
  @Input() thread: Message[] = [];
  @Input() readState: Record<string, string | null> = {};
  @Input() currentUser = '';
  @Input() isGroup = false;
  @Output() react = new EventEmitter<{ msg: Message; emoji: string }>();
  @Output() reply = new EventEmitter<Message>();
  @Output() edit = new EventEmitter<{ msg: Message; body: string }>();
  @Output() remove = new EventEmitter<Message>();
  @Output() retry = new EventEmitter<Message>();
  @Output() scrollToOriginal = new EventEmitter<string>();
  // grouping/date helpers (toDate, formatMessageTime, daySeparatorLabel, shouldShowDaySeparator,
  // isContinuation, isGroupEnd, showSenderHeader, senderColor, readersOf), and the overlay/edit
  // view-state (activeMsgId, menuOpenId, pickerOpenId, editingId, editText, quickReactions,
  // emojiPicker) all MOVE here from chat.component.
}
```

- [ ] **Step 2: Move the markup.** Cut the message-list block (`@let thread … the day-separator/sender-head/message-row/.message-cluster/reaction-pills/seen-row …`) and the typing bubble from `chat.component.html` into `message-thread.component.html`. Replace internal calls: reactions/edit/delete now `this.react.emit({msg,emoji})` etc. Keep the composer in the **host** (desktop/mobile differ there) — the thread component renders messages + typing only. Move the corresponding SCSS (message-row/bubble/cluster/reactions/reply-quote/edit/tombstone/flash + the grouping styles) into `message-thread.component.scss`, importing the tokens (`@use '../../ui/styles/tokens' as *;` or matching the existing `@import`).

- [ ] **Step 3: Declare it** in `app.module.ts` (or the relevant declarations array) and the future mobile module.

- [ ] **Step 4: Use it in desktop.** In `chat.component.html`, replace the moved block with:

```html
<app-message-thread
  [thread]="store.openThread()" [readState]="store.readState()[store.selectedKey()] || {}"
  [currentUser]="store.currentUser" [isGroup]="isGroupOpen"
  (react)="store.toggleReaction($event.msg, $event.emoji)"
  (reply)="replyingTo = $event"
  (edit)="store.editMessage($event.msg, $event.body)"
  (remove)="store.deleteMessage($event)"
  (retry)="store.retry(store.selectedEntry()!, $event)"
  (scrollToOriginal)="scrollToMessage($event)">
</app-message-thread>
```

- [ ] **Step 5: Build** → exit 0.

- [ ] **Step 6: Browser checkpoint (desktop thread identical).** Verify the thread renders + all message actions work exactly as before. **Wait for approval.**

- [ ] **Step 7: Commit (after approval).**
```bash
git add client/src/app/chat/message-thread client/src/app/chat/chat.component.* client/src/app/app.module.ts
git commit -m "refactor(client): extract shared <app-message-thread>"
```

---

## Phase 4 — Form-factor routing

### Task 4.1: ShellRedirect + routes + lazy mobile entry

**Files:**
- Create: `client/src/app/shell-redirect/shell-redirect.component.ts`
- Modify: `client/src/app/app-routing.module.ts`

- [ ] **Step 1: Create `ShellRedirectComponent`** — detects width and replaces the URL, and re-redirects on breakpoint change:

```typescript
@Component({ selector: 'app-shell-redirect', template: '', standalone: false })
export class ShellRedirectComponent implements OnInit, OnDestroy {
  private mq = window.matchMedia('(max-width: 768px)');
  private handler = () => this.go();
  constructor(private router: Router) {}
  ngOnInit() { this.go(); this.mq.addEventListener('change', this.handler); }
  ngOnDestroy() { this.mq.removeEventListener('change', this.handler); }
  private go() { this.router.navigate([this.mq.matches ? '/m/chats' : '/chat'], { replaceUrl: true }); }
}
```

- [ ] **Step 2: Wire routes.** In `app-routing.module.ts`:

```typescript
const routes: Routes = [
  { path: '', component: ShellRedirectComponent, pathMatch: 'full' },
  { path: 'chat', component: ChatComponent },
  { path: 'm', loadChildren: () => import('./mobile/chat-mobile.module').then(m => m.ChatMobileModule) },
  { path: 'signin', component: SigninComponent },
  { path: 'signup', component: SignupComponent },
  { path: 'profile', component: ProfileComponent },
];
```

(The `mobile/chat-mobile.module.ts` is created in Phase 5; until then, temporarily stub the import or do Phase 5 Task 5.1 first. Implementer note: **do Task 5.1 before building this step**, or comment the `m` route and uncomment after 5.1.)

- [ ] **Step 3: Declare `ShellRedirectComponent`** in `app.module.ts`.

- [ ] **Step 4: Build** → exit 0 (after 5.1 exists). Browser: loading `/` on a wide window lands on `/chat` (desktop unchanged).

- [ ] **Step 5: Commit.**
```bash
git add client/src/app/shell-redirect client/src/app/app-routing.module.ts client/src/app/app.module.ts
git commit -m "feat(client): form-factor routing — redirect by viewport, lazy /m"
```

---

## Phase 5 — Mobile shell, tab bar, Chats list

### Task 5.1: Lazy module + shell + tab bar + child routes

**Files:**
- Create: `client/src/app/mobile/chat-mobile.module.ts`, `mobile/shell/mobile-shell.component.{ts,html,scss}`, `mobile/tab-bar/mobile-tab-bar.component.{ts,html,scss}`

- [ ] **Step 1: Module + routes.** `ChatMobileModule` declares the shell, tab bar, and (as they're built) the screen components, imports `CommonModule`, `RouterModule.forChild(...)`, `FormsModule`, `MatIconModule`, and the shared `MessageThreadComponent` (export it from a shared module or declare in both — use a tiny `SharedChatModule` that declares+exports `MessageThreadComponent` and `AvatarComponent`, imported by both `AppModule` and `ChatMobileModule`).

```typescript
const routes: Routes = [{
  path: '', component: MobileShellComponent,
  children: [
    { path: 'chats', component: MobileChatsComponent },
    { path: 'calls', component: MobileCallsComponent },
    { path: 'people', component: MobilePeopleComponent },
    { path: 'profile', component: MobileProfileComponent },
    { path: 'c/:key', component: MobileThreadComponent },
    { path: '', redirectTo: 'chats', pathMatch: 'full' },
  ],
}];
```

(Create empty placeholder components for screens not yet built so the module compiles; flesh them out in later tasks.)

- [ ] **Step 2: Shell** — `MobileShellComponent` calls `store.init()` once, renders the top app bar (serif title slot + avatar→`/m/profile`), a `<router-outlet>`, and the bottom `<app-mobile-tab-bar>`. Hide the tab bar on the thread route (`c/:key`) so the thread is truly full-screen — derive from the router URL. Apply safe-area insets (`env(safe-area-inset-bottom)`).

- [ ] **Step 3: Tab bar** — three `routerLink`s (`/m/chats`, `/m/calls`, `/m/people`) with `routerLinkActive="on"`, Material icons (`chat_bubble`, `call`, `group`), labels, gold active color from tokens.

- [ ] **Step 4: Build** → exit 0.

- [ ] **Step 5: Commit.**
```bash
git add client/src/app/mobile
git commit -m "feat(client/mobile): lazy module, shell, bottom tab bar"
```

### Task 5.2: Chats list screen

**Files:**
- Create: `client/src/app/mobile/chats/mobile-chats.component.{ts,html,scss}`

- [ ] **Step 1: Component** reads `store.sortedConversations()`, `store.isOnline()`, `store.unreadTotal()`. A row tap navigates `this.router.navigate(['/m/c', entry.key])` (encode the key). A compose button opens the existing `GroupCreateDialogComponent` (reuse) for New Group.

- [ ] **Step 2: Template + premium SCSS** — serif "Chats" header with the user avatar on the right (`routerLink="/m/profile"`), gradient `app-avatar`s, hairline dividers, last-message preview, relative time (`store`/local helper), gold unread pill, online dot, a floating compose FAB. Use Atelier tokens; full-screen scroll list.

- [ ] **Step 3: Build** → exit 0.

- [ ] **Step 4: Browser checkpoint (mobile list).** DevTools device toolbar (390×844). Verify: `/` redirects to `/m/chats`; list shows conversations with avatars/previews/unread/online; tab bar switches; avatar → profile route (blank for now is fine). **Wait for approval.**

- [ ] **Step 5: Commit (after approval).**
```bash
git add client/src/app/mobile/chats
git commit -m "feat(client/mobile): Chats list screen"
```

---

## Phase 6 — Mobile thread

### Task 6.1: Full-screen thread screen + slide transition

**Files:**
- Create: `client/src/app/mobile/thread/mobile-thread.component.{ts,html,scss}`

- [ ] **Step 1: Component** reads the `:key` route param, calls `store.openConversation(entry)` for that key (resolve the entry via `store` — find in `conversations()` or `ensureDirectEntry` for a username key), and renders: a header (back button → `location.back()`, avatar, name/presence, disabled call icon), `<app-message-thread [thread]="store.openThread()" …>` wired to the store exactly as desktop does, and a composer (textarea + send, reply chip when `replyingTo` set) pinned to the bottom with safe-area padding. Reuse the desktop composer markup.

- [ ] **Step 2: Slide transition** — add an Angular route animation (or a CSS `@keyframes` slide-in on host) for entering `c/:key`; respect `prefers-reduced-motion`. Keep it simple (transform translateX).

- [ ] **Step 3: Build** → exit 0.

- [ ] **Step 4: Browser checkpoint (mobile thread).** Open a chat from the list → full-screen thread (no tab bar); send a message (optimistic + live), react, reply, edit, delete; back button returns to the list. Try a group too. **Wait for approval.**

- [ ] **Step 5: Commit (after approval).**
```bash
git add client/src/app/mobile/thread
git commit -m "feat(client/mobile): full-screen thread + slide transition"
```

---

## Phase 7 — People, Profile, Calls screens

### Task 7.1: People (org directory)

**Files:**
- Create: `client/src/app/mobile/people/mobile-people.component.{ts,html,scss}`

- [ ] **Step 1: Component** calls `chatApi.directoryUsers()` on init, holds a search string + filtered list (port `applyNewChatFilter` logic). Tapping a person: `store.openConversation(store.ensureDirectEntry(username))` then `router.navigate(['/m/c', username])`.
- [ ] **Step 2: Template + SCSS** — search field, full-screen list of members (gradient avatar, display name, `@username`, online dot), Atelier styling, premium empty/no-match states.
- [ ] **Step 3: Build** → exit 0.
- [ ] **Step 4: Commit.**
```bash
git add client/src/app/mobile/people
git commit -m "feat(client/mobile): People org directory screen"
```

### Task 7.2: Profile (pushed) + Calls (placeholder)

**Files:**
- Create: `client/src/app/mobile/profile/mobile-profile.component.{ts,html,scss}`, `client/src/app/mobile/calls/mobile-calls.component.{ts,html,scss}`

- [ ] **Step 1: Profile** — a pushed screen (back button → `location.back()`) rendering the existing profile content (display name, avatar, bio, push toggle) via `ProfileService`; reuse `ProfileComponent`'s form logic (extract a shared helper or call the same service). Mobile-styled.
- [ ] **Step 2: Calls** — a centered premium empty state: `call` icon in a soft gold badge, "Calls are coming soon", a supporting line. Pure presentational.
- [ ] **Step 3: Build** → exit 0.
- [ ] **Step 4: Browser checkpoint.** People → tap a person opens a DM; top-bar avatar → Profile (edit + back); Calls tab shows the placeholder. **Wait for approval.**
- [ ] **Step 5: Commit (after approval).**
```bash
git add client/src/app/mobile/profile client/src/app/mobile/calls
git commit -m "feat(client/mobile): Profile (pushed) + Calls placeholder"
```

---

## Phase 8 — Gestures

Each gesture is a small reusable directive in `client/src/app/mobile/gestures/`. Use native `pointer`/`touch` events; no new dependency. Declare them in `ChatMobileModule`.

### Task 8.1: Swipe-back

**Files:** Create `mobile/gestures/swipe-back.directive.ts`

- [ ] **Step 1:** `appSwipeBack` — on `touchstart` within ~24px of the left edge, track `touchmove` deltaX, translate the host, and on `touchend` past ~80px (or velocity) emit `(swipeBack)`; otherwise snap back. Host (thread) binds `(swipeBack)="goBack()"`.
- [ ] **Step 2: Build** → exit 0. **Step 3: Commit** `feat(client/mobile): swipe-back gesture`.

### Task 8.2: Swipe-to-reply

**Files:** Create `mobile/gestures/swipe-to-reply.directive.ts`

- [ ] **Step 1:** `appSwipeToReply` on a message row — horizontal drag reveals a reply icon, release past threshold emits `(swipeReply)`. Wire in `message-thread.component.html` per row → `reply.emit(message)`. Cap the translate; ignore vertical-dominant drags (scroll).
- [ ] **Step 2: Build** → exit 0. **Step 3: Commit** `feat(client/mobile): swipe-to-reply gesture`.

### Task 8.3: Pull-to-refresh

**Files:** Create `mobile/gestures/pull-to-refresh.directive.ts`

- [ ] **Step 1:** `appPullToRefresh` on the Chats list scroll container — when `scrollTop===0` and the user drags down past a threshold, reveal a spinner and emit `(refresh)`; host binds `(refresh)="store.loadConversations()"`. Reset after a short delay.
- [ ] **Step 2: Build** → exit 0. **Step 3: Commit** `feat(client/mobile): pull-to-refresh gesture`.

### Task 8.4: Long-press menu

**Files:** Create `mobile/gestures/long-press.directive.ts`

- [ ] **Step 1:** `appLongPress` — start a ~450ms timer on `touchstart`, cancel on move/`touchend`; on fire emit `(longPress)`. In `message-thread.component.html` bind it on the bubble → open the action overlay (set `activeMsgId`). Keep tap behavior intact.
- [ ] **Step 2: Build** → exit 0.
- [ ] **Step 3: Browser checkpoint (device, via HTTPS harness ideally).** Verify all four gestures on a touch device or DevTools touch emulation: edge-swipe back, swipe a message to reply, pull the list to refresh, long-press to open the menu. **Wait for approval.**
- [ ] **Step 4: Commit (after approval).**
```bash
git add client/src/app/mobile/gestures client/src/app/chat/message-thread
git commit -m "feat(client/mobile): long-press menu gesture"
```

---

## Phase 9 — Docs + final verification

### Task 9.1: Documentation

**Files:** Modify `docs/system-design.md`, `CLAUDE.md`, `docs/evolution.md`

- [ ] **Step 1:** In `docs/system-design.md`, refresh the HTTP + Socket.IO tables to include `/api/messages/<id>` (react/PATCH/DELETE) and the `reaction_updated`/`message_edited`/`message_deleted` events, and add a short "Client architecture" subsection describing the three layers + form-factor routing + lazy mobile module.
- [ ] **Step 2:** In `CLAUDE.md`, add a "Client layering (core/ → shells)" note: `ChatApi`/`RealtimeClient`/`ChatStore` own I/O+state, components are pure views, the socket lives in `ChatStore` for the app lifetime, desktop is `/chat` and phones are the lazy `/m` module, `<app-message-thread>` is shared. Note the form-factor redirect.
- [ ] **Step 3:** In `docs/evolution.md`, mark the native mobile UI delivered with a one-paragraph summary.
- [ ] **Step 4: Commit.**
```bash
git add docs/system-design.md CLAUDE.md docs/evolution.md
git commit -m "docs: client layering + native mobile UI"
```

### Task 9.2: Final review

- [ ] **Step 1:** `cd client; npm run build` → exit 0 (note bundle sizes; mobile chunk should be lazy/separate).
- [ ] **Step 2:** `cd backend; pytest -q` → 42 passed (no server drift).
- [ ] **Step 3:** Final browser pass — desktop at full width (unchanged) and the full mobile flow at phone width — then a final code review and `superpowers:finishing-a-development-branch`.

---

## Self-review (plan vs spec)

- **Layered client** → Phases 1 (ChatApi+RealtimeClient+models), 2 (ChatStore). ✓
- **Desktop unchanged + light polish** → Phase 2/3 keep markup identical; polish is optional within those. ✓
- **Shared MessageThread** → Phase 3. ✓
- **Form-factor routing + lazy mobile** → Phase 4 + 5.1. ✓
- **Tab bar Chats/Calls/People, Profile in top bar** → 5.1 (shell+tabbar), 7 (People/Profile/Calls). ✓
- **Full-screen list↔thread** → 5.2 + 6.1. ✓
- **Four gestures** → Phase 8 (8.1–8.4). ✓
- **Backend unchanged; docs refreshed** → Phase 9. ✓
- **Type consistency:** the "Shared interfaces" block fixes one canonical set of names (`ChatApi`, `RealtimeClient`, `ChatStore`, signal names, `openThread`, `ensureDirectEntry`, `MessageThreadComponent` I/O) referenced identically by every task. ✓
- **Verification:** build + browser per CLAUDE.md (frontend has no working unit runner); backend regression at the end. Called out up front. ✓
- **Ordering caveat fixed:** Task 4.1 notes the `/m` lazy import needs 5.1's module to exist — do 5.1 first or stub. ✓
