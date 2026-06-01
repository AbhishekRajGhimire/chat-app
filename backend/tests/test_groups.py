def _make_group(client, owner, title="Crew", members=None):
    return client.post(
        "/api/groups",
        json={"title": title, "members": members or []},
        headers=owner["headers"],
    )


def test_create_group(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    r = _make_group(client, alice, members=["bob"])
    assert r.status_code == 201
    g = r.get_json()
    assert g["title"] == "Crew"
    assert g["member_count"] == 2
    assert {m["username"] for m in g["members"]} == {"alice", "bob"}


def test_non_member_forbidden(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    cid = _make_group(client, alice, members=["bob"]).get_json()["conversation_id"]
    carol = make_user("carol")
    assert client.get(f"/api/groups/{cid}", headers=carol["headers"]).status_code == 403
    assert (
        client.post(
            f"/api/groups/{cid}/messages",
            json={"body": "x"},
            headers=carol["headers"],
        ).status_code
        == 403
    )


def test_add_remove_leave(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    make_user("carol")
    cid = _make_group(client, alice, members=["bob"]).get_json()["conversation_id"]
    add = client.post(
        f"/api/groups/{cid}/members",
        json={"members": ["carol"]},
        headers=alice["headers"],
    ).get_json()
    assert {m["username"] for m in add["members"]} == {"alice", "bob", "carol"}
    rem = client.delete(
        f"/api/groups/{cid}/members/bob", headers=alice["headers"]
    ).get_json()
    assert "bob" not in {m["username"] for m in rem["members"]}
    client.post(f"/api/groups/{cid}/leave", headers=alice["headers"])
    assert client.get(f"/api/groups/{cid}", headers=alice["headers"]).status_code == 403


def test_group_message_persists(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    cid = _make_group(client, alice, members=["bob"]).get_json()["conversation_id"]
    assert (
        client.post(
            f"/api/groups/{cid}/messages",
            json={"body": "hello crew"},
            headers=alice["headers"],
        ).status_code
        == 201
    )
    msgs = client.get(f"/api/groups/{cid}/messages", headers=alice["headers"]).get_json()
    assert any(m["message"] == "hello crew" for m in msgs)


def test_chats_history_includes_dms_and_groups(client, make_user):
    alice = make_user("alice")
    make_user("bob")
    client.post(
        "/api/dm/messages",
        json={"to_username": "bob", "body": "hi"},
        headers=alice["headers"],
    )
    _make_group(client, alice, members=["bob"], title="Crew")
    hist = client.get("/api/chats_history", headers=alice["headers"]).get_json()
    kinds = {e["kind"] for e in hist}
    assert "direct" in kinds and "group" in kinds
    grp = next(e for e in hist if e["kind"] == "group")
    assert grp["title"] == "Crew" and "conversation_id" in grp
