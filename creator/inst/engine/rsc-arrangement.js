/* ---------------------------------------------------------------------------
 * rsc-arrangement.js -- Rocksmith 2014 arrangements: the document model of
 * songs/arr/*.xml, the XML writer, and the XML -> SNG compiler.
 *
 *   const doc = E.arrParse(xmlText)        // faithful model, every level (DD)
 *   E.arrSerialize(doc)                     // -> XML text (toolkit style)
 *   const sng = E.arrCompile(doc)           // -> SNG struct (E.sngSerialize)
 *   const doc2 = E.arrFromSng(sngStruct)    // official DLC: charts only in SNG
 *
 * The compiler reproduces the Rocksmith Custom Song Toolkit's (tested field by
 * field against the .sng files it wrote for the sample songs, see
 * tests/js/test-engine.js). Arithmetic that the toolkit does in single
 * precision uses Math.fround.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;
  const f32 = Math.fround;

  // ---- reading ------------------------------------------------------------------------------
  const num = (v, d) => { if (v == null || v === "") return d; const x = +v; return Number.isFinite(x) ? x : d; };
  const int = (v, d) => { if (v == null || v === "") return d; const x = parseInt(v, 10); return Number.isFinite(x) ? x : d; };

  const NOTE_ATTRS = ["time", "linkNext", "accent", "bend", "fret", "hammerOn", "harmonic", "hopo", "ignore", "leftHand", "mute",
    "palmMute", "pluck", "pullOff", "slap", "slideTo", "string", "sustain", "tremolo", "harmonicPinch", "pickDirection",
    "rightHand", "slideUnpitchTo", "tap", "vibrato"];
  const NOTE_DEFAULTS = { linkNext: 0, accent: 0, bend: 0, fret: 0, hammerOn: 0, harmonic: 0, hopo: 0, ignore: 0, leftHand: -1, mute: 0,
    palmMute: 0, pluck: -1, pullOff: 0, slap: -1, slideTo: -1, string: 0, sustain: 0, tremolo: 0, harmonicPinch: 0, pickDirection: 0,
    rightHand: -1, slideUnpitchTo: -1, tap: 0, vibrato: 0 };
  E.NOTE_DEFAULTS = NOTE_DEFAULTS;
  const CHORD_ATTRS = ["time", "linkNext", "accent", "chordId", "fretHandMute", "highDensity", "ignore", "palmMute", "hopo", "strum"];

  function readNote(n) {
    const o = { time: num(n.attrs.time, 0) };
    for (const k of NOTE_ATTRS) if (k !== "time") o[k] = k === "bend" || k === "sustain" ? num(n.attrs[k], NOTE_DEFAULTS[k]) : int(n.attrs[k], NOTE_DEFAULTS[k]);
    const bv = E.xmlChild(n, "bendValues");
    o.bendValues = bv ? E.xmlChildren(bv, "bendValue").map((b) => ({ time: num(b.attrs.time, 0), step: num(b.attrs.step, 0), unk5: int(b.attrs.unk5, 0) })) : [];
    return o;
  }
  function readChord(c) {
    const o = { time: num(c.attrs.time, 0), linkNext: int(c.attrs.linkNext, 0), accent: int(c.attrs.accent, 0), chordId: int(c.attrs.chordId, 0),
      fretHandMute: int(c.attrs.fretHandMute, 0), highDensity: int(c.attrs.highDensity, 0), ignore: int(c.attrs.ignore, 0),
      palmMute: int(c.attrs.palmMute, 0), hopo: int(c.attrs.hopo, 0), strum: c.attrs.strum || "down" };
    o.chordNotes = E.xmlChildren(c, "chordNote").map(readNote);
    return o;
  }
  function readTrack(node) {
    const list = (name, item, fn) => E.xmlChildren(E.xmlChild(node, name), item).map(fn);
    return {
      difficulty: int(node.attrs.difficulty, 0),
      notes: list("notes", "note", readNote),
      chords: list("chords", "chord", readChord),
      fretHandMutes: list("fretHandMutes", "fretHandMute", (x) => ({ time: num(x.attrs.time, 0) })),
      anchors: list("anchors", "anchor", (a) => ({ time: num(a.attrs.time, 0), fret: int(a.attrs.fret, 1), width: num(a.attrs.width, 4) })),
      handShapes: list("handShapes", "handShape", (h) => ({ chordId: int(h.attrs.chordId, 0), startTime: num(h.attrs.startTime, 0), endTime: num(h.attrs.endTime, 0) }))
    };
  }

  /** Parse an arrangement XML (text or bytes) into the document model. */
  E.arrParse = function (input) {
    const x = typeof input === "string" || input instanceof Uint8Array ? E.xmlParse(input) : input;
    if (x.name !== "song") throw new Error("Not a Rocksmith arrangement (root <" + x.name + ">).");
    const t = (name, d) => E.xmlText(x, name, d);
    const tun = E.xmlChild(x, "tuning");
    const doc = {
      version: x.attrs.version || "7",
      comments: (x.children.filter((c) => c.comment != null).map((c) => c.comment.trim())),
      title: t("title", ""), arrangement: t("arrangement", ""), part: int(t("part"), 1), offset: num(t("offset"), 0),
      centOffset: num(t("centOffset"), 0), songLength: num(t("songLength"), 0), songNameSort: t("songNameSort", null),
      startBeat: num(t("startBeat"), 0), averageTempo: num(t("averageTempo"), 120),
      tuning: [0, 1, 2, 3, 4, 5].map((i) => int(tun && tun.attrs["string" + i], 0)),
      capo: int(t("capo"), 0), artistName: t("artistName", ""), artistNameSort: t("artistNameSort", null),
      albumName: t("albumName", ""), albumNameSort: t("albumNameSort", null), albumYear: t("albumYear", ""),
      albumArt: t("albumArt", null), crowdSpeed: int(t("crowdSpeed"), 1),
      properties: Object.assign({}, (E.xmlChild(x, "arrangementProperties") || { attrs: {} }).attrs),
      lastConversionDateTime: t("lastConversionDateTime", ""),
      phrases: E.xmlChildren(E.xmlChild(x, "phrases"), "phrase").map((p) => ({
        disparity: int(p.attrs.disparity, 0), ignore: int(p.attrs.ignore, 0), maxDifficulty: int(p.attrs.maxDifficulty, 0),
        name: p.attrs.name || "", solo: int(p.attrs.solo, 0) })),
      phraseIterations: E.xmlChildren(E.xmlChild(x, "phraseIterations"), "phraseIteration").map((p) => ({
        time: num(p.attrs.time, 0), phraseId: int(p.attrs.phraseId, 0), variation: p.attrs.variation == null ? null : p.attrs.variation,
        heroLevels: E.xmlChildren(E.xmlChild(p, "heroLevels"), "heroLevel").map((h) => ({ difficulty: int(h.attrs.difficulty, 0), hero: int(h.attrs.hero, 0) })) })),
      newLinkedDiffs: E.xmlChildren(E.xmlChild(x, "newLinkedDiffs"), "newLinkedDiff").map((l) => ({
        levelBreak: int(l.attrs.levelBreak, -1), ratio: l.attrs.ratio || "1.000",
        phrases: E.xmlChildren(l, "nld_phrase").map((p) => int(p.attrs.id, 0)) })),
      linkedDiffs: E.xmlChildren(E.xmlChild(x, "linkedDiffs"), "linkedDiff").map((l) => ({ childId: int(l.attrs.childId, 0), parentId: int(l.attrs.parentId, 0) })),
      phraseProperties: E.xmlChildren(E.xmlChild(x, "phraseProperties"), "phraseProperty").map((p) => Object.assign({}, p.attrs)),
      chordTemplates: E.xmlChildren(E.xmlChild(x, "chordTemplates"), "chordTemplate").map((c) => ({
        chordName: c.attrs.chordName || "", displayName: c.attrs.displayName || "",
        frets: [0, 1, 2, 3, 4, 5].map((i) => int(c.attrs["fret" + i], -1)), fingers: [0, 1, 2, 3, 4, 5].map((i) => int(c.attrs["finger" + i], -1)) })),
      fretHandMuteTemplates: [],
      ebeats: E.xmlChildren(E.xmlChild(x, "ebeats"), "ebeat").map((b) => ({ time: num(b.attrs.time, 0), measure: int(b.attrs.measure, -1) })),
      tonebase: t("tonebase", null), tonea: t("tonea", null), toneb: t("toneb", null), tonec: t("tonec", null), toned: t("toned", null),
      tones: E.xmlChildren(E.xmlChild(x, "tones"), "tone").map((o) => ({ time: num(o.attrs.time, 0), name: o.attrs.name || "", id: o.attrs.id == null ? null : int(o.attrs.id, 0) })),
      sections: E.xmlChildren(E.xmlChild(x, "sections"), "section").map((s) => ({ name: s.attrs.name || "", number: int(s.attrs.number, 1), startTime: num(s.attrs.startTime, 0) })),
      events: E.xmlChildren(E.xmlChild(x, "events"), "event").map((e) => ({ time: num(e.attrs.time, 0), code: e.attrs.code || "" })),
      transcriptionTrack: E.xmlChild(x, "transcriptionTrack") ? readTrack(E.xmlChild(x, "transcriptionTrack")) : null,
      levels: E.xmlChildren(E.xmlChild(x, "levels"), "level").map(readTrack)
    };
    if (doc.transcriptionTrack) doc.transcriptionTrack.difficulty = -1;
    return doc;
  };

  // ---- writing --------------------------------------------------------------------------------
  /** Numbers as the toolkit writes them: at most 3 decimals, no trailing zeros. */
  const fmt = (v) => {
    if (v == null || !Number.isFinite(+v)) return "0";
    const r = Math.round(+v * 1000) / 1000;
    return (Object.is(r, -0) ? 0 : r).toString();
  };
  E.fmtNum = fmt;

  function noteEl(n, tag) {
    const a = {};
    for (const k of NOTE_ATTRS) a[k] = k === "time" || k === "sustain" || k === "bend" ? fmt(n[k] == null ? NOTE_DEFAULTS[k] || 0 : n[k]) : String(n[k] == null ? NOTE_DEFAULTS[k] : n[k]);
    const kids = n.bendValues && n.bendValues.length
      ? [E.el("bendValues", { count: String(n.bendValues.length) }, n.bendValues.map((b) => E.el("bendValue", { time: fmt(b.time), step: fmt(b.step), unk5: String(b.unk5 || 0) })))]
      : [];
    return E.el(tag, a, kids);
  }
  function trackEl(tr, tag, extraAttrs) {
    const list = (name, items, fn) => E.el(name, { count: String(items.length) }, items.map(fn));
    return E.el(tag, Object.assign({ difficulty: String(tr.difficulty) }, extraAttrs || {}), [
      list("notes", tr.notes, (n) => noteEl(n, "note")),
      list("chords", tr.chords, (c) => E.el("chord", {
        time: fmt(c.time), linkNext: String(c.linkNext | 0), accent: String(c.accent | 0), chordId: String(c.chordId),
        fretHandMute: String(c.fretHandMute | 0), highDensity: String(c.highDensity | 0), ignore: String(c.ignore | 0),
        palmMute: String(c.palmMute | 0), hopo: String(c.hopo | 0), strum: c.strum || "down"
      }, (c.chordNotes || []).map((cn) => noteEl(Object.assign({}, cn, { time: c.time }), "chordNote")))),
      ...(tag === "level" ? [list("fretHandMutes", tr.fretHandMutes || [], (f) => E.el("fretHandMute", { time: fmt(f.time) }))] : []),
      list("anchors", tr.anchors, (a) => E.el("anchor", { time: fmt(a.time), fret: String(a.fret), width: fmt(a.width) })),
      list("handShapes", tr.handShapes, (h) => E.el("handShape", { chordId: String(h.chordId), endTime: fmt(h.endTime), startTime: fmt(h.startTime) }))
    ]);
  }

  /** Document model -> arrangement XML text. */
  E.arrSerialize = function (doc, opts) {
    opts = opts || {};
    const txt = (name, v) => E.el(name, {}, [], v == null ? "" : v);
    const kids = [
      txt("title", doc.title), txt("arrangement", doc.arrangement), txt("part", doc.part), txt("offset", fmt(doc.offset)),
      txt("centOffset", fmt(doc.centOffset)), txt("songLength", fmt(doc.songLength))
    ];
    if (doc.songNameSort != null) kids.push(txt("songNameSort", doc.songNameSort));
    kids.push(txt("startBeat", fmt(doc.startBeat)), txt("averageTempo", fmt(doc.averageTempo)),
      E.el("tuning", Object.fromEntries(doc.tuning.map((v, i) => ["string" + i, String(v)]))),
      txt("capo", doc.capo), txt("artistName", doc.artistName));
    if (doc.artistNameSort != null) kids.push(txt("artistNameSort", doc.artistNameSort));
    kids.push(txt("albumName", doc.albumName));
    if (doc.albumNameSort != null) kids.push(txt("albumNameSort", doc.albumNameSort));
    kids.push(txt("albumYear", doc.albumYear));
    if (doc.albumArt != null) kids.push(txt("albumArt", doc.albumArt));
    kids.push(txt("crowdSpeed", doc.crowdSpeed), E.el("arrangementProperties", Object.fromEntries(Object.entries(doc.properties).map(([k, v]) => [k, String(v)]))),
      txt("lastConversionDateTime", doc.lastConversionDateTime));
    const list = (name, items, fn) => E.el(name, { count: String(items.length) }, items.map(fn));
    kids.push(list("phrases", doc.phrases, (p) => E.el("phrase", { disparity: String(p.disparity | 0), ignore: String(p.ignore | 0),
      maxDifficulty: String(p.maxDifficulty | 0), name: p.name, solo: String(p.solo | 0) })));
    kids.push(list("phraseIterations", doc.phraseIterations, (p) => {
      const attrs = { time: fmt(p.time), phraseId: String(p.phraseId) };
      if (p.variation != null) attrs.variation = p.variation;
      const hl = p.heroLevels && p.heroLevels.length
        ? [E.el("heroLevels", { count: String(p.heroLevels.length) }, p.heroLevels.map((h) => E.el("heroLevel", { difficulty: String(h.difficulty), hero: String(h.hero) })))]
        : [];
      return E.el("phraseIteration", attrs, hl);
    }));
    kids.push(list("newLinkedDiffs", doc.newLinkedDiffs, (l) => E.el("newLinkedDiff", { levelBreak: String(l.levelBreak), ratio: l.ratio || "1.000", phrases: String(l.phrases.length) },
      l.phrases.map((id) => E.el("nld_phrase", { id: String(id) })))));
    kids.push(list("linkedDiffs", doc.linkedDiffs, (l) => E.el("linkedDiff", { childId: String(l.childId), parentId: String(l.parentId) })));
    kids.push(list("phraseProperties", doc.phraseProperties, (p) => E.el("phraseProperty", p)));
    kids.push(list("chordTemplates", doc.chordTemplates, (c) => {
      const a = { chordName: c.chordName || "", displayName: c.displayName || "" };
      for (let i = 0; i < 6; i++) a["fret" + i] = String(c.frets[i]);
      for (let i = 0; i < 6; i++) a["finger" + i] = String(c.fingers[i]);
      return E.el("chordTemplate", a);
    }));
    kids.push(E.el("fretHandMuteTemplates", { count: "0" }));
    kids.push(list("ebeats", doc.ebeats, (b) => E.el("ebeat", { time: fmt(b.time), measure: String(b.measure) })));
    for (const k of ["tonebase", "tonea", "toneb", "tonec", "toned"]) if (doc[k] != null) kids.push(txt(k, doc[k]));
    if (doc.tones && doc.tones.length) kids.push(list("tones", doc.tones, (o) => E.el("tone", Object.assign({ time: fmt(o.time) }, o.id != null ? { id: String(o.id) } : {}, { name: o.name }))));
    kids.push(list("sections", doc.sections, (s) => E.el("section", { name: s.name, number: String(s.number), startTime: fmt(s.startTime) })));
    kids.push(list("events", doc.events, (e) => E.el("event", { time: fmt(e.time), code: e.code })));
    const tt = doc.transcriptionTrack || { difficulty: -1, notes: [], chords: [], anchors: [], handShapes: [] };
    kids.push(trackEl(tt, "transcriptionTrack"));
    kids.push(E.el("levels", { count: String(doc.levels.length) }, doc.levels.map((l) => trackEl(l, "level"))));
    const rootEl = E.el("song", { version: doc.version || "7" }, kids);
    return E.xmlSerialize(rootEl, { comments: opts.comments || [" RockShiny Creator "] });
  };
})(typeof window !== "undefined" ? window : globalThis);
