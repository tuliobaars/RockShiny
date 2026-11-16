/* ---------------------------------------------------------------------------
 * rsc-voice.js -- where the voice sings, and lyrics laid over it.
 *
 * Vocal activity (100 frames/s): the stereo mix is cut down to the voice's
 * range (a 40-band mel spectrum, 80 Hz - 8 kHz, of the centre channel and of
 * the sides, at 22.05 kHz), each band normalised to the song (its median), and
 * described over 50 ms and 0.5 s: level, how much it moves (the 4-8 Hz
 * modulation of syllables and vibrato), how much of it sits in the centre,
 * and how it stands out of the last 2 s. A logistic model trained on the
 * sample songs' own lyrics (frames inside a sung syllable = 1) turns that into
 * p(voice). Measured leave-one-song-out on 11 songs: frame AUC 0.77 (0.54 to
 * 0.92 by song), where the centre-channel level alone gave 0.65.
 *
 * The silences and the sung phrases are the runs of p above / below 0.5
 * (V.segments). Lyrics are then laid over them. Measured on the same 11 songs,
 * each scored with a model trained without it (creator/tools/ear/eval_sync.js
 * --loso), lyrics moved by up to 2.5 s, errors of 1218 line starts:
 *   V.alignGlobal  one shift for all the lines (lyrics timed on this recording,
 *                  e.g. LRCLIB): the shift whose syllables cover the most voice.
 *                  Median line error 0.08 s, 65 % of lines within 0.3 s (the
 *                  previous onset aligner: 0.30 s, 48 %); in the studio it is
 *                  checked against the onset aligner (Auto-sync: 75 %, worst 0.72 s).
 *   V.alignLines   lyrics of another take or roughly timed: a shift and a drift
 *                  (+-0.6 %) for the whole, then each line moved on its own
 *                  (dynamic programming: lines keep their order, neighbours move
 *                  alike). Lines +-0.8 s off: median 0.35 s (one shift: 0.51 s);
 *                  another take 0.5 % slower: 0.28 s (0.38 s). Lines only +-0.3 s
 *                  off are better left to one shift (0.22 s; each line: 0.26 s).
 * ------------------------------------------------------------------------- */
