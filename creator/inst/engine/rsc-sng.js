/* ---------------------------------------------------------------------------
 * rsc-sng.js -- Rocksmith 2014 compiled charts (.sng): container, full parse,
 * serialise. (The XML -> SNG compiler is in rsc-arrangement.js.)
 *
 * Container: u32 0x4A | u32 flags (3: compressed + encrypted) | 16-byte IV |
 *            AES-CTR( u32 uncompressed length | zlib(body) ) | 56-byte signature
 * Body: length-prefixed (u32 count) arrays of packed little-endian structs, in
 * the order of SECTIONS below. parse() reads every field and serialize() writes
 * them back byte for byte (tested on every .sng of the sample songs).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;

  /** Key for a platform: "pc" (Windows, songs/bin/generic) or "mac" (songs/bin/macos). */
  E.sngKey = (platform) => (platform === "mac" ? E.KEYS.sngMac : E.KEYS.sngPC);

  /** Decrypt + inflate. platform "auto" tries PC then Mac. -> {body, platform, iv} */
  E.sngDecrypt = async function (u8, platform) {
    const r = new E.Reader(u8);
    if (u8.length < 28 || r.u32() !== 0x4a) throw new Error("Not a Rocksmith SNG file.");
    const iv = u8.slice(8, 24), payload = u8.subarray(24);
    const tries = platform === "mac" ? ["mac"] : platform === "pc" ? ["pc"] : ["pc", "mac"];
    for (const p of tries) {
      const plain = E.aesCtr(payload, E.sngKey(p), iv);
      if (plain.length > 6 && plain[4] === 0x78) {
        const len = new DataView(plain.buffer).getUint32(0, true);
        // the zlib stream is followed by the 56-byte signature (decrypted: junk), which strict
        // inflaters (the browser's DecompressionStream) refuse: cut it, else try the whole rest
        for (const end of [plain.length - 56, plain.length]) {
          try {
            const body = await E.inflate(plain.subarray(4, end));
            if (body.length === len) return { body, platform: p, iv };
          } catch (err) { /* next variant / key */ }
        }
        // more bytes after the stream (some toolkits pad the file): keep what inflates before them
        try {
          const body = await E.inflateLenient(plain.subarray(4));
          if (body.length >= len) return { body: body.length === len ? body : body.slice(0, len), platform: p, iv };
        } catch (err) { /* next key */ }
      }
    }
    throw new Error("Could not decrypt the SNG (unknown platform key).");
  };

  /** Compress + encrypt a body. opts.iv (16 bytes) defaults to zeros (deterministic output). */
  E.sngEncrypt = async function (body, platform, opts) {
    opts = opts || {};
    const z = await E.deflate(body);
    const plain = new Uint8Array(4 + z.length);
    new DataView(plain.buffer).setUint32(0, body.length, true);
    plain.set(z, 4);
    const iv = opts.iv || new Uint8Array(16);
    const enc = E.aesCtr(plain, E.sngKey(platform), iv);
    const w = new E.Writer(24 + enc.length + 56);
    w.u32(0x4a).u32(3).bytes(iv).bytes(enc).zeros(56);
    return w.result();
  };

  // ---- struct codecs: [name, type] with types u8 i8 u16 i16 u32 i32 f32 f64, "u8[n]", "cstr:n", ...
  const T = {
    bpm: [["time", "f32"], ["measure", "i16"], ["beat", "i16"], ["phraseIteration", "i32"], ["mask", "i32"]],
    phrase: [["solo", "u8"], ["disparity", "u8"], ["ignore", "u8"], ["padding", "u8"], ["maxDifficulty", "i32"],
      ["phraseIterationLinks", "i32"], ["name", "cstr:32"]],
    chord: [["mask", "u32"], ["frets", "u8[6]"], ["fingers", "u8[6]"], ["notes", "i32[6]"], ["name", "cstr:32"]],
    bend32: [["time", "f32"], ["step", "f32"], ["unk3", "i16"], ["unk4", "u8"], ["unk5", "u8"]],
    vocal: [["time", "f32"], ["note", "i32"], ["length", "f32"], ["lyric", "cstr:48"]],
    symHeader: [["unk", "i32[8]"]],
    symTexture: [["font", "cstr:128"], ["fontpathLength", "i32"], ["unk1", "i32"], ["width", "i32"], ["height", "i32"]],
    symDef: [["text", "cstr:12"], ["outer", "f32[4]"], ["inner", "f32[4]"]],
    phraseIteration: [["phraseId", "i32"], ["startTime", "f32"], ["nextPhraseTime", "f32"], ["difficulty", "i32[3]"]],
    phraseExtra: [["phraseId", "i32"], ["difficulty", "i32"], ["empty", "i32"], ["levelJump", "u8"], ["redundant", "i16"], ["padding", "u8"]],
    action: [["time", "f32"], ["name", "cstr:256"]],
    event: [["time", "f32"], ["name", "cstr:256"]],
    tone: [["time", "f32"], ["toneId", "i32"]],
    dna: [["time", "f32"], ["dnaId", "i32"]],
    section: [["name", "cstr:32"], ["number", "i32"], ["startTime", "f32"], ["endTime", "f32"], ["startPhraseIterationId", "i32"],
      ["endPhraseIterationId", "i32"], ["stringMask", "u8[36]"]],
    anchor: [["startBeatTime", "f32"], ["endBeatTime", "f32"], ["firstNoteTime", "f32"], ["lastNoteTime", "f32"], ["fretId", "u8"],
      ["padding", "u8[3]"], ["width", "i32"], ["phraseIterationId", "i32"]],
    anchorExt: [["beatTime", "f32"], ["fretId", "u8"], ["unk2", "i32"], ["unk3", "i16"], ["unk4", "u8"]],
    fingerprint: [["chordId", "i32"], ["startTime", "f32"], ["endTime", "f32"], ["firstNoteTime", "f32"], ["lastNoteTime", "f32"]],
    note: [["mask", "u32"], ["flags", "u32"], ["hash", "u32"], ["time", "f32"], ["string", "u8"], ["fret", "u8"], ["anchorFret", "u8"],
      ["anchorWidth", "u8"], ["chordId", "i32"], ["chordNotesId", "i32"], ["phraseId", "i32"], ["phraseIterationId", "i32"],
      ["fingerPrintId", "i16[2]"], ["nextIterNote", "i16"], ["prevIterNote", "i16"], ["parentPrevNote", "i16"], ["slideTo", "u8"],
      ["slideUnpitchTo", "u8"], ["leftHand", "u8"], ["tap", "u8"], ["pickDirection", "u8"], ["slap", "u8"], ["pluck", "u8"],
      ["vibrato", "i16"], ["sustain", "f32"], ["maxBend", "f32"]]
  };
  E.SNG_STRUCTS = T;

  function readField(r, type) {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(type);
    if (type.startsWith("cstr:")) return r.cstr(+type.slice(5));
    const one = () => {
      switch (m[1]) {
        case "u8": return r.u8v(); case "i8": return r.i8(); case "u16": return r.u16(); case "i16": return r.i16();
        case "u32": return r.u32(); case "i32": return r.i32(); case "f32": return r.f32(); case "f64": return r.f64();
      }
      throw new Error("bad type " + type);
    };
    if (m[2]) { const a = []; for (let i = 0; i < +m[2]; i++) a.push(one()); return a; }
    return one();
  }
  function writeField(w, type, v) {
    if (type.startsWith("cstr:")) { w.cstr(v, +type.slice(5)); return; }
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(type);
    const one = (x) => {
      switch (m[1]) {
        case "u8": w.u8(x); break; case "i8": w.i8(x); break; case "u16": w.u16(x); break; case "i16": w.i16(x); break;
        case "u32": w.u32(x); break; case "i32": w.i32(x); break; case "f32": w.f32(x); break; case "f64": w.f64(x); break;
        default: throw new Error("bad type " + type);
      }
    };
    if (m[2]) { for (let i = 0; i < +m[2]; i++) one(v[i]); } else one(v);
  }
  const readStruct = (r, def) => { const o = {}; for (const [k, t] of def) o[k] = readField(r, t); return o; };
  const writeStruct = (w, def, o) => { for (const [k, t] of def) writeField(w, t, o[k]); };
  const readArray = (r, fn) => { const n = r.u32(), a = new Array(n); for (let i = 0; i < n; i++) a[i] = fn(); return a; };
  const writeArray = (w, a, fn) => { w.u32(a.length); for (const x of a) fn(x); };

  function readChordNotes(r) {
    const o = { noteMask: readField(r, "u32[6]"), bendData: [] };
    for (let s = 0; s < 6; s++) {
      const bv = [];
      for (let i = 0; i < 32; i++) bv.push(readStruct(r, T.bend32));
      o.bendData.push({ values: bv, usedCount: r.i32() });
    }
    o.slideTo = readField(r, "u8[6]"); o.slideUnpitchTo = readField(r, "u8[6]"); o.vibrato = readField(r, "i16[6]");
    return o;
  }
  function writeChordNotes(w, o) {
    writeField(w, "u32[6]", o.noteMask);
    for (let s = 0; s < 6; s++) {
      for (let i = 0; i < 32; i++) writeStruct(w, T.bend32, o.bendData[s].values[i]);
      w.i32(o.bendData[s].usedCount);
    }
    writeField(w, "u8[6]", o.slideTo); writeField(w, "u8[6]", o.slideUnpitchTo); writeField(w, "i16[6]", o.vibrato);
  }

  /** Full parse of a decrypted SNG body (every field). */
  E.sngParse = function (body) {
    const r = new E.Reader(body);
    const s = {};
    s.bpms = readArray(r, () => readStruct(r, T.bpm));
    s.phrases = readArray(r, () => readStruct(r, T.phrase));
    s.chords = readArray(r, () => readStruct(r, T.chord));
    s.chordNotes = readArray(r, () => readChordNotes(r));
    s.vocals = readArray(r, () => readStruct(r, T.vocal));
    if (s.vocals.length) {
      s.symbolsHeader = readArray(r, () => readStruct(r, T.symHeader));
      s.symbolsTexture = readArray(r, () => readStruct(r, T.symTexture));
      s.symbolsDefinition = readArray(r, () => readStruct(r, T.symDef));
    }
    s.phraseIterations = readArray(r, () => readStruct(r, T.phraseIteration));
    s.phraseExtraInfo = readArray(r, () => readStruct(r, T.phraseExtra));
    s.nld = readArray(r, () => { const levelBreak = r.i32(); return { levelBreak, phrases: readArray(r, () => r.i32()) }; });
    s.actions = readArray(r, () => readStruct(r, T.action));
    s.events = readArray(r, () => readStruct(r, T.event));
    s.tones = readArray(r, () => readStruct(r, T.tone));
    s.dnas = readArray(r, () => readStruct(r, T.dna));
    s.sections = readArray(r, () => readStruct(r, T.section));
    s.arrangements = readArray(r, () => {
      const a = { difficulty: r.i32() };
      a.anchors = readArray(r, () => readStruct(r, T.anchor));
      a.anchorExtensions = readArray(r, () => readStruct(r, T.anchorExt));
      a.fingerprints1 = readArray(r, () => readStruct(r, T.fingerprint));
      a.fingerprints2 = readArray(r, () => readStruct(r, T.fingerprint));
      a.notes = readArray(r, () => { const n = readStruct(r, T.note); n.bendData = readArray(r, () => readStruct(r, T.bend32)); return n; });
      a.averageNotesPerIteration = readArray(r, () => r.f32());
      a.notesInIteration1 = readArray(r, () => r.i32());
      a.notesInIteration2 = readArray(r, () => r.i32());
      return a;
    });
    const m = {};
    m.maxScore = r.f64(); m.maxNotesAndChords = r.f64(); m.maxNotesAndChordsReal = r.f64(); m.pointsPerNote = r.f64();
    m.firstBeatLength = r.f32(); m.startTime = r.f32(); m.capoFretId = r.u8v(); m.lastConversionDateTime = r.cstr(32);
    m.part = r.i16(); m.songLength = r.f32(); m.tuning = readArray(r, () => r.i16());
    m.firstNoteTime = r.f32(); m.firstNoteTime2 = r.f32(); m.maxDifficulty = r.i32();
    s.metadata = m;
    s.trailing = r.left;
    return s;
  };

  /** Inverse of sngParse(). */
  E.sngSerialize = function (s) {
    const w = new E.Writer(1 << 18);
    writeArray(w, s.bpms, (x) => writeStruct(w, T.bpm, x));
    writeArray(w, s.phrases, (x) => writeStruct(w, T.phrase, x));
    writeArray(w, s.chords, (x) => writeStruct(w, T.chord, x));
    writeArray(w, s.chordNotes, (x) => writeChordNotes(w, x));
    writeArray(w, s.vocals, (x) => writeStruct(w, T.vocal, x));
    if (s.vocals.length) {
      writeArray(w, s.symbolsHeader || [], (x) => writeStruct(w, T.symHeader, x));
      writeArray(w, s.symbolsTexture || [], (x) => writeStruct(w, T.symTexture, x));
      writeArray(w, s.symbolsDefinition || [], (x) => writeStruct(w, T.symDef, x));
    }
    writeArray(w, s.phraseIterations, (x) => writeStruct(w, T.phraseIteration, x));
    writeArray(w, s.phraseExtraInfo, (x) => writeStruct(w, T.phraseExtra, x));
    writeArray(w, s.nld, (x) => { w.i32(x.levelBreak); writeArray(w, x.phrases, (p) => w.i32(p)); });
    writeArray(w, s.actions, (x) => writeStruct(w, T.action, x));
    writeArray(w, s.events, (x) => writeStruct(w, T.event, x));
    writeArray(w, s.tones, (x) => writeStruct(w, T.tone, x));
    writeArray(w, s.dnas, (x) => writeStruct(w, T.dna, x));
    writeArray(w, s.sections, (x) => writeStruct(w, T.section, x));
    writeArray(w, s.arrangements, (a) => {
      w.i32(a.difficulty);
      writeArray(w, a.anchors, (x) => writeStruct(w, T.anchor, x));
      writeArray(w, a.anchorExtensions, (x) => writeStruct(w, T.anchorExt, x));
      writeArray(w, a.fingerprints1, (x) => writeStruct(w, T.fingerprint, x));
      writeArray(w, a.fingerprints2, (x) => writeStruct(w, T.fingerprint, x));
      writeArray(w, a.notes, (n) => { writeStruct(w, T.note, n); writeArray(w, n.bendData, (b) => writeStruct(w, T.bend32, b)); });
      writeArray(w, a.averageNotesPerIteration, (x) => w.f32(x));
      writeArray(w, a.notesInIteration1, (x) => w.i32(x));
      writeArray(w, a.notesInIteration2, (x) => w.i32(x));
    });
    const m = s.metadata;
    w.f64(m.maxScore).f64(m.maxNotesAndChords).f64(m.maxNotesAndChordsReal).f64(m.pointsPerNote);
    w.f32(m.firstBeatLength).f32(m.startTime).u8(m.capoFretId).cstr(m.lastConversionDateTime, 32);
    w.i16(m.part).f32(m.songLength);
    writeArray(w, m.tuning, (x) => w.i16(x));
    w.f32(m.firstNoteTime).f32(m.firstNoteTime2).i32(m.maxDifficulty);
    return w.result();
  };

  /** Vocals-only SNG body (lyrics). vocals: [{time, note, length, lyric}] */
  E.sngVocalsBody = function (vocals, opts) {
    opts = opts || {};
    const s = {
      bpms: [], phrases: [], chords: [], chordNotes: [],
      vocals: vocals.map((v) => ({ time: v.time, note: v.note == null ? 254 : v.note, length: v.length, lyric: v.lyric })),
      symbolsHeader: [], symbolsTexture: [], symbolsDefinition: [],
      phraseIterations: [], phraseExtraInfo: [], nld: [], actions: [], events: [], tones: [], dnas: [], sections: [], arrangements: [],
      metadata: {
        maxScore: 0, maxNotesAndChords: 0, maxNotesAndChordsReal: 0, pointsPerNote: 0, firstBeatLength: 0, startTime: 0,
        capoFretId: 255, lastConversionDateTime: "", part: 0, songLength: 0, tuning: [], firstNoteTime: 0, firstNoteTime2: 0, maxDifficulty: 0
      }
    };
    if (opts.template) Object.assign(s, opts.template);
    return E.sngSerialize(s);
  };
})(typeof window !== "undefined" ? window : globalThis);
