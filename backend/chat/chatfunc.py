import datetime
from flask import jsonify, request
from flask_jwt_extended import  jwt_required, get_jwt_identity
from flask_cors import CORS
from flask_socketio import emit, join_room
# Task 1: Import database connection instance here
from .database import connection, cursor

from chat import app ,socketio, online_users, jwt

cors = CORS(app)

# Task 8: Add message routes here
@app.route('/api/post_messages/<recipient>/&/<sender>/&/<message>', methods=['POST'])
def postMessage(recipient,sender,message):
    cursor.execute("SELECT * FROM User WHERE username=?", (sender,))
    sender_user = cursor.fetchone()
    cursor.execute("SELECT * FROM User WHERE username=?", (recipient,))
    recipient_user = cursor.fetchone()
    if not sender_user or not recipient_user:
        return jsonify({'error': 'Unknown sender or recipient'}), 400
    cursor.execute("INSERT INTO Message (sender_id, recipient_id, message, timestamp) VALUES (?,?,?,?)",
                (sender_user[0], recipient_user[0], message, datetime.datetime.now().isoformat()))  # Assuming the first column is the ID
    connection.commit()
    response = jsonify({'message': 'Message posted successfully'}), 201
    return response

@app.route('/api/message_history/<user1>/&/<user2>', methods=['GET'])
def get_message_history(user1, user2):
    cursor.execute("SELECT * FROM User WHERE username=?", (user1,))
    user1_row = cursor.fetchone()
    cursor.execute("SELECT * FROM User WHERE username=?", (user2,))
    user2_row = cursor.fetchone()
    if not user1_row or not user2_row:
        return jsonify([]), 200
    query = '''
        SELECT User.username AS sender, recipient.username AS recipient, Message.message, Message.timestamp
        FROM Message
        JOIN User ON Message.sender_id = User.id
        JOIN User AS recipient ON Message.recipient_id = recipient.id
        WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    '''
    cursor.execute(query, (user1_row[0], user2_row[0], user2_row[0], user1_row[0]))
    messages = cursor.fetchall()
    # Store the messages in the desired format
    formatted_messages = []
    for message in messages:
        formatted_messages.append({
            'from': message[0],  # sender's username
            'to': message[1],    # recipient's username
            'message': message[2],
            'datetime':message[3]
        })

    return jsonify(formatted_messages)


@app.route('/api/chats_history', methods=['GET'])
@jwt_required()
def get_chats_history():
    cursor.execute("SELECT * FROM User WHERE username=?", (get_jwt_identity(),))
    user = cursor.fetchone()
    if not user:
        return jsonify([]), 200
    query = '''
        SELECT DISTINCT User.username
        FROM User
        WHERE id == ? OR (
            id IN (SELECT sender_id FROM Message WHERE sender_id = ? OR recipient_id = ?)
            OR
            id IN (SELECT recipient_id FROM Message WHERE sender_id = ? OR recipient_id = ?)
        )
    '''
    cursor.execute(query, (user[0], user[0], user[0], user[0], user[0]))
    result = cursor.fetchall()
    connection.commit()
    users_with_chat = [row[0] for row in result]
    return jsonify(users_with_chat)


@app.route('/api/directory_users', methods=['GET'])
@jwt_required()
def directory_users():
    """All registered usernames except the current user (for New Chat search)."""
    me = get_jwt_identity()
    cursor.execute(
        'SELECT username FROM User WHERE username != ? ORDER BY username COLLATE NOCASE',
        (me,),
    )
    rows = cursor.fetchall()
    return jsonify([row[0] for row in rows])


# Task 9: Handle Socket.IO connection and sent messages here
@socketio.on('connect')
def on_connect():
    print('socket connect', request.sid)


@socketio.on('join_user')
def on_join_user(data):
    """Client sends logged-in username; join a room named after them for reliable DM delivery."""
    username = (data or {}).get('username')
    if not username or not isinstance(username, str):
        return
    username = username.strip()
    if not username:
        return
    join_room(username)
    updated = False
    for index, user_tuple in enumerate(online_users):
        if user_tuple[0] == username:
            online_users[index] = (username, request.sid)
            updated = True
            break
    if not updated:
        online_users.append((username, request.sid))
    print('join_user', username, request.sid, online_users)
    emit('online_users', online_users, broadcast=True)


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    for index, user_tuple in enumerate(online_users):
        if user_tuple[1] == sid:
            online_users[index] = (user_tuple[0], '')
            break
    emit('online_users', online_users, broadcast=True)


@socketio.on('send_message')
def handle_message(data):
    data = data or {}
    sender = data.get('from')
    message = data.get('message')
    if not isinstance(sender, str) or not sender.strip():
        return
    sender = sender.strip()
    if message is None or not isinstance(message, str):
        return
    recipient = data.get('recipient')
    if isinstance(recipient, str):
        recipient = recipient.strip() or None
    else:
        recipient = None
    if not recipient and not data.get('recipientsid'):
        return
    payload = {
        'username': sender,
        'message': message,
        'datetime': datetime.datetime.now().isoformat(),
    }
    if recipient:
        emit('receive_message', payload, room=recipient)
    else:
        recipientsid = data.get('recipientsid')
        if recipientsid:
            emit('receive_message', payload, room=recipientsid)

