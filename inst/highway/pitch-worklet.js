/* ---------------------------------------------------------------------------
 * pitch-worklet.js -- AudioWorkletProcessor "rs-guitar-analyzer".
 *
 * Runs on the audio thread, so analysis timing is sample-accurate and never
 * competes with rendering. It emits (via this.port):
 *   {type: "onset", t, strength}   attack detected (t = context time, s)
 *   {type: "frame", t, mag, n, sr, rms}  magnitude spectrum every ~20 ms
 *                                  (t = window centre; mag = Float32Array n/2)
 *   {type: "level", rms, peak}     ~20 Hz input meter
 *
 * Onsets: positive spectral flux of log-compressed 1024-point spectra every
 * 256 samples, plus 8 x the positive level rise (dB over two hops), which
 * catches soft low-frequency (bass) attacks; peak-picked against an adaptive
 * threshold (running mean of the detection function) and gated by an adaptive
 * noise floor. Tuned on synthesized performances (tests/reference/): onset
 * F-measure 0.97-0.99 for guitar and bass.
 * Frames: Hann window of `win` samples (8192 guitar / 16384 bass, set by mic.js), zero-padded
 * to 2 x win for finer bin spacing; pitch verification happens on the main
 * thread against the notes that are due (mic.js).
 * ------------------------------------------------------------------------- */
/** Real-input FFT of size n via one complex FFT of size n/2 (even/odd packing):
 *  about half the work of a full complex transform (matters on the audio thread). */
class FFT {
  constructor(n) {
    const m = n / 2;
    this.n = n; this.m = m;
    this.rev = new Uint32Array(m);
    const bits = Math.log2(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(m / 2); this.sin = new Float64Array(m / 2);      // size-m twiddles
    for (let i = 0; i < m / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / m); this.sin[i] = Math.sin(-2 * Math.PI * i / m); }
    this.wc = new Float64Array(m); this.ws = new Float64Array(m);                // size-n twiddles (untangling)
    for (let k = 0; k < m; k++) { this.wc[k] = Math.cos(-2 * Math.PI * k / n); this.ws[k] = Math.sin(-2 * Math.PI * k / n); }
    this.re = new Float64Array(m); this.im = new Float64Array(m);
  }
  /** Magnitude spectrum (n/2 bins) of real input x (length <= n, zero-padded). */
  magnitude(x, out) {
    const m = this.m, re = this.re, im = this.im, rev = this.rev, len = x.length;
    // z[j] = x[2j] + i x[2j+1], in bit-reversed order
    for (let j = 0; j < m; j++) {
      const r = rev[j], a = 2 * j;
      re[r] = a < len ? x[a] : 0; im[r] = a + 1 < len ? x[a + 1] : 0;
    }
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1, step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step], s = this.sin[k * step];
          const a = start + k, b = a + half;
          const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    // X[k] = E[k] + W^k O[k], E = (Z[k] + conj Z[m-k]) / 2, O = (Z[k] - conj Z[m-k]) / 2i
    for (let k = 0; k < m; k++) {
      const k2 = k === 0 ? 0 : m - k;
      const zr = re[k], zi = im[k], cr = re[k2], ci = -im[k2];
      const er = 0.5 * (zr + cr), ei = 0.5 * (zi + ci);
      const dr = 0.5 * (zr - cr), di = 0.5 * (zi - ci);             // O = d / i = (di, -dr)
      const or = di, oi = -dr, wc = this.wc[k], ws = this.ws[k];
      const xr = er + or * wc - oi * ws, xi = ei + or * ws + oi * wc;
      out[k] = Math.sqrt(xr * xr + xi * xi);
    }
    return out;
  }
}
const hann = (n) => { const w = new Float32Array(n); for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); return w; };

