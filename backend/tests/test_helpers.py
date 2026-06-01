from chat.conversations import (
    conversation_room,
    create_group_conversation,
    get_or_create_direct_conversation,
    group_members,
    is_member,
    user_conversation_ids,
)
from chat.database import connection, cursor


def _user(username):
    cursor.execute("INSERT INTO User (username, password) VALUES (?, 'x')", (username,))
    connection.commit()
    return cursor.lastrowid


def test_conversation_room():
    assert conversation_room(7) == "conv:7"


def test_direct_conversation_idempotent_and_normalized():
    a, b = _user("a"), _user("b")
    cid1 = get_or_create_direct_conversation(a, b)
    cid2 = get_or_create_direct_conversation(b, a)  # reversed order
    assert cid1 == cid2
    assert {m["username"] for m in group_members(cid1)} == {"a", "b"}


def test_create_group_and_membership():
    creator, m1, m2 = _user("c"), _user("m1"), _user("m2")
    cid = create_group_conversation(creator, "Crew", [m1, m2])
    assert {m["username"] for m in group_members(cid)} == {"c", "m1", "m2"}
    assert is_member(cid, creator) is True
    assert is_member(cid, _user("outsider")) is False
    assert cid in user_conversation_ids(creator)
