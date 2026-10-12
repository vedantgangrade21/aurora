/* The reactive background: drifting colour fields, a spectrum halo around the
   cover, beat rings and drifting motes. All driven by real system audio. */
(function (global) {
  "use strict";

  var TAU = Math.PI * 2;
  var css = function (c, a) {
    return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a + ")";
  };

  // Each orb tracks one frequency band, so the field breathes with the mix.
  var ORBS = [
    { key: "orb0", band: "bass", ax: 0.30, ay: 0.20, sp: 0.055, ph: 0.0, size: 0.62 },
    { key: "orb1", band: "mid", ax: 0.36, ay: 0.26, sp: 0.081, ph: 1.9, size: 0.50 },
    { key: "orb2", band: "lowMid", ax: 0.27, ay: 0.31, sp: 0.067, ph: 3.4, size: 0.55 },
    { key: "orb3", band: "high", ax: 0.40, ay: 0.18, sp: 0.094, ph: 5.1, size: 0.42 },
    { key: "orb4", band: "air", ax: 0.22, ay: 0.34, sp: 0.043, ph: 2.6, size: 0.70 }
  ];

  var MAX_MOTES = 400;

  function Visualizer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.bg = document.createElement("canvas");
    this.bgx = this.bg.getContext("2d", { alpha: false });

    this.palette = global.AuroraPalette.DEFAULT;
    this.intensity = 1;
    this.moteCount = 170;
    this.time = 0;
    // Separate clock for the colour field, advanced at an intensity-scaled
    // rate. Scaling `time` directly would make the orbs jump whenever the
    // reactivity slider moved.
    this.flow = 0;
    this.dpr = 1;
    this.w = 0;
    this.h = 0;

    this.audio = { level: 0, bass: 0, lowMid: 0, mid: 0, high: 0, air: 0 };
    this.spectrum = new Float32Array(64);
    this.art = { cx: 0, cy: 0, r: 160 };

    this.rings = [];
    this.motes = [];
    this._seedMotes(MAX_MOTES);   // pooled once; only moteCount are drawn
    this.resize();
  }

  Visualizer.prototype._seedMotes = function (n) {
    this.motes.length = 0;
    for (var i = 0; i < n; i++) {
      this.motes.push({
        x: Math.random(), y: Math.random(),
        vx: (Math.random() - 0.5) * 0.006,
        vy: -(0.004 + Math.random() * 0.012),
        size: 0.4 + Math.random() * 1.9,
        phase: Math.random() * TAU,
        twinkle: 0.4 + Math.random() * 0.6
      });
    }
  };

  Visualizer.prototype.resize = function () {
    var rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(global.devicePixelRatio || 1, 1.5);
    this.w = Math.max(1, Math.round(rect.width * this.dpr));
    this.h = Math.max(1, Math.round(rect.height * this.dpr));
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    // The colour field is painted small and scaled up: the upscale does the
    // blurring for free, which is far cheaper than a real blur filter.
    this.bg.width = Math.max(2, Math.round(this.w * 0.2));
    this.bg.height = Math.max(2, Math.round(this.h * 0.2));
  };

  Visualizer.prototype.setPalette = function (p) { this.palette = p; };

  Visualizer.prototype.setIntensity = function (v) {
    if (v === this.intensity) return;
    this.intensity = v;
    this.moteCount = Math.min(MAX_MOTES, Math.round(60 + 110 * v));
  };

  Visualizer.prototype.setAudio = function (a, spectrum) {
    this.audio = a;
    if (spectrum) this.spectrum = spectrum;
  };

  Visualizer.prototype.setArt = function (cx, cy, r) {
    this.art.cx = cx * this.dpr;
    this.art.cy = cy * this.dpr;
    this.art.r = r * this.dpr;
  };

  Visualizer.prototype.beat = function () {
    var k = this.intensity;
    var hot = k >= 2.4;
    // Rings live ~1.15s and the beat cooldown caps the rate at ~2.5/s, so at
    // most ~3 overlap. This is a safety net, not a second throttle - set too
    // low it would start dropping beats and make fast tracks look arrhythmic.
    if (this.rings.length > (hot ? 5 : 3)) return;

    var power = 0.55 + this.audio.bass * 0.6;
    this.rings.push({ t: 0, power: power });
    // Only well past full reactivity does a hit throw a trailing echo.
    if (hot) this.rings.push({ t: -0.12, power: power * 0.7 });

    var kick = 0.012 * Math.min(k, 2.5);
    var step = hot ? 2 : 3;
    for (var i = 0; i < this.moteCount; i += step) {
      var m = this.motes[i];
      m.vx += (m.x - 0.5) * kick;
      m.vy += (m.y - 0.5) * kick;
    }
  };

  Visualizer.prototype.render = function (dt) {
    var k = this.intensity;
    this.time += dt;
    this.flow += dt * (0.75 + Math.min(k, 3) * 0.32);
    this._field(k);

    var ctx = this.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.bg, 0, 0, this.w, this.h);

    this._sheen();
    this._seat();
    this._motes(dt, k);
    this._halo(k);
    this._rings(dt, k);
  };

  /* Drifting colour fields, painted at low resolution. */
  Visualizer.prototype._field = function (k) {
    var g = this.bgx, W = this.bg.width, H = this.bg.height;
    var p = this.palette, t = this.flow;
    var diag = Math.sqrt(W * W + H * H);

    g.globalCompositeOperation = "source-over";
    g.fillStyle = css(p.base, 1);
    g.fillRect(0, 0, W, H);

    // Five additive orbs stack, so brightness needs a ceiling or high
    // reactivity washes the whole field to white. It rises with k, but well
    // short of linearly.
    var ceiling = Math.min(0.82, 0.55 * Math.pow(k, 0.45));
    var reachK = Math.min(k, 2.2);

    g.globalCompositeOperation = "lighter";
    for (var i = 0; i < ORBS.length; i++) {
      var o = ORBS[i];
      var energy = this.audio[o.band] || 0;
      var x = W * (0.5 + Math.cos(t * o.sp + o.ph) * o.ax
                       + Math.sin(t * o.sp * 0.63 + o.ph * 1.7) * o.ax * 0.35);
      var y = H * (0.5 + Math.sin(t * o.sp * 1.21 + o.ph) * o.ay
                       + Math.cos(t * o.sp * 0.47 + o.ph * 2.3) * o.ay * 0.4);
      var r = diag * o.size * (0.46 + energy * 0.38 * reachK);
      var alpha = Math.min(ceiling,
        (0.17 + energy * 0.36 * k) * (0.6 + this.audio.level * 0.6));

      var grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, css(p[o.key], alpha));
      grad.addColorStop(0.45, css(p[o.key], alpha * 0.35));
      grad.addColorStop(1, css(p[o.key], 0));
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, r, 0, TAU);
      g.fill();
    }
  };

  /* A slow conic sweep adds depth so the field never looks flat. */
  Visualizer.prototype._sheen = function () {
    var ctx = this.ctx;
    if (!ctx.createConicGradient) return;
    var p = this.palette;
    var grad = ctx.createConicGradient(this.flow * 0.06, this.w * 0.5, this.h * 0.5);
    grad.addColorStop(0, css(p.orb1, 0));
    grad.addColorStop(0.3, css(p.orb1, 0.05 + this.audio.mid * 0.05));
    grad.addColorStop(0.55, css(p.orb2, 0));
    grad.addColorStop(0.8, css(p.orb0, 0.045 + this.audio.high * 0.05));
    grad.addColorStop(1, css(p.orb1, 0));
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = "source-over";
  };

  /* Slight darkening under the cover so it reads as a solid object. */
  Visualizer.prototype._seat = function () {
    var ctx = this.ctx, a = this.art;
    var r = a.r * 2.1;
    var grad = ctx.createRadialGradient(a.cx, a.cy, a.r * 0.6, a.cx, a.cy, r);
    grad.addColorStop(0, "rgba(0,0,0,0.34)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(a.cx, a.cy, r, 0, TAU);
    ctx.fill();
  };

  Visualizer.prototype._motes = function (dt, k) {
    var ctx = this.ctx, p = this.palette;
    // Rise speed tapers - past ~2x the motes streak rather than drift.
    var lift = 0.4 + this.audio.air * 1.8 * Math.min(k, 2.0);
    var gain = 0.06 + this.audio.air * 0.55 * k;
    var cap = Math.min(0.85, 0.6 * Math.sqrt(k));
    var swell = 1 + this.audio.air * 0.7 * Math.min(k, 2.0);

    ctx.globalCompositeOperation = "lighter";
    for (var i = 0; i < this.moteCount; i++) {
      var m = this.motes[i];
      m.x += (m.vx + Math.sin(this.flow * 0.4 + m.phase) * 0.0012) * dt * 6;
      m.y += m.vy * dt * 6 * lift;
      m.vx *= 0.985;
      if (m.y < -0.05) { m.y = 1.05; m.x = Math.random(); m.vy = -(0.004 + Math.random() * 0.012); }
      if (m.x < -0.05) m.x = 1.05;
      if (m.x > 1.05) m.x = -0.05;

      var twinkle = 0.55 + Math.sin(this.flow * 2.1 + m.phase) * 0.45;
      var alpha = gain * twinkle * m.twinkle;
      if (alpha <= 0.005) continue;
      ctx.fillStyle = css(p.accentHot, Math.min(cap, alpha));
      ctx.beginPath();
      ctx.arc(m.x * this.w, m.y * this.h, m.size * this.dpr * swell, 0, TAU);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  /* Circular spectrum radiating from behind the cover. */
  Visualizer.prototype._halo = function (k) {
    var ctx = this.ctx, a = this.art, p = this.palette;
    var spec = this.spectrum;
    var N = 128;
    var inner = a.r * 1.07;
    // Slightly sub-linear so the bars stay on screen when turned right up.
    var maxLen = a.r * 0.62 * Math.pow(k, 0.85);
    var boost = Math.min(1.55, Math.sqrt(k));

    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";

    // Two passes: a wide soft one for bloom, a tight bright one for definition.
    for (var pass = 0; pass < 2; pass++) {
      ctx.lineWidth = (pass === 0 ? 8 * boost : 2.2) * this.dpr;
      ctx.strokeStyle = css(pass === 0 ? p.accent : p.accentHot,
                            Math.min(0.85, (pass === 0 ? 0.14 : 0.62) * boost));
      ctx.beginPath();
      for (var i = 0; i < N; i++) {
        var t = i / N;
        // Mirror the spectrum across the vertical axis for a symmetric halo.
        var m = t < 0.5 ? t * 2 : (1 - t) * 2;
        var idx = Math.min(spec.length - 1, Math.floor(m * (spec.length - 1)));
        var v = spec[idx] || 0;
        var len = a.r * 0.02 + v * maxLen;
        var ang = -Math.PI / 2 + t * TAU;
        var ca = Math.cos(ang), sa = Math.sin(ang);
        ctx.moveTo(a.cx + ca * inner, a.cy + sa * inner);
        ctx.lineTo(a.cx + ca * (inner + len), a.cy + sa * (inner + len));
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  Visualizer.prototype._rings = function (dt, k) {
    var ctx = this.ctx, a = this.art, p = this.palette;
    // Expansion is tapered hard: linear scaling would fling rings off screen
    // before they had a chance to fade.
    var spread = 1.5 * Math.pow(k, 0.6);
    var peak = Math.min(0.55, 0.32 * Math.sqrt(k));
    var weight = Math.min(1.8, Math.sqrt(k));

    ctx.globalCompositeOperation = "lighter";
    for (var i = this.rings.length - 1; i >= 0; i--) {
      var ring = this.rings[i];
      ring.t += dt / 1.15;
      if (ring.t >= 1) { this.rings.splice(i, 1); continue; }
      if (ring.t < 0) continue;   // echo rings wait their turn
      var ease = 1 - Math.pow(1 - ring.t, 3);
      var radius = a.r * (1.04 + ease * spread);
      var alpha = (1 - ring.t) * (1 - ring.t) * peak * ring.power;
      ctx.lineWidth = Math.max(0.5, (2.4 - ring.t * 2) * this.dpr * weight);
      ctx.strokeStyle = css(p.accentHot, alpha);
      ctx.beginPath();
      ctx.arc(a.cx, a.cy, radius, 0, TAU);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  global.AuroraViz = Visualizer;
})(window);
