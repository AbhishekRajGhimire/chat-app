def test_dm_post_and_history(client, make_user):
    alice = make_user("alice")
    bob = make_user("bob")
    r = client.post(
        "/api/dm/messages",
        json={"to_username": "bob", "body": "hi bob"},
        headers=alice["headers"],
    )
    assert r.status_code == 201
    a_hist = client.get("/api/dm/messages/bob", headers=alice["headers"]).get_json()
    b_hist = client.get("/api/dm/messages/alice", headers=bob["headers"]).get_json()
    assert any(m["message"] == "hi bob" for m in a_hist)
    assert any(m["message"] == "hi bob" for m in b_hist)


def test_cannot_message_self(client, make_user):
    alice = make_user("alice")
    r = client.post(
        "/api/dm/messages",
        json={"to_username": "alice", "body": "x"},
        headers=alice["headers"],
    )
    assert r.status_code == 400


def test_unknown_recipient(client, make_user):
    alice = make_user("alice")
    r = client.post(
        "/api/dm/messages",
        json={"to_username": "ghost", "body": "x"},
        headers=alice["headers"],
    )
    assert r.status_code == 400


def test_third_user_cannot_see_pair_messages(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    carol = make_user("carol")
    client.post(
        "/api/dm/messages",
        json={"to_username": "bob", "body": "secret"},
        headers=alice["headers"],
    )
    hist = client.get("/api/dm/messages/alice", headers=carol["headers"]).get_json()
    assert all(m["message"] != "secret" for m in hist)
