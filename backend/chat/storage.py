"""Local-disk attachment storage. The ONLY module that touches file bytes —
swap this for S3/MinIO in a multi-server deploy without changing callers."""
import os
import uuid
from pathlib import Path

_UPLOAD_DIR = Path(
    os.environ.get("CHAT_UPLOAD_DIR", Path(__file__).resolve().parent.parent / "uploads")
)


def _ensure_dir() -> None:
    _UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def save(file_storage) -> tuple[str, int]:
    """Persist an uploaded Werkzeug FileStorage under a server-generated key
    (never the client filename → no path traversal). Returns (key, size)."""
    _ensure_dir()
    ext = os.path.splitext(file_storage.filename or "")[1][:12]
    key = uuid.uuid4().hex + ext
    dest = _UPLOAD_DIR / key
    file_storage.save(str(dest))
    return key, dest.stat().st_size


def open_path(storage_key: str) -> str:
    return str(_UPLOAD_DIR / storage_key)


def delete(storage_key: str) -> None:
    try:
        (_UPLOAD_DIR / storage_key).unlink()
    except OSError:
        # Covers FileNotFoundError and Windows file-locking (PermissionError/WinError 32).
        pass
