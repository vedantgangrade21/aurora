"""Watches for Spotify starting up and fires a callback on the rising edge."""
import threading
import time

import psutil

PROCESS_NAMES = {"spotify.exe"}


class SpotifyWatcher(threading.Thread):
    def __init__(self, on_launch, poll_seconds=4.0, cooldown_seconds=120.0):
        super().__init__(daemon=True, name="spotify-watcher")
        self.on_launch = on_launch
        self.poll_seconds = poll_seconds
        self.cooldown_seconds = cooldown_seconds
        self._stop = threading.Event()
        self._last_fired = 0.0
        # Assume Spotify may already be running when we start, so the first
        # observation only establishes a baseline - it never fires.
        self._was_running = None

    @staticmethod
    def spotify_running() -> bool:
        for proc in psutil.process_iter(["name"]):
            try:
                name = (proc.info.get("name") or "").lower()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            if name in PROCESS_NAMES:
                return True
        return False

    def run(self):
        while not self._stop.is_set():
            try:
                running = self.spotify_running()
                if self._was_running is None:
                    self._was_running = running
                elif running and not self._was_running:
                    now = time.time()
                    if now - self._last_fired > self.cooldown_seconds:
                        self._last_fired = now
                        try:
                            self.on_launch()
                        except Exception:
                            pass
                    self._was_running = True
                else:
                    self._was_running = running
            except Exception:
                pass
            self._stop.wait(self.poll_seconds)

    def stop(self):
        self._stop.set()
