def test_vapid_key(client, make_user):
    alice = make_user("alice")
    body = client.get("/api/push/vapid-key", headers=alice["headers"]).get_json()
    assert body["publicKey"] == "testpub"


def test_subscribe_unsubscribe(client, make_user):
    alice = make_user("alice")
    sub = {"subscription": {"endpoint": "https://push/ep1", "keys": {"p256dh": "k", "auth": "a"}}}
    assert client.post("/api/push/subscribe", json=sub, headers=alice["headers"]).status_code == 201
    from chat.database import cursor
    cursor.execute("SELECT COUNT(*) FROM PushSubscription WHERE endpoint='https://push/ep1'")
    assert cursor.fetchone()[0] == 1
    client.post("/api/push/subscribe", json=sub, headers=alice["headers"])
    cursor.execute("SELECT COUNT(*) FROM PushSubscription WHERE endpoint='https://push/ep1'")
    assert cursor.fetchone()[0] == 1
    client.post("/api/push/unsubscribe", json={"endpoint": "https://push/ep1"}, headers=alice["headers"])
    cursor.execute("SELECT COUNT(*) FROM PushSubscription WHERE endpoint='https://push/ep1'")
    assert cursor.fetchone()[0] == 0


def test_push_requires_auth(client):
    assert client.get("/api/push/vapid-key").status_code in (401, 422)
