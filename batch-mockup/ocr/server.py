"""OCR over HTTP for the web service and workers, run on a separate machine.

POST /read with header "Authorization: Bearer $OCR_TOKEN" and JSON {"images": [{"data": base64, "ext": ".png"}]}
answers {"lines": [[{"text", "score"}], ...]} in image order. GET /health answers {"ok": true}.
One recognition runs at a time: the engine is not thread-safe and each image may briefly use about 1.5 GB.

    OCR_TOKEN=... OCR_PORT=8866 python server.py
"""
import base64, hmac, json, os, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from read_text import read

TOKEN = os.environ["OCR_TOKEN"]
MAX_BODY = 40 * 1024 * 1024
ALLOWED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
engine_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def answer(self, status, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.answer(200, {"ok": True}) if self.path == "/health" else self.answer(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/read":
            return self.answer(404, {"error": "not found"})
        if not hmac.compare_digest(self.headers.get("Authorization", ""), f"Bearer {TOKEN}"):
            return self.answer(401, {"error": "unauthorized"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BODY:
            return self.answer(413, {"error": "body too large or empty"})
        try:
            images = json.loads(self.rfile.read(length))["images"]
            assert isinstance(images, list) and 0 < len(images) <= 30
        except Exception:
            return self.answer(400, {"error": "bad request"})
        with tempfile.TemporaryDirectory() as folder:
            paths = []
            for n, image in enumerate(images):
                ext = str(image.get("ext", ".png")).lower()
                if ext not in ALLOWED_EXT:
                    return self.answer(400, {"error": f"unsupported image type {ext}"})
                path = os.path.join(folder, f"{n}{ext}")
                with open(path, "wb") as f:
                    f.write(base64.b64decode(image["data"]))
                paths.append(path)
            with engine_lock:
                lines = [read(p) for p in paths]
        self.answer(200, {"lines": lines})

    def log_message(self, fmt, *args):  # no image names or tokens in the log
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("OCR_PORT", "8866"))), Handler).serve_forever()
