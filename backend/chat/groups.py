"""Group conversation REST endpoints (flat membership: any member can manage)."""
import datetime

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app, socketio
from .chatfunc import add_user_to_live_room
from .conversations import (
    add_group_member,
    attachments_for,
    conversation_room,
    create_group_conversation,
    group_avatar_path,
    group_members,
    is_member,
    link_attachments,
    mark_read,
    read_state,
    remove_group_member,
    serialize_messages,
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
    cursor.execute("SELECT title, avatar_key FROM Conversation WHERE id=? AND type='group'", (cid,))
    row = cursor.fetchone()
    members = group_members(cid)
    return {
        "kind": "group",
        "conversation_id": cid,
        "title": (row[0] if row else None) or "Group",
        "avatar_url": group_avatar_path(cid, row[1] if row else None),
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
    uid, err = _require_member(cid)
    if err:
        return err
    return jsonify({"messages": serialize_messages(cid, uid), "read_state": read_state(cid)})


@app.route("/api/groups/<int:cid>/messages", methods=["POST"])
@jwt_required()
def post_group_message(cid):
    uid, err = _require_member(cid)
    if err:
        return err
    data = request.get_json(silent=True) or {}
    body = data.get("body")
    attachment_ids = data.get("attachment_ids") or []
    if not isinstance(attachment_ids, list):
        attachment_ids = []
    has_body = isinstance(body, str) and body.strip()
    if not has_body and not attachment_ids:
        return jsonify({"error": "body or attachment required"}), 400
    body = body.strip() if isinstance(body, str) else ""
    now = _utc_now_iso()
    cmid = data.get("client_message_id")
    cmid = cmid.strip() if isinstance(cmid, str) and cmid.strip() else None
    reply_to = data.get("reply_to")
    reply_to = reply_to.strip() if isinstance(reply_to, str) and reply_to.strip() else None
    cursor.execute(
        "INSERT INTO Message "
        "(conversation_id, sender_user_id, body, created_at, client_message_id, reply_to) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (cid, uid, body, now, cmid, reply_to),
    )
    connection.commit()
    link_attachments(cmid, cid, attachment_ids, uid)
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
    return jsonify({"message": "ok", "datetime": now, "client_message_id": cmid,
                    "attachments": attachments_for(cmid)}), 201