(function (factory) {
  const root = typeof window !== "undefined" ? window : globalThis;
  factory(root);
  (root.RSCreator.factories = root.RSCreator.factories || {}).voice = factory;
})(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const V = (RSC.voice = RSC.voice || {});
  const SR = 22050, N = 2048, HOP = 220, NMEL = 40;
  /** The trained model: mean / sd of the 200 features, weights, bias. */
  V.MODEL = {"mu":[-0.6005,-0.53222,-0.5152,-0.47834,-0.47878,-0.47252,-0.45642,-0.43904,-0.40471,-0.38203,-0.39065,-0.37407,-0.39368,-0.39267,-0.38104,-0.38214,-0.37782,-0.38543,-0.41133,-0.40692,-0.41304,-0.41349,-0.43197,-0.41485,-0.43627,-0.42656,-0.45254,-0.46536,-0.47716,-0.45072,-0.47269,-0.47641,-0.47815,-0.47993,-0.48733,-0.47286,-0.47578,-0.47347,-0.47179,-0.47499,-0.60044,-0.53214,-0.51511,-0.47826,-0.47872,-0.47244,-0.45633,-0.43895,-0.40462,-0.38192,-0.39055,-0.37399,-0.39359,-0.39257,-0.38095,-0.38204,-0.37773,-0.38534,-0.41124,-0.40682,-0.41294,-0.41339,-0.43187,-0.41476,-0.43617,-0.42645,-0.45243,-0.46525,-0.47707,-0.45062,-0.4726,-0.4763,-0.47805,-0.47982,-0.48723,-0.47276,-0.47567,-0.47337,-0.47169,-0.47488,0.4979,0.47512,0.45565,0.42617,0.42449,0.43007,0.44066,0.43947,0.44334,0.45777,0.46501,0.4484,0.42638,0.4315,0.45767,0.46336,0.44965,0.44822,0.4338,0.44224,0.44035,0.43933,0.43328,0.43818,0.44727,0.44959,0.44249,0.4405,0.45146,0.46184,0.46041,0.47415,0.49192,0.49993,0.50939,0.52388,0.54377,0.56185,0.57288,0.58064,-0.13208,-0.09074,-0.08898,-0.04441,-0.04248,-0.05933,-0.06453,-0.03457,-0.01964,-0.01743,-0.03592,-0.00494,-0.01458,-0.01668,-0.01709,-0.00155,-0.00602,-0.00185,-0.00041,-0.00677,-0.01406,-0.02963,-0.02505,-0.04592,-0.04485,-0.03788,-0.03368,-0.04332,-0.04764,-0.04007,-0.0415,-0.0535,-0.05057,-0.05308,-0.06105,-0.05614,-0.06403,-0.06158,-0.05291,-0.05369,-0.00051,-0.00049,-0.00046,-0.00045,-0.00048,-0.00046,-0.00046,-0.00049,-0.00051,-0.00048,-0.00049,-0.00047,-0.00046,-0.00048,-0.00048,-0.00047,-0.00051,-0.0005,-0.00046,-0.00047,-0.00043,-0.00041,-0.00041,-0.00041,-0.0004,-0.00041,-0.0004,-0.0004,-0.00042,-0.00041,-0.0004,-0.0004,-0.00038,-0.00039,-0.00039,-0.00038,-0.00037,-0.00036,-0.00035,-0.00035],"sd":[2.74608,2.69345,2.68001,2.64877,2.62784,2.61317,2.58944,2.58827,2.57569,2.56186,2.54882,2.54756,2.5206,2.51718,2.51657,2.50411,2.50016,2.50962,2.508,2.5155,2.51641,2.50807,2.52362,2.52254,2.52833,2.50939,2.50989,2.53231,2.55551,2.54352,2.53037,2.53622,2.53051,2.5276,2.53168,2.54186,2.54768,2.5554,2.55938,2.56407,2.68393,2.63848,2.62873,2.6024,2.58129,2.56528,2.53956,2.53786,2.52365,2.50597,2.49193,2.49386,2.47024,2.46601,2.46066,2.44637,2.44516,2.45543,2.45607,2.46253,2.46299,2.45429,2.47132,2.46858,2.4728,2.45297,2.45463,2.47756,2.49872,2.48399,2.47066,2.47451,2.46504,2.45976,2.46251,2.46914,2.46968,2.47405,2.47572,2.47866,0.37062,0.33016,0.32141,0.31012,0.30998,0.31248,0.31226,0.3182,0.32207,0.33105,0.32993,0.32427,0.31984,0.3194,0.32674,0.33207,0.32694,0.32454,0.32276,0.32089,0.32705,0.32965,0.32934,0.33472,0.33644,0.33804,0.33882,0.34072,0.34507,0.35148,0.35084,0.35313,0.3569,0.36023,0.35823,0.36649,0.3781,0.37771,0.37835,0.37948,0.54026,0.47061,0.47342,0.41295,0.39734,0.42056,0.41068,0.36443,0.37828,0.36211,0.37843,0.34641,0.34128,0.33058,0.33056,0.32104,0.32296,0.33211,0.31839,0.33225,0.33088,0.32228,0.31782,0.31659,0.32537,0.33813,0.31962,0.3244,0.33672,0.3421,0.32875,0.32889,0.3268,0.32906,0.33158,0.32484,0.33158,0.32571,0.33249,0.32839,0.70863,0.65773,0.64796,0.62013,0.61831,0.62526,0.63147,0.64294,0.6522,0.67293,0.67551,0.65904,0.63569,0.64157,0.6663,0.6686,0.65098,0.64438,0.63116,0.63942,0.64163,0.64231,0.63421,0.64385,0.65162,0.64756,0.64103,0.64134,0.65479,0.66755,0.66439,0.67088,0.68376,0.69596,0.70234,0.72095,0.742,0.75522,0.76467,0.77364],"w":[-0.2462,0.04054,0.36805,0.56472,0.09509,-0.00376,-0.00508,0.30948,0.18992,-0.14417,0.18664,0.05849,0.14195,0.15481,0.05241,0.26062,0.06893,0.24651,0.08987,-0.04862,-0.21811,-0.1106,-0.14737,-0.09178,-0.13578,-0.25739,-0.27951,-0.18511,-0.18518,-0.29712,-0.17289,-0.04166,-0.07437,0.01644,0.12355,0.26575,0.34507,0.22109,0.2658,0.25235,-0.35825,-0.02593,0.3075,0.47028,0.0141,0.02603,0.03732,0.30242,0.15182,-0.18881,0.18462,0.06451,0.10656,0.15886,0.04928,0.24683,0.00414,0.18574,0.07239,-0.0482,-0.19313,-0.06928,-0.14429,-0.07181,-0.12649,-0.23667,-0.25283,-0.17145,-0.17482,-0.28985,-0.17148,-0.01967,-0.07842,0.02155,0.12659,0.2731,0.35307,0.21476,0.26392,0.25562,0.17539,-0.22543,-0.06011,0.12064,-0.04987,0.13954,0.14136,0.23155,0.07236,-0.00501,-0.07689,0.08911,0.34751,-0.02219,-0.16742,0.13078,0.3098,-0.14024,0.37421,-0.02067,-0.11551,-0.17351,-0.04843,-0.02563,-0.24195,-0.21145,-0.01608,0.16258,0.00018,-0.20711,0.17396,0.19591,-0.21721,-0.07917,0.24913,0.10079,-0.30517,-0.02934,0.07289,-0.37849,0.14906,-0.00865,0.22662,0.03617,0.12854,0.06605,0.04326,-0.04171,0.06663,0.13668,-0.00153,-0.01348,0.07162,0.02622,-0.01527,0.0573,0.00573,0.06684,-0.1152,0.04005,-0.27601,-0.08844,0.21542,0.12152,0.24107,0.21691,0.04402,-0.00266,-0.09773,-0.07186,-0.27818,-0.10826,-0.04038,0.01665,0.24004,0.29869,0.31832,-0.13913,-0.01901,0.18833,0.06032,0.01344,-0.06737,-0.1936,-0.06051,0.04018,0.01708,-0.10225,-0.07246,-0.02684,-0.03913,-0.02318,-0.07629,-0.05169,-0.0407,-0.04756,-0.0356,-0.10432,-0.03065,0.03409,0.08543,0.11473,0.02415,0.02213,0.07077,0.03886,0.12976,0.00515,0.08894,0.09426,0.07739,0.04172,0.04697,0.00489,-0.03923,-0.11728,-0.10142,-0.10841,-0.05533,-0.05744],"b":-1.02652};
  /** The model's lines come out this much late against the lyrics' own timing (measured, subtracted). */
  V.BIAS = 0.15;

  // ---- signal front end -----------------------------------------------------------------------------
  /** Low-pass (windowed sinc) + resampling to 22.05 kHz (or `target`), for analysis. */
  V.toAnalysisRate = function (x, sr, target) {
    target = target || SR;
    if (sr === target) return x;
    const ratio = target / sr, fc = 0.45 * Math.min(1, ratio), taps = 31, h = new Float32Array(taps);
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const k = i - (taps - 1) / 2, sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
      h[i] = sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1))); sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    const n = Math.floor(x.length * ratio), out = new Float32Array(n), half = (taps - 1) / 2, step = 1 / ratio;
    for (let i = 0; i < n; i++) {
      const p = i * step, c = Math.floor(p);
      let acc = 0;
      for (let j = 0; j < taps; j++) { const q = c + j - half; if (q >= 0 && q < x.length) acc += h[j] * x[q]; }
      out[i] = acc;
    }
    return out;
  };
  function melBank() {
    const mel = (f) => 2595 * Math.log10(1 + f / 700), imel = (m) => 700 * (Math.pow(10, m / 2595) - 1);
    const lo = mel(80), hi = mel(8000), pts = [], bins = [];
    for (let i = 0; i < NMEL + 2; i++) pts.push(imel(lo + (hi - lo) * i / (NMEL + 1)));
    for (const f of pts) bins.push(Math.floor((N + 1) * f / SR));
    const ks = [], ws = [], start = [0];
    for (let i = 0; i < NMEL; i++) {
      const a = bins[i], b = bins[i + 1], c = bins[i + 2];
      for (let k = a; k < b; k++) { ks.push(k); ws.push((k - a) / Math.max(1, b - a)); }
      for (let k = b; k < c; k++) { ks.push(k); ws.push((c - k) / Math.max(1, c - b)); }
      start.push(ks.length);
    }
    return { k: Int32Array.from(ks), w: Float64Array.from(ws), start: Int32Array.from(start), kmax: Math.min(N / 2, Math.max(...ks)) };
  }
  /** log mel spectrum of one signal (frames x 40), symmetric Hann window as the training. */
  function logMel(x, fft, win, fb) {
    const frames = Math.floor(x.length / HOP) + 1, out = new Float32Array(frames * NMEL);
    const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
    for (let f = 0; f < frames; f += 2) {
      const o1 = f * HOP - N / 2, o2 = o1 + HOP, two = f + 1 < frames;
      for (let i = 0; i < N; i++) {
        const a = o1 + i, b = o2 + i;
        re[i] = (a >= 0 && a < x.length ? x[a] : 0) * win[i];
        im[i] = two && b >= 0 && b < x.length ? x[b] * win[i] : 0;
      }
      fft(re, im);
      for (let pass = 0; pass < (two ? 2 : 1); pass++) {
        for (let k = 0; k <= fb.kmax; k++) {
          const nk = (N - k) & (N - 1);
          let xr, xi;
          if (pass === 0) { xr = 0.5 * (re[k] + re[nk]); xi = 0.5 * (im[k] - im[nk]); }
          else { xr = 0.5 * (im[k] + im[nk]); xi = -0.5 * (re[k] - re[nk]); }
          mag[k] = Math.sqrt(xr * xr + xi * xi);
        }
        const o = (f + pass) * NMEL;
        for (let m = 0; m < NMEL; m++) {
          let s = 0;
          for (let q = fb.start[m]; q < fb.start[m + 1]; q++) s += fb.w[q] * mag[fb.k[q]];
          out[o + m] = Math.log(1e-6 + s);
        }
      }
    }
    return { v: out, frames };
  }
  function medianNormalize(v, frames) {
    const col = new Float32Array(frames);
    for (let m = 0; m < NMEL; m++) {
      for (let f = 0; f < frames; f++) col[f] = v[f * NMEL + m];
      const s = Float32Array.from(col).sort(), med = s[frames >> 1];
      for (let f = 0; f < frames; f++) v[f * NMEL + m] -= med;
    }
  }
  /** Centred moving average over w frames of every band (edges: the frames there are). */
  function box(v, frames, w) {
    const h = w >> 1, out = new Float32Array(frames * NMEL), cs = new Float64Array(frames + 1);
    for (let m = 0; m < NMEL; m++) {
      cs[0] = 0;
      for (let f = 0; f < frames; f++) cs[f + 1] = cs[f] + v[f * NMEL + m];
      for (let f = 0; f < frames; f++) { const a = Math.max(0, f - h), b = Math.min(frames, f + h + 1); out[f * NMEL + m] = (cs[b] - cs[a]) / (b - a); }
    }
    return out;
  }

  /**
   * p(voice), 100 frames/s. channels: [L, R] (or [mono]) Float32Array, sr: their rate.
   * opts.onProgress(frac). -> {p: Float32Array, fps: 100}
   */
  V.activity = async function (channels, sr, opts) {
    opts = opts || {};
    const D = RSC.dsp, tick = () => new Promise((r) => setTimeout(r, 0));
    const L = V.toAnalysisRate(channels[0], sr), R = channels[1] ? V.toAnalysisRate(channels[1], sr) : L;
    if (opts.onProgress) opts.onProgress(0.2);
    await tick();
    const n = L.length, M = new Float32Array(n), S = new Float32Array(n);
    for (let i = 0; i < n; i++) { M[i] = 0.5 * (L[i] + R[i]); S[i] = 0.5 * (L[i] - R[i]); }
    const fft = D.makeFFT(N), win = new Float64Array(N), fb = melBank();
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const lm = logMel(M, fft, win, fb);
    if (opts.onProgress) opts.onProgress(0.5);
    await tick();
    const ls = logMel(S, fft, win, fb), F = lm.frames;
    if (opts.onProgress) opts.onProgress(0.8);
    await tick();
    medianNormalize(lm.v, F); medianNormalize(ls.v, F);
    const cen = new Float32Array(F * NMEL), sq = new Float32Array(F * NMEL);
    for (let i = 0; i < F * NMEL; i++) { cen[i] = lm.v[i] - ls.v[i]; sq[i] = lm.v[i] * lm.v[i]; }
    const b5 = box(lm.v, F, 5), b51 = box(lm.v, F, 51), q51 = box(sq, F, 51), c51 = box(cen, F, 51), b201 = box(lm.v, F, 201);
    // the logistic model, folded: z = b' + sum_j a_j x_j with a_j = w_j / sd_j
    const Mo = V.MODEL, p = new Float32Array(F), A = new Float64Array(5 * NMEL);
    let b0 = Mo.b;
    for (let j = 0; j < 5 * NMEL; j++) { A[j] = Mo.w[j] / Mo.sd[j]; b0 -= A[j] * Mo.mu[j]; }
    for (let f = 0; f < F; f++) {
      let z = b0;
      const o = f * NMEL;
      for (let m = 0; m < NMEL; m++) {
        const i = o + m, mean = b51[i], sd = Math.sqrt(Math.max(0, q51[i] - mean * mean));
        z += A[m] * b5[i] + A[NMEL + m] * mean + A[2 * NMEL + m] * sd + A[3 * NMEL + m] * c51[i] + A[4 * NMEL + m] * (b5[i] - b201[i]);
      }
      p[f] = 1 / (1 + Math.exp(-z));
    }
    if (opts.onProgress) opts.onProgress(1);
    return { p, fps: 100 };
  };

  /** Evidence per frame: log-odds of p, minus its median (singing scores > 0). */
  V.evidence = function (p) {
    const ev = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) { const q = Math.min(1 - 1e-4, Math.max(1e-4, p[i])); ev[i] = Math.log(q / (1 - q)); }
    const s = Float32Array.from(ev).sort(), med = s[s.length >> 1] || 0;
    for (let i = 0; i < ev.length; i++) ev[i] -= med;
    return ev;
  };

  /**
   * Sung phrases and silences: runs of p (smoothed over 0.3 s) above 0.5,
   * shorter gaps than minGap bridged, phrases shorter than minSung dropped.
   * -> [{t0, t1}] (seconds)
   */
  V.segments = function (p, opts) {
    opts = opts || {};
    const w = 15, n = p.length, sm = new Float32Array(n), cs = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + p[i];
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(n, i + w + 1); sm[i] = (cs[b] - cs[a]) / (b - a); }
    const on = opts.threshold || 0.5, minGap = opts.minGap || 0.35, minSung = opts.minSung || 0.3, out = [];
    let s = -1;
    for (let i = 0; i <= n; i++) {
      const v = i < n ? sm[i] >= on : false;
      if (v && s < 0) s = i;
      if (!v && s >= 0) { out.push({ t0: s / 100, t1: i / 100 }); s = -1; }
    }
    const merged = [];
    for (const g of out) { const last = merged[merged.length - 1]; if (last && g.t0 - last.t1 < minGap) last.t1 = g.t1; else merged.push(Object.assign({}, g)); }
    return merged.filter((g) => g.t1 - g.t0 >= minSung);
  };

  // ---- lyrics over the voice ----------------------------------------------------------------------------
  /** Lines of syllables: [{start, end, syl: [[time, length]], idx: [syllable indices]}] ("+" ends a line). */
  V.linesOf = function (syllables) {
    const out = [];
    let cur = null;
    syllables.forEach((s, i) => {
      if (!cur) { cur = { syl: [], idx: [] }; out.push(cur); }
      cur.syl.push([s.time, Math.max(0.08, s.length || 0)]); cur.idx.push(i);
      if (/\+$/.test(s.lyric || "")) cur = null;
    });
    for (const l of out) { l.start = l.syl[0][0]; l.end = Math.max(...l.syl.map(([t, d]) => t + d)); }
    return out;
  };
  function cumsum(ev) { const c = new Float64Array(ev.length + 1); for (let i = 0; i < ev.length; i++) c[i + 1] = c[i] + ev[i]; return c; }
  /** Voice evidence under a line's syllables when the line is moved by  (and time-scaled by a around t0). */
  function lineScore(c, line, shift, a, t0) {
    const n = c.length - 1;
    let s = 0;
    for (const [t, d] of line.syl) {
      const tt = a === 1 ? t : t0 + (t - t0) * a, dd = a === 1 ? d : d * a;
      let i = Math.round((tt + shift) * 100), j = Math.round((tt + shift + dd) * 100);
      i = Math.min(n, Math.max(0, i)); j = Math.min(n, Math.max(0, j));
      s += c[j] - c[i];
    }
    return s;
  }
  /** The share of the syllables' time (moved by shift) where p(voice) > 0.5: how well they sit on the singing. */
  V.coverage = function (syllables, p, shift) {
    let n = 0, k = 0;
    for (const s of syllables) {
      const a = Math.round((s.time + (shift || 0)) * 100), b = Math.round((s.time + (shift || 0) + Math.max(0.1, s.length || 0)) * 100);
      for (let i = a; i < b; i++) { n++; if (i >= 0 && i < p.length && p[i] > 0.5) k++; }
    }
    return n ? k / n : 0;
  };

  /**
   * One shift for every line (lyrics timed on this recording). ev: V.evidence(p).
   * opts.maxLag (s, default 4), opts.prior (s). -> {shift, confidence (0..1)}
   * The model's lag (V.BIAS) is taken off.
   */
  V.alignGlobal = function (lines, ev, opts) {
    opts = opts || {};
    const c = cumsum(ev), K = Math.round((opts.maxLag || 4) * 100), c0 = Math.round((opts.prior || 0) * 100);
    const scores = [];
    let best = -Infinity, lag = c0;
    for (let d = c0 - K; d <= c0 + K; d++) {
      let sc = 0;
      for (const l of lines) sc += lineScore(c, l, d / 100, 1, 0);
      scores.push(sc);
      if (sc > best) { best = sc; lag = d; }
    }
    // confidence: how far the best stands above the best shift at least 0.5 s away
    let second = -Infinity;
    scores.forEach((sc, i) => { const d = c0 - K + i; if (Math.abs(d - lag) >= 50 && sc > second) second = sc; });
    const spread = Math.max(1e-6, best - Math.min(...scores));
    return { shift: Math.round((lag / 100 - V.BIAS) * 1000) / 1000, confidence: Math.max(0, Math.min(1, (best - second) / spread * 4)) };
  };

  /**
   * Each line on its own (lyrics of another take, or timed roughly): a shift and a
   * drift for the whole first, then every line moved within +-W s by dynamic
   * programming (lines keep their order, neighbours move alike: lam per s of
   * difference, mu per s away from the whole's fit). -> {starts: [new line starts], shift, drift}
   */
  V.alignLines = function (lines, ev, opts) {
    opts = opts || {};
    const c = cumsum(ev), maxLag = opts.maxLag || 4, W = opts.window || 1.0, step = 0.02, lam = opts.lam != null ? opts.lam : 0.3, mu = opts.mu != null ? opts.mu : 0.15;
    const t0 = lines.length ? lines[0].start : 0, prior = (opts.prior || 0) + (opts.prior != null ? V.BIAS : 0);
    let best = -Infinity, bd = prior, ba = 1;
    for (const a of [0.994, 0.996, 0.998, 1, 1.002, 1.004, 1.006]) {
      for (let d = prior - maxLag; d <= prior + maxLag + 1e-9; d += step) {
        let sc = 0;
        for (const l of lines) sc += lineScore(c, l, d, a, t0);
        if (sc > best) { best = sc; bd = d; ba = a; }
      }
    }
    const fit = lines.map((l) => ({ syl: l.syl.map(([t, d]) => [t0 + (t - t0) * ba + bd, d * ba]) }));
    for (const l of fit) { l.start = l.syl[0][0]; l.end = Math.max(...l.syl.map(([t, d]) => t + d)); }
    const K = [];
    for (let k = -W; k <= W + 1e-9; k += step) K.push(Math.round(k * 1000) / 1000);
    const nK = K.length, Ln = fit.length;
    const sc = fit.map((l) => K.map((k) => lineScore(c, l, k, 1, 0) / 100));
    let cost = sc[0].map((v, j) => v - mu * Math.abs(K[j]));
    const back = [new Int32Array(nK)];
    for (let i = 1; i < Ln; i++) {
      const nc = new Float64Array(nK), bk = new Int32Array(nK), prevEnd = fit[i - 1].end, st = fit[i].start;
      for (let j = 0; j < nK; j++) {
        let bv = -Infinity, bi = 0;
        for (let q = 0; q < nK; q++) {
          if (prevEnd + K[q] > st + K[j] + 0.05) continue;            // keep the order, no overlap
          const v = cost[q] - lam * Math.abs(K[q] - K[j]);
          if (v > bv) { bv = v; bi = q; }
        }
        nc[j] = bv + sc[i][j] - mu * Math.abs(K[j]); bk[j] = bi;
      }
      cost = nc; back.push(bk);
    }
    let j = 0;
    for (let q = 1; q < nK; q++) if (cost[q] > cost[j]) j = q;
    const ks = new Array(Ln);
    for (let i = Ln - 1; i >= 0; i--) { ks[i] = K[j]; j = back[i][j]; }
    return { starts: fit.map((l, i) => Math.round((l.start + ks[i] - V.BIAS) * 1000) / 1000), shift: bd - V.BIAS, drift: ba };
  };
});
