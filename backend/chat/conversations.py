"""Direct conversation helpers: get-or-create by normalized user pair."""
import datetime
from typing import Tuple

from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def normalized_pair(user_id_a: int, user_id_b: int) -> Tuple[int, int]:
    if user_id_a == user_id_b:
        raise ValueError("cannot open direct conversation with self")
    return (user_id_a, user_id_b) if user_id_a < user_id_b else (user_id_b, user_id_a)


def get_or_create_direct_conversation(user_id_a: int, user_id_b: int) -> int:
    low, high = normalized_pair(user_id_a, user_id_b)
    cursor.execute(
        """
        SELECT id FROM Conversation
        WHERE type = 'direct' AND dm_user_low_id = ? AND dm_user_high_id = ?
        """,
        (low, high),
    )
    row = cursor.fetchone()
    if row:
        return int(row[0])
    now = _utc_now_iso()
    cursor.execute(
        """
        INSERT INTO Conversation (type, created_at, dm_user_low_id, dm_user_high_id)
        VALUES ('direct', ?, ?, ?)
        """,
        (now, low, high),
    )
    cid = cursor.lastrowid
    for uid in (low, high):
        cursor.execute(
            """
            INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at)
            VALUES (?, ?, 'member', ?)
            """,
            (cid, uid, now),
        )
    connection.commit()
    return int(cid)
