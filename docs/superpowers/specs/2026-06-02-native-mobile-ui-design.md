# Native-style Phone UI + Layered Client Architecture — Design

**Status:** Approved (decisions captured via brainstorm visual companion, 2026-06-02)
**Branch:** `feature/mobile-native-ui`

---

## Goal

Give phones a distinct, **premium, native-style** messaging experience — full-screen conversation list ↔ full-screen thread, a bottom tab bar, and native touch gestures — instead of today's cramped single responsive layout. At the same time, restructure the web client into **clean layers** (Transport SDK → Store → Presentation) so the backend service boundary is the durable contract. That makes a future **native iOS/Android app** straightforward: it re-implements the documented contract and behavior model, not the Angular code. The desktop two-pane experience stays, with light polish allowed.

## Decisions (from brainstorming)

- **Native-style navigation:** one full screen at a time — full-screen conversation list as home, tap → full-screen thread with a back affordance.
- **Bottom tab bar:** Chats / Calls / Profile, thumb-reachable.
- **Calls tab = polished "coming soon" placeholder now** (video calling is a separate future project; the seam exists).
- **Gestures (all four):** swipe-from-edge back, swipe-a-message to reply, pull-to-refresh the chat list, long-press a message to open its action menu.
- **Desktop:** keep the two-pane layout; light polish allowed (carry over the refined list styling/spacing for consistency).
- **Architecture:** form-factor split at the route root; desktop shell vs. a **lazy-loaded mobile module** with real child routes; a **layered client** (transport SDK + reactive store + presentation); the **backend API is unchanged** and treated as the contract.
- **Aesthetic:** the existing **Aubergine Atelier** tokens (charcoal `#241121`, plum `#4a154b`, gold `#b08d57`, ivory `#f7f2e8`, paper `#fffdf8`). Premium touches: serif headers, gradient avatars with soft shadows, hairline dividers, gold unread pills, a tactile compose button, horizontal slide transitions.

## Why layered (the native-app payoff)

A native app won't reuse Angular. What it *can* reuse is a **stable, documented service boundary** and a **clear behavior model**. So we isolate those and make the UI disposable:

1. **Transport / API SDK** — the only code that knows endpoint URLs, payload shapes, and the JWT header. This is effectively a written spec of "how to talk to the backend"; the native app re-implements the same thin SDK in Swift/Kotlin against identical, documented endpoints.
2. **State / store** — the rules (optimistic send, reaction merge, unread counting, recency sort, socket lifecycle) live here, framework-light, not scattered in components. The native app mirrors this state model.
3. **Presentation** — pure views over the store; either shell could be rebuilt natively without touching the layers below.

The backend already *is* this contract (conversation-centric REST + Socket.IO + JWT); we don't reshape it — we just keep the web client honest to it and keep `docs/system-design.md` current.

---

## Architecture

### Layer 1 — Transport / API SDK (`client/src/app/core/`)

- **`ChatApi`** (injectable, logic-thin) wraps **all** REST calls — builds the `Authorization: Bearer` header, owns endpoint URLs, returns typed responses. Methods cover the existing surface: `getConversations()`, `getDmMessages(other)`, `getGroupMessages(cid)`, `postDm(toUsername, body, clientMessageId, replyTo)`, `postGroup(cid, body, clientMessageId, replyTo)`, `markDmRead(other)`, `markGroupRead(cid)`, `react(cmid, emoji)`, `editMessage(cmid, body)`, `deleteMessage(cmid)`, `directoryUsers()`, group CRUD (`createGroup`, `getGroup`, `renameGroup`, `addMembers`, `removeMember`, `leaveGroup`), and profile `getMyProfile()` / `patchProfile()`.
- **`RealtimeClient`** (injectable) wraps Socket.IO: connects with the JWT query token, exposes **typed event streams** (`receiveMessage$`, `onlineUsers$`, `peerTyping$`, `conversationAdded$` / `conversationRemoved$` / `conversationRead$`, `reactionUpdated$`, `messageEdited$`, `messageDeleted$`) and emit helpers (`sendMessage(...)`, `typing(...)`). Owns connect/reconnect/teardown.
- **Models** (`core/models/`) — one home for `Message`, `Reaction`, `ConversationEntry` / `RawConversation` (moved from `chat/conversation.ts`), `ReadState`, `DirectoryUser`, `Profile`. No view concerns in this layer.

### Layer 2 — State / store (`client/src/app/core/chat-store.service.ts`)

