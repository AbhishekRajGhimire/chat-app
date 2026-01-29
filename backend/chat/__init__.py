from flask import Flask
from flask_socketio import SocketIO
from flask_jwt_extended import JWTManager
app = Flask(__name__)

# socketio instance
socketio = SocketIO(app, cors_allowed_origins='*')

# array to store online users
online_users = []

jwt = JWTManager(app)

from chat import user
from chat import chatfunc
from chat import database
