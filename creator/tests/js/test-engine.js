// Engine tests (Node >= 18): node --test creator/tests/js/test-engine.js (all: node --test creator/tests/js/test-*.js)
// Runs on every .psarc in songs/ (tests that need songs skip without them).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { load, SONGS } = require("./load.js");
const R = load(), E = R.engine;
// what the tests write (the compiler fidelity report, a new song) goes to the system temp folder, not into creator/
const OUT = path.join(require("os").tmpdir(), "rsc-test-out");

const songs = fs.existsSync(SONGS) ? fs.readdirSync(SONGS).filter((f) => f.endsWith(".psarc")).sort() : [];
const haveSongs = songs.length > 0;
const cache = new Map();
async function open(f) {
  if (!cache.has(f)) cache.set(f, new Uint8Array(fs.readFileSync(path.join(SONGS, f))));
  return E.psarcOpen(cache.get(f));
}
const base = (n) => path.basename(n).replace(/\.[^.]+$/, "");

test("AES-256, CFB-128, CTR and MD5 match OpenSSL", () => {
  const key = E.fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
  assert.equal(E.hex(E.aesEncryptBlock(key, E.fromHex("00112233445566778899aabbccddeeff"))), "8ea2b7ca516745bfeafc49904b496089");
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(16), d = crypto.randomBytes(1003);
  const c = crypto.createCipheriv("aes-256-cfb", k, iv), ref = Buffer.concat([c.update(d), c.final()]);
  assert.ok(Buffer.from(E.aesCfbEncrypt(d, k, iv)).equals(ref));
  assert.ok(Buffer.from(E.aesCfbDecrypt(ref, k, iv)).equals(d));
  const ivc = Buffer.from("fffffffffffffffffffffffffffffff0", "hex");
  const c2 = crypto.createCipheriv("aes-256-ctr", k, ivc);
  assert.ok(Buffer.from(E.aesCtr(d, k, ivc)).equals(Buffer.concat([c2.update(d), c2.final()])));
  assert.equal(E.hex(E.md5(d)), crypto.createHash("md5").update(d).digest("hex"));
  assert.equal(E.fnv1_32("Play_DireStraitsSultansPlum"), 3780057194);
});

test("PSARC: every archive reads (TOC md5 = md5(name)) and re-packs entry for entry", { skip: !haveSongs }, async () => {
  for (const f of songs) {
    const a = await open(f);
    for (const e of a.entries) assert.equal(e.md5, E.hex(E.md5(e.name)), f + " " + e.name);
    const files = [];
    for (const e of a.entries) files.push({ name: e.name, data: await a.read(e.name) });
    const b = await E.psarcOpen(await E.psarcWrite(files));
    assert.deepEqual(b.names(), a.names(), f);
    for (const x of files) assert.ok(E.equalBytes(await b.read(x.name), x.data), f + " " + x.name);
  }
});

test("SNG: every .sng parses and serialises back byte for byte", { skip: !haveSongs }, async () => {
  let n = 0;
  for (const f of songs) {
    const a = await open(f);
    for (const s of a.find(/\.sng$/)) {
      const d = await E.sngDecrypt(await a.read(s));
      const st = E.sngParse(d.body);
      assert.equal(st.trailing, 0, s);
      assert.ok(E.equalBytes(E.sngSerialize(st), d.body), s);
      const again = await E.sngDecrypt(await E.sngEncrypt(d.body, d.platform, { iv: d.iv }), d.platform);
      assert.ok(E.equalBytes(again.body, d.body), s + " re-encrypted");
      n++;
    }
  }
  assert.ok(n >= 60);
});

test("Arrangement XML: parse -> serialise -> parse is lossless", { skip: !haveSongs }, async () => {
  for (const f of songs.slice(0, 8)) {
    const a = await open(f);
    for (const x of a.find(/^songs\/arr\/.*\.xml$/)) {
      const txt = E.fromUtf8(await a.read(x));
      if (!/<song[ >]/.test(txt)) continue;
      const d = E.arrParse(txt), d2 = E.arrParse(E.arrSerialize(d));
      d.comments = d2.comments = [];
      assert.deepEqual(JSON.parse(JSON.stringify(d2, (k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v))),
        JSON.parse(JSON.stringify(d, (k, v) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v))), x);
    }
  }
});

