/* ---------------------------------------------------------------------------
 * renderer.js -- Rocksmith-style 3D note highway on a 2D canvas.
 *
 * Zero dependencies: a pinhole camera is projected by hand (a few multiply-
 * adds per vertex), which is plenty for the few hundred primitives visible
 * per frame and keeps the module portable. The draw() function is pure with
 * respect to time -- everything on screen is derived from (chart, t) -- so
 * seeking, pausing and rate changes need no special handling.
 *
 * World space:  x = frets (lane n spans [n-1, n]), y = up (string height),
 *               z = time-distance (0 = "now" line at the strings, + = future)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});

  // Rocksmith string colours: E A D G B e
  const STRING_COLORS = ["#e8203a", "#f2d40c", "#1f9cf0", "#f5891d", "#22c55e", "#b04ee6"];
  // MUST match TECH in R/chart.R
  const TECH = {
    HAMMER_ON: 1, PULL_OFF: 2, PALM_MUTE: 4, FRET_HAND_MUTE: 8, HARMONIC: 16,
    PINCH_HARMONIC: 32, VIBRATO: 64, TREMOLO: 128, ACCENT: 256, LINK_NEXT: 512,
    TAP: 1024, BEND: 2048, SLIDE: 4096, SLIDE_UNPITCHED: 8192, CHORD: 16384, IGNORE: 32768,
  };

  const N_FRETS = 24;
  const DEPTH = 22;              // world units from now-line to the far end
  const STRING_BASE = 0.3;       // height of the lowest string
  const STRING_GAP = 0.24;
  const PITCH = 0.42;            // camera tilt (rad)
  const CAM_UP = 0.62, CAM_BACK = 1.0;   // camera offset direction (scaled by zoom)
  const NOW_LINE_Y = 0.78;       // screen fraction where the now-line floor sits
  const CAM_SMOOTH_X = 0.45;     // s, spring time constant for panning
  const CAM_SMOOTH_ZOOM = 0.8;   // s, for zoom
  const CAM_MAX_SPEED = 14;      // frets per second
  const HIT_FLASH = 0.16;        // s
  // technique animation
  const BEND_Y = STRING_GAP * 0.5;   // world height per semitone (full bend = one string gap)
  const VIB_AMP = 0.065, VIB_HZ = 5.5;
  const TREM_HZ = 12;
  const ACCENT_RING = 0.38;          // s
  const NOTE_PENDING = 0, NOTE_HIT = 1, NOTE_MISSED = 2;   // judge states (input.js)
  const PASSED_FADE = 0.5;       // world units a note travels past the strings while fading

  // -- helpers -----------------------------------------------------------------
  function lowerBound(arr, x) {              // first index with arr[i] >= x
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }
  /** Bend amount (semitones) as guitarists say it: 1 = "1/2", 2 = "full", 3 = "1 1/2". */
  function bendText(semis) {
    const tones = Math.round(semis * 2) / 4;            // to quarter tones
    if (Math.abs(tones - 1) < 1e-6) return "full";
    const whole = Math.floor(tones + 1e-6), frac = tones - whole;
    const f = frac >= 0.74 ? "\u00be" : frac >= 0.49 ? "\u00bd" : frac >= 0.24 ? "\u00bc" : "";
    return (whole ? whole : "") + f || "\u00bc";
  }

  /** Critically damped spring towards `target` (Game Programming Gems 4, 1.10). */
  function smoothDamp(cur, target, vel, smoothTime, maxSpeed, dt) {
    const omega = 2 / smoothTime, x = omega * dt;
    const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const maxChange = maxSpeed * smoothTime;
    const change = Math.max(-maxChange, Math.min(maxChange, cur - target));
    const temp = (vel + omega * change) * dt;
    let v = (vel - omega * temp) * exp;
    let out = (cur - change) + (change + temp) * exp;
    if ((target - cur > 0) === (out > target)) { out = target; v = 0; }   // no overshoot
    if (Math.abs(target - out) < 0.002 && Math.abs(v) < 0.02) { out = target; v = 0; }   // settle: sub-pixel snap (cache hits)
    return [out, v];
  }
  function shade(hex, k) {                   // k < 1 darker, > 1 lighter
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(k < 1 ? c * k : c + (255 - c) * (k - 1))));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  // Pre-computed colour variants (no string building inside the render loop).
  const variants = (c) => ({
    base: c, stem: shade(c, 0.55), dark: shade(c, 0.45), light: shade(c, 1.5),
    glow: [1, 1.1, 1.2, 1.3, 1.4, 1.5].map((k) => shade(c, k)),
  });
  const COLORS = STRING_COLORS.map(variants);
  const GREY = variants("#6b7280");               // missed notes (when a judge is active)

  function col(list, key, n, Ctor, dflt) {   // JSON column -> typed array (nulls -> dflt)
    const src = (list && list[key]) || [];
    const out = new Ctor(n);
    for (let i = 0; i < n; i++) { const v = src[i]; out[i] = v == null ? dflt : v; }
    return out;
  }

  // ---- ghost neck: shared screen-space shapes for both renderers ---------------
  const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const OPEN_MIDI = { 6: [40, 45, 50, 55, 59, 64], 4: [28, 33, 38, 43] };   // E2.. / bass E1..
  const NECK_Z = 0.03;            // just behind the strings

  /** Canvas painter for neck shapes. */
  function paintShapes(ctx, shapes) {
    for (const sh of shapes) {
      ctx.beginPath();
      if (sh.k === "poly") { ctx.moveTo(sh.pts[0], sh.pts[1]); for (let i = 2; i < sh.pts.length; i += 2) ctx.lineTo(sh.pts[i], sh.pts[i + 1]); ctx.closePath(); }
      else if (sh.k === "line") { ctx.moveTo(sh.x1, sh.y1); ctx.lineTo(sh.x2, sh.y2); }
      else if (sh.k === "circle") ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
      else if (sh.k === "text") {
        ctx.font = `${sh.weight || 700} ${sh.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = sh.fill;
        ctx.fillText(sh.text, sh.x, sh.y); continue;
      }
      if (sh.fill) { ctx.fillStyle = sh.fill; ctx.fill(); }
      if (sh.stroke) { ctx.strokeStyle = sh.stroke; ctx.lineWidth = sh.lw || 1; ctx.stroke(); }
    }
  }
  /** SVG serialiser for the same shapes (DOM renderer). */
  function shapesToSvg(shapes) {
    const r = (v) => Math.round(v * 100) / 100;
    const paint = (sh) => `fill="${sh.fill || "none"}"` + (sh.stroke ? ` stroke="${sh.stroke}" stroke-width="${r(sh.lw || 1)}"` : "");
    return shapes.map((sh) => {
      if (sh.k === "poly") { let p = ""; for (let i = 0; i < sh.pts.length; i += 2) p += `${r(sh.pts[i])},${r(sh.pts[i + 1])} `; return `<polygon points="${p}" ${paint(sh)}/>`; }
      if (sh.k === "line") return `<line x1="${r(sh.x1)}" y1="${r(sh.y1)}" x2="${r(sh.x2)}" y2="${r(sh.y2)}" ${paint(sh)}/>`;
      if (sh.k === "circle") return `<circle cx="${r(sh.x)}" cy="${r(sh.y)}" r="${r(sh.r)}" ${paint(sh)}/>`;
      return `<text x="${r(sh.x)}" y="${r(sh.y)}" font-size="${r(sh.size)}" font-weight="${sh.weight || 700}" fill="${sh.fill}" text-anchor="middle" dominant-baseline="central">${sh.text}</text>`;
    }).join("");
  }

  /** JSON payload (see R/chart.R: chart_json) -> typed, pre-indexed chart. */
  function prepareChart(json) {
    // piano / harmonica charts: renderer-lanes.js
    if (json.instrument && json.instrument !== "guitar" && NS.prepareLaneChart) return NS.prepareLaneChart(json);
    const n = (json.notes && json.notes.t ? json.notes.t.length : 0);
    const notes = {
      n,
      t: col(json.notes, "t", n, Float64Array, 0),
      s: col(json.notes, "s", n, Int8Array, 0),
      f: col(json.notes, "f", n, Int8Array, 0),
      sus: col(json.notes, "sus", n, Float32Array, 0),
      tech: col(json.notes, "tech", n, Int32Array, 0),
      slide: col(json.notes, "slide", n, Int8Array, -1),
      slideU: col(json.notes, "slideU", n, Int8Array, -1),
      bend: col(json.notes, "bend", n, Float32Array, 0),
      chord: col(json.notes, "chord", n, Int32Array, -1),
    };
    let maxSus = 0;
    for (let i = 0; i < n; i++) if (notes.sus[i] > maxSus) maxSus = notes.sus[i];
    notes.maxSus = maxSus;

    // bend curves: flat arrays sorted by note; per note a [start, count) slice
    const nbp = json.bends && json.bends.n ? json.bends.n.length : 0;
    const bends = { n: nbp, note: col(json.bends, "n", nbp, Int32Array, -1),
                    t: col(json.bends, "t", nbp, Float64Array, 0), s: col(json.bends, "s", nbp, Float32Array, 0) };
    notes.bendStart = new Int32Array(n).fill(-1);
    notes.bendCount = new Int16Array(n);
    for (let k = 0; k < nbp; k++) {
      const i = bends.note[k];
      if (i < 0 || i >= n) continue;
      if (notes.bendStart[i] < 0) notes.bendStart[i] = k;
      notes.bendCount[i]++;
    }

    const nc = json.chords && json.chords.t ? json.chords.t.length : 0;
    const chords = {
      n: nc,
      t: col(json.chords, "t", nc, Float64Array, 0),
      hd: col(json.chords, "hd", nc, Uint8Array, 0),
      name: (json.chords && json.chords.name) || [],
      minF: new Int8Array(nc).fill(99), maxF: new Int8Array(nc).fill(-1),
    };
    // name a chord only when it changes (or after a 2 s gap), like the game
    chords.showName = new Uint8Array(nc);
    for (let i = 0; i < nc; i++) {
      chords.showName[i] = chords.name[i] && (i === 0 || chords.name[i] !== chords.name[i - 1] || chords.t[i] - chords.t[i - 1] > 2) ? 1 : 0;
    }
    for (let i = 0; i < n; i++) {
      const c = notes.chord[i];
      if (c < 0 || c >= nc) continue;
      const f = notes.f[i];
      if (f > 0 && f < chords.minF[c]) chords.minF[c] = f;
      if (f > chords.maxF[c]) chords.maxF[c] = f;
    }

    const na = json.anchors && json.anchors.t ? json.anchors.t.length : 0;
    const anchors = {
      n: na,
      t: col(json.anchors, "t", na, Float64Array, 0),
      fret: col(json.anchors, "fret", na, Int8Array, 1),
      width: col(json.anchors, "width", na, Float32Array, 4),
    };
    const nb = json.beats && json.beats.t ? json.beats.t.length : 0;
    const beats = { n: nb, t: col(json.beats, "t", nb, Float64Array, 0), m: col(json.beats, "m", nb, Int16Array, -1) };
    const ns = json.sections && json.sections.t ? json.sections.t.length : 0;
    const secNames = (json.sections && json.sections.name) || [];
    const sections = { n: ns, t: col(json.sections, "t", ns, Float64Array, 0), name: secNames,
                       label: (json.sections && json.sections.label) || secNames };

    const meta = json.meta || {};
    return {
      songKey: json.songKey || null,
      meta,
      nStrings: Math.max(1, Math.min(6, meta.n_strings || 6)),
      instrument: "guitar", lanes: false,
      duration: meta.song_length || (n ? notes.t[n - 1] + notes.sus[n - 1] + 2 : 0),
      notes, chords, anchors, beats, sections, bends,
    };
  }

  class HighwayRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.opts = { lookahead: 3, invertStrings: false, showFretNumbers: true, maxDpr: 2 };
      this.chart = null;
      this.W = 1; this.H = 1; this.dpr = 1;
      this.cam = { x: 3, vis: 9, vx: 0, vv: 0, tgt: null, init: false };
      this._p = { x: 0, y: 0, s: 0 };   // scratch projection outputs (no per-frame allocs)
      this._q = { x: 0, y: 0, s: 0 };
      this._r = { x: 0, y: 0, s: 0 };
      this._u = { x: 0, y: 0, s: 0 };
      this._active = new Float32Array(6);
      this._activeFret = new Int8Array(6);
      this._lastT = null;
      this._font = "";
      this._labels = [];                 // chord names collected per frame (flat: text, x, y, size, alpha)
      this.judge = null;                 // optional HitJudge (input.js): per-note hit/miss state
      this._rib = new Float64Array(4 * 42 + 8);   // ribbon polygon scratch (screen x,y pairs)
      this._deflX = new Float32Array(6); this._deflY = new Float32Array(6); this._deflOn = new Uint8Array(6);
      this.stats = { notesDrawn: 0 };
    }

    setOptions(o) { Object.assign(this.opts, o || {}); }

    /** Attach a HitJudge (input.js). While judge.active, only notes the judge
     *  marked as hit get hit effects, and missed notes are greyed out. */
    setJudge(judge) { this.judge = judge; }
    noteState(i) { const j = this.judge; return j && j.active && j.state ? j.state[i] : NOTE_HIT; }

    /** Release resources (used when switching renderers). */
    destroy() { this._layer = null; }

    setChart(chart) {
      this.chart = chart;
      this.cam.init = false;
      this.cam.tgt = null;
    }

    resize(w, h, dpr) {
      dpr = Math.min(dpr || 1, this.opts.maxDpr);
      this.W = Math.max(1, w); this.H = Math.max(1, h); this.dpr = dpr;
      this.canvas.width = Math.round(this.W * dpr);
      this.canvas.height = Math.round(this.H * dpr);
      this.canvas.style.width = this.W + "px";
      this.canvas.style.height = this.H + "px";
      const g = this.ctx.createLinearGradient(0, 0, 0, this.H);
      g.addColorStop(0, "#05060a"); g.addColorStop(0.35, "#0b0e17"); g.addColorStop(1, "#141826");
      this._bg = g;
      this._fog = null;   // rebuilt lazily (depends on camera)
    }

    // ---- camera ----------------------------------------------------------------
    stringY(s) {
      const n = this.chart ? this.chart.nStrings : 6;
      const pos = this.opts.invertStrings ? s : n - 1 - s;   // default: low E on top (Rocksmith)
      return STRING_BASE + pos * STRING_GAP;
    }
    laneX(fret) { return fret - 0.5; }                       // centre of fret lane

    /** x of string s's tuning peg on the headstock (6-in-line, low string nearest the nut). */
    pegX(s) { return this.chart && this.chart.nStrings === 4 ? -0.75 - s * 0.7 : -0.55 - s * 0.5; }

    /** Open-string note name for string s, honouring the song's tuning offsets. */
    stringNote(s) {
      const n = this.chart ? this.chart.nStrings : 6, base = OPEN_MIDI[n === 4 ? 4 : 6][s];
      const tun = (this.chart && this.chart.meta.tuning) || [];
      return base == null ? "" : NOTE_NAMES[(((base + (+tun[s] || 0)) % 12) + 12) % 12];
    }

    /**
     * Ghost neck in the string plane: translucent fretboard with frets, nut and
     * inlays, plus a headstock with tuning pegs labelled with each string's
     * open note. Returned as screen-space shapes so both renderers share it.
     */
    _neckShapes() {
      const n = this.chart.nStrings, out = [];
      const yb = STRING_BASE - 0.16, yt = STRING_BASE + (n - 1) * STRING_GAP + 0.16, ym = (yb + yt) / 2;
      const pt = (x, y) => { const o = {}; return this.project(x, y, NECK_Z, o) ? o : null; };
      const poly = (xy, style) => {
        const pts = [];
        for (const [x, y] of xy) { const o = pt(x, y); if (!o) return; pts.push(o.x, o.y); }
        out.push(Object.assign({ k: "poly", pts }, style));
      };
      const s0 = pt(0, ym);
      if (!s0) return out;
      const px = (w) => Math.max(1, s0.s * w);                  // world width -> px at the neck
      // headstock silhouette (left of the nut)
      const hx = n === 4 ? -3.6 : -3.55;
      poly([[0, yb], [-0.3, yb - 0.05], [hx + 0.7, yb - 0.17], [hx + 0.2, yb - 0.08], [hx, ym - 0.05],
            [hx + 0.1, yt - 0.02], [hx + 0.55, yt + 0.14], [hx + 1.6, yt + 0.08], [-0.8, yt + 0.15], [-0.3, yt + 0.07], [0, yt]],
           { fill: "rgba(74,50,34,0.55)", stroke: "rgba(255,225,190,0.28)", lw: px(0.02) });
      // fretboard
      poly([[0, yb], [N_FRETS, yb], [N_FRETS, yt], [0, yt]], { fill: "rgba(52,36,26,0.40)" });
      for (const y of [yb, yt]) {                               // binding
        const a = pt(0, y), b = pt(N_FRETS, y);
        if (a && b) out.push({ k: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "rgba(235,225,205,0.30)", lw: px(0.015) });
      }
      for (let f = 1; f <= N_FRETS; f++) {                      // fret wires
        const a = pt(f, yb), b = pt(f, yt);
        if (a && b) out.push({ k: "line", x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "rgba(205,212,225,0.45)", lw: px(0.03) });
      }
      for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {   // inlays (double at 12/24)
        const ys = f % 12 === 0 ? [ym - (yt - yb) * 0.22, ym + (yt - yb) * 0.22] : [ym];
        for (const y of ys) { const o = pt(f - 0.5, y); if (o) out.push({ k: "circle", x: o.x, y: o.y, r: o.s * 0.075, fill: "rgba(235,232,225,0.30)" }); }
      }
      poly([[-0.07, yb], [0.07, yb], [0.07, yt], [-0.07, yt]], { fill: "rgba(236,228,205,0.85)" });   // nut
      // tuning pegs + open-note labels
      for (let s = 0; s < n; s++) {
        const o = pt(this.pegX(s), this.stringY(s));
        if (!o) continue;
        const r = o.s * 0.12;
        out.push({ k: "circle", x: o.x, y: o.y, r, fill: "rgba(200,205,215,0.92)", stroke: COLORS[s].base, lw: Math.max(1.5, r * 0.28) });
        out.push({ k: "text", x: o.x, y: o.y + r * 0.05, size: Math.max(7, r * 1.25), text: this.stringNote(s), fill: "#15181f", weight: 800 });
      }
      return out;
    }

    /** Cached transparent layer holding the ghost neck (+ its screen bounds). */
    _neckLayer() {
      const key = `${this.canvas.width}x${this.canvas.height}|${this.camX}|${this.camZ}|${this.opts.invertStrings}|${this.chart.nStrings}|${(this.chart.meta.tuning || []).join()}`;
      if (this._neck && key === this._neckKey) return this._neck;
      const shapes = this._neckShapes();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const grow = (x, y, m) => { x0 = Math.min(x0, x - m); y0 = Math.min(y0, y - m); x1 = Math.max(x1, x + m); y1 = Math.max(y1, y + m); };
      for (const sh of shapes) {
        if (sh.pts) for (let i = 0; i < sh.pts.length; i += 2) grow(sh.pts[i], sh.pts[i + 1], 2);
        else if (sh.k === "line") { grow(sh.x1, sh.y1, 2); grow(sh.x2, sh.y2, 2); }
        else grow(sh.x, sh.y, (sh.r || sh.size || 0) + 2);
      }
      x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
      x1 = Math.min(this.W, Math.ceil(x1)); y1 = Math.min(this.H, Math.ceil(y1));
      const layer = (this._neck && this._neck.canvas) || document.createElement("canvas");
      const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
      layer.width = Math.ceil(w * this.dpr); layer.height = Math.ceil(h * this.dpr);
      const ctx = layer.getContext("2d");
      ctx.setTransform(this.dpr, 0, 0, this.dpr, -x0 * this.dpr, -y0 * this.dpr);
      paintShapes(ctx, shapes);
      this._neck = { canvas: layer, x: x0, y: y0, w, h, shapes };
      this._neckKey = key;
      return this._neck;
    }

    anchorAt(t) {
      const a = this.chart.anchors;
      if (!a.n) return -1;
      return Math.max(0, lowerBound(a.t, t + 1e-6) - 1);
    }

    /**
     * Where the camera wants to be: frame every anchor zone and fretted note
     * in the next ~1.5 s (not just the current anchor), so quick anchor flips
     * don't each trigger a pan.
     */
    _cameraTarget(t) {
      const a = this.chart.anchors, N = this.chart.notes;
      const win = Math.min(1.5, this.opts.lookahead * 0.5);
      let lo = Infinity, hi = -Infinity;
      if (a.n) {
        for (let i = Math.max(0, this.anchorAt(t)); i < a.n && a.t[i] <= t + win; i++) {
          lo = Math.min(lo, a.fret[i] - 1); hi = Math.max(hi, a.fret[i] - 1 + a.width[i]);
        }
      }
      for (let i = lowerBound(N.t, t); i < N.n && N.t[i] <= t + win; i++) {
        const f = N.f[i];
        if (f > 0) { lo = Math.min(lo, f - 1); hi = Math.max(hi, f); }
      }
      if (lo === Infinity) return null;
      // zoom in 2-fret steps so tiny span changes never trigger a zoom
      const vis = Math.max(8, Math.min(16, 2 * Math.ceil(((hi - lo) * 1.3 + 3) / 2)));
      return { lo, hi, x: (lo + hi) / 2, vis };
    }

    _updateCamera(t, dt) {
      const c = this.cam;
      const seek = this._lastCamT == null || Math.abs(t - this._lastCamT) > 1.0;
      this._lastCamT = t;
      const tgt = this._cameraTarget(t);
      if (tgt) {
        if (!c.tgt || seek) c.tgt = { x: tgt.x, vis: tgt.vis };
        else {
          // dead zone: pan only when upcoming notes would come within 1 fret of the edge
          const half = c.tgt.vis / 2 - 1;
          if (tgt.lo < c.tgt.x - half || tgt.hi > c.tgt.x + half) c.tgt.x = tgt.x;
          // zoom out as soon as needed, zoom in only when the view is >= 6 frets
          // too wide (2-fret zoom steps + this gap avoid "breathing")
          if (tgt.vis > c.tgt.vis || tgt.vis < c.tgt.vis - 4) c.tgt.vis = tgt.vis;
        }
      } else if (!c.tgt) c.tgt = { x: 4, vis: 9 };
      if (!c.init || seek || dt > 0.5) {
        c.x = c.tgt.x; c.vis = c.tgt.vis; c.vx = 0; c.vv = 0; c.init = true;
      } else if (dt > 0) {
        // critically damped spring: eases in AND out, no velocity jumps
        [c.x, c.vx] = smoothDamp(c.x, c.tgt.x, c.vx, CAM_SMOOTH_X, CAM_MAX_SPEED, dt);
        [c.vis, c.vv] = smoothDamp(c.vis, c.tgt.vis, c.vv, CAM_SMOOTH_ZOOM, CAM_MAX_SPEED, dt);
      }
      this.sinP = Math.sin(PITCH); this.cosP = Math.cos(PITCH);
      this.F = this.H * 1.4;                        // longish lens: gentle perspective like the game
      const depthNow = (this.F * (Math.round(c.vis * 512) / 512 / 2)) / (this.W * 0.47);
      const k = depthNow / (CAM_UP * this.sinP + CAM_BACK * this.cosP);
      // projection uses a camera quantised to 1/512 lane (sub-pixel) so a
      // settled camera keeps hitting the static layer cache
      this.camX = Math.round(c.x * 512) / 512;
      this.camY = CAM_UP * k; this.camZ = -CAM_BACK * k;
      // lens shift so the now-line floor lands at NOW_LINE_Y regardless of zoom
      const cyNow = (-this.camY) * this.cosP + (-this.camZ) * this.sinP;
      this.cx0 = this.W / 2;
      this.cy0 = this.H * NOW_LINE_Y + (this.F * cyNow) / depthNow;
    }

    /** World -> screen. Returns false if behind the camera. */
    project(x, y, z, out) {
      const dy = y - this.camY, dz = z - this.camZ;
      const cz = -dy * this.sinP + dz * this.cosP;
      if (cz < 0.1) return false;
      const s = this.F / cz;
      out.x = this.cx0 + (x - this.camX) * s;
      out.y = this.cy0 - (dy * this.cosP + dz * this.sinP) * s;
      out.s = s;
      return true;
    }

    _quad(x0, x1, y, z0, z1) {            // horizontal quad in plane y
      const p = this._p, q = this._q, r = this._r, u = this._u, ctx = this.ctx;
      if (!this.project(x0, y, z0, p) || !this.project(x1, y, z0, q) ||
          !this.project(x1, y, z1, r) || !this.project(x0, y, z1, u)) return false;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.lineTo(r.x, r.y); ctx.lineTo(u.x, u.y);
      ctx.closePath();
      return true;
    }
    _line(x0, y0, z0, x1, y1, z1) {
      const p = this._p, q = this._q;
      if (!this.project(x0, y0, z0, p) || !this.project(x1, y1, z1, q)) return;
      this.ctx.moveTo(p.x, p.y); this.ctx.lineTo(q.x, q.y);
    }
    _setFont(px, weight) {
      const f = `${weight || 700} ${Math.max(6, Math.round(px))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      if (f !== this._font) { this.ctx.font = f; this._font = f; }
    }

    // ---- main entry --------------------------------------------------------------
    /** Draw the frame for chart time `t` (s). `dt` = wall-clock s since last frame. */
    draw(t, dt) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._font = "";
      if (!this.chart) {
        ctx.fillStyle = this._bg;
        ctx.fillRect(0, 0, this.W, this.H);
        return;
      }
      this._updateCamera(t, dt);
      const zps = DEPTH / this.opts.lookahead;      // world units per second
      // Camera-static layers: cached while the camera rests, painted directly
      // while it moves (a cache re-render + blit would cost two passes).
      const camKey = `${this.canvas.width}x${this.canvas.height}|${this.camX}|${this.camZ}`;
      const moving = camKey !== this._prevCamKey && this.opts.cacheWhileMoving !== true;
      this._prevCamKey = camKey;
      if (moving) {
        ctx.fillStyle = this._bg;
        ctx.fillRect(0, 0, this.W, this.H);
        this._drawBoard();
        this._drawFog();
      } else {
        ctx.drawImage(this._staticLayer(), 0, 0, this.W, this.H);
      }
      this._drawBeats(t, zps);
      this._drawAnchorZones(t, zps);
      if (moving) paintShapes(ctx, this._neckShapes());
      else {
        const neck = this._neckLayer();
        if (neck.w > 1 && neck.h > 1) ctx.drawImage(neck.canvas, neck.x, neck.y, neck.w, neck.h);
      }
      this._drawChordFrames(t, zps);
      this.stats.notesDrawn = 0;
      this._drawNotes(t, zps, true);                 // future notes (behind strings)
      this._drawChordLabels();
      this._drawStrings(t);
      this._drawNotes(t, zps, false);                // just-hit notes fade in front
      this._drawFretNumbers(t);
      this._lastT = t;
    }

    /**
     * Background + fretboard + haze depend only on the camera, which is static
     * most of the time (it only pans on anchor changes), so they are rendered
     * into an offscreen layer and blitted with a single drawImage per frame.
     */
    _staticLayer() {
      const key = `${this.canvas.width}x${this.canvas.height}|${this.camX}|${this.camZ}`;
      if (this._layer && key === this._layerKey) return this._layer;
      if (!this._layer) this._layer = document.createElement("canvas");
      const layer = this._layer;
      if (layer.width !== this.canvas.width || layer.height !== this.canvas.height) {
        layer.width = this.canvas.width; layer.height = this.canvas.height;
      }
      const main = this.ctx;
      this.ctx = layer.getContext("2d", { alpha: false });
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.fillStyle = this._bg;
      this.ctx.fillRect(0, 0, this.W, this.H);
      this._drawBoard();
      this._drawFog();
      this.ctx = main;
      this._layerKey = key;
      return layer;
    }

    _drawBoard() {
      const ctx = this.ctx;
      for (let f = 1; f <= N_FRETS; f++) {
        if (!this._quad(f - 1, f, 0, -0.8, DEPTH)) continue;
        ctx.fillStyle = f % 2 ? "#161b29" : "#1a2031";
        ctx.fill();
      }
      // fret wires
      ctx.beginPath();
      for (let f = 0; f <= N_FRETS; f++) this._line(f, 0, -0.8, f, 0, DEPTH);
      ctx.strokeStyle = "rgba(150,165,200,0.35)"; ctx.lineWidth = 1;
      ctx.stroke();
      // inlay markers (3 5 7 9 12 ...) as subtle dots along the lanes at the now line
      ctx.fillStyle = "rgba(200,210,235,0.16)";
      for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {
        if (this._quad(f - 0.62, f - 0.38, 0, -0.7, -0.35)) ctx.fill();
      }
    }

    _drawBeats(t, zps) {
      const b = this.chart.beats, ctx = this.ctx;
      if (!b.n) return;
      const i0 = lowerBound(b.t, t - 0.05), tEnd = t + this.opts.lookahead;
      for (let i = i0; i < b.n && b.t[i] <= tEnd; i++) {
        const z = (b.t[i] - t) * zps, measure = b.m[i] >= 0;
        ctx.globalAlpha = this._alphaForZ(z);
        ctx.beginPath();
        this._line(0, 0.002, z, N_FRETS, 0.002, z);
        ctx.strokeStyle = measure ? "rgba(215,225,255,0.45)" : "rgba(170,185,225,0.18)";
        ctx.lineWidth = measure ? 2 : 1;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /** Highlight each anchor's fret zone over its time span (upcoming shifts visible). */
    _drawAnchorZones(t, zps) {
      const a = this.chart.anchors, ctx = this.ctx;
      if (!a.n) return;
      const tEnd = t + this.opts.lookahead * 0.9;
      ctx.fillStyle = "rgba(120,160,255,0.10)";
      for (let i = Math.max(0, this.anchorAt(t)); i < a.n && a.t[i] <= tEnd; i++) {
        const t0 = Math.max(a.t[i], t - 0.1), t1 = Math.min(i + 1 < a.n ? a.t[i + 1] : Infinity, tEnd);
        if (t1 <= t0) continue;
        const x0 = a.fret[i] - 1, x1 = x0 + a.width[i];
        if (this._quad(x0, x1, 0.001, (t0 - t) * zps, (t1 - t) * zps)) ctx.fill();
        // bright zone edges
        ctx.beginPath();
        this._line(x0, 0.003, (t0 - t) * zps, x0, 0.003, (t1 - t) * zps);
        this._line(x1, 0.003, (t0 - t) * zps, x1, 0.003, (t1 - t) * zps);
        ctx.strokeStyle = "rgba(140,180,255,0.35)"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    _drawFog() {
      // screen-space haze towards the horizon (cheap alternative to per-vertex fog)
      const ctx = this.ctx, p = this._p;
      if (!this.project(this.camX, 0, DEPTH, p)) return;
      const yH = Math.round(p.y);
      if (!this._fog || this._fogY !== yH) {
        const g = ctx.createLinearGradient(0, yH - 2, 0, yH + this.H * 0.28);
        g.addColorStop(0, "rgba(8,10,16,1)"); g.addColorStop(1, "rgba(8,10,16,0)");
        this._fog = g; this._fogY = yH;
      }
      ctx.fillStyle = this._fog;
      ctx.fillRect(0, 0, this.W, yH + this.H * 0.28);
    }

    _alphaForZ(z) {
      if (z < 0) return Math.max(0, 1 + z / PASSED_FADE);
      const f = z / DEPTH;
      return f < 0.7 ? 1 : Math.max(0, 1 - (f - 0.7) / 0.3);
    }

    _drawChordFrames(t, zps) {
      const c = this.chart.chords, ctx = this.ctx, p = this._p, q = this._q;
      this._labels.length = 0;
      if (!c.n) return;
      const i0 = lowerBound(c.t, t - 0.1), tEnd = t + this.opts.lookahead;
      let i1 = i0; while (i1 < c.n && c.t[i1] <= tEnd) i1++;
      const iNext = lowerBound(c.t, t);                  // nearest upcoming chord always gets its name
      const yTop = STRING_BASE + (this.chart.nStrings - 1) * STRING_GAP + 0.2;
      for (let i = i1 - 1; i >= i0; i--) {
        const z = (c.t[i] - t) * zps;
        const alpha = this._alphaForZ(z);
        if (alpha <= 0) continue;
        let x0, x1;
        if (c.maxF[i] > 0) { x0 = Math.min(c.minF[i], c.maxF[i]) - 1; x1 = c.maxF[i]; }
        else { const ai = this.anchorAt(c.t[i]); x0 = ai >= 0 ? this.chart.anchors.fret[ai] - 1 : 0; x1 = x0 + (ai >= 0 ? this.chart.anchors.width[ai] : 4); }
        x0 -= 0.08; x1 += 0.08;
        if (!this.project(x0, 0, z, p) || !this.project(x1, yTop, z, q)) continue;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = c.hd[i] ? "rgba(255,255,255,0.85)" : "rgba(230,236,255,0.55)";
        ctx.lineWidth = Math.max(1, q.s * (c.hd[i] ? 0.05 : 0.03));
        ctx.strokeRect(p.x, q.y, q.x - p.x, p.y - q.y);
        const name = c.name[i];
        if (name && (c.showName[i] || i === iNext) && !c.hd[i] && q.s > 14) {
          this._labels.push(name, p.x, q.y - 2, Math.min(28, q.s * 0.32), alpha);   // drawn after the notes
        }
      }
      ctx.globalAlpha = 1;
    }

    _drawChordLabels() {
      const L = this._labels, ctx = this.ctx;
      ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.lineJoin = "round";
      for (let k = 0; k < L.length; k += 5) {
        this._setFont(L[k + 3], 750);
        ctx.globalAlpha = L[k + 4];
        ctx.lineWidth = Math.max(2, L[k + 3] * 0.18); ctx.strokeStyle = "rgba(6,8,14,0.85)";
        ctx.strokeText(L[k], L[k + 1], L[k + 2]);
        ctx.fillStyle = "#f4f6ff"; ctx.fillText(L[k], L[k + 1], L[k + 2]);
      }
      ctx.globalAlpha = 1;
    }

    // ---- techniques: shared geometry (both renderers) ------------------------------

    /** Bend (semitones) of note i at absolute time `time`, from its curve.
     *  A first point at the onset with step > 0 is a pre-bend; otherwise the
     *  curve starts from 0 at the onset. Holds the last value afterwards. */
    bendAt(i, time) {
      const N = this.chart.notes, k0 = N.bendStart[i];
      if (k0 < 0) return 0;
      const B = this.chart.bends, k1 = k0 + N.bendCount[i];
      let tp = N.t[i], sp = B.t[k0] - N.t[i] < 0.01 ? B.s[k0] : 0;
      if (time <= tp) return sp;
      for (let k = k0; k < k1; k++) {
        if (time <= B.t[k]) {
          const span = B.t[k] - tp;
          return span > 1e-4 ? sp + (B.s[k] - sp) * (time - tp) / span : B.s[k];
        }
        tp = B.t[k]; sp = B.s[k];
      }
      return sp;
    }

    /** Lateral position (world x) of note i at `time`: slides move during the sustain. */
    noteX(i, time) {
      const N = this.chart.notes, f = N.f[i];
      if (f === 0) {
        const a = this.chart.anchors, ai = this.anchorAt(N.t[i]);
        return ai >= 0 ? a.fret[ai] - 1 + a.width[ai] / 2 : 2;
      }
      const x = this.laneX(f), st = N.slide[i] >= 0 ? N.slide[i] : N.slideU[i];
      if (st > 0 && N.sus[i] > 0) return x + (this.laneX(st) - x) * Math.max(0, Math.min(1, (time - N.t[i]) / N.sus[i]));
      return x;
    }

    /** Vertical displacement of note i at `time`: bend curve + vibrato wobble. */
    noteYOff(i, time) {
      const N = this.chart.notes;
      let dy = this.bendAt(i, time) * BEND_Y;
      if (N.tech[i] & TECH.VIBRATO) {
        const env = Math.max(0, Math.min(1, (time - N.t[i] - 0.05) / 0.15));   // vibrato sets in after the attack
        dy += VIB_AMP * env * Math.sin(2 * Math.PI * VIB_HZ * time);
      }
      return dy;
    }

    /** Approach animation: accented notes pulse while they come in. */
    gemScale(i, t) {
      const N = this.chart.notes;
      if (!(N.tech[i] & TECH.ACCENT)) return 1;
      const ahead = N.t[i] - t;
      return ahead > 0 && ahead < 2 ? 1 + 0.1 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) : 1;
    }

    /**
     * Sustain ribbon(s) of note i as screen-space polygons: cb(pts, nPairs, alpha).
     * The ribbon follows slides (x), bends and vibrato (y); it is consumed at the
     * strike line. Tremolo = faint ribbon + bright dashes at TREM_HZ.
     */
    forEachRibbon(i, t, zps, cb) {
      const N = this.chart.notes, sus = N.sus[i];
      if (sus <= 0) return;
      const ta = Math.max(N.t[i], t), tb = Math.min(N.t[i] + sus, t + this.opts.lookahead);
      if (tb <= ta) return;
      const tech = N.tech[i];
      const curved = N.bendStart[i] >= 0 || (tech & TECH.VIBRATO);
      const hw = N.f[i] === 0 ? 0.45 : 0.13, y0 = this.stringY(N.s[i]);
      const fade = this._alphaForZ((ta - t) * zps);
      const strip = (t0, t1, alpha) => {
        const K = curved ? Math.max(2, Math.min(40, Math.ceil((t1 - t0) * 30))) : 1;
        const pts = this._rib, p = this._p;
        for (let k = 0; k <= K; k++) {
          const tau = t0 + (t1 - t0) * k / K, z = (tau - t) * zps;
          const x = this.noteX(i, tau), y = y0 + (curved ? this.noteYOff(i, tau) : 0);
          if (!this.project(x - hw, y, z, p)) return;
          pts[2 * k] = p.x; pts[2 * k + 1] = p.y;
          if (!this.project(x + hw, y, z, p)) return;
          pts[4 * K + 2 - 2 * k] = p.x; pts[4 * K + 3 - 2 * k] = p.y;
        }
        cb(pts, 2 * (K + 1), alpha * fade);
      };
      if (tech & TECH.TREMOLO) {
        strip(ta, tb, 0.2);
        const period = 1 / TREM_HZ;
        for (let d = Math.floor(ta / period) * period; d < tb; d += period) {
          const d0 = Math.max(ta, d), d1 = Math.min(tb, d + period * 0.5);
          if (d1 > d0) strip(d0, d1, 0.6);
        }
      } else strip(ta, tb, 0.5);
    }

    /** Per string: glow level (this._active) and, while a bent/vibrato note
     *  rings, the deflected point (this._deflX/_deflY world units). */
    _stringState(t) {
      const N = this.chart.notes, act = this._active.fill(0), on = this._deflOn.fill(0);
      const i1 = lowerBound(N.t, t + 1e-4), i0 = lowerBound(N.t, t - Math.max(HIT_FLASH, N.maxSus));
      for (let i = i0; i < i1; i++) {
        if (this.noteState(i) !== NOTE_HIT) continue;
        const s = N.s[i], d = t - N.t[i], ringing = d < N.sus[i];
        const lvl = d < HIT_FLASH ? 1 - d / HIT_FLASH : (ringing ? 0.45 : 0);
        if (lvl > act[s]) act[s] = lvl;
        if (ringing && (N.bendStart[i] >= 0 || (N.tech[i] & TECH.VIBRATO))) {
          on[s] = 1; this._deflX[s] = this.noteX(i, t); this._deflY[s] = this.noteYOff(i, t);
        }
      }
    }

    /** Screen polyline of string s (peg -> [pushed point] -> fret 24): flat [x,y,...]. */
    stringPolyline(s) {
      const y = this.stringY(s), p = this._p, out = [];
      const add = (x, yy) => { if (this.project(x, yy, 0, p)) out.push(p.x, p.y); };
      add(this.pegX(s), y);
      if (this._deflOn[s]) {
        const x = this._deflX[s], dy = this._deflY[s];
        add(x - 2.2, y); add(x - 0.6, y + dy * 0.85); add(x, y + dy); add(x + 0.6, y + dy * 0.85); add(x + 2.2, y);
      }
      add(N_FRETS, y);
      return out;
    }

    /**
     * Hit effects at the strike line: cb(kind, x, y, scale, k, stringIndex) with
     * kind = "glow" | "puff" (muted) | "ring" (accent) | "spark" (harmonic) | "miss".
     * `scale` = px per world unit there; `k` = intensity or progress (0..1).
     */
    forEachEffect(t, cb) {
      const N = this.chart.notes, p = this._p;
      const J = this.judge && this.judge.active ? this.judge : null;    // judged: effects start when the player hit
      const i1 = lowerBound(N.t, t + (J ? J.window : 0) + 1e-4), i0 = lowerBound(N.t, t - Math.max(0.45, N.maxSus));
      for (let i = i0; i < i1; i++) {
        const tech = N.tech[i], st = this.noteState(i);
        const d = t - (J && st !== NOTE_PENDING ? J.markedAt[i] : N.t[i]);
        if (d < 0) continue;
        if (st === NOTE_MISSED) {
          if (d < 0.3 && this.project(this.noteX(i, N.t[i]), this.stringY(N.s[i]), 0, p)) cb("miss", p.x, p.y, p.s, 1 - d / 0.3, N.s[i]);
          continue;
        }
        if (st !== NOTE_HIT) continue;
        const ringing = t >= N.t[i] && t - N.t[i] < N.sus[i];
        if (!this.project(this.noteX(i, t), this.stringY(N.s[i]) + this.noteYOff(i, t), 0, p)) continue;
        if (d < HIT_FLASH || ringing) {
          let k = d < HIT_FLASH ? 1 - d / HIT_FLASH : 0.35;
          if (ringing && (tech & TECH.TREMOLO)) k = Math.max(k, Math.sin(2 * Math.PI * TREM_HZ * t) > 0 ? 0.75 : 0.2);
          cb(tech & (TECH.PALM_MUTE | TECH.FRET_HAND_MUTE) ? "puff" : "glow", p.x, p.y, p.s, k, N.s[i]);
        }
        if ((tech & TECH.ACCENT) && d < ACCENT_RING) cb("ring", p.x, p.y, p.s, d / ACCENT_RING, N.s[i]);
        if ((tech & (TECH.HARMONIC | TECH.PINCH_HARMONIC)) && d < 0.3) cb("spark", p.x, p.y, p.s, d / 0.3, N.s[i]);
      }
    }

    /** future=true: notes not yet hit (t >= now), far -> near. future=false: passed notes. */
    _drawNotes(t, zps, future) {
      const N = this.chart.notes, ch = this.chart.chords, ctx = this.ctx, p = this._p, q = this._q;
      if (!N.n) return;
      const tEnd = t + this.opts.lookahead;
      const iNow = lowerBound(N.t, t);
      let i0, i1;
      if (future) { i0 = iNow; i1 = iNow; while (i1 < N.n && N.t[i1] <= tEnd) i1++; }
      else { i0 = lowerBound(N.t, t - Math.max(PASSED_FADE / zps, N.maxSus, HIT_FLASH) - 0.05); i1 = iNow; }

      // sustain ribbons first (they sit "under" the gems)
      for (let i = i1 - 1; i >= i0; i--) {
        if (N.sus[i] <= 0 || N.t[i] + N.sus[i] <= t) continue;
        const missed = this.noteState(i) === NOTE_MISSED;
        ctx.fillStyle = missed ? "#4b5563" : COLORS[N.s[i]].base;
        this.forEachRibbon(i, t, zps, (pts, n, alpha) => {
          ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
          for (let k = 2; k < 2 * n; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
          ctx.closePath();
          ctx.globalAlpha = missed ? alpha * 0.4 : alpha;
          ctx.fill();
        });
      }
      ctx.globalAlpha = 1;

      // gems
      for (let i = i1 - 1; i >= i0; i--) {
        const c = N.chord[i];
        if (c >= 0 && ch.hd[c]) continue;             // repeated chord: frame only (like the game)
        const z = (N.t[i] - t) * zps;
        const alpha = this._alphaForZ(z);
        if (alpha <= 0) continue;
        const s = N.s[i], fret = N.f[i], tech = N.tech[i];
        const y = this.stringY(s) + (N.bendStart[i] >= 0 ? this.bendAt(i, Math.min(t, N.t[i])) * BEND_Y : 0);  // pre-bends ride high
        const missed = this.noteState(i) === NOTE_MISSED;
        const C = missed ? GREY : COLORS[s];
        ctx.globalAlpha = missed ? alpha * 0.55 : alpha;
        this.stats.notesDrawn++;

        if (fret === 0) {                               // open string: bar across the zone
          const ai = this.anchorAt(N.t[i]);
          const x0 = ai >= 0 ? this.chart.anchors.fret[ai] - 1 : 0;
          const x1 = x0 + (ai >= 0 ? this.chart.anchors.width[ai] : 4);
          if (!this.project(x0 + 0.05, y, z, p) || !this.project(x1 - 0.05, y, z, q)) continue;
          const h = Math.max(3, p.s * 0.12);
          ctx.fillStyle = C.base;
          ctx.fillRect(p.x, p.y - h / 2, q.x - p.x, h);
          ctx.strokeStyle = C.light; ctx.lineWidth = Math.max(1, h * 0.18);
          ctx.strokeRect(p.x, p.y - h / 2, q.x - p.x, h);
          continue;
        }

        const x = this.laneX(fret);
        // stem to the floor
        if (this.project(x, 0, z, q) && this.project(x, y, z, p)) {
          ctx.strokeStyle = C.stem; ctx.lineWidth = Math.max(1, p.s * 0.025);
          ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        } else continue;

        const sc = this.gemScale(i, t);
        const w = p.s * 0.74 * sc, h = p.s * 0.24 * sc;
        const gx = p.x - w / 2, gy = p.y - h / 2;
        const mutedGem = tech & (TECH.FRET_HAND_MUTE);
        const hollow = tech & (TECH.HAMMER_ON | TECH.PULL_OFF | TECH.TAP);   // legato: hollow gem
        const ga = ctx.globalAlpha;
        if (hollow) ctx.globalAlpha = ga * 0.38;
        ctx.fillStyle = mutedGem ? C.dark : C.base;
        ctx.fillRect(gx, gy, w, h);
        ctx.globalAlpha = ga;
        if (!hollow) { ctx.fillStyle = "rgba(255,255,255,0.28)"; ctx.fillRect(gx, gy, w, h * 0.32); }   // top highlight
        if (tech & TECH.PALM_MUTE) { ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(gx, gy + h * 0.55, w, h * 0.45); }
        ctx.lineWidth = Math.max(1, h * (tech & TECH.ACCENT ? 0.2 : hollow ? 0.16 : 0.1));
        ctx.strokeStyle = tech & TECH.ACCENT ? "#ffffff" : hollow ? C.light : C.dark;
        ctx.strokeRect(gx, gy, w, h);
        if (tech & (TECH.HARMONIC | TECH.PINCH_HARMONIC)) {   // harmonic: diamond overlay
          ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(1, h * 0.1);
          ctx.beginPath();
          ctx.moveTo(p.x, gy - h * 0.25); ctx.lineTo(p.x + h * 0.75, p.y);
          ctx.lineTo(p.x, gy + h * 1.25); ctx.lineTo(p.x - h * 0.75, p.y); ctx.closePath(); ctx.stroke();
        }

        if (h > 7) {
          const label = this._techLabel(tech, N.bend[i]);
          const showFret = this.opts.showFretNumbers;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          if (showFret || mutedGem) {
            this._setFont(h * 0.86, 800);
            ctx.lineWidth = Math.max(1.5, h * 0.12); ctx.strokeStyle = "rgba(0,0,0,0.75)";
            const txt = mutedGem ? "X" : String(fret);
            ctx.strokeText(txt, p.x, p.y + h * 0.04); ctx.fillStyle = "#ffffff"; ctx.fillText(txt, p.x, p.y + h * 0.04);
          }
          if (label) {
            this._setFont(h * 0.7, 800);
            ctx.fillStyle = "#ffffff"; ctx.textBaseline = "bottom";
            ctx.fillText(label, p.x, gy - h * 0.12);
          }
        }
      }
      ctx.globalAlpha = 1;

      if (!future) this._drawHits(t);
    }

    _techLabel(tech, bend) {
      if (tech & TECH.BEND) return "\u2191" + bendText(bend);
      if (tech & TECH.HAMMER_ON) return "H";
      if (tech & TECH.PULL_OFF) return "P";
      if (tech & TECH.TAP) return "T";
      if (tech & TECH.PALM_MUTE) return "PM";
      if (tech & (TECH.SLIDE | TECH.SLIDE_UNPITCHED)) return "\u2197";
      if (tech & TECH.VIBRATO) return "~";
      if (tech & TECH.TREMOLO) return "\u2261";
      return "";
    }

    /** Strings at the now-line: glow while a note rings, pushed up by bends / vibrato. */
    _drawStrings(t) {
      const ctx = this.ctx, p = this._p, n = this.chart.nStrings, act = this._active;
      this._stringState(t);
      ctx.lineJoin = "round";
      for (let s = 0; s < n; s++) {
        const pts = this.stringPolyline(s);
        if (pts.length < 4) continue;
        if (!this.project(0, this.stringY(s), 0, p)) continue;
        ctx.strokeStyle = COLORS[s].glow[Math.round(act[s] * 5)];
        ctx.lineWidth = Math.max(1.2, p.s * (0.018 + (n - 1 - s) * 0.003)) * (1 + act[s] * 1.2);
        ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
        for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
        ctx.stroke();
      }
    }

    _drawHits(t) {
      const ctx = this.ctx;
      ctx.globalCompositeOperation = "lighter";
      this.forEachEffect(t, (kind, x, y, s, k, str) => {
        const C = COLORS[str];
        if (kind === "glow" || kind === "puff") {
          const puff = kind === "puff", r = s * (puff ? 0.12 + 0.1 * k : 0.16 + 0.2 * k);
          ctx.globalAlpha = (puff ? 0.35 : 0.55) * k + 0.15;
          ctx.fillStyle = puff ? "#9ca3af" : C.base;
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
          if (!puff) {
            ctx.globalAlpha = 0.8 * k; ctx.fillStyle = "#ffffff";
            ctx.beginPath(); ctx.arc(x, y, r * 0.35, 0, Math.PI * 2); ctx.fill();
          }
        } else if (kind === "ring") {                     // accent shockwave
          ctx.globalAlpha = 0.9 * (1 - k); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = Math.max(1.5, s * 0.05 * (1 - k));
          ctx.beginPath(); ctx.arc(x, y, s * (0.25 + 0.75 * k), 0, Math.PI * 2); ctx.stroke();
          ctx.strokeStyle = C.light; ctx.lineWidth = Math.max(1, s * 0.03 * (1 - k));
          ctx.beginPath(); ctx.arc(x, y, s * (0.18 + 0.55 * k), 0, Math.PI * 2); ctx.stroke();
        } else if (kind === "spark") {                    // harmonic sparkle
          const r = s * (0.2 + 0.35 * k);
          ctx.globalAlpha = 1 - k; ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          for (let a = 0; a < 8; a++) {
            const ang = a * Math.PI / 4, rr = a % 2 ? r * 0.22 : r;
            ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
          }
          ctx.closePath(); ctx.fill();
        } else if (kind === "miss") {
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = k; ctx.strokeStyle = "#f87171"; ctx.lineWidth = Math.max(2, s * 0.04);
          const r = s * 0.14;
          ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
          ctx.globalCompositeOperation = "lighter";
        }
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    _drawFretNumbers(t) {
      const ctx = this.ctx, p = this._p, a = this.chart.anchors;
      const ai = this.anchorAt(t);
      const z0 = ai >= 0 ? a.fret[ai] : 0, z1 = ai >= 0 ? a.fret[ai] + a.width[ai] - 1 : -1;
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (let f = 1; f <= N_FRETS; f++) {
        if (!this.project(this.laneX(f), 0, -0.95, p)) continue;
        if (p.x < -20 || p.x > this.W + 20) continue;
        const inZone = f >= z0 && f <= z1;
        this._setFont(Math.min(26, p.s * (inZone ? 0.34 : 0.26)), inZone ? 800 : 600);
        ctx.fillStyle = inZone ? "#ffffff" : "rgba(190,200,225,0.55)";
        ctx.fillText(String(f), p.x, p.y);
      }
    }

    currentSection(t) {
      const sec = this.chart && this.chart.sections;
      if (!sec || !sec.n) return "";
      const i = lowerBound(sec.t, t + 1e-6) - 1;
      return i >= 0 ? sec.name[i] : "";
    }
  }

  NS.TECH = TECH;
  NS.STRING_COLORS = STRING_COLORS;
  NS.COLOR_VARIANTS = COLORS;
  NS.GREY_VARIANT = GREY;
  NS.GEOMETRY = { DEPTH, STRING_BASE, STRING_GAP, N_FRETS, HIT_FLASH, PASSED_FADE };
  NS.shapesToSvg = shapesToSvg;
  NS.bendText = bendText;
  NS.NOTE_STATE = { PENDING: NOTE_PENDING, HIT: NOTE_HIT, MISSED: NOTE_MISSED };
  NS.prepareChart = prepareChart;
  NS.HighwayRenderer = HighwayRenderer;
  NS._lowerBound = lowerBound;
})(window);
