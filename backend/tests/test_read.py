from chat.conversations import (
    create_group_conversation,
    mark_read,
    read_state,
    unread_count,
)
from chat.database import connection, cursor


def _user(username):
    cursor.execute("INSERT INTO User (username, password) VALUES (?, 'x')", (username,))
    connection.commit()
    return cursor.lastrowid


def _msg(cid, sender_id, body, ts):
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at) VALUES (?,?,?,?)",
        (cid, sender_id, body, ts),
    )
    connection.commit()


def test_new_member_starts_unread_null_and_counts_all():
    a, b = _user("a"), _user("b")
    cid = create_group_conversation(a, "G", [b])
    _msg(cid, a, "hi", "2026-06-01T10:00:00")
    _msg(cid, a, "again", "2026-06-01T10:01:00")
    assert unread_count(cid, b) == 2
    assert unread_count(cid, a) == 0


def test_mark_read_clears_unread():
    a, b = _user("a"), _user("b")
    cid = create_group_conversation(a, "G", [b])
    _msg(cid, a, "hi", "2026-06-01T10:00:00")
    mark_read(cid, b, "2026-06-01T10:30:00")
    assert unread_count(cid, b) == 0
    _msg(cid, a, "later", "2026-06-01T11:00:00")
    assert unread_count(cid, b) == 1


def test_read_state_shape():
    a, b = _user("a"), _user("b")
    cid = create_group_conversation(a, "G", [b])
    mark_read(cid, a, "2026-06-01T10:30:00")
    rs = {r["username"]: r["last_read_at"] for r in read_state(cid)}
    assert rs["a"] == "2026-06-01T10:30:00"
    assert rs["b"] is None
