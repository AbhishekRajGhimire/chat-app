"""JWT-scoped profile APIs. Identity comes from the token, not the request body."""
import datetime
from typing import Any, Dict, Optional, Tuple

from flask import jsonify, request, send_file
from flask_jwt_extended import decode_token, get_jwt_identity, jwt_required

from chat import app
from . import storage
from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _avatar_path(username: str, avatar_key) -> str | None:
    """Public, cache-busted avatar URL path (or None). Caller appends &token=."""
    if not avatar_key:
        return None
    return f"/api/avatars/{username}?v={avatar_key[:8]}"


def _ensure_profile_row(user_id: int, username: str) -> None:
    cursor.execute("SELECT 1 FROM UserProfile WHERE user_id=?", (user_id,))
    if cursor.fetchone():
        return
    cursor.execute(
        """
        INSERT INTO UserProfile (user_id, display_name, updated_at)
        VALUES (?, ?, ?)
        """,
        (user_id, username, _utc_now_iso()),
    )
    connection.commit()


def _row_to_public(username: str, prof_row: Optional[Tuple]) -> Dict[str, Any]:
    if not prof_row:
        return {"username": username, "display_name": username,
                "avatar_url": None, "bio": None, "updated_at": None}
    dn, _legacy_url, bio, up, avatar_key = prof_row
    return {
        "username": username,
        "display_name": (dn or "").strip() or username,
        "avatar_url": _avatar_path(username, avatar_key),
        "bio": bio,
        "updated_at": up,
    }


@app.route("/api/me/profile", methods=["GET"])
@jwt_required()
def get_my_profile():
    me = get_jwt_identity()
    cursor.execute("SELECT id, username FROM User WHERE username=?", (me,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    cursor.execute(
        """
        SELECT display_name, avatar_url, bio, updated_at, avatar_key
        FROM UserProfile WHERE user_id=?
        """,
        (user_id,),
    )
    prof = cursor.fetchone()
    return jsonify(_row_to_public(username, prof))


@app.route("/api/me/profile", methods=["PATCH"])
@jwt_required()
def patch_my_profile():
    me = get_jwt_identity()
    cursor.execute("SELECT id, username FROM User WHERE username=?", (me,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        return jsonify({"error": "Invalid JSON body"}), 400

    _ensure_profile_row(user_id, username)
    cursor.execute(
        "SELECT display_name, avatar_url, bio FROM UserProfile WHERE user_id=?",
        (user_id,),
    )
    cur = cursor.fetchone()
    display_name, avatar_url, bio = cur[0], cur[1], cur[2]

    if "display_name" in data:
        v = data["display_name"]
        display_name = None if v is None else str(v)
    if "avatar_url" in data:
        v = data["avatar_url"]
        avatar_url = None if v is None else str(v)
    if "bio" in data:
        v = data["bio"]
        bio = None if v is None else str(v)

    now = _utc_now_iso()
    cursor.execute(
        """
        UPDATE UserProfile
        SET display_name=?, avatar_url=?, bio=?, updated_at=?
        WHERE user_id=?
        """,
        (display_name, avatar_url, bio, now, user_id),
    )
    connection.commit()

    cursor.execute(
        """
        SELECT display_name, avatar_url, bio, updated_at, avatar_key
        FROM UserProfile WHERE user_id=?
        """,
        (user_id,),
    )
    return jsonify(_row_to_public(username, cursor.fetchone()))


def _avatar_key_for(user_id):
    cursor.execute("SELECT avatar_key, avatar_mime FROM UserProfile WHERE user_id=?", (user_id,))
    row = cursor.fetchone()
    return (row[0], row[1]) if row else (None, None)


@app.route("/api/me/avatar", methods=["POST"])
@jwt_required()
def upload_my_avatar():
    me = get_jwt_identity()
    cursor.execute("SELECT id, username FROM User WHERE username=?", (me,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    f = request.files.get("file")
    if not f or not f.filename:
        return jsonify({"error": "file required"}), 400
    mime = f.mimetype or ""
    if not mime.startswith("image/"):
        return jsonify({"error": "image required"}), 400
    _ensure_profile_row(user_id, username)
    old_key, _old_mime = _avatar_key_for(user_id)
    key, _size = storage.save(f)
    cursor.execute(
        "UPDATE UserProfile SET avatar_key=?, avatar_mime=?, updated_at=? WHERE user_id=?",
        (key, mime, _utc_now_iso(), user_id),
    )
    connection.commit()
    if old_key:
        storage.delete(old_key)
    cursor.execute("SELECT display_name, avatar_url, bio, updated_at, avatar_key FROM UserProfile WHERE user_id=?", (user_id,))
    return jsonify(_row_to_public(username, cursor.fetchone()))


@app.route("/api/me/avatar", methods=["DELETE"])
@jwt_required()
def delete_my_avatar():
    me = get_jwt_identity()
    cursor.execute("SELECT id, username FROM User WHERE username=?", (me,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    old_key, _ = _avatar_key_for(user_id)
    cursor.execute("UPDATE UserProfile SET avatar_key=NULL, avatar_mime=NULL, updated_at=? WHERE user_id=?",
                   (_utc_now_iso(), user_id))
    connection.commit()
    if old_key:
        storage.delete(old_key)
    cursor.execute("SELECT display_name, avatar_url, bio, updated_at, avatar_key FROM UserProfile WHERE user_id=?", (user_id,))
    return jsonify(_row_to_public(username, cursor.fetchone()))


@app.route("/api/avatars/<username>", methods=["GET"])
def serve_avatar(username):
    token = request.args.get("token", "")
    try:
        ok = bool(decode_token(token).get("sub"))
    except Exception:
        ok = False
    if not ok:
        return jsonify({"error": "auth required"}), 401
    cursor.execute(
        "SELECT p.avatar_key, p.avatar_mime FROM User u "
        "JOIN UserProfile p ON p.user_id = u.id WHERE u.username=?",
        (username,),
    )
    row = cursor.fetchone()
    if not row or not row[0]:
        return jsonify({"error": "not found"}), 404
    resp = send_file(storage.open_path(row[0]), mimetype=row[1] or "image/jpeg", as_attachment=False)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


@app.route("/api/users/<target_username>/profile", methods=["GET"])
@jwt_required()
def get_user_public_profile(target_username):
    """Public card for any org user (same fields as directory). JWT required."""
    cursor.execute("SELECT id, username FROM User WHERE username=?", (target_username,))
    row = cursor.fetchone()
    if not row:
        return jsonify({"error": "User not found"}), 404
    user_id, username = row[0], row[1]
    cursor.execute(
        """
        SELECT display_name, avatar_url, bio, updated_at, avatar_key
        FROM UserProfile WHERE user_id=?
        """,
        (user_id,),
    )
    prof = cursor.fetchone()
    return jsonify(_row_to_public(username, prof))
