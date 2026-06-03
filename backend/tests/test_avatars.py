import io as _io

from chat.database import cursor
from chat.profile import _avatar_path


def test_userprofile_has_avatar_columns():
    cursor.execute("PRAGMA table_info(UserProfile)")
    cols = {r[1] for r in cursor.fetchall()}
    assert {"avatar_key", "avatar_mime"} <= cols


def test_avatar_path_builds_versioned_path_or_none():
    assert _avatar_path("alice", None) is None
    assert _avatar_path("alice", "") is None
    p = _avatar_path("alice", "abcdef1234567890.jpg")
    assert p == "/api/avatars/alice?v=abcdef12"


def test_upload_avatar_sets_path_then_delete_clears(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/me/avatar",
                    data={"file": (_io.BytesIO(b"JPEGDATA"), "a.jpg", "image/jpeg")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 200
    url = r.get_json()["avatar_url"]
    assert url and url.startswith("/api/avatars/alice?v=")
    prof = client.get("/api/me/profile", headers=alice["headers"]).get_json()
    assert prof["avatar_url"] == url
    d = client.delete("/api/me/avatar", headers=alice["headers"])
    assert d.status_code == 200 and d.get_json()["avatar_url"] is None


def test_upload_avatar_rejects_non_image(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/me/avatar",
                    data={"file": (_io.BytesIO(b"%PDF"), "a.pdf", "application/pdf")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 400


def test_serve_avatar_token_gated(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    client.post("/api/me/avatar",
                data={"file": (_io.BytesIO(b"IMG"), "a.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=alice["headers"])
    btok = bob["headers"]["Authorization"].split()[1]
    ok = client.get(f"/api/avatars/alice?token={btok}")
    assert ok.status_code == 200 and ok.data == b"IMG"
    assert "inline" in ok.headers.get("Content-Disposition", "")
    assert client.get("/api/avatars/alice").status_code == 401
    assert client.get(f"/api/avatars/bob?token={btok}").status_code == 404


def _set_avatar(client, user):
    client.post("/api/me/avatar",
                data={"file": (_io.BytesIO(b"IMG"), "a.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=user["headers"])


def test_directory_and_history_include_avatar(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    _set_avatar(client, bob)
    diru = client.get("/api/directory_users", headers=alice["headers"]).get_json()
    assert any(u["username"] == "bob" and u["avatar_url"] for u in diru)
    client.post("/api/dm/messages", json={"to_username": "bob", "body": "hi"}, headers=alice["headers"])
    hist = client.get("/api/chats_history", headers=alice["headers"]).get_json()
    bob_row = next(e for e in hist if e.get("username") == "bob")
    assert bob_row["avatar_url"]


def test_group_members_and_sender_avatar(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    _set_avatar(client, alice)
    cid = client.post("/api/groups", json={"title": "G", "members": ["bob"]},
                      headers=alice["headers"]).get_json()["conversation_id"]
    g = client.get(f"/api/groups/{cid}", headers=alice["headers"]).get_json()
    assert any(m["username"] == "alice" and m["avatar_url"] for m in g["members"])
    client.post(f"/api/groups/{cid}/messages", json={"body": "yo", "client_message_id": "gm"},
                headers=alice["headers"])
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    assert next(m for m in msgs if m["id"] == "gm")["sender_avatar_url"]
