import io
from werkzeug.datastructures import FileStorage

from chat import storage


def test_storage_save_and_read_roundtrip():
    fs = FileStorage(stream=io.BytesIO(b"hello-bytes"), filename="note.txt", content_type="text/plain")
    key, size = storage.save(fs)
    assert key and size == len(b"hello-bytes")
    with open(storage.open_path(key), "rb") as fh:
        assert fh.read() == b"hello-bytes"
    storage.delete(key)
