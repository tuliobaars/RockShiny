// DSP tests (Node >= 18): node --test creator/tests/js/test-dsp.js
// Beat tracking, stem separation and lyrics sync on signals whose answer is known.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { load, SONGS } = require("./load.js");
const { makeSong } = require("./synth.js");
const R = load(), E = R.engine, B = R.beats, ST = R.stems, S = R.sync;

function clickTrack(bpm, seconds, sr, perBar, offset) {
  const x = new Float32Array(Math.floor(seconds * sr)), beats = [];
  for (let t = offset, i = 0; t < seconds; t += 60 / bpm, i++) {
    beats.push(t);
    const down = i % perBar === 0, n0 = Math.floor(t * sr), f = down ? 60 : 200;
    for (let k = 0; k < 0.12 * sr && n0 + k < x.length; k++) {
      const tt = k / sr;
      x[n0 + k] += (down ? 0.9 : 0.45) * Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 30);
      // a bass note that changes on the downbeat (what the bar detector listens for)
      if (down) x[n0 + k] += 0.3 * Math.sin(2 * Math.PI * [41.2, 55, 49, 61.7][(i / perBar) % 4] * tt);
    }
    // eighth-note hi-hats (real music has the subdivisions that tell a beat from its half)
    for (const h of [t, t + 30 / bpm]) {
      const h0 = Math.floor(h * sr);
      for (let k = 0; k < 0.03 * sr && h0 + k < x.length; k++) x[h0 + k] += 0.12 * (((k * 2654435761) >>> 0) / 4294967296 - 0.5) * Math.exp(-k / sr * 120);
    }
  }
  return { x, beats };
}

test("beat tracker: tempo, beats and bars of click tracks", () => {
  for (const [bpm, off] of [[120, 0.37], [96, 0.8], [132, 0.1]]) {
    const sr = 22050, { x, beats } = clickTrack(bpm, 40, sr, 4, off);
    const r = B.track([x], sr, { beatsPerBar: 4 });
    assert.ok(Math.abs(r.bpm - bpm) / bpm < 0.01, bpm + " -> " + r.bpm);
    const f = B.fMeasure(r.beats.filter((t) => t > 1 && t < 39), beats.filter((t) => t > 1 && t < 39)).f;
    assert.ok(f > 0.97, bpm + " F " + f);
    const downs = r.grid.filter((g) => g.measure > 0).map((g) => g.time), ref = beats.filter((_, i) => i % 4 === 0);
    assert.ok(B.fMeasure(downs.filter((t) => t > 1 && t < 39), ref.filter((t) => t > 1 && t < 39)).f > 0.9, bpm + " bars");
  }
});

test("beat tracker: a fast tempo is found, or its half (the x2 button's job)", () => {
  const sr = 22050, { x } = clickTrack(142, 30, sr, 4, 0.2);
  const r = B.track([x], sr, { beatsPerBar: 4 });
  assert.ok([1, 0.5, 2].some((m) => Math.abs(r.bpm / (142 * m) - 1) < 0.01), "142 -> " + r.bpm);
  assert.ok(Math.abs(B.track([x], sr, { bpm: 140 }).bpm - 142) < 1.5, "with a tempo hint");
});

test("stems: a chart-driven synthetic mix separates and the stems add up to the mix", { skip: !fs.existsSync(SONGS) }, async () => {
  const f = path.join(SONGS, "Dire-Straits_Sultans-of-Swing_v443_m.psarc");
  if (!fs.existsSync(f)) return;
  const { project } = await E.projectFromPsarc(new Uint8Array(fs.readFileSync(f)));
  const sr = 22050, t0 = 16, secs = 12;
  const song = makeSong(project, t0 + secs, sr);
  const p2 = JSON.parse(JSON.stringify(project));
  p2.arrangements = p2.arrangements.filter((a) => a.kind !== "rhythm");     // the synthetic mix plays lead and bass
  const sep = await ST.separate(song.mix, sr, ST.guideFromProject(p2), { range: [t0, t0 + secs] });
  const cut = (x) => x.subarray(Math.floor(t0 * sr), Math.floor(t0 * sr) + sep.stems.vocals[0].length);
  const gain = {};
  for (const id of ["vocals", "guitar", "bass", "drums", "other"]) {
    const est = ST.toFloat(sep.stems[id]), ref = song.stems[id].map(cut), mix = song.mix.map(cut);
    gain[id] = ST.sdr(est[0], ref[0]) - ST.sdr(mix[0], ref[0]);
  }
  console.log("  SDR improvement over the mix (dB): " + Object.entries(gain).map(([k, v]) => k + " " + v.toFixed(1)).join(", "));
  for (const id of ["vocals", "guitar", "drums", "other"]) assert.ok(gain[id] > 3, id + " " + gain[id]);
  assert.ok(gain.bass > 1, "bass " + gain.bass);
  const sum = new Float32Array(sep.stems.vocals[0].length);
  for (const id of sep.ids) { const x = sep.stems[id][0]; for (let i = 0; i < sum.length; i++) sum[i] += x[i] / 32768; }
  const recon = ST.sdr(sum, cut(song.mix[0]));
  console.log("  stems summed vs the mix: " + recon.toFixed(1) + " dB");
  assert.ok(recon > 30, "stems add up to the mix: " + recon);
});

test("lyrics sync: the activity fit finds a known shift; the drift fit and retiming", () => {
  const syl = [];
  for (let t = 10; t < 100; t += 7) for (let k = 0; k < 5; k++) syl.push({ time: t + k * 0.4, length: 0.3, lyric: "la" + (k === 4 ? "+" : ""), note: 254 });
  const pres = new Float32Array(120 * 100).fill(-0.5);
  for (const s of syl) for (let i = Math.round((s.time + 1.23) * 100); i < Math.round((s.time + 1.23 + s.length) * 100); i++) pres[i] = 1.5;
  assert.ok(Math.abs(S.activityLag(syl, pres, 3) - 1.23) < 0.015);
  const fit = S.fitDrift([[10, 12], [100, 104.5]]);
  assert.deepEqual(S.applyDrift([10, 100], fit), [12, 104.5]);
  const lines = S.lineIndex(syl);
  assert.equal(lines[4], 0); assert.equal(lines[5], 1);
  const moved = S.retime(syl, lines, lines.filter((l, i) => i === 0 || lines[i - 1] !== l).map((l, i) => 20 + i * 7));
  assert.equal(moved[0].time, 20); assert.equal(moved[5].time, 27);
});
