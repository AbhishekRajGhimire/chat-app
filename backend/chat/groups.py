"""Group conversation REST endpoints (flat membership: any member can manage)."""
import datetime

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app, socketio
from .chatfunc import add_user_to_live_room
from .conversations import (
    add_group_member,
    conversation_room,
    create_group_conversation,
    group_members,
    is_member,
    mark_read,
    read_state,
    remove_group_member,
)
from .database import connection, cursor
from .push import send_push_to_user


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _uid(username: str):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    row = cursor.fetchone()
    return int(row[0]) if row else None


def _require_member(cid: int):
    """Return (user_id, None) if the caller is a member, else (None, error_response)."""
    uid = _uid(get_jwt_identity())
    if uid is None:
        return None, (jsonify({"error": "User not found"}), 404)
    if not is_member(cid, uid):
        return None, (jsonify({"error": "Not a member"}), 403)
    return uid, None


def _group_summary(cid: int) -> dict:
    cursor.execute("SELECT title FROM Conversation WHERE id=? AND type='group'", (cid,))
    row = cursor.fetchone()
    members = group_members(cid)
    return {
        "kind": "group",
        "conversation_id": cid,
        "title": (row[0] if row else None) or "Group",
        "members": members,
        "member_count": len(members),
    }


@app.route("/api/groups", methods=["POST"])
@jwt_required()
def create_group():
    creator = _uid(get_jwt_identity())
    if creator is None:
        return jsonify({"error": "User not found"}), 404
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    members = data.get("members")
    if not title:
        return jsonify({"error": "title required"}), 400
    if not isinstance(members, list):
        return jsonify({"error": "members required"}), 400

    member_ids = []
    for uname in members:
        if isinstance(uname, str) and uname.strip():
            uid = _uid(uname.strip())
            if uid is not None and uid != creator:
                member_ids.append(uid)
    member_ids = list(dict.fromkeys(member_ids))
    if not member_ids:
        return jsonify({"error": "at least one valid member required"}), 400

    cid = create_group_conversation(creator, title, member_ids)
    # Put every member (including creator) into the live room + notify them.
    for m in group_members(cid):
        add_user_to_live_room(m["username"], cid)
    return jsonify(_group_summary(cid)), 201


@app.route("/api/groups/<int:cid>", methods=["GET"])
@jwt_required()
def get_group(cid):
    _, err = _require_member(cid)
    if err:
        return err
    return jsonify(_group_summary(cid))


@app.route("/api/groups/<int:cid>", methods=["PATCH"])
@jwt_required()
def rename_group(cid):
    _, err = _require_member(cid)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    if not title:
        return jsonify({"error": "title required"}), 400
    cursor.execute("UPDATE Conversation SET title=? WHERE id=? AND type='group'", (title, cid))
    connection.commit()
    return jsonify(_group_summary(cid))


@app.route("/api/groups/<int:cid>/members", methods=["POST"])
@jwt_required()
def add_members(cid):
    _, err = _require_member(cid)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    members = data.get("members")
    if not isinstance(members, list):
        return jsonify({"error": "members required"}), 400
    added = []
    for uname in members:
        if isinstance(uname, str) and uname.strip():
            uid = _uid(uname.strip())
            if uid is not None and not is_member(cid, uid):
                add_group_member(cid, uid)
                add_user_to_live_room(uname.strip(), cid)
                added.append(uname.strip())
    return jsonify(_group_summary(cid))


@app.route("/api/groups/<int:cid>/members/<username>", methods=["DELETE"])
@jwt_required()
def remove_member(cid, username):
    _, err = _require_member(cid)
    if err:
        return err
    target = _uid(username)
    if target is None:
        return jsonify({"error": "Unknown user"}), 404
    remove_group_member(cid, target)
    socketio.emit("conversation_removed", {"conversation_id": cid}, room=username)
    return jsonify(_group_summary(cid))


@app.route("/api/groups/<int:cid>/leave", methods=["POST"])
@jwt_required()
def leave_group(cid):
    uid, err = _require_member(cid)
    if err:
        return err
    remove_group_member(cid, uid)
    socketio.emit("conversation_removed", {"conversation_id": cid}, room=get_jwt_identity())
    return jsonify({"message": "left"}), 200


@app.route("/api/groups/<int:cid>/read", methods=["POST"])
@jwt_required()
def mark_group_read(cid):
    uid, err = _require_member(cid)
    if err:
        return err
    now = _utc_now_iso()
    mark_read(cid, uid, now)
    socketio.emit(
        "conversation_read",
        {"conversation_id": cid, "username": get_jwt_identity(), "last_read_at": now},
        room=conversation_room(cid),
    )
    return jsonify({"message": "ok", "last_read_at": now}), 200


@app.route("/api/groups/<int:cid>/messages", methods=["GET"])
@jwt_required()
def get_group_messages(cid):
    _, err = _require_member(cid)
    if err:
        return err
    cursor.execute(
        """
        SELECT u.username, m.body, m.created_at
        FROM Message m
        JOIN User u ON u.id = m.sender_user_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at, m.id
        """,
        (cid,),
    )
    messages = [{"from": r[0], "message": r[1], "datetime": r[2]} for r in cursor.fetchall()]
    return jsonify({"messages": messages, "read_state": read_state(cid)})


@app.route("/api/groups/<int:cid>/messages", methods=["POST"])
@jwt_required()
def post_group_message(cid):
    uid, err = _require_member(cid)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    body = data.get("body")
    if not isinstance(body, str) or not body.strip():
        return jsonify({"error": "body required"}), 400
    body = body.strip()
    now = _utc_now_iso()
    cursor.execute(
        "INSERT INTO Message (conversation_id, sender_user_id, body, created_at) "
        "VALUES (?, ?, ?, ?)",
        (cid, uid, body, now),
    )
    connection.commit()
    # Persistence only; live delivery is the socket send_message path
    # (emits to the conversation room, excluding the sender).
    cursor.execute("SELECT title FROM Conversation WHERE id=?", (cid,))
    _t = cursor.fetchone()
    gtitle = (_t[0] if _t else None) or "Group"
    sender = get_jwt_identity()
    for m in group_members(cid):
        if m["username"] != sender:
            muid = _uid(m["username"])
            if muid is not None:
                send_push_to_user(muid, {
                    "title": gtitle,
                    "body": f"{sender}: {body[:120]}",
                    "conversationKey": f"conv:{cid}",
                    "kind": "group",
                    "url": "/",
                })
    return jsonify({"message": "ok", "datetime": now}), 201
