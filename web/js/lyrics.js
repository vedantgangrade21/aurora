/* Line-synced lyric ticker. Sync is line-level: the current line lights up as
   a whole and stays lit until the next one starts. */
(function (global) {
  "use strict";

  var ANCHOR = 0.42;        // where the active line sits inside the viewport

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
  }

  Ticker.prototype.setOffset = function (ms) { this.offset = ms || 0; };

  Ticker.prototype.clear = function () {
    this.track.textContent = "";
    this.track.classList.remove("plain");
    this.track.style.transform = "translateY(0px)";
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

  Ticker.prototype.update = function (timeMs) {
    if (!this.nodes.length) return;

    if (this.kind === "plain") {
      var span = this.track.offsetHeight - this.scroll.clientHeight;
      if (span > 0 && this.duration > 0) {
        var frac = Math.max(0, Math.min(1, timeMs / this.duration));
        this.track.style.transform = "translateY(" + (-span * frac) + "px)";
      }
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

    var m = this._measure()[i];
    if (!m) return;
    var anchor = this.scroll.clientHeight * ANCHOR;
    this.track.style.transform = "translateY(" + (anchor - m.top - m.h / 2) + "px)";
  };

  global.AuroraLyrics = Ticker;
})(window);
