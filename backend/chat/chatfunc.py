import datetime
from typing import Dict, Optional

from flask import jsonify, request
from flask_jwt_extended import decode_token, get_jwt_identity, jwt_required
from flask_socketio import emit, join_room

from .conversations import (
    conversation_room,
    get_or_create_direct_conversation,
    group_members,
    is_member,
    mark_read,
    read_state,
    unread_count,
    user_conversation_ids,
)
from .database import connection, cursor

from chat import app, online_users, socketio

# Maps Socket.IO session id → JWT username (set on authenticated connect only).
socket_user_by_sid: Dict[str, str] = {}


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _handshake_bearer_token() -> Optional[str]:
    """Token from Engine.IO query (?token=) or Authorization header."""
    raw = request.args.get("token")
    if raw and isinstance(raw, str) and raw.strip():
        return raw.strip()
    auth = request.headers.get("Authorization") or ""
    if auth.startswith("Bearer "):
        return auth[7:].strip() or None
    return None


def _username_from_jwt_string(token: str) -> Optional[str]:
    try:
        decoded = decode_token(token)
        sub = decoded.get("sub")
        if isinstance(sub, str) and sub.strip():
            return sub.strip()
    except Exception:
        return None
    return None


def _direct_conversation_id_for_pair(user_id_a: int, user_id_b: int):
    low, high = (user_id_a, user_id_b) if user_id_a < user_id_b else (user_id_b, user_id_a)
    cursor.execute(
        """
        SELECT id FROM Conversation
        WHERE type = 'direct' AND dm_user_low_id = ? AND dm_user_high_id = ?
        """,
        (low, high),
    )
    row = cursor.fetchone()
    return int(row[0]) if row else None


