"""Spotify Web API access: Authorization Code + PKCE, then poll what is playing."""
import base64
import hashlib
import secrets
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer

import requests

REDIRECT_PORT = 8888
REDIRECT_URI = f"http://127.0.0.1:{REDIRECT_PORT}/callback"
SCOPES = ("user-read-currently-playing user-read-playback-state "
          "user-modify-playback-state")
AUTH_URL = "https://accounts.spotify.com/authorize"
TOKEN_URL = "https://accounts.spotify.com/api/token"
# /me/player rather than /currently-playing: it carries the device block, which
# is where the volume and whether the device can even set volume live.
PLAYER_URL = "https://api.spotify.com/v1/me/player"

_DONE_PAGE = """<!doctype html><meta charset="utf-8"><title>Aurora</title>
<style>
 html,body{height:100%%;margin:0;background:#0a0a0f;color:#f4f4f6;
   font:400 16px/1.6 "Segoe UI Variable Display","Segoe UI",system-ui,sans-serif;
   display:grid;place-items:center;text-align:center}
 .card{padding:48px 56px;border-radius:20px;background:rgba(255,255,255,.04);
   border:1px solid rgba(255,255,255,.08);max-width:420px}
 h1{font-size:22px;font-weight:600;margin:0 0 10px;letter-spacing:-.02em}
 p{margin:0;color:rgba(244,244,246,.6);font-size:14px}
 .dot{width:38px;height:38px;border-radius:50%%;margin:0 auto 22px;
   background:conic-gradient(from 0deg,#7c5cff,#ff5c8a,#5cc8ff,#7c5cff)}
</style><div class="card"><div class="dot"></div><h1>%s</h1><p>%s</p></div>"""


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _make_verifier() -> str:
    return _b64url(secrets.token_bytes(64))


def _make_challenge(verifier: str) -> str:
    return _b64url(hashlib.sha256(verifier.encode("ascii")).digest())


class AuthError(Exception):
    pass


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        super().__init__(f"rate limited for {retry_after}s")
        self.retry_after = retry_after


class PlaybackError(Exception):
    """A transport command Spotify would not carry out, with a readable reason."""


class ScopeError(PlaybackError):
    """The saved grant predates a feature. Only re-authorising fixes it.

    Spotify reports a missing scope as 401 "Permissions missing", which looks
    like a stale token but is not - refreshing returns the same scopes forever.
    """


CONTROL_SCOPE = "user-modify-playback-state"
SCOPE_MESSAGE = ("This Spotify connection was authorised before playback control "
                 "was added. Open Settings and choose Reconnect to enable it.")


def run_auth_flow(client_id: str, timeout: float = 300.0,
                  force_dialog: bool = False) -> str:
    """Open the browser, capture the redirect, return a refresh token."""
    client_id = (client_id or "").strip()
    if not client_id:
        raise AuthError("No client ID provided.")

    verifier = _make_verifier()
    state = secrets.token_urlsafe(16)
    captured = {}
    done = threading.Event()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):  # noqa: N802
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != "/callback":
                self._reply(404, "Not found", "")
                return
            params = urllib.parse.parse_qs(parsed.query)
            captured["code"] = (params.get("code") or [None])[0]
            captured["state"] = (params.get("state") or [None])[0]
            captured["error"] = (params.get("error") or [None])[0]
            if captured.get("error"):
                self._reply(400, "Authorization declined",
                            "You can close this tab and try again in Aurora.")
            elif captured.get("code"):
                self._reply(200, "Connected to Spotify",
                            "You can close this tab. Aurora is ready.")
            else:
                self._reply(400, "Something went wrong",
                            "No authorization code came back.")
            done.set()

        def _reply(self, code, title, body):
            payload = (_DONE_PAGE % (title, body)).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    try:
        server = HTTPServer(("127.0.0.1", REDIRECT_PORT), Handler)
    except OSError as exc:
        raise AuthError(
            f"Port {REDIRECT_PORT} is already in use, so the Spotify redirect "
            f"cannot be received. Close whatever is using it, then retry."
        ) from exc

    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        query = urllib.parse.urlencode({
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPES,
            "state": state,
            "code_challenge_method": "S256",
            "code_challenge": _make_challenge(verifier),
            # On a reconnect, force the approval screen. Spotify can otherwise
            # silently re-issue the scopes already consented to, which would
            # leave a scope upgrade quietly ineffective.
            "show_dialog": "true" if force_dialog else "false",
        })
        webbrowser.open(f"{AUTH_URL}?{query}")
        if not done.wait(timeout):
            raise AuthError("Timed out waiting for approval in the browser.")
    finally:
        threading.Thread(target=server.shutdown, daemon=True).start()

    if captured.get("error"):
        raise AuthError(f"Spotify returned: {captured['error']}")
    if captured.get("state") != state:
        raise AuthError("State mismatch on the redirect. Authorization was rejected.")
    code = captured.get("code")
    if not code:
        raise AuthError("Spotify did not return an authorization code.")

    resp = requests.post(TOKEN_URL, timeout=20, data={
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT_URI,
        "client_id": client_id,
        "code_verifier": verifier,
    })
    if resp.status_code != 200:
        raise AuthError(f"Token exchange failed ({resp.status_code}): {resp.text[:200]}")
    refresh = resp.json().get("refresh_token")
    if not refresh:
        raise AuthError("Spotify did not return a refresh token.")
    return refresh


