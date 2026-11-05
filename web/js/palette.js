/* Pulls an accent palette out of the album cover.
   Art is served from our own origin, so the canvas stays readable. */
(function (global) {
  "use strict";

  var KEYS = ["base", "panel", "tint", "accent", "accentHot",
              "orb0", "orb1", "orb2", "orb3", "orb4"];

  var DEFAULT = {
    base: [7, 7, 12],
    panel: [18, 16, 30],
    tint: [222, 214, 255],
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

  /* The accent is the colour family that most fills the cover, picked from its
     own pixels. Each family scores area x colour strength, so a large muted
     wall beats a small saturated detail. Covers with no real colour resolve to
     white or black rather than having a tint invented for them. */
  var NEUTRAL_CHROMA = 0.10;  // below this a pixel reads as grey, not a colour
  var FAMILY_REACH = 25;      // degrees either side of the peak hue
  var SHADE_REACH = 15;       // tighter band the final shade is sampled from
  var BIG_AREA = 0.10;        // this much of the cover counts as a real colour...
  var BIG_CHROMA = 0.13;      // ...if it is at least this colourful on average
  var SMALL_AREA = 0.015;     // a small area counts only when strongly coloured
  var SMALL_CHROMA = 0.20;
  var LIT_LIGHTNESS = 0.35;
  var WHITE_SHARE = 0.08;     // lit pixels needed for a colourless cover to be
                              // "white"; thin lines on black stay "black"
  // Pale warm tones (paper, skin, sand) read to the eye as off-white rather than
  // as a colour, so they count for less - still enough to win a cover that has
  // nothing else, but not enough to outvote a real colour beside them.
  var BEIGE_WEIGHT = 0.4;

  function isBeige(deg, sat) {
    return deg >= 20 && deg < 62 && sat < 0.4;
  }

  function hueGap(a, b) {
    var gap = Math.abs(a - b);
    return Math.min(gap, 360 - gap);
  }

  /* The whole family decides whether this hue is a colour at all; the shade
     comes from the tighter band at its centre, favouring vivid lit pixels. A
     plain average drifts into whatever sits nearby, and shadows turn gold tan. */
  function sampleFamily(pixels, centre, total) {
    var area = 0, sum = 0, wr = 0, wg = 0, wb = 0, wt = 0;
    for (var k = 0; k < pixels.length; k++) {
      var px = pixels[k];
      var gap = hueGap(px.deg, centre);
      if (gap > FAMILY_REACH) continue;
      area++; sum += px.c;
      if (gap > SHADE_REACH) continue;
      var weight = px.vote * px.c * px.c * px.l * px.l;
      wr += px.r * weight; wg += px.g * weight; wb += px.b * weight; wt += weight;
    }
    if (!wt) return null;
    var share = area / total;
    var strength = sum / area;
    if ((share >= BIG_AREA && strength >= BIG_CHROMA) ||
        (share >= SMALL_AREA && strength >= SMALL_CHROMA)) {
      var picked = rgb2hsl(wr / wt, wg / wt, wb / wt);
      return { kind: "colour", h: picked[0], s: picked[1], l: picked[2] };
    }
    return null;
  }

  function pick(data) {
    var bins = new Float64Array(36);
    var pixels = [];
    var total = 0, litCount = 0, litR = 0, litG = 0, litB = 0;

    for (var i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 180) continue;
      total++;
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var hsl = rgb2hsl(r, g, b);
      var chroma = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
      if (hsl[2] >= LIT_LIGHTNESS) {
        litCount++; litR += r; litG += g; litB += b;
      }
      if (chroma < NEUTRAL_CHROMA) continue;
      var deg = hsl[0] * 360;
      var vote = chroma * (isBeige(deg, hsl[1]) ? BEIGE_WEIGHT : 1);
      bins[Math.floor(deg / 10) % 36] += vote;
      pixels.push({ r: r, g: g, b: b, deg: deg, c: chroma, l: hsl[2], vote: vote });
    }
    if (!total) return { kind: "black" };

    // Slide a 30-degree window (about one named colour) round the hue wheel, so
    // a family straddling two bins is not split in half and outvoted. Strongest
    // window first; the first that amounts to a real colour is the accent.
    var windows = [];
    for (var p = 0; p < 36; p++) {
      windows.push({ centre: p * 10 + 5,
                     mass: bins[(p + 35) % 36] + bins[p] + bins[(p + 1) % 36] });
    }
    windows.sort(function (a, b) { return b.mass - a.mass; });

    for (var n = 0; n < windows.length && windows[n].mass > 0; n++) {
      var found = sampleFamily(pixels, windows[n].centre, total);
      if (found) return found;
    }

    if (litCount / total >= WHITE_SHARE) {
      var shade = rgb2hsl(litR / litCount, litG / litCount, litB / litCount);
      return { kind: "white", h: shade[0], s: shade[1] };
    }
    return { kind: "black" };
  }

  function extract(img) {
    var S = 64;
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = S;
    var ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    try {
      ctx.drawImage(img, 0, 0, S, S);
      return build(pick(ctx.getImageData(0, 0, S, S).data));
    } catch (err) {
      return Object.assign({}, DEFAULT);
    }
  }

  /* One palette shape for both sources. Everything - background, glass panels,
     glow, secondary text - hangs off the single accent, and the drifting colour
     fields stay within its hue, so no colour appears that the accent lacks. */
  function build(c) {
    if (c.kind === "black") {
      // Black cannot be a highlight on black, so the background carries it and
      // the highlights go to white, the way a black cover's own lines do.
      return {
        base: [3, 3, 4], panel: [14, 14, 16], tint: [226, 226, 230],
        accent: [132, 132, 138], accentHot: [236, 236, 240],
        orb0: [46, 46, 50], orb1: [38, 38, 42], orb2: [42, 42, 46],
        orb3: [30, 30, 33], orb4: [22, 22, 25]
      };
    }
    if (c.kind === "white") {
      var ws = Math.min(0.2, c.s);
      return {
        base: hsl2rgb(c.h, ws, 0.05),
        panel: hsl2rgb(c.h, ws, 0.1),
        tint: hsl2rgb(c.h, ws, 0.92),
        accent: hsl2rgb(c.h, ws, 0.78),
        accentHot: hsl2rgb(c.h, ws, 0.94),
        orb0: hsl2rgb(c.h, ws, 0.62),
        orb1: hsl2rgb(c.h, ws, 0.7),
        orb2: hsl2rgb(c.h, ws, 0.52),
        orb3: hsl2rgb(c.h, ws, 0.42),
        orb4: hsl2rgb(c.h, ws, 0.3)
      };
    }
    // Keep the picked hue and character, lifted only as far as it needs to read
    // as light on a dark screen.
    var s = Math.max(0.35, Math.min(0.92, c.s * 1.2));
    var l = Math.max(0.48, Math.min(0.62, c.l));
    // Yellow is the one hue that stops being itself when dark: it turns brown.
    // A properly coloured yellow gets lifted further so it still reads as yellow.
    var deg = c.h * 360;
    if (deg >= 30 && deg < 65 && c.s >= 0.35) {
      s = Math.max(s, 0.72);
      l = Math.max(l, 0.58);
    }
    var hot = hsl2rgb(c.h, Math.min(0.9, s), 0.74);
    return {
      base: hsl2rgb(c.h, Math.min(0.5, s * 0.6), 0.06),
      panel: hsl2rgb(c.h, Math.min(0.4, s * 0.45), 0.1),
      // Secondary text: the accent washed most of the way to white, so it stays
      // readable while still clearly belonging to the cover.
      tint: [hot[0] + (255 - hot[0]) * 0.55, hot[1] + (255 - hot[1]) * 0.55,
             hot[2] + (255 - hot[2]) * 0.55],
      accent: hsl2rgb(c.h, s, l),
      accentHot: hot,
      orb0: hsl2rgb(c.h, s, 0.56),
      orb1: hsl2rgb(c.h + 0.015, s * 0.9, 0.64),
      orb2: hsl2rgb(c.h - 0.015, s, 0.5),
      orb3: hsl2rgb(c.h, s * 0.7, 0.42),
      orb4: hsl2rgb(c.h, s, 0.3)
    };
  }

  /* A full palette from a single chosen colour (the "custom colour" mode). */
  function fromHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return Object.assign({}, DEFAULT);
    var n = parseInt(m[1], 16);
    var c = rgb2hsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
    if (c[2] < 0.1) return build({ kind: "black" });
    if (c[2] > 0.9 || c[1] < 0.1) return build({ kind: "white", h: c[0], s: c[1] });
    return build({ kind: "colour", h: c[0], s: c[1], l: c[2] });
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
    s.setProperty("--glass", rgba(p.panel, 0.8));
    s.setProperty("--hair", rgba(p.accentHot, 0.13));
    s.setProperty("--text-soft", rgba(p.tint, 0.45));
    s.setProperty("--dim", rgba(p.tint, 0.66));
    s.setProperty("--faint", rgba(p.tint, 0.36));
    s.setProperty("--track-bg", rgba(p.tint, 0.14));
    document.body.style.backgroundColor = css(p.base);
  }

  global.AuroraPalette = {
    KEYS: KEYS,
    DEFAULT: DEFAULT,
    extract: extract,
    pick: pick,
    fromHex: fromHex,
    lerp: lerp,
    css: css,
    rgba: rgba,
    applyToRoot: applyToRoot
  };
})(window);
