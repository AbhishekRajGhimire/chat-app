import sqlite3
# Task 1: Initialize SQLite Connection here
# NOTE: For local testing we keep a single connection (check_same_thread=False)
# so Flask + SocketIO handlers can share it.
connection = sqlite3.connect('chat.db', check_same_thread=False)
cursor = connection.cursor()

# Task 2: Add database tables here
cursor.execute ('''
        CREATE TABLE IF NOT EXISTS User (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
            )
            ''')
        
    
cursor.execute('''
        CREATE TABLE IF NOT EXISTS Message (
            id INTEGER PRIMARY KEY,
            sender_id INTEGER NOT NULL,
            recipient_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            timestamp DATETIME NOT NULL,
            FOREIGN KEY (sender_id) REFERENCES User (id),
            FOREIGN KEY (recipient_id) REFERENCES User (id)
        )
    ''')

connection.commit()