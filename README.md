# Aurora

An ambient album display for Spotify. The cover art of whatever you are playing
sits in the middle of the screen, the background is built from the colours of
that cover, and the whole thing moves with the actual audio coming out of your
speakers. Lyrics scroll underneath, in time with the song.

**Windows 10/11 only.** Needs Python 3.12 and Spotify Premium for the
playback controls (the display itself works on any account).

## Install

1. **Download** - the green **Code** button on GitHub -> **Download ZIP**, then
   extract it somewhere permanent (e.g. `Documents\Aurora`). Or:

   ```
   git clone https://github.com/vedantgangrade21/aurora.git
   ```

2. **Install Python 3.12** if you don't have it:

   ```
   winget install Python.Python.3.12
   ```

   3.12 specifically - `PyAudioWPatch`, which captures the audio, has no
   wheels for newer versions yet.

3. **Run `Setup.bat`.** It builds a private environment in `.venv`, installs
   the dependencies, and offers to put a shortcut on your Desktop.

4. **Run `Aurora.bat`** (or the shortcut). `Aurora-debug.bat` does the same but
   keeps a console open so you can see errors.

Then connect Spotify - below.

## First run: connecting Spotify

Spotify has no public "what is playing" feed, so Aurora asks through your own
Spotify app. It takes about a minute, once.

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
   The name and description do not matter.
2. Set the **Redirect URI** to exactly `http://127.0.0.1:8888/callback`, and
   tick the **Web API** checkbox.
3. Open the app's **Settings**, copy the **Client ID**, and paste it into
   Aurora's setup screen.

A browser tab opens once so you can approve access. After that Aurora keeps a
refresh token in `%APPDATA%\Aurora\config.json` and never asks again.

Nothing leaves your machine except the Spotify API calls and the lyric lookup.

## Keyboard

| Key | Does |
| --- | --- |
| `Space` | Play or pause |
| `←` `→` | Seek 5 seconds |
| `⇧` + `←` `→` | Previous or next track |
| `↑` `↓` | Volume |
| `F` | Fullscreen |
| `L` | Switch between centred and split layout |
| `K` | Show or hide the lyric ticker |
| `S` | Settings |
| `[` `]` | Nudge lyric timing by 100 ms |
| `?` | Shortcut list |
| `Esc` | Hide to the tray |

The window chrome fades out after a few seconds of no mouse movement, and comes
back the moment you move it.

## Settings

Reachable with `S`, or from the tray icon.

- **Layout** - cover centred with lyrics below, or cover left and lyrics right.
- **Reactivity** - how strongly the visuals respond to the music, from 30% up
  to 300%. Past about 180% every beat also throws a second, trailing ring.
- **Film grain** - the subtle texture over everything. Turn it off if you find
  it distracting.
- **Timing offset** - if lyrics run early or late, shift them. Per-install, not
  per-track.
- **Show on screen** - independently hide the window bar (the logo top-left and
  the buttons top-right), the title and artist, the progress bar, the playback
  controls, and the lyric ticker. **Album art only** switches all five off at
  once; **Show everything** brings them back. With nothing but the cover left,
  it sits dead centre in the window - the chrome padding and the empty ticker
  row drop out rather than nudging it upward. In the split layout, leaving just
  the cover and the ticker centres the cover against the lyric column. With the window bar hidden, `S`
  still opens settings, `Esc` still hides Aurora, and the tray icon always
  works - and an invisible strip along the top stays draggable.
- **Always on top / Open fullscreen** - window behaviour.
- **When Spotify opens** - ask first (default), just open it, or do nothing.

## How it works

| Piece | What it does |
| --- | --- |
| `aurora/spotify.py` | PKCE OAuth against Spotify, then polls what is playing |
| `aurora/audio.py` | WASAPI loopback capture of your default output, FFT into five bands plus a 64-bin spectrum, with beat detection |
| `aurora/lyrics.py` | Fetches and parses synced lyrics from LRCLIB, cached to disk |
| `aurora/server.py` | Serves the UI over local HTTP; audio frames go out as binary over a WebSocket at 60 fps, everything else as JSON |
| `aurora/watcher.py` | Notices when `Spotify.exe` appears |
| `aurora/icon.py` | Draws the app mark and writes the .ico / .png |
| `aurora/singleton.py` | Keeps a second launch from polling Spotify alongside the first |
| `aurora/app.py` | Ties it together and owns the windows |
| `web/js/palette.js` | Pulls the accent palette out of the cover art |
| `web/js/visualizer.js` | Draws the reactive background |
| `web/js/lyrics.js` | The ticker |

