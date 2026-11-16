#!/usr/bin/env node
// How well the lyrics sync works, on the songs decoded by prep.js:
//   node creator/tools/ear/eval_sync.js [cache-dir] [--loso] [--rows rows.json]
// Each song's lyrics are moved by a random 0-2.5 s (3 tries a song), then put back by
//   onsets    RockShiny's onset aligner (karaoke-sync.js) after a coarse activity lag: the old auto-sync
//   voice     the voice model (V.alignGlobal)
//   auto-sync the Creator's rule: the voice, unless the onset aligner is > 0.8 s away from it
// and "Sync each line" (V.alignLines) against one shift, on lyrics also off line by line (+-0.3 s, then
// +-0.8 s: timed roughly), and on lyrics of another take (a tempo 0.5 % off too).
// Errors are those of each line's start. --loso: p(voice) from voice_train.py's
// leave-one-song-out models (<name>.p.npy), so no song is scored by a model trained on it.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), os = require("os"), cp = require("child_process");
const { load } = require("../../tests/js/load.js");
const R = load();
const args = process.argv.slice(2), LOSO = args.includes("--loso");
const cache = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--rows") || path.join(os.tmpdir(), "rsc-ear");
// RockShiny's karaoke aligner: next to creator/ (RockShiny) or the copy bundled in creator/rockshiny/
const creator = path.resolve(__dirname, "..", "..");
const kfile = [path.join(creator, "..", "inst", "karaoke", "karaoke-sync.js"), path.join(creator, "rockshiny", "inst", "karaoke", "karaoke-sync.js")].find((f) => fs.existsSync(f));
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(kfile, "utf8"), { filename: kfile });
const K = globalThis.RSKaraoke;
const rd = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const stats = (a) => {
  a = a.slice().sort((x, y) => x - y);
  const q = (f) => a[Math.min(a.length - 1, Math.floor(a.length * f))];
  return "median " + q(0.5).toFixed(2) + " s, " + Math.round(100 * a.filter((x) => x < 0.3).length / a.length) + "% < 0.3 s, " +
    Math.round(100 * a.filter((x) => x < 0.5).length / a.length) + "% < 0.5 s, worst " + a[a.length - 1].toFixed(2) + " s (" + a.length + " lines)";
};
(async () => {
  const res = { rows: [], onsets: [], voice: [], auto: [], ownShift: [], ownEach: [], roughShift: [], roughEach: [], takeShift: [], takeEach: [] };
  const names = fs.readdirSync(cache).filter((x) => x.endsWith(".json")).sort();
  for (const j of names) {
    const base = path.join(cache, j.replace(/\.json$/, "")), meta = JSON.parse(fs.readFileSync(base + ".json")), S = meta.syl;
    if (!S.length) continue;
    const L = rd(base + ".L.f32"), Rr = rd(base + ".R.f32"), sr = 22050;
    let p;
    if (LOSO) {
      const b = cp.execFileSync("python3", ["-c", "import numpy as np,sys; sys.stdout.buffer.write(np.load(sys.argv[1]).astype(np.float32).tobytes())", base + ".p.npy"], { maxBuffer: 1e9 });
      p = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    } else p = (await R.voice.activity([L, Rr], sr)).p;
    const ev = R.voice.evidence(p), pr = R.sync.presence([L, Rr], sr), lines = R.voice.linesOf(S);
    const buf = { sampleRate: sr, numberOfChannels: 2, length: L.length, duration: L.length / sr, getChannelData: (i) => (i ? Rr : L) };
    const words = [];
    let cur = null;
    for (const s of S) { if (!cur) { cur = { start: s.time, words: [] }; words.push(cur); } cur.words.push({ w: s.lyric.replace(/[+-]$/, ""), j: /-$/.test(s.lyric) ? 1 : 0 }); if (/\+$/.test(s.lyric)) cur = null; }
    const errs = (shift) => lines.map(() => Math.abs(shift));
    for (let tr = 0; tr < 3; tr++) {
      const G = Math.round((rnd() * 5 - 2.5) * 100) / 100;                     // the lyrics are G s late
      const coarse = R.sync.activityLag(S.map((s) => Object.assign({}, s, { time: s.time + G })), pr, 4, 0);
      const r = await K.alignLRC(buf, words.map((l) => ({ start: l.start + G + coarse, words: l.words })), { audioDuration: buf.duration, lrcDuration: 0, window: 0.8, margin: 0 });
      const onset = G + coarse + r.offset;                                     // the error left
      const g = R.voice.alignGlobal(lines.map((l) => ({ start: l.start + G, end: l.end + G, syl: l.syl.map(([t, d]) => [t + G, d]) })), ev, { maxLag: 4 });
      // the Creator's rule (rsc-tools.js autoSync): the voice, unless the onsets disagree by > 0.8 s and put the
      // syllables about as well on the singing (coverage within 0.1)
      const Sg = S.map((s) => Object.assign({}, s, { time: s.time + G }));
      const voice = G + g.shift, useOnset = lines.length >= 8 && Math.abs(onset - voice) > 0.8 &&
        R.voice.coverage(Sg, p, coarse + r.offset) >= R.voice.coverage(Sg, p, g.shift) - 0.1;
      const auto = useOnset ? onset : voice;
      res.onsets.push(...errs(onset)); res.voice.push(...errs(voice)); res.auto.push(...errs(auto));
      res.rows.push({ song: j, lines: lines.length, G, voice, voiceConf: g.confidence, onset, onsetConf: r.confidence });
      // lines off on their own, and lyrics of another take (a tempo 0.5 % off as well)
      for (const [key, drift, off] of [["own", 0, 0.3], ["rough", 0, 0.8], ["take", 0.005, 0.3]]) {
        const jit = lines.map((l) => { const d = G + drift * (l.start - lines[0].start) + (rnd() - 0.5) * 2 * off; return { start: l.start + d, end: l.end + d, syl: l.syl.map(([t, dd]) => [t + d, dd]) }; });
        const g2 = R.voice.alignGlobal(jit, ev, { maxLag: 4 });
        jit.forEach((l, i) => res[key + "Shift"].push(Math.abs(l.start + g2.shift - lines[i].start)));
        const e = R.voice.alignLines(jit, ev, { maxLag: 4 });
        e.starts.forEach((t, i) => res[key + "Each"].push(Math.abs(t - lines[i].start)));
      }
    }
    console.log(j.slice(0, 40).padEnd(40), "onsets", res.onsets.slice(-1)[0].toFixed(2), "voice", res.voice.slice(-1)[0].toFixed(2), "auto-sync", res.auto.slice(-1)[0].toFixed(2));
  }
  if (args.includes("--rows")) fs.writeFileSync(args[args.indexOf("--rows") + 1], JSON.stringify(res.rows));
  console.log("\nlyrics moved by up to 2.5 s" + (LOSO ? " (p(voice) of models that never saw the song)" : " (the shipped model)"));
  console.log("  onsets only (old)    " + stats(res.onsets));
  console.log("  voice model          " + stats(res.voice));
  console.log("  auto-sync (shipped)  " + stats(res.auto));
  console.log("lines also off on their own (+-0.3 s)");
  console.log("  one shift (voice)    " + stats(res.ownShift));
  console.log("  sync each line       " + stats(res.ownEach));
  console.log("lines timed roughly (+-0.8 s)");
  console.log("  one shift (voice)    " + stats(res.roughShift));
  console.log("  sync each line       " + stats(res.roughEach));
  console.log("lyrics of another take: 0.5 % slower, lines +-0.3 s");
  console.log("  one shift (voice)    " + stats(res.takeShift));
  console.log("  sync each line       " + stats(res.takeEach));
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
