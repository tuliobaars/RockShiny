/* ---------------------------------------------------------------------------
 * karaoke-sing.js -- sing into the microphone and get scored, in real time
 * (a player plugin for karaoke.js; the same in Shiny and in the HTML page).
 *
 *   microphone ─► AudioWorklet "rs-sing" (pitch: YIN on the signal decimated to
 *                  ~16 kHz, 64 ms window, every 10 ms) ─► SingScorer (main thread)
 *
 * What a sung moment is compared with, per song:
 *   melody     the archive's vocal notes carry pitches (a few charts do: Get
 *              Lucky, Dream On, Little Wing, Steady As She Goes ...): the sung
 *              pitch vs the note due, octave-free (sing in any octave); full
 *              marks within 50 cents, none beyond 300 cents.
 *   tonality   otherwise: which pitches the singer's voice uses in each line,
 *              measured from the song itself (the centre of the stereo mix,
 *              as karaoke-voice.js, chroma in thirds of a semitone, 100-1000 Hz,
 *              30 % of the whole song's profile blended in). A sung pitch scores
 *              by the weight of its pitch class in that profile. Validated on the
 *              charted songs without their charts (numpy prototype): a singer on
 *              the charted notes vs the same singer transposed, per line
 *              AUC 0.78 -- reliable over a song, indicative per line.
 * Timing: only the sung syllables' time counts (+-0.1 s); singing elsewhere is
 * neither rewarded nor punished. A line scores timing x (0.2 + 0.8 x pitch);
 * the song 0..10 000 points, weighted by the lines' sung time.
 *
 *   player.sing.start() / stop()        microphone on / off (needs a user gesture first)
 *   hooks.onScore(result)               at the end of the song (Shiny: input <id>_score)
 *   player.sing.ack({newBest, best})    the host's personal best, shown on the results
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const K = (root.RSKaraoke = root.RSKaraoke || {});

  // ---- the pitch tracker (AudioWorklet; self-contained) ---------------------------------
  function singProcessor() {
    /* global sampleRate, currentTime, registerProcessor, AudioWorkletProcessor */
    class RSSing extends AudioWorkletProcessor {
      constructor() {
        super();
        const D = Math.max(1, Math.round(sampleRate / 16000));
        this.D = D; this.fs = sampleRate / D;
        // anti-alias low-pass (windowed sinc, 0.42 of the new Nyquist... of the new rate)
        const taps = 31, fc = 0.42 * this.fs / sampleRate;
        this.h = new Float64Array(taps);
        let sum = 0;
        for (let i = 0; i < taps; i++) {
          const m = i - (taps - 1) / 2, s = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
          this.h[i] = s * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1))); sum += this.h[i];
        }
        for (let i = 0; i < taps; i++) this.h[i] /= sum;
        this.hist = new Float64Array(taps); this.hp = 0; this.phase = 0;
        this.W = Math.round(0.064 * this.fs); this.hop = Math.round(0.01 * this.fs);
        this.tmin = Math.floor(this.fs / 1100); this.tmax = Math.ceil(this.fs / 70);
        this.buf = new Float64Array(this.W); this.bp = 0; this.count = 0;
        this.x = new Float64Array(this.W); this.d = new Float64Array(this.tmax + 2);
        this.port.onmessage = (e) => { if (e.data && e.data.ping) this.port.postMessage({ pong: e.data.ping }); };
      }
      _yin(tEnd) {
        const W = this.W, x = this.x, d = this.d, tmax = this.tmax, Wi = W - tmax;
        for (let i = 0, j = this.bp; i < W; i++, j = (j + 1) % W) x[i] = this.buf[j];
        let e = 0;
        for (let i = 0; i < W; i++) e += x[i] * x[i];
        const rms = Math.sqrt(e / W), db = 20 * Math.log10(rms + 1e-12);
        let f0 = 0, conf = 0;
        if (db > -60) {
          d[0] = 1;
          let run = 0, best = -1, bestV = 1e9;
          for (let tau = 1; tau <= tmax; tau++) {
            let s = 0;
            for (let j = 0; j < Wi; j++) { const v = x[j] - x[j + tau]; s += v * v; }
            run += s;
            d[tau] = run > 0 ? s * tau / run : 1;
          }
          for (let tau = this.tmin; tau <= tmax; tau++) {
            if (d[tau] < 0.12) { while (tau + 1 <= tmax && d[tau + 1] < d[tau]) tau++; best = tau; break; }
            if (d[tau] < bestV) { bestV = d[tau]; best = tau; }
          }
          const dv = d[best];
          if (best > this.tmin && best < tmax && dv < 0.35) {
            const a = d[best - 1], b = d[best], c = d[best + 1], den = a - 2 * b + c;
            const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
            f0 = this.fs / (best + Math.max(-0.5, Math.min(0.5, shift)));
            conf = 1 - dv;
          }
        }
        this.port.postMessage({ t: tEnd - 0.5 * W / this.fs, f0, conf, db });
      }
      process(inputs) {
        const inp = inputs[0] && inputs[0][0];
        if (!inp) return true;
        const h = this.h, taps = h.length, D = this.D;
        for (let i = 0; i < inp.length; i++) {
          this.hist[this.hp] = inp[i]; this.hp = (this.hp + 1) % taps;
          if (++this.phase < D) continue;
          this.phase = 0;
          let y = 0;
          for (let k = 0, j = this.hp; k < taps; k++, j = (j + 1) % taps) y += h[k] * this.hist[j];
          this.buf[this.bp] = y; this.bp = (this.bp + 1) % this.W;
          if (++this.count >= this.hop) { this.count = 0; this._yin(currentTime + (i + 1) / sampleRate); }
        }
        return true;
      }
    }
    registerProcessor("rs-sing", RSSing);
  }
  K.singProcessorUrl = () => K.workletUrl(singProcessor, "blob");
  K.singProcessorSource = singProcessor;

  const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
  const fold = (d) => ((d % 12) + 18) % 12 - 6;              // semitones, octave-free, -6..6
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  // ---- reference: the song's melody (charted) or tonality (measured) ---------------------
  /** Charted vocal pitches that look like a melody (Rocksmith writes 254 = unpitched;
   *  some charts fill one constant or 0 in). */
  K.melodyNotes = function (S) {
    const n = [];
    for (const L of S.lines) for (const W of L.words) if (W.n != null && W.n > 20 && W.n < 110) n.push(W.n);
    const distinct = new Set(n).size;
    return n.length >= 8 && distinct >= 4 && Math.max(...n) - Math.min(...n) >= 5;
  };

  /** Per-line pitch-class profiles (36 bins, thirds of a semitone) of the song's centre
   *  channel -- buf: an AudioBuffer of the song (stereo, any rate >= 4 kHz). */
  K.tonalityProfiles = async function (buf, lines, opts) {
    opts = opts || {};
    const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const N = sr < 12000 ? 2048 : sr < 24000 ? 4096 : 8192, hop = N / 4;
    const fft = K._fft(N), win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const bins = [];                                             // bin -> chroma class (100-1000 Hz)
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      if (f < 100 || f > 1000) continue;
      bins.push([k, ((Math.round(midiOf(f) * 3) % 36) + 36) % 36]);
    }
    const re = new Float64Array(N), im = new Float64Array(N);
    const song = new Float64Array(36), profs = [];
    let work = 0;
    for (const line of lines) {
      const p = new Float64Array(36);
      const a = Math.max(0, Math.floor((line.start - 0.1) * sr)), b = Math.min(L.length - N, Math.floor((line.end + 0.1) * sr));
      for (let s = a; s <= b; s += hop) {
        for (let i = 0; i < N; i++) { re[i] = L[s + i] * win[i]; im[i] = R[s + i] * win[i]; }
        fft(re, im);
        for (const [k, c] of bins) {
          const q = N - k;
          const lr = 0.5 * (re[k] + re[q]), li = 0.5 * (im[k] - im[q]), rr = 0.5 * (im[k] + im[q]), ri = -0.5 * (re[k] - re[q]);
          const sr_ = lr + rr, si = li + ri, den = 2 * (lr * lr + li * li + rr * rr + ri * ri) + 1e-20;
          const cen = (sr_ * sr_ + si * si) / den;                // 1 = the same in both channels
          p[c] += cen * cen * 0.5 * Math.sqrt(sr_ * sr_ + si * si);
        }
        if (++work % 200 === 0) await new Promise((r) => setTimeout(r, 0));   // stay responsive
      }
      profs.push(p);
      for (let c = 0; c < 36; c++) song[c] += p[c];
    }
    const sTot = song.reduce((x, y) => x + y, 0) || 1;
    return profs.map((p) => {
      const tot = p.reduce((x, y) => x + y, 0) || 1, q = new Float64Array(36);
      for (let c = 0; c < 36; c++) q[c] = 0.7 * p[c] / tot + 0.3 * song[c] / sTot;
      const mx = Math.max(...q) || 1;
      for (let c = 0; c < 36; c++) q[c] = Math.pow(q[c] / mx, 2);
      const out = new Float64Array(36);                           // tolerate a third of a semitone
      for (let c = 0; c < 36; c++) out[c] = Math.max(q[c], 0.8 * q[(c + 1) % 36], 0.8 * q[(c + 35) % 36]);
      return out;
    });
  };

  K._fft = function (n) {
    const bits = Math.log2(n), rev = new Uint32Array(n), cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    for (let i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = -Math.sin(2 * Math.PI * i / n); }
    return (re, im) => {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half, tr = re[b] * cs[k] - im[b] * sn[k], ti = re[b] * sn[k] + im[b] * cs[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    };
  };

  // ---- the scorer (pure: testable without audio) -------------------------------------------
  const RATINGS = [[0.85, "Perfect!"], [0.65, "Great"], [0.45, "Good"], [0.2, "OK"], [0, "Missed"]];
  K.SING = { TOL: 0.1, FULL_CENTS: 50, ZERO_CENTS: 300, TONAL_LO: 0.15, TONAL_SPAN: 0.38, MIN_CONF: 0.5, MIN_DB: -50, RATINGS };
  K.rating = (x) => RATINGS.find(([v]) => x >= v)[1];

  class SingScorer {
    /** S: the player's song model; mode "melody" | "tonality"; profiles: per line (tonality). */
    constructor(S, mode, profiles) {
      this.S = S; this.mode = mode; this.profiles = profiles || null;
      const C = K.SING;
      this.lines = S.lines.map((L, k) => {
        const syl = L.words.map((W) => ({ t: W.t, e: W.t + Math.max(W.d, 0.12), n: W.n != null && W.n !== 254 ? W.n : null }));
        const due = syl.reduce((x, s) => x + (s.e - s.t), 0);
        return { k, start: L.start, end: L.end, syl, due, frames: 0, voiced: 0, pitch: 0, done: false, score: null };
      });
      this.total = this.lines.reduce((x, l) => x + l.due, 0) || 1;
      this.points = 0; this.combo = 0; this.bestCombo = 0; this.last = null; this.trail = []; this.tol = C.TOL;
      this.seeked = false;
    }
    /** Which line / syllables are due at song time s. */
    _line(s) {
      const L = this.lines;
      let lo = 0, hi = L.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].start - 0.2 <= s) lo = m + 1; else hi = m; }
      for (let k = lo - 1; k >= 0 && k >= lo - 2; k--) if (s <= L[k].end + 0.3) return L[k];
      return null;
    }
    /** Score of one sung pitch (midi, float) against line l at song time s: 0..1, or null if nothing is due. */
    pitchScore(l, s, m) {
      const C = K.SING, tol = this.tol;
      if (this.mode === "melody") {
        let best = null;
        for (const y of l.syl) {
          if (y.n == null || s < y.t - tol || s > y.e + tol) continue;
          const c = Math.abs(fold(m - y.n)) * 100;
          const v = clamp(1 - (c - C.FULL_CENTS) / (C.ZERO_CENTS - C.FULL_CENTS), 0, 1);
          if (best == null || v > best) best = v;
        }
        return best;
      }
      const p = this.profiles && this.profiles[l.k];
      if (!p) return null;
      const r = p[((Math.round(m * 3) % 36) + 36) % 36];
      return clamp((r - C.TONAL_LO) / C.TONAL_SPAN, 0, 1);
    }
    /** One pitch frame: s = song time it was sung at; f0 Hz (0 = silence / unvoiced). */
    frame(s, f0, conf, db) {
      const C = K.SING, l = this._line(s);
      this._finishBefore(s);
      if (!l || l.done) return null;
      let core = false, near = false;                      // inside a syllable / within the tolerance around one
      for (const y of l.syl) {
        if (s >= y.t && s <= y.e) { core = true; near = true; break; }
        if (s >= y.t - this.tol && s <= y.e + this.tol) near = true;
      }
      const voiced = f0 > 0 && conf >= C.MIN_CONF && db >= C.MIN_DB;
      const m = voiced ? midiOf(f0) : null;
      let v = null;
      if (core) l.frames++;
      if (near && voiced) {
        l.voiced++;
        v = this.pitchScore(l, s, m);
        l.pitch += v == null ? 0.5 : v;                    // a melody syllable without a pitch: half credit
      }
      if (voiced) {
        this.trail.push({ s, m, v });
        if (this.trail.length > 800) this.trail.splice(0, 200);
      }
      return v;
    }
    _finishBefore(s) {
      for (const l of this.lines) {
        if (l.done || l.end + 0.4 > s) { if (l.start > s) break; continue; }
        this._finish(l);
      }
    }
    _finish(l) {
      l.done = true;
      if (!l.frames) { l.score = 0; l.timing = 0; l.pitchAvg = 0; l.frames = 0; }
      if (!l.frames) { this.combo = 0; this.last = { k: l.k, score: 0, rating: K.rating(0), at: performance.now() }; return; }
      l.timing = Math.min(1, l.voiced / Math.max(1, l.frames * 0.8));    // voiced near the syllables vs their length
      l.pitchAvg = l.voiced ? l.pitch / l.voiced : 0;
      l.score = l.timing * (0.2 + 0.8 * l.pitchAvg);
      this.points += 10000 * l.score * l.due / this.total;
      this.combo = l.score >= 0.65 ? this.combo + 1 : 0;
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.last = { k: l.k, score: l.score, rating: K.rating(l.score), at: performance.now() };
    }
    /** After a seek: lines from there on are sung again. */
    seek(s) {
      this.seeked = true;
      for (const l of this.lines) if (l.end + 0.4 > s) {
        if (l.done && l.score != null) this.points -= 10000 * l.score * l.due / this.total;
        Object.assign(l, { frames: 0, voiced: 0, pitch: 0, done: false, score: null });
      }
      this.trail = this.trail.filter((p) => p.s < s);
    }
    finishAll() { for (const l of this.lines) if (!l.done) this._finish(l); }
    result() {
      const sung = this.lines.filter((l) => l.done && l.frames > 0);
      const avg = (f) => (sung.length ? sung.reduce((x, l) => x + f(l), 0) / sung.length : 0);
      return { score: Math.round(this.points), mode: this.mode, lines: this.lines.map((l) => (l.score == null ? null : +l.score.toFixed(3))),
               pitch: +avg((l) => l.pitchAvg).toFixed(3), timing: +avg((l) => l.timing).toFixed(3), bestCombo: this.bestCombo,
               linesSung: sung.length, linesTotal: this.lines.length, complete: !this.seeked, rating: K.rating(this.points / 10000) };
    }
  }
  K.SingScorer = SingScorer;

  // ---- the plugin: microphone, lane, score, results ------------------------------------------
  const DOT_COLOURS = ["rgba(180,190,210,0.7)", "#46c878", "#ffd27a", "#ff7a6b"];   // no reference / good / close / off
  /** Fill many rectangles (flat [x, y, w, h, ...]) as one path. */
  function fillRects(g, colour, r) {
    if (!r.length) return;
    g.beginPath();
    for (let i = 0; i < r.length; i += 4) g.rect(r[i], r[i + 1], r[i + 2], r[i + 3]);
    g.fillStyle = colour; g.fill();
  }
  const ICON_MIC = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>';
  class SingSession {
    constructor(player) {
      this.p = player; this.on = false; this.scorer = null; this.profiles = new Map();
      try { this.prefs = JSON.parse(root.localStorage.getItem("rs-karaoke-sing") || "{}") || {}; } catch (e) { this.prefs = {}; }
      this._build();
    }
    _save() { try { root.localStorage.setItem("rs-karaoke-sing", JSON.stringify(this.prefs)); } catch (e) { /* private */ } }

    _build() {
      const p = this.p;
      const b = (this.btn = document.createElement("button"));
      b.type = "button"; b.className = "rs-k-btn rs-k-btn-mic"; b.innerHTML = ICON_MIC + "<i class='rs-k-miclevel'></i>";
      b.title = "Sing & score: your microphone, scored as you sing (headphones recommended)"; b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => { this.toggle(); b.blur(); });
      p.transport.insertBefore(b, p.time);
      this.lane = document.createElement("canvas"); this.lane.className = "rs-k-lane";
      p.el.insertBefore(this.lane, p.transport);
      // the lane's size, kept by an observer: reading clientWidth in the frame would force a layout
      // right after the player's DOM updates (measured: 5-15 ms per frame on software raster)
      this.laneSize = null;
      if (root.ResizeObserver) {
        this._ro = new root.ResizeObserver((es) => { const r = es[es.length - 1].contentRect; this.laneSize = { w: r.width, h: r.height }; });
        this._ro.observe(this.lane);
      }
      this.hud = document.createElement("div"); this.hud.className = "rs-k-score";
      this.hud.innerHTML = '<b class="rs-k-score-pts">0</b><span class="rs-k-score-rate"></span>';
      p.el.appendChild(this.hud);
      this.card = document.createElement("div"); this.card.className = "rs-k-results";
      p.el.appendChild(this.card);
    }
    toggle() { return this.on || this._pendingStart ? this.stop() : this.start(); }
    /** The player starts (a user gesture: the audio graph is running now). */
    playing() { if (this._pendingStart && !this.on) this.start(); }

    async start(opts) {
      const p = this.p, out = p.deck.out;
      if (this.on || this._starting) return;
      this._starting = true;
      const gen = this._gen = (this._gen || 0) + 1;           // stop() while starting cancels the start
      const cancelled = () => gen !== this._gen;
      try {
        if (!root.navigator.mediaDevices || !root.navigator.mediaDevices.getUserMedia) throw new Error("this browser has no microphone access here (it needs https or localhost)");
        await out.ensure();
        if (!out.ready) {                                 // the browser wants a click first (autoplay policy)
          this._pendingStart = true;
          this.btn.classList.add("is-pending");
          p.status("Singing: press Play (or Space) and the microphone starts.", "info");
          return false;
        }
        this._pendingStart = false; this.btn.classList.remove("is-pending");
        this.stream = await root.navigator.mediaDevices.getUserMedia({ audio: {
          deviceId: this.prefs.deviceId ? { exact: this.prefs.deviceId } : undefined,
          echoCancellation: this.prefs.echoCancellation !== false, noiseSuppression: false, autoGainControl: false } });
        if (cancelled()) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; return false; }
        await K.loadWorklet(out.ctx, singProcessor);
        if (cancelled()) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; return false; }
        this.src = out.ctx.createMediaStreamSource(this.stream);
        this.node = new AudioWorkletNode(out.ctx, "rs-sing", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        this.sink = out.ctx.createGain(); this.sink.gain.value = 0;
        this.src.connect(this.node).connect(this.sink).connect(out.ctx.destination);
        this.node.port.onmessage = (e) => this._pitch(e.data);
        const tr = this.stream.getAudioTracks()[0], st = tr && tr.getSettings ? tr.getSettings() : {};
        this.inputLatency = (st.latency || 0.01) + (out.ctx.baseLatency || 0.01);
        this.on = true; this.frames = 0; this.level = -100;
        p.el.classList.add("is-singing");
        this.btn.classList.add("is-on");
        if (!(opts && opts.quiet) && p.voice && p.voice.volume >= 1 && !p.voice.muted) {
          p.status("Singing: use headphones, or turn the original voice down (the person icon) so the microphone hears you, not the song.", "info");
          setTimeout(() => { if (/^Singing:/.test(p.banner.textContent)) p.status("", "clear"); }, 7000);
        }
        await this._prepare();
        if (cancelled()) return false;
      } catch (e) {
        if (cancelled()) return false;
        this.stop();
        p.status(`Microphone: ${e.message || e}`, "error");
        if (p.hooks.onSingState) p.hooks.onSingState({ on: false, error: String(e.message || e), nonce: Date.now() });
        return false;
      } finally { if (gen === this._gen) this._starting = false; }
      if (p.hooks.onSingState) p.hooks.onSingState({ on: true, mode: this.scorer && this.scorer.mode, nonce: Date.now() });
      return true;
    }
    stop() {
      const p = this.p;
      if (this._starting) { this._gen = (this._gen || 0) + 1; this._starting = false; }
      this._pendingStart = false; this.btn.classList.remove("is-pending");
      try { if (this.src) this.src.disconnect(); if (this.node) this.node.disconnect(); if (this.sink) this.sink.disconnect(); } catch (e) { /* gone */ }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.src = this.node = this.sink = this.stream = null;
      const was = this.on;
      this.on = false;
      p.el.classList.remove("is-singing");
      this.btn.classList.remove("is-on");
      this.btn.style.setProperty("--lvl", 0);
      if (was && this.scorer && this.scorer.lines.some((l) => l.done && l.frames)) this._results(false);
      if (was && p.hooks.onSingState) p.hooks.onSingState({ on: false, nonce: Date.now() });
    }

    /** The reference for the song on stage: its charted melody, or its measured tonality. */
    async _prepare() {
      const p = this.p, S = p.song;
      if (!S || !S.lines.length || (S.lyrics && S.lyrics.plain)) { this.scorer = null; return; }
      if (K.melodyNotes(S)) { this.scorer = new SingScorer(S, "melody"); this._afterSetup(); return; }
      const key = S.songKey + "|" + S.lines.length + "|" + (S.lines[0].start).toFixed(2);
      let prof = this.profiles.get(key);
      if (!prof) {
        this.scorer = null;
        p.status("Preparing the score: listening to the song's voice\u2026", "info");
        try {
          const buf = await p.decodeAudio(8000);
          if (!buf) throw new Error("the song's audio is not loaded yet");
          const t0 = performance.now();
          prof = await K.tonalityProfiles(buf, S.lines);
          this.prepMs = performance.now() - t0;
          this.profiles.set(key, prof);
          p.status("", "clear");
        } catch (e) {
          p.status(`Scoring by timing only: ${e.message || e}`, "info");
          prof = null;
        }
      }
      if (p.song !== S) return;
      this.scorer = new SingScorer(S, prof ? "tonality" : "timing", prof);
      this._afterSetup();
    }
    _afterSetup() {
      const s = this.p.lyricTime(performance.now());
      if (this.scorer && s > 0.5) this.scorer.seek(s);
      this.scorer && (this.scorer.seeked = s > 0.5);
      this._paintHud(true);
    }
    /** A new song on stage. */
    load() {
      this.card.classList.remove("is-open");
      this.scorer = null;
      if (this.on) this._prepare();
      this._paintHud(true);
    }
    seeked(t) { if (this.scorer) this.scorer.seek(t); }
    ended() { if (this.on && this.scorer) { this.scorer.finishAll(); this._results(true); } }

    _pitch(m) {
      if (!this.on || m.t == null) return;
      const p = this.p, ctx = p.deck.out.ctx;
      this.level = m.db;
      this.btn.style.setProperty("--lvl", clamp((m.db + 60) / 45, 0, 1).toFixed(2));
      if (!this.scorer || !p.clock.playing) return;
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      const perf = ts && ts.performanceTime > 0 ? ts.performanceTime + (m.t - ts.contextTime) * 1000
        : performance.now() - (ctx.currentTime - m.t) * 1000;
      const lat = (this.prefs.latencyMs != null ? this.prefs.latencyMs / 1000 : this.inputLatency);
      const s = p.lyricTime(perf - 1000 * lat);
      this.frames++;
      this.scorer.frame(s, m.f0, m.conf, m.db);
    }

    /** Every display frame: lane + score. */
    frame(t) {
      if (!this.on) return;
      this._paintLane(t);
      this._paintHud(false);
    }
    _paintHud(force) {
      const sc = this.scorer, pts = sc ? Math.round(sc.points) : 0;
      if (force || pts !== this._pts) { this._pts = pts; this.hud.querySelector(".rs-k-score-pts").textContent = pts.toLocaleString("en-US"); }
      const last = sc && sc.last, fresh = last && performance.now() - last.at < 1800;
      const txt = fresh ? last.rating + (sc.combo >= 3 ? `  \u00d7${sc.combo}` : "") : sc ? (sc.mode === "melody" ? "melody" : sc.mode === "tonality" ? "in key" : "timing") : "";
      if (txt !== this._txt) {
        this._txt = txt;
        const r = this.hud.querySelector(".rs-k-score-rate");
        r.textContent = txt;
        r.className = "rs-k-score-rate" + (fresh ? " is-" + last.rating.replace(/[^a-z]/gi, "").toLowerCase() : "");
      }
    }
    _paintLane(t) {
      const cv = this.lane, dpr = Math.min(2, root.devicePixelRatio || 1);
      const sz = this.laneSize || (this._ro ? { w: 0, h: 0 } : { w: cv.clientWidth, h: cv.clientHeight });
      const w = sz.w, hgt = sz.h;
      if (!w || !hgt) return;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr); }
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, hgt);
      const sc = this.scorer;
      if (!sc) return;
      const before = 2.5, after = 4, x = (s) => ((s - t + before) / (before + after)) * w;
      const melody = sc.mode === "melody";
      // pitch axis: melody -> the song's charted range; tonality -> one octave of pitch classes
      let lo = 0, hi = 12;
      if (melody) {
        if (this._range == null || this._rangeFor !== sc) {
          const ns = sc.lines.flatMap((l) => l.syl.filter((y) => y.n != null).map((y) => y.n));
          this._range = [Math.min(...ns) - 2, Math.max(...ns) + 2]; this._rangeFor = sc;
        }
        [lo, hi] = this._range;
      }
      const y = (m) => hgt - 6 - ((m - lo) / (hi - lo)) * (hgt - 12);
      const foldTo = (m) => { if (!melody) return ((m % 12) + 12) % 12; const c = (lo + hi) / 2; return m + 12 * Math.round((c - m) / 12); };
      // grid
      g.strokeStyle = "rgba(255,255,255,0.05)"; g.lineWidth = 1;
      for (let m = Math.ceil(lo); m <= hi; m++) { if (((m % 12) + 12) % 12 === 0) { g.beginPath(); g.moveTo(0, y(m)); g.lineTo(w, y(m)); g.stroke(); } }
      // reference (batched: one fill per colour -- canvas state changes are what cost on software raster)
      const refOn = [], refOff = [];
      for (const l of sc.lines) {
        if (l.end < t - before || l.start > t + after) continue;
        if (melody) {
          for (const s of l.syl) {
            if (s.n == null) continue;
            (s.t <= t && t <= s.e ? refOn : refOff).push(x(s.t), y(foldTo(s.n)) - 3, Math.max(3, x(s.e) - x(s.t)), 6);
          }
        } else if (sc.profiles && sc.profiles[l.k]) {
          const p = sc.profiles[l.k], x0 = x(l.start), x1 = x(l.end);
          for (let c = 0; c < 36; c += 3) {
            const v = Math.max(p[c], p[(c + 1) % 36], p[(c + 35) % 36]);
            if (v < 0.2) continue;
            g.fillStyle = `rgba(245,165,36,${(0.1 + 0.4 * v).toFixed(2)})`;
            g.fillRect(x0, y(c / 3) - 3, x1 - x0, 6);
          }
        }
      }
      fillRects(g, "rgba(245,165,36,0.45)", refOff);
      fillRects(g, "rgba(245,165,36,0.95)", refOn);
      // now line
      g.fillStyle = "rgba(255,255,255,0.5)"; g.fillRect(x(t) - 1, 0, 2, hgt);
      // the singer: the trail is in time order -> binary search the visible part, one path per colour
      const tr = sc.trail, from = t - before, to = t + 0.2;
      let a = 0, b = tr.length;
      while (a < b) { const mid = (a + b) >> 1; if (tr[mid].s < from) a = mid + 1; else b = mid; }
      const dots = [[], [], [], []];
      for (let i = a; i < tr.length; i++) {
        const q = tr[i];
        if (q.s > to) continue;
        dots[q.v == null ? 0 : q.v > 0.7 ? 1 : q.v > 0.35 ? 2 : 3].push(x(q.s) - 1.5, y(foldTo(q.m)) - 1.5, 3, 3);
      }
      DOT_COLOURS.forEach((c, i) => fillRects(g, c, dots[i]));
    }

    _results(finished) {
      const sc = this.scorer;
      if (!sc) return;
      const r = Object.assign(sc.result(), { songKey: this.p.song && this.p.song.songKey, finished, rate: this.p.clock.rate, nonce: Date.now() });
      this.lastResult = r;
      const key = "rs-karaoke-best:" + r.songKey;
      let best = null;
      try { best = JSON.parse(root.localStorage.getItem(key) || "null"); } catch (e) { best = null; }
      const newBest = r.complete && finished && (!best || r.score > best.score);
      if (newBest) { try { root.localStorage.setItem(key, JSON.stringify({ score: r.score, at: Date.now() })); } catch (e) { /* private */ } }
      const bars = r.lines.map((v) => `<i style="--v:${v == null ? 0 : v}" class="${v == null ? "is-skip" : ""}"></i>`).join("");
      this.card.innerHTML = `<div class="rs-k-res-box"><div class="rs-k-res-kind">${finished ? "Song finished" : "Scoring stopped"} \u00b7 ${
        r.mode === "melody" ? "sung against the charted melody" : r.mode === "tonality" ? "sung against the song's key, line by line" : "timing only"}</div>
        <div class="rs-k-res-score">${r.score.toLocaleString("en-US")}</div><div class="rs-k-res-rating">${r.rating}</div>
        <div class="rs-k-res-stats"><span><b>${Math.round(100 * r.pitch)}%</b> pitch</span><span><b>${Math.round(100 * r.timing)}%</b> timing</span>
        <span><b>${r.linesSung}/${r.linesTotal}</b> lines</span><span><b>\u00d7${r.bestCombo}</b> best streak</span></div>
        <div class="rs-k-res-lines">${bars}</div>
        <div class="rs-k-res-best">${newBest ? "New personal best!" : best ? `Best: ${best.score.toLocaleString("en-US")}` : r.complete ? "" : "Practice run (you jumped around): not a record"}</div>
        <button type="button" class="rs-k-res-close">Close</button></div>`;
      this.card.querySelector(".rs-k-res-close").addEventListener("click", () => this.card.classList.remove("is-open"));
      this.card.classList.add("is-open");
      if (this.p.hooks.onScore) this.p.hooks.onScore(r);
    }
    /** The host's verdict (Shiny: R's personal best). */
    ack(a) {
      const e = this.card.querySelector(".rs-k-res-best");
      if (e && a) e.textContent = a.newBest ? "New personal best!" + (a.previous != null ? ` (was ${(+a.previous).toLocaleString("en-US")})` : "")
        : a.best != null ? `Best: ${(+a.best).toLocaleString("en-US")}` : e.textContent;
    }
    destroy() { this.stop(); if (this._ro) this._ro.disconnect(); this.lane.remove(); this.hud.remove(); this.card.remove(); }
  }
  K.SingSession = SingSession;
  (K.plugins = K.plugins || []).push({ name: "sing", create: (player) => new SingSession(player) });
})(window);
