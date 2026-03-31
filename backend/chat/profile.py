"""JWT-scoped profile APIs. Identity comes from the token, not the request body."""
import datetime
from typing import Any, Dict, Optional, Tuple

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app
from .database import connection, cursor


def _utc_now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


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
        return {
            "username": username,
            "display_name": username,
            "avatar_url": None,
            "bio": None,
            "updated_at": None,
        }
    dn, au, bio, up = prof_row
    display = (dn or "").strip() or username
    return {
        "username": username,
        "display_name": display,
        "avatar_url": au,
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
        SELECT display_name, avatar_url, bio, updated_at
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
        SELECT display_name, avatar_url, bio, updated_at
        FROM UserProfile WHERE user_id=?
        """,
        (user_id,),
    )
    return jsonify(_row_to_public(username, cursor.fetchone()))


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
        SELECT display_name, avatar_url, bio, updated_at
        FROM UserProfile WHERE user_id=?
        """,
        (user_id,),
    )
    prof = cursor.fetchone()
    return jsonify(_row_to_public(username, prof))
