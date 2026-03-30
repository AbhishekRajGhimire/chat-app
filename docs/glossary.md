# Glossary — terms used in this project

Short definitions of concepts you’ll see in **Rojin**, the **README**, and **`system-design.md`** / **`security.md`**. This is a learning reference, not a formal spec.

---

## A

**Angular**  
A TypeScript framework for building **SPAs**. This repo’s UI (chat, sign-in, sign-up) lives under `client/src/app/`.

**API (HTTP API)**  
Endpoints the backend exposes over HTTP (e.g. `POST /api/signin`). The client calls them with **`fetch`** or Angular **`HttpClient`**.

---

## B

**Bearer token**  
A scheme for sending a **JWT** in an HTTP header: `Authorization: Bearer <token>`. The server reads the header and verifies the token.

**bcrypt**  
A slow, salted password-hashing algorithm. The backend stores **hashes**, not plain passwords (`backend/chat/user.py`).

---

## C

**Client**  
The browser (or app) running the **Angular** frontend. Opposite of **server** (Flask).

**CORS (Cross-Origin Resource Sharing)**  
Rules the **browser** enforces: which **origins** (scheme + host + port) may call your API with JavaScript and read the response. The server answers with headers like `Access-Control-Allow-Origin`. **CORS is not login**—you still use **JWT** (or similar) for identity. This project uses **Flask-CORS**; in dev, the **proxy** often makes `/api` look same-origin to the browser.

**Credentials (CORS)**  
Whether cookies or `Authorization` headers are allowed on cross-origin requests. Flask is configured with `CORS_SUPPORTS_CREDENTIALS` in `backend/chat/__init__.py`.

---

## D

**Dev server**  
`ng serve` for Angular (e.g. port **4200**). Not the same as a production web server.

---

## E

**Emit (Socket.IO)**  
Send an event from server to client(s) or client to server. Example: server **`emit('receive_message', …)`** to a **room**.

---

## F

**Flask**  
Python **web framework** handling HTTP routes in this project (`backend/chat/`).

**Flask-SocketIO**  
Adds **Socket.IO** to Flask so one process can serve both REST and realtime events (`backend/chat/__init__.py`, `chatfunc.py`).

---

## H

**HTTP**  
The request/response protocol used for **REST** APIs (`GET`, `POST`, …).

**HTTPS**  
HTTP over **TLS** (encrypted). Important in production so **JWT** and message bodies are not readable on the wire.

---

## J

**JSON**  
Text format for APIs: `{ "username": "...", "password": "..." }`.

**JWT (JSON Web Token)**  
A signed token the server issues after login. The client stores it (here: **`localStorage`**) and sends it as a **Bearer** token. The server verifies the signature with **`JWT_SECRET_KEY`**. See `security.md` for expiry and hardening.

---

## L

**localStorage**  
Browser key-value storage that persists across tabs/restarts (until cleared). This app keeps **`access_token`** and **`username`** there.

---

## O

**Origin**  
`https://example.com:443` (scheme + host + port). **Same-origin** means the page and API share that triple; otherwise the browser may apply **CORS** rules.

---

## P

**Presence**  
Who is “online” right now. Here: in-memory **`online_users`** plus Socket.IO **`join_user`** / **`disconnect`**.

**Proxy (dev proxy)**  
`client/src/proxy.conf.json` forwards `/api` and `/socket.io` from the Angular dev server to **:3000** so the browser talks to one port during development.

---

## R

**REST**  
Style of **HTTP API** using verbs and resources (e.g. `GET /api/chats_history`). Not every endpoint here is “pure REST,” but the idea is the same.

**Room (Socket.IO)**  
A named channel; **`emit(..., room=username)`** delivers only to sockets that **`join_room(username)`**. Used for DMs in this app.

---

## S

**Server**  
The **Flask + Socket.IO** process (typically **`python main.py`** on port **3000**).

**Socket.IO**  
Library on top of **WebSockets** (with fallbacks) for realtime events: **`connect`**, **`join_user`**, **`send_message`**, **`receive_message`**.

**SPA (Single Page Application)**  
One loaded HTML shell; **Angular** swaps views and talks to the API without full page reloads for each screen.

**SQLite**  
File-based embedded **SQL** database (`chat.db`). Good for demos; scaling often moves to PostgreSQL/MySQL.

---

## T

**TLS**  
Encryption layer used by **HTTPS**.

**Token**  
Here, usually the **JWT** string returned from **`/api/signin`**.

---

## W

**WebSocket**  
Long-lived, two-way connection for low-latency messages. **Socket.IO** builds on this (with extra features).

---

## Related docs

- **How pieces fit together**: [`system-design.md`](./system-design.md)  
- **Future direction (profiles, groups)**: [`evolution.md`](./evolution.md)  
- **Risks and hardening**: [`security.md`](./security.md)  
- **Run on home Wi‑Fi**: [`../deployment/home-deployment.md`](../deployment/home-deployment.md)
