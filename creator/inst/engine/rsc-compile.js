/* ---------------------------------------------------------------------------
 * rsc-compile.js -- arrangement document (rsc-arrangement.js) -> SNG struct.
 *
 * A re-implementation of what the Rocksmith Custom Song Toolkit writes
 * (Sng2014FileWriter): the same derived values -- beat masks, phrase links,
 * string masks, anchors' first/last note times, fingerprints, chord-notes
 * sharing, note masks, per-iteration note counts, the scoring metadata --
 * checked field by field against the toolkit's .sng files of the sample songs
 * (tests/js/test-engine.js). The toolkit computes in single precision: every
 * time goes through Math.fround, as in C#'s float.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;
  const f32 = Math.fround;

  const M = E.NOTE_MASK = {
    CHORD: 0x02, OPEN: 0x04, FRETHANDMUTE: 0x08, TREMOLO: 0x10, HARMONIC: 0x20, PALMMUTE: 0x40, SLAP: 0x80, PLUCK: 0x100,
    HAMMERON: 0x200, PULLOFF: 0x400, SLIDE: 0x800, BEND: 0x1000, SUSTAIN: 0x2000, TAP: 0x4000, PINCHHARMONIC: 0x8000,
    VIBRATO: 0x10000, MUTE: 0x20000, IGNORE: 0x40000, LEFTHAND: 0x80000, RIGHTHAND: 0x100000, HIGHDENSITY: 0x200000,
    SLIDEUNPITCHEDTO: 0x400000, SINGLE: 0x800000, CHORDNOTES: 0x1000000, DOUBLESTOP: 0x2000000, ACCENT: 0x4000000,
    PARENT: 0x8000000, CHILD: 0x10000000, ARPEGGIO: 0x20000000, STRUM: 0x80000000
  };
  const STANDARD_MIDI = [40, 45, 50, 55, 59, 64];
  const u8 = (v) => v & 255;                   // C# unchecked((Byte)x)

  /** MIDI note of a string/fret (as the toolkit: bass an octave lower, capo on open strings). */
  E.midiNote = function (tuning, string, fret, bass, capo) {
    if (fret === 255 || fret < 0) return -1;
    let note = STANDARD_MIDI[string] + tuning[string] + fret - (bass ? 12 : 0);
    if (capo > 0 && fret === 0) note += capo;
    return note;
  };

  function noteMask(n, single) {
    if (!n) return 0;
    let m = 0;
    if (single) m |= M.SINGLE;
    if (n.fret === 0) m |= M.OPEN;
    if (n.linkNext) m |= M.PARENT;
    if (n.accent) m |= M.ACCENT;
    if (n.bend) m |= M.BEND;
    if (n.hammerOn) m |= M.HAMMERON;
    if (n.harmonic) m |= M.HARMONIC;
    if (single && n.ignore) m |= M.IGNORE;
    if (single && n.leftHand !== -1) m |= M.LEFTHAND;
    if (n.mute) m |= M.MUTE;
    if (n.palmMute) m |= M.PALMMUTE;
    if (n.pluck !== -1) m |= M.PLUCK;
    if (n.pullOff) m |= M.PULLOFF;
    if (n.slap !== -1) m |= M.SLAP;
    if (n.slideTo !== -1) m |= M.SLIDE;
    if (n.sustain) m |= M.SUSTAIN;
    if (n.tremolo) m |= M.TREMOLO;
    if (n.harmonicPinch) m |= M.PINCHHARMONIC;
    if (n.pickDirection) m |= M.PICKDIRECTION_UNUSED || 0;
    if (n.rightHand !== -1) m |= M.RIGHTHAND;
    if (n.slideUnpitchTo !== -1) m |= M.SLIDEUNPITCHEDTO;
    if (n.tap) m |= M.TAP;
    if (n.vibrato) m |= M.VIBRATO;
    return m >>> 0;
  }

  const bend32 = (b) => ({ time: f32(b ? b.time : 0), step: f32(b ? b.step : 0), unk3: 0, unk4: 0, unk5: b ? b.unk5 | 0 : 0 });

  /** Index of the phrase iteration at `time` (end: an iteration starting exactly at time counts for the previous one). */
  function iterationAt(doc, time, end) {
    const it = doc.phraseIterations;
    let id = 0;
    while (id + 1 < it.length) {
      const t = f32(it[id + 1].time);
      if (!end && t > time) break;
      if (end && t >= time) break;
      id++;
    }
    return id;
  }

  /**
   * Compile an arrangement document to an SNG struct (serialise with E.sngSerialize).
   * opts.bass: force bass (else from the arrangement properties / name).
   */
  E.arrCompile = function (doc, opts) {
    opts = opts || {};
    const bass = opts.bass != null ? opts.bass : (+doc.properties.pathBass === 1 || /bass/i.test(doc.arrangement));
    const tuning = doc.tuning.slice(0, 6);
    const s = { vocals: [], symbolsHeader: [], symbolsTexture: [], symbolsDefinition: [], phraseExtraInfo: [], actions: [] };

    // beats
    let measure = 0, beat = 0;
    s.bpms = doc.ebeats.map((b) => {
      if (b.measure >= 0) { measure = b.measure; beat = 0; } else beat++;
      let mask = 0;
      if (beat === 0) { mask |= 1; if (measure % 2 === 0) mask |= 2; }
      return { time: f32(b.time), measure, beat, phraseIteration: iterationAt(doc, f32(b.time), true), mask };
    });

    s.phrases = doc.phrases.map((p, i) => ({
      solo: p.solo | 0, disparity: p.disparity | 0, ignore: p.ignore | 0, padding: 0, maxDifficulty: p.maxDifficulty | 0,
      phraseIterationLinks: doc.phraseIterations.filter((it) => it.phraseId === i).length, name: p.name
    }));

    s.chords = doc.chordTemplates.map((c) => {
      let mask = 0;
      if (/arp$/.test(c.displayName || "")) mask |= 1; else if (/nop$/.test(c.displayName || "")) mask |= 2;
      const frets = c.frets.map(u8), fingers = c.fingers.map(u8);
      return { mask, frets, fingers, notes: frets.map((f, i) => E.midiNote(tuning, i, f, bass, doc.capo)), name: c.chordName || "" };
    });

    s.phraseIterations = doc.phraseIterations.map((it, i) => {
      const diff = [0, 0, 0];
      for (const h of it.heroLevels || []) if (h.hero >= 1 && h.hero <= 3) diff[h.hero - 1] = h.difficulty;
      return { phraseId: it.phraseId, startTime: f32(it.time),
        nextPhraseTime: f32(i + 1 < doc.phraseIterations.length ? doc.phraseIterations[i + 1].time : doc.songLength), difficulty: diff };
    });

    s.nld = doc.newLinkedDiffs.map((l) => ({ levelBreak: l.levelBreak, phrases: l.phrases.slice() }));
    s.events = doc.events.map((e) => ({ time: f32(e.time), name: e.code }));
    s.tones = (doc.tones || []).map((t) => ({ time: f32(t.time), toneId: t.id != null ? t.id : toneIndex(doc, t.name) }));
    const DNA = { dna_none: 0, dna_solo: 1, dna_riff: 2, dna_chord: 3 };
    s.dnas = doc.events.filter((e) => e.code in DNA).map((e) => ({ time: f32(e.time), dnaId: DNA[e.code] }));

    // sections (string masks per difficulty, filled below)
    const maxDiff = doc.levels.length - 1;
    s.sections = doc.sections.map((sec, i) => {
      const start = f32(sec.startTime), endT = f32(i + 1 < doc.sections.length ? doc.sections[i + 1].startTime : doc.songLength);
      const mask = new Array(36).fill(0);
      for (let j = maxDiff; j >= 0; j--) {
        let m = 0;
        const lv = doc.levels[j];
        for (const n of lv.notes) { const t = f32(n.time); if (t >= start && t < endT) m |= 1 << n.string; }
        for (const c of lv.chords) {
          const t = f32(c.time);
          if (t >= start && t < endT) {
            const tp = doc.chordTemplates[c.chordId];
            if (tp) tp.frets.forEach((f, k) => { if (f !== -1) m |= 1 << k; });
          }
        }
        if (m === 0 && j < maxDiff) m = mask[j + 1];
        mask[j] = m;
      }
      return { name: sec.name, number: sec.number, startTime: start, endTime: endT,
        startPhraseIterationId: iterationAt(doc, start, false), endPhraseIterationId: iterationAt(doc, endT, true), stringMask: mask };
    });

    // chord notes are shared between identical records
    s.chordNotes = [];
    const cnIndex = new Map();
    function addChordNotes(chord) {
      const c = { noteMask: [], bendData: [], slideTo: [], slideUnpitchTo: [], vibrato: [] };
      for (let str = 0; str < 6; str++) {
        const n = (chord.chordNotes || []).find((x) => x.string === str) || null;
        c.noteMask.push(noteMask(n, false));
        const vals = [];
        for (let k = 0; k < 32; k++) vals.push(bend32(n && n.bendValues[k]));
        c.bendData.push({ values: vals, usedCount: n ? n.bendValues.length : 0 });
        c.slideTo.push(n ? u8(n.slideTo) : 255);
        c.slideUnpitchTo.push(n ? u8(n.slideUnpitchTo) : 255);
        c.vibrato.push(n ? n.vibrato : 0);
      }
      if (c.noteMask.every((m) => m === 0)) return -1;
      const key = JSON.stringify(c);
      if (cnIndex.has(key)) return cnIndex.get(key);
      cnIndex.set(key, s.chordNotes.length);
      s.chordNotes.push(c);
      return s.chordNotes.length - 1;
    }

    const lastIterTime = f32(doc.phraseIterations.length ? doc.phraseIterations[doc.phraseIterations.length - 1].time : doc.songLength);
    let firstNoteTime = null;
    let noteCount = 0, ignoredCount = 0;
    const noteIds = new Map();

    s.arrangements = doc.levels.map((level) => {
      const a = { difficulty: level.difficulty };
      a.anchors = level.anchors.map((an, j) => ({
        startBeatTime: f32(an.time), endBeatTime: j + 1 < level.anchors.length ? f32(level.anchors[j + 1].time) : lastIterTime,
        firstNoteTime: f32(3.4028234663852886e38), lastNoteTime: f32(1.1754943508222875e-38), fretId: an.fret, padding: [0, 0, 0],
        width: Math.trunc(an.width), phraseIterationId: iterationAt(doc, f32(an.time), false)
      }));
      a.anchorExtensions = [];
      a.fingerprints1 = []; a.fingerprints2 = [];
      for (const h of level.handShapes) {
        if (h.chordId < 0) continue;
        const fp = { chordId: h.chordId, startTime: f32(h.startTime), endTime: f32(h.endTime), firstNoteTime: f32(3.4028234663852886e38), lastNoteTime: f32(1.1754943508222875e-38) };
        const tp = doc.chordTemplates[h.chordId];
        if (tp && /arp$/.test(tp.displayName || "")) a.fingerprints2.push(fp); else a.fingerprints1.push(fp);
      }

      // notes + chords, merged in time order (notes first at equal times)
      const items = level.notes.map((n) => ({ n, chord: false })).concat(level.chords.map((c) => ({ n: c, chord: true })));
      items.sort((x, y) => f32(x.n.time) - f32(y.n.time) || (x.chord - y.chord));
      a.notes = [];
      for (const { n: src, chord } of items) {
        const t = f32(src.time);
        const n = {
          mask: 0, flags: 0, hash: 0, time: t, string: 255, fret: 255, anchorFret: 255, anchorWidth: 255, chordId: -1, chordNotesId: -1,
          phraseId: 0, phraseIterationId: iterationAt(doc, t, false), fingerPrintId: [-1, -1], nextIterNote: -1, prevIterNote: -1,
          parentPrevNote: -1, slideTo: 255, slideUnpitchTo: 255, leftHand: 255, tap: 255, pickDirection: 255, slap: 255, pluck: 255,
          vibrato: 0, sustain: 0, maxBend: 0, bendData: []
        };
        n.phraseId = doc.phraseIterations.length ? doc.phraseIterations[n.phraseIterationId].phraseId : 0;
        let sustain;
        if (!chord) {
          n.mask = noteMask(src, true);
          n.string = src.string; n.fret = u8(src.fret);
          n.slideTo = u8(src.slideTo); n.slideUnpitchTo = u8(src.slideUnpitchTo); n.leftHand = u8(src.leftHand);
          n.tap = src.tap ? u8(src.tap) : 255; n.pickDirection = u8(src.pickDirection); n.slap = u8(src.slap); n.pluck = u8(src.pluck);
          n.vibrato = src.vibrato; n.sustain = f32(src.sustain); n.maxBend = f32(src.bend);
          n.bendData = (src.bendValues || []).map(bend32);
          if (src.slideTo !== -1) a.anchorExtensions.push({ beatTime: f32(t + f32(src.sustain)), fretId: u8(src.slideTo), unk2: 0, unk3: 0, unk4: 0 });
          sustain = f32(src.sustain);
        } else {
          const cnid = addChordNotes(src);
          n.mask = M.CHORD;
          if (cnid !== -1) n.mask |= M.CHORDNOTES;
          if (src.linkNext) n.mask |= M.PARENT;
          if (src.accent) n.mask |= M.ACCENT;
          if (src.fretHandMute) n.mask |= M.FRETHANDMUTE;
          if (src.highDensity) n.mask |= M.HIGHDENSITY;
          if (src.ignore) n.mask |= M.IGNORE;
          if (src.palmMute) n.mask |= M.PALMMUTE;
          n.chordId = src.chordId; n.chordNotesId = cnid;
          for (const cn of src.chordNotes || []) if (cn.sustain > 0) { n.sustain = f32(cn.sustain); break; }
          if (n.sustain > 0) n.mask |= M.SUSTAIN;
          const tp = s.chords[src.chordId];
          if (tp && tp.frets.filter((f) => f !== 255).length === 2) n.mask |= M.DOUBLESTOP;
          n.mask >>>= 0;
          sustain = n.sustain;
        }
        // fingerprints (hand shapes)
        for (let id = 0; id < a.fingerprints1.length; id++) {
          const fp = a.fingerprints1[id];
          if (t >= fp.startTime && t < fp.endTime) {
            n.fingerPrintId[0] = id;
            if (n.chordId !== -1 && !(n.mask & M.HIGHDENSITY)) n.mask = (n.mask | M.STRUM) >>> 0;
            if (fp.firstNoteTime === f32(3.4028234663852886e38)) fp.firstNoteTime = t;
            fp.lastNoteTime = f32(t + (t + sustain < fp.endTime ? sustain : 0));
            break;
          }
        }
        for (let id = 0; id < a.fingerprints2.length; id++) {
          const fp = a.fingerprints2[id];
          if (t >= fp.startTime && t < fp.endTime) {
            n.fingerPrintId[1] = id;
            n.mask = (n.mask | M.ARPEGGIO) >>> 0;
            if (fp.firstNoteTime === f32(3.4028234663852886e38)) fp.firstNoteTime = t;
            fp.lastNoteTime = f32(t + (t + sustain < fp.endTime ? sustain : 0));
            break;
          }
        }
        for (const an of a.anchors) {
          if (t >= an.startBeatTime && t < an.endBeatTime) {
            n.anchorWidth = an.width; n.anchorFret = an.fretId;
            if (an.firstNoteTime === f32(3.4028234663852886e38)) an.firstNoteTime = t;
            an.lastNoteTime = f32(t + (t + sustain < an.endBeatTime - 0.1 ? sustain : 0));
            break;
          }
        }
        if (firstNoteTime == null || t < firstNoteTime) firstNoteTime = t;
        a.notes.push(n);
      }

      // an anchor that only holds the end of a slide (pitched or not) takes that as its note
      const EMPTY = f32(3.4028234663852886e38);
      for (const n of a.notes) {
        if (n.chordId >= 0 || (n.slideTo === 255 && n.slideUnpitchTo === 255)) continue;
        const end = f32(n.time + n.sustain);
        for (const an of a.anchors) {
          if (end >= an.startBeatTime && end < an.endBeatTime) {
            if (an.firstNoteTime === EMPTY) { an.firstNoteTime = end; an.lastNoteTime = f32(end + 0.1); }
            break;
          }
        }
      }

      // linkNext: a single note right after a time group whose last note is a parent is its child
      a.notes.forEach((n, j) => {
        if (n.chordId >= 0) return;
        let k = j - 1;
        while (k >= 0 && a.notes[k].time === n.time) k--;
        if (k >= 0 && (a.notes[k].mask & M.PARENT)) { n.mask = (n.mask | M.CHILD) >>> 0; n.parentPrevNote = k; }
      });
      // hash: one id per distinct note across all levels (links and numbering are not part of it)
      for (const n of a.notes) {
        const key = JSON.stringify([n.mask, n.time, n.string, n.fret, n.anchorFret, n.anchorWidth, n.chordId, n.chordNotesId, n.phraseId,
          n.phraseIterationId, n.fingerPrintId, n.slideTo, n.slideUnpitchTo, n.leftHand, n.tap, n.pickDirection, n.slap, n.pluck,
          n.vibrato, n.sustain, n.maxBend, n.bendData]);
        if (!noteIds.has(key)) noteIds.set(key, noteIds.size);
        n.hash = noteIds.get(key);
      }
      // neighbours within the same phrase iteration
      a.notes.forEach((n, j) => {
        if (j > 0 && a.notes[j - 1].phraseIterationId === n.phraseIterationId) n.prevIterNote = j - 1;
        if (j + 1 < a.notes.length && a.notes[j + 1].phraseIterationId === n.phraseIterationId) n.nextIterNote = j + 1;
      });
      numberNotes(a.notes, s.phraseIterations);

      // per-iteration counts
      const nIt = doc.phraseIterations.length;
      a.notesInIteration1 = new Array(nIt).fill(0);
      a.notesInIteration2 = new Array(nIt).fill(0);
      for (const n of a.notes) {
        a.notesInIteration2[n.phraseIterationId]++;
        if (!(n.mask & M.IGNORE)) a.notesInIteration1[n.phraseIterationId]++;
      }
      // the average per phrase counts ignored notes too (NotesInIteration2)
      a.averageNotesPerIteration = new Array(doc.phrases.length).fill(0);
      const cnt = new Array(doc.phrases.length).fill(0);
      doc.phraseIterations.forEach((it, j) => { a.averageNotesPerIteration[it.phraseId] += a.notesInIteration2[j]; cnt[it.phraseId]++; });
      a.averageNotesPerIteration = a.averageNotesPerIteration.map((v, j) => f32(cnt[j] ? v / cnt[j] : 0));

      // scoring: the notes of the iterations that use this level as their max difficulty; the
      // toolkit subtracts the ignored notes of every level from the "real" count (reproduced)
      doc.phraseIterations.forEach((it, j) => {
        if (doc.phrases[it.phraseId] && doc.phrases[it.phraseId].maxDifficulty === level.difficulty) noteCount += a.notesInIteration2[j];
        ignoredCount += a.notesInIteration2[j] - a.notesInIteration1[j];
      });
      return a;
    });

    const m = {
      maxScore: 100000, maxNotesAndChords: noteCount, maxNotesAndChordsReal: noteCount - ignoredCount, pointsPerNote: noteCount ? 100000 / noteCount : 0,
      firstBeatLength: doc.ebeats.length > 1 ? f32(f32(doc.ebeats[1].time) - f32(doc.ebeats[0].time)) : 0,
      startTime: f32(-doc.offset), capoFretId: doc.capo === 0 ? 255 : doc.capo, lastConversionDateTime: doc.lastConversionDateTime || "",
      part: doc.part, songLength: f32(doc.songLength), tuning: tuning, firstNoteTime: f32(firstNoteTime || 0), firstNoteTime2: f32(firstNoteTime || 0),
      maxDifficulty: maxDiff
    };
    s.metadata = m;
    return s;
  };

  /**
   * Which notes show their fret number (NOTE_FLAGS_NUMBERED), as the toolkit decides:
   * not open strings; not when the same fret (single notes) or the same chord was
   * numbered among the previous 8 notes, within 2 s and in the same phrase iteration
   * (the iteration only advances once a note lies strictly past its end).
   */
  function numberNotes(notes, iters) {
    let p = 0;
    for (let o = 0; o < notes.length; o++) {
      const cur = notes[o];
      if (cur.fret === 0) { cur.flags = 0; continue; }
      if (iters.length && p < iters.length - 1 && cur.time > iters[p].nextPhraseTime) { p++; o--; continue; }
      const start = iters.length ? iters[p].startTime : -Infinity;
      let repeat = false;
      for (let i = o - 1; i >= Math.max(0, o - 8); i--) {
        const q = notes[i];
        if (q.time + 2.0 < cur.time) continue;
        if (q.time < start) continue;
        if ((cur.chordId === -1 && q.fret === cur.fret) || (cur.chordId !== -1 && q.chordId === cur.chordId)) {
          if (q.flags & 1) { repeat = true; break; }
        }
      }
      if (!repeat) cur.flags |= 1;
    }
  }

  function toneIndex(doc, name) {
    const names = [doc.tonea, doc.toneb, doc.tonec, doc.toned];
    const i = names.indexOf(name);
    return i < 0 ? 0 : i;
  }
})(typeof window !== "undefined" ? window : globalThis);
