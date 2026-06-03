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


import io as _io


def test_upload_returns_metadata_and_kind(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/attachments",
                    data={"file": (_io.BytesIO(b"\x89PNG..."), "pic.png", "image/png")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 201
    body = r.get_json()
    assert body["filename"] == "pic.png" and body["mime"] == "image/png"
    assert body["kind"] == "image" and body["size"] > 0 and isinstance(body["id"], int)


def test_upload_non_image_is_file_kind(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/attachments",
                    data={"file": (_io.BytesIO(b"%PDF-1.5"), "doc.pdf", "application/pdf")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.get_json()["kind"] == "file"


def test_group_send_links_attachment_and_serializes(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"img"), "p.png", "image/png")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    r = client.post(f"/api/groups/{cid}/messages",
                    json={"body": "", "client_message_id": "g-att", "attachment_ids": [up["id"]]},
                    headers=alice["headers"])
    assert r.status_code == 201
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    m = next(x for x in msgs if x["id"] == "g-att")
    assert [a["id"] for a in m["attachments"]] == [up["id"]]


def test_dm_send_allows_empty_body_with_attachment(client, make_user):
    alice = make_user("alice"); make_user("bob")
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"img"), "p.png", "image/png")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    r = client.post("/api/dm/messages",
                    json={"to_username": "bob", "body": "", "client_message_id": "d-att",
                          "attachment_ids": [up["id"]]}, headers=alice["headers"])
    assert r.status_code == 201
    msgs = client.get("/api/dm/messages/bob", headers=alice["headers"]).get_json()["messages"]
    assert any(x["id"] == "d-att" and len(x["attachments"]) == 1 for x in msgs)


def test_serve_member_gets_bytes_and_disposition(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"PNGDATA"), "p.png", "image/png")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    client.post(f"/api/groups/{cid}/messages",
                json={"body": "", "client_message_id": "att-msg", "attachment_ids": [up["id"]]},
                headers=alice["headers"])
    token = bob["headers"]["Authorization"].split()[1]
    r = client.get(f"/api/attachments/{up['id']}?token={token}")
    assert r.status_code == 200 and r.data == b"PNGDATA"
    assert "inline" in r.headers.get("Content-Disposition", "")


def test_serve_non_member_forbidden(client, make_user):
    alice = make_user("alice"); make_user("bob"); carol = make_user("carol")
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    up = client.post("/api/attachments",
                     data={"file": (_io.BytesIO(b"x"), "d.pdf", "application/pdf")},
                     content_type="multipart/form-data", headers=alice["headers"]).get_json()
    client.post(f"/api/groups/{cid}/messages",
                json={"body": "", "client_message_id": "att-2", "attachment_ids": [up["id"]]},
                headers=alice["headers"])
    token = carol["headers"]["Authorization"].split()[1]
    r = client.get(f"/api/attachments/{up['id']}?token={token}")
    assert r.status_code == 403


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
