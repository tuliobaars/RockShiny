/* ---------------------------------------------------------------------------
 * karaoke-sync.js -- lyrics that are not in the .psarc: LRC files (a sidecar
 * .lrc, or synced lyrics from LRCLIB), timed for *a* recording of the song,
 * aligned automatically to *this* recording.
 *
 *   RSKaraoke.parseLRC(text)          -> {lines: [{t, text, words?}], meta, offsetMs, synced}
 *   RSKaraoke.vocalsFromLRC(parsed)   -> karaoke vocals columns {t, d, w, j, l}, one per syllable
 *   RSKaraoke.syllabify(word)         -> ["e", "ve", "ry", "thing"]
 *   RSKaraoke.timeLine(words, t, next) -> syllable times of a line timed only by its start
 *   RSKaraoke.alignLRC(buf, lines, o) -> {offset, confidence, moved} (seconds)
 *   RSKaraoke.lookupLRCLIB(q)         -> LRC text from lrclib.net (browser fallback)
 *
 * Alignment (measured on songs with studio-timed syllables, LRC-like line jitter
 * of 150 ms, see docs): the song's centre channel is split into harmonic and
 * percussive parts (median filtering of the spectrogram), so drums do not count;
 * the rise of harmonic energy in the vocal band (250-3000 Hz) marks sung onsets.
 * Word onsets estimated from the LRC lines are slid over it (+-2 s around two
 * priors: no offset, and the difference of the track lengths); a shift is taken
 * only when it scores 8 % better than staying put, so lyrics that already fit
 * the recording stay where they are (and never with fewer than 8 lines).
 *
 * Syllables: LRC lyrics are timed per line (LRCLIB), sometimes per word
 * ("enhanced" LRC, <mm:ss.xx> tags). Words are split into syllables (English
 * heuristic) and highlighted one by one: word-timed lyrics at their own times,
 * line-timed ones by a timing model fitted to the sample songs' studio-timed
 * syllables (0.28 s per syllable, longer syllables a little longer, a breath
 * between words, never into the next line). Measured against those charts with
 * exact line times: median word-onset error 175 ms (44 % within 150 ms), the
 * sung word or its neighbour lit 81 % of the time -- an estimate, flagged in the player
 * ("\u2248 syllables"). Detecting syllable onsets in the mixed recording was
 * tried (spectral flux, harmonic/percussive split, centre-channel masks,
 * dynamic programming over onsets): no better than the model, so not used.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const K = (root.RSKaraoke = root.RSKaraoke || {});

  // ---- LRC ----------------------------------------------------------------------------
  const TAG = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  const WORD = /<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>/g;
  const secs = (m, s) => +m * 60 + +String(s).replace(":", ".");

  K.parseLRC = function (text) {
    const out = { lines: [], meta: {}, offsetMs: 0, synced: "none" };
    const raw = String(text || "").replace(/^\ufeff/, "").split(/\r?\n/);
    const timed = [], plain = [];
    for (const line of raw) {
      const meta = /^\s*\[([a-z#]+):(.*)\]\s*$/i.exec(line);
      if (meta && !/^\d/.test(meta[1])) {
        const k = meta[1].toLowerCase(), v = meta[2].trim();
        if (k === "offset") out.offsetMs = +v || 0; else out.meta[k] = v;
        continue;
      }
      const tags = [];
      let m, last = 0;
      TAG.lastIndex = 0;
      while ((m = TAG.exec(line)) && m.index === last) { tags.push(secs(m[1], m[2])); last = TAG.lastIndex; }
      const rest = line.slice(last);
      if (!tags.length) { if (rest.trim()) plain.push(rest.trim()); continue; }
      // enhanced LRC: <mm:ss.xx> before words
      let words = null;
      if (WORD.test(rest)) {
        words = [];
        const parts = rest.split(/(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)/);
        let t = null;
        for (const p of parts) {
          const w = /^<(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)>$/.exec(p);
          if (w) { t = secs(w[1], w[2]); continue; }
          for (const word of p.split(/\s+/).filter(Boolean)) { words.push({ t, w: word }); t = null; }
        }
      }
      WORD.lastIndex = 0;
      const txt = rest.replace(WORD, "").replace(/\s+/g, " ").trim();
      // word times relative to the line's first timestamp, so a repeated line gets its own
      const rel = words && words.length ? words.map((W) => ({ w: W.w, dt: W.t == null ? null : W.t - tags[0] })) : null;
      for (const t of tags) {
        timed.push({ t, text: txt, words: rel ? rel.map((W) => ({ w: W.w, t: W.dt == null ? null : t + W.dt })) : null });
      }
    }
    timed.sort((a, b) => a.t - b.t);
    const shift = out.offsetMs / 1000;                         // [offset:+ms] shows the lyrics sooner
    for (const L of timed) { L.t -= shift; if (L.words) for (const W of L.words) if (W.t != null) W.t -= shift; }
    if (timed.length) {
      out.lines = timed;
      out.synced = timed.some((L) => L.words && L.words.some((W) => W.t != null)) ? "word" : "line";
    } else {
      out.lines = plain.map((text) => ({ t: null, text }));
      out.synced = plain.length ? "none" : "empty";
    }
    return out;
  };

  // ---- syllables ----------------------------------------------------------------------------
  // English heuristic (vowel groups; silent final e / -es / -ed; V-CV, VC-CV, onset clusters
  // stay together; ta|ble; go|ing). Display and timing only -- it does not need to be perfect.
  const ONSET = new Set(["bl", "br", "cl", "cr", "dr", "fl", "fr", "gl", "gr", "pl", "pr", "sc", "sk", "sl", "sm", "sn",
    "sp", "st", "sw", "tr", "tw", "wr", "ch", "sh", "th", "ph", "wh", "qu"]);
  function syllabifyPart(s) {
    const low = s.toLowerCase(), n = low.length;
    const vow = (c) => /[aeiou]/.test(c || "");
    const isV = (i) => {
      const c = low[i];
      if (c === "y") return i > 0 && /[a-z]/.test(low[i - 1]) && !vow(low[i - 1]);
      return vow(c);
    };
    const groups = [];                                            // vowel groups [from, to)
    for (let i = 0; i < n;) {
      if (isV(i)) { let j = i + 1; while (j < n && vow(low[j])) j++; groups.push([i, j]); i = j; } else i++;
    }
    for (let k = 0; k < groups.length; k++) {                    // go|ing, see|ing, cry|ing
      const [a, b] = groups[k];
      if (b - a >= 2 && low[b - 1] === "i" && low.slice(b, b + 2) === "ng") { groups.splice(k, 1, [a, b - 1], [b - 1, b]); k++; }
    }
    for (let k = 0; k + 1 < groups.length; k++) {                // play|ing: the y stays in front
      const [a, b] = groups[k];
      if (low[b] === "y" && groups[k + 1][0] === b + 1) groups[k] = [a, b + 1];
    }
    let end = n; while (end > 0 && !/[a-z]/.test(low[end - 1])) end--;
    let le = false;
    if (groups.length > 1) {
      const g = groups[groups.length - 1], tail = low.slice(g[0], end), pre = low[g[0] - 1] || "";
      if (tail === "e") {
        if (pre === "l" && g[0] - 2 >= groups[groups.length - 2][1] && !vow(low[g[0] - 2])) le = true; else groups.pop();
      } else if (tail === "es" && !/[sxzgc]/.test(pre) && !/(ch|sh)$/.test(low.slice(0, g[0]))) groups.pop();
      else if (tail === "ed" && !/[td]/.test(pre)) groups.pop();
    }
    if (groups.length <= 1) return [s];
    const out = [];
    let p = 0;
    for (let k = 1; k < groups.length; k++) {
      const a = groups[k - 1][1], b = groups[k][0], cons = low.slice(a, b);
      let cut;
      if (le && k === groups.length - 1) cut = b - 2;              // ta|ble, lit|tle
      else if (cons.length <= 1) cut = a;                         // V-CV
      else if (cons.length === 2) cut = ONSET.has(cons) ? a : cons === "ck" || cons === "ng" ? b : a + 1;
      else cut = ONSET.has(cons.slice(-2)) ? b - 2 : b - 1;
      cut = Math.max(cut, groups[k - 1][0] + 1);
      if (cut > p && cut < n) { out.push(s.slice(p, cut)); p = cut; }
    }
    out.push(s.slice(p));
    return out;
  }
  /** "everything" -> ["e", "ve", "ry", "thing"]; hyphenated parts split first. */
  K.syllabify = (word) => String(word).split(/(?<=-)/).flatMap(syllabifyPart).filter((x) => x.length);

  // Syllable timing model for lyrics timed per line (fitted on songs with studio-timed
  // syllables, see docs): about 0.28 s per syllable, longer syllables take a little
  // longer (letters^0.5), a short breath between words, and never into the next line.
  const SYL = { per: 0.28, pause: 0.3, wexp: 0.5, gap: 0.3, minD: 0.2 };
  K.SYLLABLE_MODEL = SYL;
  const letters = (x) => Math.max(1, String(x).toLowerCase().replace(/[^a-z\u00c0-\u024f]/g, "").length);
  /**
   * words: [{w}] of one line, start: its time, next: start of the next line.
   * -> syllables [{t, d, w, j, wi}] (j: joins the next syllable; wi: word index)
   */
  K.timeLine = function (words, start, next) {
    const syl = [];
    words.forEach((W, wi) => {
      const parts = K.syllabify(W.w);
      parts.forEach((p, i) => syl.push({ w: p, j: i < parts.length - 1, wi, first: i === 0 }));
    });
    if (!syl.length) return [];
    const wt = syl.map((S) => Math.pow(letters(S.w), SYL.wexp));
    const mean = wt.reduce((a, b) => a + b, 0) / wt.length;
    let pos = 0;
    const at = syl.map((S, i) => {
      if (S.first && i > 0) pos += SYL.gap;
      const x = pos; pos += wt[i] / mean; return x;
    });
    const total = pos;
    const span = Math.max(SYL.minD, Math.min(next - start - SYL.pause, syl.length * SYL.per));
    return syl.map((S, i) => {
      const t = start + span * at[i] / total;
      const tn = i + 1 < syl.length ? start + span * at[i + 1] / total : start + span;
      return { t, d: Math.max(0.08, tn - t - 0.02), w: S.w, j: S.j, wi: S.wi };
    });
  };

  /** Karaoke vocals columns from parsed LRC, one entry per syllable. Word-synced
   *  (enhanced LRC): words at their own times, syllables spread over each word;
   *  line-synced: syllable times estimated from the line times (K.timeLine). */
  K.vocalsFromLRC = function (P) {
    const v = { t: [], d: [], w: [], j: [], l: [] };
    const L = P.lines.filter((x) => x.t != null && x.text);
    const push = (t, d, w, j, k) => { v.t.push(+t.toFixed(3)); v.d.push(+d.toFixed(3)); v.w.push(w); v.j.push(j ? 1 : 0); v.l.push(k); };
    L.forEach((line, k) => {
      const next = k + 1 < L.length ? L[k + 1].t : line.t + 6;
      const words = line.words ? line.words : line.text.split(/\s+/).filter(Boolean).map((w) => ({ t: null, w }));
      if (!words.some((W) => W.t != null)) {                    // line-synced
        for (const S of K.timeLine(words, line.t, next)) push(S.t, S.d, S.w, S.j, k);
        return;
      }
      let prevT = line.t;                                        // word-synced
      words.forEach((W, i) => {
        let t = W.t != null ? Math.max(W.t, prevT) : null, nt = next;
        for (let q = i + 1; q < words.length; q++) if (words[q].t != null) { nt = words[q].t; break; }
        if (t == null) t = prevT;                                // untimed word: with the previous one
        const parts = K.syllabify(W.w);
        const span = Math.max(0.08 * parts.length, Math.min(nt - t, 1.5, parts.length * SYL.per + 0.1));
        parts.forEach((p, q) => push(t + span * q / parts.length, Math.max(0.08, span / parts.length), p, q < parts.length - 1, k));
        prevT = t;
      });
    });
    return v;
  };

  // ---- audio features ---------------------------------------------------------------------
  /** Radix-2 FFT of size n with precomputed bit reversal and twiddles (in place). */
  function makeFFT(n) {
    const rev = new Uint32Array(n), cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit; rev[i] = j;
    }
    for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(-2 * Math.PI * k / n); sin[k] = Math.sin(-2 * Math.PI * k / n); }
    return function (re, im) {
      for (let i = 1; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1, step = n / len;
        for (let i = 0; i < n; i += len) {
          for (let k = 0; k < half; k++) {
            const p = i + k, q = p + half, wr = cos[k * step], wi = sin[k * step];
            const tr = re[q] * wr - im[q] * wi, ti = re[q] * wi + im[q] * wr;
            re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          }
        }
      }
    };
  }
  /** Sliding median of width w (odd) over n values src[off + stride * i] (edges
   *  repeat the end values), written to out[oOff + oStride * i]. A sorted window
   *  kept in `buf`: each step removes one value and inserts one (no allocation). */
  function slidingMedian(x, n, w, out, buf) {
    // x, out: contiguous Float32Arrays of length n; edges repeat the end values
    const h = w >> 1;
    let len = 0;
    for (let i = -h; i <= h; i++) {
      const v = x[i < 0 ? 0 : i >= n ? n - 1 : i];
      let q = len++; while (q > 0 && buf[q - 1] > v) { buf[q] = buf[q - 1]; q--; } buf[q] = v;
    }
    out[0] = buf[h];
    for (let c = 1; c < n; c++) {
      const a = c - h - 1, b = c + h;
      const vo = x[a < 0 ? 0 : a >= n ? n - 1 : a], vi = x[b >= n ? n - 1 : b];
      let q = 0; while (buf[q] !== vo) q++;
      for (; q < w - 1; q++) buf[q] = buf[q + 1];                 // remove the outgoing value
      q = w - 1; while (q > 0 && buf[q - 1] > vi) { buf[q] = buf[q - 1]; q--; } buf[q] = vi;   // insert the new one
      out[c] = buf[h];
    }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  /** Harmonic-energy onset strength of the centre channel, 100 frames/s. */
  K.vocalOnsets = async function (audioBuffer, T) {
    let t0 = performance.now(); const lap = (k) => { if (T) { const n = performance.now(); T[k] = Math.round(n - t0); t0 = n; } };
    const sr = audioBuffer.sampleRate, hop = Math.round(sr / 100), N = sr <= 8000 ? 512 : sr <= 16000 ? 1024 : 2048;
    const L = audioBuffer.getChannelData(0), R = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : L;
    const frames = Math.floor(L.length / hop) + 1;             // frame f is centred on sample f * hop
    const k0 = Math.ceil(150 * N / sr), k1 = Math.floor(3500 * N / sr), nb = k1 - k0 + 1;
    const b0 = Math.ceil(250 * N / sr) - k0, b1 = Math.floor(3000 * N / sr) - k0;
    const S = new Float32Array(frames * nb), win = new Float32Array(N), re = new Float64Array(N), im = new Float64Array(N), fft = makeFFT(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const M = new Float32Array(L.length + 2 * N);                // centre channel, zero-padded by N on both sides
    for (let i = 0; i < L.length; i++) M[N + i] = 0.5 * (L[i] + R[i]);
    for (let f = 0; f < frames; f += 2) {                      // two real frames per complex FFT
      const o = f * hop - N / 2, o2 = o + hop, two = f + 1 < frames;
      for (let i = 0, a = N + o, b = N + o2; i < N; i++) { re[i] = M[a + i] * win[i]; im[i] = two ? M[b + i] * win[i] : 0; }
      fft(re, im);
      for (let k = 0; k < nb; k++) {                           // X[k] = (Z[k] + conj Z[N-k]) / 2, Y[k] = (Z[k] - conj Z[N-k]) / 2i
        const kk = k0 + k, nk = (N - kk) & (N - 1);
        const xr = 0.5 * (re[kk] + re[nk]), xi = 0.5 * (im[kk] - im[nk]);
        S[f * nb + k] = Math.sqrt(xr * xr + xi * xi);
        if (two) { const yr = 0.5 * (im[kk] + im[nk]), yi = -0.5 * (re[kk] - re[nk]); S[(f + 1) * nb + k] = Math.sqrt(yr * yr + yi * yi); }
      }
      if ((f & 2047) === 0) await tick();
    }
    lap("stft");
    // harmonic (median over 17 frames) vs percussive (median over 17 bins)
    const H = new Float32Array(frames * nb), P = new Float32Array(frames * nb), buf = new Float32Array(17);
    const col = new Float32Array(frames), colM = new Float32Array(frames);
    for (let k = b0; k <= b1; k++) {                           // along time, per scored bin (copied out: contiguous)
      for (let f = 0; f < frames; f++) col[f] = S[f * nb + k];
      slidingMedian(col, frames, 17, colM, buf);
      for (let f = 0; f < frames; f++) H[f * nb + k] = colM[f];
      if ((k & 31) === 0) await tick();
    }
    const lo = Math.max(0, b0 - 8), hi = Math.min(nb - 1, b1 + 8), span = hi - lo + 1;   // frequency median: scored bins + context
    for (let f = 0; f < frames; f++) {                         // along frequency, per frame
      slidingMedian(S.subarray(f * nb + lo, f * nb + hi + 1), span, 17, P.subarray(f * nb + lo, f * nb + hi + 1), buf);
      if ((f & 4095) === 0) await tick();
    }
    lap("medians");
    const e = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let s = 0;
      for (let k = b0; k <= b1; k++) {
        const h = H[f * nb + k], p = P[f * nb + k], m = S[f * nb + k] * (h * h / (h * h + p * p + 1e-12));
        s += m * m;
      }
      e[f] = Math.log(1e-9 + s);
    }
    const fl = new Float32Array(frames);
    for (let f = 1; f < frames; f++) fl[f] = Math.max(0, e[f] - e[f - 1]);
    const out = new Float32Array(frames);                     // minus the 1 s moving average, >= 0
    let acc = 0;
    for (let f = 0; f < frames + 50; f++) {
      if (f < frames) acc += fl[f];
      if (f - 100 >= 0) acc -= fl[f - 100];
      const c = f - 50;
      if (c >= 0 && c < frames) out[c] = Math.max(0, fl[c] - acc / 100);
    }
    lap("flux");
    return out;
  };

  // ---- alignment -------------------------------------------------------------------------
  /** Estimated word onsets of LRC lines (the syllable model of K.timeLine). */
  K.estimatedOnsets = function (lines, starts) {
    const ev = [];
    lines.forEach((line, k) => {
      const s = starts[k], next = k + 1 < starts.length ? starts[k + 1] : s + 8;
      const words = [], seen = new Set();                        // prepared lines hold syllables: rejoin words
      let cur = "";
      for (const W of line.words) { cur += W.w; if (!W.j) { words.push({ w: cur }); cur = ""; } }
      if (cur) words.push({ w: cur });
      for (const S of K.timeLine(words, s, next)) if (!seen.has(S.wi)) { seen.add(S.wi); ev.push(S.t); }
    });
    return ev;
  };

  /**
   * buf: an AudioBuffer of this recording; lines: prepared karaoke lines (with
   * words); opts: {audioDuration, lrcDuration, window = 2, margin = 0.08}.
   * -> {offset (s, add to the lyric times), confidence (peak z-score), moved}
   */
  K.alignLRC = async function (buf, lines, opts) {
    opts = opts || {};
    if (lines.length < 8) return { offset: 0, confidence: 0, moved: false, reason: "too few lines to sync reliably" };
    const o = await K.vocalOnsets(buf), n = o.length;
    const box = new Float32Array(n);                           // +-100 ms
    let acc = 0;
    for (let i = 0; i < n + 10; i++) {
      if (i < n) acc += o[i];
      if (i - 21 >= 0) acc -= o[i - 21];
      const c = i - 10;
      if (c >= 0 && c < n) box[c] = acc;
    }
    const starts = lines.map((L) => L.start);
    const ev = K.estimatedOnsets(lines, starts).map((t) => Math.round(t * 100));
    const score = (lag) => { let s = 0; for (const e of ev) { const i = e + lag; if (i >= 0 && i < n) s += box[i]; } return s; };
    const W = Math.round(100 * (opts.window || 2));
    const priors = [0];
    const d = (+opts.audioDuration || 0) - (+opts.lrcDuration || 0);
    if (opts.lrcDuration && Math.abs(d) > 1 && Math.abs(d) < 30) priors.push(Math.round(d * 100));
    const all = [];
    let best = { s: -Infinity, lag: 0 }, at0 = { s: -Infinity, lag: 0 };
    for (const p of priors) {
      for (let lag = p - W; lag <= p + W; lag++) {
        const s = score(lag);
        all.push(s);
        if (s > best.s) best = { s, lag };
        if (Math.abs(lag) <= 5 && s > at0.s) at0 = { s, lag };
      }
    }
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const sd = Math.sqrt(all.reduce((a, b) => a + (b - mean) * (b - mean), 0) / all.length) || 1;
    const pick = best.s >= at0.s * (1 + (opts.margin == null ? 0.08 : opts.margin)) ? best : at0;
    return { offset: pick.lag / 100, confidence: +((pick.s - mean) / sd).toFixed(2), moved: pick !== at0 };
  };

  // ---- online lookup (browser fallback; the app and the exporters look up on the server) ---
  const clean = (s) => String(s || "").replace(/\s*[([].*?(live|remaster|version|edit|mix|mono|stereo|feat).*?[)\]]/gi, "").trim();
  const mainArtist = (s) => String(s || "").replace(/\s*[([]\s*(?:ft\.?|feat\.?|featuring|with)\s[^)\]]*[)\]]/gi, "")
    .split(/\s+(?:ft\.?|feat\.?|featuring|with|&|and|x)\s+|,/i)[0].trim();
  K.pickLRCLIB = function (results, q) {
    const dur = +q.duration || 0;
    const ok = (results || []).filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics));
    ok.sort((a, b) => (!!b.syncedLyrics - !!a.syncedLyrics) ||
      (dur ? Math.abs((a.duration || 0) - dur) - Math.abs((b.duration || 0) - dur) : 0));
    return ok[0] || null;
  };
  K.lookupLRCLIB = async function (q, fetchImpl) {
    const f = fetchImpl || root.fetch.bind(root), base = "https://lrclib.net/api/search?";
    const tries = [];
    const add = (a, t) => { const u = base + new URLSearchParams({ artist_name: a, track_name: t }); if (!tries.includes(u)) tries.push(u); };
    add(q.artist || "", q.title || ""); add(mainArtist(q.artist), clean(q.title));
    tries.push(base + new URLSearchParams({ q: `${mainArtist(q.artist)} ${clean(q.title)}`.trim() }));
    let reached = false;
    for (const u of tries) {
      try {
        const r = await f(u, { headers: { Accept: "application/json" } });
        reached = true;
        if (!r.ok) continue;
        const hit = K.pickLRCLIB(await r.json(), q);
        if (hit) return { lrc: hit.syncedLyrics || hit.plainLyrics, synced: hit.syncedLyrics ? "line" : "none",
                          lrcDuration: hit.duration || null, source: "lrclib", url: `https://lrclib.net/api/get/${hit.id}` };
      } catch (e) { /* offline, blocked (CORS): try the next query */ }
    }
    return reached ? null : { offline: true };
  };
})(window);
