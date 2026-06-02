import uuid

from chat.database import connection, cursor, _backfill_client_message_ids


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
