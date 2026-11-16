// Difficulty levels (dynamic difficulty) tests (Node >= 18): node --test creator/tests/js/test-difficulty.js
// Runs on the charts with difficulty levels in songs/ (skips without them).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path");
const { load, SONGS } = require("./load.js");
const E = load().engine;

const songs = fs.existsSync(SONGS) ? fs.readdirSync(SONGS).filter((f) => f.endsWith(".psarc")).sort() : [];
const haveSongs = songs.length > 0;
const clone = (x) => JSON.parse(JSON.stringify(x));
const RWTK = "Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", SULTANS = "Dire-Straits_Sultans-of-Swing_v443_m.psarc";
const bytes = new Map();
const read = (f) => { if (!bytes.has(f)) bytes.set(f, new Uint8Array(fs.readFileSync(path.join(SONGS, f)))); return bytes.get(f); };
const openProject = (f) => E.projectFromPsarc(read(f));
let ddCharts = null;
async function allDD() {
  if (ddCharts) return ddCharts;
  ddCharts = [];
  for (const f of songs) {
    const { project, source } = await openProject(f);
    for (const a of project.arrangements) if (a.dd) ddCharts.push({ f, a, source });
  }
  return ddCharts;
}
const strip = (lv) => { const c = clone(lv); for (const x of c.anchors) delete x._carry; return c; };
const events = (lv, r) => {
  const T = new Set();
  for (const n of lv.notes) if (n.time >= r.t0 && n.time < r.t1) T.add(Math.round(n.time * 1000));
  for (const c of lv.chords) if (c.time >= r.t0 && c.time < r.t1) T.add(Math.round(c.time * 1000));
  return T;
};
const canon = (lv) => JSON.stringify(["notes", "chords"].map((k) => lv[k].map((x) => JSON.stringify(x)).sort()));

test("levels: the hardest view is the merged chart, and viewing every level changes nothing", { skip: !haveSongs, timeout: 600000 }, async () => {
  const charts = await allDD();
  assert.ok(charts.length >= 20, "charts with difficulty levels: " + charts.length);
  for (const { f, a, source } of charts) {
    if (a.origin.xml) {
      const orig = E.arrParse(await source.read(a.origin.xml));
      assert.deepEqual(strip(a.doc.levels[0]), E.arrMergeLevels(orig).levels[0], f + " " + a.id + ": hardest view");
      // saving the levels as they are gives the file's levels
      assert.deepEqual(E.ddSaveDoc(a).levels, E.ddNormalizeLevels(orig.levels), f + " " + a.id + ": saved levels");
    }
    const before = JSON.stringify(a.dd.levels);
    for (let k = 0; k < a.dd.levels.length; k++) E.ddShow(a, k);
    E.ddShow(a, null);
    assert.equal(JSON.stringify(a.dd.levels), before, f + " " + a.id + ": view + commit");
    assert.deepEqual(a.dd.dirty, {}, f + " " + a.id + ": nothing marked changed");
  }
});

test("levels: an edit at level k lands in level k of that phrase only, and is saved with every level", { skip: !haveSongs }, async () => {
  const { project, source } = await openProject(RWTK);
  const a = project.arrangements.find((x) => x.kind === "lead");
  const orig = clone(a.dd.levels);
  // a phrase with 3 levels (0-2)
  const R = E.ddRanges(a.doc), r = R.find((x) => x.phraseId >= 0 && a.doc.phrases[x.phraseId].maxDifficulty === 2 && events(orig[1], x).size >= 2);
  assert.ok(r, "a phrase with levels 0-2");
  E.ddShow(a, 1);
  const lv = a.doc.levels[0];
  const victim = lv.notes.find((n) => n.time >= r.t0 && n.time < r.t1) || null;
  assert.ok(victim);
  lv.notes.splice(lv.notes.indexOf(victim), 1);
  E.ddShow(a, null);
  assert.deepEqual(Object.keys(a.dd.dirty), ["1"]);
  for (const d of [0, 2]) assert.equal(canon(a.dd.levels[d]), canon(orig[d]), "level " + d + " untouched");
  assert.equal(a.dd.levels[1].notes.length, orig[1].notes.length - 1);
  // the hardest chart of that phrase (level 2) still has its notes
  assert.equal(events(a.doc.levels[0], r).size, events(orig[2], r).size);
  a.edited = true;
  const out = await E.psarcOpen(await E.projectSave(project, source));
  const doc = E.arrParse(await out.read(a.origin.xml));
  assert.equal(doc.levels.length, 3);
  assert.equal(doc.levels[1].notes.length, orig[1].notes.length - 1);
  assert.equal(doc.levels[2].notes.length, orig[2].notes.length);
  const sng = E.sngParse((await E.sngDecrypt(await out.read(a.origin.sng), "mac")).body);
  assert.equal(sng.arrangements.length, 3, "SNG keeps the three levels");
  assert.equal(sng.arrangements[1].notes.length, doc.levels[1].notes.length + doc.levels[1].chords.length);
  const re = await E.projectFromPsarc(await E.psarcWrite(await Promise.all(out.names().map(async (n) => ({ name: n, data: await out.read(n) })))));
  assert.equal(re.project.arrangements.find((x) => x.id === a.id).dd.levels.length, 3);
});

