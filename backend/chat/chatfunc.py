import datetime
from flask import jsonify, request
from flask_jwt_extended import  jwt_required, get_jwt_identity
from flask_cors import CORS
from flask_socketio import emit
# Task 1: Import database connection instance here
from .database import connection, cursor

from chat import app ,socketio, online_users, jwt

cors = CORS(app)

# Task 8: Add message routes here
@app.route('/api/post_messages/<recipient>/&/<sender>/&/<message>', methods=['POST'])
def postMessage(recipient,sender,message):
    cursor.execute("SELECT * FROM User WHERE username=?", (sender,))
    sender = cursor.fetchone()
    cursor.execute("SELECT * FROM User WHERE username=?", (recipient,))
    recipient_user = cursor.fetchone()
    cursor.execute("INSERT INTO Message (sender_id, recipient_id, message, timestamp) VALUES (?,?,?,?)",
                (sender[0], recipient_user[0],message, datetime.datetime.now().isoformat() ))  # Assuming the first column is the ID
    connection.commit()
    response = jsonify({'message': 'Message posted successfully'}), 201
    return response

@app.route('/api/message_history/<user1>/&/<user2>', methods=['GET'])
def get_message_history(recipient, sender):
    cursor.execute("SELECT * FROM User WHERE username=?", (user1,))
    user1 = cursor.fetchone()
    cursor.execute("SELECT * FROM User WHERE username=?", (user2,))
    user2 = cursor.fetchone()
    query = '''
        SELECT User.username AS sender, recipient.username AS recipient, Message.message, Message.timestamp
        FROM Message
        JOIN User ON Message.sender_id = User.id
        JOIN User AS recipient ON Message.recipient_id = recipient.id
        WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    '''
    cursor.execute(query, (user1[0], user2[0], user2[0], user1[0]))
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
    return users_with_chat
# Task 9: Handle Socket.IO connection and sent messages here
@socketio.on('connect')
def on_connect():
    print("id", request.sid)
    for index, user_tuple in enumerate(online_users):
        if user_tuple[1] == '':
            online_users[index] = (user_tuple[0], request.sid)
            break
    print(online_users)
    emit('online_users', online_users, broadcast=True)


@socketio.on('send_message')
def handle_message(data):
    username = data['from']
    message = data['message']
    recipientsid = data["recipientsid"]
    print("message", message)
    emit('receive_message', {'username': username, 'message': message, 'datetime':datetime.datetime.now().isoformat()}, room = recipientsid)

