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


def test_send_push_targets_subs_and_prunes(client, make_user, monkeypatch):
    import chat.push as push
    alice = make_user("alice")
    for ep in ("https://push/a", "https://push/b"):
        client.post("/api/push/subscribe",
                    json={"subscription": {"endpoint": ep, "keys": {"p256dh": "k", "auth": "a"}}},
                    headers=alice["headers"])
    from chat.database import cursor
    cursor.execute("SELECT id FROM User WHERE username='alice'"); aid = cursor.fetchone()[0]

    calls = []
    class FakeResp:
        status_code = 410
    class FakeExc(Exception):
        response = FakeResp()
    def fake_webpush(subscription_info, data, vapid_private_key, vapid_claims):
        calls.append(subscription_info["endpoint"])
        if subscription_info["endpoint"].endswith("/b"):
            raise FakeExc()
    monkeypatch.setattr(push, "webpush", fake_webpush)
    monkeypatch.setattr(push, "WebPushException", FakeExc)

    push.send_push_to_user(int(aid), {"title": "x", "body": "y"})
    assert set(calls) == {"https://push/a", "https://push/b"}
    cursor.execute("SELECT COUNT(*) FROM PushSubscription WHERE endpoint='https://push/b'")
    assert cursor.fetchone()[0] == 0
