// By ear: the demo song, the voice model (lyrics sync), the tuner's pitch and chord
// detection, and the chart drafts from a recording (Node >= 18):
//   node --test creator/tests/js/test-ear.js
// The demo song needs nothing; the checks on real recordings use songs/ when it is there.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { load, SONGS } = require("./load.js");
const R = load(), E = R.engine, V = R.voice, T = R.transcribe, D = R.dsp;

let demo = null;
async function getDemo() {
  if (!demo) { const score = E.demoScore(); demo = { score, audio: E.demoRender(score, 44100) }; }
  return demo;
}
function auc(p, lab) {
  const idx = Array.from(p.keys()).sort((a, b) => p[a] - p[b]);
  let pos = 0, neg = 0, sr = 0;
  idx.forEach((i, r) => { if (lab[i]) { pos++; sr += r + 1; } else neg++; });
  return (sr - pos * (pos + 1) / 2) / (pos * neg);
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function pluck(out, sr, t0, hz, dur, amp, rand) {
  const n0 = Math.floor(t0 * sr), len = Math.floor(dur * sr), p = Math.max(2, Math.round(sr / hz)), buf = new Float32Array(p);
  for (let i = 0; i < p; i++) buf[i] = rand() * 2 - 1;
  let idx = 0;
  for (let i = 0; i < len && n0 + i < out.length; i++) { const c = buf[idx]; buf[idx] = 0.997 * (0.5 * c + 0.5 * buf[(idx + 1) % p]); idx = (idx + 1) % p; out[n0 + i] += c * amp; }
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

test("the demo song: made from scratch, saved, read back with its charts, lyrics and audio", async () => {
  const made = await E.demoSong();
  assert.equal(made.project.meta.title, "Night Drive");
  const bytes = await E.projectSave(made.project, made.source);
  const re = await E.projectFromPsarc(bytes);
  const n = re.project.arrangements.map((a) => a.doc.levels[0].notes.length + a.doc.levels[0].chords.length);
  assert.deepEqual(n, [52, 48, 96]);
  assert.equal(re.project.vocals.syllables.length, 55);
  assert.ok(re.project.audio.duration > 30 && re.project.audio.codec === "pcm");
  assert.equal(re.project.art.names.length, 3);
});

test("voice model: where the demo's voice sings, and lyrics shifted by up to 2.5 s laid back over it", async () => {
  const { score, audio } = await getDemo();
  const v = await V.activity(audio.channels, 44100);
  const lab = new Uint8Array(v.p.length);
  for (const s of score.lyrics) for (let f = Math.round(s.time * 100); f < Math.round((s.time + s.length) * 100) && f < lab.length; f++) lab[f] = 1;
  const a = auc(v.p, lab);
  assert.ok(a > 0.8, "frame AUC " + a);
  // the sung phrases and the silences: the segments cover the singing and little else
  const seg = V.segments(v.p), inSeg = new Uint8Array(v.p.length);
  for (const g of seg) for (let f = Math.round(g.t0 * 100); f < Math.round(g.t1 * 100) && f < inSeg.length; f++) inSeg[f] = 1;
  let sung = 0, sungIn = 0, quiet = 0, quietIn = 0;
  for (let f = 0; f < lab.length; f++) { if (lab[f]) { sung++; sungIn += inSeg[f]; } else { quiet++; quietIn += inSeg[f]; } }
  // (the rest includes the breaths between lines, which a sung phrase bridges, and a bar of the intro the model
  // takes for a voice: the demo's voice is synthetic, the model learnt on real singers)
  assert.ok(sungIn / sung > 0.85 && quietIn / quiet < 0.45, "segments: " + (sungIn / sung).toFixed(2) + " of the singing, " + (quietIn / quiet).toFixed(2) + " of the rest");
  const ev = V.evidence(v.p), L = V.linesOf(score.lyrics);
  for (const G of [-2.5, -0.8, 0.6, 2.2]) {
    const moved = L.map((l) => ({ start: l.start + G, end: l.end + G, syl: l.syl.map(([t, d]) => [t + G, d]) }));
    const g = V.alignGlobal(moved, ev, { maxLag: 4 });
    assert.ok(Math.abs(G + g.shift) < 0.3, "shift " + G + ": off by " + (G + g.shift).toFixed(3));
  }
  // each line: lines also moved on their own (another take)
  const rand = rng(5);
  const jit = L.map((l) => { const d = 0.8 + (rand() - 0.5) * 0.5; return { start: l.start + d, end: l.end + d, syl: l.syl.map(([t, dd]) => [t + d, dd]) }; });
  const r = V.alignLines(jit, ev, { maxLag: 3 });
  const err = r.starts.map((t, i) => Math.abs(t - L[i].start)).sort((x, y) => x - y);
  assert.ok(err[err.length >> 1] < 0.3, "median line error " + err[err.length >> 1]);
});

test("tuner: YIN names every string of a guitar and a bass, within a few cents", () => {
  const sr = 48000, rand = rng(2);
  for (const m of [28, 33, 38, 43, 40, 45, 50, 55, 59, 64, 69, 76]) {
    const x = new Float32Array(sr);
    pluck(x, sr, 0, hz(m), 1, 0.5, rand);
    const y = T.yin(x.subarray(4800, 4800 + 4096), sr, { minHz: 35 });
    assert.ok(y.hz > 0, "MIDI " + m + ": no pitch");
    const got = T.midiOf(y.hz);
    assert.equal(Math.round(got), m, "MIDI " + m + " read as " + got.toFixed(2));
  }
});

test("tuner: strummed chords are named (G, C, D, Em, A, Am, E, Dm)", () => {
  const sr = 48000, n = 8192, fft = D.makeFFT(n), rand = rng(9), STD = [40, 45, 50, 55, 59, 64];
  const shapes = { G: [3, 2, 0, 0, 0, 3], C: [-1, 3, 2, 0, 1, 0], D: [-1, -1, 0, 2, 3, 2], Em: [0, 2, 2, 0, 0, 0], A: [-1, 0, 2, 2, 2, 0], Am: [-1, 0, 2, 2, 1, 0], E: [0, 2, 2, 1, 0, 0], Dm: [-1, -1, 0, 2, 3, 1] };
  for (const [name, frets] of Object.entries(shapes)) {
    const x = new Float32Array(sr);
    frets.forEach((f, s) => { if (f >= 0) pluck(x, sr, 0.05 + s * 0.012, hz(STD[s] + f), 0.9, 0.2, rand); });
    const acc = new Float64Array(n / 2 + 1), w = D.hann(n);
    for (const t of [0.2, 0.25, 0.3]) {
      const re = new Float64Array(n), im = new Float64Array(n), o = Math.floor(t * sr);
      for (let i = 0; i < n; i++) re[i] = (x[o + i] || 0) * w[i];
      fft(re, im);
      for (let k = 0; k <= n / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    }
    assert.equal(T.chordOfSpectrum(acc, sr, n).name, name);
  }
});

test("onto the fretboard: notes with little hand movement, playable chord shapes in any tuning", () => {
  const open = T.openStrings([0, 0, 0, 0, 0, 0], 6, false, 0);
  const line = [64, 67, 69, 71, 74, 76, 74, 71];
  const pos = T.placeNotes(line, open, { maxFret: 17 });
  pos.forEach((p, i) => assert.equal(open[p.string] + p.fret, line[i]));
  const frets = pos.map((p) => p.fret).filter((f) => f > 0);
  assert.ok(Math.max(...frets) - Math.min(...frets) <= 5, "a hand position: " + frets);
  for (const tun of [[0, 0, 0, 0, 0, 0], [-2, 0, 0, 0, 0, 0], [-1, -1, -1, -1, -1, -1]]) {
    const op = T.openStrings(tun, 6, false, 0);
    for (let r = 0; r < 12; r++) for (const q of ["maj", "min", "5"]) {
      const f = T.chordShape(r, q, op), used = f.map((x, s) => (x >= 0 ? (op[s] + x) % 12 : -1)).filter((x) => x >= 0);
      assert.ok(used.length >= 2, "a chord of " + r + q);
      const lowest = f.findIndex((x) => x >= 0);
      assert.equal((op[lowest] + f[lowest]) % 12, r, "the root is the lowest note");
      const tones = new Set((q === "maj" ? [0, 4, 7] : q === "min" ? [0, 3, 7] : [0, 7]).map((i) => (r + i) % 12));
      assert.ok(used.every((pc) => tones.has(pc)), "only chord tones: " + r + q + " " + f);
      const fr = f.filter((x) => x > 0);
      assert.ok(!fr.length || Math.max(...fr) - Math.min(...fr) <= 4, "a hand's span: " + f);
    }
  }
});

test("drafts from a recording: the demo's chords and bass roots", async () => {
  const { score, audio } = await getDemo();
  const an = await T.analyse(audio.channels, 44100);
  const ch = T.chordsOnBeats(an, score.beats);
  let ok = 0;
  for (const c of score.chords) { const e = ch.find((x) => Math.abs(x.time - c.time) < 0.01); if (e && e.root === (T.PC.indexOf(c.name.replace(/m$/, "")))) ok++; }
  const share = ok / score.chords.length;
  console.log("  demo: chord roots right on %d of %d beats", ok, score.chords.length);
  assert.ok(share >= 0.35, "chord roots " + share);
  const b = T.bassFromChords(an, ch);
  assert.equal(b.length, ch.length);
  assert.ok(b.every((x) => x.midi >= 28 && x.midi < 52));
});

const songs = fs.existsSync(SONGS) ? fs.readdirSync(SONGS).filter((f) => f.endsWith(".psarc")) : [];
const CN = songs.find((f) => /Comfortably-Numb_v6/.test(f)), RWTK = songs.find((f) => /Riding-With-The-King/.test(f));
test("real recordings (songs/): the voice model hears the singing, the chord draft finds the roots", { skip: !(CN && RWTK), timeout: 600000 }, async () => {
  const { songAudio, haveFfmpeg } = require("./audio.js");
  if (!haveFfmpeg()) return;
  for (const [f, minAuc] of [[RWTK, 0.7], [CN, 0.75]]) {
    const u8 = new Uint8Array(fs.readFileSync(path.join(SONGS, f))), { project } = await E.projectFromPsarc(u8);
    const au = await songAudio(E, u8, { channels: 2, sr: 22050 });
    const v = await V.activity(au.channels, au.sr);
    const lab = new Uint8Array(v.p.length);
    for (const s of project.vocals.syllables) for (let k = Math.round(s.time * 100); k < Math.round((s.time + Math.max(0.12, s.length)) * 100) && k < lab.length; k++) lab[k] = 1;
    const a = auc(v.p, lab);
    console.log("  %s: voice AUC %s", f.slice(0, 30), a.toFixed(3));
    assert.ok(a > minAuc, f + " AUC " + a);
    if (f === CN) {
      const an = await T.analyse(au.channels, au.sr), ch = T.chordsOnBeats(an, project.beats);
      const rh = project.arrangements.find((x) => x.kind === "rhythm"), lv = rh.doc.levels[0];
      let ok = 0, n = 0;
      for (const c of lv.chords) {
        const tp = rh.doc.chordTemplates[c.chordId], s = tp.frets.findIndex((x) => x >= 0);
        if (s < 0) continue;
        const root = ([40, 45, 50, 55, 59, 64][s] + (rh.doc.tuning[s] || 0) + tp.frets[s]) % 12;
        let i = -1;
        for (let k = 0; k < ch.length; k++) { if (ch[k].time <= c.time + 0.02) i = k; else break; }
        if (i < 0) continue;
        n++; ok += ch[i].root === root;
      }
      console.log("  %s: chord roots %s", f.slice(0, 30), (ok / n).toFixed(3));
      assert.ok(ok / n > 0.7, "roots " + ok / n);
    }
  }
});
