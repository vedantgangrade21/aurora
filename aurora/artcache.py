"""Downloads album art locally so the renderer can read its pixels.

Album art is served from our own HTTP origin rather than i.scdn.co: that keeps
the canvas untainted, so the palette extractor can call getImageData on it.
"""
import hashlib
import threading
from pathlib import Path

import requests

from . import config

_lock = threading.Lock()
_memo: dict[str, str] = {}

_EXT_BY_TYPE = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def local_url(art_url: str) -> str:
    """Fetch (once) and return a path under our own server, or '' on failure."""
    if not art_url:
        return ""
    with _lock:
        hit = _memo.get(art_url)
    if hit:
        return hit

    config.ART_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha1(art_url.encode("utf-8")).hexdigest()[:20]

    existing = next(config.ART_DIR.glob(digest + ".*"), None)
    if existing is not None:
        url = "/art/" + existing.name
        with _lock:
            _memo[art_url] = url
        return url

    try:
        resp = requests.get(art_url, timeout=20)
        resp.raise_for_status()
        ext = _EXT_BY_TYPE.get(resp.headers.get("Content-Type", "").split(";")[0], ".jpg")
        path = config.ART_DIR / (digest + ext)
        tmp = path.with_suffix(path.suffix + ".part")
        tmp.write_bytes(resp.content)
        tmp.replace(path)
    except Exception:
        return ""

    url = "/art/" + path.name
    with _lock:
        _memo[art_url] = url
    _prune()
    return url


def _prune(keep: int = 60):
    """Keep the art cache small - drop the least recently used files."""
    try:
        files = sorted(
            (p for p in config.ART_DIR.iterdir() if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale in files[keep:]:
            stale.unlink(missing_ok=True)
    except Exception:
        pass


def path_for(name: str) -> Path | None:
    """Resolve a /art/<name> request to a file inside the cache directory.

    The check is done on the name rather than by resolving and comparing paths:
    under MSIX/packaged launches Windows redirects %APPDATA% into the package
    LocalCache, and Path.resolve() follows that redirection, so a resolved path
    no longer matches a resolved ART_DIR. Requiring a bare filename component
    is both redirection-proof and enough to stop traversal.
    """
    if (not name or name in (".", "..")
            or "/" in name or "\\" in name or ":" in name):
        return None
    candidate = config.ART_DIR / name
    return candidate if candidate.is_file() else None