@app.route("/api/dm/messages", methods=["POST"])
@jwt_required()
def post_dm_message():
    me_username = get_jwt_identity()
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400
    to_username = data.get("to_username")
    body = data.get("body")
    if not isinstance(to_username, str) or not to_username.strip():
        return jsonify({"error": "to_username required"}), 400
    if not isinstance(body, str) or not body.strip():
        return jsonify({"error": "body required"}), 400
    to_username = to_username.strip()
    body = body.strip()
    if to_username == me_username:
        return jsonify({"error": "Cannot message yourself"}), 400

    cursor.execute("SELECT id FROM User WHERE username=?", (me_username,))
    me_row = cursor.fetchone()
    cursor.execute("SELECT id FROM User WHERE username=?", (to_username,))
    peer_row = cursor.fetchone()
    if not me_row or not peer_row:
        return jsonify({"error": "Unknown user"}), 400

    cid = get_or_create_direct_conversation(int(me_row[0]), int(peer_row[0]))
    now = _utc_now_iso()
    cursor.execute(
        """
        INSERT INTO Message (conversation_id, sender_user_id, body, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (cid, me_row[0], body, now),
    )
    connection.commit()
    # NOTE: live delivery happens via the socket `send_message` handler (DM →
    # peer's username room). This POST only persists. Keeping DM delivery on the
    # username room (unchanged) avoids the "recipient not yet in a brand-new
    # conversation's room" problem; only groups use per-conversation rooms.
    return (
        jsonify(
            {
                "message": "Message posted successfully",
                "conversation_id": cid,
                "message_id": cursor.lastrowid,
            }
        ),
        201,
    )


@app.route("/api/dm/<other_username>/read", methods=["POST"])
@jwt_required()
def mark_dm_read(other_username):
    me = get_jwt_identity()
    cursor.execute("SELECT id FROM User WHERE username=?", (me,))
    me_row = cursor.fetchone()
    cursor.execute("SELECT id FROM User WHERE username=?", (other_username,))
    other_row = cursor.fetchone()
    if not me_row or not other_row:
        return jsonify({"error": "Unknown user"}), 400
    cid = _direct_conversation_id_for_pair(int(me_row[0]), int(other_row[0]))
    if cid is None:
        return jsonify({"message": "no conversation"}), 200
    now = _utc_now_iso()
    mark_read(cid, int(me_row[0]), now)
    socketio.emit(
        "conversation_read",
        {"conversation_id": cid, "username": me, "last_read_at": now},
        room=conversation_room(cid),
    )
    return jsonify({"message": "ok", "last_read_at": now}), 200


@app.route("/api/dm/messages/<other_username>", methods=["GET"])
@jwt_required()
def get_dm_messages(other_username):
    me_username = get_jwt_identity()
    empty = {"messages": [], "read_state": []}
    if other_username == me_username:
        return jsonify(empty), 200

    cursor.execute("SELECT id FROM User WHERE username=?", (me_username,))
    me_row = cursor.fetchone()
    cursor.execute("SELECT id FROM User WHERE username=?", (other_username,))
    other_row = cursor.fetchone()
    if not me_row or not other_row:
        return jsonify(empty), 200

    me_id = int(me_row[0])
    other_id = int(other_row[0])
    cid = _direct_conversation_id_for_pair(me_id, other_id)
    if cid is None:
        return jsonify(empty), 200

    cursor.execute(
        """
        SELECT u.username, m.sender_user_id, m.body, m.created_at
        FROM Message m
        JOIN User u ON u.id = m.sender_user_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at
        """,
        (cid,),
    )
    rows = cursor.fetchall()
    formatted = []
    for sender_name, sender_id, text, ts in rows:
        to_name = other_username if int(sender_id) == me_id else me_username
        formatted.append(
            {"from": sender_name, "to": to_name, "message": text, "datetime": ts}
        )
    return jsonify({"messages": formatted, "read_state": read_state(cid)})


@app.route("/api/chats_history", methods=["GET"])
@jwt_required()
def get_chats_history():
    cursor.execute("SELECT id, username FROM User WHERE username=?", (get_jwt_identity(),))
    me_row = cursor.fetchone()
    if not me_row:
        return jsonify([]), 200
    me_id, me_name = int(me_row[0]), me_row[1]

    cursor.execute(
        """
        SELECT COALESCE(NULLIF(TRIM(p.display_name), ''), u.username)
        FROM User u
        LEFT JOIN UserProfile p ON p.user_id = u.id
        WHERE u.id = ?
        """,
        (me_id,),
    )
    self_display_row = cursor.fetchone()
    self_display = self_display_row[0] if self_display_row else me_name

    cursor.execute(
        """
        SELECT c.id,
            u.username,
            COALESCE(NULLIF(TRIM(p.display_name), ''), u.username) AS display_name,
            (SELECT m.body FROM Message m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
            (SELECT m.created_at FROM Message m
             WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at
        FROM Conversation c
        JOIN ConversationMember ms ON ms.conversation_id = c.id AND ms.user_id = ?
        JOIN ConversationMember mp ON mp.conversation_id = c.id AND mp.user_id != ms.user_id
        JOIN User u ON u.id = mp.user_id
        LEFT JOIN UserProfile p ON p.user_id = u.id
        WHERE c.type = 'direct'
        """,
        (me_id,),
    )
    peers = [
        {
            "kind": "direct",
            "username": r[1],
            "display_name": r[2],
            "last_message": r[3],
            "last_message_at": r[4],
            "unread_count": unread_count(int(r[0]), me_id),
        }
        for r in cursor.fetchall()
    ]

    # Group conversations the user belongs to.
    cursor.execute(
        """
        SELECT c.id, c.title,
            (SELECT COUNT(*) FROM ConversationMember cm2 WHERE cm2.conversation_id = c.id) AS member_count,
            (SELECT m.body FROM Message m WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
            (SELECT m.created_at FROM Message m WHERE m.conversation_id = c.id
             ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message_at
        FROM Conversation c
        JOIN ConversationMember cm ON cm.conversation_id = c.id AND cm.user_id = ?
        WHERE c.type = 'group'
        """,
        (me_id,),
    )
    groups = [
        {
            "kind": "group",
            "conversation_id": int(r[0]),
            "title": r[1] or "Group",
            "member_count": int(r[2]),
            "last_message": r[3],
            "last_message_at": r[4],
            "unread_count": unread_count(int(r[0]), me_id),
        }
        for r in cursor.fetchall()
    ]

    self_entry = {
        "kind": "direct",
        "username": me_name,
        "display_name": self_display,
        "last_message": None,
        "last_message_at": None,
        "unread_count": 0,
    }
    combined = peers + groups + [self_entry]
    return jsonify(combined)


@app.route("/api/directory_users", methods=["GET"])
@jwt_required()
def directory_users():
    """All registered usernames except the current user (for New Chat search)."""
    me = get_jwt_identity()
    cursor.execute(
        """
        SELECT u.username,
            COALESCE(NULLIF(TRIM(p.display_name), ''), u.username) AS display_name
        FROM User u
        LEFT JOIN UserProfile p ON p.user_id = u.id
        WHERE u.username != ?
        ORDER BY display_name COLLATE NOCASE
        """,
        (me,),
    )
    rows = cursor.fetchall()
    return jsonify(
        [{"username": row[0], "display_name": row[1]} for row in rows]
    )


def _register_socket_presence(username: str, sid: str) -> None:
    join_room(username)
    updated = False
    for index, user_tuple in enumerate(online_users):
        if user_tuple[0] == username:
            online_users[index] = (username, sid)
            updated = True
            break
    if not updated:
        online_users.append((username, sid))


def add_user_to_live_room(username: str, cid: int) -> None:
    """Place an already-connected member into a conversation room without a
    reconnect, and tell them (their username room) to add it to the sidebar."""
    room = conversation_room(cid)
    for uname, sid in online_users:
        if uname == username and sid:
            socketio.server.enter_room(sid, room)
    socketio.emit("conversation_added", {"conversation_id": cid}, room=username)


@socketio.on("connect")
def on_connect():
    token = _handshake_bearer_token()
    if not token:
        return False
    username = _username_from_jwt_string(token)
    if not username:
        return False
    socket_user_by_sid[request.sid] = username
    _register_socket_presence(username, request.sid)
    # Join a room per conversation so group (and DM) messages fan out correctly.
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    me = cursor.fetchone()
    if me:
        for cid in user_conversation_ids(int(me[0])):
            join_room(conversation_room(cid))
    emit("online_users", online_users, broadcast=True)


@socketio.on("disconnect")
def on_disconnect():
    socket_user_by_sid.pop(request.sid, None)
    sid = request.sid
    for index, user_tuple in enumerate(online_users):
        if user_tuple[1] == sid:
            online_users[index] = (user_tuple[0], "")
            break
    emit("online_users", online_users, broadcast=True)


def _sender_user_id(username: str):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    row = cursor.fetchone()
    return int(row[0]) if row else None


@socketio.on("send_message")
def handle_message(data):
    sender = socket_user_by_sid.get(request.sid)
    if not sender:
        return
    data = data or {}
    message = data.get("message")
    if message is None or not isinstance(message, str):
        return
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()

    # Group: deliver to the conversation room (members joined on connect).
    cid = data.get("conversation_id")
    if cid is not None:
        try:
            cid = int(cid)
        except (TypeError, ValueError):
            return
        uid = _sender_user_id(sender)
        if uid is None or not is_member(cid, uid):
            return
        emit(
            "receive_message",
            {"username": sender, "message": message, "datetime": now,
             "kind": "group", "conversation_id": cid},
            room=conversation_room(cid),
            skip_sid=request.sid,  # sender already appended optimistically
        )
        return

    # Direct: deliver to the recipient's username room (unchanged behavior).
    recipient = data.get("recipient")
    if isinstance(recipient, str):
        recipient = recipient.strip() or None
    else:
        recipient = None
    if not recipient:
        return
    emit(
        "receive_message",
        {"username": sender, "message": message, "datetime": now, "kind": "direct"},
        room=recipient,
    )


@socketio.on("typing")
def handle_typing(data):
    # Sender identity comes only from the socket session (same trust model as
    # send_message). The event carries no message content.
    sender = socket_user_by_sid.get(request.sid)
    if not sender:
        return
    data = data or {}
    cid = data.get("conversation_id")
    if cid is not None:
        try:
            cid = int(cid)
        except (TypeError, ValueError):
            return
        uid = _sender_user_id(sender)
        if uid is None or not is_member(cid, uid):
            return
        emit("peer_typing", {"from": sender, "conversation_id": cid},
             room=conversation_room(cid), skip_sid=request.sid)
        return
    recipient = data.get("recipient")
    if isinstance(recipient, str) and recipient.strip():
        emit("peer_typing", {"from": sender, "conversation_id": None},
             room=recipient.strip())
