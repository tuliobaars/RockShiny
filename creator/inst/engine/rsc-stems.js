/* ---------------------------------------------------------------------------
 * rsc-stems.js -- instrument stems from the song's own chart.
 *
 * A Rocksmith package knows what every guitar and bass note is, when it starts,
 * how long it rings, how it bends and slides -- and when the singer sings. The
 * separation uses that (score-informed source separation) on the stereo mix:
 *
 *   harmonic / percussive split   median filtering of the spectrogram (drums)
 *   chart templates               a harmonic comb at every charted note's pitch
 *                                 (tuning, capo, cent offset, bends, slides), for
 *                                 the guitar parts and the bass
 *   vocal prior                   lyric activity x centre of the stereo image x
 *                                 the voice band (and the sung pitch if charted)
 *   soft masks                    each time-frequency bin shared among the stems
 *                                 in proportion to their evidence; masks sum to
 *                                 one, so the stems add up to the mix exactly
 *
 *   const sep = RSCreator.stems.separate(channels, sr, guide, {onProgress})
 *   -> {stems: {vocals, guitar, bass, drums, other}: [Int16Array L, R], sr, ...}
 *   RSCreator.stems.guideFromProject(project) -> the chart information it uses
 *
 * It is signal processing, not a trained neural network: the stems are cleanest
 * where the chart is complete; parts nobody charted (keys, strings...) end up in
 * "other". Measured on synthetic mixes with known stems (tests/js/test-dsp.js).
 * ------------------------------------------------------------------------- */
