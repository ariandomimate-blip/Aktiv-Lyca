import os
import subprocess
import threading
import time

import requests
from flask import Flask, request, Response

app = Flask(__name__)

NODE_PORT = int(os.environ.get("LYCA_NODE_PORT", "10001"))
NODE_URL = f"http://127.0.0.1:{NODE_PORT}"
_start_lock = threading.Lock()
_node_process = None

def ensure_node_server():
    global _node_process
    with _start_lock:
        if _node_process is not None and _node_process.poll() is None:
            return
        env = os.environ.copy()
        env["PORT"] = str(NODE_PORT)
        _node_process = subprocess.Popen(
            ["node", "telegram-start-patch.js"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )
        # telegram-start-patch.js exits after patching; start the real server next.
        try:
            _node_process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            _node_process.kill()
        _node_process = subprocess.Popen(
            ["node", "server.js"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )

def proxy():
    ensure_node_server()
    body = request.get_data()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in {"host", "content-length", "connection"}
    }
    try:
        r = requests.request(
            method=request.method,
            url=NODE_URL + request.full_path,
            headers=headers,
            data=body,
            allow_redirects=False,
            timeout=120,
        )
        response_headers = [
            (k, v) for k, v in r.headers.items()
            if k.lower() not in {"content-length", "connection", "transfer-encoding"}
        ]
        return Response(r.content, status=r.status_code, headers=response_headers)
    except requests.RequestException as exc:
        return Response(
            "Lyca Webshop startet noch – bitte kurz erneut laden.\n" + str(exc),
            status=503,
            content_type="text/plain; charset=utf-8",
        )

@app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
@app.route("/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
def gateway(path):
    return proxy()

# Start the Node webshop when Gunicorn imports this WSGI application.
ensure_node_server()
