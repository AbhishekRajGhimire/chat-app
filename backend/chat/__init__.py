import os
from datetime import timedelta
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except ImportError:
    pass

from flask import Flask
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from flask_socketio import SocketIO

app = Flask(__name__)

# Debug defaults OFF. Enable explicitly (FLASK_DEBUG=true) for local dev only —
# the Werkzeug debugger allows code execution and leaks tracebacks if reachable.
DEBUG = os.environ.get("FLASK_DEBUG", "false").strip().lower() in (
    "1",
    "true",
    "yes",
    "on",
)


def _require_secret(env_name: str, dev_fallback: str) -> str:
    """Return the secret from the environment.

    A known fallback is allowed only in debug (dev) mode. When debug is off we
    refuse to start rather than silently sign tokens/sessions with a secret that
    is committed to the repo — that would let anyone forge a JWT for any user.
    """
    value = os.environ.get(env_name)
    if value:
        return value
    if DEBUG:
        return dev_fallback
    raise RuntimeError(
        f"{env_name} must be set when FLASK_DEBUG is off. "
        f"Add a long random value (32+ bytes) to backend/.env."
    )


app.config["SECRET_KEY"] = _require_secret("SECRET_KEY", "dev-secret-key-change-me")
app.config["JWT_SECRET_KEY"] = _require_secret(
    "JWT_SECRET_KEY",
    "dev-jwt-secret-key-change-me-please-use-at-least-32-characters",
)

# Default 7 days for LAN/office; set JWT_ACCESS_TOKEN_DAYS=0 to disable expiry (dev only).
_jwt_days_raw = os.environ.get("JWT_ACCESS_TOKEN_DAYS", "7").strip().lower()
if _jwt_days_raw in ("0", "false", "no", "never"):
    app.config["JWT_ACCESS_TOKEN_EXPIRES"] = False
else:
    try:
        days = int(_jwt_days_raw)
    except ValueError:
        days = 7
    app.config["JWT_ACCESS_TOKEN_EXPIRES"] = timedelta(days=max(1, days))

app.config["CORS_SUPPORTS_CREDENTIALS"] = True

_cors = os.environ.get("CORS_ORIGINS", "").strip()
if _cors:
    _cors_list = [o.strip() for o in _cors.split(",") if o.strip()]
    CORS(app, supports_credentials=True, origins=_cors_list)
    _socket_cors = _cors_list
else:
    CORS(app, supports_credentials=True)
    _socket_cors = "*"

socketio = SocketIO(app, cors_allowed_origins=_socket_cors)

online_users = []

jwt = JWTManager(app)

from chat import user
from chat import chatfunc
from chat import profile
from chat import groups
from chat import database
