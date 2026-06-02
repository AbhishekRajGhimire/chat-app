import uuid

from chat.database import connection, cursor, _backfill_client_message_ids
from chat.conversations import reactions_for, serialize_messages


def _seed_message_without_cmid():
    """Insert a user, a direct conversation, and a Message with NULL client_message_id."""
    cursor.execute("INSERT INTO User (username, password) VALUES ('zoe', 'x')")
    uid = cursor.lastrowid
    cursor.execute("INSERT INTO User (username, password) VALUES ('yan', 'x')")
    uid2 = cursor.lastrowid
    lo, hi = sorted((uid, uid2))
    cursor.execute(
        "INSERT INTO Conversation (type, created_at, dm_user_low_id, dm_user_high_id) "
        "VALUES ('direct', datetime('now'), ?, ?)",
        (lo, hi),
    )
    cid = cursor.lastrowid
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at) "
        "VALUES (?, ?, 'hi', datetime('now'))",
        (cid, uid),
    )
    connection.commit()
    return cursor.lastrowid


def test_message_action_columns_exist():
    cursor.execute("PRAGMA table_info(Message)")
    cols = {row[1] for row in cursor.fetchall()}
    assert {"reply_to", "edited_at", "deleted_at"} <= cols


def test_message_reaction_table_exists():
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='MessageReaction'"
    )
    assert cursor.fetchone() is not None


def test_backfill_populates_null_client_message_ids():
    mid = _seed_message_without_cmid()
    cursor.execute("UPDATE Message SET client_message_id=NULL WHERE id=?", (mid,))
    connection.commit()
    _backfill_client_message_ids()
    cursor.execute("SELECT client_message_id FROM Message WHERE id=?", (mid,))
    value = cursor.fetchone()[0]
    assert value
    uuid.UUID(value)  # parses as a UUID


def _seed_group_with_message(body="hello", cmid="cmid-1"):
    cursor.execute("INSERT INTO User (username, password) VALUES ('amy', 'x')")
    amy = cursor.lastrowid
    cursor.execute("INSERT INTO User (username, password) VALUES ('ben', 'x')")
    ben = cursor.lastrowid
    cursor.execute(
        "INSERT INTO Conversation (type, title, created_at, created_by_user_id) "
        "VALUES ('group', 'Crew', datetime('now'), ?)",
        (amy,),
    )
    cid = cursor.lastrowid
    for uid in (amy, ben):
        cursor.execute(
            "INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at) "
            "VALUES (?, ?, 'member', datetime('now'))",
            (cid, uid),
        )
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at, client_message_id) "
        "VALUES (?, ?, ?, datetime('now'), ?)",
        (cid, amy, body, cmid),
    )
    connection.commit()
    return cid, amy, ben


def test_reactions_for_aggregates_and_marks_mine():
    cid, amy, ben = _seed_group_with_message(cmid="cmid-react")
    for uid in (amy, ben):
        cursor.execute(
            "INSERT INTO MessageReaction (client_message_id, user_id, emoji, created_at) "
            "VALUES ('cmid-react', ?, '\U0001f44d', datetime('now'))",
            (uid,),
        )
    connection.commit()
    result = reactions_for("cmid-react", amy)
    assert result == [{"emoji": "\U0001f44d", "count": 2, "mine": True}]
    assert reactions_for("cmid-react", ben)[0]["mine"] is True


def test_serialize_messages_includes_action_fields():
    cid, amy, ben = _seed_group_with_message(body="hi", cmid="cmid-ser")
    msgs = serialize_messages(cid, amy)
    assert len(msgs) == 1
    m = msgs[0]
    assert m["from"] == "amy"
    assert m["message"] == "hi"
    assert m["id"] == "cmid-ser"
    assert m["reactions"] == []
    assert m["reply_to"] is None
    assert m["reply_preview"] is None
    assert m["edited_at"] is None
    assert m["deleted"] is False


def test_serialize_messages_reply_preview_and_deleted():
    cid, amy, ben = _seed_group_with_message(body="parent", cmid="p1")
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at, client_message_id, reply_to) "
        "VALUES (?, ?, 'child', datetime('now'), 'c1', 'p1')",
        (cid, ben),
    )
    cursor.execute("UPDATE Message SET deleted_at=datetime('now'), body='' WHERE client_message_id='p1'")
    connection.commit()
    msgs = {m["id"]: m for m in serialize_messages(cid, amy)}
    assert msgs["p1"]["deleted"] is True
    assert msgs["p1"]["message"] == ""
    # child still resolves; preview is suppressed because the parent is deleted
    assert msgs["c1"]["reply_to"] == "p1"
    assert msgs["c1"]["reply_preview"] is None


