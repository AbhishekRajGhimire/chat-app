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
