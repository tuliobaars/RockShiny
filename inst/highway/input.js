/* ---------------------------------------------------------------------------
 * input.js -- player input & hit judgement (the seam for microphone input).
 *
 *   input source ──► InputBus ──► HitJudge ──► per-note state ──► renderers
 *   (keyboard,        events      matches to    Uint8Array:        (read only)
 *    microphone)                  due notes     pending/hit/missed
 *
 * Sources never touch the renderer, clock or DOM; they only push events:
 *
 *   bus.noteHit = true                     // boolean trigger: "the due note was played now"
 *   bus.hit({ at, midi, string, fret })    // richer form: pitch from a detector, timestamp
 *                                          // (performance.now()) of the detected onset
 *   bus.hit({ chartTime, notes: [i, ...] }) // detector that already knows the chart time
 *                                          // and exactly which notes it verified (mic.js)
 *   bus.noteMiss = true                    // explicit wrong note (breaks the streak)
 *
 * Sources are registered by name (mic.js registers "microphone"):
 *
 *   RSHighway.registerInputSource("name", (ctx) => ({ async start() {...}, stop() {...} }));
 *   // ctx = { bus, judge, chart, expectedAt(t, w), chartTime(perfMs), options,
 *   //         onLevel, onDevices, onOnsetRaw, onError }   (see binding.js)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});
  const PENDING = 0, HIT = 1, MISSED = 2;
  const KIND_PITCHED = 0, KIND_UNPITCHED = 1;         // unpitched: fret-hand mutes, pinch harmonics
  // natural harmonic at fret f sounds this many semitones above the open string
  const HARMONIC_SEMITONES = { 12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31 };
  const OPEN_MIDI = { 6: [40, 45, 50, 55, 59, 64], 4: [28, 33, 38, 43] };
  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

  // ---- event bus -----------------------------------------------------------------
  class InputBus {
    constructor() { this._subs = {}; }
    on(type, fn) { (this._subs[type] = this._subs[type] || []).push(fn); return () => this.off(type, fn); }
    off(type, fn) { const l = this._subs[type]; if (l) this._subs[type] = l.filter((f) => f !== fn); }
    emit(type, ev) { for (const fn of (this._subs[type] || []).slice()) fn(ev); }
    /** Boolean trigger (as an external module would set it): a hit right now. */
    set noteHit(v) { if (v) this.emit("hit", { at: performance.now() }); }
    get noteHit() { return false; }
    /** Boolean trigger: a wrong / extra note right now. */
    set noteMiss(v) { if (v) this.emit("miss", { at: performance.now() }); }
    get noteMiss() { return false; }
    /** Rich hit: { at?: performance.now() ms, midi?, string?, fret?, confidence? } */
    hit(ev) { this.emit("hit", Object.assign({ at: performance.now() }, ev || {})); }
  }

  // ---- judge ---------------------------------------------------------------------
  class HitJudge {
    constructor() {
      this.window = 0.12;        // s: a hit counts if within +/- window of the note
      this.perfectWindow = 0.04; // s
      this.missDelay = 0;        // s: extra grace before "missed" (audio detectors need ~0.1-0.2 s)
      this.active = false;       // only judges while an input source is running
      this.chart = null;
      this.state = null;         // Uint8Array per note: PENDING / HIT / MISSED
      this.markedAt = null;      // Float64Array: chart time the note was judged (effects timing)
      this.onJudged = null;      // callback(result) for telemetry / UI
      this._missPtr = 0; this.nEvents = 0;
      this._resetStats();
    }
    _resetStats() {
      this.hits = 0; this.misses = 0; this.perfect = 0; this.streak = 0; this.bestStreak = 0; this.extra = 0;
      this.score = 0; this.deltas = [];
      const ns = this.chart ? this.chart.sections.n : 0;
      this.secHits = new Int32Array(ns); this.secTotal = new Int32Array(ns);
    }
    /** Score multiplier from the streak (x1 .. x4, +1 every 10 events). */
    get multiplier() { return Math.min(4, 1 + Math.floor(this.streak / 10)); }

    setChart(chart) {
      this.chart = chart;
      const n = chart ? chart.notes.n : 0;
      this.state = new Uint8Array(n);
      this.markedAt = new Float64Array(n);
      this.midi = new Int16Array(n);
      this.freq = new Float32Array(n);      // expected sounding frequency at the onset (Hz)
      this.kind = new Uint8Array(n);
      this.legato = new Uint8Array(n);      // hammer-on / pull-off / tap: no pick attack
      this.section = new Int16Array(n).fill(-1);
      this._missPtr = 0;
      this.nEvents = 0;                     // distinct onsets (a chord counts once): run coverage
      if (chart && chart.lanes) {                       // piano / harmonica: the chart gives the pitch
        const N = chart.notes, sec = chart.sections, legato = chart.instrument === "harmonica" ? 1 : 0;
        let si = -1;
        for (let i = 0; i < n; i++) {
          this.midi[i] = N.midi[i];
          this.freq[i] = 440 * Math.pow(2, (N.midi[i] - 69) / 12);
          this.kind[i] = KIND_PITCHED;
          this.legato[i] = legato;                       // a breath has no pick attack: the pitch appearing counts
          if (i === 0 || Math.abs(N.t[i] - N.t[i - 1]) > 0.002) this.nEvents++;
          while (si + 1 < sec.n && sec.t[si + 1] <= N.t[i] + 1e-6) si++;
          this.section[i] = si;
        }
      } else if (chart) {
        const N = chart.notes, T = NS.TECH, base = OPEN_MIDI[chart.nStrings === 4 ? 4 : 6];
        const tun = chart.meta.tuning || [], capo = +chart.meta.capo || 0, cents = +chart.meta.cent_offset || 0;
        const B = chart.bends, sec = chart.sections;
        let si = -1;
        for (let i = 0; i < n; i++) {
          const open = (base[N.s[i]] || 0) + (+tun[N.s[i]] || 0);
          const f = N.f[i], tech = N.tech[i];
          let semis = open + (f === 0 ? capo : f);           // frets are absolute; the capo only moves open strings
          if ((tech & T.HARMONIC) && HARMONIC_SEMITONES[f] != null) semis = open + HARMONIC_SEMITONES[f];
          this.midi[i] = Math.round(semis);
          // a pre-bend (curve starting above 0 at the onset) sounds higher from the start
          const k0 = N.bendStart ? N.bendStart[i] : -1;
          const pre = k0 >= 0 && B.t[k0] - N.t[i] < 0.01 ? B.s[k0] : 0;
          this.freq[i] = 440 * Math.pow(2, (semis + pre + cents / 100 - 69) / 12);
          this.kind[i] = tech & (T.FRET_HAND_MUTE | T.PINCH_HARMONIC) ? KIND_UNPITCHED : KIND_PITCHED;
          this.legato[i] = tech & (T.HAMMER_ON | T.PULL_OFF | T.TAP) ? 1 : 0;
          if (i === 0 || Math.abs(N.t[i] - N.t[i - 1]) > 0.002) this.nEvents++;
          while (si + 1 < sec.n && sec.t[si + 1] <= N.t[i] + 1e-6) si++;
          this.section[i] = si;
        }
      }
      this._resetStats();
    }

    /** After a seek / loop wrap: re-arm notes from `t` on; skipped notes are not misses. */
    jump(t) {
      if (!this.chart) return;
      const N = this.chart.notes, i0 = lowerBound(N.t, t - this.window);
      for (let i = i0; i < N.n; i++) this.state[i] = PENDING;
      this._missPtr = i0;
      this.streak = 0;
    }

    /** Due notes around chart time t: [{i, time, midi, string, fret}] (for pitch detectors). */
    expectedAt(t, win) {
      if (!this.chart) return [];
      const N = this.chart.notes, w = win || this.window, out = [];
      for (let i = lowerBound(N.t, t - w); i < N.n && N.t[i] <= t + w; i++) {
        if (this.state[i] === PENDING) out.push({ i, time: N.t[i], midi: this.midi[i], freq: this.freq[i], kind: this.kind[i],
                                                  legato: this.legato[i], string: N.s[i], fret: N.f[i] });
      }
      return out;
    }

    /** Frequencies (Hz) of notes still ringing at chart time t (except `exclude` indices):
     *  detectors use them to "explain away" partials that are not the due notes'. */
    ringingAt(t, exclude) {
      if (!this.chart) return [];
      const N = this.chart.notes, out = [], ex = new Set(exclude || []);
      for (let i = lowerBound(N.t, t - Math.max(2, N.maxSus)); i < N.n && N.t[i] < t - 0.002; i++) {
        if (!ex.has(i) && t <= N.t[i] + Math.max(N.sus[i], 0.35) && this.kind[i] === KIND_PITCHED) out.push(this.freq[i]);
      }
      return out;
    }

    /** Judge one input at chart time t. Returns the result or null (stray input). */
    judgeHit(t, ev) {
      if (!this.active || !this.chart) return null;
      ev = ev || {};
      const N = this.chart.notes;
      const cand = this.expectedAt(t).filter((c) =>
        (ev.midi == null || Math.abs(c.midi - ev.midi) <= 0.5) &&
        (ev.string == null || c.string === ev.string) && (ev.fret == null || c.fret === ev.fret));
      if (!cand.length) { this.extra++; this._emit({ type: "extra", t }); return null; }
      let picked;
      if (Array.isArray(ev.notes) && ev.notes.length) {               // detector says exactly which notes
        const want = new Set(ev.notes);
        picked = cand.filter((c) => want.has(c.i));
        if (!picked.length) { this.extra++; this._emit({ type: "extra", t }); return null; }
      } else {
        // earliest due event; a chord (same onset) is hit as a whole unless a pitch/string was given
        const first = cand.reduce((a, b) => (Math.abs(b.time - t) < Math.abs(a.time - t) ? b : a));
        const group = cand.filter((c) => Math.abs(c.time - first.time) < 0.002);
        picked = ev.midi != null || ev.string != null ? [first] : group;
      }
      const first = picked[0];
      for (const c of picked) { this.state[c.i] = HIT; this.markedAt[c.i] = t; }
      const delta = t - first.time, perfect = Math.abs(delta) <= this.perfectWindow;
      this.hits++; this.streak++; this.bestStreak = Math.max(this.bestStreak, this.streak);
      if (perfect) this.perfect++;
      this.score += (perfect ? 100 : 70) * picked.length * this.multiplier;
      this.deltas.push(Math.round(delta * 1000));
      const sec = this.section[first.i];
      if (sec >= 0) { this.secHits[sec]++; this.secTotal[sec]++; }
      const res = { type: "hit", t, noteTime: first.time, deltaMs: Math.round(delta * 1000), perfect,
                    grade: perfect ? "perfect" : delta < 0 ? "early" : "late", notes: picked.map((c) => c.i) };
      this._emit(res);
      return res;
    }

    /** An explicit wrong note: breaks the streak. */
    judgeMiss(t) { if (this.active) { this.streak = 0; this.extra++; this._emit({ type: "wrong", t }); } }

    /** Per frame: notes whose window has passed unplayed become MISSED. */
    tick(t) {
      if (!this.active || !this.chart) return;
      const N = this.chart.notes;
      const limit = t - this.window - this.missDelay;
      while (this._missPtr < N.n && N.t[this._missPtr] < limit) {
        const i = this._missPtr++;
        if (this.state[i] !== PENDING) continue;
        this.state[i] = MISSED; this.markedAt[i] = N.t[i] + this.window;
        // count a chord once (an event is hit if any of its notes was)
        const sameEvent = i > 0 && Math.abs(N.t[i] - N.t[i - 1]) <= 0.002;
        if (!sameEvent) {
          let anyHit = false;
          for (let k = i + 1; k < N.n && Math.abs(N.t[k] - N.t[i]) <= 0.002; k++) if (this.state[k] === HIT) anyHit = true;
          if (!anyHit) {
            this.misses++; this.streak = 0;
            const sec = this.section[i];
            if (sec >= 0) this.secTotal[sec]++;
            this._emit({ type: "miss", t, noteTime: N.t[i], notes: [i] });
          }
        }
      }
    }

    summary() {
      const total = this.hits + this.misses;
      return { hits: this.hits, misses: this.misses, perfect: this.perfect, extra: this.extra, streak: this.streak,
               bestStreak: this.bestStreak, accuracy: total ? this.hits / total : null, score: this.score,
               multiplier: this.multiplier };
    }

    /** Full run result (end of song / loop pass). */
    result() {
      const sec = this.chart ? this.chart.sections : { n: 0, label: [] };
      const sections = [];
      for (let k = 0; k < sec.n; k++) {
        if (this.secTotal[k]) sections.push({ index: k, label: sec.label[k] || sec.name[k], hits: this.secHits[k],
                                              total: this.secTotal[k], accuracy: this.secHits[k] / this.secTotal[k] });
      }
      const d = this.deltas.slice().sort((a, b) => a - b);
      const med = d.length ? d[d.length >> 1] : null;
      return Object.assign(this.summary(), {
        sections, events: this.nEvents, coverage: this.nEvents ? (this.hits + this.misses) / this.nEvents : 0, meanDeltaMs: d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null, medianDeltaMs: med,
        early: d.filter((x) => x < -this.perfectWindow * 1000).length, late: d.filter((x) => x > this.perfectWindow * 1000).length,
      });
    }
    /** Accuracy per section so far (null = not played yet), for the timeline. */
    sectionAccuracy() {
      const out = [];
      for (let k = 0; k < this.secTotal.length; k++) out.push(this.secTotal[k] ? this.secHits[k] / this.secTotal[k] : null);
      return out;
    }
    _emit(r) { if (this.onJudged) this.onJudged(r); }
  }

  // ---- input sources -----------------------------------------------------------------
  const sources = {};
  /** factory(ctx) -> { start(), stop() }; ctx = { bus, expectedAt, chartTime } */
  NS.registerInputSource = (name, factory) => { sources[name] = factory; };
  NS.inputSources = sources;

  // Built-in test source: D / F / J / K (rhythm-game keys) = "noteHit = true".
  NS.registerInputSource("keyboard", ({ bus }) => {
    const KEYS = new Set(["KeyD", "KeyF", "KeyJ", "KeyK"]);
    const onKey = (e) => {
      if (e.repeat || !KEYS.has(e.code)) return;
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|SELECT|TEXTAREA/.test(tag)) return;
      bus.hit({ at: e.timeStamp || performance.now(), source: "keyboard" });   // event timestamp = exact press time
      e.preventDefault();
    };
    return {
      start() { document.addEventListener("keydown", onKey, true); },
      stop() { document.removeEventListener("keydown", onKey, true); },
    };
  });

  Object.assign(NS, { InputBus, HitJudge, NOTE_PENDING: PENDING, NOTE_HIT: HIT, NOTE_MISSED: MISSED,
                      NOTE_KIND: { PITCHED: KIND_PITCHED, UNPITCHED: KIND_UNPITCHED } });
})(window);
