## Real‑Time Chat App (Angular + Flask + Socket.IO)

A full‑stack real‑time chat application built with **Angular** on the frontend and **Flask + Socket.IO** on the backend. It includes **JWT authentication**, **online user presence**, real‑time direct messages, and **SQLite** persistence for chat history.

### Features

- **Auth**: Sign up / sign in with JWT
- **Realtime messaging**: Socket.IO events for instant delivery
- **Presence**: Online users list
- **Message history**: Persisted to SQLite under **direct conversations** (conversation-centric schema; see `docs/evolution.md`)
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
    chatfunc.py          # DM REST + directory + socket events
    conversations.py     # get-or-create direct Conversation by user pair
    profile.py           # JWT profile APIs
    database.py          # SQLite connection + schema (drops legacy pairwise Message if seen)
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

### Evolution (future features)

- See `docs/evolution.md` for a roadmap toward profiles, group chat, and a conversation-centric data model.

### Security

- See `docs/security.md` for the current security posture and hardening checklists (dev, organization LAN, production).

### Glossary

- See `docs/glossary.md` for short definitions of terms (JWT, CORS, Socket.IO, SPA, etc.).

### Home / LAN deployment

- See `deployment/home-deployment.md` for running the app on your Wi‑Fi (firewall, URLs, and how to stop everything safely).

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
pip install -r requirements.txt
copy .env.example .env
# Edit .env: set SECRET_KEY and JWT_SECRET_KEY for office/LAN (32+ random characters each).
python main.py
```

Backend runs on **`http://localhost:3000`** (override with **`PORT`** / **`HOST`** in `.env`).

**Environment (LAN/office):** Optional **`.env`** in `backend/` is loaded automatically if **`python-dotenv`** is installed (included in `requirements.txt`). See **`backend/.env.example`** for **`JWT_ACCESS_TOKEN_DAYS`**, **`CORS_ORIGINS`**, **`FLASK_DEBUG`**, and secrets.

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
- `GET /api/directory_users` (JWT required) — all registered usernames except you (for New Chat search)
- `GET /api/dm/messages/<other_username>` (JWT required) — DM thread with that user
- `POST /api/dm/messages` (JWT required) — JSON `{ "to_username", "body" }`
- `GET /api/me/profile`, `PATCH /api/me/profile` (JWT required)
- `GET /api/users/<username>/profile` (JWT required) — public profile card

### Screenshots

I’ll add screenshots here after pushing to GitHub:

<img width="1482" height="930" alt="Screenshot 2026-01-29 162735" src="https://github.com/user-attachments/assets/19c5ee4f-9a11-44c4-9080-144538b7f4c3" />


<img width="1490" height="965" alt="Screenshot 2026-01-29 161700" src="https://github.com/user-attachments/assets/01c3c183-a51c-482a-9d38-35f7e18cf569" />
#### I created two test accounts 'avi' and 'gri' to test the messaging.

### Notes

- This repository is configured for **local testing**. The Flask secret keys are **development-only** values.