class GuitarAnalyzer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.win = o.window || 4096;
    this.hop = Math.round(sampleRate * (o.frameSeconds || 0.02));
    this.fft = new FFT(this.win * 2); this.specWin = hann(this.win);
    this.odfN = 1024; this.odfHop = 256;
    this.odfFFT = new FFT(this.odfN); this.odfWin = hann(this.odfN);
    this.ring = new Float32Array(65536); this.w = 0;
    this.seg = new Float32Array(this.win); this.odfSeg = new Float32Array(this.odfN);
    this.odfMag = new Float32Array(this.odfN / 2); this.prevLog = new Float32Array(this.odfN / 2);
    this.odf = []; this.odfT = []; this.odfRms = []; this.levDb = [-120, -120];
    this.sensitivity = o.sensitivity || 1;        // > 1 = more sensitive
    this.noise = 1e-4; this.lastOnset = -1;
    this.sinceOdf = 0; this.sinceFrame = 0; this.sinceLevel = 0; this.levelPeak = 0; this.levelSum = 0; this.levelN = 0;
    this.frame = 0;                               // absolute frame index of the next sample
    this.port.onmessage = (e) => { if (e.data && e.data.sensitivity) this.sensitivity = +e.data.sensitivity; };
  }

  _copy(dst, endFrame) {                          // last dst.length samples ending at endFrame
    const n = dst.length, L = this.ring.length;
    let idx = ((this.w - (this.frame - endFrame) - n) % L + L) % L;
    for (let i = 0; i < n; i++) { dst[i] = this.ring[idx]; idx = idx + 1 === L ? 0 : idx + 1; }
  }

  process(inputs) {
    const input = inputs[0];
    const x = input && input[0];
    if (!x) return true;
    const L = this.ring.length;
    for (let i = 0; i < x.length; i++) {
      const v = input.length > 1 ? 0.5 * (x[i] + input[1][i]) : x[i];     // mono mix
      this.ring[this.w] = v; this.w = this.w + 1 === L ? 0 : this.w + 1;
      const a = Math.abs(v); if (a > this.levelPeak) this.levelPeak = a;
      this.levelSum += v * v; this.levelN++;
    }
    this.frame = currentFrame + x.length;
    this.sinceOdf += x.length; this.sinceFrame += x.length; this.sinceLevel += x.length;
    while (this.sinceOdf >= this.odfHop) { this.sinceOdf -= this.odfHop; this._onsetStep(this.frame - this.sinceOdf); }
    while (this.sinceFrame >= this.hop) { this.sinceFrame -= this.hop; this._frameStep(this.frame - this.sinceFrame); }
    if (this.sinceLevel >= sampleRate / 20) {
      this.port.postMessage({ type: "level", rms: Math.sqrt(this.levelSum / Math.max(1, this.levelN)), peak: this.levelPeak });
      this.sinceLevel = 0; this.levelPeak = 0; this.levelSum = 0; this.levelN = 0;
    }
    return true;
  }

  _onsetStep(endFrame) {
    const seg = this.odfSeg, n = this.odfN;
    this._copy(seg, endFrame);
    let e = 0;
    for (let i = 0; i < n; i++) { e += seg[i] * seg[i]; seg[i] *= this.odfWin[i]; }
    const rms = Math.sqrt(e / n);
    // adaptive noise floor: follows quiet input quickly, loud input very slowly
    this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.9995 + rms * 0.0005;
    this.odfFFT.magnitude(seg, this.odfMag);
    const lo = Math.floor(70 * n / sampleRate), hi = Math.min(n / 2, Math.ceil(8000 * n / sampleRate));
    let flux = 0;
    for (let k = lo; k < hi; k++) {
      const c = Math.log(1 + 100 * this.odfMag[k]);
      const d = c - this.prevLog[k];
      if (d > 0) flux += d;
      this.prevLog[k] = c;
    }
    // level rise (dB over two hops): soft low-frequency attacks barely move the flux
    const db = 20 * Math.log10(1e-6 + rms);
    const rise = Math.max(0, db - this.levDb[0]);
    this.levDb[0] = this.levDb[1]; this.levDb[1] = db;
    flux += 8 * rise;
    const t = (endFrame - n / 2) / sampleRate;             // centre of the analysis window
    this.odf.push(flux); this.odfT.push(t); this.odfRms.push(rms);
    if (this.odf.length > 48) { this.odf.shift(); this.odfT.shift(); this.odfRms.shift(); }
    // peak-pick the value 3 hops back (needs a little look-ahead)
    const m = this.odf.length, j = m - 4;
    if (j < 4) return;
    const v = this.odf[j];
    for (let k = j - 3; k <= j + 3; k++) if (k !== j && this.odf[k] >= v) return;
    let mean = 0;
    for (let k = 0; k < m; k++) mean += this.odf[k];
    mean /= m;
    const thr = (mean * 1.5 + 2.5) / this.sensitivity;
    const loud = Math.max(this.odfRms[j], this.odfRms[j + 1], this.odfRms[j + 2]);
    if (v > thr && loud > this.noise * 2.5 && loud > 1e-3 && this.odfT[j] - this.lastOnset > 0.045) {
      this.lastOnset = this.odfT[j];
      this.port.postMessage({ type: "onset", t: this.odfT[j], strength: v / thr });
    }
  }

  _frameStep(endFrame) {
    const seg = this.seg, n = this.win;
    this._copy(seg, endFrame);
    let e = 0;
    for (let i = 0; i < n; i++) { e += seg[i] * seg[i]; seg[i] *= this.specWin[i]; }
    const mag = new Float32Array(this.fft.n / 2);
    this.fft.magnitude(seg, mag);
    this.port.postMessage({ type: "frame", t: (endFrame - n / 2) / sampleRate, mag, n: this.fft.n, sr: sampleRate,
                            win: n, rms: Math.sqrt(e / n) }, [mag.buffer]);
  }
}
registerProcessor("rs-guitar-analyzer", GuitarAnalyzer);
