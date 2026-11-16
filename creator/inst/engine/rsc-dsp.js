/* ---------------------------------------------------------------------------
 * rsc-dsp.js -- signal processing shared by the beat tracker, the lyrics sync
 * and the stem separation: FFT, windows, short-time spectra, onset envelopes,
 * sliding medians, WAV encoding. Pure functions on Float32Arrays (they run in
 * the page, in a worker and under Node).
 * ------------------------------------------------------------------------- */
(function (factory) {
  // registered as a factory too: the studio runs it again inside a Web Worker
  const root = typeof window !== "undefined" ? window : globalThis;
  factory(root);
  (root.RSCreator.factories = root.RSCreator.factories || {}).dsp = factory;
})(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const D = (RSC.dsp = RSC.dsp || {});

  /** In-place radix-2 complex FFT of size n (inverse: conjugate trick, unscaled). */
  D.makeFFT = function (n) {
    const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit; rev[i] = j;
    }
    for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(-2 * Math.PI * k / n); sin[k] = Math.sin(-2 * Math.PI * k / n); }
    function fft(re, im) {
      for (let i = 1; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1, step = n / len;
        for (let i = 0; i < n; i += len) {
          for (let k = 0, w = 0; k < half; k++, w += step) {
            const p = i + k, q = p + half, wr = cos[w], wi = sin[w];
            const tr = re[q] * wr - im[q] * wi, ti = re[q] * wi + im[q] * wr;
            re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          }
        }
      }
    }
    fft.inverse = function (re, im) {
      for (let i = 0; i < n; i++) im[i] = -im[i];
      fft(re, im);
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
    };
    fft.n = n;
    return fft;
  };

  D.hann = function (n) { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n); return w; };

  /** Mono mix of channels (Float32Array[]). */
  D.mono = function (chs) {
    if (chs.length === 1) return chs[0];
    const n = chs[0].length, out = new Float32Array(n), g = 1 / chs.length;
    for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] * g;
    return out;
  };

  /** Linear-interpolation resampling (for analysis; the audio itself is never resampled this way). */
  D.resample = function (x, from, to) {
    if (from === to) return x;
    const n = Math.floor(x.length * to / from), out = new Float32Array(n), r = from / to;
    for (let i = 0; i < n; i++) { const p = i * r, k = Math.floor(p), f = p - k; out[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f; }
    return out;
  };

  /**
   * Magnitude spectrogram of a mono signal: frames centred at i*hop.
   * -> {mag: Float32Array(frames*bins), frames, bins, hop, n, sr}
   */
  D.stftMag = function (x, sr, n, hop, opts) {
    opts = opts || {};
    const frames = Math.floor(x.length / hop) + 1, bins = n / 2 + 1;
    const kmax = opts.maxBin ? Math.min(bins, opts.maxBin) : bins;
    const mag = new Float32Array(frames * kmax), win = D.hann(n), fft = D.makeFFT(n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let f = 0; f < frames; f += 2) {                       // two real frames per complex FFT
      const o1 = f * hop - n / 2, o2 = o1 + hop, two = f + 1 < frames;
      for (let i = 0; i < n; i++) {
        const a = o1 + i, b = o2 + i;
        re[i] = (a >= 0 && a < x.length ? x[a] : 0) * win[i];
        im[i] = two && b >= 0 && b < x.length ? x[b] * win[i] : 0;
      }
      fft(re, im);
      for (let k = 0; k < kmax; k++) {
        const nk = (n - k) & (n - 1);
        const xr = 0.5 * (re[k] + re[nk]), xi = 0.5 * (im[k] - im[nk]);
        mag[f * kmax + k] = Math.sqrt(xr * xr + xi * xi);
        if (two) { const yr = 0.5 * (im[k] + im[nk]), yi = -0.5 * (re[k] - re[nk]); mag[(f + 1) * kmax + k] = Math.sqrt(yr * yr + yi * yi); }
      }
    }
    return { mag, frames, bins: kmax, hop, n, sr };
  };

  /** Sliding median (odd width w) of src[off + stride*i], i < n, into out[oOff + oStride*i]. */
  D.slidingMedian = function (src, n, w, out, off, stride, oOff, oStride) {
    off = off || 0; stride = stride || 1; oOff = oOff || 0; oStride = oStride || 1;
    const h = w >> 1, win = new Float64Array(w);
    let size = 0;
    const at = (i) => src[off + stride * Math.min(n - 1, Math.max(0, i))];
    for (let i = -h; i <= h; i++) { const v = at(i); let j = size++; while (j > 0 && win[j - 1] > v) { win[j] = win[j - 1]; j--; } win[j] = v; }
    for (let i = 0; i < n; i++) {
      out[oOff + oStride * i] = win[h];
      const rem = at(i - h), add = at(i + h + 1);
      let j = 0; while (win[j] !== rem) j++;                      // remove
      for (; j < size - 1; j++) win[j] = win[j + 1];
      j = size - 1; while (j > 0 && win[j - 1] > add) { win[j] = win[j - 1]; j--; } win[j] = add;
    }
  };

  /**
   * Onset strength: half-wave rectified change of the log-compressed spectrum,
   * summed over a frequency band, minus its local mean. fps = sr / hop.
   */
  D.onsetEnvelope = function (spec, opts) {
    opts = opts || {};
    const { mag, frames, bins, n, sr } = spec;
    const k0 = Math.max(1, Math.floor((opts.lo || 30) * n / sr)), k1 = Math.min(bins - 1, Math.ceil((opts.hi || 8000) * n / sr));
    const out = new Float32Array(frames), prev = new Float32Array(bins);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let k = k0; k <= k1; k++) {
        const v = Math.log1p(1000 * mag[f * bins + k]);
        const d = v - prev[k];
        if (f > 0 && d > 0) s += d;
        prev[k] = v;
      }
      out[f] = s;
    }
    const w = Math.max(3, Math.round((opts.meanWindow || 0.4) * sr / spec.hop));
    const res = new Float32Array(frames);
    let acc = 0;
    for (let f = 0; f < frames + w; f++) {
      if (f < frames) acc += out[f];
      if (f - 2 * w - 1 >= 0) acc -= out[f - 2 * w - 1];
      const c = f - w;
      if (c >= 0 && c < frames) res[c] = Math.max(0, out[c] - acc / (2 * w + 1));
    }
    let sd = 0;
    for (let f = 0; f < frames; f++) sd += res[f] * res[f];
    sd = Math.sqrt(sd / frames) || 1;
    for (let f = 0; f < frames; f++) res[f] /= sd;
    return res;
  };

  /** 16-bit PCM WAV file of channels (Float32Array[] or Int16 interleaved with .channels). */
  D.wavBytes = function (chs, sr) {
    const ch = chs.length, n = chs[0].length, data = n * ch * 2;
    const buf = new ArrayBuffer(44 + data), dv = new DataView(buf), u8 = new Uint8Array(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) u8[o + i] = s.charCodeAt(i); };
    str(0, "RIFF"); dv.setUint32(4, 36 + data, true); str(8, "WAVE"); str(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true);
    dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); str(36, "data"); dv.setUint32(40, data, true);
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chs[c][i]));
      dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2;
    }
    return u8;
  };

  /** Min/max peaks per `block` samples of a mono signal (for waveforms). */
  D.peaks = function (x, block) {
    const n = Math.ceil(x.length / block), out = new Float32Array(2 * n);
    for (let b = 0; b < n; b++) {
      let lo = 0, hi = 0;
      const e = Math.min(x.length, (b + 1) * block);
      for (let i = b * block; i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      out[2 * b] = lo; out[2 * b + 1] = hi;
    }
    return out;
  };

  D.midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  D.hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
});
