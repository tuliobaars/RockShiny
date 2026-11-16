#!/usr/bin/env node
// Decode the sample songs once for the "by ear" tools (the voice model, the drafts):
//   node creator/tools/ear/prep.js [songs-dir] [cache-dir]
// For every .psarc of up to 8 minutes: <cache>/<name>.L.f32 / .R.f32 (stereo, 22.05 kHz,
// float32) and <name>.json: {file, len, beats, syl: the lyrics' syllables, arrs: every chart's
// notes and chords as MIDI pitches}. Needs ffmpeg (the audio) and the songs you own.
"use strict";
const fs = require("fs"), path = require("path");
const { load, SONGS } = require("../../tests/js/load.js");
const { songAudio, haveFfmpeg } = require("../../tests/js/audio.js");
const E = load().engine;
const songs = process.argv[2] || SONGS, cache = process.argv[3] || path.join(require("os").tmpdir(), "rsc-ear");
if (!haveFfmpeg()) { console.error("needs ffmpeg"); process.exit(2); }
fs.mkdirSync(cache, { recursive: true });
(async () => {
  for (const f of fs.readdirSync(songs).filter((x) => x.endsWith(".psarc")).sort()) {
    const u8 = new Uint8Array(fs.readFileSync(path.join(songs, f)));
    const { project } = await E.projectFromPsarc(u8);
    if (project.meta.songLength > 480) { console.log("skip (longer than 8 min)", f); continue; }
    const base = path.join(cache, f.replace(/\.psarc$/, ""));
    if (!fs.existsSync(base + ".L.f32")) {
      const au = await songAudio(E, u8, { channels: 2, sr: 22050 });
      fs.writeFileSync(base + ".L.f32", Buffer.from(au.channels[0].buffer));
      fs.writeFileSync(base + ".R.f32", Buffer.from(au.channels[1].buffer));
    }
    const STD = [40, 45, 50, 55, 59, 64], arrs = [];
    for (const a of project.arrangements) {
      const d = a.doc, lv = d.levels[0], bass = a.kind === "bass";
      const midi = (s, fr) => STD[s] + (d.tuning[s] || 0) + fr - (bass ? 12 : 0) + (fr === 0 && d.capo ? d.capo : 0) + (d.centOffset || 0) / 100;
      arrs.push({
        kind: a.kind, name: a.name, tuning: d.tuning, capo: d.capo, cents: d.centOffset || 0,
        notes: lv.notes.filter((n) => !n.mute && n.fret >= 0).map((n) => ({ t: n.time, sus: n.sustain || 0, s: n.string, f: n.fret, m: midi(n.string, n.fret) })),
        chords: lv.chords.map((c) => {
          const tp = d.chordTemplates[c.chordId];
          return { t: c.time, name: tp ? tp.chordName : "", frets: tp ? tp.frets : [], sus: Math.max(0, ...(c.chordNotes || []).map((q) => q.sustain || 0)),
            ms: tp ? tp.frets.map((fr, s) => (fr >= 0 ? midi(s, fr) : null)).filter((x) => x != null) : [] };
        })
      });
    }
    const syl = project.vocals ? project.vocals.syllables : [];
    fs.writeFileSync(base + ".json", JSON.stringify({ file: f, len: project.meta.songLength, beats: project.beats, syl, arrs }));
    console.log("ok", f, "syllables " + syl.length, arrs.map((a) => a.kind + " " + a.notes.length + "/" + a.chords.length).join(", "));
  }
  console.log("cache:", cache);
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
