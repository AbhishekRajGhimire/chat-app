# Home network deployment (LAN / Wi‑Fi)

This guide explains how to run the chat app so **other devices on your home Wi‑Fi** can use it (phones, tablets, other PCs). Traffic stays on your local network as long as you **do not** expose these ports on your router to the internet.

## What runs where

| Service | Port | Bind address | Role |
|--------|------|--------------|------|
| Flask + Socket.IO (backend) | **3000** | `0.0.0.0` (all interfaces) | REST API and WebSocket server |
| Angular dev server (frontend) | **4200** | `0.0.0.0` (via `npm run start`) | Web UI; proxies `/api` and `/socket.io` to `localhost:3000` on the **same PC** |

The machine where you start both processes is the **host**. Other devices only need to open the app at **`http://<host-LAN-IP>:4200`**. They should **not** browse to port `3000` directly; the dev server’s proxy handles API and Socket.IO for them.

## Prerequisites

- This repository cloned on a Windows PC (the host).
- **Python 3.10+** and a virtual environment with backend dependencies (see the main `README.md`).
- **Node.js** and `npm install` completed in `client/`.
- Host and clients on the **same LAN** (same home Wi‑Fi, or Ethernet on the same router). Some **guest networks** block device-to-device access; use the main Wi‑Fi if connections fail.

## One-time setup: Windows Firewall

The host PC must allow **inbound** TCP connections on the ports the stack uses.

### Option A: GUI (recommended for clarity)

1. Open **Windows Security** → **Firewall & network protection** → **Advanced settings** (or run `wf.msc`).
2. Select **Inbound Rules** → **New Rule…**.
3. **Rule type:** Port → **Next**.
4. **Protocol:** TCP → **Specific local ports:** `3000` → **Next**.
5. **Action:** Allow the connection → **Next**.
6. **Profile:** enable **Private** (and **Domain** if your PC uses it). Avoid **Public** unless you understand the exposure → **Next**.
7. **Name:** e.g. `Chat app – backend 3000` → **Finish**.
8. Repeat steps 2–7 for port **4200**, e.g. name `Chat app – Angular 4200`.

### Option B: PowerShell (run as Administrator)

Adjust names if you prefer:

```powershell
New-NetFirewallRule -DisplayName "Chat app – backend 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "Chat app – Angular 4200" -Direction Inbound -Protocol TCP -LocalPort 4200 -Action Allow -Profile Private
```

Ensure the Wi‑Fi network is classified as **Private** (**Settings** → **Network & Internet** → **Properties** for your Wi‑Fi).

## Find the host PC’s LAN IP address

On the **host** (PowerShell or Command Prompt):

```powershell
ipconfig
```

Under your active **Wireless LAN adapter Wi‑Fi** (or Ethernet), note **IPv4 Address** (examples: `192.168.1.50`, `10.0.0.12`). This is the address other devices will use.

## Start the application (host PC)

Use **two terminals**, both on the host. Run these from the **repository root** (the folder that contains `backend` and `client`).

### Terminal 1 – backend

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python main.py
```

If `.venv` does not exist yet, create it first (`python -m venv .venv`, then `pip install` as in the main `README.md`).

You should see the server start on port **3000**. Leave this window open.

### Terminal 2 – frontend

```powershell
cd client
npm run start
```

The `start` script runs `ng serve` with `--host 0.0.0.0` and the proxy config, so the UI is reachable from other machines on port **4200**. Leave this window open.

## Connect from another device

1. Connect the phone or PC to the **same Wi‑Fi** as the host (avoid isolated guest Wi‑Fi if possible).
2. Open a browser and go to:

   ```text
   http://<HOST_IPV4>:4200
   ```

   Example: `http://192.168.1.50:4200`

3. Use **HTTP**, not HTTPS, unless you have added TLS yourself.
4. Sign up or sign in and use the app normally.

## Keep access local (home network only)

- **Do not** configure **port forwarding** on your home router for ports 3000 or 4200 unless you intentionally want the internet to reach this dev stack (not recommended for this setup).
- Firewall rules scoped to **Private** limit exposure when you are on untrusted networks; still avoid running unnecessary services on **Public** Wi‑Fi.

## Security on a personal PC (plain language)

**There is no separate “open port” that stays dangerous after you stop the chat app.** Ports **3000** and **4200** are only used while **Python** (backend) and **Node** (Angular dev server) are running. When those processes exit, they **stop listening**; other devices on Wi‑Fi can no longer reach your chat stack through those ports.

**While the app is running**

