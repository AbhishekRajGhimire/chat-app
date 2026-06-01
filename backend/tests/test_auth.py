def test_signup_creates_user_and_profile(client):
    r = client.post("/api/signup", json={"username": "alice", "password": "pw"})
    assert r.status_code == 201
    from chat.database import cursor

    cursor.execute("SELECT id FROM User WHERE username='alice'")
    uid = cursor.fetchone()[0]
    cursor.execute("SELECT 1 FROM UserProfile WHERE user_id=?", (uid,))
    assert cursor.fetchone() is not None


def test_duplicate_username_conflicts(client):
    client.post("/api/signup", json={"username": "alice", "password": "pw"})
    r = client.post("/api/signup", json={"username": "alice", "password": "pw2"})
    assert r.status_code == 409


def test_signin_good_and_bad(client):
    client.post("/api/signup", json={"username": "alice", "password": "pw"})
    ok = client.post("/api/signin", json={"username": "alice", "password": "pw"})
    assert ok.status_code == 200 and "access_token" in ok.get_json()
    bad = client.post("/api/signin", json={"username": "alice", "password": "nope"})
    assert bad.status_code == 401


def test_protected_route_requires_token(client):
    r = client.get("/api/chats_history")
    assert r.status_code in (401, 422)