test("levels by hand: an easier copy, then removing it again, gives the levels back", { skip: !haveSongs }, async () => {
  const { project } = await openProject(RWTK);
  const a = project.arrangements.find((x) => x.kind === "lead");
  const orig = clone(a.dd.levels), hard = canon(a.doc.levels[0]);
  const R = E.ddRanges(a.doc), r = R.find((x) => x.phraseId >= 0 && a.doc.phrases[x.phraseId].maxDifficulty === 2);
  const p = r.phraseId;
  E.ddShow(a, 1);
  E.ddInsertLevel(a, p, 1);                   // level 1 of the phrase duplicated: 0, 1 (copy), 2 (old 1), 3 (old 2)
  assert.equal(a.doc.phrases[p].maxDifficulty, 3);
  assert.equal(a.dd.levels.length, 4);
  assert.deepEqual(events(a.dd.levels[1], r), events(a.dd.levels[2], r));
  assert.deepEqual(events(a.dd.levels[3], r), events(orig[2], r));
  E.ddShow(a, null);
  assert.equal(canon(a.doc.levels[0]), hard, "the hardest chart does not change");
  assert.deepEqual(a.doc.phraseIterations.find((it) => it.phraseId === p).heroLevels.map((h) => h.difficulty), [1, 2, 3]);
  E.ddRemoveLevel(a, p, 1);
  assert.equal(a.doc.phrases[p].maxDifficulty, 2);
  assert.equal(a.dd.levels.length, 3);
  for (let d = 0; d < 3; d++) assert.equal(canon(a.dd.levels[d]), canon(orig[d]), "level " + d);
  // every phrase at once, then flat
  E.ddInsertLevel(a, null, 0);
  assert.equal(a.dd.levels.length, 4);
  E.ddFlatten(a);
  assert.equal(a.dd, null);
  assert.equal(canon(a.doc.levels[0]), hard);
  assert.ok(a.doc.phrases.every((x) => x.maxDifficulty === 0));
});

