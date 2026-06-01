"""Conversation helpers: direct (normalized pair) and group conversations."""
import datetime
from typing import List, Tuple

from .database import connection, cursor


def conversation_room(cid: int) -> str:
    """Socket.IO room name for a conversation (DMs and groups alike)."""
    return f"conv:{int(cid)}"


def user_conversation_ids(user_id: int) -> List[int]:
    cursor.execute(
        "SELECT conversation_id FROM ConversationMember WHERE user_id = ?",
        (user_id,),
    )
    return [int(r[0]) for r in cursor.fetchall()]


def is_member(cid: int, user_id: int) -> bool:
    cursor.execute(
        "SELECT 1 FROM ConversationMember WHERE conversation_id = ? AND user_id = ?",
        (cid, user_id),
    )
    return cursor.fetchone() is not None


def group_members(cid: int) -> List[dict]:
    cursor.execute(
        """
        SELECT u.username, COALESCE(NULLIF(TRIM(p.display_name), ''), u.username)
        FROM ConversationMember m
        JOIN User u ON u.id = m.user_id
        LEFT JOIN UserProfile p ON p.user_id = u.id
        WHERE m.conversation_id = ?
        ORDER BY u.username
        """,
        (cid,),
    )
    return [{"username": r[0], "display_name": r[1]} for r in cursor.fetchall()]


def create_group_conversation(creator_id: int, title: str, member_ids: List[int]) -> int:
    now = _utc_now_iso()
    cursor.execute(
        "INSERT INTO Conversation (type, title, created_at, created_by_user_id) "
        "VALUES ('group', ?, ?, ?)",
        (title, now, creator_id),
    )
    cid = int(cursor.lastrowid)
    for uid in {creator_id, *member_ids}:
        cursor.execute(
            "INSERT INTO ConversationMember (conversation_id, user_id, role, joined_at) "
            "VALUES (?, ?, 'member', ?)",
            (cid, uid, now),
        )
    connection.commit()
    return cid


def add_group_member(cid: int, user_id: int) -> None:
    cursor.execute(
        "INSERT OR IGNORE INTO ConversationMember (conversation_id, user_id, role, joined_at) "
        "VALUES (?, ?, 'member', ?)",
        (cid, user_id, _utc_now_iso()),
    )
    connection.commit()


def remove_group_member(cid: int, user_id: int) -> None:
    cursor.execute(
        "DELETE FROM ConversationMember WHERE conversation_id = ? AND user_id = ?",
        (cid, user_id),
    )
    connection.commit()


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
