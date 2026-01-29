from flask import Flask
from flask_socketio import SocketIO
from flask_jwt_extended import JWTManager
from flask_cors import CORS
app = Flask(__name__)

# Basic config for local testing
app.config['SECRET_KEY'] = 'dev-secret-key'
app.config['JWT_SECRET_KEY'] = 'dev-jwt-secret-key'
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = False
app.config['CORS_SUPPORTS_CREDENTIALS'] = True
CORS(app, supports_credentials=True)

# socketio instance
socketio = SocketIO(app, cors_allowed_origins='*')

# array to store online users
online_users = []

jwt = JWTManager(app)

from chat import user
from chat import chatfunc
from chat import database