def _make_group(client, owner, member, title="Crew"):
    """owner creates a group containing member; returns conversation_id."""
    r = client.post(
        "/api/groups",
        json={"title": title, "members": [member["username"]]},
        headers=owner["headers"],
    )
    return r.get_json()["conversation_id"]


def _post_group_msg(client, sender, cid, body="hi", cmid="m-1"):
    client.post(
        f"/api/groups/{cid}/messages",
        json={"body": body, "client_message_id": cmid},
        headers=sender["headers"],
    )
    return cmid


def test_react_toggles_on_and_off(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="react-1")

    r1 = client.post(f"/api/messages/{cmid}/react", json={"emoji": "\U0001f44d"}, headers=bob["headers"])
    assert r1.status_code == 200
    assert r1.get_json()["reactions"] == [{"emoji": "\U0001f44d", "count": 1, "mine": True}]

    r2 = client.post(f"/api/messages/{cmid}/react", json={"emoji": "\U0001f44d"}, headers=bob["headers"])
    assert r2.status_code == 200
    assert r2.get_json()["reactions"] == []  # toggled off


def test_react_requires_membership(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    carol = make_user("carol")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="react-2")
    r = client.post(f"/api/messages/{cmid}/react", json={"emoji": "\U0001f44d"}, headers=carol["headers"])
    assert r.status_code == 403


def test_react_unknown_message_404(client, make_user):
    alice = make_user("alice")
    r = client.post("/api/messages/nope/react", json={"emoji": "\U0001f44d"}, headers=alice["headers"])
    assert r.status_code == 404


def test_edit_owner_updates_body_and_sets_edited(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, body="frist", cmid="edit-1")
    r = client.patch(f"/api/messages/{cmid}", json={"body": "first"}, headers=alice["headers"])
    assert r.status_code == 200
    body = r.get_json()
    assert body["body"] == "first"
    assert body["edited_at"]
    msgs = client.get(f"/api/groups/{cid}/messages", headers=alice["headers"]).get_json()["messages"]
    edited = next(m for m in msgs if m["id"] == cmid)
    assert edited["message"] == "first"
    assert edited["edited_at"]


def test_edit_non_owner_forbidden(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="edit-2")
    r = client.patch(f"/api/messages/{cmid}", json={"body": "nope"}, headers=bob["headers"])
    assert r.status_code == 403


def test_delete_owner_soft_deletes(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, body="secret", cmid="del-1")
    r = client.delete(f"/api/messages/{cmid}", headers=alice["headers"])
    assert r.status_code == 200
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    tomb = next(m for m in msgs if m["id"] == cmid)
    assert tomb["deleted"] is True
    assert tomb["message"] == ""


def test_delete_non_owner_forbidden(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    cmid = _post_group_msg(client, alice, cid, cmid="del-2")
    r = client.delete(f"/api/messages/{cmid}", headers=bob["headers"])
    assert r.status_code == 403


def test_dm_post_stores_client_message_id_and_reply(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    r = client.post(
        "/api/dm/messages",
        json={"to_username": "bob", "body": "parent", "client_message_id": "dm-p"},
        headers=alice["headers"],
    )
    assert r.status_code == 201
    assert r.get_json()["client_message_id"] == "dm-p"
    client.post(
        "/api/dm/messages",
        json={"to_username": "alice", "body": "child", "client_message_id": "dm-c", "reply_to": "dm-p"},
        headers=bob["headers"],
    )
    msgs = client.get("/api/dm/messages/bob", headers=alice["headers"]).get_json()["messages"]
    by_id = {m["id"]: m for m in msgs}
    assert by_id["dm-p"]["id"] == "dm-p"
    assert by_id["dm-c"]["reply_to"] == "dm-p"
    assert by_id["dm-c"]["reply_preview"] == "parent"
    # DM payloads still carry `to`
    assert by_id["dm-p"]["to"] == "bob"


def test_group_post_stores_client_message_id(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    cid = _make_group(client, alice, bob)
    client.post(
        f"/api/groups/{cid}/messages",
        json={"body": "yo", "client_message_id": "g-1"},
        headers=alice["headers"],
    )
    msgs = client.get(f"/api/groups/{cid}/messages", headers=bob["headers"]).get_json()["messages"]
    assert any(m["id"] == "g-1" and m["reactions"] == [] for m in msgs)
