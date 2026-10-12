"""Keeps two Aurora instances from polling Spotify with the same account at
once. Each instance polls independently, so a second one does not just
duplicate the UI - it doubles the request rate against the same token, and
Spotify's rate limit once tripped can lock the app out for the better part of
an hour (seen firsthand: a Retry-After of 2864 seconds).
"""
import atexit
import ctypes
import os

import psutil

from . import config

LOCK_PATH = config.APP_DIR / "aurora.pid"

_own_pid = None


def _read_lock():
    try:
        return int(LOCK_PATH.read_text().strip())
    except Exception:
        return None


def _is_live_aurora(pid: int) -> bool:
    """True if pid is a live python/pythonw process, not just a reused pid."""
    try:
        return psutil.Process(pid).name().lower() in ("python.exe", "pythonw.exe")
    except Exception:
        return False


def acquire() -> bool:
    """Claim the lock. False means a live instance already holds it."""
    global _own_pid
    config.APP_DIR.mkdir(parents=True, exist_ok=True)
    existing = _read_lock()
    if (existing and existing != os.getpid()
            and psutil.pid_exists(existing) and _is_live_aurora(existing)):
        return False
    LOCK_PATH.write_text(str(os.getpid()))
    _own_pid = os.getpid()
    atexit.register(release)
    return True


def release():
    global _own_pid
    if _own_pid is None:
        return
    try:
        if _read_lock() == _own_pid:
            LOCK_PATH.unlink(missing_ok=True)
    except Exception:
        pass
    _own_pid = None


def notify_already_running():
    """A MessageBox works even for a silent --tray launch with no console."""
    try:
        ctypes.windll.user32.MessageBoxW(
            0,
            "Aurora is already running. Check the system tray, or Alt+Tab "
            "to find its window.",
            "Aurora",
            0x40,  # MB_ICONINFORMATION
        )
    except Exception:
        pass
