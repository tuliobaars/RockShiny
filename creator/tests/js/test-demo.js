// The engine on the demo song alone (no sample songs needed: the creator/ folder on its
// own): node --test creator/tests/js/test-demo.js
// The same round trips the sample-song tests make, on "Night Drive" made from scratch.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { load } = require("./load.js");
const E = load().engine;

let pkg = null;
async function demoPackage(platform) {
  if (!pkg) pkg = {};
  if (!pkg[platform]) { const made = await E.demoSong({ platform }); pkg[platform] = await E.projectSave(made.project, made.source); }
  return pkg[platform];
}
const canon = (lv) => JSON.stringify(["notes", "chords"].map((k) => lv[k].map((x) => JSON.stringify(x)).sort()));

test("demo: the archive re-packs entry for entry; every SNG and XML round-trips", async () => {
  for (const platform of ["pc", "mac"]) {
    const bytes = await demoPackage(platform), a = await E.psarcOpen(bytes);
    const files = await Promise.all(a.names().map(async (n) => ({ name: n, data: await a.read(n) })));
    const b = await E.psarcOpen(await E.psarcWrite(files));
    assert.deepEqual(b.names(), a.names());
    for (const n of a.names()) assert.ok(E.equalBytes(await b.read(n), await a.read(n)), n);
    for (const n of a.find(/\.sng$/)) {
      const d = await E.sngDecrypt(await a.read(n), platform);
      if (/vocals/.test(n)) continue;
      assert.ok(E.equalBytes(E.sngSerialize(E.sngParse(d.body)), d.body), n + ": parse -> serialise");
    }
    for (const n of a.find(/^songs\/arr\/.*\.xml$/)) {
      if (/vocals|showlights/.test(n)) continue;
      const x = E.arrParse(await a.read(n));
      assert.deepEqual(E.arrParse(E.utf8(E.arrSerialize(x))), x, n);
    }
  }
});

test("demo: open + save without edits writes every file back unchanged; Mac -> PC converts", async () => {
  const bytes = await demoPackage("mac"), a = await E.psarcOpen(bytes);
  const { project, source } = await E.projectFromPsarc(bytes);
  const b = await E.psarcOpen(await E.projectSave(project, source));
  assert.deepEqual(b.names().slice().sort(), a.names().slice().sort());
  for (const n of a.names()) assert.ok(E.equalBytes(await b.read(n), await a.read(n)), n);
  const re = await E.projectFromPsarc(bytes), pc = await E.psarcOpen(await E.projectSave(re.project, re.source, { platform: "pc" }));
  assert.ok(pc.names().some((n) => /^songs\/bin\/generic\//.test(n)));
  assert.ok(!pc.names().some((n) => /audio\/mac|songs\/bin\/macos/.test(n)));
  const back = await E.projectFromPsarc(await E.psarcWrite(await Promise.all(pc.names().map(async (n) => ({ name: n, data: await pc.read(n) })))));
  assert.equal(back.project.platform, "pc");
  assert.deepEqual(back.project.arrangements.map((x) => x.doc.levels[0].notes.length + x.doc.levels[0].chords.length), [52, 48, 96]);
});

test("demo: difficulty levels built, viewed, edited by hand, saved and read back", async () => {
  const { project, source } = await E.projectFromPsarc(await demoPackage("pc"));
  const rhythm = project.arrangements[1], hard = canon(rhythm.doc.levels[0]);
  E.ddAuto(rhythm, { maxLevels: 6 });
  assert.ok(rhythm.dd && rhythm.dd.levels.length > 2);
  assert.equal(canon(rhythm.doc.levels[0]), hard, "the full chart is the top level");
  const before = JSON.stringify(rhythm.dd.levels);
  for (let k = 0; k < rhythm.dd.levels.length; k++) E.ddShow(rhythm, k);
  E.ddShow(rhythm, null);
  assert.equal(JSON.stringify(rhythm.dd.levels), before, "viewing changes nothing");
  E.ddShow(rhythm, 0);
  const n0 = rhythm.doc.levels[0].chords.length + rhythm.doc.levels[0].notes.length;
  assert.ok(n0 > 0 && n0 < 48, "level 0 is easier: " + n0);
  E.ddInsertLevel(rhythm, null, 0);
  E.ddRemoveLevel(rhythm, null, 0);
  assert.equal(JSON.stringify(rhythm.dd.levels), before, "a level added and removed again");
  rhythm.edited = true;
  const out = await E.projectFromPsarc(await E.projectSave(project, source));
  assert.equal(out.project.arrangements[1].dd.levels.length, rhythm.dd.levels.length);
});
