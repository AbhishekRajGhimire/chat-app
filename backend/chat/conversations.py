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


def mark_read(cid: int, user_id: int, when_iso: str) -> None:
    cursor.execute(
        "UPDATE ConversationMember SET last_read_at=? WHERE conversation_id=? AND user_id=?",
        (when_iso, cid, user_id),
    )
    connection.commit()


def unread_count(cid: int, user_id: int) -> int:
    """Messages in cid newer than the member's last_read_at, excluding their own."""
    cursor.execute(
        "SELECT last_read_at FROM ConversationMember WHERE conversation_id=? AND user_id=?",
        (cid, user_id),
    )
    row = cursor.fetchone()
    last = row[0] if row else None
    if last is None:
        cursor.execute(
            "SELECT COUNT(*) FROM Message WHERE conversation_id=? AND sender_user_id!=?",
            (cid, user_id),
        )
    else:
        cursor.execute(
            "SELECT COUNT(*) FROM Message WHERE conversation_id=? AND sender_user_id!=? AND created_at>?",
            (cid, user_id, last),
        )
    return int(cursor.fetchone()[0])


def read_state(cid: int) -> list:
    """[{username, last_read_at}] for every member — drives 'seen' rendering."""
    cursor.execute(
        "SELECT u.username, m.last_read_at FROM ConversationMember m "
        "JOIN User u ON u.id = m.user_id WHERE m.conversation_id=?",
        (cid,),
    )
    return [{"username": r[0], "last_read_at": r[1]} for r in cursor.fetchall()]


_PREVIEW_MAX = 120


def reactions_for(client_message_id: str, me_id: int) -> list:
    """[{emoji, count, mine}] aggregated across users for one message."""
    if not client_message_id:
        return []
    cursor.execute(
        """
        SELECT emoji, COUNT(*),
               MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END)
        FROM MessageReaction
        WHERE client_message_id = ?
        GROUP BY emoji
        ORDER BY MIN(id)
        """,
        (me_id, client_message_id),
    )
    return [
        {"emoji": r[0], "count": int(r[1]), "mine": bool(r[2])}
        for r in cursor.fetchall()
    ]


def serialize_messages(cid: int, me_id: int) -> list:
    """Full message payloads for a conversation: text + id + reactions + reply +
    edited/deleted markers. Shared by DM and group history endpoints."""
    cursor.execute(
        """
        SELECT u.username, m.body, m.created_at, m.client_message_id,
               m.reply_to, m.edited_at, m.deleted_at
        FROM Message m
        JOIN User u ON u.id = m.sender_user_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at, m.id
        """,
        (cid,),
    )
    rows = cursor.fetchall()
    body_by_cmid = {r[3]: r[1] for r in rows if r[3]}
    deleted_cmids = {r[3] for r in rows if r[3] and r[6] is not None}
    out = []
    for username, body, ts, cmid, reply_to, edited_at, deleted_at in rows:
        deleted = deleted_at is not None
        preview = None
        if reply_to and reply_to not in deleted_cmids:
            parent = body_by_cmid.get(reply_to)
            if parent:
                preview = parent[:_PREVIEW_MAX]
        out.append(
            {
                "from": username,
                "message": "" if deleted else body,
                "datetime": ts,
                "id": cmid,
                "reply_to": reply_to,
                "reply_preview": preview,
                "edited_at": edited_at,
                "deleted": deleted,
                "reactions": reactions_for(cmid, me_id) if cmid else [],
            }
        )
    return out


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
