"""Local transport: static HTTP for the UI, WebSocket for live state.

Audio frames go over the socket as raw float32 binary at 60 fps; everything
else (track, lyrics, config, status) travels as JSON text on the same socket.
"""
import asyncio
import json
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import websockets
from websockets.asyncio.server import serve as ws_serve

from . import artcache, icon as icon_mod

FRAME_INTERVAL = 1.0 / 60.0


class _Handler(SimpleHTTPRequestHandler):
    ws_port = 0

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/art/"):
            self._serve_art()
            return
        if self.path.startswith("/config.js"):
            body = f"window.AURORA_WS_PORT = {self.ws_port};\n".encode("utf-8")
            self._send_bytes(body, "application/javascript; charset=utf-8")
            return
        if self.path.startswith("/icon.png") or self.path.startswith("/favicon.ico"):
            _, png = icon_mod.ensure_files()
            self._send_bytes(png.read_bytes(), "image/png", cache=True)
            return
        super().do_GET()

    def _serve_art(self):
        name = self.path[len("/art/"):].split("?")[0]
        path = artcache.path_for(name)
        if path is None:
            self.send_error(404)
            return
        suffix = path.suffix.lower()
        ctype = {
            ".png": "image/png",
            ".webp": "image/webp",
            ".gif": "image/gif",
        }.get(suffix, "image/jpeg")
        self._send_bytes(path.read_bytes(), ctype, cache=True)

    def _send_bytes(self, payload: bytes, ctype: str, cache: bool = False):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header(
            "Cache-Control",
            "public, max-age=86400" if cache else "no-store",
        )
        self.end_headers()
        self.wfile.write(payload)

    def end_headers(self):
        if not self.path.startswith(("/art/", "/icon.png", "/favicon.ico")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


class AuroraServer:
    def __init__(self, web_dir, audio_engine, on_message=None, on_connect=None,
                 http_port=0, ws_port=0):
        self.web_dir = str(web_dir)
        self.audio = audio_engine
        self.on_message = on_message
        self.on_connect = on_connect

        self.http_port = http_port
        self.ws_port = ws_port
        self._want_ws_port = ws_port
        self._clients: set = set()   # display windows: get audio frames
        self._aux: set = set()       # toast window: JSON only
        self._loop = None
        self._httpd = None
        self._ready = threading.Event()

    # ---- lifecycle ----------------------------------------------------

    def start(self) -> str:
        threading.Thread(target=self._run_ws, daemon=True, name="ws-server").start()
        if not self._ready.wait(10):
            raise RuntimeError("WebSocket server failed to start.")

        handler = partial(_Handler, directory=self.web_dir)
        _Handler.ws_port = self.ws_port
        self._httpd = ThreadingHTTPServer(("127.0.0.1", self.http_port), handler)
        self._httpd.daemon_threads = True
        self.http_port = self._httpd.server_address[1]
        threading.Thread(target=self._httpd.serve_forever, daemon=True,
                         name="http-server").start()
        return f"http://127.0.0.1:{self.http_port}/index.html"

    def stop(self):
        if self._httpd:
            threading.Thread(target=self._httpd.shutdown, daemon=True).start()
        if self._loop:
            self._loop.call_soon_threadsafe(self._loop.stop)

    # ---- websocket ----------------------------------------------------

    def _run_ws(self):
        asyncio.run(self._serve())

    async def _serve(self):
        self._loop = asyncio.get_running_loop()
        async with await ws_serve(self._client, "127.0.0.1", self._want_ws_port) as server:
            self.ws_port = server.sockets[0].getsockname()[1]
            self._ready.set()
            await self._pump()

    async def _client(self, websocket):
        try:
            path = websocket.request.path or "/"
        except Exception:
            path = "/"
        role = "toast" if "role=toast" in path else "display"
        pool = self._aux if role == "toast" else self._clients
        pool.add(websocket)
        try:
            if self.on_connect:
                for message in self.on_connect(role) or []:
                    await websocket.send(json.dumps(message))
            async for raw in websocket:
                if isinstance(raw, bytes):
                    continue
                try:
                    data = json.loads(raw)
                except Exception:
                    continue
                if self.on_message:
                    # Handlers may block (network, auth), so keep the loop free.
                    threading.Thread(
                        target=self._safe_handle, args=(data,), daemon=True
                    ).start()
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            pool.discard(websocket)

    def _safe_handle(self, data):
        try:
            self.on_message(data)
        except Exception as exc:
            self.broadcast({"type": "toast", "level": "error", "text": str(exc)[:200]})

    async def _pump(self):
        # Drift-corrected: a plain sleep(1/60) rounds up to the Windows timer
        # granularity and lands nearer 32 fps than 60.
        loop = asyncio.get_running_loop()
        due = loop.time()
        while True:
            if self._clients:
                frame = self.audio.snapshot().tobytes()
                await asyncio.gather(
                    *(client.send(frame) for client in list(self._clients)),
                    return_exceptions=True,
                )
            due += FRAME_INTERVAL
            delay = due - loop.time()
            if delay < 0:
                due = loop.time()
                delay = 0
            await asyncio.sleep(delay)

    # ---- outbound -----------------------------------------------------

    def broadcast(self, message: dict):
        """Thread-safe JSON push to every connected renderer."""
        if not self._loop or not (self._clients or self._aux):
            return
        payload = json.dumps(message)
        asyncio.run_coroutine_threadsafe(self._send_all(payload), self._loop)

    async def _send_all(self, payload: str):
        await asyncio.gather(
            *(client.send(payload) for client in list(self._clients | self._aux)),
            return_exceptions=True,
        )
