import os

from chat import app, socketio

if __name__ == "__main__":
    _debug = os.environ.get("FLASK_DEBUG", "true").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    port = int(os.environ.get("PORT", "3000"))
    host = os.environ.get("HOST", "0.0.0.0")
    socketio.run(app, debug=_debug, port=port, host=host)