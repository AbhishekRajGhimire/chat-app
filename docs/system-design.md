## System design (high level)

### Architecture diagram

```mermaid
flowchart LR
  U[User in browser] -->|Loads SPA| A[Angular app<br/>:4200]

  subgraph FE[Frontend]
    A
    LS[(localStorage<br/>access_token + username)]
    PX[Angular dev proxy<br/>proxy.conf.json]
  end

  subgraph BE[Backend (Python)]
    API[Flask API<br/>:3000]
    WS[Flask-SocketIO<br/>:3000]
    DB[(SQLite<br/>chat.db)]
    PRES[In-memory presence<br/>online_users[]]
  end

  A <-->|REST JSON<br/>/api/*| API
  A <-->|Socket.IO<br/>/socket.io/*| WS

  A -->|Stores token| LS
  LS -->|Authorization: Bearer ...| API

  API -->|Read/write users/messages| DB
  API --> PRES
  WS --> PRES

  WS -->|Broadcast online users| A
  WS -->|Emit receive_message<br/>to recipient socket| A

  A -.dev only.-> PX
  PX -->|Forwards to :3000| API
  PX -->|Forwards to :3000| WS
```

### What happens when…

- **User signs up**
  - Angular sends `POST /api/signup` with `{ username, password }`
  - Flask hashes password and stores the user in SQLite

- **User signs in**
  - Angular sends `POST /api/signin`
  - Flask verifies password and returns a JWT `access_token`
  - Angular stores `access_token` and `username` in `localStorage`

- **Chat screen loads**
  - Angular calls `GET /api/chats_history` with `Authorization: Bearer <token>`
  - Flask returns a list of users you’ve chatted with
  - Angular opens a Socket.IO connection for realtime presence + messages

- **User sends a message**
  - **Realtime delivery**: Angular emits `send_message` to Socket.IO; backend emits `receive_message` to the recipient socket
  - **Persistence**: Angular calls `POST /api/post_messages/...` so the message is stored in SQLite

### Key files (where to explain from)

- **Frontend**
  - `client/src/app/chat/chat.component.ts` (Socket.IO + chat logic)
  - `client/src/app/auth.service.ts` (REST API calls)
  - `client/src/proxy.conf.json` (local dev proxy)

- **Backend**
  - `backend/main.py` (server entrypoint)
  - `backend/chat/__init__.py` (app + SocketIO + JWT setup)
  - `backend/chat/user.py` (auth endpoints)
  - `backend/chat/chatfunc.py` (chat endpoints + socket events)
  - `backend/chat/database.py` (SQLite schema)