test("automatic levels: nested, the top level is the chart, close to the hand-made ones", { skip: !haveSongs, timeout: 600000 }, async () => {
  const charts = await allDD();
  let nest = 0, nestAll = 0, f1 = [], f1rand = [], seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const F1 = (A, B) => { if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return 2 * i / (A.size + B.size); };
  for (const { f, a } of charts) {
    const orig = E.ddSaveDoc(a), base = clone(orig);
    base.levels = [E.ddExtract(orig.levels, orig, null)];
    const g = E.ddGenerate(base, { bass: a.kind === "bass" });
    E.arrCompile(g, { bass: a.kind === "bass" });                  // compiles
    assert.ok(g.levels.length > 1, f + " " + a.id);
    for (const r of E.ddRanges(g)) {
      const m = r.phraseId >= 0 ? g.phrases[r.phraseId].maxDifficulty : 0;
      const hard = events(base.levels[0], r);
      assert.deepEqual(events(g.levels[m], r), hard, f + " " + a.id + " top level at " + r.start);
      if (hard.size) assert.ok(events(g.levels[0], r).size >= 1, "level 0 is never empty where the chart has notes");
      for (let k = 0; k < m; k++) {
        nestAll++;
        const A = events(g.levels[k], r), B = events(g.levels[k + 1], r);
        if ([...A].every((x) => B.has(x))) nest++;
      }
      const it = g.phraseIterations[r.i];
      if (it && m > 0) assert.deepEqual(it.heroLevels.map((h) => h.difficulty), E.ddHeroLevels(m).map((h) => h.difficulty));
    }
    // the easy level (hero 1) against the author's
    for (const r of E.ddRanges(orig)) {
      if (r.phraseId < 0) continue;
      const mo = orig.phrases[r.phraseId].maxDifficulty, full = events(orig.levels[mo], r);
      if (mo < 2 || full.size < 4) continue;
      const easy = (d, it) => (it.heroLevels.find((h) => h.hero === 1) || { difficulty: 0 }).difficulty;
      const A = events(orig.levels[easy(orig, orig.phraseIterations[r.i])], r);
      const mg = g.phrases[g.phraseIterations[r.i].phraseId].maxDifficulty;
      const G = events(g.levels[Math.min(mg, easy(g, g.phraseIterations[r.i]))], r);
      f1.push(F1(A, G));
      const arr = [...full], Rn = new Set();
      while (Rn.size < Math.min(A.size, arr.length)) Rn.add(arr[Math.floor(rand() * arr.length)]);
      f1rand.push(F1(A, Rn));
    }
  }
  const mean = (v) => v.reduce((x, y) => x + y, 0) / v.length;
  assert.equal(nest, nestAll, "every level holds the notes of the one below");
  const ours = mean(f1), base = mean(f1rand);
  console.log("  easy level vs. hand-made: F1 %s (random subset of the same size %s) over %d phrases", ours.toFixed(3), base.toFixed(3), f1.length);
  assert.ok(ours > 0.7 && ours > base + 0.2, "F1 " + ours + " vs random " + base);
});

test("automatic levels: chords thin out from the top string down, linked notes stay together", () => {
  const doc = {
    arrangement: "Lead", properties: {}, tuning: [0, 0, 0, 0, 0, 0], capo: 0, songLength: 20,
    ebeats: Array.from({ length: 40 }, (_, i) => ({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 + 1 : -1 })),
    phrases: [{ name: "COUNT", maxDifficulty: 0, disparity: 0, ignore: 0, solo: 0 }, { name: "riff", maxDifficulty: 0, disparity: 0, ignore: 0, solo: 0 }],
    phraseIterations: [{ time: 0, phraseId: 0, heroLevels: [] }, { time: 1, phraseId: 1, heroLevels: [] }],
    newLinkedDiffs: [], linkedDiffs: [], sections: [{ name: "riff", number: 1, startTime: 1 }], events: [], tones: [], offset: 0, part: 1,
    chordTemplates: [{ chordName: "G", displayName: "G", frets: [3, 2, 0, 0, 0, 3], fingers: [2, 1, -1, -1, -1, 3] }],
    levels: [{ difficulty: 0, notes: [], chords: [], anchors: [{ time: 1, fret: 1, width: 4 }], handShapes: [], fretHandMutes: [] }]
  };
  const lv = doc.levels[0];
  for (let i = 0; i < 16; i++) {
    const t = 1 + i * 0.5;
    if (i % 4 === 0) {
      lv.chords.push({ time: t, chordId: 0, linkNext: 0, accent: 0, fretHandMute: 0, highDensity: 0, ignore: 0, palmMute: 0, hopo: 0, strum: "down",
        chordNotes: doc.chordTemplates[0].frets.map((fr, s) => Object.assign({}, E.NOTE_DEFAULTS, { time: t, string: s, fret: fr, sustain: 0.4, bendValues: [] })) });
      lv.handShapes.push({ chordId: 0, startTime: t, endTime: t + 0.45 });
    } else if (i === 6) {
      lv.notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: t, string: 3, fret: 5, sustain: 0.5, slideTo: 7, linkNext: 1, bendValues: [] }));
    } else if (i === 7) {
      lv.notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: t, string: 3, fret: 7, sustain: 0.2, bendValues: [] }));
    } else lv.notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: t + 0.25, string: 2, fret: 2 + (i % 3), bendValues: [] }));
  }
  const g = E.ddGenerate(doc, {});
  const m = g.phrases[1].maxDifficulty;
  assert.ok(m >= 4, "16 events -> several levels: " + m);
  const size = (L) => L.chords.length ? Math.max(...L.chords.map((c) => g.chordTemplates[c.chordId].frets.filter((f) => f >= 0).length)) : L.notes.some((n) => Math.abs(n.time - 1) < 1e-6) ? 1 : 0;
  const sizes = g.levels.slice(0, m + 1).map(size);
  assert.equal(sizes[0], 1, "level 0: the chord is one note");
  assert.equal(sizes[m], 6, "top: the full chord");
  for (let k = 1; k <= m; k++) assert.ok(sizes[k] >= sizes[k - 1], "chords grow with the level: " + sizes);
  // the one note a chord becomes at level 0 is its lowest string, with the chord's sustain
  const n0 = g.levels[0].notes.find((n) => Math.abs(n.time - 1) < 1e-6);
  assert.equal(n0.string, 0); assert.equal(n0.fret, 3); assert.equal(n0.sustain, 0.4);
  // smaller chords have their own templates (and hand shapes)
  for (const L of g.levels) for (const c of L.chords) assert.ok(L.handShapes.some((h) => h.chordId === c.chordId && c.time >= h.startTime - 1e-4 && c.time < h.endTime));
  // the linked slide keeps its partner wherever it is kept
  for (const L of g.levels) {
    const a = L.notes.find((n) => Math.abs(n.time - 4) < 1e-6), b = L.notes.find((n) => Math.abs(n.time - 4.5) < 1e-6);
    if (a && a.linkNext) assert.ok(b, "linked note kept with its partner");
  }
  // level 0 keeps the strongest beat (the note on the downbeat at 4 s) and its linked partner
  assert.ok(g.levels[0].notes.some((n) => Math.abs(n.time - 4) < 1e-6) && g.levels[0].notes.some((n) => Math.abs(n.time - 4.5) < 1e-6), JSON.stringify(g.levels[0].notes.map((n) => n.time)));
  E.arrCompile(g, {});
});

