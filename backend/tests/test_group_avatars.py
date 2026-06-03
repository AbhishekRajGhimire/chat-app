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
