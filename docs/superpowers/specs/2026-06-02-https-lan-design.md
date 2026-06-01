# HTTPS on the LAN (Caddy + mkcert) — Design

**Status:** Approved (decisions captured 2026-06-02)
**Phase:** Phase 5 — between PWA shell (3a) and Web Push (3b); unblocks both phone PWA install and (later) Web Push.
**Branch target:** new branch off `main`

---

## Goal

Serve the **built** Angular PWA over locally-trusted **TLS** on the LAN, proxying `/api` and `/socket.io` to Flask, so the service worker registers and Rojin installs on a phone at **`https://Avi.local`**. This is an **opt-in testing harness** — it sits beside the normal `ng serve` dev workflow and changes no app code.

## Decisions (from brainstorming)

- **Name:** `Avi.local` (the PC's mDNS hostname — resolves on phones with zero DNS config).
- **Stack:** **Caddy** reverse proxy + **mkcert** locally-trusted certificate.
- **Deliverables in `deployment/`**: a `Caddyfile`, a `serve-https.ps1` runner, and an `https-deployment.md` guide (incl. trusting the CA on Android/iOS).
- **Reversible:** stop Caddy + disable the 443 firewall rule → back to plain feature dev, no residue. Normal dev (`ng serve` :4200 http, `python main.py` :3000) is untouched.

## Non-goals / YAGNI

- No public-internet exposure, no real domain / Let's Encrypt.
- No change to app code, the SPA, the dev proxy (`proxy.conf.json`), or backend routes.
- No `rojin.local` / router-DNS setup (chose `Avi.local`).
- No automated provisioning of the phone's CA trust (manual, documented).
- No production process manager / service install (run on demand).

## Architecture

```
Phone (same Wi-Fi) ──https──> Caddy :443 (Avi.local)
                                 ├── /api/*  /socket.io/*  ──> Flask :3000 (http, localhost)  [WS auto-upgraded]
                                 └── everything else        ──> client/dist/client (built SPA, try_files → index.html)
```
- **Same origin** behind Caddy (app + API share `https://Avi.local`) → **no CORS change needed**.
- Caddy terminates TLS with the mkcert cert (no ACME). Flask keeps running plain HTTP on `localhost:3000`.

## Deliverables

### `deployment/Caddyfile`
```
Avi.local, localhost {
	tls deployment/certs/avi.local.pem deployment/certs/avi.local-key.pem

	# API + realtime → Flask (Caddy auto-upgrades WebSockets)
	@backend path /api/* /socket.io/*
	reverse_proxy @backend localhost:3000

	# Built SPA + deep-link fallback
	root * client/dist/client
	try_files {path} /index.html
	file_server
	encode gzip
}
```
(Run from repo root so the relative paths resolve.)

### `deployment/serve-https.ps1`
Builds the client, ensures the mkcert cert exists, runs Caddy:
```powershell
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$certDir = Join-Path $root "deployment\certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$cert = Join-Path $certDir "avi.local.pem"
$key  = Join-Path $certDir "avi.local-key.pem"
if (-not (Test-Path $cert)) {
  Write-Host "Generating mkcert certificate (first run)..."
  mkcert -install
  mkcert -cert-file $cert -key-file $key Avi.local localhost 127.0.0.1
}
Write-Host "Building client (production)..."
Push-Location (Join-Path $root "client"); npm run build; Pop-Location
Write-Host "Serving https://Avi.local  (Ctrl+C to stop)"
Set-Location $root
caddy run --config (Join-Path $root "deployment\Caddyfile")
```

### `deployment/certs/` (gitignored)
mkcert outputs the cert + **private key** here — never committed. Add `deployment/certs/` to `.gitignore`.

### `deployment/https-deployment.md`
- Prereqs: install tools — `winget install FiloSottile.mkcert` and `winget install CaddyServer.Caddy` (winget is available).
- One-time: run `serve-https.ps1` from an **Administrator** PowerShell (mkcert `-install` needs admin to add the CA to the system store; the 443 firewall rule needs admin).
- Firewall: `New-NetFirewallRule -DisplayName "Rojin HTTPS 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private`.
- Run the backend separately (`python main.py` on :3000).
- **Trust the CA on the phone** (the one manual step): find it via `mkcert -CAROOT` → `rootCA.pem`; transfer to phone.
  - **Android:** Settings → Security → "Install a certificate" → CA certificate → pick `rootCA.pem`.
  - **iOS:** install the `rootCA.pem` profile, then Settings → General → About → Certificate Trust Settings → enable full trust for the mkcert root.
- Open `https://Avi.local` on the phone (same Wi-Fi) → install the PWA.
- Teardown: Ctrl+C Caddy; optionally disable the firewall rule and `mkcert -uninstall`.

## Docs to update

- `CLAUDE.md`: note the optional HTTPS harness (`deployment/serve-https.ps1`, prod-build + Caddy + mkcert at `https://Avi.local`), and that it's separate from `ng serve`.
- `docs/evolution.md`: mark internal-HTTPS delivered for the PWA/push use case.

## Verification

Host-side (I can do these):
- After install + cert gen + build + `caddy run`: `Invoke-WebRequest https://localhost/` → 200 with a **valid** cert (host trusts the mkcert CA).
- `https://localhost/ngsw-worker.js` and `/manifest.webmanifest` served over TLS.
- An `/api/...` request through Caddy reaches Flask (401/422 when unauthenticated, i.e., it hit the route — not a 404).
- In Chrome at `https://localhost`, the service worker registers (prod build + secure context) and the app is installable.

Phone-side (user, manual): trust the CA, open `https://Avi.local`, install.

## Risks / watch-items

- **Admin needed** for first-time `mkcert -install` and the firewall rule.
- **Port 443 free:** if something else holds 443, change the Caddyfile to `Avi.local:8443` (URL becomes `https://Avi.local:8443`).
- **mDNS `.local`** resolves on iOS + most Android; a few Android builds are flaky — fallback is `https://<LAN-IP>` (the cert includes `127.0.0.1`/`localhost`; add the LAN IP as a SAN if IP access is wanted — note the IP can change).
- **Backend must be running** (`python main.py`) for `/api` + sockets; Caddy only proxies.
- **Private key hygiene:** `deployment/certs/` gitignored so the key never lands in the repo.
- Caddy serves the **built** app → rebuild to see changes (expected; this path is for PWA/phone testing, not live dev).