(function (factory) {
  // registered as a factory too: the studio runs it again inside a Web Worker
  const root = typeof window !== "undefined" ? window : globalThis;
  factory(root);
  (root.RSCreator.factories = root.RSCreator.factories || {}).stems = factory;
})(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const D = RSC.dsp, ST = (RSC.stems = RSC.stems || {});
  const STANDARD = [40, 45, 50, 55, 59, 64];

  ST.STEMS = [
    { id: "vocals", label: "Vocals", color: "#f5a524" },
    { id: "guitar", label: "Guitar", color: "#1f9cf0" },
    { id: "bass", label: "Bass", color: "#b04ee6" },
    { id: "drums", label: "Drums", color: "#e8203a" },
    { id: "other", label: "Other", color: "#22c55e" }
  ];

  /**
   * The chart information the separation uses, from a Creator project:
   * {guitar: [{t0, t1, p0, p1, bend}], bass: [...], vocals: [...], lyrics: [[t0, t1]], centOffset}
   * p0 / p1: MIDI pitch at the start / end (slides), bend: [[t, semitones]] (absolute times).
   */
  ST.guideFromProject = function (project) {
    const g = { guitar: [], bass: [], vocals: [], lyrics: [] };
    for (const a of project.arrangements || []) {
      // the hardest chart (the view may show an easier difficulty level)
      const d = a.doc, bass = a.kind === "bass", out = bass ? g.bass : g.guitar;
      const lv = a.dd && a.dd.view != null && root.RSCreator.engine && root.RSCreator.engine.ddExtract ? root.RSCreator.engine.ddExtract(a.dd.levels, d, null) : d.levels[0];
      const cents = (d.centOffset || 0) / 100;
      const pitch = (s, f) => STANDARD[s] + (d.tuning[s] || 0) + f + (f === 0 && d.capo ? d.capo : 0) - (bass ? 12 : 0) + cents;
      const add = (n, t) => {
        if (n.fret < 0 || n.mute) return;
        const sus = n.sustain || 0;
        const p0 = pitch(n.string, n.fret);
        const to = n.slideTo >= 0 ? n.slideTo : n.slideUnpitchTo >= 0 ? n.slideUnpitchTo : n.fret;
        const bend = (n.bendValues || []).map((b) => [b.time, b.step]);
        if (!bend.length && n.bend > 0) bend.push([t + sus * 0.25, n.bend], [t + sus, n.bend]);
        out.push({ t0: t, t1: t + Math.max(sus, 0.25), sus, p0, p1: pitch(n.string, to), bend });
      };
      for (const n of lv.notes) add(n, n.time);
      for (const c of lv.chords) {
        const tp = d.chordTemplates[c.chordId];
        if (!tp) continue;
        const cn = c.chordNotes || [];
        for (let s = 0; s < 6; s++) {
          if (tp.frets[s] < 0) continue;
          const x = cn.find((q) => q.string === s) || { fret: tp.frets[s], string: s, sustain: Math.max(0, ...cn.map((q) => q.sustain || 0)), slideTo: -1, slideUnpitchTo: -1, bendValues: [] };
          add(Object.assign({}, x, { string: s, fret: tp.frets[s] }), c.time);
        }
      }
    }
    const v = (project.vocals && project.vocals.syllables) || [];
    for (const s of v) {
      g.lyrics.push([s.time, s.time + Math.max(0.1, s.length)]);
      if (s.note != null && s.note !== 254 && s.note > 30 && s.note < 100) g.vocals.push({ t0: s.time, t1: s.time + Math.max(0.1, s.length), sus: s.length, p0: s.note, p1: s.note, bend: [] });
    }
    return g;
  };

  /** Per-frame active pitches of a part: [{hz, a}] lists, frame f at f * hop / sr. */
  function activity(notes, frames, hop, sr, decay) {
    const act = Array.from({ length: frames }, () => []);
    for (const n of notes) {
      const f0 = Math.max(0, Math.floor((n.t0 - 0.03) * sr / hop)), end = n.t1 + 0.12;
      const f1 = Math.min(frames - 1, Math.ceil(end * sr / hop));
      for (let f = f0; f <= f1; f++) {
        const t = f * hop / sr, dt = Math.max(0, t - n.t0);
        let p = n.p0;
        if (n.p1 !== n.p0 && n.sus > 0) p = n.p0 + (n.p1 - n.p0) * Math.min(1, dt / n.sus);
        if (n.bend.length) {
          let b = 0;
          for (const [bt, st] of n.bend) if (bt <= t) b = st;
          p += b;
        }
        const a = Math.exp(-dt / decay) * (t > n.t1 ? Math.exp(-(t - n.t1) / 0.05) : 1);
        if (a > 0.02) act[f].push({ hz: D.midiToHz(p), a });
      }
    }
    return act;
  }

  /** Harmonic comb template (0..1) of the active pitches into out[0..bins). */
  function comb(list, out, bins, binHz, maxHz, rolloff) {
    out.fill(0);
    for (const { hz, a } of list) {
      for (let h = 1; h * hz < maxHz; h++) {
        const fc = h * hz / binHz, sig = Math.max(0.9, fc * 0.03), amp = a * Math.pow(h, -rolloff);
        const k0 = Math.max(1, Math.floor(fc - 3 * sig)), k1 = Math.min(bins - 1, Math.ceil(fc + 3 * sig));
        for (let k = k0; k <= k1; k++) { const x = (k - fc) / sig, v = amp * Math.exp(-0.5 * x * x); if (v > out[k]) out[k] = v; }
      }
    }
  }

  const band = (f, lo, hi, soft) => { const a = 1 / (1 + Math.pow(lo / Math.max(f, 1), soft)), b = 1 / (1 + Math.pow(f / hi, soft)); return a * b; };

  /**
   * Separate a stereo mix. channels: [L, R] Float32Array; guide: guideFromProject();
   * opts: {onProgress(f), range: [t0, t1] (s), stems: ids to keep (default all)}.
   * Returns a Promise (it yields to the event loop between chunks).
   */
  ST.separate = async function (channels, sr, guide, opts) {
    opts = opts || {};
    const L0 = channels[0], R0 = channels[1] || channels[0];
    const s0 = opts.range ? Math.max(0, Math.floor(opts.range[0] * sr)) : 0, s1 = opts.range ? Math.min(L0.length, Math.ceil(opts.range[1] * sr)) : L0.length;
    const L = L0.subarray(s0, s1), R = R0.subarray(s0, s1), n = L.length, tOff = s0 / sr;
    const N = sr > 30000 ? 4096 : 2048, hop = N / 4, bins = N / 2 + 1, binHz = sr / N;
    const frames = Math.floor(n / hop) + 1, C = 8, CH = 128, gamma = opts.gamma || 1;
    const hasGuitar = guide.guitar.length > 0, hasBass = guide.bass.length > 0, hasLyrics = guide.lyrics.length > 0;
    const ids = ST.STEMS.map((s) => s.id).filter((id) => id !== "guitar" || hasGuitar);
    const keep = new Set(opts.stems || ids);
    const shift = (notes) => notes.map((x) => Object.assign({}, x, { t0: x.t0 - tOff, t1: x.t1 - tOff, bend: x.bend.map(([t, b]) => [t - tOff, b]) }));
    const actG = activity(shift(guide.guitar), frames, hop, sr, 1.2), actB = activity(shift(guide.bass), frames, hop, sr, 1.5);
    const actV = activity(shift(guide.vocals), frames, hop, sr, 10);
    // lyric activity per frame (0..1), widened by 150 ms each side
    const lyr = new Float32Array(frames);
    for (const [a, b] of guide.lyrics) {
      const f0 = Math.max(0, Math.floor((a - tOff - 0.15) * sr / hop)), f1 = Math.min(frames - 1, Math.ceil((b - tOff + 0.15) * sr / hop));
      for (let f = f0; f <= f1; f++) lyr[f] = 1;
    }
    const lyrS = new Float32Array(frames);                 // smoothed (+-4 frames)
    for (let f = 0; f < frames; f++) { let s = 0, c = 0; for (let d = -4; d <= 4; d++) { const g = f + d; if (g >= 0 && g < frames) { s += lyr[g]; c++; } } lyrS[f] = s / c; }

    // static per-bin weights
    const bandV = new Float32Array(bins), bandG = new Float32Array(bins), bandB = new Float32Array(bins), lowB = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const f = k * binHz;
      bandV[k] = band(f, 140, 7000, 4); bandG[k] = band(f, 75, 9000, 3); bandB[k] = band(f, 28, 1800, 3); lowB[k] = band(f, 25, 220, 6);
    }
    const win = D.hann(N), fft = D.makeFFT(N);
    const outs = {};
    for (const id of ids) if (keep.has(id)) outs[id] = [new Float32Array(n + N), new Float32Array(n + N)];
    const wsum = new Float32Array(n);                      // sum of the squared windows (1.5 inside, less at the edges)
    const tG = new Float32Array(bins), tB = new Float32Array(bins), tV = new Float32Array(bins);
    const reA = new Float64Array(N), imA = new Float64Array(N), reB = new Float64Array(N), imB = new Float64Array(N);

    for (let c0 = 0; c0 < frames; c0 += CH) {
      const c1 = Math.min(frames, c0 + CH), a0 = Math.max(0, c0 - C), a1 = Math.min(frames, c1 + C), m = a1 - a0;
      // spectra of the chunk (+ context): L and R at once (L + iR, separated by symmetry)
      const XL = new Float32Array(m * bins * 2), XR = new Float32Array(m * bins * 2), X = new Float32Array(m * bins);
      for (let j = 0; j < m; j++) {
        const o = (a0 + j) * hop - N / 2;
        for (let i = 0; i < N; i++) { const p = o + i, w = win[i]; reA[i] = p >= 0 && p < n ? L[p] * w : 0; imA[i] = p >= 0 && p < n ? R[p] * w : 0; }
        fft(reA, imA);
        for (let k = 0; k < bins; k++) {
          const nk = (N - k) & (N - 1);
          const lr = 0.5 * (reA[k] + reA[nk]), li = 0.5 * (imA[k] - imA[nk]), rr = 0.5 * (imA[k] + imA[nk]), ri = -0.5 * (reA[k] - reA[nk]);
          const q = (j * bins + k) * 2;
          XL[q] = lr; XL[q + 1] = li; XR[q] = rr; XR[q + 1] = ri;
          X[j * bins + k] = Math.sqrt(0.5 * (lr * lr + li * li + rr * rr + ri * ri));
        }
      }
      // harmonic (median over 17 frames) / percussive (median over 17 bins)
      const H = new Float32Array(m * bins), P = new Float32Array(m * bins);
      for (let k = 0; k < bins; k++) D.slidingMedian(X, m, 17, H, k, bins, k, bins);
      for (let j = 0; j < m; j++) D.slidingMedian(X, bins, 17, P, j * bins, 1, j * bins, 1);
      for (let f = c0; f < c1; f++) {
        const j = f - a0;
        comb(actG[f], tG, bins, binHz, 7000, 0.6); comb(actB[f], tB, bins, binHz, 2500, 0.8); comb(actV[f], tV, bins, binHz, 6000, 0.7);
        const ly = hasLyrics ? lyrS[f] : 0.25;
        // mask the spectrum for each stem, then invert two stems per complex FFT
        const masks = {};
        for (const id of ids) masks[id] = new Float32Array(bins);
        for (let k = 0; k < bins; k++) {
          const h = H[j * bins + k], p = P[j * bins + k], mh = (h * h) / (h * h + p * p + 1e-18), mp = 1 - mh;
          const q = (j * bins + k) * 2, lr = XL[q], li = XL[q + 1], rr = XR[q], ri = XR[q + 1];
          const e = lr * lr + li * li + rr * rr + ri * ri + 1e-18, sr2 = (lr + rr) * (lr + rr) + (li + ri) * (li + ri);
          const centre = sr2 / (2 * e), c3 = centre * centre * centre;
          const wv = ly * bandV[k] * c3 * (0.35 + 2 * Math.min(1, tV[k])) + 1e-6;
          const wg = hasGuitar ? bandG[k] * (0.06 + 1.6 * Math.min(1, tG[k])) : 0;
          const wb = lowB[k] * (hasBass ? 0.35 : 0.6) + bandB[k] * 1.6 * Math.min(1, tB[k]);
          let pv = wv, pg = wg, pb = wb, po = 0.22;
          if (gamma !== 1) { pv = Math.pow(pv, gamma); pg = Math.pow(pg, gamma); pb = Math.pow(pb, gamma); po = Math.pow(po, gamma); }
          const sum = pv + pg + pb + po;
          masks.vocals[k] = mh * pv / sum;
          if (hasGuitar) masks.guitar[k] = mh * pg / sum;
          masks.bass[k] = mh * pb / sum + mp * lowB[k] * 0.15;
          masks.drums[k] = mp * (1 - lowB[k] * 0.15);
          masks.other[k] = mh * po / sum;
        }
        { const base = f * hop - N / 2; for (let i = 0; i < N; i++) { const q = base + i; if (q >= 0 && q < n) wsum[q] += win[i] * win[i]; } }
        const todo = ids.filter((id) => outs[id]);
        for (let s = 0; s < todo.length; s++) {
          const mk = masks[todo[s]], o = outs[todo[s]];
          // L and R of one stem as one complex spectrum: Z = ML + i MR (both Hermitian)
          for (let k = 0; k < bins; k++) {
            const q = (j * bins + k) * 2, g = mk[k];
            const Lr = XL[q] * g, Li = XL[q + 1] * g, Rr = XR[q] * g, Ri = XR[q + 1] * g;
            reB[k] = Lr - Ri; imB[k] = Li + Rr;
            if (k > 0 && k < N / 2) { reB[N - k] = Lr + Ri; imB[N - k] = -Li + Rr; }
          }
          fft.inverse(reB, imB);
          const base = f * hop - N / 2;
          for (let i = 0; i < N; i++) {
            const p = base + i;
            if (p < 0 || p >= n) continue;
            const w = win[i];
            o[0][p] += reB[i] * w; o[1][p] += imB[i] * w;
          }
        }
      }
      if (opts.onProgress) opts.onProgress(c1 / frames);
      if (RSC.engine && RSC.engine.tick) await RSC.engine.tick();
    }
    const stems = {};
    for (const id of Object.keys(outs)) {
      stems[id] = outs[id].map((x) => {
        const y = new Int16Array(n);
        for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, x[i] / Math.max(1e-6, wsum[i]))); y[i] = v < 0 ? v * 32768 : v * 32767; }
        return y;
      });
    }
    return { stems, sr, start: tOff, ids: Object.keys(stems), hasGuitar, hasBass, hasLyrics };
  };

  /** Float channels of an Int16 stem. */
  ST.toFloat = (st) => st.map((x) => { const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] / 32768; return y; });

  /** Signal-to-distortion ratio (dB) of an estimate against the true signal. */
  ST.sdr = function (est, ref) {
    let s = 0, e = 0;
    for (let i = 0; i < ref.length; i++) { const r = ref[i], d = est[i] - r; s += r * r; e += d * d; }
    return 10 * Math.log10((s + 1e-12) / (e + 1e-12));
  };
});
