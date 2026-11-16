/* ---------------------------------------------------------------------------
 * rsc-sync.js -- lyrics re-timed to the recording.
 *
 * Auto-sync (one shift for the whole lyrics, which LRC lyrics timed on *a*
 * recording need): first S.activityLag() lays the lyrics' phrases and pauses over
 * where the recording's centre channel sings -- robust, never seconds off -- then
 * RockShiny's onset aligner (karaoke-sync.js, alignLRC) fine-tunes within
 * +-0.8 s. Measured on the sample songs with studio-timed lyrics shifted by up to
 * +-2.5 s: median line error 0.30 s, worst 0.72 s (RockShiny's aligner alone:
 * 9 of 39 trials more than 1 s off). Per-line acoustic snapping was measured and
 * left out: no vocal-onset feature of the mixes told a line start from the
 * times around it (AUC ~0.5). The manual tools are here too: a drift fit through
 * placed lines (lyrics of another take), tap-along timing, moving a line's syllables.
 *
 *   RSCreator.sync.presence(channels, sr)          where the centre channel sings (100 fps)
 *   RSCreator.sync.activityLag(syl, presence, max) the shift that fits the lyrics' phrases
 *   RSCreator.sync.fitDrift(pairs)                 -> {a, b}: t' = a * t + b
 *   RSCreator.sync.applyDrift(starts, fit)         -> new line starts
 *   RSCreator.sync.retime(syllables, lineOf, starts)
 *   RSCreator.sync.lineIndex(syllables)            line of each syllable ("+" ends one)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const S = (RSC.sync = RSC.sync || {});

  /** Least-squares line t' = a t + b through (t, t') pairs (lyrics timed on another take). */
  S.fitDrift = function (pairs) {
    const n = pairs.length;
    if (n < 2) return { a: 1, b: n ? pairs[0][1] - pairs[0][0] : 0 };
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1), b = (sy - a * sx) / n;
    return { a, b };
  };

  /**
   * Where a voice sings, 100 frames/s: the level of the centre of the stereo image
   * (mid minus side) in the voice band (250-3500 Hz), in dB, minus its 4 s
   * moving average, z-scored. channels: [L, R] Float32Array.
   */
  S.presence = function (channels, sr) {
    const D = RSC.dsp, L = channels[0], R = channels[1] || channels[0], n = L.length;
    const hop = Math.round(sr / 100), N = sr > 30000 ? 4096 : 2048;
    const M = new Float32Array(n), Sd = new Float32Array(n);
    for (let i = 0; i < n; i++) { M[i] = 0.5 * (L[i] + R[i]); Sd[i] = 0.5 * (L[i] - R[i]); }
    const maxBin = Math.ceil(4000 * N / sr);
    const sm = D.stftMag(M, sr, N, hop, { maxBin }), ss = D.stftMag(Sd, sr, N, hop, { maxBin });
    const k0 = Math.ceil(250 * N / sr), k1 = Math.floor(3500 * N / sr), raw = new Float32Array(sm.frames);
    for (let f = 0; f < sm.frames; f++) {
      let e = 0;
      for (let k = k0; k <= k1; k++) { const v = Math.max(0, sm.mag[f * sm.bins + k] - 1.5 * ss.mag[f * ss.bins + k]); e += v * v; }
      raw[f] = Math.log(1e-7 + e);
    }
    const w = 200, out = new Float32Array(raw.length);
    let acc = 0;
    for (let i = 0; i < raw.length + w; i++) {
      if (i < raw.length) acc += raw[i];
      if (i - 2 * w - 1 >= 0) acc -= raw[i - 2 * w - 1];
      const c = i - w;
      if (c >= 0 && c < raw.length) out[c] = raw[c] - acc / (Math.min(raw.length, c + w + 1) - Math.max(0, c - w));
    }
    let m = 0, sd = 0;
    for (const v of out) m += v;
    m /= out.length || 1;
    for (const v of out) sd += (v - m) * (v - m);
    sd = Math.sqrt(sd / (out.length || 1)) || 1;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) / sd;
    return out;
  };

  /**
   * The shift (s) that lays the lyrics' singing (their syllables) over the recording's
   * singing (S.presence): the pattern of phrases and pauses over the whole song, so the
   * answer does not depend on where the lyrics start (no jumps of seconds); accurate to
   * a few hundred ms. maxLag: search range (s); prior: a likely shift to centre it on.
   */
  S.activityLag = function (syllables, presence, maxLag, prior) {
    const n = presence.length, act = [];
    for (const s of syllables) {
      const a = Math.round(s.time * 100), b = Math.round((s.time + Math.max(0.1, s.length)) * 100);
      for (let i = a; i < b; i++) act.push(i);
    }
    const c = Math.round((prior || 0) * 100), K = Math.round((maxLag || 3) * 100);
    let best = -Infinity, lag = c;
    for (let d = c - K; d <= c + K; d++) {
      let sc = 0;
      for (const i of act) { const j = i + d; if (j >= 0 && j < n) sc += presence[j]; }
      if (sc > best) { best = sc; lag = d; }
    }
    return lag / 100;
  };

  S.applyDrift = (starts, fit) => starts.map((t) => Math.round((fit.a * t + fit.b) * 1000) / 1000);

  /**
   * Move the syllables of each line so that the line starts at its new time
   * (syllables keep their offsets inside the line; never past the next line).
   * syllables: [{time, length, lyric, note}] with line index `line` (from lineIndex()).
   */
  S.retime = function (syllables, lineOf, newStarts) {
    const firstOf = [];
    syllables.forEach((s, i) => { const l = lineOf[i]; if (firstOf[l] == null) firstOf[l] = s.time; });
    const out = syllables.map((s, i) => {
      const l = lineOf[i], d = newStarts[l] - firstOf[l];
      return Object.assign({}, s, { time: Math.round((s.time + d) * 1000) / 1000 });
    });
    for (let i = 0; i + 1 < out.length; i++) {
      const room = out[i + 1].time - out[i].time;
      if (out[i].length > room - 0.02) out[i].length = Math.max(0.05, Math.round((room - 0.02) * 1000) / 1000);
    }
    return out;
  };

  /** Line index of each syllable (Rocksmith "+" ends a line). */
  S.lineIndex = function (syllables) {
    let l = 0;
    return syllables.map((s) => { const cur = l; if (/\+$/.test(s.lyric || "")) l++; return cur; });
  };
})(typeof window !== "undefined" ? window : globalThis);
