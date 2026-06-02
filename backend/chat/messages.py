"""Message-level actions (reactions, edit, delete), keyed on client_message_id.

Membership/ownership is resolved from the message's own conversation row — the
caller never supplies a conversation id. Mutations broadcast to the per-
conversation room so every participant updates live.
"""
import datetime

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app, socketio
from .conversations import conversation_room, is_member, reactions_for
from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _uid(username):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    row = cursor.fetchone()
    return int(row[0]) if row else None


def _message_meta(cmid):
    """(conversation_id, sender_user_id, deleted_at) for a client_message_id."""
    cursor.execute(
        "SELECT conversation_id, sender_user_id, deleted_at "
        "FROM Message WHERE client_message_id=?",
        (cmid,),
    )
    row = cursor.fetchone()
    if not row:
        return (None, None, None)
    return (int(row[0]), int(row[1]), row[2])


@app.route("/api/messages/<cmid>/react", methods=["POST"])
@jwt_required()
def react_message(cmid):
    me = _uid(get_jwt_identity())
    if me is None:
        return jsonify({"error": "User not found"}), 404
    conv_id, _sender, _deleted = _message_meta(cmid)
    if conv_id is None:
        return jsonify({"error": "Unknown message"}), 404
    if not is_member(conv_id, me):
        return jsonify({"error": "Not a member"}), 403
    data = request.get_json(silent=True) or {}
    emoji = data.get("emoji")
    if not isinstance(emoji, str) or not emoji.strip():
        return jsonify({"error": "emoji required"}), 400
    emoji = emoji.strip()

    cursor.execute(
        "SELECT id FROM MessageReaction "
        "WHERE client_message_id=? AND user_id=? AND emoji=?",
        (cmid, me, emoji),
    )
    existing = cursor.fetchone()
    if existing:
        cursor.execute("DELETE FROM MessageReaction WHERE id=?", (existing[0],))
    else:
        cursor.execute(
            "INSERT INTO MessageReaction (client_message_id, user_id, emoji, created_at) "
            "VALUES (?, ?, ?, ?)",
            (cmid, me, emoji, _utc_now_iso()),
        )
    connection.commit()

    reactions = reactions_for(cmid, me)
    socketio.emit(
        "reaction_updated",
        {"conversation_id": conv_id, "client_message_id": cmid, "reactions": reactions},
        room=conversation_room(conv_id),
    )
    return jsonify({"reactions": reactions}), 200


@app.route("/api/messages/<cmid>", methods=["PATCH"])
@jwt_required()
def edit_message(cmid):
    me = _uid(get_jwt_identity())
    conv_id, sender, deleted_at = _message_meta(cmid)
    if conv_id is None:
        return jsonify({"error": "Unknown message"}), 404
    if me != sender:
        return jsonify({"error": "Not your message"}), 403
    if deleted_at is not None:
        return jsonify({"error": "Message deleted"}), 400
    data = request.get_json(silent=True) or {}
    body = data.get("body")
    if not isinstance(body, str) or not body.strip():
        return jsonify({"error": "body required"}), 400
    body = body.strip()
    now = _utc_now_iso()
    cursor.execute(
        "UPDATE Message SET body=?, edited_at=? WHERE client_message_id=?",
        (body, now, cmid),
    )
    connection.commit()
    socketio.emit(
        "message_edited",
        {"conversation_id": conv_id, "client_message_id": cmid, "body": body, "edited_at": now},
        room=conversation_room(conv_id),
    )
    return jsonify({"client_message_id": cmid, "body": body, "edited_at": now}), 200


@app.route("/api/messages/<cmid>", methods=["DELETE"])
@jwt_required()
def delete_message(cmid):
    me = _uid(get_jwt_identity())
    conv_id, sender, _deleted = _message_meta(cmid)
    if conv_id is None:
        return jsonify({"error": "Unknown message"}), 404
    if me != sender:
        return jsonify({"error": "Not your message"}), 403
    now = _utc_now_iso()
    cursor.execute(
        "UPDATE Message SET deleted_at=?, body='' WHERE client_message_id=?",
        (now, cmid),
    )
    connection.commit()
    socketio.emit(
        "message_deleted",
        {"conversation_id": conv_id, "client_message_id": cmid},
        room=conversation_room(conv_id),
    )
    return jsonify({"client_message_id": cmid, "deleted": True}), 200
