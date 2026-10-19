r"""Persistent configuration stored in %APPDATA%\Aurora."""
import json
import os
import re
import threading
from pathlib import Path

APP_DIR = Path(os.environ.get("APPDATA") or Path.home()) / "Aurora"
CONFIG_PATH = APP_DIR / "config.json"
CACHE_DIR = APP_DIR / "cache"
ART_DIR = CACHE_DIR / "art"
LYRICS_DIR = CACHE_DIR / "lyrics"

DEFAULTS = {
    "client_id": "",
    "refresh_token": "",
    "auto_open": False,          # bring Aurora up when Spotify starts
    "layout": "center",          # center | split
    "lyrics_offset_ms": 0,
    "show_lyrics": True,
    "show_info": True,           # title / artist / album
    "show_progress": True,
    "show_controls": True,       # transport + volume
    "show_chrome": True,         # logo top-left, window buttons top-right
    "always_on_top": False,
    "start_fullscreen": True,
    "intensity": 1.0,            # 0.3 .. 3.0 visual strength
    "color_mode": "cover",       # cover | custom
    "custom_color": "#7c5cff",
    "grain": True,
}

# Values arriving from the renderer are clamped to keep a stray or stale
# setting from writing something the visuals cannot cope with.
CLAMPS = {
    "intensity": (0.3, 3.0),
    "lyrics_offset_ms": (-10000, 10000),
}

_lock = threading.RLock()
_data = None


def _ensure_dirs():
    for d in (APP_DIR, CACHE_DIR, ART_DIR, LYRICS_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load():
    global _data
    with _lock:
        if _data is not None:
            return _data
        _ensure_dirs()
        data = dict(DEFAULTS)
        if CONFIG_PATH.exists():
            try:
                data.update(json.loads(CONFIG_PATH.read_text("utf-8")))
            except Exception:
                pass
        # drop keys we no longer recognise so the file stays tidy
        _data = {k: data.get(k, v) for k, v in DEFAULTS.items()}
        return _data


def save():
    with _lock:
        _ensure_dirs()
        tmp = CONFIG_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(_data, indent=2), "utf-8")
        tmp.replace(CONFIG_PATH)


def get(key, default=None):
    return load().get(key, default)


def set_many(patch: dict):
    with _lock:
        cfg = load()
        for k, v in patch.items():
            if k not in DEFAULTS:
                continue
            if k == "color_mode" and v not in ("cover", "custom"):
                continue
            if k == "custom_color":
                if not isinstance(v, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", v):
                    continue
                v = v.lower()
            if k in CLAMPS:
                low, high = CLAMPS[k]
                try:
                    v = max(low, min(high, type(low)(v)))
                except (TypeError, ValueError):
                    continue
            cfg[k] = v
        save()
        return dict(cfg)


def public():
    """Config minus anything secret, for the renderer."""
    cfg = dict(load())
    cfg["connected"] = bool(cfg.get("client_id") and cfg.get("refresh_token"))
    cfg.pop("refresh_token", None)
    cfg.pop("client_id", None)
    return cfg
