from chat.database import cursor
from chat.conversations import group_avatar_path


def test_conversation_has_avatar_columns():
    cursor.execute("PRAGMA table_info(Conversation)")
    cols = {r[1] for r in cursor.fetchall()}
    assert {"avatar_key", "avatar_mime"} <= cols


def test_group_avatar_path_or_none():
    assert group_avatar_path(7, None) is None
    assert group_avatar_path(7, "") is None
    assert group_avatar_path(7, "abcdef1234.jpg") == "/api/groups/7/avatar?v=abcdef12"


import io as _io


def _grp(client, owner, members=("bob",)):
    return client.post("/api/groups", json={"title": "G", "members": list(members)},
                       headers=owner["headers"]).get_json()["conversation_id"]


def test_group_avatar_upload_serve_delete(client, make_user):
    alice = make_user("alice"); bob = make_user("bob")
    cid = _grp(client, alice)
    r = client.post(f"/api/groups/{cid}/avatar",
                    data={"file": (_io.BytesIO(b"GIMG"), "g.jpg", "image/jpeg")},
                    content_type="multipart/form-data", headers=alice["headers"])
    assert r.status_code == 200
    url = r.get_json()["avatar_url"]
    assert url and url.startswith(f"/api/groups/{cid}/avatar?v=")
    btok = bob["headers"]["Authorization"].split()[1]
    ok = client.get(f"/api/groups/{cid}/avatar?token={btok}")
    assert ok.status_code == 200 and ok.data == b"GIMG" and "inline" in ok.headers.get("Content-Disposition", "")
    d = client.delete(f"/api/groups/{cid}/avatar", headers=alice["headers"])
    assert d.status_code == 200 and d.get_json()["avatar_url"] is None


def test_group_avatar_non_member_forbidden_and_validation(client, make_user):
    alice = make_user("alice"); make_user("bob"); carol = make_user("carol")
    cid = _grp(client, alice)
    assert client.post(f"/api/groups/{cid}/avatar",
                       data={"file": (_io.BytesIO(b"x"), "g.jpg", "image/jpeg")},
                       content_type="multipart/form-data", headers=carol["headers"]).status_code == 403
    assert client.post(f"/api/groups/{cid}/avatar",
                       data={"file": (_io.BytesIO(b"x"), "g.pdf", "application/pdf")},
                       content_type="multipart/form-data", headers=alice["headers"]).status_code == 400
    client.post(f"/api/groups/{cid}/avatar",
                data={"file": (_io.BytesIO(b"x"), "g.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=alice["headers"])
    ctok = carol["headers"]["Authorization"].split()[1]
    assert client.get(f"/api/groups/{cid}/avatar?token={ctok}").status_code == 403


def test_group_avatar_in_chats_history(client, make_user):
    alice = make_user("alice"); make_user("bob")
    cid = _grp(client, alice)
    client.post(f"/api/groups/{cid}/avatar",
                data={"file": (_io.BytesIO(b"x"), "g.jpg", "image/jpeg")},
                content_type="multipart/form-data", headers=alice["headers"])
    hist = client.get("/api/chats_history", headers=alice["headers"]).get_json()
    grow = next(e for e in hist if e.get("conversation_id") == cid)
    assert grow["avatar_url"] and grow["avatar_url"].startswith(f"/api/groups/{cid}/avatar?v=")
