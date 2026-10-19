/* Line-synced lyric ticker. Sync is line-level: the current line lights up as
   a whole and stays lit until the next one starts.

   The ticker can also be browsed: wheel or drag to scroll through the whole
   song. Three seconds after the last touch it glides back to the line being
   sung, and the highlight keeps following the music the whole time. */
(function (global) {
  "use strict";

  var ANCHOR = 0.42;          // where the active line sits inside the viewport
  var RESUME_MS = 3000;       // idle time before snapping back to the song
  var EASE = "cubic-bezier(.22,.61,.36,1)";

  function Ticker(els) {
    this.scroll = els.scroll;
    this.track = els.track;
    this.note = els.note;

    this.kind = "none";
    this.lines = [];
    this.nodes = [];
    this.metrics = null;
    this.index = -1;
    this.offset = 0;
    this.duration = 0;
    this.trackId = null;
    this.lastTime = 0;

    this.view = 0;            // current translateY of the track, in px
    this.manual = false;      // true while the user is browsing
    this.resumeTimer = null;
    this.drag = null;

    this._bindInput();
  }

  Ticker.prototype.setOffset = function (ms) { this.offset = ms || 0; };

  Ticker.prototype.clear = function () {
    this._endBrowse(false);
    this.track.textContent = "";
    this.track.classList.remove("plain");
    this._place(0, "instant");
    this.nodes = [];
    this.lines = [];
    this.metrics = null;
    this.index = -1;
  };

  Ticker.prototype.setLyrics = function (data, durationMs) {
    data = data || {};
    this.duration = durationMs || 0;
    this.clear();
    this.kind = data.kind || "none";
    this.trackId = data.track_id || null;

    if (this.kind === "synced" && data.lines && data.lines.length) {
      this.lines = data.lines;
      for (var i = 0; i < this.lines.length; i++) {
        this.nodes.push(this._node(this.lines[i].text));
      }
      this.note.textContent = "";
    } else if (this.kind === "plain" && data.text) {
      this.track.classList.add("plain");
      var rows = data.text.split(/\r?\n/);
      for (var j = 0; j < rows.length; j++) {
        this.nodes.push(this._node(rows[j]));
      }
      this.note.textContent = "Unsynced lyrics";
    } else {
      this.kind = "none";
      this.note.textContent = "No lyrics found for this track";
    }
    this.metrics = null;
  };

  Ticker.prototype._node = function (text) {
    var el = document.createElement("p");
    el.className = "lyric";
    if (!text || !text.trim()) {
      el.classList.add("inst");
      el.textContent = "♪";
    } else {
      el.textContent = text;
    }
    this.track.appendChild(el);
    return el;
  };

  /* Called on resize and on layout changes. Line boxes move, so drop the
     cached offsets and force the next update to re-anchor immediately
     instead of waiting for the song to reach the next line. */
  Ticker.prototype.remeasure = function () {
    this.metrics = null;
    for (var i = 0; i < this.nodes.length; i++) {
      this.nodes[i].classList.remove("active", "n1", "n2");
    }
    this.index = -1;
  };

  Ticker.prototype._measure = function () {
    if (this.metrics) return this.metrics;
    var out = [];
    for (var i = 0; i < this.nodes.length; i++) {
      out.push({ top: this.nodes[i].offsetTop, h: this.nodes[i].offsetHeight });
    }
    this.metrics = out;
    return out;
  };

  Ticker.prototype._seek = function (t) {
    var lines = this.lines;
    var lo = 0, hi = lines.length - 1, found = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return found;
  };

  /* ---- positioning ---------------------------------------------------- */

  /* translateY that puts line i on the anchor. */
  Ticker.prototype._anchorFor = function (i) {
    var m = this._measure()[i];
    if (!m) return this.view;
    return this.scroll.clientHeight * ANCHOR - m.top - m.h / 2;
  };

  /* Where unsynced lyrics sit for the current song position. */
  Ticker.prototype._plainY = function () {
    var span = this.track.offsetHeight - this.scroll.clientHeight;
    if (span <= 0 || this.duration <= 0) return 0;
    return -span * Math.max(0, Math.min(1, this.lastTime / this.duration));
  };

  /* How far browsing may go: first line to last line on the anchor. */
  Ticker.prototype._bounds = function () {
    if (this.kind === "synced") {
      var m = this._measure();
      if (!m.length) return [0, 0];
      return [this._anchorFor(m.length - 1), this._anchorFor(0)];
    }
    var span = this.track.offsetHeight - this.scroll.clientHeight;
    return [Math.min(0, -span), 0];
  };

  /* mode: "follow" (normal ticker easing), "browse" (tracks the hand),
     "return" (slow glide back), "instant". */
  Ticker.prototype._place = function (y, mode) {
    this.view = y;
    var t = "";
    if (mode === "browse") t = "transform .14s linear";
    else if (mode === "return") t = "transform 1.1s " + EASE;
    else if (mode === "instant") t = "none";
    this.track.style.transition = t;
    this.track.style.transform = "translateY(" + y.toFixed(1) + "px)";
  };

  /* ---- playback ------------------------------------------------------- */

  Ticker.prototype.update = function (timeMs) {
    this.lastTime = timeMs;
    if (!this.nodes.length) return;

    if (this.kind === "plain") {
      if (!this.manual) this._place(this._plainY(), "follow");
      return;
    }
    if (this.kind !== "synced") return;

    // Line-level only: the whole line lights up when it starts and stays lit
    // until the next one. Nothing to update on frames where it has not changed.
    var i = this._seek(timeMs + this.offset);
    if (i < 0) i = 0;
    if (i !== this.index) {
      this._focus(i);
      this.index = i;
    }
  };

  Ticker.prototype._focus = function (i) {
    var nodes = this.nodes;
    for (var d = -3; d <= 3; d++) {
      var n = nodes[this.index + d];
      if (n) n.classList.remove("active", "n1", "n2");
    }
    for (var e = -3; e <= 3; e++) {
      var node = nodes[i + e];
      if (!node) continue;
      var abs = Math.abs(e);
      if (abs === 0) node.classList.add("active");
      else if (abs === 1) node.classList.add("n1");
      else if (abs === 2) node.classList.add("n2");
    }
    // While browsing, the highlight moves on but the view stays put.
    if (!this.manual) this._place(this._anchorFor(i), "follow");
  };

  /* ---- browsing ------------------------------------------------------- */

  Ticker.prototype._browse = function (dy) {
    if (!this.nodes.length || this.kind === "none") return;
    if (!this.manual) {
      this.manual = true;
      this.track.classList.add("browsing");
    }
    var b = this._bounds();
    this._place(Math.max(b[0], Math.min(b[1], this.view + dy)), "browse");
    this._armResume();
  };

  Ticker.prototype._armResume = function () {
    clearTimeout(this.resumeTimer);
    var self = this;
    this.resumeTimer = setTimeout(function () { self._endBrowse(true); }, RESUME_MS);
  };

  Ticker.prototype._endBrowse = function (glide) {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
    if (!this.manual) return;
    this.manual = false;
    this.drag = null;
    this.track.classList.remove("browsing");
    if (!glide || !this.nodes.length) return;
    var y = this.kind === "plain" ? this._plainY()
      : this._anchorFor(Math.max(0, this.index));
    this._place(y, "return");
  };

  Ticker.prototype._bindInput = function () {
    var self = this;
    var area = this.scroll;

    area.addEventListener("wheel", function (ev) {
      if (!self.nodes.length) return;
      ev.preventDefault();
      var unit = ev.deltaMode === 1 ? 32 : ev.deltaMode === 2 ? area.clientHeight : 1;
      self._browse(-ev.deltaY * unit);
    }, { passive: false });

    area.addEventListener("pointerdown", function (ev) {
      if (!self.nodes.length || ev.button !== 0) return;
      self.drag = { y: ev.clientY };
      try { area.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    });
    area.addEventListener("pointermove", function (ev) {
      if (!self.drag) return;
      var dy = ev.clientY - self.drag.y;
      self.drag.y = ev.clientY;
      if (dy) self._browse(dy);
    });
    var stop = function (ev) {
      self.drag = null;
      try { area.releasePointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
    };
    area.addEventListener("pointerup", stop);
    area.addEventListener("pointercancel", stop);
  };

  global.AuroraLyrics = Ticker;
})(window);
