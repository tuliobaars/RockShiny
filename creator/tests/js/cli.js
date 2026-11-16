#!/usr/bin/env node
// The Creator's engine from the command line (used by the R tests to check the two
// implementations against each other):
//   node cli.js list <file.psarc>                       -> JSON [{name, size, md5}]
//   node cli.js resave <in.psarc> <out.psarc> [pc|mac]  open + save (no edits)
//   node cli.js edit <in.psarc> <out.psarc>             add a note to every chart, change the title
//   node cli.js new <out.psarc>                         a small song from scratch (synthetic audio)
//   node cli.js dd-edit <in.psarc> <out.psarc>          edit a chart with difficulty levels at level 1 and at the top (levels kept)
//   node cli.js dd-auto <in.psarc> <out.psarc> [max]    difficulty levels built for every chart (auto)
//   node cli.js dd-flat <in.psarc> <out.psarc>          every chart saved as one level
//   node cli.js demo <out.psarc> [pc|mac]               the demo song ("Night Drive", made from scratch)
//   node cli.js guitar-wav <notes|repeats|chords> <out.wav>  a plucked guitar for the tuner's tests (a fake microphone):
//                                                       notes E2 A2 D3 G3 B3 E4 one a second; repeats: E2 x3 re-plucked
//                                                       while ringing, A2 B2 A2 overlapping, E3 x2; strums G C D Em
"use strict";
const fs = require("fs");
const { load } = require("./load.js");
const RS = load(), E = RS.engine;
/** Plucked strings (Karplus-Strong) at 48 kHz: single notes, or strummed chords. */
function guitar(what) {
  const sr = 48000, mh = (m) => 440 * Math.pow(2, (m - 69) / 12);
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pluck = (out, t0, hz, dur, amp) => {
    const n0 = Math.floor(t0 * sr), len = Math.floor(dur * sr), p = Math.max(2, Math.round(sr / hz)), buf = new Float32Array(p);
    for (let i = 0; i < p; i++) buf[i] = rand() * 2 - 1;
    for (let i = 0, k = 0; i < len && n0 + i < out.length; i++) {
      const c = buf[k];
      buf[k] = 0.997 * (0.5 * c + 0.5 * buf[(k + 1) % p]); k = (k + 1) % p;
      out[n0 + i] += c * amp * (i < len - 0.03 * sr ? 1 : (len - i) / (0.03 * sr));
    }
  };
  const STD = [40, 45, 50, 55, 59, 64];
  if (what === "notes") { const x = new Float32Array(sr * 9); STD.forEach((m, i) => pluck(x, 1 + i, mh(m), 0.7, 0.5)); return x; }
  if (what === "repeats") {
    seed = 5;
    const x = new Float32Array(sr * 9);
    [[1, 40], [1.6, 40], [2.2, 40], [3, 45], [3.5, 47], [4, 45], [5, 52], [5.6, 52]].forEach(([t, m]) => pluck(x, t, mh(m), 0.9, 0.5));
    return x;
  }
  const shapes = { G: [3, 2, 0, 0, 0, 3], C: [-1, 3, 2, 0, 1, 0], D: [-1, -1, 0, 2, 3, 2], Em: [0, 2, 2, 0, 0, 0] }, x = new Float32Array(sr * 9);
  ["G", "C", "D", "Em"].forEach((c, i) => shapes[c].forEach((f, s) => { if (f >= 0) pluck(x, 2 + i * 1.4 + s * 0.012, mh(STD[s] + f), 1.0, 0.22); }));   // from 2 s: time to pick "Chords"
  return x;
}

(async () => {
  const [cmd, a, b, c] = process.argv.slice(2);
  if (cmd === "list") {
    const arc = await E.psarcOpen(new Uint8Array(fs.readFileSync(a)));
    const out = [];
    for (const n of arc.names()) { const d = await arc.read(n); out.push({ name: n, size: d.length, md5: E.hex(E.md5(d)) }); }
    process.stdout.write(JSON.stringify(out));
  } else if (cmd === "resave" || cmd === "edit") {
    const { project, source } = await E.projectFromPsarc(new Uint8Array(fs.readFileSync(a)));
    if (cmd === "edit") {
      for (const x of project.arrangements) { x.doc.levels[0].notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: 2.5, string: 1, fret: 3, sustain: 0.25, bendValues: [] })); x.edited = true; }
      project.meta.title += " (edit)"; project.meta.metaEdited = true;
    }
    fs.writeFileSync(b, await E.projectSave(project, source, { platform: c || undefined }));
  } else if (cmd === "new") {
    const sr = 44100, n = 8 * sr, L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) { L[i] = 0.2 * Math.sin(2 * Math.PI * 196 * i / sr); R[i] = 0.2 * Math.sin(2 * Math.PI * 247 * i / sr); }
    const { project, source } = await E.projectNew({ title: "Cli Song", artist: "RockShiny", platform: "pc", audio: { channels: [L, R], sampleRate: sr }, bpm: 100, arrangements: [{ kind: "lead" }, { kind: "bass" }] });
    const lv = project.arrangements[0].doc.levels[0];
    for (let i = 0; i < 6; i++) lv.notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: 1 + 0.6 * i, string: i, fret: 2 + i, bendValues: [] }));
    project.vocals = { id: null, syllables: [{ time: 1, length: 0.5, lyric: "Hel-", note: 254 }, { time: 1.6, length: 0.5, lyric: "lo+", note: 254 }], origin: null, edited: true };
    fs.writeFileSync(a, await E.projectSave(project, source));
  } else if (cmd === "dd-edit" || cmd === "dd-auto" || cmd === "dd-flat") {
    const { project, source } = await E.projectFromPsarc(new Uint8Array(fs.readFileSync(a)));
    const report = [];
    for (const x of project.arrangements) {
      if (cmd === "dd-auto") { E.ddAuto(x, { maxLevels: c ? +c : undefined }); x.edited = true; }
      else if (cmd === "dd-flat") { E.ddFlatten(x); x.edited = true; }
      else if (x.dd) {
        E.ddShow(x, 1);
        const lv = x.doc.levels[0];
        const victim = lv.notes.find((n) => n.time > 10);
        if (victim) lv.notes.splice(lv.notes.indexOf(victim), 1);
        E.ddShow(x, null);
        x.doc.levels[0].notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: 2.5, string: 1, fret: 3, sustain: 0.25, bendValues: [] }));
        x.doc.levels[0].notes.sort((p, q) => p.time - q.time || p.string - q.string);
        x.edited = true;
        report.push({ id: x.id, removedAtLevel1: victim ? victim.time : null });
      }
      report.push({ id: x.id, levels: x.dd ? x.dd.levels.length : 1 });
    }
    fs.writeFileSync(b, await E.projectSave(project, source));
    process.stdout.write(JSON.stringify(report));
  } else if (cmd === "demo") {
    const made = await E.demoSong({ platform: b || "pc" });
    fs.writeFileSync(a, await E.projectSave(made.project, made.source));
  } else if (cmd === "guitar-wav") {
    fs.writeFileSync(b, RS.dsp.wavBytes([guitar(a)], 48000));
  } else { console.error("usage: cli.js list|resave|edit|new|dd-edit|dd-auto|dd-flat|demo|guitar-wav ..."); process.exit(2); }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
