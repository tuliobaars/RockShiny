/* ---------------------------------------------------------------------------
 * rsc-demo.js -- "Night Drive", a demo song made from scratch: an original
 * composition (E minor, 100 BPM: Em C G D), its lead, rhythm and bass charts,
 * lyrics sung by a synthesised voice, drums, album art -- and the audio played
 * from those very charts (plucked strings, a formant voice). No recording, no
 * rights needed: the Creator (and its tests) can always open a complete song,
 * and every note of it is known.
 *
 *   E.demoSong(opts) -> {project, source, score, stems}   (opts.platform, opts.sr)
 *   E.demoScore()    -> the composition: {bpm, offset, bars, chords, lead, bass, lyrics}
 *   E.demoRender(score, sr, opts) -> {channels: [L, R], sr, stems: {guitar, bass, drums, vocals}}
 *                       (opts.voiceGain: the voice's level; by default a little above the
 *                       guitars, as in a mix -- louder helps the voice model and hurts the
 *                       chord draft, and the other way round)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;
  const BPM = 100, BEAT = 60 / BPM, BAR = 4 * BEAT, OFFSET = 0.6;

  // ---- the composition -------------------------------------------------------------------------------------
  const SHAPES = {                       // standard-tuning open chords (string 0 = low E)
    Em: [0, 2, 2, 0, 0, 0], C: [-1, 3, 2, 0, 1, 0], G: [3, 2, 0, 0, 0, 3], D: [-1, -1, 0, 2, 3, 2]
  };
  const BASS_ROOT = { Em: [0, 0], C: [1, 3], G: [0, 3], D: [2, 0] };           // [string, fret] on a bass
  const LYRICS = [
    // verse
    "Ne-on lights a-cross the bay", "Mid-night calls me out to play", "En-gines hum and head-lights glow", "Down the har-bor road we go",
    // chorus
    "Drive, drive in-to the night", "Hold the wheel and hold on tight", "Ev-ery mile a brand new start", "Ne-on Har-bor in my heart"
  ];
  const MELODY = [                       // MIDI of each syllable, one line per bar (E minor)
    [64, 64, 67, 67, 69, 67, 64], [62, 62, 64, 67, 67, 64, 62], [60, 60, 64, 67, 67, 69, 71], [71, 69, 67, 67, 64, 62, 64],
    [71, 71, 69, 67, 69, 71], [67, 69, 71, 71, 69, 67, 69], [72, 71, 69, 67, 69, 71, 71], [71, 71, 69, 67, 67, 64, 64]
  ];
  E.demoScore = function () {
    const prog = ["Em", "C", "G", "D"], chorus = ["C", "G", "D", "Em"];
    const bars = [].concat(["Em", "C"], prog, chorus, ["Em", "Em"]);          // intro 2, verse 4, chorus 4, outro 2
    const t = (bar, beat) => Math.round((OFFSET + bar * BAR + beat * BEAT) * 1000) / 1000;
    const chords = [], bass = [], lead = [], lyrics = [];
    bars.forEach((c, b) => {
      for (let k = 0; k < 4; k++) chords.push({ time: t(b, k), name: c, frets: SHAPES[c], sustain: k === 3 ? BEAT * 0.9 : 0, repeat: k > 0 });
      for (let e = 0; e < 8; e++) {                                            // bass: eighths on the root, the 5th on the last
        const [s, f] = BASS_ROOT[c];
        const fifth = e === 7 && b % 2 === 1;
        bass.push({ time: t(b, e / 2), string: fifth ? Math.min(3, s + 1) : s, fret: fifth ? f + 2 : f, sustain: 0 });
      }
    });
    // lead: a lick in the gaps of the verse, a riff over the chorus, a solo at the end (E minor pentatonic, 12th position)
    const lick = [[0, 3, 14], [0.5, 3, 12], [1, 4, 12], [1.5, 4, 15], [2, 5, 12], [3, 5, 15]];             // [beat, string, fret]
    for (const bar of [2, 3, 4, 5]) for (const [bt, s, f] of lick.slice(3)) lead.push({ time: t(bar, bt + 0.0), string: s, fret: f, sustain: bt === 3 ? BEAT * 0.8 : 0 });
    const riff = [[0, 4, 12], [0.5, 4, 15], [1, 5, 12], [1.5, 4, 15], [2, 4, 12], [2.5, 3, 14], [3, 3, 12]];
    for (const bar of [6, 7, 8, 9]) for (const [bt, s, f] of riff) lead.push({ time: t(bar, bt), string: s, fret: f, sustain: bt === 3 ? BEAT * 0.9 : 0 });
    const solo = [[0, 5, 15], [0.5, 5, 12], [1, 4, 15], [1.5, 4, 12], [2, 3, 14], [2.5, 3, 12], [3, 2, 14], [4, 3, 14], [4.5, 4, 12], [5, 4, 15], [6, 5, 12], [7, 5, 15]];
    for (const [bt, s, f] of solo) lead.push({ time: t(10, bt), string: s, fret: f, sustain: bt === 7 ? BEAT * 1.5 : 0 });
    // lyrics: one line per bar of the verse and the chorus, sung from beat 0.5 to beat 3 (eighths, a sixteenth
    // in the 7-syllable lines), then a breath
    const RHYTHM = { 6: [0.5, 1, 1.5, 2, 2.5, 3], 7: [0.5, 1, 1.25, 1.5, 2, 2.5, 3] };
    LYRICS.forEach((line, li) => {
      const bar = 2 + li, syl = [];
      line.split(" ").forEach((w) => w.split("-").forEach((p, i, a) => syl.push(p + (i < a.length - 1 ? "-" : ""))));
      const at = RHYTHM[syl.length] || syl.map((_, k) => 0.5 + k * 0.5);
      syl.forEach((s, k) => {
        const last = k === syl.length - 1, len = last ? BEAT * 0.7 : Math.min(BEAT * 0.45, (at[k + 1] - at[k]) * BEAT * 0.9);
        lyrics.push({ time: t(bar, at[k]), length: Math.round(len * 1000) / 1000, lyric: last ? s.replace(/[,]$/, "") + "+" : s.replace(/,$/, ""), note: MELODY[li][k] || 64 });
      });
    });
    const sections = [["intro", 0], ["verse", 2], ["chorus", 6], ["outro", 10]].map(([name, bar], i) => ({ name, number: 1, startTime: t(bar, 0) }));
    const beats = [];
    for (let i = 0; i <= bars.length * 4 + 4; i++) beats.push({ time: Math.round((OFFSET + i * BEAT) * 1000) / 1000, measure: i % 4 === 0 ? i / 4 + 1 : -1 });
    return { bpm: BPM, offset: OFFSET, bars, chords, lead, bass, lyrics, sections, beats, length: OFFSET + bars.length * BAR + 2.2 };
  };

  // ---- the audio, played from the charts ---------------------------------------------------------------------
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function pluck(out, sr, t0, hz, dur, amp, bright, pan, rand) {
    const n0 = Math.floor(t0 * sr), len = Math.floor(Math.min(dur + 0.35, 4) * sr), p = Math.max(2, Math.round(sr / hz));
    const buf = new Float32Array(p);
    for (let i = 0; i < p; i++) buf[i] = rand() * 2 - 1;
    let idx = 0;
    const decay = 0.996 + 0.0035 * Math.min(1, dur / 2), gl = amp * Math.cos((pan + 1) * Math.PI / 4), gr = amp * Math.sin((pan + 1) * Math.PI / 4);
    for (let i = 0; i < len; i++) {
      const j = n0 + i;
      if (j >= out[0].length) break;
      const cur = buf[idx], nxt = buf[(idx + 1) % p];
      buf[idx] = decay * (bright * cur + (1 - bright) * nxt);
      idx = (idx + 1) % p;
      const env = i < len - 0.05 * sr ? 1 : (len - i) / (0.05 * sr);
      if (j >= 0) { out[0][j] += cur * gl * env; out[1][j] += cur * gr * env; }
    }
  }
  function drums(out, sr, beats, end, rand) {
    beats.forEach((b, i) => {
      const t = b.time;
      if (t > end) return;
      const inBar = i % 4, n0 = Math.floor(t * sr);
      if (inBar === 0 || inBar === 2) for (let k = 0; k < 0.18 * sr; k++) {
        const j = n0 + k; if (j >= out[0].length) break;
        const tt = k / sr, f = 50 + 70 * Math.exp(-tt * 25), v = 0.55 * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 18);
        out[0][j] += v; out[1][j] += v;
      }
      if (inBar === 1 || inBar === 3) { let lp = 0; for (let k = 0; k < 0.15 * sr; k++) { const j = n0 + k; if (j >= out[0].length) break; const nz = rand() * 2 - 1; lp = 0.6 * lp + 0.4 * nz; const v = 0.28 * (nz - lp) * Math.exp(-k / sr * 25); out[0][j] += v; out[1][j] += v; } }
      for (const ht of [t, t + BEAT / 2]) { const h0 = Math.floor(ht * sr); let prev = 0; for (let k = 0; k < 0.04 * sr; k++) { const j = h0 + k; if (j >= out[0].length) break; const nz = rand() * 2 - 1, v = 0.08 * (nz - prev) * Math.exp(-k / sr * 90); prev = nz; out[0][j] += v * 0.5; out[1][j] += v; } }
    });
  }
  const VOWELS = { a: [730, 1090, 2440], e: [530, 1840, 2480], i: [300, 2290, 3010], o: [570, 840, 2410], u: [300, 870, 2240] };
  function vowelOf(s) { const m = s.toLowerCase().match(/[aeiouy]/); return VOWELS[m ? (m[0] === "y" ? "i" : m[0]) : "a"]; }
  const VOICE_GAIN = 0.003;              // the voice a little above the guitars, as in a mix
  function voice(out, sr, lyrics, rand, gain) {
    for (const s of lyrics) {
      const n0 = Math.floor(s.time * sr), len = Math.floor(Math.max(0.12, s.length) * sr), F = vowelOf(s.lyric), f0 = midiHz(s.note);
      let ph = 0, lp = 0;
      const y = [0, 0, 0], y2 = [0, 0, 0], cons = /^[^aeiouy]/i.test(s.lyric.replace(/[^a-z]/gi, "") || "a");
      for (let i = 0; i < len; i++) {
        const j = n0 + i;
        if (j >= out[0].length) break;
        const tt = i / sr, glide = tt < 0.05 ? Math.pow(2, -0.7 * (0.05 - tt) / 12 / 0.05) : 1;
        const vib = 1 + (tt > 0.12 ? 0.018 * Math.min(1, (tt - 0.12) / 0.15) * Math.sin(2 * Math.PI * 5.5 * tt) : 0);   // a singer's vibrato
        ph += f0 * glide * vib / sr;
        lp = 0.7 * lp + 0.3 * (2 * (ph % 1) - 1);                            // a buzz (a softened saw), some breath,
        const src = lp + 0.12 * (rand() * 2 - 1);                            // through three formants
        let v = 0;
        for (let q = 0; q < 3; q++) {
          const r = Math.exp(-Math.PI * 100 / sr), th = 2 * Math.PI * F[q] / sr;
          const o = src + 2 * r * Math.cos(th) * y[q] - r * r * y2[q];
          y2[q] = y[q]; y[q] = o; v += o * (q === 0 ? 1 : q === 1 ? 0.6 : 0.3);
        }
        let env = Math.min(1, tt / 0.03, (len - i) / (0.04 * sr));
        let o = gain * v * env;
        if (cons && tt < 0.04) o += 0.004 * (rand() * 2 - 1) * (1 - tt / 0.04);   // a consonant: a burst of noise
        out[0][j] += o; out[1][j] += o;
      }
    }
  }
  E.demoRender = function (score, sr, opts) {
    sr = sr || 44100;
    const n = Math.floor(score.length * sr), mk = () => [new Float32Array(n), new Float32Array(n)], rand = rng(7);
    const st = { guitar: mk(), bass: mk(), drums: mk(), vocals: mk() }, STD = [40, 45, 50, 55, 59, 64];
    for (const c of score.chords) c.frets.forEach((f, s) => { if (f >= 0) pluck(st.guitar, sr, c.time + s * 0.012, midiHz(STD[s] + f), c.sustain || BEAT * 0.9, c.repeat ? 0.16 : 0.2, 0.5, -0.5, rand); });
    for (const x of score.lead) pluck(st.guitar, sr, x.time, midiHz(STD[x.string] + x.fret), Math.max(x.sustain, 0.3), 0.22, 0.6, 0.45, rand);
    for (const x of score.bass) pluck(st.bass, sr, x.time, midiHz(STD[x.string] - 12 + x.fret), Math.max(x.sustain, BEAT * 0.45), 0.5, 0.2, 0, rand);
    drums(st.drums, sr, score.beats, score.length - 2, rand);
    voice(st.vocals, sr, score.lyrics, rand, (opts && opts.voiceGain) || VOICE_GAIN);
    const L = new Float32Array(n), R = new Float32Array(n);
    let peak = 0;
    for (const k of Object.keys(st)) for (let i = 0; i < n; i++) { L[i] += st[k][0][i]; R[i] += st[k][1][i]; }
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const g = 0.9 / (peak || 1);
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
    for (const k of Object.keys(st)) for (const c of st[k]) for (let i = 0; i < n; i++) c[i] *= g;
    return { channels: [L, R], sr, stems: st };
  };

  /** Album art: a neon road at night (an RGBA image, drawn in code). */
  function art(w) {
    const px = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      const u = x / w, v = y / w, o = (y * w + x) * 4;
      let r = 20 + 60 * v, g = 10 + 20 * v, b = 50 + 80 * (1 - v);
      const sun = Math.hypot(u - 0.5, v - 0.42);
      if (sun < 0.2 && v < 0.52 && !(v > 0.36 && Math.floor(v * 60) % 3 === 0)) { r = 255; g = 120 + 100 * (0.42 - v) / 0.2; b = 60; }
      if (v > 0.55) {                                                           // the road: lines to the horizon
        const d = Math.abs(u - 0.5) / (v - 0.5 + 1e-3);
        if (Math.abs(d - 0.9) < 0.06 || Math.abs(d - 0.3) < 0.03) { r = 245; g = 165; b = 36; }
        else if (Math.floor((v - 0.55) * 40 + 1 / (v - 0.5)) % 2 === 0 && d < 0.05) { r = 255; g = 220; b = 150; }
        else { r *= 0.5; g *= 0.5; b *= 0.8; }
      }
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
    }
    return { rgba: px, width: w, height: w };
  }

  /** The demo as a Creator project, ready to edit and save. */
  E.demoSong = async function (opts) {
    opts = opts || {};
    const score = E.demoScore(), audio = E.demoRender(score, opts.sr || 44100);
    const made = await E.projectNew({
      title: "Night Drive", artist: "RockShiny Demo", album: "Neon Harbor", year: 2025, platform: opts.platform || "pc",
      audio: { channels: audio.channels, sampleRate: audio.sr }, beats: score.beats, bpm: BPM, sections: score.sections,
      arrangements: [{ kind: "lead" }, { kind: "rhythm" }, { kind: "bass" }], art: art(256)
    });
    const { project } = made, nd = E.NOTE_DEFAULTS;
    const [lead, rhythm, bass] = project.arrangements;
    lead.doc.levels[0].notes = score.lead.map((x) => Object.assign({}, nd, { time: x.time, string: x.string, fret: x.fret, sustain: Math.round(x.sustain * 1000) / 1000, bendValues: [] }));
    lead.doc.levels[0].anchors = [{ time: score.lead[0].time, fret: 12, width: 4 }];
    const rl = rhythm.doc.levels[0], ids = {};
    for (const c of score.chords) {
      if (ids[c.name] == null) { rhythm.doc.chordTemplates.push({ chordName: c.name, displayName: c.name, frets: c.frets.slice(), fingers: c.frets.map(() => -1) }); ids[c.name] = rhythm.doc.chordTemplates.length - 1; }
      rl.chords.push({ time: c.time, linkNext: 0, accent: 0, chordId: ids[c.name], fretHandMute: 0, highDensity: c.repeat ? 1 : 0, ignore: 0, palmMute: 0, hopo: 0, strum: "down",
        chordNotes: c.frets.map((f, s) => (f >= 0 ? Object.assign({}, nd, { time: c.time, string: s, fret: f, sustain: Math.round(c.sustain * 1000) / 1000, bendValues: [] }) : null)).filter(Boolean) });
    }
    rl.anchors = [{ time: score.chords[0].time, fret: 1, width: 4 }];
    bass.doc.levels[0].notes = score.bass.map((x) => Object.assign({}, nd, { time: x.time, string: x.string, fret: x.fret, sustain: 0, bendValues: [] }));
    bass.doc.levels[0].anchors = [{ time: score.bass[0].time, fret: 1, width: 4 }];
    project.vocals = { id: null, syllables: score.lyrics.map((s) => ({ time: s.time, length: Math.round(s.length * 1000) / 1000, lyric: s.lyric, note: s.note })), origin: null, edited: true };
    project.sectionsEdited = true;
    made.score = score;
    made.stems = audio.stems;
    return made;
  };
})(typeof window !== "undefined" ? window : globalThis);