// ---- the compiler against the toolkit's own .sng files ----------------------------------------
const fidelity = { total: 0, same: 0, byField: {} };
function tally(field, ok) {
  fidelity.total++; if (ok) fidelity.same++;
  const b = fidelity.byField[field] || (fidelity.byField[field] = [0, 0]);
  b[ok ? 0 : 1]++;
}
const eqNum = (a, b) => Object.is(Math.fround(a), Math.fround(b));
const same = (a, b) => (typeof a === "number" ? eqNum(a, b) : JSON.stringify(a) === JSON.stringify(b));
function cmpList(sec, A, B) {
  tally(sec + ".count", A.length === B.length);
  for (let i = 0; i < Math.min(A.length, B.length); i++) for (const k of Object.keys(B[i])) if (k !== "chordNotesId") tally(sec + "." + k, same(A[i][k], B[i][k]));
}

test("SNG compiler reproduces the toolkit's .sng files (field by field)", { skip: !haveSongs, timeout: 600000 }, async () => {
  for (const f of songs) {
    const a = await open(f);
    for (const x of a.find(/^songs\/arr\/.*\.xml$/)) {
      const id = base(x);
      if (/_(vocals|jvocals|showlights)$/.test(id)) continue;
      const sn = a.find(new RegExp("songs/bin/.*/" + id + "\\.sng$"))[0];
      if (!sn) continue;
      const doc = E.arrParse(await a.read(x));
      const ref = E.sngParse((await E.sngDecrypt(await a.read(sn))).body), mine = E.arrCompile(doc);
      for (const sec of ["bpms", "phrases", "chords", "phraseIterations", "phraseExtraInfo", "nld", "actions", "events", "tones", "dnas", "sections"]) cmpList(sec, mine[sec], ref[sec]);
      for (let L = 0; L < Math.min(mine.arrangements.length, ref.arrangements.length); L++) {
        const A = mine.arrangements[L], B = ref.arrangements[L];
        for (const sec of ["anchors", "anchorExtensions", "fingerprints1", "fingerprints2", "notes"]) cmpList("arr." + sec, A[sec], B[sec]);
        // chord notes: the record each chord points to, by content (the toolkit's ids carry its session cache)
        for (let i = 0; i < Math.min(A.notes.length, B.notes.length); i++) {
          const ca = A.notes[i].chordNotesId < 0 ? null : mine.chordNotes[A.notes[i].chordNotesId];
          const cb = B.notes[i].chordNotesId < 0 ? null : ref.chordNotes[B.notes[i].chordNotesId];
          tally("chordNotes.content", JSON.stringify(ca) === JSON.stringify(cb));
        }
        for (const sec of ["averageNotesPerIteration", "notesInIteration1", "notesInIteration2"]) tally("arr." + sec, same(A[sec].map(Math.fround), B[sec].map(Math.fround)));
      }
      for (const k of Object.keys(ref.metadata)) tally("meta." + k, same(mine.metadata[k], ref.metadata[k]));
    }
  }
  const pct = 100 * fidelity.same / fidelity.total;
  const worst = Object.entries(fidelity.byField).filter(([, v]) => v[1]).map(([k, v]) => k + " " + v[1] + "/" + (v[0] + v[1]));
  console.log("  compiler fidelity: " + fidelity.same + " / " + fidelity.total + " fields (" + pct.toFixed(4) + " %); differing: " + worst.join(", "));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "compiler-fidelity.json"), JSON.stringify({ fields: fidelity.total, matching: fidelity.same, percent: pct, byField: fidelity.byField }, null, 1));
  assert.ok(pct > 99.98, "fidelity " + pct);
  // fields that must always match
  for (const k of ["bpms.time", "bpms.measure", "bpms.mask", "phrases.name", "chords.notes", "sections.stringMask", "arr.notes.time",
    "arr.notes.sustain", "arr.notes.chordId", "arr.notes.anchorFret", "arr.notes.phraseIterationId", "chordNotes.content", "meta.maxNotesAndChords"]) {
    const v = fidelity.byField[k];
    assert.ok(v && v[1] === 0, k + " " + JSON.stringify(v));
  }
});

