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

app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-key-change-me")
app.config["JWT_SECRET_KEY"] = os.environ.get(
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
from chat import database
