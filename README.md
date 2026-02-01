## Real‑Time Chat App (Angular + Flask + Socket.IO)

A full‑stack real‑time chat application built with **Angular** on the frontend and **Flask + Socket.IO** on the backend. It includes **JWT authentication**, **online user presence**, real‑time direct messages, and **SQLite** persistence for chat history.

### Features

- **Auth**: Sign up / sign in with JWT
- **Realtime messaging**: Socket.IO events for instant delivery
- **Presence**: Online users list
- **Message history**: Persisted to SQLite and retrievable per user pair
- **Simple UI**: Angular Material components for a clean chat experience

### Tech stack

- **Frontend**: Angular (TypeScript), Angular Material, `socket.io-client`
- **Backend**: Python, Flask, Flask‑SocketIO, Flask‑JWT‑Extended, Flask‑Bcrypt, Flask‑CORS
- **Database**: SQLite

### Project structure

```
backend/
  main.py                # starts Flask-SocketIO server
  chat/
    __init__.py          # Flask app + SocketIO + JWT setup
    user.py              # auth routes: signup/signin/signout
    chatfunc.py          # chat routes + socket events
    database.py          # SQLite connection + schema
client/
  src/
    app/
      signin/            # login UI
      signup/            # registration UI
      chat/              # chat UI + Socket.IO client
      auth.service.ts    # HTTP API calls
    proxy.conf.json      # dev proxy for /api and /socket.io
```

### System design

- See `docs/system-design.md` for a high-level architecture diagram and request flows.

### Local setup (Windows / PowerShell)

#### Prerequisites

- **Python 3.10+**
- **Node.js** (Angular 13 works best with Node 14/16)

#### 1) Run the backend

From repo root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install flask flask-socketio flask-jwt-extended flask-bcrypt flask-cors eventlet
python main.py
```

Backend runs on **`http://localhost:3000`**.

#### 2) Run the frontend

In a second terminal from repo root:

```powershell
cd client
npm install
npm run start
```

Frontend runs on **`http://localhost:4200`** and proxies:
- `/api/*` → `http://localhost:3000`
- `/socket.io/*` → `http://localhost:3000` (WebSocket)

### API endpoints (backend)

- `POST /api/signup`
- `POST /api/signin`
- `POST /api/signout` (JWT required)
- `GET /api/chats_history` (JWT required)
- `GET /api/message_history/<user1>/&/<user2>`
- `POST /api/post_messages/<recipient>/&/<sender>/&/<message>`

### Screenshots

I’ll add screenshots here after pushing to GitHub:

<img width="1482" height="930" alt="Screenshot 2026-01-29 162735" src="https://github.com/user-attachments/assets/19c5ee4f-9a11-44c4-9080-144538b7f4c3" />


<img width="1490" height="965" alt="Screenshot 2026-01-29 161700" src="https://github.com/user-attachments/assets/01c3c183-a51c-482a-9d38-35f7e18cf569" />
#### I created two test accounts 'avi' and 'gri' to test the messaging.

### Notes

- This repository is configured for **local testing**. The Flask secret keys are **development-only** values.

