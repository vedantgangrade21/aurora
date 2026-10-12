"""Time-synced lyrics via LRCLIB (free, no key, community sourced)."""
import json
import re
import threading

import requests

from . import config

API = "https://lrclib.net/api"
UA = "Aurora/1.0.0 (local ambient album display)"

# [mm:ss.xx] or [mm:ss.xxx], possibly several stamps on one line
_STAMP = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")

_lock = threading.Lock()
_memo: dict[str, dict] = {}


def parse_lrc(text: str) -> list[dict]:
    """Turn LRC markup into a sorted [{t: ms, text: str}] list."""
    lines: list[dict] = []
    for raw in (text or "").splitlines():
        stamps = list(_STAMP.finditer(raw))
        if not stamps:
            continue
        body = raw[stamps[-1].end():].strip()
        for stamp in stamps:
            minutes, seconds, frac = stamp.group(1), stamp.group(2), stamp.group(3)
            ms = int(minutes) * 60_000 + int(seconds) * 1000
            if frac:
                ms += int(frac.ljust(3, "0")[:3])
            lines.append({"t": ms, "text": body})
    lines.sort(key=lambda item: item["t"])

    # Collapse runs of blank lines into a single instrumental marker.
    cleaned: list[dict] = []
    for line in lines:
        if not line["text"] and cleaned and not cleaned[-1]["text"]:
            continue
        cleaned.append(line)
    return cleaned


def _cache_path(track_id: str):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", track_id)[:80] or "unknown"
    return config.LYRICS_DIR / (safe + ".json")


def _score(candidate: dict, duration_s: float) -> float:
    """Prefer synced lyrics whose duration is closest to the real track."""
    delta = abs(float(candidate.get("duration") or 0) - duration_s)
    bonus = -50.0 if candidate.get("syncedLyrics") else 0.0
    return delta + bonus


def fetch(track: dict) -> dict:
    """Return {'kind': 'synced'|'plain'|'none', 'lines': [...], 'text': str}."""
    track_id = track.get("id") or ""
    with _lock:
        hit = _memo.get(track_id)
    if hit is not None:
        return hit

    cache_file = _cache_path(track_id)
    if cache_file.exists():
        try:
            hit = json.loads(cache_file.read_text("utf-8"))
            with _lock:
                _memo[track_id] = hit
            return hit
        except Exception:
            pass

    result = {"kind": "none", "lines": [], "text": ""}
    duration_s = round((track.get("duration_ms") or 0) / 1000)
    artist = track.get("artist") or ""
    title = track.get("title") or ""
    album = track.get("album") or ""
    # LRCLIB matches on the primary artist, so drop any featured credits.
    primary_artist = re.split(r"\s*,\s*|\s+feat\.?\s+|\s+&\s+", artist)[0] if artist else ""

    try:
        found = None
        resp = requests.get(
            f"{API}/get",
            timeout=15,
            headers={"User-Agent": UA},
            params={
                "artist_name": primary_artist,
                "track_name": title,
                "album_name": album,
                "duration": duration_s,
            },
        )
        if resp.status_code == 200:
            found = resp.json()
        else:
            search = requests.get(
                f"{API}/search",
                timeout=15,
                headers={"User-Agent": UA},
                params={"track_name": title, "artist_name": primary_artist},
            )
            if search.status_code == 200:
                candidates = [c for c in search.json() if c.get("syncedLyrics") or c.get("plainLyrics")]
                if candidates:
                    found = min(candidates, key=lambda c: _score(c, duration_s))

        if found:
            synced = found.get("syncedLyrics")
            plain = found.get("plainLyrics")
            if synced:
                lines = parse_lrc(synced)
                if lines:
                    result = {"kind": "synced", "lines": lines, "text": ""}
            if result["kind"] == "none" and plain:
                result = {"kind": "plain", "lines": [], "text": plain}
    except Exception:
        return result  # transient failure: do not poison the cache

    config.LYRICS_DIR.mkdir(parents=True, exist_ok=True)
    try:
        cache_file.write_text(json.dumps(result), "utf-8")
    except Exception:
        pass
    with _lock:
        _memo[track_id] = result
    return result
