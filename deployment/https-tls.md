# LAN HTTPS for phone / PWA testing (Caddy + mkcert)

An **opt-in** testing harness that serves the **built** Rojin PWA over locally-trusted
TLS at **`https://Avi.local`**, proxying `/api` and `/socket.io` to Flask. This is what
lets the **service worker register** and the app **install on your phone** (a service
worker needs a *trusted* secure context — plain HTTP on the LAN won't do).

It is **separate from normal development.** Day-to-day you still use `npm run start`
(`ng serve` on `:4200`, HTTP) — see [`home-deployment.md`](./home-deployment.md). Use
this only when you want to test the real PWA on a phone. Tearing it down (Ctrl+C Caddy,
disable the firewall rule) leaves no residue.

## What runs where

| Service | Port | Role |
|--------|------|------|
| Flask + Socket.IO (backend) | **3000** | API + WebSocket (plain HTTP, localhost) |
| Caddy (reverse proxy) | **443** | Terminates TLS (mkcert), serves `client/dist/client`, proxies `/api` + `/socket.io` → `:3000` |

Phone → `https://Avi.local` (Caddy) → static SPA + proxied API/sockets. Same origin, so
no CORS change is needed. `Avi.local` is this PC's mDNS hostname and resolves on the LAN
with no DNS setup.

## One-time setup

### 1. Install the tools (winget)
```powershell
winget install --silent --accept-source-agreements --accept-package-agreements FiloSottile.mkcert
winget install --silent CaddyServer.Caddy
```
Open a new terminal afterwards so `mkcert` and `caddy` are on `PATH`. Verify with
`mkcert -help` and `caddy version`.

### 2. Allow port 443 through the firewall (Administrator)
```powershell
New-NetFirewallRule -DisplayName "Rojin HTTPS 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private
```
Make sure your Wi-Fi network is classified **Private**.

## Run it

Two terminals on this PC:

**Terminal 1 — backend** (as usual):
```powershell
cd backend
.\.venv\Scripts\Activate.ps1
python main.py
```

**Terminal 2 — HTTPS harness** (Administrator the **first** time, for `mkcert -install`):
```powershell
.\deployment\serve-https.ps1
```
The script generates the cert on first run, builds the client, and starts Caddy. Leave it
running. On this PC, browse `https://localhost` to confirm it works (valid padlock).

## Trust the CA on the phone (one-time, required)

The phone must trust mkcert's local CA, or the browser won't register the service worker.

1. On the PC, find the CA: `mkcert -CAROOT` → the folder holds **`rootCA.pem`**. Transfer it
   to the phone (email / USB / a download).
2. **Android:** Settings → Security (→ Encryption & credentials) → **Install a certificate** →
   **CA certificate** → pick `rootCA.pem` → accept the warning.
3. **iOS:** open `rootCA.pem` → install the **profile** (Settings → Profile Downloaded) →
   then Settings → General → About → **Certificate Trust Settings** → enable **full trust**
   for the mkcert root.
4. Phone on the **same Wi-Fi** → open **`https://Avi.local`** → use it; the browser menu
   now offers **Add to Home Screen / Install**.

## Tear down

- **Ctrl+C** the Caddy terminal — nothing listens on 443 anymore.
- Optional: remove the firewall rule
  `Remove-NetFirewallRule -DisplayName "Rojin HTTPS 443"` and `mkcert -uninstall`.
- Back to plain dev (`npm run start`) with no leftover state.

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| Port 443 already in use | Edit `deployment/Caddyfile` site line to `Avi.local:8443, localhost:8443` and browse `https://Avi.local:8443`. |
| `Avi.local` won't resolve on the phone | Some Android builds have flaky mDNS — browse the **LAN IP** instead (re-issue the cert adding the IP as a SAN), or add a router DNS entry. |
| Browser still warns "not secure" | The phone hasn't trusted `rootCA.pem` (step above), or (iOS) full trust isn't enabled. |
| Login / messages fail | Backend isn't running on `:3000` (Terminal 1). |
| `mkcert -install` fails | Run the harness from an **Administrator** PowerShell the first time. |

## Why this unblocks more than install

A trusted secure context is also a hard requirement for **Web Push** (the next feature).
Once this harness works, push notifications can be built on top of the same setup.