test("levels follow new sections; modes keep / rebuild / one level; a new song gets levels", { skip: !haveSongs }, async () => {
  const { project, source } = await openProject(RWTK);
  const a = project.arrangements.find((x) => x.kind === "lead");
  const hard = canon(a.doc.levels[0]), perLevel = a.dd.levels.map((l, k) => canon(E.ddExtract(a.dd.levels, a.doc, k)));
  // new sections: the phrases are rebuilt, every level's chart stays the same
  const nIt = a.doc.phraseIterations.length;
  project.sections = project.sections.filter((s, i) => i % 2 === 0);
  E.arrApplySections(a, project.sections);
  assert.ok(a.doc.phraseIterations.length < nIt, "fewer phrases: " + a.doc.phraseIterations.length + " < " + nIt);
  assert.equal(canon(a.doc.levels[0]), hard, "the hardest chart survives new phrases");
  const top = a.dd.levels.length - 1;
  assert.equal(canon(E.ddExtract(a.dd.levels, a.doc, 0)), perLevel[0], "level 0 survives (phrases merge to the higher max)");
  assert.equal(canon(E.ddExtract(a.dd.levels, a.doc, top)), perLevel[top]);
  // modes
  a.edited = true;
  a.dd.mode = "flat";
  let d = E.ddSaveDoc(a);
  assert.equal(d.levels.length, 1); assert.equal(canon(d.levels[0]), hard);
  a.dd.mode = "auto";
  d = E.ddSaveDoc(a);
  assert.ok(d.levels.length > 3);
  a.dd.mode = "keep";
  d = E.ddSaveDoc(a);
  assert.equal(d.levels.length, top + 1);
  project.sectionsEdited = true;
  const out = await E.psarcOpen(await E.projectSave(project, source));
  assert.equal(E.arrParse(await out.read(a.origin.xml)).levels.length, top + 1);
  // a chart without levels: "rebuild" builds them
  const s = await openProject(SULTANS), lead = s.project.arrangements.find((x) => x.kind === "lead");
  assert.equal(lead.dd, null);
  E.ddSetMode(lead, "auto", { maxLevels: 6 });
  assert.ok(lead.dd && lead.dd.levels.length === 7, "levels 0-6: " + (lead.dd && lead.dd.levels.length));
  assert.equal(lead.dd.mode, "auto");
  lead.edited = true;
  const o2 = await E.psarcOpen(await E.projectSave(s.project, s.source));
  const x2 = E.arrParse(await o2.read(lead.origin.xml));
  assert.equal(x2.levels.length, 7);
  const m2 = JSON.parse(E.fromUtf8(await o2.read(lead.origin.manifest)));
  assert.equal(Object.values(m2.Entries)[0].Attributes.MaxPhraseDifficulty, 6);
});
