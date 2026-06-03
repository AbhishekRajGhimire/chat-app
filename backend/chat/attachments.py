"""Attachment upload + serve. Bytes go through chat.storage; access is
membership-checked via the linked message's conversation."""
import datetime

from flask import jsonify, request, send_file
from flask_jwt_extended import decode_token, get_jwt_identity, jwt_required

from chat import app
from . import storage
from .conversations import is_member
from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _uid(username):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    row = cursor.fetchone()
    return int(row[0]) if row else None


@app.route("/api/attachments", methods=["POST"])
@jwt_required()
def upload_attachment():
    me = _uid(get_jwt_identity())
    if me is None:
        return jsonify({"error": "User not found"}), 404
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    key, size = storage.save(f)
    mime = f.mimetype or "application/octet-stream"
    kind = "image" if mime.startswith("image/") else "file"
    cursor.execute(
        "INSERT INTO MessageAttachment "
        "(uploader_user_id, storage_key, filename, mime, size, kind, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (me, key, f.filename, mime, size, kind, _utc_now_iso()),
    )
    connection.commit()
    return jsonify({"id": cursor.lastrowid, "filename": f.filename,
                    "mime": mime, "size": size, "kind": kind}), 201


def _username_from_token(token):
    try:
        sub = decode_token(token).get("sub")
        return sub.strip() if isinstance(sub, str) and sub.strip() else None
    except Exception:
        return None


@app.route("/api/attachments/<int:aid>", methods=["GET"])
def serve_attachment(aid):
    token = request.args.get("token", "")
    username = _username_from_token(token)
    me = _uid(username) if username else None
    if me is None:
        return jsonify({"error": "auth required"}), 401
    cursor.execute(
        "SELECT storage_key, filename, mime, kind, conversation_id "
        "FROM MessageAttachment "
        "WHERE id = ?",
        (aid,),
    )
    row = cursor.fetchone()
    if not row or row[4] is None:
        return jsonify({"error": "not found"}), 404
    storage_key, filename, mime, kind, conv_id = row
    if not is_member(int(conv_id), me):
        return jsonify({"error": "forbidden"}), 403
    resp = send_file(storage.open_path(storage_key), mimetype=mime,
                     as_attachment=(kind != "image"), download_name=filename)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp
