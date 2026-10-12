/* Pulls an accent palette out of the album cover.
   Art is served from our own origin, so the canvas stays readable. */
(function (global) {
  "use strict";

  var KEYS = ["base", "accent", "accentHot", "orb0", "orb1", "orb2", "orb3", "orb4"];

  var DEFAULT = {
    base: [7, 7, 12],
    accent: [124, 92, 255],
    accentHot: [182, 164, 255],
    orb0: [124, 92, 255],
    orb1: [255, 92, 138],
    orb2: [92, 200, 255],
    orb3: [150, 120, 220],
    orb4: [60, 50, 120]
  };

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2, h = 0, s = 0, d = max - min;
    if (d > 1e-6) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return [h, s, l];
  }

  function hue2rgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hsl2rgb(h, s, l) {
    h = ((h % 1) + 1) % 1;
    s = Math.max(0, Math.min(1, s));
    l = Math.max(0, Math.min(1, l));
    if (s === 0) { var v = Math.round(l * 255); return [v, v, v]; }
    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
    ];
  }

  function best(list, score, ok) {
    var top = null, topScore = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (ok && !ok(c)) continue;
      var s = score(c);
      if (s > topScore) { topScore = s; top = c; }
    }
    return top;
  }

  function shape(swatch, s, l) {
    return hsl2rgb(swatch.h, s == null ? swatch.s : s, l == null ? swatch.l : l);
  }

  function extract(img) {
    var S = 64;
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    var data;
    try {
      ctx.drawImage(img, 0, 0, S, S);
      data = ctx.getImageData(0, 0, S, S).data;
    } catch (err) {
      return Object.assign({}, DEFAULT);
    }

    var buckets = new Map();
    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 180) continue;
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var hsl = rgb2hsl(r, g, b);
      if (hsl[2] < 0.04 || hsl[2] > 0.97) continue;
      // Quantise finely on hue, coarsely elsewhere, so distinct colours survive.
      var key = ((hsl[0] * 24) | 0) * 1000 + ((hsl[1] * 5) | 0) * 100 + ((hsl[2] * 8) | 0);
      var e = buckets.get(key);
      if (!e) { e = { r: 0, g: 0, b: 0, n: 0 }; buckets.set(key, e); }
      e.r += r; e.g += g; e.b += b; e.n++;
    }

    var list = [];
    var total = 0;
    buckets.forEach(function (e) {
      var r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
      var hsl = rgb2hsl(r, g, b);
      list.push({ h: hsl[0], s: hsl[1], l: hsl[2], n: e.n });
      total += e.n;
    });
    if (!list.length) return Object.assign({}, DEFAULT);
    total = total || 1;

    var pop = function (c) { return c.n / total; };

    var dominant = best(list, function (c) { return c.n; });
    var vibrant = best(list,
      function (c) { return pop(c) * 0.7 + c.s * 1.5 * (1 - Math.abs(c.l - 0.52) * 1.4); },
      function (c) { return c.s > 0.24 && c.l > 0.18 && c.l < 0.84; });
    var light = best(list,
      function (c) { return pop(c) * 0.5 + c.s * 0.9 + c.l * 0.5; },
      function (c) { return c.l > 0.52 && c.s > 0.14; });
    var dark = best(list,
      function (c) { return pop(c) * 0.8 + c.s * 0.7; },
      function (c) { return c.l < 0.42; });
    var muted = best(list,
      function (c) { return pop(c); },
      function (c) { return c.s < 0.3; });

    // Fall back along the dominant hue when a slot has no real candidate,
    // which keeps monochrome covers coherent instead of defaulting to violet.
    if (!vibrant) vibrant = { h: dominant.h, s: Math.max(0.45, dominant.s), l: 0.55 };
    if (!light) light = { h: vibrant.h, s: Math.max(0.3, vibrant.s * 0.8), l: 0.72 };
    if (!dark) dark = { h: dominant.h, s: dominant.s, l: 0.22 };
    if (!muted) muted = { h: dominant.h, s: dominant.s * 0.35, l: 0.44 };

    var accent = {
      h: vibrant.h,
      s: Math.max(0.5, Math.min(0.95, vibrant.s * 1.25)),
      l: Math.max(0.5, Math.min(0.66, vibrant.l))
    };

    return {
      base: hsl2rgb(dominant.h, Math.min(0.55, dominant.s * 0.85), 0.052),
      accent: shape(accent),
      accentHot: hsl2rgb(accent.h, Math.min(0.9, accent.s * 1.05), 0.76),
      orb0: shape(accent, Math.min(1, accent.s * 1.1), 0.56),
      orb1: hsl2rgb(light.h, Math.max(0.4, light.s), 0.66),
      orb2: hsl2rgb(accent.h + 0.09, Math.max(0.45, accent.s * 0.9), 0.5),
      orb3: hsl2rgb(muted.h, Math.max(0.22, muted.s), 0.42),
      orb4: hsl2rgb(dark.h, Math.max(0.35, dark.s), 0.3)
    };
  }

  function lerp(a, b, t) {
    var out = {};
    for (var i = 0; i < KEYS.length; i++) {
      var k = KEYS[i], ca = a[k] || DEFAULT[k], cb = b[k] || DEFAULT[k];
      out[k] = [
        ca[0] + (cb[0] - ca[0]) * t,
        ca[1] + (cb[1] - ca[1]) * t,
        ca[2] + (cb[2] - ca[2]) * t
      ];
    }
    return out;
  }

  function css(c) {
    return "rgb(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + ")";
  }

  function rgba(c, a) {
    return "rgba(" + (c[0] | 0) + "," + (c[1] | 0) + "," + (c[2] | 0) + "," + a + ")";
  }

  function applyToRoot(p) {
    var s = document.documentElement.style;
    s.setProperty("--base", css(p.base));
    s.setProperty("--accent", css(p.accent));
    s.setProperty("--accent-hot", css(p.accentHot));
    s.setProperty("--accent-glow", rgba(p.accent, 0.45));
    document.body.style.backgroundColor = css(p.base);
  }

  global.AuroraPalette = {
    KEYS: KEYS,
    DEFAULT: DEFAULT,
    extract: extract,
    lerp: lerp,
    css: css,
    rgba: rgba,
    applyToRoot: applyToRoot
  };
})(window);
