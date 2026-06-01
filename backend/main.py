import os

from chat import DEBUG, app, socketio

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    host = os.environ.get("HOST", "0.0.0.0")
    socketio.run(app, debug=DEBUG, port=port, host=host)