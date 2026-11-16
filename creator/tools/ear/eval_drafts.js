#!/usr/bin/env node
// How good the drafts from a recording are (rsc-transcribe.js), on the songs decoded by prep.js:
//   node creator/tools/ear/eval_drafts.js [cache-dir]
//   chords   the root of the drafted chord on each of the rhythm chart's chords (the chart's own
//            lowest note's pitch class), for songs with a rhythm chart of 50+ chords
//   bass     the drafted bass notes against the bass chart: F-measure (onset within 0.1 s, the
//            same MIDI note), and with any octave (pitch class)
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const { load } = require("../../tests/js/load.js");
const T = load().transcribe;
const cache = process.argv[2] || path.join(os.tmpdir(), "rsc-ear");
const rd = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
function rootOf(ms) { if (!ms.length) return null; return Math.round(Math.min(...ms)) % 12; }
function fmeasure(est, ref, tol, eq) {
  ref = ref.slice().sort((a, b) => a[0] - b[0]);
  const used = new Set();
  let tp = 0;
  for (const [t, m] of est.slice().sort((a, b) => a[0] - b[0])) {
    let best = -1;
    for (let i = 0; i < ref.length; i++) {
      if (used.has(i)) continue;
      if (ref[i][0] > t + tol) break;
      if (Math.abs(ref[i][0] - t) <= tol && eq(Math.round(m), Math.round(ref[i][1])) && (best < 0 || Math.abs(ref[i][0] - t) < Math.abs(ref[best][0] - t))) best = i;
    }
    if (best >= 0) { used.add(best); tp++; }
  }
  const p = tp / Math.max(1, est.length), r = tp / Math.max(1, ref.length);
  return (2 * p * r) / Math.max(1e-9, p + r);
}
(async () => {
  const roots = [], bf = [], bpc = [];
  for (const j of fs.readdirSync(cache).filter((x) => x.endsWith(".json")).sort()) {
    const base = path.join(cache, j.replace(/\.json$/, "")), meta = JSON.parse(fs.readFileSync(base + ".json"));
    const rh = meta.arrs.find((a) => a.kind === "rhythm" && a.chords.length > 50), bs = meta.arrs.find((a) => a.kind === "bass" && a.notes.length);
    if (!rh && !bs) continue;
    const an = await T.analyse([rd(base + ".L.f32"), rd(base + ".R.f32")], 22050), ch = T.chordsOnBeats(an, meta.beats);
    let line = j.slice(0, 40).padEnd(40);
    if (rh) {
      let ok = 0, n = 0;
      for (const c of rh.chords) {
        const r = rootOf(c.ms);
        if (r == null) continue;
        let i = -1;
        for (let k = 0; k < ch.length; k++) { if (ch[k].time <= c.t + 0.02) i = k; else break; }
        if (i < 0) continue;
        n++; ok += ch[i].root === r;
      }
      roots.push(ok / n); line += " chord roots " + (ok / n).toFixed(2);
    }
    if (bs) {
      const est = T.bassFromChords(an, ch).map((x) => [x.time, x.midi]), ref = bs.notes.map((n) => [n.t, n.m]);
      bf.push(fmeasure(est, ref, 0.1, (a, c) => a === c)); bpc.push(fmeasure(est, ref, 0.1, (a, c) => (a - c) % 12 === 0));
      line += "  bass F " + bf[bf.length - 1].toFixed(2) + " (any octave " + bpc[bpc.length - 1].toFixed(2) + ")";
    }
    console.log(line);
  }
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log("\nchord roots right: %s of the chords (%d songs); bass draft F %s (any octave %s; %d songs)", mean(roots).toFixed(3), roots.length, mean(bf).toFixed(3), mean(bpc).toFixed(3), bf.length);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
