## System design (high level)

### Architecture diagram

```mermaid
flowchart LR
  U[User in browser] -->|Loads SPA| A[Angular app<br/>:4200]

  A <-->|REST JSON<br/>/api/*| B[Flask API<br/>:3000]
  A <-->|Socket.IO<br/>/socket.io/*| S[Flask-SocketIO<br/>:3000]

  subgraph Backend[Backend (Python)]
    B
    S
    M[(SQLite<br/>chat.db)]
    P[In-memory presence<br/>online_users[]]
  end

  B -->|Create/verify JWT| J[JWT (access_token)]
  A -->|Stores token| LS[localStorage<br/>access_token + username]
  LS -->|Authorization: Bearer ...| B

  B -->|Read/write users/messages| M
  S -->|Broadcast online users| A
  S -->|Emit receive_message<br/>to recipient socket| A
  B --> P
  S --> P

  A -.dev only.->|Angular proxy forwards to :3000| PX[proxy.conf.json]
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

