import datetime
import json

from flask import jsonify, request
from flask_jwt_extended import get_jwt_identity, jwt_required

from chat import app, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
from .database import connection, cursor

try:
    from pywebpush import webpush, WebPushException
except ImportError:  # pragma: no cover
    webpush = None
    class WebPushException(Exception):
        pass


def _uid(username):
    cursor.execute("SELECT id FROM User WHERE username=?", (username,))
    r = cursor.fetchone()
    return int(r[0]) if r else None


@app.route("/api/push/vapid-key", methods=["GET"])
@jwt_required()
def vapid_key():
    return jsonify({"publicKey": VAPID_PUBLIC_KEY or None})


@app.route("/api/push/subscribe", methods=["POST"])
@jwt_required()
def push_subscribe():
    uid = _uid(get_jwt_identity())
    data = request.get_json(silent=True) or {}
    sub = data.get("subscription") or {}
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    if uid is None or not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        return jsonify({"error": "invalid subscription"}), 400
    cursor.execute(
        "INSERT INTO PushSubscription (user_id, endpoint, p256dh, auth, created_at) "
        "VALUES (?,?,?,?,?) "
        "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, "
        "p256dh=excluded.p256dh, auth=excluded.auth",
        (uid, endpoint, keys["p256dh"], keys["auth"],
         datetime.datetime.now(datetime.timezone.utc).isoformat()),
    )
    connection.commit()
    return jsonify({"message": "subscribed"}), 201


@app.route("/api/push/unsubscribe", methods=["POST"])
@jwt_required()
def push_unsubscribe():
    data = request.get_json(silent=True) or {}
    endpoint = data.get("endpoint")
    if endpoint:
        cursor.execute("DELETE FROM PushSubscription WHERE endpoint=?", (endpoint,))
        connection.commit()
    return jsonify({"message": "unsubscribed"}), 200


def send_push_to_user(user_id, payload):
    if not (VAPID_PRIVATE_KEY and VAPID_PUBLIC_KEY) or webpush is None:
        return
    cursor.execute(
        "SELECT endpoint, p256dh, auth FROM PushSubscription WHERE user_id=?",
        (user_id,),
    )
    for endpoint, p256dh, auth in cursor.fetchall():
        try:
            webpush(
                subscription_info={"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}},
                data=json.dumps(payload),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT or "mailto:admin@rojin.local"},
            )
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):
                cursor.execute("DELETE FROM PushSubscription WHERE endpoint=?", (endpoint,))
                connection.commit()
        except Exception:
            pass