test("vocals .sng from the XML is byte-identical to the toolkit's", { skip: !haveSongs }, async () => {
  let n = 0;
  for (const f of songs) {
    const a = await open(f);
    const x = a.find(/_vocals\.xml$/)[0], s = a.find(/_vocals\.sng$/)[0];
    if (!x || !s) continue;
    assert.ok(E.equalBytes(E.vocalsSngBody(E.vocalsParse(await a.read(x))), (await E.sngDecrypt(await a.read(s))).body), f);
    n++;
  }
  assert.ok(n >= 10);
});

test("sound banks rebuild byte for byte from their ids", { skip: !haveSongs }, async () => {
  for (const f of songs) {
    const a = await open(f);
    for (const b of a.find(/\.bnk$/)) {
      const bytes = await a.read(b), ids = E.bankIds(bytes), wemId = E.bankWemIds(bytes)[0];
      const wem = await a.read(a.find(new RegExp(wemId + "\\.wem$"))[0]);
      const key = JSON.parse(E.fromUtf8(await a.read(a.find(/manifests\/.*\.json$/)[0]))).Entries;
      const songKey = Object.values(key)[0].Attributes.SongKey;
      const name = /_preview\.bnk$/.test(b) ? songKey + "_Preview" : songKey;
      assert.ok(E.equalBytes(E.bankBuild({ name, wemId, wem, codec: "vorbis", ids, volume: ids.volume }).bytes, bytes), f + " " + b);
    }
  }
});

test("Wwise Vorbis -> Ogg: valid pages, exact length", { skip: !haveSongs }, async () => {
  const a = await open("Daft-Punk_Derezzed_v1_m.psarc");
  const wem = await a.read(a.find(/\.wem$/)[0]), info = E.wemInfo(wem);
  const ogg = E.wemToOgg(wem);
  let o = 0, pages = 0, last = null;
  while (o < ogg.length) {
    assert.equal(E.latin1(ogg.subarray(o, o + 4)), "OggS");
    const segs = ogg[o + 26];
    let len = 27 + segs;
    for (let i = 0; i < segs; i++) len += ogg[o + 27 + i];
    const page = ogg.slice(o, o + len), crc = new DataView(page.buffer).getUint32(22, true);
    page.fill(0, 22, 26);
    assert.equal(E.crc32ogg(page), crc, "page " + pages);
    last = new DataView(ogg.buffer, ogg.byteOffset + o).getUint32(6, true);
    o += len; pages++;
  }
  assert.equal(last, info.samples);
});

test("DDS: DXT1 round trip keeps the picture (PSNR > 35 dB), the header is the toolkit's", { skip: !haveSongs }, async () => {
  const a = await open("Dire-Straits_Sultans-of-Swing_v443_m.psarc");
  const dds = await a.read(a.find(/_256\.dds$/)[0]), img = E.ddsDecode(dds);
  const re = E.ddsEncodeDXT1(img.rgba, img.width, img.height);
  assert.ok(E.equalBytes(re.subarray(0, 128), dds.subarray(0, 128)));
  const back = E.ddsDecode(re);
  let se = 0;
  for (let i = 0; i < img.rgba.length; i++) if (i % 4 !== 3) se += (img.rgba[i] - back.rgba[i]) ** 2;
  assert.ok(10 * Math.log10(255 * 255 / (se / (img.width * img.height * 3))) > 35);
});

test("project: open + save without edits writes every file back unchanged", { skip: !haveSongs, timeout: 600000 }, async () => {
  for (const f of songs) {
    const a = await open(f);
    const { project, source } = await E.projectFromPsarc(cache.get(f));
    assert.ok(project.arrangements.length >= 1, f);
    const b = await E.psarcOpen(await E.projectSave(project, source));
    assert.deepEqual(b.names().slice().sort(), a.names().slice().sort(), f);
    for (const n of a.names()) assert.ok(E.equalBytes(await b.read(n), await a.read(n)), f + " " + n);
  }
});

