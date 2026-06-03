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


from chat.conversations import attachments_for, link_attachments, serialize_messages
from chat.database import connection


def _seed_group_with_attachment(cmid="am-1"):
    cursor.execute("INSERT INTO User (username, password) VALUES ('ann', 'x')"); ann = cursor.lastrowid
    cursor.execute("INSERT INTO User (username, password) VALUES ('bo', 'x')"); bo = cursor.lastrowid
    cursor.execute("INSERT INTO Conversation (type, title, created_at, created_by_user_id) "
                   "VALUES ('group', 'G', datetime('now'), ?)", (ann,)); cid = cursor.lastrowid
    for uid in (ann, bo):
        cursor.execute("INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at) "
                       "VALUES (?, ?, 'member', datetime('now'))", (cid, uid))
    cursor.execute("INSERT INTO Message (conversation_id, sender_user_id, body, created_at, client_message_id) "
                   "VALUES (?, ?, '', datetime('now'), ?)", (cid, ann, cmid))
    cursor.execute("INSERT INTO MessageAttachment (uploader_user_id, storage_key, filename, mime, size, kind, created_at) "
                   "VALUES (?, 'k1', 'a.png', 'image/png', 12, 'image', datetime('now'))", (ann,))
    aid = cursor.lastrowid
    connection.commit()
    return cid, ann, bo, aid


def test_link_attachments_owner_only():
    cid, ann, bo, aid = _seed_group_with_attachment()
    link_attachments("am-1", cid, [aid], bo)            # bo did NOT upload it → ignored
    assert attachments_for("am-1") == []
    link_attachments("am-1", cid, [aid], ann)           # owner links it
    got = attachments_for("am-1")
    assert got == [{"id": aid, "filename": "a.png", "mime": "image/png", "size": 12, "kind": "image"}]


def test_serialize_messages_includes_attachments():
    cid, ann, bo, aid = _seed_group_with_attachment(cmid="am-2")
    link_attachments("am-2", cid, [aid], ann)
    msgs = {m["id"]: m for m in serialize_messages(cid, ann)}
    assert msgs["am-2"]["attachments"] == [{"id": aid, "filename": "a.png", "mime": "image/png", "size": 12, "kind": "image"}]
