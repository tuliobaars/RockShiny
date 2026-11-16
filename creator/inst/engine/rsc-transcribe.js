/* ---------------------------------------------------------------------------
 * rsc-transcribe.js -- notes and chords by ear: the tuner's pitch and chord
 * detection, and drafts of the rhythm and bass charts from a recording.
 *
 * The tuner (a clean instrument, studio/rsc-fill.js):
 *   T.yin(frame, sr)               -> {hz, clarity}       one note (YIN)
 *   T.chromaOf(mag, sr, n)         -> 12 pitch classes    of a magnitude spectrum
 *   T.rawChromaOf(mag, sr, n)      -> 12 pitch classes (harmonics included)
 *   T.matchChord(chroma, {harmonic}) -> {root, quality, name, score}; harmonic: templates
 *                                  that expect a strummed guitar's harmonics (the tuner)
 * Onto the fretboard:
 *   T.placeNotes(midis, tuning, strings, opts) -> [{string, fret}] (least hand movement)
 *   T.chordShape(root, quality, tuning, opts)  -> frets (-1 = not played)
 * Drafts from a recording (a full mix: rough, to correct by hand):
 *   T.analyse(channels, sr)        -> chroma (100 frames/s), bass salience, tuning
 *   T.chordsOnBeats(an, beats)     -> [{time, root, quality, name}] one per beat
 *                                     (templates + Viterbi smoothing)
 *   T.bassFromChords(an, chords)   -> [{time, midi, sustain}]  the chord roots,
 *                                     in the octave the bass is heard in
 * Measured on the sample songs against their own charts (creator/tools/ear/
 * eval_drafts.js): the chord root right on 51 % of the rhythm charts' chords
 * (0.17-0.86 by song, 10 songs); the bass draft scores an F-measure of 0.21
 * against the bass charts (onsets within 0.1 s, the same note; 0.31 in any
 * octave). A lead line cannot be told out of a full mix this way (F 0.05), so
 * lead is filled with the tuner.
 * ------------------------------------------------------------------------- */
