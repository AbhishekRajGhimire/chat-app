import os
import tempfile

# Set BEFORE importing the app so the DB path + secret-guard use test values.
os.environ["CHAT_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")
os.environ.setdefault("SECRET_KEY", "test-secret")
os.environ.setdefault("JWT_SECRET_KEY", "test-jwt-secret")
os.environ.setdefault("FLASK_DEBUG", "true")
os.environ.setdefault("VAPID_PUBLIC_KEY", "testpub")
os.environ.setdefault("VAPID_PRIVATE_KEY", "testpriv")
os.environ.setdefault("VAPID_SUBJECT", "mailto:test@rojin.local")

import pytest
from chat import app as flask_app
from chat.database import connection, cursor


@pytest.fixture
def app():
    flask_app.config.update(TESTING=True)
    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture(autouse=True)
def clean_db():
    """Wipe all rows between tests (single shared connection → must isolate)."""
    yield
    for table in ("Message", "ConversationMember", "Conversation", "UserProfile", "User"):
        cursor.execute(f"DELETE FROM {table}")
    connection.commit()


@pytest.fixture
def make_user(client):
    """Sign a user up + in; return {username, headers} with a Bearer token."""
    def _make(username="alice", password="pw"):
        client.post("/api/signup", json={"username": username, "password": password})
        resp = client.post("/api/signin", json={"username": username, "password": password})
        token = resp.get_json()["access_token"]
        return {"username": username, "headers": {"Authorization": f"Bearer {token}"}}
    return _make
