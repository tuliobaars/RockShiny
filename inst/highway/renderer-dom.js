/* ---------------------------------------------------------------------------
 * renderer-dom.js -- the same highway drawn with HTML + SVG elements.
 *
 * Selectable alternative to the canvas renderer (settings: renderer = "dom").
 * It extends HighwayRenderer, so camera, projection, visibility windows and
 * options are shared; only the drawing backend differs.
 *
 * Why it can be faster: the browser caches unchanged layers (the board is an
 * SVG re-generated only when the camera moves) and moves notes by compositing
 * `transform`s, with rasterisation off the main thread. The canvas renderer
 * re-rasterises its pixels every frame. See docs: "Renderer benchmark".
 *
 * Fast-DOM rules used throughout: pooled elements, per frame only
 * `transform` / `opacity` / SVG geometry attributes change, text and classes
 * are written only when they change, no layout-triggering properties.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = root.RSHighway;
  const SVGNS = "http://www.w3.org/2000/svg";
  const COLORS = NS.COLOR_VARIANTS, TECH = NS.TECH, lowerBound = NS._lowerBound, GREY = NS.GREY_VARIANT;
  const { DEPTH, STRING_BASE, STRING_GAP, N_FRETS, HIT_FLASH, PASSED_FADE } = NS.GEOMETRY;
  const GEM_W = 100, GEM_H = 32;        // unscaled gem box (px); scaled per note

  function mk(tag, cls, parent, svg) {
    const e = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
    if (cls) e.setAttribute("class", cls);
    if (parent) parent.appendChild(e);
    return e;
  }
  const r2 = (v) => Math.round(v * 100) / 100;

  /** Grow-only pool; elements not used in a frame are hidden. */
  class Pool {
    constructor(make) { this.make = make; this.items = []; this.used = 0; }
    begin() { this.used = 0; }
    next() {
      if (this.used === this.items.length) { const e = this.make(); e._c = {}; this.items.push(e); }
      const e = this.items[this.used++];
      if (e._hidden) { e.style.display = ""; e._hidden = false; }
      return e;
    }
    end() {
      for (let i = this.used; i < this.items.length; i++) {
        const e = this.items[i];
        if (!e._hidden) { e.style.display = "none"; e._hidden = true; }
      }
    }
  }
  // write-if-changed helpers (cache on the element)
  const cache = (e) => e._c || (e._c = {});
  function setAttr(e, k, v) { const c = cache(e); if (c[k] !== v) { e.setAttribute(k, v); c[k] = v; } }
  function setStyle(e, k, v) {
    const c = cache(e);
    if (c["s:" + k] === v) return;
    if (k.startsWith("--")) e.style.setProperty(k, v); else e.style[k] = v;   // custom properties need setProperty
    c["s:" + k] = v;
  }
  function setText(e, v) { const c = cache(e); if (c.text !== v) { e.textContent = v; c.text = v; } }

  class DomHighwayRenderer extends NS.HighwayRenderer {
    constructor(container, before) {
      super(document.createElement("canvas"));          // detached: base state only
      this.root = mk("div", "rs-hwd");
      container.insertBefore(this.root, before || null);
      this.staticSvg = mk("svg", "rs-hwd-layer", this.root, true);   // board + haze (camera-static)
      this.floorSvg = mk("svg", "rs-hwd-layer", this.root, true);    // anchor zones, beat lines
      this.neckSvg = mk("svg", "rs-hwd-layer", this.root, true);     // ghost neck (camera-static)
      this.dynSvg = mk("svg", "rs-hwd-layer", this.root, true);      // frames, sustains, strings
      const layer = () => mk("div", "rs-hwd-layer", this.root);
      const stemL = layer(), barL = layer(), gemL = layer(), hitL = layer(), labelL = layer();

      const svgEl = (tag, cls) => () => mk(tag, cls, this.dynSvg, true);
      const floorEl = (tag, cls) => () => mk(tag, cls, this.floorSvg, true);
      this.pools = {
        zone: new Pool(floorEl("polygon", "rs-hwd-zone")),
        zoneEdge: new Pool(floorEl("line", "rs-hwd-zone-edge")),
        beat: new Pool(floorEl("line")),
        frame: new Pool(svgEl("rect", "rs-hwd-frame")),
        sustain: new Pool(svgEl("polygon")),
        string: new Pool(svgEl("polyline", "rs-hwd-string")),
        stem: new Pool(() => mk("div", "rs-hwd-stem", stemL)),
        bar: new Pool(() => mk("div", "rs-hwd-bar", barL)),
        gem: new Pool(() => { const g = mk("div", "rs-hwd-gem", gemL); g._label = mk("span", "rs-hwd-tech", g); g._num = mk("span", "rs-hwd-num", g); return g; }),
        hit: new Pool(() => mk("div", "rs-hwd-hit", hitL)),
        ring: new Pool(() => mk("div", "rs-hwd-ring", hitL)),
        spark: new Pool(() => mk("div", "rs-hwd-spark", hitL)),
        miss: new Pool(() => mk("div", "rs-hwd-miss", hitL)),
        chordName: new Pool(() => mk("div", "rs-hwd-chord", labelL)),
      };
      this._staticKey = "";
    }

    destroy() { this.root.remove(); }

    resize(w, h) {
      this.W = Math.max(1, w); this.H = Math.max(1, h); this.dpr = 1;
      for (const s of [this.staticSvg, this.floorSvg, this.neckSvg, this.dynSvg]) {
        s.setAttribute("width", this.W); s.setAttribute("height", this.H);
        s.setAttribute("viewBox", `0 0 ${this.W} ${this.H}`);
      }
      this._staticKey = "";
      this._neckKey = "";
    }

    draw(t, dt) {
      const P = this.pools;
      for (const k in P) P[k].begin();
      if (this.chart) {
        this._updateCamera(t, dt);
        const zps = DEPTH / this.opts.lookahead;
        this._board(t);
        this._neckSvgLayer();
        this._zones(t, zps);
        this._beats(t, zps);
        this._frames(t, zps);
        this.stats.notesDrawn = 0;
        this._notes(t, zps);
        this._strings(t);
      }
      for (const k in P) P[k].end();
      this.root.style.visibility = this.chart ? "" : "hidden";
    }

    // ---- static board: only rebuilt when camera / active zone changes -------------
    _board(t) {
      const ai = this.anchorAt(t), a = this.chart.anchors;
      const key = `${this.W}x${this.H}|${this.camX}|${this.camZ}|${ai}|${this.chart.nStrings}`;
      if (key === this._staticKey) return;
      this._staticKey = key;
      const p = this._p, q = this._q, r = this._r, u = this._u;
      const z0 = ai >= 0 ? a.fret[ai] : 0, z1 = ai >= 0 ? a.fret[ai] + a.width[ai] - 1 : -1;
      let svg = `<defs><linearGradient id="rs-hwd-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05060a"/>` +
        `<stop offset=".35" stop-color="#0b0e17"/><stop offset="1" stop-color="#141826"/></linearGradient>` +
        `</defs>` +
        `<rect width="${this.W}" height="${this.H}" fill="url(#rs-hwd-bg)"/>`;
      const quad = (x0, x1, z0q, z1q) =>
        this.project(x0, 0, z0q, p) && this.project(x1, 0, z0q, q) && this.project(x1, 0, z1q, r) && this.project(x0, 0, z1q, u)
          ? `${r2(p.x)},${r2(p.y)} ${r2(q.x)},${r2(q.y)} ${r2(r.x)},${r2(r.y)} ${r2(u.x)},${r2(u.y)}` : null;
      for (let f = 1; f <= N_FRETS; f++) {
        const pts = quad(f - 1, f, -0.8, DEPTH);
        if (pts) svg += `<polygon points="${pts}" fill="${f % 2 ? "#161b29" : "#1a2031"}" stroke="rgba(150,165,200,0.35)" stroke-width="1"/>`;
      }
      for (const f of [3, 5, 7, 9, 12, 15, 17, 19, 21, 24]) {
        const pts = quad(f - 0.62, f - 0.38, -0.7, -0.35);
        if (pts) svg += `<polygon points="${pts}" fill="rgba(200,210,235,0.16)"/>`;
      }
      if (this.project(this.camX, 0, DEPTH, p)) {      // haze: opaque above the far end, fading below (as canvas)
        const y0 = r2(p.y - 2), y1 = r2(p.y + this.H * 0.28);
        svg += `<linearGradient id="rs-hwd-fog" gradientUnits="userSpaceOnUse" x1="0" y1="${y0}" x2="0" y2="${y1}">` +
          `<stop offset="0" stop-color="#080a10" stop-opacity="1"/><stop offset="1" stop-color="#080a10" stop-opacity="0"/></linearGradient>` +
          `<rect y="0" width="${this.W}" height="${Math.max(0, y1)}" fill="url(#rs-hwd-fog)"/>`;
      }
      for (let f = 1; f <= N_FRETS; f++) {
        if (!this.project(this.laneX(f), 0, -0.95, p) || p.x < -20 || p.x > this.W + 20) continue;
        const inZone = f >= z0 && f <= z1, fs = Math.min(26, p.s * (inZone ? 0.34 : 0.26));
        svg += `<text x="${r2(p.x)}" y="${r2(p.y + fs * 0.85)}" font-size="${r2(Math.max(6, fs))}" font-weight="${inZone ? 800 : 600}" ` +
          `text-anchor="middle" fill="${inZone ? "#ffffff" : "rgba(190,200,225,0.55)"}">${f}</text>`;
      }
      this.staticSvg.innerHTML = svg;
    }

    _neckSvgLayer() {
      const key = `${this.W}x${this.H}|${this.camX}|${this.camZ}|${this.opts.invertStrings}|${this.chart.nStrings}|${(this.chart.meta.tuning || []).join()}`;
      if (key === this._neckKey) return;
      this._neckKey = key;
      this.neckSvg.innerHTML = NS.shapesToSvg(this._neckShapes());
    }

    _zones(t, zps) {
      const a = this.chart.anchors, p = this._p, q = this._q, r = this._r, u = this._u;
      if (!a.n) return;
      const tEnd = t + this.opts.lookahead * 0.9;
      for (let i = Math.max(0, this.anchorAt(t)); i < a.n && a.t[i] <= tEnd; i++) {
        const t0 = Math.max(a.t[i], t - 0.1), t1 = Math.min(i + 1 < a.n ? a.t[i + 1] : Infinity, tEnd);
        if (t1 <= t0) continue;
        const x0 = a.fret[i] - 1, x1 = x0 + a.width[i], za = (t0 - t) * zps, zb = (t1 - t) * zps;
        if (!this.project(x0, 0, za, p) || !this.project(x1, 0, za, q) || !this.project(x1, 0, zb, r) || !this.project(x0, 0, zb, u)) continue;
        setAttr(this.pools.zone.next(), "points", `${r2(p.x)},${r2(p.y)} ${r2(q.x)},${r2(q.y)} ${r2(r.x)},${r2(r.y)} ${r2(u.x)},${r2(u.y)}`);
        for (const [s, e] of [[p, u], [q, r]]) {
          const l = this.pools.zoneEdge.next();
          setAttr(l, "x1", r2(s.x)); setAttr(l, "y1", r2(s.y)); setAttr(l, "x2", r2(e.x)); setAttr(l, "y2", r2(e.y));
        }
      }
    }

    _beats(t, zps) {
      const b = this.chart.beats, p = this._p, q = this._q;
      for (let i = lowerBound(b.t, t - 0.05); i < b.n && b.t[i] <= t + this.opts.lookahead; i++) {
        const z = (b.t[i] - t) * zps;
        if (!this.project(0, 0, z, p) || !this.project(N_FRETS, 0, z, q)) continue;
        const l = this.pools.beat.next(), m = b.m[i] >= 0;
        setAttr(l, "x1", r2(p.x)); setAttr(l, "y1", r2(p.y)); setAttr(l, "x2", r2(q.x)); setAttr(l, "y2", r2(q.y));
        setAttr(l, "class", m ? "rs-hwd-measure" : "rs-hwd-beat");
        setAttr(l, "opacity", r2(this._alphaForZ(z)));
      }
    }

    _frames(t, zps) {
      const c = this.chart.chords, p = this._p, q = this._q;
      if (!c.n) return;
      const yTop = STRING_BASE + (this.chart.nStrings - 1) * STRING_GAP + 0.2;
      let i1 = lowerBound(c.t, t - 0.1); const i0 = i1;
      const iNext = lowerBound(c.t, t);                  // nearest upcoming chord always gets its name
      while (i1 < c.n && c.t[i1] <= t + this.opts.lookahead) i1++;
      for (let i = i1 - 1; i >= i0; i--) {
        const z = (c.t[i] - t) * zps, alpha = this._alphaForZ(z);
        if (alpha <= 0) continue;
        let x0, x1;
        if (c.maxF[i] > 0) { x0 = Math.min(c.minF[i], c.maxF[i]) - 1; x1 = c.maxF[i]; }
        else { const ai = this.anchorAt(c.t[i]); x0 = ai >= 0 ? this.chart.anchors.fret[ai] - 1 : 0; x1 = x0 + (ai >= 0 ? this.chart.anchors.width[ai] : 4); }
        if (!this.project(x0 - 0.08, 0, z, p) || !this.project(x1 + 0.08, yTop, z, q)) continue;
        const rect = this.pools.frame.next();
        setAttr(rect, "x", r2(p.x)); setAttr(rect, "y", r2(q.y));
        setAttr(rect, "width", r2(q.x - p.x)); setAttr(rect, "height", r2(p.y - q.y));
        setAttr(rect, "stroke-width", r2(Math.max(1, q.s * (c.hd[i] ? 0.05 : 0.03))));
        setAttr(rect, "class", c.hd[i] ? "rs-hwd-frame is-repeat" : "rs-hwd-frame");
        setAttr(rect, "opacity", r2(alpha));
        const name = c.name[i];
        if (name && (c.showName[i] || i === iNext) && !c.hd[i] && q.s > 14) {
          const lb = this.pools.chordName.next();
          setText(lb, name);
          lb.style.transform = `translate(${r2(p.x)}px,${r2(q.y)}px) scale(${r2(Math.min(28, q.s * 0.32) / 20)})`;
          lb.style.opacity = alpha;
        }
      }
    }

    _notes(t, zps) {
      const N = this.chart.notes, ch = this.chart.chords, P = this.pools;
      const p = this._p, q = this._q;
      if (!N.n) return;
      const i0 = lowerBound(N.t, t - Math.max(PASSED_FADE / zps, N.maxSus, HIT_FLASH) - 0.05);
      let i1 = lowerBound(N.t, t);
      while (i1 < N.n && N.t[i1] <= t + this.opts.lookahead) i1++;
      const anchors = this.chart.anchors;
      const zoneOf = (tn) => { const ai = this.anchorAt(tn); const x0 = ai >= 0 ? anchors.fret[ai] - 1 : 0; return [x0, x0 + (ai >= 0 ? anchors.width[ai] : 4)]; };

      for (let i = i1 - 1; i >= i0; i--) {
        const s = N.s[i], fret = N.f[i], tech = N.tech[i];
        const missed = this.noteState(i) === NS.NOTE_STATE.MISSED;
        const C = missed ? GREY : COLORS[s];
        const z = (N.t[i] - t) * zps;

        // sustain ribbon(s): slides, bends, vibrato, tremolo (shared geometry)
        if (N.sus[i] > 0 && N.t[i] + N.sus[i] > t) {
          this.forEachRibbon(i, t, zps, (pts, n, alpha) => {
            let str = "";
            for (let k = 0; k < 2 * n; k += 2) str += r2(pts[k]) + "," + r2(pts[k + 1]) + " ";
            const poly = P.sustain.next();
            setAttr(poly, "points", str);
            setAttr(poly, "fill", C.base);
            setAttr(poly, "opacity", r2(missed ? alpha * 0.4 : alpha));
          });
        }

        const c = N.chord[i];
        if (c >= 0 && ch.hd[c]) continue;                       // repeated chord: frame only
        const alpha = this._alphaForZ(z) * (missed ? 0.55 : 1);
        if (alpha <= 0) continue;
        this.stats.notesDrawn++;
        const y = this.stringY(s) + (N.bendStart[i] >= 0 ? this.bendAt(i, Math.min(t, N.t[i])) * STRING_GAP * 0.5 : 0);

        if (fret === 0) {                                         // open string: bar across the zone
          const [a0, a1] = zoneOf(N.t[i]);
          if (!this.project(a0 + 0.05, y, z, p) || !this.project(a1 - 0.05, y, z, q)) continue;
          const b = P.bar.next();
          setStyle(b, "background", C.base); setStyle(b, "borderColor", C.light);
          b.style.transform = `translate(${r2(p.x)}px,${r2(p.y - 5)}px) scale(${r2((q.x - p.x) / 100)},${r2(Math.max(3, p.s * 0.12) / 10)})`;
          b.style.opacity = r2(alpha);
          continue;
        }

        const x = this.laneX(fret);
        if (!this.project(x, 0, z, q) || !this.project(x, y, z, p)) continue;
        const stem = P.stem.next();
        setStyle(stem, "background", C.stem);
        stem.style.transform = `translate(${r2(p.x - 1)}px,${r2(p.y)}px) scale(${r2(Math.max(1, p.s * 0.025) / 2)},${r2((q.y - p.y) / 100)})`;
        stem.style.opacity = r2(alpha);

        const g = P.gem.next();
        const muted = (tech & TECH.FRET_HAND_MUTE) !== 0;
        const hollow = (tech & (TECH.HAMMER_ON | TECH.PULL_OFF | TECH.TAP)) !== 0;
        const cls = "rs-hwd-gem" + (tech & TECH.ACCENT ? " is-accent" : "") + (muted ? " is-muted" : "") +
          (hollow ? " is-hollow" : "") + (tech & TECH.PALM_MUTE ? " is-pm" : "") +
          (tech & (TECH.HARMONIC | TECH.PINCH_HARMONIC) ? " is-harmonic" : "");
        setAttr(g, "class", cls);
        setStyle(g, "--gem", muted ? C.dark : C.base);
        setStyle(g, "borderColor", tech & TECH.ACCENT ? "#ffffff" : hollow ? C.light : C.dark);
        setText(g._num, muted ? "X" : (this.opts.showFretNumbers ? String(fret) : ""));
        setText(g._label, this._techLabel(tech, N.bend[i]));
        g.style.transform = `translate(${r2(p.x - GEM_W / 2)}px,${r2(p.y - GEM_H / 2)}px) scale(${r2(p.s * 0.74 * this.gemScale(i, t) / GEM_W)})`;
        g.style.opacity = r2(alpha);
      }

      // hit effects at the strike line (shared descriptors)
      this.forEachEffect(t, (kind, x, y, sc, k, str) => {
        const C = COLORS[str];
        if (kind === "glow" || kind === "puff") {
          const puff = kind === "puff", h = P.hit.next();
          setStyle(h, "background", puff ? "radial-gradient(circle, #d1d5db 0 15%, rgba(156,163,175,.7) 35%, transparent 70%)"
                                         : `radial-gradient(circle, #fff 0 18%, ${C.base} 36%, transparent 70%)`);
          h.style.transform = `translate(${r2(x - 50)}px,${r2(y - 50)}px) scale(${r2(sc * (puff ? 0.12 + 0.1 * k : 0.16 + 0.2 * k) / 35)})`;
          h.style.opacity = r2((puff ? 0.35 : 0.55) * k + 0.3);
        } else if (kind === "ring") {
          const rg = P.ring.next();
          setStyle(rg, "borderColor", C.light);
          rg.style.transform = `translate(${r2(x - 50)}px,${r2(y - 50)}px) scale(${r2(sc * (0.25 + 0.75 * k) / 50)})`;
          rg.style.opacity = r2(0.9 * (1 - k));
        } else if (kind === "spark") {
          const sp = P.spark.next();
          sp.style.transform = `translate(${r2(x - 50)}px,${r2(y - 50)}px) scale(${r2(sc * (0.2 + 0.35 * k) / 50)})`;
          sp.style.opacity = r2(1 - k);
        } else if (kind === "miss") {
          const m = P.miss.next();
          m.style.transform = `translate(${r2(x - 50)}px,${r2(y - 50)}px) scale(${r2(sc * 0.14 / 50)})`;
          m.style.opacity = r2(k);
        }
      });
    }

    _strings(t) {
      const p = this._p, n = this.chart.nStrings, act = this._active;
      this._stringState(t);
      for (let s = 0; s < n; s++) {
        const pts = this.stringPolyline(s);
        if (pts.length < 4 || !this.project(0, this.stringY(s), 0, p)) continue;
        let str = "";
        for (let k = 0; k < pts.length; k += 2) str += r2(pts[k]) + "," + r2(pts[k + 1]) + " ";
        const l = this.pools.string.next();
        setAttr(l, "points", str);
        setAttr(l, "stroke", COLORS[s].glow[Math.round(act[s] * 5)]);
        setAttr(l, "stroke-width", r2(Math.max(1.2, p.s * (0.018 + (n - 1 - s) * 0.003)) * (1 + act[s] * 1.2)));
      }
    }
  }

  NS.DomHighwayRenderer = DomHighwayRenderer;
})(window);
