/* ---------------------------------------------------------------------------
 * renderer-lanes.js -- the note highway for piano and harmonica ("lane charts",
 * R/instruments.R). Same camera, timing and judge contract as renderer.js;
 * the guitar's strings and frets become lanes:
 *
 *   piano      one lane per key above a 3D keyboard (white lanes 1 unit wide,
 *              black lanes narrower, between them); notes are blocks whose
 *              length is the note's duration, coloured by hand; keys go down
 *              (and light up) while their note sounds.
 *   harmonica  ten lanes above a 10-hole harmonica; blocks are coloured by
 *              breath (blow = blue, draw = orange, overblow = violet) and
 *              carry the tab ("4", "-4", "-3''", "6o"); bends are striped.
 *
 * World space as in renderer.js: x = lanes, y = up, z = time-distance
 * (0 = strike line, + = future). The instrument lies at z < 0.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});

  const DEPTH_PER_LANE = 22 / 12;      // highway depth scales with its width (same look as the guitar's)
  const PITCH = 0.42, CAM_UP = 0.62, CAM_BACK = 1.0;
  const NOW_LINE_Y = 0.70;             // strike line (screen fraction); the instrument sits below it
  const HIT_FLASH = 0.16;
  const MIN_BLOCK = 0.09;              // s: shortest block drawn
  const NOTE_PENDING = 0, NOTE_HIT = 1, NOTE_MISSED = 2;
  const IS_BLACK = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
  const BLACK_SHIFT = { 1: -0.1, 3: 0.1, 6: -0.12, 8: 0, 10: 0.12 };   // black keys sit off-centre, like a real keyboard
  const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const HAND = ["#60a5fa", "#34d399"];                                 // left, right
  const BREATH = { blow: "#38bdf8", draw: "#fb923c", over: "#c084fc" };

  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };
  function shade(hex, k) {
    const n = parseInt(hex.slice(1), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(k < 1 ? c * k : c + (255 - c) * (k - 1))));
    return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  }
  const variants = (c) => ({ base: c, top: shade(c, 1.18), side: shade(c, 0.62), dark: shade(c, 0.45), light: shade(c, 1.55), dim: shade(c, 0.7) });
  const HANDV = HAND.map(variants);
  const BREATHV = { blow: variants(BREATH.blow), draw: variants(BREATH.draw), over: variants(BREATH.over) };
  const GREYV = variants("#6b7280");
  function col(list, key, n, Ctor, dflt) {
    const src = (list && list[key]) || [], out = new Ctor(n);
    for (let i = 0; i < n; i++) { const v = src[i]; out[i] = v == null ? dflt : v; }
    return out;
  }

  /** Harmonica tab of a note: "4" blow, "-4" draw, "-3''" bent two semitones, "6o" overblow. */
  function harpTab(hole, blow, bend, ob) {
    return (blow ? "" : "-") + hole + (ob ? "o" : "'".repeat(Math.max(0, bend)));
  }
  NS.harpTab = harpTab;

  /** Lane chart JSON (R/chart.R lane_chart_payload) -> typed chart (same top-level shape as prepareChart). */
  function prepareLaneChart(json) {
    const N0 = json.notes || {}, n = N0.t ? N0.t.length : 0;
    const notes = {
      n,
      t: col(N0, "t", n, Float64Array, 0), sus: col(N0, "sus", n, Float32Array, 0),
      midi: col(N0, "midi", n, Int16Array, 60), chord: col(N0, "chord", n, Int32Array, -1),
      hand: col(N0, "hand", n, Uint8Array, 1),
      hole: col(N0, "hole", n, Int8Array, 0), blow: col(N0, "blow", n, Uint8Array, 1),
      bend: col(N0, "bend", n, Int8Array, 0), ob: col(N0, "ob", n, Uint8Array, 0),
      // guitar columns (zeros) so generic code (tests, tools) never meets undefined
      s: new Int8Array(n), f: new Int8Array(n), tech: new Int32Array(n),
    };
    let maxSus = 0, lowest = 127;
    for (let i = 0; i < n; i++) { if (notes.sus[i] > maxSus) maxSus = notes.sus[i]; if (notes.midi[i] < lowest) lowest = notes.midi[i]; }
    notes.maxSus = maxSus;
    const nc = json.chords && json.chords.t ? json.chords.t.length : 0;
    const chords = { n: nc, t: col(json.chords, "t", nc, Float64Array, 0), name: (json.chords && json.chords.name) || [],
                     hd: col(json.chords, "hd", nc, Uint8Array, 0) };
    chords.showName = new Uint8Array(nc);
    for (let i = 0; i < nc; i++) {
      chords.showName[i] = chords.name[i] && (i === 0 || chords.name[i] !== chords.name[i - 1] || chords.t[i] - chords.t[i - 1] > 2) ? 1 : 0;
    }
    const nb = json.beats && json.beats.t ? json.beats.t.length : 0;
    const beats = { n: nb, t: col(json.beats, "t", nb, Float64Array, 0), m: col(json.beats, "m", nb, Int16Array, -1) };
    const ns = json.sections && json.sections.t ? json.sections.t.length : 0;
    const secNames = (json.sections && json.sections.name) || [];
    const sections = { n: ns, t: col(json.sections, "t", ns, Float64Array, 0), name: secNames,
                       label: (json.sections && json.sections.label) || secNames };
    const meta = json.meta || {};
    return {
      songKey: json.songKey || null, meta, instrument: json.instrument, lanes: true, nStrings: 0,
      lowestMidi: n ? lowest : 60,
      duration: meta.song_length || (n ? notes.t[n - 1] + notes.sus[n - 1] + 2 : 0),
      notes, chords, beats, sections,
      anchors: { n: 0, t: new Float64Array(0), fret: new Int8Array(0), width: new Float32Array(0) },
      bends: { n: 0, note: new Int32Array(0), t: new Float64Array(0), s: new Float32Array(0) },
    };
  }

  class LaneHighwayRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d", { alpha: false });
      this.opts = { lookahead: 3, showFretNumbers: true, maxDpr: 2 };
      this.chart = null; this.judge = null;
      this.W = 1; this.H = 1; this.dpr = 1;
      this._p = { x: 0, y: 0, s: 0 }; this._q = { x: 0, y: 0, s: 0 }; this._r = { x: 0, y: 0, s: 0 }; this._u = { x: 0, y: 0, s: 0 };
      this._font = "";
      this.stats = { notesDrawn: 0, pressed: 0 };
    }
    setOptions(o) { Object.assign(this.opts, o || {}); this._layerKey = null; }
    setJudge(j) { this.judge = j; }
    noteState(i) { const j = this.judge; return j && j.active && j.state ? j.state[i] : NOTE_HIT; }
    destroy() { this._layer = null; }

    setChart(chart) {
      this.chart = chart && chart.lanes ? chart : null;
      this._layout();
      this._layerKey = null;
    }

    resize(w, h, dpr) {
      dpr = Math.min(dpr || 1, this.opts.maxDpr);
      this.W = Math.max(1, w); this.H = Math.max(1, h); this.dpr = dpr;
      this.canvas.width = Math.round(this.W * dpr); this.canvas.height = Math.round(this.H * dpr);
      this.canvas.style.width = this.W + "px"; this.canvas.style.height = this.H + "px";
      const g = this.ctx.createLinearGradient(0, 0, 0, this.H);
      g.addColorStop(0, "#05060a"); g.addColorStop(0.35, "#0b0e17"); g.addColorStop(1, "#141826");
      this._bg = g;
      this._layerKey = null;
    }

    // ---- layout: lanes per pitch ------------------------------------------------------------
    _layout() {
      const c = this.chart;
      this.lanes = null;
      if (!c) return;
      if (c.instrument === "harmonica") {
        this.kind = "harmonica";
        this.width = 10;
        this.lanes = [];
        for (let h = 1; h <= 10; h++) this.lanes.push({ x0: h - 0.86, x1: h - 0.14, c: h - 0.5 });
        return;
      }
      this.kind = "piano";
      const lo = c.meta.range_lo || 48, hi = c.meta.range_hi || 84;
      this.lo = lo; this.hi = hi;
      const L = new Array(128).fill(null);
      let w = 0;
      for (let m = lo; m <= hi; m++) {
        if (!IS_BLACK[m % 12]) { L[m] = { x0: w + 0.06, x1: w + 0.94, c: w + 0.5, black: false, kx0: w, kx1: w + 1 }; w++; }
      }
      for (let m = lo; m <= hi; m++) {
        if (!IS_BLACK[m % 12] || !L[m - 1]) continue;
        const c0 = L[m - 1].kx1 + BLACK_SHIFT[m % 12];
        L[m] = { x0: c0 - 0.27, x1: c0 + 0.27, c: c0, black: true, kx0: c0 - 0.3, kx1: c0 + 0.3 };
      }
      this.keys = L; this.width = w;
    }
    /** Lane (x0, x1, centre) of note i. */
    lane(i) {
      const N = this.chart.notes;
      if (this.kind === "harmonica") return this.lanes[Math.max(1, Math.min(10, N.hole[i])) - 1];
      return this.keys[N.midi[i]] || this.keys[this.lo];
    }

    // ---- camera (static: the whole instrument is always in view) ---------------------------------
    /**
     * Static camera: the instrument's *front* edge (nearest the player, widest on
     * screen) spans ~94 % of the width; the strike line sits at NOW_LINE_Y and
     * the instrument reaches down to just above the transport bar.
     */
    _camera() {
      const span = this.width + 0.8;
      let vis = span;
      for (let pass = 0; pass < 4; pass++) {
        this._cameraFor(vis);
        const p = this._p, q = this._q;
        if (!this.project(0, 0, 0, p) || !this.project(0, 0, -this.instLen, q)) break;
        vis = span * q.s / p.s;                       // widen until the front edge fits
      }
      this.depth = DEPTH_PER_LANE * Math.max(10, vis);
    }
    _cameraFor(vis) {
      this.sinP = Math.sin(PITCH); this.cosP = Math.cos(PITCH);
      this.F = this.H * 1.4;
      const depthNow = (this.F * (vis / 2)) / (this.W * 0.47);
      const k = depthNow / (CAM_UP * this.sinP + CAM_BACK * this.cosP);
      this.camX = this.width / 2; this.camY = CAM_UP * k; this.camZ = -CAM_BACK * k;
      const cyNow = (-this.camY) * this.cosP + (-this.camZ) * this.sinP;
      this.cx0 = this.W / 2;
      this.cy0 = this.H * NOW_LINE_Y + (this.F * cyNow) / depthNow;
      // instrument length: its front edge ~62 px above the bottom (clear of the transport bar)
      const target = this.H - 62, p = this._p;
      let a = -0.05, b = this.camZ * 0.6;
      for (let it = 0; it < 30; it++) {
        const m = (a + b) / 2;
        if (this.project(0, 0, m, p) && p.y < target) a = m; else b = m;
      }
      this.instLen = Math.max(0.6, Math.min(this.kind === "piano" ? 5.5 : 3.2, -a));
    }
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
    /** Quad through 4 world points (x, y, z triples); leaves the path open for fill/stroke. */
    _quad4(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3) {
      const p = this._p, q = this._q, r = this._r, u = this._u, ctx = this.ctx;
      if (!this.project(x0, y0, z0, p) || !this.project(x1, y1, z1, q) || !this.project(x2, y2, z2, r) || !this.project(x3, y3, z3, u)) return false;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.lineTo(r.x, r.y); ctx.lineTo(u.x, u.y); ctx.closePath();
      return true;
    }
    _floor(x0, x1, y, z0, z1) { return this._quad4(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1); }
    _setFont(px, weight) {
      const f = `${weight || 700} ${Math.max(6, Math.round(px))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      if (f !== this._font) { this.ctx.font = f; this._font = f; }
    }
    _alphaForZ(z) {
      if (z < 0) return Math.max(0, 1 + z / 0.5);
      const f = z / this.depth;
      return f < 0.7 ? 1 : Math.max(0, 1 - (f - 0.7) / 0.3);
    }

    // ---- frame -------------------------------------------------------------------------------------
    draw(t, dt) {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._font = "";
      if (!this.chart || !this.width) { ctx.fillStyle = this._bg; ctx.fillRect(0, 0, this.W, this.H); return; }
      ctx.drawImage(this._staticLayer(), 0, 0, this.W, this.H);
      const zps = this.depth / this.opts.lookahead;
      this._drawBeats(t, zps);
      this.stats.notesDrawn = 0;
      this._drawBlocks(t, zps);
      this._drawInstrument(t);
      this._drawEffects(t);
    }

    /** Background, lanes, haze and the idle instrument: static per size/chart, cached. */
    _staticLayer() {
      const key = `${this.canvas.width}x${this.canvas.height}|${this.chart.songKey}|${this.kind}|${this.width}|${this.lo}|${this.opts.showFretNumbers}`;
      if (this._layer && key === this._layerKey) return this._layer;
      this._camera();
      if (!this._layer) this._layer = document.createElement("canvas");
      const layer = this._layer;
      layer.width = this.canvas.width; layer.height = this.canvas.height;
      const main = this.ctx;
      this.ctx = layer.getContext("2d", { alpha: false });
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._font = "";
      this.ctx.fillStyle = this._bg; this.ctx.fillRect(0, 0, this.W, this.H);
      this._drawLanes();
      this._drawFog();
      if (this.kind === "piano") this._drawKeyboard(null); else this._drawHarmonica(null);
      this.ctx = main; this._font = "";
      this._layerKey = key;
      return layer;
    }

    _drawLanes() {
      const ctx = this.ctx, D = this.depth;
      if (this.kind === "harmonica") {
        for (let h = 0; h < 10; h++) {
          if (this._floor(h, h + 1, 0, 0, D)) { ctx.fillStyle = h % 2 ? "#161b29" : "#1a2031"; ctx.fill(); }
        }
        ctx.beginPath();
        for (let h = 0; h <= 10; h++) this._line(h, 0, 0, h, 0, D);
        ctx.strokeStyle = "rgba(150,165,200,0.30)"; ctx.lineWidth = 1; ctx.stroke();
        return;
      }
      for (let m = this.lo; m <= this.hi; m++) {               // white lanes, then black lanes on top
        const k = this.keys[m];
        if (!k || k.black) continue;
        if (this._floor(k.kx0, k.kx1, 0, 0, D)) { ctx.fillStyle = m % 12 === 0 ? "#1b2236" : "#171c2b"; ctx.fill(); }
      }
      for (let m = this.lo; m <= this.hi; m++) {
        const k = this.keys[m];
        if (!k || !k.black) continue;
        if (this._floor(k.kx0, k.kx1, 0.001, 0, D)) { ctx.fillStyle = "#10131d"; ctx.fill(); }
      }
      ctx.beginPath();
      for (let m = this.lo; m <= this.hi; m++) {
        const k = this.keys[m];
        if (k && !k.black) this._line(k.kx0, 0.002, 0, k.kx0, 0.002, D);
      }
      ctx.strokeStyle = "rgba(150,165,200,0.16)"; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath();                                        // octave (C) lines brighter
      for (let m = this.lo; m <= this.hi; m += 1) if (m % 12 === 0 && this.keys[m]) this._line(this.keys[m].kx0, 0.003, 0, this.keys[m].kx0, 0.003, D);
      ctx.strokeStyle = "rgba(190,205,240,0.32)"; ctx.lineWidth = 1.5; ctx.stroke();
    }
    _line(x0, y0, z0, x1, y1, z1) {
      const p = this._p, q = this._q;
      if (!this.project(x0, y0, z0, p) || !this.project(x1, y1, z1, q)) return;
      this.ctx.moveTo(p.x, p.y); this.ctx.lineTo(q.x, q.y);
    }
    _drawFog() {
      const ctx = this.ctx, p = this._p;
      if (!this.project(this.camX, 0, this.depth, p)) return;
      const yH = Math.round(p.y);
      const g = ctx.createLinearGradient(0, yH - 2, 0, yH + this.H * 0.26);
      g.addColorStop(0, "rgba(8,10,16,1)"); g.addColorStop(1, "rgba(8,10,16,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, this.W, yH + this.H * 0.26);
    }

    _drawBeats(t, zps) {
      const b = this.chart.beats, ctx = this.ctx;
      if (!b.n) return;
      const tEnd = t + this.opts.lookahead;
      for (let i = lowerBound(b.t, t); i < b.n && b.t[i] <= tEnd; i++) {
        const z = (b.t[i] - t) * zps, measure = b.m[i] >= 0;
        ctx.globalAlpha = this._alphaForZ(z);
        ctx.beginPath(); this._line(0, 0.004, z, this.width, 0.004, z);
        ctx.strokeStyle = measure ? "rgba(215,225,255,0.40)" : "rgba(170,185,225,0.15)";
        ctx.lineWidth = measure ? 2 : 1; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /** Colour set of note i (hand / breath; grey when missed). */
    _colors(i) {
      if (this.noteState(i) === NOTE_MISSED) return GREYV;
      const N = this.chart.notes;
      if (this.kind === "piano") return HANDV[N.hand[i] ? 1 : 0];
      return N.ob[i] ? BREATHV.over : N.blow[i] ? BREATHV.blow : BREATHV.draw;
    }
    _label(i) {
      const N = this.chart.notes;
      if (this.kind === "harmonica") return harpTab(N.hole[i], N.blow[i], N.bend[i], N.ob[i]);
      const m = N.midi[i];
      return NOTE_NAMES[m % 12];
    }

    /** Note blocks: length = duration; they are consumed at the strike line. */
    _drawBlocks(t, zps) {
      const N = this.chart.notes, ctx = this.ctx, p = this._p, q = this._q, tEnd = t + this.opts.lookahead;
      if (!N.n) return;
      const i0 = lowerBound(N.t, t - Math.max(N.maxSus, MIN_BLOCK) - 0.05);
      let i1 = lowerBound(N.t, tEnd);
      const labels = [];
      const chordSeen = new Set();
      // far -> near so nearer blocks overlap farther ones; black-key lanes after white ones per pass
      for (let pass = 0; pass < 2; pass++) {
        for (let i = i1 - 1; i >= i0; i--) {
          const L = this.lane(i);
          if ((pass === 1) !== !!L.black) continue;
          const dur = Math.max(N.sus[i], MIN_BLOCK);
          const tb = N.t[i] + dur;
          if (tb <= t) continue;
          const za = Math.max(0, (N.t[i] - t) * zps), zb = Math.min(this.depth, (tb - t) * zps);
          if (zb <= za) continue;
          const missed = this.noteState(i) === NOTE_MISSED;
          const C = this._colors(i);
          const alpha = this._alphaForZ(za) * (missed ? 0.5 : 1);
          if (alpha <= 0) continue;
          const h = L.black ? 0.16 : 0.12, x0 = L.x0, x1 = L.x1;
          ctx.globalAlpha = alpha;
          // front face (towards the player) then top
          if (this._quad4(x0, 0, za, x1, 0, za, x1, h, za, x0, h, za)) { ctx.fillStyle = C.side; ctx.fill(); }
          if (!this._floor(x0, x1, h, za, zb)) continue;
          ctx.fillStyle = C.base; ctx.fill();
          ctx.strokeStyle = C.light; ctx.lineWidth = 1; ctx.stroke();
          if (this.kind === "harmonica" && N.bend[i] > 0 && !N.ob[i]) {          // bends: diagonal stripes
            // screen bounding box of the top face (near corners are the widest, far edge the highest)
            this.project(x0, h, za, p); this.project(x1, h, za, q);
            const bx0 = p.x, bx1 = q.x, by1 = p.y;
            this.project(x0, h, zb, q);
            const by0 = q.y, span = by1 - by0;
            ctx.save(); ctx.clip();
            ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 2;
            ctx.beginPath();
            for (let d = bx0 - span; d < bx1; d += 9) { ctx.moveTo(d, by1); ctx.lineTo(d + span, by0); }
            ctx.stroke(); ctx.restore();
          }
          this.stats.notesDrawn++;
          // label at the near end
          if (this.opts.showFretNumbers !== false && this.project(L.c, h, za, p) && this.project(x1, h, za, q)) {
            const px = (q.x - p.x) * 2;
            if (px > 13) labels.push(this._label(i), p.x, p.y, Math.min(22, px * (this.kind === "harmonica" ? 0.5 : 0.62)), alpha);
          }
          const c = N.chord[i], ch = this.chart.chords;
          if (c >= 0 && ch.showName[c] && !chordSeen.has(c) && za > 0) {
            chordSeen.add(c);
            let lowest = i; while (lowest > 0 && N.t[lowest - 1] === N.t[i]) lowest--;
            const Lw = this.lane(lowest);
            if (this.project(Lw.x0 - 0.15, 0.3, za, p)) labels.push("\u0001" + ch.name[c], p.x, p.y, Math.min(24, p.s * 0.55), alpha);
          }
        }
      }
      ctx.globalAlpha = 1;
      ctx.textBaseline = "bottom"; ctx.lineJoin = "round";
      for (let k = 0; k < labels.length; k += 5) {
        let txt = labels[k];
        const chord = txt.charCodeAt(0) === 1;
        if (chord) txt = txt.slice(1);
        this._setFont(labels[k + 3], 800);
        ctx.textAlign = chord ? "right" : "center";
        ctx.globalAlpha = labels[k + 4];
        ctx.lineWidth = Math.max(2, labels[k + 3] * 0.2); ctx.strokeStyle = "rgba(6,8,14,0.85)";
        ctx.strokeText(txt, labels[k + 1], labels[k + 2] - 2);
        ctx.fillStyle = "#ffffff"; ctx.fillText(txt, labels[k + 1], labels[k + 2] - 2);
      }
      ctx.globalAlpha = 1;
    }

    /** Which lanes sound now: Map laneKey -> {color, k (flash 0..1)}. */
    _sounding(t) {
      const N = this.chart.notes, J = this.judge && this.judge.active ? this.judge : null, out = new Map();
      const i0 = lowerBound(N.t, t - Math.max(N.maxSus, MIN_BLOCK, HIT_FLASH) - 0.05), i1 = lowerBound(N.t, t + (J ? J.window : 0) + 1e-4);
      for (let i = i0; i < i1; i++) {
        const st = this.noteState(i);
        if (st !== NOTE_HIT) continue;
        const start = J ? J.markedAt[i] : N.t[i];
        const end = N.t[i] + Math.max(N.sus[i], 0.12);
        if (t < start || t > end) continue;
        const key = this.kind === "harmonica" ? N.hole[i] : N.midi[i];
        const flash = t - start < HIT_FLASH ? 1 - (t - start) / HIT_FLASH : 0;
        const prev = out.get(key);
        if (!prev || flash > prev.k) out.set(key, { i, C: this._colors(i), k: flash });
      }
      return out;
    }

    _drawInstrument(t) {
      const on = this._sounding(t);
      this.stats.pressed = on.size;
      if (this.kind === "piano") this._drawKeyboard(on); else this._drawHarmonica(on);
    }

    /** Keyboard. on == null: the idle keyboard (static layer); else only what changes: pressed keys + black keys. */
    _drawKeyboard(on) {
      const ctx = this.ctx, L = this.instLen || 4, BL = L * 0.62, BH = 0.32;
      if (on && !on.size) return;
      for (let m = this.lo; m <= this.hi; m++) {
        const k = this.keys[m];
        if (!k || k.black) continue;
        const hit = on && on.get(m);
        if (on && !hit) continue;
        const dip = hit ? 0.03 : 0;
        if (this._floor(k.kx0 + 0.03, k.kx1 - 0.03, -dip, -0.02, -L)) {
          if (hit) { ctx.fillStyle = hit.C.top; ctx.fill(); }
          else {
            const g = this._gradY(-0.02, -L, "#e9ebf1", "#ffffff");
            ctx.fillStyle = g || "#f1f3f7"; ctx.fill();
          }
          ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 1; ctx.stroke();
        }
        if (this._quad4(k.kx0 + 0.03, -dip, -L, k.kx1 - 0.03, -dip, -L, k.kx1 - 0.03, -0.22, -L, k.kx0 + 0.03, -0.22, -L)) {
          ctx.fillStyle = hit ? hit.C.side : "#b9bfcc"; ctx.fill();
        }
        if (!on && m % 12 === 0 && this.project(k.c, 0, -L + 0.45, this._p)) {        // C labels
          this._setFont(Math.min(14, this._p.s * 0.42), 700);
          ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#6b7280";
          ctx.fillText("C" + (m / 12 - 1), this._p.x, this._p.y);
        }
      }
      // black keys: always redrawn on top of pressed white keys
      for (let m = this.lo; m <= this.hi; m++) {
        const k = this.keys[m];
        if (!k || !k.black) continue;
        const hit = on && on.get(m);
        const h = hit ? BH - 0.06 : BH;
        if (this._quad4(k.kx0, 0, -BL, k.kx1, 0, -BL, k.kx1, h, -BL, k.kx0, h, -BL)) { ctx.fillStyle = hit ? hit.C.dark : "#05060a"; ctx.fill(); }
        if (this._floor(k.kx0, k.kx1, h, -0.02, -BL)) {
          ctx.fillStyle = hit ? hit.C.base : "#1c1f27"; ctx.fill();
          ctx.strokeStyle = hit ? hit.C.light : "rgba(255,255,255,0.10)"; ctx.lineWidth = 1; ctx.stroke();
        }
      }
      // strike line
      if (!on) {
        ctx.beginPath(); this._line(0, 0.01, 0, this.width, 0.01, 0);
        ctx.strokeStyle = "rgba(245,165,36,0.75)"; ctx.lineWidth = 2; ctx.stroke();
      }
    }

    _gradY(z0, z1, c0, c1) {
      const p = this._p, q = this._q;
      if (!this.project(this.camX, 0, z0, p) || !this.project(this.camX, 0, z1, q)) return null;
      const g = this.ctx.createLinearGradient(0, p.y, 0, q.y);
      g.addColorStop(0, c0); g.addColorStop(1, c1);
      return g;
    }

    /** 10-hole harmonica: chrome cover plate with the comb's holes at the strike line. */
    _drawHarmonica(on) {
      const ctx = this.ctx, L = this.instLen || 2.4;
      if (!on) {
        // body (cover plate) + front edge
        if (this._floor(-0.25, 10.25, 0, -0.02, -L)) {
          ctx.fillStyle = this._gradY(-0.02, -L, "#8b93a3", "#d7dce5") || "#b8bfcc"; ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.5; ctx.stroke();
        }
        if (this._quad4(-0.25, 0, -L, 10.25, 0, -L, 10.25, -0.35, -L, -0.25, -0.35, -L)) { ctx.fillStyle = "#5b6272"; ctx.fill(); }
        ctx.beginPath(); this._line(0, 0.01, 0, 10, 0.01, 0);
        ctx.strokeStyle = "rgba(245,165,36,0.75)"; ctx.lineWidth = 2; ctx.stroke();
      }
      const hz0 = -0.12, hz1 = -Math.min(0.95, L * 0.4);
      for (let h = 1; h <= 10; h++) {
        const hit = on && on.get(h);
        if (on && !hit) continue;
        if (this._floor(h - 0.78, h - 0.22, 0.001, hz0, hz1)) {
          ctx.fillStyle = hit ? hit.C.base : "#141821"; ctx.fill();
          ctx.strokeStyle = hit ? hit.C.light : "rgba(0,0,0,0.5)"; ctx.lineWidth = hit ? 2 : 1; ctx.stroke();
        }
        if (this.project(h - 0.5, 0, hz1 - Math.min(0.55, L * 0.22), this._p)) {
          this._setFont(Math.min(22, this._p.s * 0.5), 800);
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillStyle = hit ? hit.C.dark : "#2d3240";
          ctx.fillText(String(h), this._p.x, this._p.y);
        }
      }
    }

    /** Hit glow at the strike line, red X for misses. */
    _drawEffects(t) {
      const N = this.chart.notes, ctx = this.ctx, p = this._p, J = this.judge && this.judge.active ? this.judge : null;
      const i0 = lowerBound(N.t, t - Math.max(0.4, HIT_FLASH) - (J ? J.window + J.missDelay : 0)), i1 = lowerBound(N.t, t + (J ? J.window : 0) + 1e-4);
      ctx.globalCompositeOperation = "lighter";
      for (let i = i0; i < i1; i++) {
        const st = this.noteState(i), L = this.lane(i);
        const d = t - (J && st !== NOTE_PENDING ? J.markedAt[i] : N.t[i]);
        if (d < 0 || !this.project(L.c, 0.05, 0, p)) continue;
        if (st === NOTE_HIT && d < HIT_FLASH) {
          const k = 1 - d / HIT_FLASH, C = this._colors(i), r = p.s * (0.35 + 0.35 * k) * (L.x1 - L.x0);
          ctx.globalAlpha = 0.6 * k + 0.1; ctx.fillStyle = C.base;
          ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 0.8 * k; ctx.fillStyle = "#ffffff";
          ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.35, 0, Math.PI * 2); ctx.fill();
        } else if (st === NOTE_MISSED && d < 0.3) {
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1 - d / 0.3; ctx.strokeStyle = "#f87171"; ctx.lineWidth = Math.max(2, p.s * 0.05);
          const r = p.s * 0.22;
          ctx.beginPath(); ctx.moveTo(p.x - r, p.y - r); ctx.lineTo(p.x + r, p.y + r); ctx.moveTo(p.x + r, p.y - r); ctx.lineTo(p.x - r, p.y + r); ctx.stroke();
          ctx.globalCompositeOperation = "lighter";
        }
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    }
  }

  NS.prepareLaneChart = prepareLaneChart;
  NS.LaneHighwayRenderer = LaneHighwayRenderer;
})(window);
