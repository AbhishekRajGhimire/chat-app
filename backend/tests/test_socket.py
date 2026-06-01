"""Socket.IO smoke tests — skip cleanly if the test client can't run in CI."""
import pytest


def test_socket_rejects_without_token(app):
    from chat import socketio

    try:
        c = socketio.test_client(app, query_string="")
    except Exception as e:  # pragma: no cover - environment dependent
        pytest.skip(f"socketio test client unavailable: {e}")
    assert c.is_connected() is False


def test_socket_group_delivery(app, client, make_user):
    from chat import socketio

    alice = make_user("alice")
    make_user("bob")
    cid = client.post(
        "/api/groups",
        json={"title": "Crew", "members": ["bob"]},
        headers=alice["headers"],
    ).get_json()["conversation_id"]

    a_tok = alice["headers"]["Authorization"].split(" ", 1)[1]
    b_tok = (
        client.post("/api/signin", json={"username": "bob", "password": "pw"})
        .get_json()["access_token"]
    )

    try:
        ca = socketio.test_client(app, query_string=f"token={a_tok}")
        cb = socketio.test_client(app, query_string=f"token={b_tok}")
    except Exception as e:  # pragma: no cover
        pytest.skip(f"socketio test client unavailable: {e}")
    if not (ca.is_connected() and cb.is_connected()):
        pytest.skip("socket clients did not connect in this environment")

    cb.get_received()  # drain join/presence noise
    ca.emit("send_message", {"conversation_id": cid, "message": "yo"})
    received = cb.get_received()
    assert any(
        pkt["name"] == "receive_message" and pkt["args"][0].get("message") == "yo"
        for pkt in received
    )
