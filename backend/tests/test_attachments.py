import io
from werkzeug.datastructures import FileStorage

from chat import storage
from chat.database import cursor


def test_storage_save_and_read_roundtrip():
    fs = FileStorage(stream=io.BytesIO(b"hello-bytes"), filename="note.txt", content_type="text/plain")
    key, size = storage.save(fs)
    assert key and size == len(b"hello-bytes")
    with open(storage.open_path(key), "rb") as fh:
        assert fh.read() == b"hello-bytes"
    storage.delete(key)


def test_message_attachment_table_exists():
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='MessageAttachment'")
    assert cursor.fetchone() is not None
    cursor.execute("PRAGMA table_info(MessageAttachment)")
    cols = {r[1] for r in cursor.fetchall()}
    assert {"client_message_id", "conversation_id", "uploader_user_id", "storage_key",
            "filename", "mime", "size", "kind", "created_at"} <= cols