- **`ChatStore`** is an app-singleton holding reactive state via **Angular signals**: `conversations`, `chatHistory` (keyed by conversation key), `readState`, `onlineUsers`, `typingFrom`, plus computed `sortedConversations` and unread totals.
- It subscribes to `RealtimeClient` streams and reduces them into state, and exposes **action methods** that today live in `ChatComponent`: `loadConversations()`, `openConversation(key)`, `sendMessage(...)`, `retry(msg)`, `toggleReaction(msg, emoji)`, `editMessage(msg, body)`, `deleteMessage(msg)`, `markRead(entry)`, `notifyTyping()`, `createGroup(...)`, member management.
- **All business rules move here**: optimistic append + rollback, the reaction merge that preserves local `mine`, `findMessage(id)` across threads, unread counting, recency sort, `client_message_id` generation/threading. The socket is created once at app start through `RealtimeClient` and **survives navigation and shell swaps** — directly resolving the CLAUDE.md "don't move the socket without handling reconnects" caveat (the store owns one connection for the app's lifetime; tears down on logout).

### Layer 3 — Presentation

- **Shared:** `MessageThreadComponent` (`<app-message-thread>`) — a presentational component that renders the message list (bubbles, day separators, sender headers, reactions, reply quote, edit, delete/tombstone, seen receipts) plus the composer affordances. Driven by `@Input` (thread, readState, currentUser, isGroup) and `@Output` (send, react, reply, edit, delete, retry, typing) wired to `ChatStore`. **Extracted from today's `chat.component.html`** so the messaging-polish UI is rendered identically by both desktop and mobile — no duplication.
- **Desktop:** `DesktopChatComponent` — today's two-pane `ChatComponent`, refactored to consume `ChatStore` and embed `<app-message-thread>`; markup largely unchanged, light polish.
- **Mobile:** **`ChatMobileModule`** (lazy-loaded), containing:
  - `MobileShellComponent` — the tab-bar layout: a `<router-outlet>` for tab content above a fixed `MobileTabBarComponent` (Chats / Calls / Profile, safe-area padded, active tab gold).
  - `MobileChatsComponent` — full-screen conversation list (Chats tab).
  - `MobileThreadComponent` — full-screen thread (embeds `<app-message-thread>`).
  - `MobileCallsComponent` — premium "coming soon" placeholder.
  - `MobileProfileComponent` — wraps/reuses the existing profile content in the shell.
  - Gesture directives (below).

### Routing (`app-routing.module.ts`)

- `''` → **`ShellRedirectComponent`**: on init and on breakpoint change it `matchMedia`-detects width and `router.navigate`s (URL-replace) to the desktop chat or `/m/chats`, preserving the open conversation key across the divide when possible.
- `'chat'` → `DesktopChatComponent`.
- `'m'` → `loadChildren` ⇒ `ChatMobileModule`, children: `chats`, `calls`, `profile`, `c/:key` (full-screen thread, pushed on top), default redirect → `chats`. `:key` is the existing conversation key (username for DMs, `conv:<id>` for groups).
- `'signin'`, `'signup'`, `'profile'` stay. **Reactive auth is preserved** (401/422 → `/signin`); the only new routing logic is form-factor detection — no auth guards added.
- Because mobile screens are **real router navigations**, the browser/hardware **back button and swipe-back map to `router` navigation/`location.back()`**, and the mobile JS **lazy-loads only on phones** (trimming the initial bundle that's currently over budget).

### Backend

**No changes.** The existing REST + Socket.IO API is the contract both shells (and a future native app) consume. `docs/system-design.md` HTTP + Socket.IO event tables are refreshed to include the message-action endpoints (`/api/messages/<id>` react/edit/delete) and events (`reaction_updated`, `message_edited`, `message_deleted`).

---

## Mobile UX detail

- **Tab bar:** fixed bottom, three tabs, safe-area inset padding, active tab in gold; switching tabs is router navigation (state preserved by `ChatStore`, no reload).
- **Chats screen:** full-screen list — serif "Chats" header with a compose action (✎), gradient avatars with soft shadow, hairline dividers, last-message preview, relative time, gold unread pill, online dot. Tap a row → `/m/c/:key`. **Pull-to-refresh** re-fetches conversations. The compose action opens the New Chat (people search) / New Group entry points (reusing existing flows + the group-create dialog).
- **Thread screen:** full-screen — header = back ‹ + avatar + name/presence + a disabled "call" icon (calling seam); body is `<app-message-thread>`; composer pinned to the bottom with safe-area padding. **Swipe from the left edge → back. Swipe a message → reply. Long-press a message → action menu.** All messaging-polish features (reactions, reply, edit/delete) work unchanged.
- **Calls screen:** premium empty state — icon, "Calls are coming soon," supporting line; visually consistent with the rest.
- **Profile screen:** the existing profile content (display name, avatar, bio, push toggle) rendered inside the mobile shell.
- **Transitions:** horizontal slide-push for the thread (forward in, back out); tab switches are instant/quick cross-fade. All respect `prefers-reduced-motion`.

## Gestures (implementation)

Small, reusable **directives** (isolation; no heavy gesture dependency — use pointer/touch events, optionally `@angular/cdk` where it fits):

- **`appSwipeBack`** on the thread screen — track a touch starting near the left edge, follow the horizontal drag with `translateX`, and on release past a threshold call `location.back()` / router back.
- **`appSwipeToReply`** on a message row — horizontal drag reveals a reply icon; release past threshold emits a reply for that message.
- **`appPullToRefresh`** on the list scroll container — top overscroll reveals a spinner; release past threshold triggers `ChatStore.loadConversations()`.
- **`appLongPress`** on a message — a press-and-hold timer opens the action menu (reusing the existing `activeMsgId` overlay path).

## Testing

- **Backend:** unchanged; the existing **42 pytest** tests already cover the API the layers consume.
- **Web client (logic):** `ChatStore` is a plain reactive class, so its reducers are unit-testable **without** the pre-existing-broken Karma scaffold — add focused plain-TS tests for the highest-value logic: reaction merge (preserve `mine`), optimistic append + rollback, `findMessage` across threads, unread counting, recency sort. `ChatApi` URL/shape correctness via `HttpTestingController` where cheap. (The scaffold specs stay excluded; the CI gate remains the production build.)
- **Manual browser verification (per CLAUDE.md):** desktop regression (must behave identically after the layer extraction) **and** the mobile flow on a narrow viewport / real device via the HTTPS harness, before each runtime-affecting commit.

## File structure (high level)

- **Core (new):** `core/chat-api.service.ts`, `core/realtime-client.service.ts`, `core/chat-store.service.ts`, `core/models/*.ts` (absorbs `chat/conversation.ts`).
- **Shared view (new):** `chat/message-thread/message-thread.component.{ts,html,scss}`.
- **Desktop:** `chat/chat.component.*` → `DesktopChatComponent` (refactored to consume the store + embed the shared thread).
- **Mobile (new, lazy):** `mobile/chat-mobile.module.ts`, `mobile/shell/`, `mobile/chats/`, `mobile/thread/`, `mobile/calls/`, `mobile/profile/`, `mobile/tab-bar/`, `mobile/gestures/{swipe-back,swipe-to-reply,pull-to-refresh,long-press}.directive.ts`.
- **Routing:** `app-routing.module.ts` (+ `ShellRedirectComponent`).
- **Docs:** `docs/system-design.md` (refresh API tables), `CLAUDE.md` (note the layered client + mobile module).

## Build sequence (for the plan)

This is one coherent project but large; sequence it so **desktop stays working throughout** and each step is independently verifiable:

1. **Extract Layer 1 (ChatApi + RealtimeClient + models)** — no behavior change; desktop still works.
2. **Extract Layer 2 (ChatStore)** and refactor `DesktopChatComponent` to consume it — desktop is the regression oracle; behavior identical.
3. **Extract `MessageThreadComponent`** and use it in desktop — identical rendering.
4. **Routing split** — `ShellRedirect` + desktop route; no mobile yet (desktop reachable, unchanged).
5. **Mobile shell + tab bar + Chats list** (lazy module).
6. **Mobile thread** (embeds the shared thread) + transitions.
7. **Gestures** (the four directives).
8. **Calls + Profile tabs**, premium polish pass.
9. **Docs** refresh.

## Risks / watch-items

- **The extraction is the bulk of the work** (lifting state out of the ~770-line `ChatComponent`). Use desktop as the behavioral oracle: after each extraction step, desktop must behave exactly as before *before* moving on.
- **Socket-in-store reconnect** — one connection for the app lifetime; reconnect on token changes, tear down on logout (the CLAUDE.md flag).
- **Resize across the breakpoint mid-session** (dev/tablet/rotation) — `ShellRedirect` swaps shells and preserves the open key; a remount is acceptable.
- **Bundle budgets** — the lazy mobile module *reduces* the desktop initial bundle; keep the `angular.json` budgets honest (we recently bumped them).
- **Scope discipline** — desktop changes stay "light polish"; don't redesign desktop here.

## Scope note

One project, one spec, one sequenced plan. The layer extraction (steps 1–3) is a prerequisite refactor; the mobile experience (steps 4–8) is the feature. Not multiple independent subsystems, so no decomposition into separate specs.
