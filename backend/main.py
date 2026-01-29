from chat import socketio, app

if __name__== '__main__':
    socketio.run(app,debug=True, port=3000, host='0.0.0.0')