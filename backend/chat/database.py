import sqlite3
# Task 1: Initialize SQLite Connction here
connection = sqlite3.connect('chat.db',check_same_thread = flase)
cursor = connection.cursor

# Task 2: Add database tables here
cursor.execute ('''
        CREATE TABLE IF NOT EXISTS User (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL
            )
            ''')
        
    
cursor.execute('''
        CREATE TABLE IF NOT EXISTS Messages
            id PRIMARY KEY,
            sender_id INTEGER NOT NULL,
            recipient_id INTEGER NOT NULL,
            message TEXT NOT NULL,
            timestamp DATETIME NOT NULL,
            FOREIGN KEY (sender_id) REFERENCES user (id),
            FOREIGN KEY (recipient_id) REFERENCES user (id)
        )
    ''')

connection.commit()