class SpotifyClient:
    """Holds the refresh token and hands out fresh access tokens."""

    def __init__(self, client_id: str, refresh_token: str, on_refresh_rotated=None):
        self.client_id = client_id
        self.refresh_token = refresh_token
        self.on_refresh_rotated = on_refresh_rotated
        self._access_token = None
        self._expires_at = 0.0
        self._lock = threading.Lock()
        self._session = requests.Session()
        # None until the first token refresh tells us what the grant covers.
        self.granted_scopes = None

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.refresh_token)

    @property
    def can_control(self):
        """True / False once known, None while we have not refreshed yet."""
        if self.granted_scopes is None:
            return None
        return CONTROL_SCOPE in self.granted_scopes

    def _access(self) -> str:
        with self._lock:
            if self._access_token and time.time() < self._expires_at - 60:
                return self._access_token
            resp = self._session.post(TOKEN_URL, timeout=20, data={
                "grant_type": "refresh_token",
                "refresh_token": self.refresh_token,
                "client_id": self.client_id,
            })
            if resp.status_code != 200:
                raise AuthError(
                    f"Could not refresh the Spotify token ({resp.status_code}). "
                    f"Reconnect from Settings."
                )
            payload = resp.json()
            self._access_token = payload["access_token"]
            self._expires_at = time.time() + float(payload.get("expires_in", 3600))
            scope = payload.get("scope")
            if scope is not None:
                self.granted_scopes = set(scope.split())
            rotated = payload.get("refresh_token")
            if rotated and rotated != self.refresh_token:
                self.refresh_token = rotated
                if self.on_refresh_rotated:
                    try:
                        self.on_refresh_rotated(rotated)
                    except Exception:
                        pass
            return self._access_token

    def now_playing(self):
        """Return a normalised track dict, or None when nothing is playing."""
        token = self._access()
        resp = self._session.get(
            PLAYER_URL,
            timeout=15,
            params={"additional_types": "track,episode"},
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code == 204 or not resp.content:
            return None
        if resp.status_code == 401:
            with self._lock:
                self._access_token = None
            raise AuthError("Spotify rejected the access token.")
        if resp.status_code == 429:
            raise RateLimited(float(resp.headers.get("Retry-After", "5") or 5))
        resp.raise_for_status()

        data = resp.json()
        item = data.get("item")
        if not item:
            return None
        return normalise(item, data)

    # ---- transport ----------------------------------------------------

    def _command(self, method: str, path: str, params: dict | None = None):
        """Fire a playback command, retrying once if the token just went stale."""
        token = self._access()
        # Known-missing scope: refreshing would return the same grant, so fail
        # straight away with something the user can act on.
        if self.can_control is False:
            raise ScopeError(SCOPE_MESSAGE)
        resp = None
        for attempt in (0, 1):
            resp = self._session.request(
                method,
                PLAYER_URL + path,
                timeout=15,
                params=params or {},
                headers={"Authorization": f"Bearer {token}", "Content-Length": "0"},
            )
            if resp.status_code == 401 and attempt == 0:
                with self._lock:
                    self._access_token = None
                token = self._access()
                continue
            break

        if resp.status_code in (200, 202, 204):
            return

        reason = message = ""
        try:
            err = (resp.json() or {}).get("error") or {}
            reason = err.get("reason") or ""
            message = err.get("message") or ""
        except Exception:
            pass

        if resp.status_code == 429:
            raise RateLimited(float(resp.headers.get("Retry-After", "3") or 3))
        # A 401 that survived the retry above is not a stale token: Spotify
        # uses it to mean the grant lacks the scope ("Permissions missing").
        if resp.status_code == 401 or "permission" in message.lower():
            self.granted_scopes = set(self.granted_scopes or ()) - {CONTROL_SCOPE}
            raise ScopeError(SCOPE_MESSAGE)
        if resp.status_code == 404 or reason == "NO_ACTIVE_DEVICE":
            raise PlaybackError(
                "No active Spotify device. Start playing something in Spotify first."
            )
        if resp.status_code == 403:
            if reason == "PREMIUM_REQUIRED":
                raise PlaybackError("Controlling playback this way needs Spotify Premium.")
            raise PlaybackError(
                message or "Spotify refused that. Try reconnecting from Settings."
            )
        raise PlaybackError(f"Spotify returned {resp.status_code}. {message}".strip()[:180])

    def play(self):
        self._command("PUT", "/play")

    def pause(self):
        self._command("PUT", "/pause")

    def next_track(self):
        self._command("POST", "/next")

    def previous_track(self):
        self._command("POST", "/previous")

    def seek(self, position_ms: int):
        self._command("PUT", "/seek", {"position_ms": max(0, int(position_ms))})

    def set_volume(self, percent: int):
        self._command("PUT", "/volume",
                      {"volume_percent": max(0, min(100, int(percent)))})


def normalise(item: dict, data: dict) -> dict:
    if item.get("type") == "episode":
        show = item.get("show") or {}
        artist = show.get("publisher") or show.get("name") or ""
        album = show.get("name") or ""
        images = item.get("images") or show.get("images") or []
    else:
        artist = ", ".join(a.get("name", "") for a in item.get("artists") or [])
        album_obj = item.get("album") or {}
        album = album_obj.get("name") or ""
        images = album_obj.get("images") or []

    images = sorted(images, key=lambda im: im.get("width") or 0, reverse=True)
    title = item.get("name") or ""
    device = data.get("device") or {}
    return {
        "volume": device.get("volume_percent"),
        # Absent on some device payloads; assume it works rather than greying out.
        "supports_volume": bool(device.get("supports_volume", True)),
        "device_name": device.get("name") or "",
        "id": item.get("id") or f"{artist}|{title}",
        "title": title,
        "artist": artist,
        "album": album,
        "art_url": images[0]["url"] if images else "",
        "duration_ms": int(item.get("duration_ms") or 0),
        "progress_ms": int(data.get("progress_ms") or 0),
        "is_playing": bool(data.get("is_playing")),
        "server_ts": time.time() * 1000.0,
    }