test("project: edits are saved (chart, lyrics, metadata) and everything else is untouched", { skip: !haveSongs }, async () => {
  const f = "Dire-Straits_Sultans-of-Swing_v443_m.psarc", a = await open(f);
  const { project, source } = await E.projectFromPsarc(cache.get(f));
  const lead = project.arrangements.find((x) => x.kind === "lead");
  const n0 = lead.doc.levels[0].notes.length;
  lead.doc.levels[0].notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: 20.5, string: 2, fret: 7, sustain: 0.5, bendValues: [] }));
  lead.edited = true;
  project.vocals.syllables[0].lyric = "Hey";
  project.vocals.edited = true;
  project.meta.title = "Sultans of Swing (edit)"; project.meta.metaEdited = true;
  const out = await E.psarcOpen(await E.projectSave(project, source));
  const doc = E.arrParse(await out.read(lead.origin.xml));
  assert.equal(doc.levels.length, 1);
  assert.equal(doc.levels[0].notes.length, n0 + 1);
  assert.equal(doc.title, "Sultans of Swing (edit)");
  const sng = E.sngParse((await E.sngDecrypt(await out.read(lead.origin.sng), "mac")).body);
  assert.equal(sng.arrangements[0].notes.length, n0 + 1 + doc.levels[0].chords.length);
  assert.equal(E.vocalsParse(await out.read(project.vocals.origin.xml))[0].lyric, "Hey");
  const mf = JSON.parse(E.fromUtf8(await out.read(lead.origin.manifest)));
  assert.equal(Object.values(mf.Entries)[0].Attributes.SongName, "Sultans of Swing (edit)");
  assert.equal(Object.values(mf.Entries)[0].Attributes.Score_MaxNotes, sng.metadata.maxNotesAndChords);
  for (const n of a.find(/\.(wem|bnk|dds|xblock|flat)$/)) assert.ok(E.equalBytes(await out.read(n), await a.read(n)), n);
  const re = await E.projectFromPsarc(await E.psarcWrite(await Promise.all(out.names().map(async (n) => ({ name: n, data: await out.read(n) })))));
  assert.equal(re.project.meta.title, "Sultans of Swing (edit)");
});