(function (factory) {
  const root = typeof window !== "undefined" ? window : globalThis;
  factory(root);
  (root.RSCreator.factories = root.RSCreator.factories || {}).transcribe = factory;
})(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const T = (RSC.transcribe = RSC.transcribe || {});
  const PC = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  T.PC = PC;
  const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const midiOf = (hz) => 69 + 12 * Math.log2(hz / 440);
  T.noteName = (m) => PC[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  const STANDARD = [40, 45, 50, 55, 59, 64];

  // ---- one note: YIN ------------------------------------------------------------------------------------
  /**
   * Fundamental frequency of a frame (YIN with parabolic interpolation).
   * -> {hz (0 when none), clarity (1 - the YIN dip, 0..1), rms}
   */
  T.yin = function (x, sr, opts) {
    opts = opts || {};
    const n = x.length, W = n >> 1, minHz = opts.minHz || 38, maxHz = opts.maxHz || 1400, thr = opts.threshold || 0.15;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / n);
    const tauMin = Math.max(2, Math.floor(sr / maxHz)), tauMax = Math.min(W - 1, Math.ceil(sr / minHz));
    const d = new Float32Array(tauMax + 1);
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const v = x[i] - x[i + tau]; s += v * v; }
      d[tau] = s;
    }
    let run = 0, best = -1;
    const cm = new Float32Array(tauMax + 1);
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) { run += d[tau]; cm[tau] = run ? d[tau] * tau / run : 1; }
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cm[tau] < thr) { while (tau + 1 <= tauMax && cm[tau + 1] < cm[tau]) tau++; best = tau; break; }
    }
    if (best < 0) {                                   // no dip under the threshold: the deepest one, if clear enough
      let m = 1;
      for (let tau = tauMin; tau <= tauMax; tau++) if (cm[tau] < m) { m = cm[tau]; best = tau; }
      if (m > 0.35) return { hz: 0, clarity: 1 - m, rms };
    }
    let t = best;
    if (best > 1 && best < tauMax) {
      const a = cm[best - 1], b = cm[best], c = cm[best + 1], den = a - 2 * b + c;
      if (den) t = best + 0.5 * (a - c) / den;
    }
    return { hz: sr / t, clarity: 1 - cm[best], rms };
  };
  T.midiOf = midiOf;

  // ---- chords -----------------------------------------------------------------------------------------------
  const QUALITIES = [["maj", [0, 4, 7], ""], ["min", [0, 3, 7], "m"], ["5", [0, 7], "5"], ["7", [0, 4, 7, 10], "7"], ["m7", [0, 3, 7, 10], "m7"]];
  function templates(kinds) {
    const out = [];
    for (let r = 0; r < 12; r++) {
      for (const [q, iv, suffix] of QUALITIES) {
        if (!kinds.includes(q)) continue;
        const t = new Float64Array(12);
        for (const i of iv) t[(r + i) % 12] = 1;
        t[r] += 0.5;
        let nrm = 0;
        for (const v of t) nrm += v * v;
        nrm = Math.sqrt(nrm);
        for (let i = 0; i < 12; i++) t[i] /= nrm;
        out.push({ root: r, quality: q, name: PC[r] + suffix, t });
      }
    }
    return out;
  }
  /**
   * Templates that sound like a strummed guitar chord: each chord tone with its
   * first six harmonics (1/h), so the harmonics of a chord (a B over an E, a G#
   * over a low E) are expected instead of read as notes.
   */
  function harmonicTemplates(kinds) {
    const out = [];
    for (let r = 0; r < 12; r++) {
      for (const [q, iv, suffix] of QUALITIES) {
        if (!kinds.includes(q)) continue;
        const t = new Float64Array(12);
        // a voicing: the root low, then the tones above it, the root again (guitar-like)
        const low = 36 + r, notes = [low, low + iv[iv.length > 2 ? 2 : 1]].concat(iv.map((i) => low + 12 + i));
        for (const m of notes) for (let h = 1; h <= 6; h++) t[Math.round(m + 12 * Math.log2(h)) % 12] += 1 / h;
        let nrm = 0;
        for (const v of t) nrm += v * v;
        nrm = Math.sqrt(nrm);
        for (let i = 0; i < 12; i++) t[i] /= nrm;
        out.push({ root: r, quality: q, name: PC[r] + suffix, t });
      }
    }
    return out;
  }
  const TPL = templates(["maj", "min", "5"]), TPL_TUNER = templates(["maj", "min", "5", "7", "m7"]);
  const TPL_HARM = harmonicTemplates(["maj", "min", "5"]);
  T.harmonicTemplates = TPL_HARM;
  T.templates = TPL;
  /** Power chords (two notes) match melodies too easily: their score is scaled down by this. */
  T.FIVE_PENALTY = 0.85;

  /**
   * Pitch classes of a magnitude spectrum (n-point FFT at sr): C2..B5, linear
   * interpolation; tuning in semitones. Harmonics are told apart from notes: the
   * level at each semitone is lowered by what the notes an octave (2nd harmonic)
   * and an octave and a fifth (3rd harmonic) below it would put there, so a
   * ringing B does not read as a B and an F#.
   */
  T.chromaOf = function (mag, sr, n, tuning) {
    const c = new Float64Array(12), B = mag.length, lv = new Float64Array(96);
    for (let m = 28; m < 96; m++) {
      const k = hzOf(m + (tuning || 0)) * n / sr, k0 = Math.floor(k), a = k - k0;
      if (k0 + 1 >= B) break;
      lv[m] = (1 - a) * mag[k0] + a * mag[k0 + 1];
    }
    for (let m = 36; m < 84; m++) {
      const v = lv[m] - 0.5 * lv[m - 12] - 0.45 * lv[m - 19] - 0.3 * (m >= 28 + 28 ? lv[m - 28] : 0);
      if (v > 0) c[m % 12] += v;
    }
    return c;
  };
  /** Pitch classes of a magnitude spectrum as they are (harmonics included): for T.matchChord(c, {harmonic: true}). */
  T.rawChromaOf = function (mag, sr, n, tuning) {
    const c = new Float64Array(12), B = mag.length;
    for (let m = 36; m < 84; m++) {
      const k = hzOf(m + (tuning || 0)) * n / sr, k0 = Math.floor(k), a = k - k0;
      if (k0 + 1 >= B) break;
      c[m % 12] += (1 - a) * mag[k0] + a * mag[k0 + 1];
    }
    return c;
  };
  /**
   * The chord of a clean instrument's spectrum (the tuner): the plain templates on
   * the harmonics-lowered chroma and the harmonic templates on the raw chroma,
   * scored together (each alone misreads some strums). -> {root, quality, name, score}
   */
  T.chordOfSpectrum = function (mag, sr, n, tuning) {
    const a = T.rawChromaOf(mag, sr, n, tuning), s = T.chromaOf(mag, sr, n, tuning);
    const nr = (c) => { let z = 0; for (const v of c) z += v * v; return Math.sqrt(z) || 1; }, na = nr(a), ns = nr(s);
    let best = null;
    TPL_HARM.forEach((th, i) => {
      const tp = TPL[i];
      let s1 = 0, s2 = 0;
      for (let k = 0; k < 12; k++) { s1 += th.t[k] * a[k] / na; s2 += tp.t[k] * s[k] / ns; }
      let sc = 0.5 * (s1 + s2);
      if (th.quality === "5") sc *= T.FIVE_PENALTY;
      if (!best || sc > best.score) best = { root: th.root, quality: th.quality, name: th.name, score: sc };
    });
    return best;
  };
  /** The chord a chroma vector sounds most like. -> {root, quality, name, score (cosine)} */
  T.matchChord = function (chroma, opts) {
    const tp = opts && opts.harmonic ? TPL_HARM : opts && opts.sevenths ? TPL_TUNER : TPL;
    let nrm = 0;
    for (const v of chroma) nrm += v * v;
    nrm = Math.sqrt(nrm) || 1;
    let best = null;
    for (const t of tp) {
      let s = 0;
      for (let i = 0; i < 12; i++) s += t.t[i] * chroma[i] / nrm;
      if (t.quality === "5") s *= T.FIVE_PENALTY;
      if (!best || s > best.score) best = { root: t.root, quality: t.quality, name: t.name, score: s };
    }
    return best;
  };

  // ---- a recording: chroma and bass salience (100 frames/s at 11.025 kHz) -----------------------------------------
  /**
   * The analysis the drafts use. channels [L, R] at sr. -> {chroma (Float32Array F*12),
   * bass (F*24: salience of MIDI 28..51), frames, tuning (semitones)}
   */
  T.analyse = async function (channels, sr, opts) {
    opts = opts || {};
    const D = RSC.dsp, V = RSC.voice, tick = () => new Promise((r) => setTimeout(r, 0));
    let mono = D.mono(channels);
    if (opts.side && channels.length > 1) { const L = channels[0], R = channels[1]; mono = new Float32Array(L.length); for (let i = 0; i < L.length; i++) mono[i] = 0.5 * (L[i] - R[i]); }
    const x = V.toAnalysisRate(mono, sr, 11025), SR = 11025, N = 4096, HOP = Math.round(SR / 100);
    if (opts.onProgress) opts.onProgress(0.15);
    await tick();
    const spec = D.stftMag(x, SR, N, HOP, { maxBin: Math.ceil(1100 * N / SR) + 2 }), F = spec.frames, B = spec.bins, mag = spec.mag;
    if (opts.onProgress) opts.onProgress(0.6);
    await tick();
    const at = (f, hz) => { const k = hz * N / SR, k0 = Math.floor(k), a = k - k0; return k0 + 1 < B ? (1 - a) * mag[f * B + k0] + a * mag[f * B + k0 + 1] : 0; };
    // tuning: the offset (-50..+50 cents) whose semitone grid holds the most energy
    let tuning = 0, bestE = -1;
    for (let c = -50; c <= 50; c += 5) {
      let e = 0;
      for (let f = 0; f < F; f += 10) for (let m = 40; m < 84; m++) e += at(f, hzOf(m + c / 100));
      if (e > bestE) { bestE = e; tuning = c / 100; }
    }
    const chroma = new Float32Array(F * 12), bass = new Float32Array(F * 24), hw = [1, 0.9, 0.8, 0.6, 0.5, 0.4];
    for (let f = 0; f < F; f++) {
      for (let m = 36; m < 84; m++) chroma[f * 12 + (m % 12)] += at(f, hzOf(m + tuning));
      for (let j = 0; j < 24; j++) {
        const f0 = hzOf(28 + j + tuning);
        let odd = 0, even = 0;
        for (let h = 1; h <= 6; h++) { const v = hw[h - 1] * at(f, f0 * h); if (h % 2) odd += v; else even += v; }
        bass[f * 24 + j] = (odd + even) * Math.min(1, 1.5 * odd / (even + 1e-9));
      }
    }
    if (opts.onProgress) opts.onProgress(1);
    return { chroma, bass, frames: F, tuning };
  };

  /**
   * A chord on every beat: the median chroma of the beat against major / minor /
   * power-chord templates, smoothed along the song (Viterbi; staying on a chord is
   * favoured by `stay`). -> [{time, end, root, quality, name, score}]
   */
  T.chordsOnBeats = function (an, beats, opts) {
    opts = opts || {};
    const stay = opts.stay != null ? opts.stay : 0.1, F = an.frames, B = beats.map((b) => b.time).sort((a, b) => a - b);
    const rows = [], times = [];
    const col = new Float32Array(Math.max(1, F));
    for (let i = 0; i + 1 < B.length; i++) {
      const fa = Math.max(0, Math.floor(B[i] * 100)), fb = Math.min(F, Math.max(fa + 1, Math.floor(B[i + 1] * 100)));
      if (fa >= F) break;
      const c = new Float64Array(12);
      for (let p = 0; p < 12; p++) {
        let n = 0;
        for (let f = fa; f < fb; f++) col[n++] = an.chroma[f * 12 + p];
        const s = col.subarray(0, n).sort();
        c[p] = n ? s[n >> 1] : 0;
      }
      rows.push(c); times.push([B[i], B[i + 1]]);
    }
    if (!rows.length) return [];
    const five = opts.fivePenalty != null ? opts.fivePenalty : T.FIVE_PENALTY, tpl = opts.harmonic ? TPL_HARM : TPL;
    const K = tpl.length, S = rows.map((c) => {
      let nrm = 0;
      for (const v of c) nrm += v * v;
      nrm = Math.sqrt(nrm) || 1;
      return tpl.map((t) => { let s = 0; for (let i = 0; i < 12; i++) s += t.t[i] * c[i] / nrm; return t.quality === "5" ? s * five : s; });
    });
    let dp = S[0].slice();
    const back = [];
    for (let i = 1; i < S.length; i++) {
      const nd = new Array(K), bk = new Int32Array(K);
      let bestPrev = 0;
      for (let k = 1; k < K; k++) if (dp[k] > dp[bestPrev]) bestPrev = k;
      for (let k = 0; k < K; k++) {
        const viaSelf = dp[k] + stay;
        if (viaSelf >= dp[bestPrev]) { nd[k] = viaSelf + S[i][k]; bk[k] = k; } else { nd[k] = dp[bestPrev] + S[i][k]; bk[k] = bestPrev; }
      }
      dp = nd; back.push(bk);
    }
    let k = 0;
    for (let j = 1; j < K; j++) if (dp[j] > dp[k]) k = j;
    const path = new Array(S.length);
    for (let i = S.length - 1; i >= 0; i--) { path[i] = k; if (i > 0) k = back[i - 1][k]; }
    return path.map((k, i) => ({ time: times[i][0], end: times[i][1], root: tpl[k].root, quality: tpl[k].quality, name: tpl[k].name, score: S[i][k] }));
  };

  /** The bass draft: each beat's chord root, in the octave (E1..D#3) the bass sounds in there. */
  T.bassFromChords = function (an, chords) {
    const out = [];
    for (const c of chords) {
      const f = Math.min(an.frames - 1, Math.round(c.time * 100) + 10);
      let best = -1, m = 28 + ((c.root - 28 % 12 + 12) % 12);
      for (let j = 0; j < 24; j++) if ((28 + j) % 12 === c.root && an.bass[f * 24 + j] > best) { best = an.bass[f * 24 + j]; m = 28 + j; }
      out.push({ time: c.time, midi: m, sustain: Math.max(0, (c.end - c.time) * 0.85) });
    }
    return out;
  };

  // ---- onto the fretboard ----------------------------------------------------------------------------------
  /** Open-string MIDI notes of a chart (tuning offsets from E standard, bass an octave down, capo). */
  T.openStrings = function (tuning, strings, bass, capo) {
    const out = [];
    for (let s = 0; s < strings; s++) out.push(STANDARD[s] + (tuning[s] || 0) - (bass ? 12 : 0) + (capo || 0));
    return out;
  };
  /**
   * Strings and frets for a line of notes: every note where it can be played
   * (fret 0..maxFret), the path with the least hand movement (dynamic programming;
   * high frets cost a little, open strings are free). -> [{string, fret}]
   */
  T.placeNotes = function (midis, open, opts) {
    opts = opts || {};
    const maxFret = opts.maxFret || 17, home = opts.home != null ? opts.home : 3;
    const cands = midis.map((m) => {
      const c = [];
      open.forEach((o, s) => { const f = Math.round(m) - o; if (f >= 0 && f <= maxFret) c.push({ string: s, fret: f }); });
      return c.length ? c : [{ string: 0, fret: Math.max(0, Math.min(maxFret, Math.round(m) - open[0])) }];
    });
    if (!cands.length) return [];
    const pos = (c) => (c.fret === 0 ? null : c.fret);
    let cost = cands[0].map((c) => 0.05 * Math.abs((pos(c) || home) - home));
    const back = [];
    for (let i = 1; i < cands.length; i++) {
      const nc = [], bk = [];
      for (const c of cands[i]) {
        let bv = Infinity, bi = 0;
        cands[i - 1].forEach((p, j) => {
          const a = pos(p), b = pos(c), move = a == null || b == null ? 0.5 : Math.abs(a - b);
          const v = cost[j] + move + 0.02 * c.fret + (p.string === c.string && a != null && b != null ? 0 : 0.1);
          if (v < bv) { bv = v; bi = j; }
        });
        nc.push(bv); bk.push(bi);
      }
      cost = nc; back.push(bk);
    }
    let j = 0;
    cost.forEach((v, i) => { if (v < cost[j]) j = i; });
    const out = new Array(cands.length);
    for (let i = cands.length - 1; i >= 0; i--) { out[i] = cands[i][j]; if (i > 0) j = back[i - 1][j]; }
    return out;
  };

  /**
   * A playable shape for a chord on a 6-string chart (any tuning): the root on the
   * lowest string it fits (string 0 or 1, fret 0..12), the other strings on chord
   * tones within four frets of it (open strings allowed near the nut), strings below
   * the root muted; power chords: root, fifth, octave. Prefers low positions and the
   * third covered. -> frets (array, -1 = not played)
   */
  T.chordShape = function (root, quality, open, opts) {
    opts = opts || {};
    const iv = (QUALITIES.find((q) => q[0] === quality) || QUALITIES[0])[1], tones = new Set(iv.map((i) => (root + i) % 12));
    const n = open.length;
    let best = null;
    for (const s0 of [0, 1]) {
      if (s0 >= n) continue;
      for (let b = 0; b <= 12; b++) {
        const f0 = b, pc0 = (open[s0] + f0) % 12;
        if (pc0 !== root) continue;
        const frets = new Array(n).fill(-1);
        frets[s0] = f0;
        if (quality === "5") {
          const want = [(root + 7) % 12, root];
          for (let k = 0; k < 2 && s0 + 1 + k < n; k++) {
            const s = s0 + 1 + k;
            let f = -1;
            for (let d = 0; d <= 4; d++) { const fr = f0 + d - 1; if (fr >= 0 && (open[s] + fr) % 12 === want[k]) { f = fr; break; } }
            frets[s] = f;
          }
        } else {
          for (let s = s0 + 1; s < n; s++) {
            let f = -1;
            for (const fr of (f0 <= 3 ? [0, 1, 2, 3, 4] : [f0, f0 + 1, f0 + 2, f0 + 3])) {
              if (fr < 0 || fr > 15) continue;
              if (tones.has((open[s] + fr) % 12)) { f = fr; break; }
            }
            frets[s] = f;
          }
        }
        const used = frets.filter((f) => f >= 0), pcs = new Set(frets.map((f, s) => (f >= 0 ? (open[s] + f) % 12 : -1)).filter((v) => v >= 0));
        const covers = [...tones].filter((t) => pcs.has(t)).length;
        const span = Math.max(...used.filter((f) => f > 0), f0) - Math.min(...used.filter((f) => f > 0).concat([Math.max(1, f0)]));
        const score = covers * 3 + used.length * 0.5 - b * 0.25 - Math.max(0, span - 3) * 2 - s0 * 0.3;
        if (!best || score > best.score) best = { frets, score };
      }
    }
    return best ? best.frets : new Array(n).fill(-1);
  };
});
