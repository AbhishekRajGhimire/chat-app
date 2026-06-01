# Opt-in HTTPS harness for phone / PWA testing.
# Run from an Administrator PowerShell the FIRST time (mkcert -install + the
# 443 firewall rule need admin). The backend must already be running:
#   cd backend; .\.venv\Scripts\Activate.ps1; python main.py     # on :3000
# Prereqs: mkcert + caddy installed (see deployment/https-tls.md).
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$certDir = Join-Path $root "deployment\certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$cert = Join-Path $certDir "avi.local.pem"
$key  = Join-Path $certDir "avi.local-key.pem"

if (-not (Test-Path $cert)) {
  Write-Host "Generating mkcert certificate (first run; needs admin for -install)..."
  mkcert -install
  mkcert -cert-file $cert -key-file $key Avi.local localhost 127.0.0.1
}

Write-Host "Building client (production)..."
Push-Location (Join-Path $root "client"); npm run build; Pop-Location

Write-Host "Serving https://Avi.local  (Ctrl+C to stop)"
Set-Location $root
caddy run --config (Join-Path $root "deployment\Caddyfile")
