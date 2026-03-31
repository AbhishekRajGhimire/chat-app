import datetime
from typing import Dict, Optional

from flask import jsonify, request
from flask_jwt_extended import decode_token, get_jwt_identity, jwt_required
from flask_socketio import emit, join_room

from .conversations import get_or_create_direct_conversation
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


@app.route("/api/dm/messages/<other_username>", methods=["GET"])
@jwt_required()
def get_dm_messages(other_username):
    me_username = get_jwt_identity()
    if other_username == me_username:
        return jsonify([]), 200

    cursor.execute("SELECT id FROM User WHERE username=?", (me_username,))
    me_row = cursor.fetchone()
    cursor.execute("SELECT id FROM User WHERE username=?", (other_username,))
    other_row = cursor.fetchone()
    if not me_row or not other_row:
        return jsonify([]), 200

    me_id = int(me_row[0])
    other_id = int(other_row[0])
    cid = _direct_conversation_id_for_pair(me_id, other_id)
    if cid is None:
        return jsonify([]), 200

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
            {
                "from": sender_name,
                "to": to_name,
                "message": text,
                "datetime": ts,
            }
        )
    return jsonify(formatted)


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
        SELECT DISTINCT u.username,
            COALESCE(NULLIF(TRIM(p.display_name), ''), u.username) AS display_name
        FROM Conversation c
        JOIN ConversationMember ms ON ms.conversation_id = c.id AND ms.user_id = ?
        JOIN ConversationMember mp ON mp.conversation_id = c.id AND mp.user_id != ms.user_id
        JOIN User u ON u.id = mp.user_id
        LEFT JOIN UserProfile p ON p.user_id = u.id
        WHERE c.type = 'direct'
        """,
        (me_id,),
    )
    peers = [{"username": r[0], "display_name": r[1]} for r in cursor.fetchall()]
    self_entry = {"username": me_name, "display_name": self_display}
    combined = peers + [self_entry]
    combined.sort(key=lambda e: e["display_name"].lower())
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


@socketio.on("send_message")
def handle_message(data):
    sender = socket_user_by_sid.get(request.sid)
    if not sender:
        return
    data = data or {}
    message = data.get("message")
    if message is None or not isinstance(message, str):
        return
    recipient = data.get("recipient")
    if isinstance(recipient, str):
        recipient = recipient.strip() or None
    else:
        recipient = None
    if not recipient and not data.get("recipientsid"):
        return
    payload = {
        "username": sender,
        "message": message,
        "datetime": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    if recipient:
        emit("receive_message", payload, room=recipient)
    else:
        recipientsid = data.get("recipientsid")
        if recipientsid:
            emit("receive_message", payload, room=recipientsid)