- **Who can reach it?** Typically only devices on your **same LAN** (same router/Wi‑Fi). Your **home router does not** expose these ports to the internet unless **you** add port forwarding—so random people on the internet usually cannot connect.
- **Who on the LAN?** Anyone who knows your PC’s IP and can reach your Wi‑Fi (family, guests on the same network, a compromised device on Wi‑Fi) could open the app in a browser. This project uses **development** settings (e.g. Flask debug, fixed secrets in code); treat it as **local/hobby use**, not a hardened production service.
- **Firewall rules** you added say: “if a program on this PC is listening on 3000/4200, allow inbound on **Private** networks.” They do not by themselves run the app; **starting** the backend and frontend is what opens the listeners.

**After you stop both processes**

- Nothing from this project is accepting connections on 3000/4200 anymore, so **that exposure ends**.
- The **firewall allow rules** remain until you remove or disable them. If **nothing** is listening, those rules mostly mean “traffic would be allowed if something listened”—low practical risk on a home PC, but you can **remove or disable** them when you are done with LAN hosting (see below) if you want the tightest setup.

## How to stop the processes

### Normal shutdown (use this first)

In **each** terminal where the app is running:

1. Click the terminal window to focus it.
2. Press **Ctrl+C** once (or twice if the first interrupt is ignored).
3. Wait until the process exits and you get the prompt back.

Order does not matter, but stop both:

- **Frontend:** Ctrl+C in the `npm run start` / `ng serve` terminal.
- **Backend:** Ctrl+C in the `python main.py` terminal.

After stopping, other devices will no longer load the app until you start both again.

### If Ctrl+C does not stop the process

- Try **Ctrl+Break** on some Windows terminals.
- Close the terminal tab/window (may kill the child process depending on your terminal).
- **Task Manager:** End task for **Node.js** (frontend) or **Python** (backend) if you are sure those are your dev instances.

### Find and stop by port (PowerShell)

If something is still listening on 4200 or 3000:

```powershell
netstat -ano | findstr :4200
netstat -ano | findstr :3000
```

Note the **PID** in the last column, then:

```powershell
taskkill /PID <pid> /F
```

Use `/F` only when a normal stop failed. Replace `<pid>` with the number you saw.

## After you stop: “closing” the ports and optional firewall cleanup

### 1) Stop the servers (this is what actually closes the app ports)

Follow **[How to stop the processes](#how-to-stop-the-processes)** above. Once both **backend** and **frontend** are stopped, your PC is **no longer listening** on 3000 and 4200 for this stack. That is the main step—there is nothing extra you must do for those ports to go idle.

To double-check nothing is still listening:

```powershell
netstat -ano | findstr ":3000 "
netstat -ano | findstr ":4200 "
```

If these print nothing (or only unrelated lines), nothing is bound to those ports.

### 2) Optional: remove or disable the Windows Firewall allow rules

If you added inbound rules only for this chat app and you want them **off** until the next time you host on the LAN:

**GUI**

1. Open **Windows Security** → **Firewall & network protection** → **Advanced settings** (or `wf.msc`).
2. **Inbound Rules**.
3. Find rules you created (e.g. `Chat app – backend 3000`, `Chat app – Angular 4200`).
4. Either **Disable Rule** (toggle off, easy to turn on later) or **Delete** (remove permanently).

**PowerShell (run as Administrator)** — only if the display names match what you created:

```powershell
Remove-NetFirewallRule -DisplayName "Chat app – backend 3000"
Remove-NetFirewallRule -DisplayName "Chat app – Angular 4200"
```

If the names differ, list rules and remove by name:

```powershell
Get-NetFirewallRule -Direction Inbound | Where-Object { $_.DisplayName -like "*Chat app*" } | Remove-NetFirewallRule
```

Review the list before piping to `Remove-NetFirewallRule` if you are unsure.

Disabling or removing rules does **not** stop a running server by itself; always **stop Python and Node** first if you want the app unreachable.

## Troubleshooting

| Symptom | Things to check |
|--------|------------------|
| Other device cannot open `http://IP:4200` | Same Wi‑Fi; correct IPv4; firewall rules; host still running `npm run start`; try host browser at `http://127.0.0.1:4200` first. |
| Page loads but login/chat fails | Backend must be running on the host (`python main.py`); check Terminal 1 for errors. |
| Works on host, not on phone | Guest/isolated Wi‑Fi; wrong IP; firewall; VPN on phone splitting traffic. |
| “Invalid host header” or similar (older Angular) | This repo’s `npm run start` includes `--disable-host-check` for dev LAN use; use `npm run start` from `client/`. |

## Related documentation

- Local install and dependencies: `README.md` (repository root)
- Architecture: `docs/system-design.md`