The audio really is the audio: Aurora taps the system output device, so the
visuals respond to what you are hearing, not to a guess based on the track.

Album art is downloaded and re-served from Aurora's own local origin. That is
deliberate: it keeps the canvas untainted so the palette extractor can read the
cover's pixels.

## Controlling playback

Play/pause, previous, next, a draggable playhead and a volume slider sit under
the track title. Drag anywhere on the progress bar to scrub; the lyrics follow
the playhead as you drag.

Two caveats, both Spotify's rather than Aurora's:

- **Playback control needs Spotify Premium.** On a free account Spotify
  refuses the commands and Aurora says so.
- **Something has to be playing already.** The API drives an *active device*,
  so if Spotify is idle you will get "No active Spotify device" - press play in
  Spotify once and the controls take over from there.

Volume also depends on the device: some, notably Spotify Connect speakers and
some phones, report that they do not accept volume changes, and Aurora greys
the slider out when that happens.

## The app icon, and starting with Windows

The Aurora mark - a violet-to-pink disc with a dark label and a punched spindle
hole - is drawn in code (`aurora/icon.py`) and written out to
`assets/aurora.ico` and `assets/aurora.png` on first run. One artwork covers the
window and taskbar, the tray, and the web favicon, and nothing binary lives in
the source tree. To redraw it after changing the colours:

```
.venv\Scripts\python.exe -m aurora.icon
```

`Aurora.bat` shows a console icon in Explorer, because it is a batch file. For a
real icon, make a shortcut:

```
powershell -ExecutionPolicy Bypass -File Create-Shortcut.ps1
```

That puts an Aurora shortcut on your Desktop pointing straight at `pythonw.exe`,
so there is no console window at all. Add `-Startup` to put it in the startup
folder instead, where it launches with `--tray` and waits quietly for you to
open Spotify.

## When something is off

**Too many (or too few) beat rings.** Beat detection lives at the top of
`aurora/audio.py`. `BEAT_COOLDOWN` is the blunt one - it caps how often a ring
can fire, currently 0.40s for roughly 2.5 per second. `BEAT_SENSITIVITY` is how
far above the running bass average a hit has to sit to count, and
`BEAT_FLOOR` is the minimum bass energy. Raise any of them for fewer rings.

**The background does not move.** Aurora captures the *default* playback
device. If you changed outputs after starting it, restart Aurora. Settings ->
Connections shows which device it grabbed, or the error if it could not.

**No lyrics.** They come from LRCLIB, a free community database, and coverage is
not universal - especially for very new or very obscure tracks. "Re-fetch
lyrics for this track" in Settings clears the cached miss and tries again.

**"Permissions missing", or the controls are replaced by a Reconnect button.**
Spotify grants a fixed set of permissions when you first authorize, and
refreshing a token never widens it. If your connection was made before
playback control was added, it is read-only forever - Spotify reports that as
`401 Permissions missing`. Settings -> Connections -> **Reconnect** re-runs
authorization against the client ID already saved and fixes it. Aurora detects
this on its own and hides the transport controls rather than letting them fail.

**Lyrics drift.** Use `[` and `]`, or the offset buttons in Settings.

**"Port 8888 is already in use."** Only needed during the one-time Spotify
connect, to catch the redirect. Close whatever else is on that port and retry.

**Nothing on screen.** The window may be hidden. Click the tray icon, or run
`Aurora-debug.bat` to see what it is complaining about.

**Spotify stopped showing up, with no error.** Aurora now only runs one
instance at a time - launching it again while it is already running shows a
"already running" message instead of starting a second copy. That guards
against the actual cause of this: two or more copies polling Spotify with the
same account at once trips Spotify's rate limiter, which can lock the app out
for up to an hour and, before this fix, did so silently - the screen just kept
showing whatever it last displayed. If it happens again, the connection status
in Settings will now say so directly and count down the wait. If Aurora ever
refuses to start after a crash and claims another copy is running when there is
not one, delete `%APPDATA%\Aurora\aurora.pid` and try again.
