"""Aurora orchestration: polls Spotify, drives the display, owns the windows."""
import ctypes
import sys
import threading
from pathlib import Path

import webview

from . import artcache, config, icon as icon_mod, lyrics as lyrics_mod
from .audio import AudioEngine
from .server import AuroraServer
from .spotify import (AuthError, PlaybackError, RateLimited, SpotifyClient,
                      run_auth_flow)
from .tray import Tray
from .watcher import SpotifyWatcher

WEB_DIR = Path(__file__).resolve().parent.parent / "web"



APP_ID = "Aurora.AmbientDisplay"


def _claim_taskbar_identity():
    """Without its own AppUserModelID the taskbar groups Aurora under Python
    and shows the Python icon instead of ours."""
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
    except Exception:
        pass


def _timer_resolution(enable: bool):
    """Ask Windows for 1 ms timers so the 60 fps audio pump actually hits 60."""
    try:
        winmm = ctypes.WinDLL("winmm")
        (winmm.timeBeginPeriod if enable else winmm.timeEndPeriod)(1)
    except Exception:
        pass


class Aurora:
    def __init__(self, start_hidden: bool = False):
        self.cfg = config.load()
        self.start_hidden = start_hidden

        self.audio = AudioEngine()
        self.server = AuroraServer(WEB_DIR, self.audio,
                                   on_message=self.handle_message,
                                   on_connect=self.initial_messages)
        self.client = self._build_client()

        self.track = None
        self.lyrics = None
        self.status = {"type": "status", "state": "starting", "message": ""}

        self.display = None
        self.tray = None
        # pywebview does not report show/hide back to us, so track it ourselves.
        self._display_visible = not start_hidden
        self._stop = threading.Event()
        # Set to cut the poll interval short, so a transport command is
        # reflected back within a moment instead of on the next scheduled poll.
        self._wake = threading.Event()
        self._quitting = False
        self._lyrics_token = 0

    # ---- setup --------------------------------------------------------

    def _build_client(self):
        client_id = self.cfg.get("client_id") or ""
        refresh = self.cfg.get("refresh_token") or ""
        if not (client_id and refresh):
            return None
        return SpotifyClient(client_id, refresh,
                             on_refresh_rotated=self._store_refresh)

    def _store_refresh(self, token: str):
        config.set_many({"refresh_token": token})

    def run(self):
        _timer_resolution(True)
        _claim_taskbar_identity()
        ico_path, _ = icon_mod.ensure_files()
        url = self.server.start()
        self.audio.start()

        self.display = webview.create_window(
            "Aurora",
            url,
            width=1280,
            height=820,
            min_size=(760, 520),
            frameless=True,
            easy_drag=False,
            background_color="#07070C",
            fullscreen=bool(self.cfg.get("start_fullscreen")),
            on_top=bool(self.cfg.get("always_on_top")),
            hidden=self.start_hidden,
        )
        self.display.events.closing += self._on_display_closing

        self.tray = Tray(self.show_display, self.open_settings, self.quit)
        self.tray.start()

        threading.Thread(target=self._poll_loop, daemon=True, name="spotify-poll").start()
        self.watcher = SpotifyWatcher(self.on_spotify_launch)
        self.watcher.start()

        # Older pywebview builds do not take an icon; fall back rather than fail.
        try:
            webview.start(private_mode=False, debug=False, icon=str(ico_path))
        except TypeError:
            webview.start(private_mode=False, debug=False)
        self.shutdown()

    # ---- window plumbing ----------------------------------------------

    # pywebview may or may not hand the window to event handlers depending on
    # version, so this stays tolerant about its arguments.
    def _on_display_closing(self, *_args):
        if self._quitting:
            return True
        self.display.hide()   # closing the display just parks it in the tray
        self._display_visible = False
        return False

    def show_display(self):
        try:
            self.display.show()
            self.display.restore()
            self._display_visible = True
        except Exception:
            pass

    def open_settings(self):
        self.show_display()
        self.server.broadcast({"type": "open_settings"})

    def on_spotify_launch(self):
        # Optional: bring the display up when Spotify starts. Off by default.
        if config.get("auto_open") and not self._display_visible:
            self.show_display()

    def quit(self):
        self._quitting = True
        self._stop.set()
        self._wake.set()
        try:
            self.display.destroy()
        except Exception:
            pass

    def shutdown(self):
        self._stop.set()
        self._wake.set()
        self.audio.stop()
        try:
            self.watcher.stop()
        except Exception:
            pass
        try:
            self.tray.stop()
        except Exception:
            pass
        self.server.stop()
        _timer_resolution(False)

    # ---- state out ----------------------------------------------------

    def initial_messages(self, role: str):
        messages = [
            {"type": "config", "config": config.public()},
            dict(self.status, audio=self.audio.status()),
        ]
        if self.track:
            messages.append({"type": "track", "track": self.track})
            if self.lyrics:
                messages.append(dict(self.lyrics, type="lyrics"))
        elif role == "display":
            messages.append({"type": "idle"})
        return messages

    def _set_status(self, state, message=""):
        if self.status.get("state") == state and self.status.get("message") == message:
            return
        self.status = {"type": "status", "state": state, "message": message}
        self.server.broadcast(dict(self.status, audio=self.audio.status()))

    # ---- polling ------------------------------------------------------

    def _poll_loop(self):
        while not self._stop.is_set():
            interval = 1.5
            try:
                if self.client is None or not self.client.configured:
                    self._set_status("needs_setup", "Connect a Spotify account to begin.")
                    interval = 2.0
                else:
                    track = self.client.now_playing()
                    if track is None:
                        if self.track is not None:
                            self.track = None
                            self.lyrics = None
                            self.server.broadcast({"type": "idle"})
                        self._set_status("idle", "Nothing is playing right now.")
                        interval = 3.0
                    else:
                        self._on_track(track)
                        interval = 1.5 if track["is_playing"] else 4.0
            except RateLimited as exc:
                interval = max(5.0, exc.retry_after)
                # Silently backing off here left the UI stuck on whatever it
                # last showed - often "idle" - for as long as an hour with no
                # indication why. Say what is actually happening instead.
                if interval >= 90:
                    minutes = round(interval / 60)
                    message = (f"Spotify is rate-limiting this app right now. "
                              f"Retrying automatically in about {minutes} "
                              f"minute{'s' if minutes != 1 else ''}.")
                else:
                    message = f"Spotify asked us to slow down. Retrying in {round(interval)}s."
                self._set_status("rate_limited", message)
            except AuthError as exc:
                self._set_status("error", str(exc))
                interval = 8.0
            except Exception as exc:
                self._set_status("error", f"Spotify request failed: {str(exc)[:140]}")
                interval = 5.0
            if self._wake.wait(interval):
                self._wake.clear()

    def _on_track(self, track: dict):
        changed = self.track is None or track["id"] != self.track.get("id")
        if changed:
            track["art"] = artcache.local_url(track.get("art_url") or "")
            self.track = track
            self.lyrics = None
            self.server.broadcast({"type": "track", "track": track})
            self._load_lyrics(track)
        else:
            track["art"] = self.track.get("art", "")
            self.track = track

        self._set_status("ok", "")
        self.server.broadcast({
            "type": "tick",
            "id": track["id"],
            "progress_ms": track["progress_ms"],
            "duration_ms": track["duration_ms"],
            "is_playing": track["is_playing"],
            "server_ts": track["server_ts"],
            "volume": track.get("volume"),
            "supports_volume": track.get("supports_volume", True),
            "device_name": track.get("device_name", ""),
            "can_control": self.client.can_control if self.client else None,
        })

    def _load_lyrics(self, track: dict):
        self._lyrics_token += 1
        token = self._lyrics_token

        def work():
            result = lyrics_mod.fetch(track)
            if token != self._lyrics_token:
                return   # a newer track already superseded this lookup
            payload = dict(result, type="lyrics", track_id=track["id"])
            self.lyrics = payload
            self.server.broadcast(payload)

        threading.Thread(target=work, daemon=True, name="lyrics").start()

    # ---- messages in ---------------------------------------------------

    def handle_message(self, data: dict):
        kind = data.get("type")
        if kind == "setting":
            patch = data.get("patch") or {}
            self.cfg = config.set_many(patch)
            self._apply_settings(patch)
            self.server.broadcast({"type": "config", "config": config.public()})
        elif kind == "connect":
            self._connect(data.get("client_id") or "")
        elif kind == "reconnect":
            # Re-run authorisation against the client ID already on file, so a
            # grant made before a scope was added can be upgraded in place.
            saved = config.get("client_id") or ""
            if not saved:
                self.server.broadcast({"type": "auth", "state": "error",
                                       "message": "No Spotify client ID saved yet."})
            else:
                self._connect(saved, force_dialog=True)
        elif kind == "disconnect":
            config.set_many({"client_id": "", "refresh_token": ""})
            self.client = None
            self.track = None
            self.lyrics = None
            self.server.broadcast({"type": "config", "config": config.public()})
            self.server.broadcast({"type": "idle"})
            self._set_status("needs_setup", "Disconnected from Spotify.")
        elif kind == "action":
            self._action(data.get("name") or "")
        elif kind == "control":
            self._control(data.get("name") or "", data.get("value"))
        elif kind == "reload_lyrics":
            if self.track:
                track_id = self.track.get("id") or ""
                lyrics_mod._memo.pop(track_id, None)
                path = lyrics_mod._cache_path(track_id)
                try:
                    path.unlink(missing_ok=True)
                except Exception:
                    pass
                self._load_lyrics(self.track)

    def _control(self, name: str, value):
        if self.client is None or not self.client.configured:
            self.server.broadcast({"type": "toast", "text": "Connect Spotify first."})
            return

        actions = {
            "play": lambda: self.client.play(),
            "pause": lambda: self.client.pause(),
            "next": lambda: self.client.next_track(),
            "previous": lambda: self.client.previous_track(),
            "seek": lambda: self.client.seek(int(value or 0)),
            "volume": lambda: self.client.set_volume(int(value or 0)),
        }
        action = actions.get(name)
        if action is None:
            return

        try:
            action()
        except (PlaybackError, AuthError) as exc:
            self.server.broadcast({"type": "toast", "text": str(exc)})
            return
        except RateLimited:
            self.server.broadcast({"type": "toast", "text": "Slow down a moment."})
            return
        except Exception as exc:
            self.server.broadcast({"type": "toast",
                                   "text": f"Command failed: {str(exc)[:140]}"})
            return

        # Volume is already reflected locally by the slider, so only the
        # commands that change playback state are worth an early re-poll.
        if name != "volume":
            timer = threading.Timer(0.35, self._wake.set)
            timer.daemon = True
            timer.start()

    def _apply_settings(self, patch: dict):
        if "always_on_top" in patch:
            try:
                self.display.on_top = bool(patch["always_on_top"])
            except Exception:
                pass

    def _action(self, name: str):
        if name == "close":
            self.display.hide()
            self._display_visible = False
        elif name == "minimize":
            self.display.minimize()
            self._display_visible = False
        elif name == "fullscreen":
            self.display.toggle_fullscreen()
        elif name == "quit":
            self.quit()

    def _connect(self, client_id: str, force_dialog: bool = False):
        client_id = client_id.strip()
        self.server.broadcast({"type": "auth", "state": "pending"})
        try:
            refresh = run_auth_flow(client_id, force_dialog=force_dialog)
        except AuthError as exc:
            self.server.broadcast({"type": "auth", "state": "error", "message": str(exc)})
            return
        except Exception as exc:
            self.server.broadcast({"type": "auth", "state": "error",
                                   "message": f"Unexpected error: {str(exc)[:160]}"})
            return

        config.set_many({"client_id": client_id, "refresh_token": refresh})
        self.cfg = config.load()
        self.client = self._build_client()
        self.server.broadcast({"type": "auth", "state": "ok"})
        self.server.broadcast({"type": "config", "config": config.public()})
        self._set_status("ok", "")


def main():
    from . import singleton
    if not singleton.acquire():
        singleton.notify_already_running()
        return
    start_hidden = "--tray" in sys.argv
    Aurora(start_hidden=start_hidden).run()
