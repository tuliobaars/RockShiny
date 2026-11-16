/* Test helpers for check_sing.py: a synthetic singer and offline runs of the
 * karaoke worklets (rs-voice, rs-sing) in an OfflineAudioContext. */
(function (root) {
  "use strict";
  const T = (root.SingTest = {});
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
  T.rng = rng;
  // vowel formants (F, bandwidth) for /a/ /e/ /o/
  const VOWELS = [[[730, 90], [1090, 110], [2440, 170]], [[530, 70], [1840, 100], [2480, 150]], [[570, 80], [840, 100], [2410, 170]]];
  function formantGain(f, vowel) {
    let g = 0.02;
    for (const [F, B] of vowel) g += 1 / (1 + Math.pow((f - F) / (B / 2), 2));
    return g;
  }
  /**
   * A sung voice: notes [{t, d, midi}] -> Float32Array at sr.
   * opts: {vibrato (cents), rate (Hz), jitter (cents sd), noise (dB re voice, e.g. -20), seed, gain, breath}
   */
  T.voice = function (notes, sr, dur, opts) {
    opts = Object.assign({ vibrato: 30, rate: 5.5, jitter: 8, noise: -40, seed: 7, gain: 0.25, breath: 0.02 }, opts || {});
    const r = rng(opts.seed), n = Math.ceil(dur * sr), x = new Float32Array(n);
    for (const no of notes) {
      const i0 = Math.max(0, Math.round(no.t * sr)), i1 = Math.min(n, Math.round((no.t + no.d) * sr));
      if (i1 <= i0) continue;
      const f0 = 440 * Math.pow(2, (no.midi - 69) / 12), vowel = VOWELS[Math.floor(r() * 3)];
      const nh = Math.min(40, Math.floor((sr / 2 - 200) / f0));
      const amp = new Float64Array(nh + 1), ph = new Float64Array(nh + 1);
      for (let h = 1; h <= nh; h++) { amp[h] = formantGain(h * f0, vowel) / Math.pow(h, 0.9); ph[h] = r() * 2 * Math.PI; }
      let norm = 0; for (let h = 1; h <= nh; h++) norm += amp[h] * amp[h];
      norm = Math.sqrt(norm) || 1;
      const vphase = r() * 6.28, att = 0.03 * sr, rel = 0.05 * sr;
      let drift = 0;
      for (let i = i0; i < i1; i++) {
        const k = i - i0, env = Math.min(1, k / att, (i1 - i) / rel);
        if (k % 256 === 0) drift = 0.9 * drift + 0.1 * (r() - 0.5) * 2 * opts.jitter;
        const cents = opts.vibrato * Math.sin(vphase + 2 * Math.PI * opts.rate * k / sr) * Math.min(1, k / (0.3 * sr)) + drift;
        const f = f0 * Math.pow(2, cents / 1200);
        let s = 0;
        for (let h = 1; h <= nh; h++) { ph[h] += 2 * Math.PI * h * f / sr; s += amp[h] * Math.sin(ph[h]); }
        x[i] += opts.gain * env * (s / norm + opts.breath * (r() - 0.5));
      }
    }
    if (opts.noise > -90) {                          // background noise (half white, half brown), at `noise` dB re the voice's RMS
      let e = 0, m = 0; for (let i = 0; i < n; i++) if (x[i] !== 0) { e += x[i] * x[i]; m++; }
      const target = Math.sqrt(e / Math.max(1, m)) * Math.pow(10, opts.noise / 20);
      const z = new Float32Array(n); let b = 0, ez = 0;
      for (let i = 0; i < n; i++) { b = 0.98 * b + (r() - 0.5); z[i] = 0.5 * (r() - 0.5) + 0.1 * b; ez += z[i] * z[i]; }
      const k = target / Math.sqrt(ez / n);
      for (let i = 0; i < n; i++) x[i] += k * z[i];
    }
    if (opts.bleed && opts.bleedGain) {             // the song from the speakers (an AudioBuffer channel, same rate)
      const y = opts.bleed, off = Math.round((opts.bleedAt || 0) * sr);
      for (let i = 0; i < n && i + off < y.length; i++) x[i] += opts.bleedGain * y[i + off];
    }
    return x;
  };
  /** Notes from a karaoke song model (charted pitches), shifted / transposed. */
  T.notesOf = function (S, o) {
    o = Object.assign({ transpose: 0, octave: 0, late: 0, random: false, seed: 3, only: null }, o || {});
    const r = rng(o.seed), out = [];
    const all = S.lines.flatMap((L) => L.words.filter((W) => W.n != null).map((W) => W.n));
    const lo = Math.min(...all), hi = Math.max(...all);
    S.lines.forEach((L, k) => {
      if (o.only && !o.only(k)) return;
      for (const W of L.words) {
        if (W.n == null && !o.anyPitch) continue;
        const base = o.random ? lo + Math.floor(r() * (hi - lo + 1)) : (W.n != null ? W.n : o.anyPitch(k));
        out.push({ t: W.t + o.late, d: Math.max(0.12, W.d), midi: base + o.transpose + 12 * o.octave });
      }
    });
    return out;
  };
  /** Run a worklet over a buffer offline -> {frames: port messages, out: AudioBuffer, ms: render time}. */
  T.offline = async function (name, url, channels, sr, input, params, outCh) {
    const len = input[0].length;
    const ctx = new OfflineAudioContext(outCh || channels, len + 4096, sr);
    await ctx.audioWorklet.addModule(url);
    const buf = ctx.createBuffer(channels, len, sr);
    for (let c = 0; c < channels; c++) buf.copyToChannel(input[c], c);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const node = new AudioWorkletNode(ctx, name, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [outCh || channels],
      channelCount: channels, channelCountMode: "explicit" });
    for (const [k, v] of Object.entries(params || {})) node.parameters.get(k).value = v;
    const frames = [];
    node.port.onmessage = (e) => frames.push(e.data);
    src.connect(node).connect(ctx.destination);
    src.start();
    const t0 = performance.now();
    const out = await ctx.startRendering();
    const ms = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));     // the last port messages
    return { frames, out, ms };
  };
  /** Decode a URL to an AudioBuffer at sr. */
  T.decode = async function (url, sr) {
    const data = await (await fetch(url)).arrayBuffer();
    return await new OfflineAudioContext(2, sr, sr).decodeAudioData(data);
  };
})(window);
