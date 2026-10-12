"""System tray presence so Aurora can sit quietly and wait for Spotify."""
import threading

import pystray

from . import config
from .icon import render as make_icon_image


class Tray:
    def __init__(self, on_show, on_settings, on_quit):
        self.on_show = on_show
        self.on_settings = on_settings
        self.on_quit = on_quit
        self.icon = pystray.Icon(
            "aurora",
            make_icon_image(64),
            "Aurora - ambient album display",
            menu=pystray.Menu(
                pystray.MenuItem("Show display", self._show, default=True),
                pystray.MenuItem("Settings", self._settings),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem(
                    "Notify when Spotify opens",
                    self._toggle_notify,
                    checked=lambda _item: config.get("notify_on_spotify"),
                ),
                pystray.Menu.SEPARATOR,
                pystray.MenuItem("Quit Aurora", self._quit),
            ),
        )

    def _show(self, *_):
        self.on_show()

    def _settings(self, *_):
        self.on_settings()

    def _toggle_notify(self, *_):
        config.set_many({"notify_on_spotify": not config.get("notify_on_spotify")})
        self.icon.update_menu()

    def _quit(self, *_):
        self.icon.visible = False
        self.icon.stop()
        self.on_quit()

    def start(self):
        threading.Thread(target=self.icon.run, daemon=True, name="tray").start()

    def stop(self):
        try:
            self.icon.stop()
        except Exception:
            pass
