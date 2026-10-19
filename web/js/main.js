/* Aurora renderer: socket plumbing, playback clock, palette morphing, UI. */
(function () {
  "use strict";

  var P = window.AuroraPalette;
  var $ = function (id) { return document.getElementById(id); };

  var el = {
    stage: $("stage"), fx: $("fx"), grain: $("grain"),
    artframe: $("artframe"), artglow: $("artglow"),
    info: $("info"), lyricbox: $("lyricbox"),
    album: $("album"), title: $("title"), artist: $("artist"),
    fill: $("fill"), tNow: $("tNow"), tEnd: $("tEnd"),
    trackHit: $("trackHit"), knob: $("knob"), transport: $("transport"),
    volume: $("volume"), btnPlay: $("btnPlay"), btnMute: $("btnMute"),
    idle: $("idle"), setup: $("setup"), panel: $("panel"), keys: $("keys"),
    srcdot: $("srcdot"), toast: $("toastMsg"),
    spotifyState: $("spotifyState"), audioState: $("audioState"),
    authMsg: $("authMsg"), clientId: $("clientId"), btnConnect: $("btnConnect")
  };

  var viz = new window.AuroraViz(el.fx);
  var ticker = new window.AuroraLyrics({
    scroll: $("lyricScroll"), track: $("lyricTrack"), note: $("lyricNote")
  });

  var cfg = {};
  // Two copies: what the wire last said, and what we actually draw. The drawn
  // one chases the target every frame, so the visuals stay fluid at 60 fps even
  // if frames arrive slower or unevenly.
  var audio = { level: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  var target = { level: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
  var BANDS = ["level", "bass", "lowMid", "mid", "high", "air"];
  var spectrum = new Float32Array(64);
  var spectrumTarget = new Float32Array(64);
  var pendingBeat = false;
  var audioOk = false;
  var tilt = { x: 0, y: 0, tx: 0, ty: 0 };

  var palCur = P.DEFAULT;
  var palTarget = P.DEFAULT;
  var coverPal = P.DEFAULT;   // what the current artwork yields, kept even
                              // while a custom colour is in use

  /* The palette the screen should be heading towards, from whichever source
     the user picked. palCur then morphs to it, so switching is a smooth fade. */
  function choosePalette() {
    palTarget = cfg.color_mode === "custom"
      ? P.fromHex(cfg.custom_color || "#7c5cff")
      : coverPal;
  }
  var palApplied = null;

  var currentTrack = null;
  var lastSecond = -1;

  // Cover cross-fade state.
  var artLayers = [$("artA"), $("artB")];
  var artFront = 0;
  var swapGen = 0;
  var glowTarget = 1;
  var glowLevel = 1;

  // Playback control state.
  var scrub = { active: false, frac: 0 };
  var vol = { value: 100, supported: true, last: 0, pending: null, held: 0 };

  var LEAVE_MS = 260;    // how long the old title has to clear out
  var ART_WAIT_MS = 2500; // never stall the swap on a slow image
  var LYRIC_WAIT_MS = 3500;

  /* ---------------- playback clock ---------------- */

  var clock = {
    p: 0, t: 0, dur: 0, playing: false, has: false,
    sync: function (progress, duration, playing) {
      var predicted = this.now();
      // Ease small corrections instead of snapping, so lyrics do not twitch
      // every time the poll comes back a few tens of ms out.
      if (this.has && playing && this.playing && Math.abs(progress - predicted) < 900) {
        this.p = predicted + (progress - predicted) * 0.35;
      } else {
        this.p = progress;
      }
      this.dur = duration;
      this.t = performance.now();
      this.playing = playing;
      this.has = true;
    },
    now: function () {
      if (!this.has) return 0;
      var v = this.playing ? this.p + (performance.now() - this.t) : this.p;
      return this.dur ? Math.min(v, this.dur) : v;
    }
  };

  function mmss(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2);
  }

  /* ---------------- socket ---------------- */

  var ws = null;

  function connect() {
    var port = window.AURORA_WS_PORT;
    ws = new WebSocket("ws://127.0.0.1:" + port + "/?role=display");
    ws.binaryType = "arraybuffer";
    ws.onmessage = function (ev) {
      if (typeof ev.data === "string") {
        try { onJson(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
      } else {
        onAudio(new Float32Array(ev.data));
      }
    };
    ws.onclose = function () { setTimeout(connect, 1200); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function send(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function onAudio(f) {
    if (f.length < 8) return;
    target.level = f[0]; target.bass = f[1]; target.lowMid = f[2];
    target.mid = f[3]; target.high = f[4]; target.air = f[5];
    if (f[6] > 0.5) pendingBeat = true;
    audioOk = f[7] > 0.5;
    spectrumTarget.set(f.subarray(8));
  }

  function followAudio(dt) {
    var a = 1 - Math.exp(-dt * 24);
    for (var i = 0; i < BANDS.length; i++) {
      var k = BANDS[i];
      audio[k] += (target[k] - audio[k]) * a;
    }
    for (var j = 0; j < spectrum.length; j++) {
      spectrum[j] += (spectrumTarget[j] - spectrum[j]) * a;
    }
  }

  function onJson(msg) {
    switch (msg.type) {
      case "config": applyConfig(msg.config); break;
      case "track": setTrack(msg.track); break;
      case "tick":
        clock.sync(msg.progress_ms, msg.duration_ms, msg.is_playing);
        document.body.dataset.playing = msg.is_playing ? "1" : "0";
        applyControlAvailability(msg.can_control);
        applyVolume(msg);
        el.idle.hidden = true;
        el.stage.classList.remove("busy");
        break;
      case "lyrics":
        if (!currentTrack || msg.track_id === currentTrack.id) {
          ticker.setLyrics(msg, clock.dur);
          el.lyricbox.classList.remove("swap");
        }
        break;
      case "idle":
        currentTrack = null;
        clock.has = false;
        el.idle.hidden = false;
        el.stage.classList.add("busy");
        ticker.clear();
        break;
      case "status": onStatus(msg); break;
      case "auth": onAuth(msg); break;
      case "open_settings": openPanel(true); break;
      case "toast": flash(msg.text); break;
    }
  }

  function onStatus(msg) {
    var dot = el.srcdot;
    dot.classList.remove("ok", "err");
    if (msg.state === "ok") dot.classList.add("ok");
    else if (msg.state === "error") dot.classList.add("err");
    dot.title = msg.message || msg.state;

    el.spotifyState.textContent =
      msg.state === "ok" ? "Connected" :
      msg.state === "needs_setup" ? "Not connected" :
      msg.state === "idle" ? "Idle" : (msg.message || "Error");

    if (msg.audio) {
      el.audioState.textContent = msg.audio.ok
        ? (msg.audio.device || "Capturing").replace(/\s*\(.*\)\s*$/, "")
        : (msg.audio.error || "Unavailable");
    }
  }

  /* ---------------- playback control ---------------- */

  function control(name, value) {
    send({ type: "control", name: name, value: value });
  }

  /* Spotify reports a missing scope only when a command is attempted, so the
     backend tells us up front and the controls step aside rather than failing
     on click. null means "not established yet" - leave things as they are. */
  function applyControlAvailability(can) {
    if (can === false) {
      document.body.dataset.canControl = "0";
      $("controlState").textContent = "Reconnect needed";
    } else if (can === true) {
      delete document.body.dataset.canControl;
      $("controlState").textContent = "Available";
    }
  }

  $("ctrlNote").addEventListener("click", function () {
    openPanel(true);
    flash("Choose Reconnect under Connections");
  });

  function togglePlay() {
    var playing = document.body.dataset.playing === "1";
    // Flip locally first; the next poll confirms or corrects it.
    document.body.dataset.playing = playing ? "0" : "1";
    clock.playing = !playing;
    clock.p = clock.now();
    clock.t = performance.now();
    control(playing ? "pause" : "play");
  }

  el.btnPlay.addEventListener("click", function () { this.blur(); togglePlay(); });
  $("btnPrev").addEventListener("click", function () { this.blur(); control("previous"); });
  $("btnNext").addEventListener("click", function () { this.blur(); control("next"); });

  /* --- scrubbing --- */

  function fracFromEvent(ev) {
    var rect = $("track").getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
  }

  function paintScrub() {
    var pct = (scrub.frac * 100).toFixed(2) + "%";
    el.fill.style.width = pct;
    el.knob.style.left = pct;
    el.tNow.textContent = mmss(scrub.frac * clock.dur);
  }

  el.trackHit.addEventListener("pointerdown", function (ev) {
    if (!clock.dur) return;
    scrub.active = true;
    scrub.frac = fracFromEvent(ev);
    el.trackHit.classList.add("scrubbing");
    // Capture can be refused if the pointer is already gone; the drag still
    // works without it, so never let that abort the scrub.
    try { el.trackHit.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    paintScrub();
    ev.preventDefault();
  });

  el.trackHit.addEventListener("pointermove", function (ev) {
    if (!scrub.active) return;
    scrub.frac = fracFromEvent(ev);
    paintScrub();
  });

  function endScrub(ev) {
    if (!scrub.active) return;
    scrub.active = false;
    el.trackHit.classList.remove("scrubbing");
    var target = Math.round(scrub.frac * clock.dur);
    // Move the local clock straight away so lyrics jump with the playhead
    // rather than waiting for Spotify to confirm the seek.
    clock.p = target;
    clock.t = performance.now();
    lastSecond = -1;
    control("seek", target);
    if (ev && ev.pointerId != null) {
      try { el.trackHit.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    }
  }

  el.trackHit.addEventListener("pointerup", endScrub);
  el.trackHit.addEventListener("pointercancel", endScrub);

  function seekBy(deltaMs) {
    if (!clock.dur) return;
    var target = Math.max(0, Math.min(clock.dur - 500, clock.now() + deltaMs));
    clock.p = target;
    clock.t = performance.now();
    lastSecond = -1;
    control("seek", Math.round(target));
  }

  /* --- volume --- */

  function applyVolume(msg) {
    vol.supported = msg.supports_volume !== false && msg.volume != null;
    el.volume.disabled = !vol.supported;
    el.btnMute.disabled = !vol.supported;
    el.volume.title = vol.supported
      ? "Volume"
      : "This Spotify device does not accept volume changes";
    // Do not yank the slider while it is being used, or just after.
    if (!vol.supported || performance.now() - vol.held < 1500) return;
    if (msg.volume != null && Math.round(msg.volume) !== Math.round(vol.value)) {
      vol.value = msg.volume;
      el.volume.value = msg.volume;
      paintMute();
    }
  }

  function paintMute() {
    el.btnMute.classList.toggle("muted", Number(vol.value) === 0);
  }

  function pushVolume(value, immediate) {
    vol.value = value;
    vol.held = performance.now();
    paintMute();
    // Dragging fires continuously; throttle so we do not hammer the API.
    var now = performance.now();
    var rounded = Math.round(value);
    if (immediate || now - vol.last > 250) {
      clearTimeout(vol.pending);
      vol.pending = null;
      if (rounded === vol.sent) return;   // the trailing change event repeats input
      vol.last = now;
      vol.sent = rounded;
      control("volume", rounded);
    } else if (!vol.pending) {
      vol.pending = setTimeout(function () {
        vol.pending = null;
        var latest = Math.round(vol.value);
        if (latest === vol.sent) return;
        vol.last = performance.now();
        vol.sent = latest;
        control("volume", latest);
      }, 250);
    }
  }

  el.volume.addEventListener("input", function () { pushVolume(Number(this.value), false); });
  el.volume.addEventListener("change", function () { pushVolume(Number(this.value), true); });

  el.btnMute.addEventListener("click", function () {
    this.blur();
    var next = Number(vol.value) === 0 ? (vol.restore || 60) : 0;
    if (Number(vol.value) !== 0) vol.restore = Number(vol.value);
    el.volume.value = next;
    pushVolume(next, true);
  });

  function nudgeVolume(delta) {
    if (!vol.supported) return;
    var next = Math.max(0, Math.min(100, Math.round(Number(vol.value) + delta)));
    el.volume.value = next;
    pushVolume(next, true);
    flash("Volume " + next + "%");
  }

  /* ---------------- track + palette ---------------- */

  /* A track change runs in two beats: the old cover and title clear out, then
     the new ones arrive together once the artwork has actually decoded. Waiting
     on the image is what keeps it clean - swapping early would flash an empty
     frame mid-fade. */
  function setTrack(t) {
    if (currentTrack && currentTrack.id === t.id) {
      currentTrack = t;   // same song, just refreshed state - no transition
      return;
    }
    var first = !currentTrack;
    currentTrack = t;
    var gen = ++swapGen;

    el.idle.hidden = true;
    el.stage.classList.remove("busy");

    // Empty the ticker now, while the box is faded out, so the clear is unseen.
    el.lyricbox.classList.add("swap");
    ticker.clear();
    glowTarget = 0.12;
    if (!first) el.info.classList.add("leave");

    var loaded = null;
    var imgReady = !t.art;
    var timeReady = false;
    var committed = false;

    function maybeCommit() {
      if (committed || gen !== swapGen || !imgReady || !timeReady) return;
      committed = true;
      commit();
    }

    function commit() {
      el.album.textContent = t.album || "";
      el.title.textContent = t.title || "";
      el.artist.textContent = t.artist || "";
      el.title.title = t.title || "";
      el.artist.title = t.artist || "";
      el.fill.style.width = "0%";
      el.knob.style.left = "0%";
      el.tNow.textContent = "0:00";
      // Set from the track itself: while paused the render loop repaints no
      // labels, so waiting for a tick would leave the old duration on screen.
      el.tEnd.textContent = mmss(t.duration_ms || 0);
      lastSecond = -1;

      if (loaded) {
        var next = artLayers[1 - artFront];
        var prev = artLayers[artFront];
        next.src = t.art;
        // Snap the incoming layer to its start state without animating there.
        next.style.transition = "none";
        next.classList.remove("show", "leaving");
        void next.offsetWidth;
        next.style.transition = "";
        next.classList.add("show");
        prev.classList.remove("show");
        prev.classList.add("leaving");
        artFront = 1 - artFront;

        el.artframe.classList.add("has-art");
        el.artglow.style.backgroundImage = "url(" + t.art + ")";
        coverPal = P.extract(loaded);
        choosePalette();
      } else {
        artLayers[artFront].classList.remove("show");
        artLayers[artFront].classList.add("leaving");
        el.artframe.classList.remove("has-art");
        el.artglow.style.backgroundImage = "";
        coverPal = P.DEFAULT;
        choosePalette();
      }

      // Park the new text below for one frame, then let it transition up.
      el.info.classList.remove("leave");
      el.info.classList.add("enter");
      void el.info.offsetWidth;
      el.info.classList.remove("enter");
      glowTarget = 1;

      // If lyrics never turn up, do not leave the ticker hidden forever.
      setTimeout(function () {
        if (gen === swapGen) el.lyricbox.classList.remove("swap");
      }, LYRIC_WAIT_MS);
    }

    if (t.art) {
      var img = new Image();
      img.onload = function () { loaded = img; imgReady = true; maybeCommit(); };
      img.onerror = function () { imgReady = true; maybeCommit(); };
      img.src = t.art;
    }
    setTimeout(function () { timeReady = true; maybeCommit(); }, first ? 0 : LEAVE_MS);
    setTimeout(function () {
      imgReady = true; timeReady = true; maybeCommit();
    }, ART_WAIT_MS);
  }

  function morphPalette(dt) {
    palCur = P.lerp(palCur, palTarget, 1 - Math.exp(-dt * 2.4));
    var changed = !palApplied;
    if (!changed) {
      for (var i = 0; i < P.KEYS.length; i++) {
        var k = P.KEYS[i], a = palCur[k], b = palApplied[k];
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 1.2) {
          changed = true; break;
        }
      }
    }
    if (changed) {
      P.applyToRoot(palCur);
      palApplied = { };
      for (var j = 0; j < P.KEYS.length; j++) {
        palApplied[P.KEYS[j]] = palCur[P.KEYS[j]].slice();
      }
    }
    viz.setPalette(palCur);
  }

  /* ---------------- render loop ---------------- */

  var last = performance.now();

  function frame(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    var k = cfg.intensity == null ? 1 : cfg.intensity;

    // The beat still drives the background rings; the cover no longer answers
    // to it, only to the bass band.
    if (pendingBeat) { viz.beat(); pendingBeat = false; }

    followAudio(dt);
    morphPalette(dt);

    var rect = el.artframe.getBoundingClientRect();
    viz.setArt(rect.left + rect.width / 2, rect.top + rect.height / 2, rect.width / 2);
    viz.setAudio(audio, spectrum);
    viz.setIntensity(k);
    viz.render(dt);

    tilt.x += (tilt.tx - tilt.x) * Math.min(1, dt * 6);
    tilt.y += (tilt.ty - tilt.y) * Math.min(1, dt * 6);
    // Bass band alone. Sub-linear in k, or the cover thumps hard enough to
    // look unstable at 300%.
    var scale = 1 + audio.bass * 0.038 * Math.pow(k, 0.8);
    el.artframe.style.transform =
      "perspective(1400px) rotateX(" + tilt.y.toFixed(2) + "deg) rotateY(" +
      tilt.x.toFixed(2) + "deg) scale(" + scale.toFixed(4) + ")";
    // The blurred backdrop dips while covers swap, so it fades rather than cuts.
    glowLevel += (glowTarget - glowLevel) * Math.min(1, dt * 5);
    el.artglow.style.opacity =
      ((0.42 + audio.level * 0.4) * glowLevel).toFixed(3);

    var t = clock.now();
    if (clock.dur > 0 && !scrub.active) {
      var pct = ((t / clock.dur) * 100).toFixed(2) + "%";
      el.fill.style.width = pct;
      el.knob.style.left = pct;
      var sec = Math.floor(t / 1000);
      if (sec !== lastSecond) {
        lastSecond = sec;
        el.tNow.textContent = mmss(t);
        el.tEnd.textContent = mmss(clock.dur);
      }
    }
    ticker.update(scrub.active ? scrub.frac * clock.dur : t);

    requestAnimationFrame(frame);
  }

  /* ---------------- config + settings UI ---------------- */

  function applyConfig(c) {
    cfg = c || {};
    el.stage.dataset.layout = cfg.layout || "center";
    el.stage.dataset.lyrics = cfg.show_lyrics === false ? "off" : "on";
    el.stage.dataset.info = cfg.show_info === false ? "off" : "on";
    el.stage.dataset.progress = cfg.show_progress === false ? "off" : "on";
    el.stage.dataset.controls = cfg.show_controls === false ? "off" : "on";
    document.body.dataset.chrome = cfg.show_chrome === false ? "off" : "on";
    // With nothing left inside it, drop #info from the grid entirely so the
    // ticker still gets the leftover row instead of collapsing.
    var bareStage = cfg.show_info === false && cfg.show_progress === false
      && cfg.show_controls === false;
    el.stage.classList.toggle("no-info", bareStage);
    // Nothing left but the cover, so centre it on the screen proper.
    el.stage.classList.toggle("art-only", bareStage && cfg.show_lyrics === false);
    document.body.classList.toggle("no-grain", cfg.grain === false);
    ticker.setOffset(cfg.lyrics_offset_ms || 0);
    ticker.remeasure();

    setChecked("grainToggle", cfg.grain !== false);
    setChecked("lyricsToggle", cfg.show_lyrics !== false);
    setChecked("infoToggle", cfg.show_info !== false);
    setChecked("progressToggle", cfg.show_progress !== false);
    setChecked("controlsToggle", cfg.show_controls !== false);
    setChecked("chromeToggle", cfg.show_chrome !== false);
    setChecked("onTopToggle", !!cfg.always_on_top);
    setChecked("fsToggle", !!cfg.start_fullscreen);
    setChecked("notifyToggle", !!cfg.notify_on_spotify);
    setChecked("autoToggle", !!cfg.auto_open);

    var intensity = Math.round((cfg.intensity == null ? 1 : cfg.intensity) * 100);
    $("intensity").value = intensity;
    $("intensityVal").textContent = intensity + "%";
    $("offsetVal").textContent = (cfg.lyrics_offset_ms || 0) + " ms";

    var colorMode = cfg.color_mode === "custom" ? "custom" : "cover";
    var hex = (cfg.custom_color || "#7c5cff").toLowerCase();
    var cSegs = $("segColor").children;
    for (var ci = 0; ci < cSegs.length; ci++) {
      cSegs[ci].classList.toggle("on", cSegs[ci].dataset.value === colorMode);
    }
    $("customColorRow").hidden = colorMode !== "custom";
    $("customHex").textContent = hex;
    $("customColor").value = hex;
    var known = false;
    var sw = $("swatches").querySelectorAll("button");
    for (var si = 0; si < sw.length; si++) {
      var hit = sw[si].dataset.color === hex;
      sw[si].classList.toggle("on", hit);
      known = known || hit;
    }
    $("swatches").querySelector(".picker").classList.toggle("on", !known);
    choosePalette();

    var segs = $("segLayout").children;
    for (var i = 0; i < segs.length; i++) {
      segs[i].classList.toggle("on", segs[i].dataset.value === (cfg.layout || "center"));
    }

    el.setup.hidden = !!cfg.connected;
    if (cfg.connected) el.stage.classList.remove("busy");
  }

  function setChecked(id, value) {
    var node = $(id);
    if (node) node.checked = !!value;
  }

  function setting(patch) { send({ type: "setting", patch: patch }); }

  function bindSwitch(id, key) {
    $(id).addEventListener("change", function () {
      var patch = {}; patch[key] = this.checked; setting(patch);
    });
  }

  bindSwitch("grainToggle", "grain");
  bindSwitch("lyricsToggle", "show_lyrics");
  bindSwitch("infoToggle", "show_info");
  bindSwitch("progressToggle", "show_progress");
  bindSwitch("controlsToggle", "show_controls");
  bindSwitch("chromeToggle", "show_chrome");

  $("btnArtOnly").addEventListener("click", function () {
    setting({
      show_info: false, show_progress: false,
      show_controls: false, show_lyrics: false, show_chrome: false
    });
    flash("Album art only. Press S for settings.");
  });
  $("btnShowAll").addEventListener("click", function () {
    setting({
      show_info: true, show_progress: true,
      show_controls: true, show_lyrics: true, show_chrome: true
    });
  });
  bindSwitch("onTopToggle", "always_on_top");
  bindSwitch("fsToggle", "start_fullscreen");
  bindSwitch("notifyToggle", "notify_on_spotify");
  bindSwitch("autoToggle", "auto_open");

  $("intensity").addEventListener("input", function () {
    $("intensityVal").textContent = this.value + "%";
    cfg.intensity = this.value / 100;
  });
  $("intensity").addEventListener("change", function () {
    setting({ intensity: this.value / 100 });
  });

  $("segColor").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (btn) setting({ color_mode: btn.dataset.value });
  });
  $("swatches").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button[data-color]");
    if (btn) setting({ color_mode: "custom", custom_color: btn.dataset.color });
  });
  // Live preview while dragging in the picker; saved once it is let go.
  $("customColor").addEventListener("input", function () {
    $("customHex").textContent = this.value;
    palTarget = P.fromHex(this.value);
  });
  $("customColor").addEventListener("change", function () {
    setting({ color_mode: "custom", custom_color: this.value });
  });

  $("segLayout").addEventListener("click", function (ev) {
    var btn = ev.target.closest("button");
    if (btn) setting({ layout: btn.dataset.value });
  });

  function nudge(delta) {
    var value = delta === 0 ? 0 : (cfg.lyrics_offset_ms || 0) + delta;
    setting({ lyrics_offset_ms: value });
    flash("Lyric timing " + (value > 0 ? "+" : "") + value + " ms");
  }
  $("offMinus").addEventListener("click", function () { nudge(-100); });
  $("offPlus").addEventListener("click", function () { nudge(100); });
  $("offZero").addEventListener("click", function () { nudge(0); });
  $("btnRefetch").addEventListener("click", function () {
    send({ type: "reload_lyrics" });
    flash("Looking for lyrics again");
  });
  $("btnDisconnect").addEventListener("click", function () {
    send({ type: "disconnect" });
    openPanel(false);
  });
  $("btnReconnect").addEventListener("click", function () {
    send({ type: "reconnect" });
    flash("Approve access in the browser tab that just opened");
  });

  /* ---------------- chrome ---------------- */

  function openPanel(open) {
    el.panel.hidden = false;
    requestAnimationFrame(function () { el.panel.classList.toggle("open", open); });
    if (!open) setTimeout(function () { el.panel.hidden = true; }, 450);
  }

  $("btnSettings").addEventListener("click", function () {
    openPanel(!el.panel.classList.contains("open"));
  });
  $("btnPanelClose").addEventListener("click", function () { openPanel(false); });
  $("btnClose").addEventListener("click", function () { send({ type: "action", name: "close" }); });
  $("btnMin").addEventListener("click", function () { send({ type: "action", name: "minimize" }); });
  $("btnFull").addEventListener("click", function () { send({ type: "action", name: "fullscreen" }); });
  $("btnLayout").addEventListener("click", function () {
    setting({ layout: (cfg.layout === "split") ? "center" : "split" });
  });
  $("btnLyrics").addEventListener("click", function () {
    setting({ show_lyrics: cfg.show_lyrics === false });
  });

  /* ---------------- setup ---------------- */

  $("btnCopy").addEventListener("click", function () {
    var text = $("redirect").textContent;
    var done = function () { flash("Redirect URI copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  });

  el.btnConnect.addEventListener("click", startConnect);
  el.clientId.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter") startConnect();
  });

  function startConnect() {
    var id = el.clientId.value.trim();
    if (!id) {
      el.authMsg.className = "msg err";
      el.authMsg.textContent = "Paste the Client ID from your Spotify app first.";
      return;
    }
    send({ type: "connect", client_id: id });
  }

  function onAuth(msg) {
    if (msg.state === "pending") {
      el.btnConnect.disabled = true;
      el.btnConnect.textContent = "Waiting...";
      el.authMsg.className = "msg";
      el.authMsg.textContent = "A browser tab just opened. Approve access there.";
    } else if (msg.state === "ok") {
      el.btnConnect.disabled = false;
      el.btnConnect.textContent = "Connect";
      el.authMsg.className = "msg ok";
      el.authMsg.textContent = "Connected.";
      setTimeout(function () { el.setup.hidden = true; }, 700);
    } else {
      el.btnConnect.disabled = false;
      el.btnConnect.textContent = "Connect";
      el.authMsg.className = "msg err";
      el.authMsg.textContent = msg.message || "Could not connect.";
    }
  }

  /* ---------------- ambience: idle UI, tilt, keys ---------------- */

  var idleTimer = null;
  function wake() {
    document.body.classList.remove("idle-ui", "hide-cursor");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (el.panel.classList.contains("open") || !el.setup.hidden) return;
      document.body.classList.add("idle-ui", "hide-cursor");
    }, 2800);
  }

  window.addEventListener("mousemove", function (ev) {
    wake();
    tilt.tx = ((ev.clientX / window.innerWidth) - 0.5) * 7;
    tilt.ty = -((ev.clientY / window.innerHeight) - 0.5) * 5;
  });
  window.addEventListener("mousedown", wake);
  window.addEventListener("wheel", wake, { passive: true });

  window.addEventListener("keydown", function (ev) {
    if (ev.target.tagName === "INPUT") return;
    wake();
    var key = ev.key.toLowerCase();

    if (key === " " || ev.code === "Space") {
      ev.preventDefault();
      togglePlay();
      return;
    }
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      ev.preventDefault();
      var forward = ev.key === "ArrowRight";
      if (ev.shiftKey) control(forward ? "next" : "previous");
      else seekBy(forward ? 5000 : -5000);
      return;
    }
    if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
      ev.preventDefault();
      nudgeVolume(ev.key === "ArrowUp" ? 5 : -5);
      return;
    }

    if (key === "escape") {
      if (!el.keys.hidden) { el.keys.hidden = true; return; }
      if (el.panel.classList.contains("open")) { openPanel(false); return; }
      send({ type: "action", name: "close" });
    } else if (key === "f" || ev.key === "F11") {
      send({ type: "action", name: "fullscreen" });
    } else if (key === "l") {
      setting({ layout: (cfg.layout === "split") ? "center" : "split" });
    } else if (key === "k") {
      setting({ show_lyrics: cfg.show_lyrics === false });
    } else if (key === "s") {
      openPanel(!el.panel.classList.contains("open"));
    } else if (key === "[") {
      nudge(-100);
    } else if (key === "]") {
      nudge(100);
    } else if (key === "?" || (ev.shiftKey && key === "/")) {
      el.keys.hidden = !el.keys.hidden;
    }
  });

  el.keys.addEventListener("click", function () { el.keys.hidden = true; });

  var flashTimer = null;
  function flash(text) {
    el.toast.textContent = text;
    el.toast.classList.add("on");
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { el.toast.classList.remove("on"); }, 2000);
  }

  /* ---------------- grain texture ---------------- */

  (function makeGrain() {
    var size = 140;
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var x = c.getContext("2d");
    var img = x.createImageData(size, size);
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    el.grain.style.backgroundImage = "url(" + c.toDataURL() + ")";
  })();

  /* ---------------- boot ---------------- */

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    viz.resize();
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { ticker.remeasure(); }, 180);
  });

  window.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });

  // Handy when poking at the running display from a console.
  window.Aurora = { viz: viz, ticker: ticker, clock: clock, cfg: function () { return cfg; } };

  connect();
  wake();
  requestAnimationFrame(frame);
})();