test("project: a new song from scratch opens again with its chart, lyrics and audio", async () => {
  const sr = 48000, len = 12 * sr, L = new Float32Array(len), Rr = new Float32Array(len);
  for (let i = 0; i < len; i++) { const t = i / sr; L[i] = 0.3 * Math.sin(2 * Math.PI * 110 * t); Rr[i] = 0.3 * Math.sin(2 * Math.PI * 165 * t); }
  const art = new Uint8ClampedArray(300 * 300 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 256));
  const { project, source } = await E.projectNew({ title: "Test Song", artist: "RockShiny", album: "Creator", year: 2025, platform: "pc",
    audio: { channels: [L, Rr], sampleRate: sr }, bpm: 120, arrangements: [{ kind: "lead" }, { kind: "bass" }], art: { rgba: art, width: 300, height: 300 } });
  const lead = project.arrangements[0];
  for (let i = 0; i < 8; i++) lead.doc.levels[0].notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: 1 + i * 0.5, string: i % 6, fret: 3 + i, bendValues: [] }));
  lead.doc.levels[0].anchors.push({ time: 1, fret: 3, width: 4 });
  project.vocals = { id: null, syllables: [{ time: 1, length: 0.4, lyric: "Hel-", note: 254 }, { time: 1.5, length: 0.4, lyric: "lo+", note: 254 }], origin: null, edited: true };
  project.sections = [{ name: "intro", number: 1, startTime: 0 }, { name: "verse", number: 1, startTime: 4 }, { name: "chorus", number: 1, startTime: 8 }];
  project.sectionsEdited = true;
  const bytes = await E.projectSave(project, source);
  const a = await E.psarcOpen(bytes);
  const names = a.names();
  for (const re of [/^appid\.appid$/, /_aggregategraph\.nt$/, /^toolkit\.version$/, /audio\/windows\/\d+\.wem$/, /song_rockshinytestsong\.bnk$/,
    /_preview\.bnk$/, /flatmodels\/rs\/rsenumerable_root\.flat/, /gamexblocks\/nsongs\/rockshinytestsong\.xblock/, /album_rockshinytestsong_256\.dds/,
    /manifests\/songs_dlc_rockshinytestsong\/rockshinytestsong_lead\.json/, /songs_dlc_rockshinytestsong\.hsan/, /songs\/arr\/rockshinytestsong_lead\.xml/,
    /songs\/bin\/generic\/rockshinytestsong_bass\.sng/, /songs\/arr\/rockshinytestsong_vocals\.xml/, /songs\/bin\/generic\/rockshinytestsong_vocals\.sng/,
    /songs\/arr\/rockshinytestsong_showlights\.xml/]) assert.ok(names.some((n) => re.test(n)), String(re));
  const re2 = await E.projectFromPsarc(bytes);
  assert.equal(re2.project.meta.title, "Test Song");
  assert.equal(re2.project.arrangements.length, 2);
  assert.equal(re2.project.arrangements[0].doc.levels[0].notes.length, 8);
  assert.equal(re2.project.vocals.syllables.length, 2);
  assert.equal(re2.project.sections.length, 3);
  assert.equal(re2.project.audio.codec, "pcm");
  const wem = await a.read(re2.project.audio.song);
  assert.ok(Math.abs(E.wemInfo(wem).duration - 12) < 1e-6);
  const sng = E.sngParse((await E.sngDecrypt(await a.read(names.find((n) => /lead\.sng$/.test(n))), "pc")).body);
  assert.equal(sng.arrangements[0].notes.length, 8);
  assert.equal(sng.phraseIterations.length, re2.project.arrangements[0].doc.phraseIterations.length);
  const hsan = JSON.parse(E.fromUtf8(await a.read(names.find((n) => /\.hsan$/.test(n)))));
  assert.equal(Object.keys(hsan.Entries).length, 3);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "new-song_p.psarc"), bytes);
});

test("project: Mac -> PC conversion moves the files and re-keys the charts", { skip: !haveSongs }, async () => {
  const f = "Daft-Punk_Derezzed_v1_m.psarc";
  const { project, source } = await E.projectFromPsarc(cache.get(f));
  const out = await E.psarcOpen(await E.projectSave(project, source, { platform: "pc" }));
  const names = out.names();
  assert.ok(!names.some((n) => /audio\/mac|songs\/bin\/macos/.test(n)));
  for (const n of names.filter((x) => /\.sng$/.test(x))) { const d = await E.sngDecrypt(await out.read(n), "pc"); assert.ok(d.body.length > 0, n); }
  assert.ok(names.some((n) => /^audio\/windows\/.*\.wem$/.test(n)));
  const graph = E.fromUtf8(await out.read(names.find((n) => /aggregategraph/.test(n))));
  assert.ok(/dx9/.test(graph) && !/macos/.test(graph));
});

test("SNG -> XML -> SNG (official songs without XML) keeps the chart", { skip: !haveSongs }, async () => {
  const a = await open("BB_King-Lucille_v1_DD_Aludog_m.psarc");
  const sn = a.find(/lead\.sng$/)[0];
  const ref = E.sngParse((await E.sngDecrypt(await a.read(sn))).body);
  const back = E.arrCompile(E.arrFromSng(ref, { arrangement: "Lead" }));
  assert.equal(back.arrangements.length, ref.arrangements.length);
  for (let L = 0; L < ref.arrangements.length; L++) {
    const A = back.arrangements[L].notes, B = ref.arrangements[L].notes;
    assert.equal(A.length, B.length);
    let ok = 0;
    for (let i = 0; i < A.length; i++) if (A[i].time === B[i].time && A[i].fret === B[i].fret && A[i].string === B[i].string && A[i].sustain === B[i].sustain && (A[i].mask & ~0x10080000) === (B[i].mask & ~0x10080000)) ok++;
    assert.ok(ok / A.length > 0.99, "level " + L + ": " + ok + "/" + A.length);
  }
});
