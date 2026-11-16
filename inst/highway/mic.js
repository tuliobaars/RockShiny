/* ---------------------------------------------------------------------------
 * mic.js -- microphone / instrument-cable scoring (an input source for input.js).
 *
 *   getUserMedia ─► AudioWorklet "rs-guitar-analyzer" (pitch-worklet.js)
 *                      onsets + spectra (audio thread)
 *                 ─► NoteVerifier (main thread)
 *                      "were the notes that are due right now actually played?"
 *                 ─► bus.hit({ chartTime, notes, source: "microphone" }) ─► HitJudge
 *
 * Verification, not transcription: the chart says which pitches are due, so
 * for each due note we measure the harmonic salience of its expected
 * frequency and compare it with the neighbouring semitones. This works for
 * chords (which blind pitch tracking cannot do) and is robust to the
 * fundamental being weak on low strings.
 * Rules: picked notes need an onset near their time; hammer-ons / pull-offs /
 * taps need only the pitch to appear (it must not already be sounding);
 * fret-hand mutes and pinch harmonics need only the attack; chords count
 * when >= 50 % of their pitched notes are present.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});
  // the worklet file sits next to this script (also when the script was injected dynamically)
  const SCRIPT = (document.currentScript && document.currentScript.src) ||
    (Array.from(document.scripts).map((x) => x.src).find((u) => /\/mic\.js(\?|$)/.test(u)) || "");
  const WORKLET_URL = SCRIPT ? SCRIPT.replace(/[^/]*$/, "pitch-worklet.js") : "pitch-worklet.js";
  const SEMI = Math.pow(2, 1 / 12), QTONE = Math.pow(2, 1 / 24);
  const LOG_FMIN = 35, LOG_FMAX = 5000, LOG_BPS = 3;                     // log-frequency axis
  const LOG_N = Math.ceil(12 * LOG_BPS * Math.log2(LOG_FMAX / LOG_FMIN));
  const LOG_HALF_LO = Math.pow(2, -1 / (24 * LOG_BPS)), LOG_HALF_HI = Math.pow(2, 1 / (24 * LOG_BPS));

  // ---- note verification (pure: testable offline) --------------------------------------
  class NoteVerifier {
    /**
     * @param judge   HitJudge (expectedAt, window, active)
     * @param emit    (chartTime, ev) => void   called for each verified event
     * @param opts    { threshold: salience ratio vs neighbouring semitones,
     *                  chordFraction, harmonics }
     */
    constructor(judge, emit, opts) {
      this.judge = judge; this.emit = emit;
      this.opts = Object.assign({ threshold: 2, chordFraction: 0.5, harmonics: 6 }, opts || {});
      this.onsets = []; this.frames = []; this._templates = new Map(); this._before = new Map();
    }
    setSensitivity(k) { this.opts.threshold = 2 / Math.max(0.4, Math.min(2.5, k)); }

    onOnset(tc, strength) {
      this.onsets.push({ tc, strength, used: false });
      while (this.onsets.length && this.onsets[0].tc < tc - 2) this.onsets.shift();
    }

    /** Peak magnitude within +/- a quarter tone of frequency f. */
    _peak(mag, f, binHz) {
      const lo = Math.max(1, Math.floor(f / QTONE / binHz)), hi = Math.min(mag.length - 1, Math.ceil(f * QTONE / binHz));
      let m = 0;
      for (let b = lo; b <= hi; b++) if (mag[b] > m) m = mag[b];
      return m;
    }
    /** Harmonic salience of f0: sum of harmonic peaks, weighted 1/sqrt(h). */
    _sal(mag, f0, binHz) {
      let s = 0;
      for (let h = 1; h <= this.opts.harmonics; h++) {
        if (f0 * h * QTONE / binHz >= mag.length - 1) break;
        s += this._peak(mag, f0 * h, binHz) / Math.sqrt(h);
      }
      return s;
    }

    // ---- joint decomposition (fixed-dictionary NMF) -----------------------------------

    /** Log-frequency magnitude spectrum of a frame (cached): 3 bins / semitone, 35 Hz - 5 kHz. */
    _logSpec(frame) {
      if (frame.V) return frame.V;
      const { mag, binHz } = frame, V = new Float64Array(LOG_N);
      for (let b = 0; b < LOG_N; b++) {
        const fc = LOG_FMIN * Math.pow(2, b / (12 * LOG_BPS));
        const x0 = Math.ceil(fc * LOG_HALF_LO / binHz), x1 = Math.floor(fc * LOG_HALF_HI / binHz);
        let v = 0;
        if (x1 >= x0) { for (let k = x0; k <= Math.min(x1, mag.length - 1); k++) if (mag[k] > v) v = mag[k]; }
        else {                                              // log bin narrower than a linear bin: interpolate
          const x = fc / binHz, k = Math.floor(x), u = x - k;
          v = k + 1 < mag.length ? mag[k] * (1 - u) + mag[k + 1] * u : 0;
        }
        V[b] = v;
      }
      return (frame.V = V);
    }

    /** Sparse harmonic template of a pitch on the log axis (cached, unit sum). */
    _template(f) {
      const key = Math.round(f * 10);
      let t = this._templates.get(key);
      if (t) return t;
      const idx = [], w = [];
      for (let h = 1; h <= 20; h++) {
        const fh = f * h;
        if (fh > LOG_FMAX) break;
        const pos = 12 * LOG_BPS * Math.log2(fh / LOG_FMIN), b0 = Math.round(pos), amp = Math.pow(h, -0.8);
        for (let b = b0 - 1; b <= b0 + 1; b++) {
          if (b < 0 || b >= LOG_N) continue;
          idx.push(b); w.push(amp * Math.exp(-0.5 * Math.pow((b - pos) / 0.6, 2)));
        }
      }
      const sum = w.reduce((a, b) => a + b, 0) || 1;
      t = { idx: Int32Array.from(idx), w: Float64Array.from(w.map((x) => x / sum)) };
      this._templates.set(key, t);
      return t;
    }

    /**
     * Which of the `targets` (Hz) are sounding in this frame? The spectrum is
     * explained jointly by the targets, their semitone neighbours (the likely
     * wrong notes), still-ringing notes and a flat noise floor (KL-NMF with a
     * fixed dictionary, multiplicative updates). A target is present when its
     * activation beats both neighbours by `threshold` and holds a real share of
     * the energy. @return array of true | false | null (null: the target is an
     * exact harmonic of another candidate and too weak to tell apart)
     */
    verify(frame, targets, ringing) {
      const V = this._logSpec(frame);
      const cands = [], add = (f, role, of) => {
        if (f < LOG_FMIN || f > LOG_FMAX / 1.5) return -1;
        for (let j = 0; j < cands.length; j++) if (Math.abs(Math.log(cands[j].f / f)) < 0.02) return j;
        cands.push({ f, role, of }); return cands.length - 1;
      };
      const tj = targets.map((f) => add(f, "target"));
      const nb = targets.map((f, k) => [add(f / SEMI, "neighbour", k), add(f * SEMI, "neighbour", k)]);
      for (const f of ringing || []) add(f, "ringing");
      const m = cands.length, T = cands.map((c) => this._template(c.f));
      let total = 0;
      for (let b = 0; b < LOG_N; b++) total += V[b];
      if (total <= 0) { this.lastActivation = targets.map(() => 0); return targets.map(() => false); }
      const a = new Float64Array(m).fill(total / (m + 1));
      let noise = total / (m + 1);
      const R = new Float64Array(LOG_N);
      for (let it = 0; it < 40; it++) {
        R.fill(noise / LOG_N);
        for (let j = 0; j < m; j++) { const t = T[j]; for (let k = 0; k < t.idx.length; k++) R[t.idx[k]] += a[j] * t.w[k]; }
        for (let j = 0; j < m; j++) {
          const t = T[j]; let num = 0;
          for (let k = 0; k < t.idx.length; k++) num += t.w[k] * V[t.idx[k]] / R[t.idx[k]];
          a[j] *= num;                                    // templates have unit sum
        }
        let nn = 0;
        for (let b = 0; b < LOG_N; b++) nn += V[b] / R[b];
        noise *= nn / LOG_N;
      }
      let act = 0;
      for (let j = 0; j < m; j++) act += a[j];
      if (this._dbg) this._last = [];
      this.lastActivation = tj.map((j) => (j >= 0 ? a[j] : 0));      // per target (for the rise test)
      return targets.map((f, k) => {
        const j = tj[k];
        if (j < 0) return null;
        const rival = Math.max(nb[k][0] >= 0 && nb[k][0] !== j ? a[nb[k][0]] : 0, nb[k][1] >= 0 && nb[k][1] !== j ? a[nb[k][1]] : 0, 1e-12);
        const share = a[j] / (act + noise);
        if (this._dbg) this._last.push(a[j] / rival, share);
        const ok = a[j] / rival >= this.opts.threshold && share >= 0.02;
        if (ok) return true;
        // an exact harmonic (octave, twelfth, ...) of another candidate cannot be told apart when weak
        const covered = cands.some((c, q) => q !== j && c.role !== "neighbour" && [2, 3, 4].some((h) => Math.abs(Math.log(f / (h * c.f))) < Math.log(QTONE)));
        return covered ? null : false;
      });
    }

    /** Single-target convenience wrapper (legato checks, tests). */
    present(frame, f, single, others) { return this.verify(frame, [f], others || [])[0]; }

    onFrame(tc, mag, n, sr, rms, win) {
      const J = this.judge;
      if (!J.active) return;
      let max = 0;
      for (let k = 0; k < mag.length; k++) if (mag[k] > max) max = mag[k];
      const frame = { tc, mag, binHz: sr / n, res: sr / (win || n / 2), rms, floor: max * 0.01 };
      this.frames.push(frame);
      while (this.frames.length && this.frames[0].tc < tc - 0.6) this.frames.shift();

      const cands = J.expectedAt(tc, J.window + 0.05);
      if (!cands.length) return;
      const groups = [];
      for (const c of cands) {
        const g = groups.find((x) => Math.abs(x.time - c.time) < 0.002);
        if (g) g.notes.push(c); else groups.push({ time: c.time, notes: [c] });
      }
      groups.sort((a, b) => a.time - b.time);
      for (const g of groups) {
        if (g.time > tc + 0.03) continue;                          // frame has not reached it yet
        const legato = g.notes.every((c) => c.legato);
        let on = this._onsetNear(g.time);
        // an onset nearer to another due note is that note's attack, not this one's
        if (on && J.expectedAt(on.tc, 0.25).some((c) => Math.abs(c.time - g.time) > 0.002 && Math.abs(c.time - on.tc) < Math.abs(g.time - on.tc))) on = null;
        const why = this.trace ? (r) => {                            // optional diagnostics: reason history
          const h = this.trace.get(g.time) || [];
          if (h[h.length - 1] !== r) h.push(r);
          this.trace.set(g.time, h);
        } : () => {};
        if (!on && !legato) { why("no onset"); continue; }         // picked notes need an attack
        // The frame must belong to this attack: its window starts within +/- 1/4
        // window of the onset. Earlier frames still hold the previous strike; later
        // ones can hold the *next* strike (which must not confirm this onset).
        if (on) {
          const start = tc - 0.5 / frame.res, q = 0.25 / frame.res;
          if (start < on.tc - q) { why("waiting"); continue; }    // not yet: wait for a later frame
          if (start > on.tc + q) { on.expired = true; why("expired"); continue; }
        }
        const pitched = g.notes.filter((c) => c.kind === NS.NOTE_KIND.PITCHED);
        const single = g.notes.length === 1;
        const ringing = J.ringingAt ? J.ringingAt(g.time, g.notes.map((c) => c.i)) : [];
        const hitNotes = g.notes.filter((c) => c.kind !== NS.NOTE_KIND.PITCHED).map((c) => c.i);
        let present = 0, verifiable = 0;
        const freqs = pitched.map((c) => c.freq);
        const ring = ringing.filter((f) => freqs.every((g) => Math.abs(Math.log(f / g)) > Math.log(QTONE)));
        const verdict = pitched.length ? this.verify(frame, freqs, ring) : [];
        pitched.forEach((c, k) => {
          const v = verdict[k];
          if (v === null) { hitNotes.push(c.i); return; }          // cannot be checked: follows the chord
          verifiable++;
          if (v) { present++; hitNotes.push(c.i); }
        });
        const needed = verifiable <= 1 ? verifiable : Math.max(1, Math.ceil(verifiable * this.opts.chordFraction));
        if (present < needed) { why(`pitch ${present}/${needed} of ${verifiable} verifiable`); continue; }
        if (on && !this._rose(frame, on, pitched, verdict, ring)) { why("rise"); continue; }
        let tHit;
        if (on) { on.used = true; tHit = on.tc; }
        else if (legato && verifiable) {
          // the same pitch is due again (and already reached): the sound is more likely that note's
          const again = groups.some((g2) => g2.time > g.time + 0.002 && g2.time <= tc + 0.03 &&
            g2.notes.length === g.notes.length && g2.notes.every((c, k) => Math.abs(c.freq - g.notes[k].freq) < 0.5));
          if (again) { why("same pitch due again"); continue; }
          // the new pitch must not have been sounding already (previous note ringing)
          // (the frames before the note are complete by now: decide once per note group)
          const key = g.time + "|" + freqs.join(",");
          let soundedBefore = this._before.get(key);
          if (soundedBefore === undefined) {
            const before = this.frames.filter((f) => f.tc < g.time - 0.07 && f.tc > g.time - 0.3);
            soundedBefore = !before.length || before.some((f) => this.verify(f, freqs, ring).every((v) => v !== false));
            this._before.set(key, soundedBefore);
            if (this._before.size > 256) this._before.delete(this._before.keys().next().value);
          }
          if (soundedBefore) continue;
          tHit = Math.max(g.time - J.window, Math.min(tc, g.time));
        } else continue;
        this.emit(tHit, { notes: hitNotes, source: "microphone", via: on ? "onset" : "legato" });
      }
    }

    /** Rise test: the verified notes must not have decayed across the attack (>= 0.5 x the level just
     *  before it): a spurious onset on strings that were already ringing fails. 0.5 rather than ~1
     *  because fast palm-muted re-strikes of the same chord barely exceed the previous strike's level. */
    _rose(frame, on, pitched, verdict, ring) {
      if (!pitched.length || !this.lastActivation) return true;
      const after = this.lastActivation.slice();
      const before = this.frames.filter((f) => f.tc + 0.5 / f.res <= on.tc + 0.1 / f.res).pop();
      if (!before) return true;
      this.verify(before, pitched.map((c) => c.freq), ring);
      let a = 0, b = 0;
      verdict.forEach((v, k) => { if (v) { a += after[k]; b += this.lastActivation[k]; } });
      return a >= (this.opts.rise != null ? this.opts.rise : 0.5) * b;    // tuned: see tests/frontend/check_scoring.py
    }

    _onsetNear(t) {
      const w = this.judge.window;
      let best = null;
      for (const o of this.onsets) {
        if (o.used || o.expired || Math.abs(o.tc - t) > w) continue;
        if (!best || Math.abs(o.tc - t) < Math.abs(best.tc - t)) best = o;
      }
      return best;
    }
  }

  /** Analysis window (samples at 48 kHz): low notes (bass, low piano) need a longer one to resolve semitones. */
  function analysisWindow(chart) {
    if (!chart) return 8192;
    if (!chart.lanes) return chart.nStrings === 4 ? 16384 : 8192;          // bass / guitar (tuned: check_scoring.py)
    return chart.lowestMidi < 34 ? 16384 : 8192;                          // below Bb1: as for bass
  }
  NS.analysisWindow = analysisWindow;

  // ---- the input source ------------------------------------------------------------------
  /**
   * ctx (from the controller): { bus, judge, chart, chartTime(perfMs), options, onLevel, onDevices,
   *                              onOnsetRaw(perfMs), onError(err) }
   * options: { deviceId, echoCancellation, sensitivity, latencyMs }
   */
  class MicSource {
    constructor(ctx) {
      this.ctx = ctx;
      this.opts = Object.assign({ sensitivity: 1, latencyMs: null }, ctx.options || {});
      if (this.opts.latencyMs == null) this.opts.latencyMs = this._remembered();   // calibrated last time
    }
    _storeKey() { return "rs-input-latency:" + (this.opts.deviceId || "default"); }
    _remembered() {
      try { const v = root.localStorage.getItem(this._storeKey()); return v == null ? null : +v; } catch (e) { return null; }
    }

    async start() {
      const o = this.opts, c = this.ctx;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
          deviceId: o.deviceId ? { exact: o.deviceId } : undefined,
          echoCancellation: !!o.echoCancellation, noiseSuppression: false, autoGainControl: false } });
        if (this._stopped) return this.stop();                           // switched off meanwhile
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ac = new AC({ latencyHint: "interactive" });
        // (capture permission normally lets the context start; otherwise Play resumes it)
        if (this.ac.state !== "running") await Promise.race([this.ac.resume(), new Promise((r) => setTimeout(r, 500))]);
        await this.ac.audioWorklet.addModule(WORKLET_URL);
        if (this._stopped) return this.stop();
        this.node = new AudioWorkletNode(this.ac, "rs-guitar-analyzer", { processorOptions: {
          window: analysisWindow(c.chart), sensitivity: o.sensitivity } });
        const sink = this.ac.createGain(); sink.gain.value = 0;            // keeps the node pulled, silently
        this.src = this.ac.createMediaStreamSource(this.stream);
        this.src.connect(this.node).connect(sink).connect(this.ac.destination);
        this.verifier = new NoteVerifier(c.judge, (tc, ev) => c.bus.hit(Object.assign({ chartTime: tc }, ev)));
        this.verifier.setSensitivity(o.sensitivity);
        this.node.port.onmessage = (e) => this._message(e.data);
        // default latency estimate until calibrated: input path ~ device + context buffering
        const tr = this.stream.getAudioTracks()[0], st = tr && tr.getSettings ? tr.getSettings() : {};
        this.trackLabel = tr ? tr.label : "";
        this.estimatedLatencyMs = Math.round(1000 * ((st.latency || 0.01) + (this.ac.baseLatency || 0.01) + (this.ac.outputLatency || 0)));
        const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput")
          .map((d) => ({ id: d.deviceId, label: d.label || "Input device" }));
        if (c.onDevices) c.onDevices(devices, st.deviceId || o.deviceId || (devices[0] && devices[0].id), this.estimatedLatencyMs);
      } catch (err) {
        if (c.onError) c.onError(err);
        this.stop();
        throw err;
      }
    }

    /** Resume a context the autoplay policy kept suspended (called on Play). */
    resume() { if (this.ac && this.ac.state === "suspended") this.ac.resume(); }

    stop() {
      this._stopped = true;
      try { if (this.src) this.src.disconnect(); } catch (e) { /* already */ }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ac) this.ac.close();
      this.src = this.node = this.stream = this.ac = null;
    }

    setOptions(o) {
      o = Object.assign({}, o);
      if (o.latencyMs == null) delete o.latencyMs;                       // null = keep the current value
      Object.assign(this.opts, o);
      if (o.latencyMs != null) { try { root.localStorage.setItem(this._storeKey(), String(Math.round(+o.latencyMs))); } catch (e) { /* private mode */ } }
      if (o.sensitivity != null && this.node) { this.node.port.postMessage({ sensitivity: +o.sensitivity }); this.verifier.setSensitivity(+o.sensitivity); }
    }

    latencyMs() { return this.opts.latencyMs != null ? +this.opts.latencyMs : this.estimatedLatencyMs || 0; }

    /** Context time of the analyser -> performance.now() ms at which that sound was captured. */
    _perfOf(t) {
      const ac = this.ac, ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
      const perf = ts && ts.performanceTime > 0 ? ts.performanceTime + (t - ts.contextTime) * 1000
        : performance.now() + (t - ac.currentTime + (ac.baseLatency || 0) + (ac.outputLatency || 0)) * 1000;
      return perf - this.latencyMs();
    }

    _message(m) {
      const c = this.ctx;
      if (m.type === "level") { if (c.onLevel) c.onLevel(m.rms, m.peak); return; }
      if (!this.ac) return;
      const perf = this._perfOf(m.t);
      if (m.type === "onset") {
        if (c.onOnsetRaw) c.onOnsetRaw(perf + this.latencyMs());            // uncorrected, for calibration
        this.verifier.onOnset(c.chartTime(perf), m.strength);
      } else if (m.type === "frame") {
        this.verifier.onFrame(c.chartTime(perf), m.mag, m.n, m.sr, m.rms, m.win);
      }
    }
  }

  NS.NoteVerifier = NoteVerifier;
  NS.MicSource = MicSource;
  NS.PITCH_WORKLET_URL = WORKLET_URL;
  NS.registerInputSource("microphone", (ctx) => new MicSource(ctx));
})(window);
