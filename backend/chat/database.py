import os
import sqlite3
import uuid

# NOTE: For local testing we keep a single connection (check_same_thread=False)
# so Flask + SocketIO handlers can share it. The path is overridable via
# CHAT_DB_PATH (tests point it at a throwaway temp DB); defaults to chat.db.
connection = sqlite3.connect(
    os.environ.get("CHAT_DB_PATH", "chat.db"), check_same_thread=False
)
cursor = connection.cursor()
cursor.execute("PRAGMA foreign_keys = ON")


def _legacy_pairwise_message_table() -> bool:
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='Message'"
    )
    if not cursor.fetchone():
        return False
    cursor.execute("PRAGMA table_info(Message)")
    cols = {row[1] for row in cursor.fetchall()}
    return "recipient_id" in cols and "conversation_id" not in cols


def _drop_conversation_schema():
    cursor.executescript(
        """
        DROP TABLE IF EXISTS Message;
        DROP TABLE IF EXISTS ConversationMember;
        DROP TABLE IF EXISTS Conversation;
        """
    )


def _create_conversation_schema():
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS User (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS Conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
            title TEXT,
            created_at TEXT NOT NULL,
            created_by_user_id INTEGER REFERENCES User(id),
            dm_user_low_id INTEGER REFERENCES User(id),
            dm_user_high_id INTEGER REFERENCES User(id),
            CHECK (
                (type = 'direct' AND dm_user_low_id IS NOT NULL
                 AND dm_user_high_id IS NOT NULL
                 AND dm_user_low_id < dm_user_high_id)
                OR (type = 'group' AND dm_user_low_id IS NULL
                    AND dm_user_high_id IS NULL)
            )
        )
        """
    )
    cursor.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS ux_conversation_direct_pair
        ON Conversation(dm_user_low_id, dm_user_high_id)
        WHERE type = 'direct'
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS ConversationMember (
            conversation_id INTEGER NOT NULL REFERENCES Conversation(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            role TEXT NOT NULL DEFAULT 'member'
                CHECK (role IN ('owner', 'admin', 'member')),
            joined_at TEXT NOT NULL,
            last_read_at TEXT,
            PRIMARY KEY (conversation_id, user_id)
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS Message (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL REFERENCES Conversation(id) ON DELETE CASCADE,
            sender_user_id INTEGER NOT NULL REFERENCES User(id),
            body TEXT NOT NULL,
            created_at TEXT NOT NULL,
            client_message_id TEXT,
            reply_to TEXT,
            edited_at TEXT,
            deleted_at TEXT
        )
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_message_conv_created
        ON Message(conversation_id, created_at)
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS MessageReaction (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_message_id TEXT NOT NULL,
            user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            emoji TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (client_message_id, user_id, emoji)
        )
        """
    )
    cursor.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_reaction_cmid
        ON MessageReaction(client_message_id)
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS MessageAttachment (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            client_message_id TEXT,
            conversation_id INTEGER REFERENCES Conversation(id) ON DELETE CASCADE,
            uploader_user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL,
            filename TEXT NOT NULL,
            mime TEXT NOT NULL,
            size INTEGER NOT NULL,
            kind TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    cursor.execute(
        "CREATE INDEX IF NOT EXISTS ix_attachment_cmid ON MessageAttachment(client_message_id)"
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS UserProfile (
            user_id INTEGER PRIMARY KEY,
            display_name TEXT,
            avatar_url TEXT,
            bio TEXT,
            updated_at TEXT,
            FOREIGN KEY (user_id) REFERENCES User(id) ON DELETE CASCADE
        )
        """
    )
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS PushSubscription (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES User(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )


def _backfill_client_message_ids():
    """Give every message a stable public id (UUID) so it can be reacted to /
    edited / deleted. Runs once for rows predating the client_message_id era."""
    cursor.execute(
        "SELECT id FROM Message WHERE client_message_id IS NULL OR client_message_id = ''"
    )
    rows = cursor.fetchall()
    for (mid,) in rows:
        cursor.execute(
            "UPDATE Message SET client_message_id=? WHERE id=?",
            (str(uuid.uuid4()), mid),
        )
    if rows:
        connection.commit()


_create_conversation_schema()

if _legacy_pairwise_message_table():
    _drop_conversation_schema()
    _create_conversation_schema()

# Idempotent migration: add last_read_at to ConversationMember on existing DBs.
cursor.execute("PRAGMA table_info(ConversationMember)")
if "last_read_at" not in {row[1] for row in cursor.fetchall()}:
    cursor.execute("ALTER TABLE ConversationMember ADD COLUMN last_read_at TEXT")
    connection.commit()

# Idempotent: add message-action columns to pre-existing Message tables.
cursor.execute("PRAGMA table_info(Message)")
_msg_cols = {row[1] for row in cursor.fetchall()}
for _col in ("reply_to", "edited_at", "deleted_at"):
    if _col not in _msg_cols:
        cursor.execute(f"ALTER TABLE Message ADD COLUMN {_col} TEXT")
connection.commit()

# Give pre-existing messages stable public ids.
_backfill_client_message_ids()

cursor.execute(
    """
    INSERT INTO UserProfile (user_id, display_name, updated_at)
    SELECT u.id, u.username, datetime('now')
    FROM User u
    WHERE NOT EXISTS (
        SELECT 1 FROM UserProfile p WHERE p.user_id = u.id
    )
    """
)

connection.commit()
