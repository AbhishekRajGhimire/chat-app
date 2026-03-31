from flask import request, jsonify
from flask_bcrypt import Bcrypt
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity
import sqlite3

from chat import app, jwt, online_users

# Task 1: Import database connection instance here
from .database import connection, cursor

bcrypt = Bcrypt(app)

# Task 3: Add /api/signup route here
@app.route('/api/signup', methods = ['POST'])
def signup():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    if not username or not password:
        return jsonify({'error' : 'Invalid data'}), 400
    cursor.execute("SELECT * FROM User WHERE username=?", (username,))
    result = cursor.fetchone()
    hashed_password = bcrypt.generate_password_hash(password).decode('utf-8')
    if result:
        return 'Username already exists', 409

    cursor.execute(
        "INSERT INTO User (username,password) VALUES (?, ?)",
        (username, hashed_password),
    )
    new_id = cursor.lastrowid
    cursor.execute(
        """
        INSERT INTO UserProfile (user_id, display_name, updated_at)
        VALUES (?, ?, datetime('now'))
        """,
        (new_id, username),
    )
    connection.commit()
    response = jsonify({'message': 'User created successfully'}), 201
    return response
# Task 3: Add /api/signin route here
@app.route('/api/signin', methods = ['POST'])
def signin():
    data = request.get_json()
    username = data.get('username')
    password = data.get('password')
    if not username or not password:
        return jsonify({'error' : 'Invalid data'}), 400
    cursor.execute("SELECT * FROM User WHERE username=?", (username,))
    user = cursor.fetchone()
    connection.commit()
    if user and bcrypt.check_password_hash(user[2], password):
        access_token = create_access_token(identity=username)
        response = jsonify({'message': 'Login successful', 'access_token': access_token, 'username': username})
        for user_tuple in online_users:
            if user_tuple[0] == username:
                online_users.remove(user_tuple)
        online_users.append((username, ""))
        print("online",online_users)
        return response, 200
    else:
        return jsonify({'error': 'Invalid credentials'}), 401

# Task 3: Add /api/signout route here
@app.route('/api/signout', methods=['POST'])
@jwt_required()
def signout():
    response = jsonify({'message': 'Logged out successfully'})
    for user_tuple in online_users:
        if user_tuple[0] == get_jwt_identity():
            online_users.remove(user_tuple)
            break
    return response, 200