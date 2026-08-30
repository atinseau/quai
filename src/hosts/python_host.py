"""Python function host.

Serves a single callable over HTTP, mirroring the Node and Bun hosts: the
developer writes handler(request) and Quai supplies the listening, the
lifecycle and the timeout.
"""

import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HANDLER_PATH = os.environ.get("QUAI_HANDLER", "main.py")
TIMEOUT_SECONDS = int(os.environ.get("QUAI_TIMEOUT_MS", "30000")) / 1000
PORT = int(os.environ.get("PORT", "8080"))


def load_handler():
    spec = importlib.util.spec_from_file_location("quai_function", HANDLER_PATH)
    if spec is None or spec.loader is None:
        sys.exit(f"quai: cannot load {HANDLER_PATH}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    handler = getattr(module, "handler", None)
    if not callable(handler):
        sys.exit(f"quai: {HANDLER_PATH} must define a callable named 'handler'")
    return handler


HANDLER = load_handler()


class FunctionRequestHandler(BaseHTTPRequestHandler):
    def _run(self):
        length = int(self.headers.get("content-length") or 0)
        request = {
            "method": self.command,
            "path": self.path,
            "headers": dict(self.headers),
            "body": self.rfile.read(length).decode("utf-8") if length else "",
        }

        result = {}

        def call():
            try:
                result["value"] = HANDLER(request)
            except Exception as error:  # noqa: BLE001 - reported to the caller
                result["error"] = error

        worker = threading.Thread(target=call, daemon=True)
        worker.start()
        worker.join(TIMEOUT_SECONDS)

        # A stuck call gets a definite answer instead of holding the connection.
        if worker.is_alive():
            self._respond(504, f"Function timed out after {TIMEOUT_SECONDS}s")
            return

        if "error" in result:
            print(result["error"], file=sys.stderr)
            self._respond(500, "Function failed")
            return

        value = result.get("value")
        if isinstance(value, (dict, list)):
            self._respond(200, json.dumps(value), "application/json")
        else:
            self._respond(200, "" if value is None else str(value))

    def _respond(self, status, body, content_type="text/plain; charset=utf-8"):
        encoded = body.encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        pass  # the supervisor already captures output

    do_GET = _run
    do_POST = _run
    do_PUT = _run
    do_DELETE = _run
    do_PATCH = _run


print(f"quai function host listening on {PORT}", flush=True)
ThreadingHTTPServer(("0.0.0.0", PORT), FunctionRequestHandler).serve_forever()
