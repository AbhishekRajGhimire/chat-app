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
