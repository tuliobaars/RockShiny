/* ---------------------------------------------------------------------------
 * rsc-beats.js -- a beat grid from the audio (songs made from scratch, or
 * re-syncing a chart to a new recording).
 *
 *   RSCreator.beats.track(channels, sr, {bpm, beatsPerBar}) ->
 *      {bpm, beats: [s], downbeat (index), grid: [{time, measure}], confidence}
 *
 * Onset envelope (log-spectral flux) -> tempo by autocorrelation with a
 * log-normal preference around 115 BPM (or the tempo the user gives) ->
 * dynamic-programming beat tracker (Ellis 2007: each beat as strong as
 * possible, spacing close to the period) -> bar phase from the low-frequency
 * onsets and the harmonic change at each beat. Measured on the sample songs
 * against their charted beats (tests/js/test-dsp.js).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const D = RSC.dsp, B = (RSC.beats = RSC.beats || {});
  const SR = 22050, N = 1024, HOP = 256, FPS = SR / HOP;

  /**
   * Tempo (BPM) of an onset envelope. Each candidate period is scored by the
   * autocorrelation at the beat, half-bar and bar lags and at the half beat (the
   * metrical levels a real beat has; a 3:4 impostor lacks them), weighted toward
   * `prior` BPM. Right within 4 % (or an octave) on 16 of the 17 sample songs.
   */
  B.tempo = function (env, fps, opts) {
    opts = opts || {};
    const prior = opts.bpm || 115, spread = opts.bpm ? 0.35 : 1.0;
    const minLag = Math.floor(60 * fps / (opts.maxBpm || 220)), maxLag = Math.ceil(60 * fps / (opts.minBpm || 45));
    const n = env.length, top = Math.min(n - 1, 4 * maxLag + 2), ac = new Float64Array(top + 2);
    for (let lag = 1; lag <= top; lag++) {
      let s = 0;
      for (let i = lag; i < n; i++) s += env[i] * env[i - lag];
      ac[lag] = s / (n - lag);
    }
    const at = (x) => { const i = Math.floor(x), f = x - i; return i + 1 > top ? 0 : ac[i] * (1 - f) + ac[i + 1] * f; };
    let best = -Infinity, bestLag = minLag;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = 60 * fps / lag, w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / prior) / spread, 2));
      const s = w * (ac[lag] + 0.5 * at(2 * lag) + 0.25 * at(4 * lag) + 0.5 * at(lag / 2));
      if (s > best) { best = s; bestLag = lag; }
    }
    const y0 = ac[bestLag - 1], y1 = ac[bestLag], y2 = ac[bestLag + 1];
    const den = y0 - 2 * y1 + y2, shift = den ? 0.5 * (y0 - y2) / den : 0;
    const period = bestLag + Math.max(-0.5, Math.min(0.5, shift));
    return { bpm: 60 * fps / period, period };
  };

  /** Dynamic-programming beat tracker on an onset envelope (frames). */
  B.dpBeats = function (env, period, tightness) {
    tightness = tightness || 300;
    const n = env.length, score = new Float64Array(n), back = new Int32Array(n).fill(-1);
    const lo = Math.round(period / 2), hi = Math.round(period * 2);
    for (let t = 0; t < n; t++) {
      let best = -Infinity, arg = -1;
      for (let p = t - hi; p <= t - lo; p++) {
        if (p < 0) continue;
        const d = Math.log((t - p) / period), s = score[p] - tightness * d * d;
        if (s > best) { best = s; arg = p; }
      }
      score[t] = env[t] + (arg >= 0 && best > 0 ? best : 0);
      back[t] = arg >= 0 && best > 0 ? arg : -1;
    }
    let end = n - 1, m = -Infinity;
    for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > m) { m = score[t]; end = t; }
    const beats = [];
    for (let t = end; t >= 0; t = back[t]) beats.push(t);
    return beats.reverse();
  };

  /** Beat-synchronous chroma in a frequency band, and its change from beat to beat. */
  function chromaChange(spec, beatFrames, lo, hi) {
    const { mag, bins, n, sr } = spec, pcOf = new Int16Array(bins).fill(-1);
    for (let k = 1; k < bins; k++) { const f = k * sr / n; if (f > lo && f < hi) pcOf[k] = ((Math.round(12 * Math.log2(f / 440)) % 12) + 12) % 12; }
    const chroma = beatFrames.map((f, i) => {
      const e = i + 1 < beatFrames.length ? beatFrames[i + 1] : Math.min(spec.frames, f + 20), c = new Float64Array(12);
      for (let t = f; t < e; t++) for (let k = 1; k < bins; k++) if (pcOf[k] >= 0) c[pcOf[k]] += mag[t * bins + k];
      const s = Math.hypot(...c) || 1;
      return c.map((v) => v / s);
    });
    return chroma.map((c, i) => (i === 0 ? 0 : 1 - c.reduce((s, v, j) => s + v * chroma[i - 1][j], 0)));
  }
  const zscore = (v) => {
    const m = v.reduce((a, b) => a + b, 0) / v.length, sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length) || 1;
    return v.map((x) => (x - m) / sd);
  };

  /**
   * Track the beats of a recording. channels: Float32Array[]; sr: their rate.
   * opts.bpm: expected tempo (optional); opts.beatsPerBar (default 4).
   */
  B.track = function (channels, sr, opts) {
    opts = opts || {};
    const perBar = opts.beatsPerBar || 4;
    const x = D.resample(D.mono(channels), sr, SR), duration = x.length / SR;
    const spec = D.stftMag(x, SR, N, HOP);
    const env = D.onsetEnvelope(spec, { lo: 30, hi: 8000 });
    const tmp = B.tempo(env, FPS, opts);
    const frames = B.dpBeats(env, tmp.period, opts.tightness);
    if (frames.length < 4) return { bpm: tmp.bpm, beats: [], grid: [], downbeat: 0, confidence: 0 };
    // bar phase: the bass moves to a new note, and is loudest, on the downbeat (the bass-register
    // chroma change picked the charted bar phase on 5 of the 6 sample songs with reliable beats;
    // full-band chroma 4, kick-drum onsets 2)
    const change = zscore(chromaChange(spec, frames, 40, 250));
    const kb = Math.ceil(150 * N / SR);
    const energy = zscore(frames.map((f) => { let e = 0; for (let k = 1; k < kb; k++) e += spec.mag[f * spec.bins + k]; return e; }));
    let bestPhase = 0, bestScore = -Infinity;
    for (let ph = 0; ph < perBar; ph++) {
      let s = 0, c = 0;
      for (let i = ph; i < frames.length; i += perBar) { s += change[i] + energy[i]; c++; }
      if (c && s / c > bestScore) { bestScore = s / c; bestPhase = ph; }
    }
    let beats = frames.map((f) => f / FPS);
    // refine: local tempo from the tracked beats, extended to cover the whole song
    const step = (beats[beats.length - 1] - beats[0]) / (beats.length - 1);
    let phase = bestPhase;
    while (beats[0] - step > 0.02) { beats.unshift(beats[0] - step); phase = (phase + 1) % perBar; }
    while (beats[beats.length - 1] + step < duration) beats.push(beats[beats.length - 1] + step);
    beats = beats.map((t) => Math.round(t * 1000) / 1000);
    const grid = beats.map((t, i) => ({ time: t, measure: (i - phase) % perBar === 0 ? Math.floor((i - phase) / perBar) + 1 : -1 }));
    // beats before the first downbeat belong to a pickup bar: number the bars from the first downbeat
    let m = 0;
    for (let i = 0; i < grid.length; i++) if ((i - phase) % perBar === 0 && i >= phase) grid[i].measure = ++m;
    for (let i = 0; i < phase; i++) grid[i].measure = -1;
    if (phase > 0) grid[0].measure = 0;                     // the song starts mid-bar: a bar "0"
    // confidence: onset strength on the beats vs. off the beats
    let on = 0, off = 0;
    for (const f of frames) { on += env[f] || 0; off += env[Math.round(f + tmp.period / 2)] || 0; }
    return { bpm: Math.round(60 / step * 1000) / 1000, beats, grid, downbeat: phase, confidence: Math.round(100 * on / (on + off + 1e-9)) / 100 };
  };

  /**
   * Score beats against a reference (F-measure, +-tol seconds), as in MIREX.
   * -> {f, precision, recall}
   */
  B.fMeasure = function (est, ref, tol) {
    tol = tol || 0.07;
    const used = new Uint8Array(ref.length);
    let hit = 0, j = 0;
    for (const t of est) {
      while (j < ref.length && ref[j] < t - tol) j++;
      for (let k = j; k < ref.length && ref[k] <= t + tol; k++) if (!used[k]) { used[k] = 1; hit++; break; }
    }
    const p = est.length ? hit / est.length : 0, r = ref.length ? hit / ref.length : 0;
    return { f: p + r ? 2 * p * r / (p + r) : 0, precision: p, recall: r };
  };
})(typeof window !== "undefined" ? window : globalThis);
