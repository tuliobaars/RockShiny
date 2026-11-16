/* ---------------------------------------------------------------------------
 * rsc-project.js -- a song as the Creator edits it, and the way back to a
 * Rocksmith 2014 package.
 *
 *   const {project, source} = await E.projectFromPsarc(bytes)   // open
 *   const files = await E.projectFiles(project, source)         // [{name, data}]
 *   const bytes = await E.psarcWrite(files)                     // save
 *   const {project, source} = await E.projectNew(opts)          // from scratch
 *
 * A project is plain JSON (it travels between the browser and R):
 *   {format, key, platform, meta, beats, sections, arrangements: [{id, name, kind,
 *    doc (the chart: arrangement document with one level), levels, origin, edited}],
 *   vocals: {syllables, origin, edited}, audio, art, files}
 * `source` holds the bytes: the original archive (read(name)) plus new files.
 *
 * Saving is minimal: whatever was not edited is written back byte for byte
 * (charts, manifests, audio, art); an edited chart gets a new XML + compiled
 * SNG, edited metadata patches the manifests and header.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;
  E.PROJECT_FORMAT = "rockshiny-creator/1";
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // ---- Dynamic Difficulty -> one level (the chart the editor shows) ------------------------------
  /**
   * Merge the difficulty levels into the full chart: for every phrase iteration the
   * level of the phrase's max difficulty (or the highest one present below it), as
   * RockShiny's build_chart(). The result has one level (difficulty 0).
   */
  E.arrMergeLevels = function (doc) {
    if (doc.levels.length <= 1) {
      const d = clone(doc);
      if (d.levels.length) d.levels[0].difficulty = 0; else d.levels = [{ difficulty: 0, notes: [], chords: [], fretHandMutes: [], anchors: [], handShapes: [] }];
      d.phrases.forEach((p) => { p.maxDifficulty = 0; });
      return d;
    }
    const its = doc.phraseIterations.slice().sort((a, b) => a.time - b.time);
    const avail = doc.levels.map((l) => l.difficulty).sort((a, b) => a - b);
    const chosen = its.map((it) => {
      const target = (doc.phrases[it.phraseId] || { maxDifficulty: avail[avail.length - 1] }).maxDifficulty;
      const ok = avail.filter((a) => a <= target);
      return ok.length ? ok[ok.length - 1] : avail[0];
    });
    const times = its.map((it) => it.time);
    const iterAt = (t) => { let lo = 0, hi = times.length - 1, r = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
    const levelOf = (t) => (times.length && t >= times[0] ? chosen[iterAt(t)] : chosen[0]);
    const out = { difficulty: 0, notes: [], chords: [], fretHandMutes: [], anchors: [], handShapes: [] };
    for (const lv of doc.levels) {
      for (const n of lv.notes) if (levelOf(n.time) === lv.difficulty) out.notes.push(clone(n));
      for (const c of lv.chords) if (levelOf(c.time) === lv.difficulty) out.chords.push(clone(c));
      for (const a of lv.anchors) if (levelOf(a.time) === lv.difficulty) out.anchors.push(clone(a));
      for (const h of lv.handShapes) if (levelOf(h.startTime) === lv.difficulty) out.handShapes.push(clone(h));
    }
    // every iteration starts with the anchor its level has in force there
    its.forEach((it, j) => {
      const lv = doc.levels.find((l) => l.difficulty === chosen[j]);
      if (!lv || !lv.anchors.length) return;
      const end = j + 1 < its.length ? its[j + 1].time : Infinity;
      if (out.anchors.some((a) => a.time >= it.time - 1e-6 && a.time < end && Math.abs(a.time - it.time) < 1e-3)) return;
      const hasNote = out.notes.some((n) => n.time >= it.time && n.time < end) || out.chords.some((c) => c.time >= it.time && c.time < end);
      if (!hasNote) return;
      let act = null;
      for (const a of lv.anchors) if (a.time <= it.time + 1e-6) act = a;
      if (act && !out.anchors.some((a) => Math.abs(a.time - it.time) < 1e-3)) out.anchors.push({ time: it.time, fret: act.fret, width: act.width });
    });
    const byTime = (a, b) => a.time - b.time;
    out.notes.sort((a, b) => a.time - b.time || a.string - b.string);
    out.chords.sort(byTime); out.anchors.sort(byTime); out.handShapes.sort((a, b) => a.startTime - b.startTime);
    const d = clone(Object.assign({}, doc, { levels: [] }));
    d.levels = [out];
    d.phrases.forEach((p) => { p.maxDifficulty = 0; });
    d.phraseIterations.forEach((p) => { p.heroLevels = []; });
    d.newLinkedDiffs = []; d.linkedDiffs = [];
    return d;
  };

  // ---- SNG -> arrangement document (official DLC ships charts only as SNG) ----------------------------
  const M = E.NOTE_MASK;
  const s8 = (v) => (v === 255 ? -1 : v);
  function noteFromMask(mask, o) {
    return Object.assign({
      linkNext: mask & M.PARENT ? 1 : 0, accent: mask & M.ACCENT ? 1 : 0, bend: 0, fret: 0, hammerOn: mask & M.HAMMERON ? 1 : 0,
      harmonic: mask & M.HARMONIC ? 1 : 0, hopo: mask & (M.HAMMERON | M.PULLOFF) ? 1 : 0, ignore: mask & M.IGNORE ? 1 : 0,
      leftHand: -1, mute: mask & M.MUTE ? 1 : 0, palmMute: mask & M.PALMMUTE ? 1 : 0, pluck: -1, pullOff: mask & M.PULLOFF ? 1 : 0,
      slap: -1, slideTo: -1, string: 0, sustain: 0, tremolo: mask & M.TREMOLO ? 1 : 0, harmonicPinch: mask & M.PINCHHARMONIC ? 1 : 0,
      pickDirection: 0, rightHand: -1, slideUnpitchTo: -1, tap: mask & M.TAP ? 1 : 0, vibrato: 0, bendValues: []
    }, o);
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  E.arrFromSng = function (s, info) {
    info = info || {};
    const m = s.metadata;
    const doc = {
      version: "7", comments: [" Generated from SNG by RockShiny Creator "], title: info.title || "", arrangement: info.arrangement || "",
      part: m.part, offset: r3(-m.startTime), centOffset: info.centOffset || 0, songLength: r3(m.songLength), songNameSort: null, startBeat: 0,
      averageTempo: info.averageTempo || 120, tuning: [0, 1, 2, 3, 4, 5].map((i) => m.tuning[i] || 0), capo: m.capoFretId === 255 ? 0 : m.capoFretId,
      artistName: info.artist || "", artistNameSort: null, albumName: info.album || "", albumNameSort: null, albumYear: info.year || "",
      albumArt: null, crowdSpeed: 1, properties: info.properties || {}, lastConversionDateTime: m.lastConversionDateTime,
      phrases: s.phrases.map((p) => ({ disparity: p.disparity, ignore: p.ignore, maxDifficulty: p.maxDifficulty, name: p.name, solo: p.solo })),
      phraseIterations: s.phraseIterations.map((p) => ({ time: r3(p.startTime), phraseId: p.phraseId, variation: null,
        heroLevels: p.difficulty.map((d, i) => ({ difficulty: d, hero: i + 1 })).filter((h) => h.difficulty > 0) })),
      newLinkedDiffs: s.nld.map((l) => ({ levelBreak: l.levelBreak, ratio: "1.000", phrases: l.phrases.slice() })), linkedDiffs: [], phraseProperties: [],
      chordTemplates: s.chords.map((c) => ({ chordName: c.name, displayName: c.name + (c.mask & 1 ? "-arp" : c.mask & 2 ? "-nop" : ""),
        frets: c.frets.map(s8), fingers: c.fingers.map(s8) })),
      fretHandMuteTemplates: [],
      ebeats: s.bpms.map((b) => ({ time: r3(b.time), measure: b.mask & 1 ? b.measure : -1 })),
      tonebase: info.tonebase || null, tonea: info.tonea || null, toneb: info.toneb || null, tonec: info.tonec || null, toned: info.toned || null,
      tones: s.tones.map((t) => ({ time: r3(t.time), id: t.toneId, name: (info.toneNames || [])[t.toneId] || "" })),
      sections: s.sections.map((x) => ({ name: x.name, number: x.number, startTime: r3(x.startTime) })),
      events: s.events.map((e) => ({ time: r3(e.time), code: e.name })), transcriptionTrack: null,
      levels: s.arrangements.map((a) => {
        const lv = { difficulty: a.difficulty, notes: [], chords: [], fretHandMutes: [], anchors: [], handShapes: [] };
        lv.anchors = a.anchors.map((x) => ({ time: r3(x.startBeatTime), fret: x.fretId, width: x.width }));
        lv.handShapes = a.fingerprints1.concat(a.fingerprints2).map((f) => ({ chordId: f.chordId, startTime: r3(f.startTime), endTime: r3(f.endTime) }))
          .sort((p, q) => p.startTime - q.startTime);
        for (const n of a.notes) {
          if (n.chordId < 0) {
            lv.notes.push(noteFromMask(n.mask, {
              time: r3(n.time), string: n.string, fret: n.fret, sustain: r3(n.sustain), bend: n.maxBend, slideTo: s8(n.slideTo),
              slideUnpitchTo: s8(n.slideUnpitchTo), leftHand: s8(n.leftHand), pluck: s8(n.pluck), slap: s8(n.slap),
              pickDirection: n.pickDirection === 255 ? 0 : n.pickDirection, tap: n.tap === 255 ? 0 : n.tap, vibrato: n.vibrato,
              rightHand: n.mask & M.RIGHTHAND ? 1 : -1,
              bendValues: n.bendData.map((b) => ({ time: r3(b.time), step: b.step, unk5: b.unk5 }))
            }));
          } else {
            const tp = s.chords[n.chordId] || { frets: [255, 255, 255, 255, 255, 255] };
            const cn = n.chordNotesId >= 0 ? s.chordNotes[n.chordNotesId] : null;
            const chordNotes = [];
            for (let str = 0; str < 6; str++) {
              if (tp.frets[str] === 255) continue;
              const mk = cn ? cn.noteMask[str] : 0;
              if (!cn) { chordNotes.push(noteFromMask(0, { time: r3(n.time), string: str, fret: tp.frets[str], sustain: r3(n.sustain) })); continue; }
              const bd = cn.bendData[str];
              chordNotes.push(noteFromMask(mk, {
                time: r3(n.time), string: str, fret: tp.frets[str], sustain: r3(n.sustain), slideTo: s8(cn.slideTo[str]),
                slideUnpitchTo: s8(cn.slideUnpitchTo[str]), vibrato: cn.vibrato[str],
                bendValues: bd.values.slice(0, bd.usedCount).map((b) => ({ time: r3(b.time), step: b.step, unk5: b.unk5 })),
                bend: bd.usedCount ? Math.max(...bd.values.slice(0, bd.usedCount).map((b) => b.step)) : 0
              }));
            }
            lv.chords.push({ time: r3(n.time), linkNext: n.mask & M.PARENT ? 1 : 0, accent: n.mask & M.ACCENT ? 1 : 0, chordId: n.chordId,
              fretHandMute: n.mask & M.FRETHANDMUTE ? 1 : 0, highDensity: n.mask & M.HIGHDENSITY ? 1 : 0, ignore: n.mask & M.IGNORE ? 1 : 0,
              palmMute: n.mask & M.PALMMUTE ? 1 : 0, hopo: 0, strum: "down", chordNotes });
          }
        }
        return lv;
      })
    };
    return doc;
  };

  // ---- helpers ------------------------------------------------------------------------------------------
  const lowerKey = (p) => p.key.toLowerCase();
  E.pathsFor = function (project) {
    const P = E.PLATFORMS[project.platform], k = lowerKey(project);
    return {
      arrXml: (id) => "songs/arr/" + id + ".xml", sng: (id) => P.sng + "/" + id + ".sng",
      manifest: (id) => "manifests/songs_dlc_" + k + "/" + id + ".json", hsan: "manifests/songs_dlc_" + k + "/songs_dlc_" + k + ".hsan",
      showlights: "songs/arr/" + k + "_showlights.xml", xblock: "gamexblocks/nsongs/" + k + ".xblock",
      graph: k + "_aggregategraph.nt", bank: P.audio + "/song_" + k + ".bnk", previewBank: P.audio + "/song_" + k + "_preview.bnk",
      wem: (id) => P.audio + "/" + id + ".wem", art: (n) => "gfxassets/album_art/album_" + k + "_" + n + ".dds",
      flatRoot: "flatmodels/rs/rsenumerable_root.flat", flatSong: "flatmodels/rs/rsenumerable_song.flat"
    };
  };

  /** A source of file bytes: an opened archive plus added / replaced files. */
  E.makeSource = function (arc) {
    const added = new Map();
    return {
      arc, added,
      has: (n) => added.has(n) || (arc ? arc.has(n) : false),
      read: (n) => (added.has(n) ? Promise.resolve(added.get(n)) : arc ? arc.read(n) : Promise.reject(new Error("No file " + n))),
      put: (n, bytes) => added.set(n, bytes),
      names: () => Array.from(new Set((arc ? arc.names() : []).concat(Array.from(added.keys()))))
    };
  };

  // ---- open ------------------------------------------------------------------------------------------------
  /** Open a .psarc (bytes) for editing. -> {project, source} */
  E.projectFromPsarc = async function (u8, opts) {
    opts = opts || {};
    const arc = await E.psarcOpen(u8);
    const names = arc.names(), platform = E.platformOf(names), base = (p) => p.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
    const manifests = names.filter((n) => /^manifests\/.*\.json$/.test(n));
    const mf = {};
    for (const n of manifests) {
      try { const j = JSON.parse(E.fromUtf8(await arc.read(n))); mf[base(n)] = { name: n, attrs: Object.values(j.Entries)[0].Attributes }; } catch (e) { /* unreadable manifest */ }
    }
    const firstAttrs = (Object.values(mf).find((m) => m.attrs && m.attrs.SongName) || { attrs: {} }).attrs;
    const xmls = names.filter((n) => /^songs\/arr\/.*\.xml$/.test(n)), sngs = names.filter((n) => /^songs\/bin\/.*\.sng$/.test(n));
    const ids = Array.from(new Set(xmls.concat(sngs).map(base))).filter((b) => !/_(showlights)$/.test(b));
    const key = firstAttrs.SongKey || firstAttrs.DLCKey || (ids[0] || "song").replace(/_[a-z0-9]+$/, "");
    const project = {
      format: E.PROJECT_FORMAT, key, platform, files: names,
      meta: {
        title: firstAttrs.SongName || "", titleSort: firstAttrs.SongNameSort || "", artist: firstAttrs.ArtistName || "",
        artistSort: firstAttrs.ArtistNameSort || "", album: firstAttrs.AlbumName || "", albumSort: firstAttrs.AlbumNameSort || "",
        year: firstAttrs.SongYear ? String(firstAttrs.SongYear) : "", averageTempo: firstAttrs.SongAverageTempo || 120,
        songLength: firstAttrs.SongLength || 0, volume: firstAttrs.SongVolume != null ? firstAttrs.SongVolume : -7,
        previewVolume: firstAttrs.PreviewVolume != null ? firstAttrs.PreviewVolume : -7, metaEdited: false
      },
      arrangements: [], vocals: null, beats: [], sections: [], beatsEdited: false, sectionsEdited: false
    };
    const vocalIds = ids.filter((b) => /_j?vocals$/.test(b));
    for (const id of ids.filter((b) => !/_j?vocals$/.test(b))) {
      const xml = xmls.find((n) => base(n) === id) || null, sng = sngs.find((n) => base(n) === id) || null;
      const m = mf[id];
      let doc;
      if (xml) doc = E.arrParse(await arc.read(xml));
      else {
        const s = E.sngParse((await E.sngDecrypt(await arc.read(sng), platform)).body);
        const a = (m && m.attrs) || {};
        doc = E.arrFromSng(s, { title: project.meta.title, artist: project.meta.artist, album: project.meta.album, year: project.meta.year,
          arrangement: a.ArrangementName, properties: a.ArrangementProperties, centOffset: a.CentOffset, averageTempo: a.SongAverageTempo,
          tonebase: a.Tone_Base, tonea: a.Tone_A, toneb: a.Tone_B, tonec: a.Tone_C, toned: a.Tone_D,
          toneNames: [a.Tone_A, a.Tone_B, a.Tone_C, a.Tone_D] });
      }
      const name = (m && m.attrs.ArrangementName) || doc.arrangement || "Lead";
      const kind = E.kindOf(name, (m && m.attrs.ArrangementProperties) || doc.properties);
      const arr = {
        id, name, kind, represent: !m || m.attrs.Representative !== 0, bonus: !!(m && m.attrs.ArrangementProperties && m.attrs.ArrangementProperties.bonusArr),
        levels: doc.levels.length, doc: null, dd: null,
        origin: { xml, sng, manifest: m ? m.name : null }, persistentId: m ? m.attrs.PersistentID : null,
        tones: m && m.attrs.Tones ? m.attrs.Tones : null, edited: false
      };
      E.ddInit(arr, doc);          // difficulty levels kept (rsc-difficulty.js); the hardest chart is the view
      project.arrangements.push(arr);
    }
    const order = { lead: 0, rhythm: 1, combo: 2, bass: 3 };
    project.arrangements.sort((a, b) => order[a.kind] - order[b.kind] || a.id.localeCompare(b.id));
    if (project.arrangements.length) {
      const d = project.arrangements[0].doc;
      project.beats = d.ebeats.map((b) => ({ time: b.time, measure: b.measure }));
      project.sections = d.sections.map((s) => ({ name: s.name, number: s.number, startTime: s.startTime }));
      if (!project.meta.songLength) project.meta.songLength = d.songLength;
    }
    const vid = vocalIds.find((b) => !/jvocals$/.test(b)) || vocalIds[0];
    if (vid) {
      const xml = xmls.find((n) => base(n) === vid), sng = sngs.find((n) => base(n) === vid);
      let syl = [];
      try {
        syl = xml ? E.vocalsParse(await arc.read(xml)) : E.vocalsFromSng(E.sngParse((await E.sngDecrypt(await arc.read(sng), platform)).body));
      } catch (e) { syl = []; }
      project.vocals = { id: vid, syllables: syl, origin: { xml: xml || null, sng: sng || null, manifest: mf[vid] ? mf[vid].name : null },
        persistentId: mf[vid] ? mf[vid].attrs.PersistentID : null, edited: false };
    }
    // audio: the full song is the .wem the song bank references
    const P = E.PLATFORMS[platform];
    const wems = names.filter((n) => /\.wem$/.test(n)), banks = names.filter((n) => /\.bnk$/.test(n));
    const songBank = banks.find((n) => !/_preview\.bnk$/.test(n)), prevBank = banks.find((n) => /_preview\.bnk$/.test(n));
    const wemOfBank = async (b) => { if (!b) return null; const idsB = E.bankWemIds(await arc.read(b)); return wems.find((w) => idsB.includes(+base(w))) || null; };
    let songWem = await wemOfBank(songBank), prevWem = await wemOfBank(prevBank);
    if (!songWem && wems.length) songWem = wems.slice().sort((a, b) => arc.entries.find((e) => e.name === b).length - arc.entries.find((e) => e.name === a).length)[0];
    project.audio = { song: songWem, preview: prevWem, songBank: songBank || null, previewBank: prevBank || null, replaced: false, dir: P.audio };
    if (songWem) {
      try { const info = E.wemInfo((await arc.read(songWem)).subarray(0, 4096)); project.audio.codec = info.codec; project.audio.sampleRate = info.sampleRate; project.audio.channels = info.channels; project.audio.duration = info.duration; }
      catch (e) { /* header only */ }
    }
    project.art = { names: names.filter((n) => /^gfxassets\/album_art\/.*\.dds$/.test(n)), replaced: false };
    return { project, source: E.makeSource(arc) };
  };

  // ---- beats ------------------------------------------------------------------------------------------
  /** Beat grid at a constant tempo: [{time, measure}] from `start` to `length`. */
  E.beatsFromTempo = function (bpm, start, length, perBar) {
    perBar = perBar || 4;
    const out = [], step = 60 / bpm;
    let i = 0;
    for (let t = start; t <= length + 1e-6; t += step, i++) out.push({ time: Math.round(t * 1000) / 1000, measure: i % perBar === 0 ? i / perBar + 1 : -1 });
    return out;
  };
  /** Average tempo of a beat grid (beats per minute). */
  E.averageTempo = function (beats) {
    if (beats.length < 2) return 120;
    return Math.round(60 * (beats.length - 1) / (beats[beats.length - 1].time - beats[0].time) * 1000) / 1000;
  };

  /** An empty arrangement document for a new chart. */
  E.newArrangementDoc = function (project, kind, tuning) {
    const K = E.ARRANGEMENT_KINDS[kind];
    const len = project.meta.songLength || 60;
    const secs = project.sections.length ? project.sections : [{ name: "intro", number: 1, startTime: project.beats.length ? project.beats[0].time : 0 }];
    const phraseNames = ["COUNT"].concat(secs.map((s) => s.name + s.number)).concat(["END"]);
    const itTimes = [0].concat(secs.map((s) => s.startTime)).concat([Math.max(len - 0.5, secs[secs.length - 1].startTime + 0.5)]);
    return {
      version: "7", comments: [" RockShiny Creator "], title: project.meta.title, arrangement: K.label, part: 1, offset: 0, centOffset: 0,
      songLength: len, songNameSort: project.meta.titleSort || project.meta.title, startBeat: project.beats.length ? project.beats[0].time : 0,
      averageTempo: project.meta.averageTempo || E.averageTempo(project.beats), tuning: (tuning || [0, 0, 0, 0, 0, 0]).slice(0, 6), capo: 0,
      artistName: project.meta.artist, artistNameSort: project.meta.artistSort || project.meta.artist, albumName: project.meta.album,
      albumNameSort: project.meta.albumSort || project.meta.album, albumYear: project.meta.year, albumArt: "urn:image:dds:album_" + lowerKey(project),
      crowdSpeed: 1, properties: Object.assign({ represent: 1, bonusArr: 0 }, K.path), lastConversionDateTime: "",
      phrases: phraseNames.map((n) => ({ disparity: 0, ignore: 0, maxDifficulty: 0, name: n, solo: /solo/i.test(n) ? 1 : 0 })),
      phraseIterations: itTimes.map((t, i) => ({ time: t, phraseId: i, variation: null, heroLevels: [] })),
      newLinkedDiffs: [], linkedDiffs: [], phraseProperties: [], chordTemplates: [], fretHandMuteTemplates: [],
      ebeats: clone(project.beats), tonebase: null, tonea: null, toneb: null, tonec: null, toned: null, tones: [],
      sections: clone(secs), events: [], transcriptionTrack: null,
      levels: [{ difficulty: 0, notes: [], chords: [], fretHandMutes: [], anchors: [], handShapes: [] }]
    };
  };

  /**
   * Phrases follow the sections: one phrase (and iteration) per section, plus COUNT
   * before the first and END at the end -- the layout the toolkit expects. Used when
   * sections change in a chart without dynamic difficulty.
   */
  E.phrasesFromSections = function (doc) {
    const secs = doc.sections.slice().sort((a, b) => a.startTime - b.startTime);
    const names = [], its = [];
    const pid = (name) => { let i = names.indexOf(name); if (i < 0) { names.push(name); i = names.length - 1; } return i; };
    its.push({ time: 0, phraseId: pid("COUNT"), variation: null, heroLevels: [] });
    for (const s of secs) if (s.startTime > 0.0005) its.push({ time: s.startTime, phraseId: pid(s.name + (/noguitar/i.test(s.name) ? "" : s.number)), variation: null, heroLevels: [] });
    const endT = Math.max(doc.songLength - 0.1, its[its.length - 1].time + 0.1);
    if (!secs.some((s) => /noguitar/i.test(s.name) && s.startTime >= endT - 1)) its.push({ time: endT, phraseId: pid("END"), variation: null, heroLevels: [] });
    doc.phrases = names.map((n) => ({ disparity: 0, ignore: 0, maxDifficulty: 0, name: n, solo: /solo/i.test(n) ? 1 : 0 }));
    doc.phraseIterations = its;
    doc.newLinkedDiffs = []; doc.linkedDiffs = [];
    return doc;
  };

  /** New sections for a chart: its phrases follow them (difficulty levels are carried over, rsc-difficulty.js). */
  E.arrApplySections = function (a, sections) {
    const rephrase = (d) => { d.sections = clone(sections); E.phrasesFromSections(d); };
    if (a.dd && E.ddRephrase) E.ddRephrase(a, rephrase); else rephrase(a.doc);
  };

  /** Make every chart consistent with the project's beats / sections / metadata before saving. */
  E.projectSync = function (project) {
    const m = project.meta;
    for (const a of project.arrangements) {
      const d = a.doc;
      if (project.beatsEdited) { d.ebeats = clone(project.beats); a.edited = true; }
      if (project.sectionsEdited) { E.arrApplySections(a, project.sections); a.edited = true; }
      if (m.metaEdited) {
        d.title = m.title; d.artistName = m.artist; d.artistNameSort = m.artistSort || m.artist; d.albumName = m.album;
        d.albumNameSort = m.albumSort || m.album; d.albumYear = m.year; d.songNameSort = m.titleSort || m.title;
      }
      if (a.edited) {
        d.songLength = m.songLength || d.songLength;
        d.averageTempo = E.averageTempo(d.ebeats);
        d.arrangement = a.name;
        for (const lv of d.levels) {
          lv.notes.sort((p, q) => p.time - q.time || p.string - q.string);
          lv.chords.sort((p, q) => p.time - q.time);
          lv.anchors.sort((p, q) => p.time - q.time);
          lv.handShapes.sort((p, q) => p.startTime - q.startTime);
        }
        if (!d.lastConversionDateTime) {
          const t = new Date();
          d.lastConversionDateTime = (t.getMonth() + 1) + "-" + t.getDate() + "-" + String(t.getFullYear()).slice(2) + " " + t.getHours() + ":" + String(t.getMinutes()).padStart(2, "0");
        }
      }
    }
    return project;
  };

  // ---- save ---------------------------------------------------------------------------------------------
  /**
   * The files of the package: [{name, data}] in archive order. Untouched files are
   * copied; edited charts are re-serialised and compiled; metadata edits patch the
   * manifests and the header; new files (vocals, audio, art) are added.
   */
  E.projectFiles = async function (project, source, opts) {
    opts = opts || {};
    E.projectSync(project);
    const P = E.pathsFor(project), plat = project.platform, out = new Map();
    const songMeta = Object.assign({ key: project.key }, project.meta, { averageTempo: project.meta.averageTempo });
    const put = (name, data) => out.set(name, typeof data === "string" ? E.utf8(data) : data);
    const fresh = !source.arc;
    const attrsAll = [], manifestText = {};

    for (const a of project.arrangements) {
      // the chart as saved: its difficulty levels (kept, rebuilt, or one level)
      const doc = E.ddSaveDoc ? E.ddSaveDoc(a) : a.doc;
      const xmlName = (a.origin && a.origin.xml) || P.arrXml(a.id), sngName = (a.origin && a.origin.sng && !opts.platformChanged) ? a.origin.sng : P.sng(a.id);
      const mfName = (a.origin && a.origin.manifest) || P.manifest(a.id);
      let sng = null;
      // (an unchanged chart moving to the other platform keeps its SNG: re-encrypted below)
      if (a.edited || fresh || !a.origin || !a.origin.sng) {
        sng = E.arrCompile(doc, { bass: a.kind === "bass" });
      }
      if (a.edited || fresh || !a.origin || !a.origin.xml) put(xmlName, E.arrSerialize(doc));
      if (sng) put(sngName, await E.sngEncrypt(E.sngSerialize(sng), plat));
      // manifest
      if (a.origin && a.origin.manifest && !fresh) {
        const text = E.fromUtf8(await source.read(a.origin.manifest));
        let computed = null;
        if (a.edited) computed = E.arrAttributes(songMeta, Object.assign({}, a, { doc, sng }));
        const patched = project.meta.metaEdited || computed ? E.manifestPatch(text, project.meta, computed) : text;
        manifestText[mfName] = patched;
        attrsAll.push(Object.values(JSON.parse(patched).Entries)[0].Attributes);
      } else {
        const attrs = E.arrAttributes(songMeta, Object.assign({}, a, { doc, sng: sng || E.arrCompile(doc, { bass: a.kind === "bass" }) }));
        manifestText[mfName] = E.manifestJson(attrs);
        attrsAll.push(attrs);
        a.persistentId = attrs.PersistentID;
      }
    }
    if (project.vocals && project.vocals.syllables && project.vocals.syllables.length) {
      const v = project.vocals, id = v.id || lowerKey(project) + "_vocals";
      v.id = id;
      const xmlName = (v.origin && v.origin.xml) || P.arrXml(id), sngName = (v.origin && v.origin.sng && !opts.platformChanged) ? v.origin.sng : P.sng(id);
      const mfName = (v.origin && v.origin.manifest) || P.manifest(id);
      if (v.edited || fresh || !v.origin || !v.origin.xml) put(xmlName, E.vocalsSerialize(v.syllables));
      if (v.edited || fresh || !v.origin || !v.origin.sng || opts.platformChanged) put(sngName, await E.sngEncrypt(E.vocalsSngBody(v.syllables), plat));
      if (v.origin && v.origin.manifest && !fresh) {
        const text = E.fromUtf8(await source.read(v.origin.manifest));
        manifestText[mfName] = project.meta.metaEdited ? E.manifestPatch(text, project.meta, null) : text;
        attrsAll.push(Object.values(JSON.parse(manifestText[mfName]).Entries)[0].Attributes);
      } else {
        const attrs = E.vocalsAttributes(songMeta, { id, persistentId: v.persistentId });
        v.persistentId = attrs.PersistentID;
        manifestText[mfName] = E.manifestJson(attrs);
        attrsAll.push(attrs);
      }
    }
    for (const [n, t] of Object.entries(manifestText)) {
      const orig = source.arc && source.arc.has(n) ? E.fromUtf8(await source.read(n)) : null;
      if (orig !== t) put(n, t);
    }
    // sound banks carry the song / preview volume: rebuilt (same ids) when it changed
    if (source.arc && project.audio) {
      for (const [bank, wemName, vol, suffix] of [[project.audio.songBank, project.audio.song, project.meta.volume, ""],
        [project.audio.previewBank, project.audio.preview, project.meta.previewVolume, "_Preview"]]) {
        if (!bank || !wemName || vol == null || !source.has(bank) || out.has(bank)) continue;
        const bytes = await source.read(bank), ids = E.bankIds(bytes);
        if (Math.abs(ids.volume - vol) < 1e-4) continue;
        const wem = await source.read(wemName), info = E.wemInfo(wem.subarray(0, 4096));
        put(bank, E.bankBuild({ name: project.key + suffix, wemId: E.bankWemIds(bytes)[0], wem, codec: info.codec, ids, volume: vol, preview: !!suffix }).bytes);
      }
    }
    // header
    const hsanName = (source.arc && source.arc.names().find((n) => /\.hsan$/.test(n))) || P.hsan;
    if (fresh || !source.arc.has(hsanName)) put(hsanName, E.hsanJson(attrsAll));
    else if (project.meta.metaEdited || project.arrangements.some((a) => a.edited) || attrsAll.length !== Object.keys(JSON.parse(E.fromUtf8(await source.read(hsanName))).Entries).length) {
      const text = E.fromUtf8(await source.read(hsanName)), j = JSON.parse(text);
      const byId = Object.fromEntries(attrsAll.map((a) => [a.PersistentID, a]));
      const j2 = JSON.parse(E.hsanPatch(text, byId));
      for (const id of Object.keys(j2.Entries)) if (!byId[id]) delete j2.Entries[id];          // removed arrangements
      const missing = attrsAll.filter((a) => !j.Entries[a.PersistentID]);
      if (missing.length) Object.assign(j2.Entries, JSON.parse(E.hsanJson(missing)).Entries);  // added ones
      put(hsanName, JSON.stringify(j2, null, 2));
    }
    // package files of a new song (or files a song lacks)
    const has = (n) => out.has(n) || source.has(n);
    const arrsForX = project.arrangements.map((a) => ({ id: a.id, name: a.name, persistentId: a.persistentId }))
      .concat(project.vocals && project.vocals.syllables.length ? [{ id: project.vocals.id, name: "Vocals", persistentId: project.vocals.persistentId }] : []);
    const xblockName = (source.arc && source.arc.names().find((n) => /\.xblock$/.test(n))) || P.xblock;
    const origIds = (project.files || []).filter((n) => /^manifests\/.*\.json$/.test(n)).map((n) => n.replace(/^.*\//, "").replace(/\.json$/, "")).sort();
    const nowIds = arrsForX.map((a) => a.id).sort();
    if (!has(xblockName) || fresh || JSON.stringify(origIds) !== JSON.stringify(nowIds)) put(xblockName, E.xblockXml(songMeta, arrsForX));
    if (!has(P.showlights)) put(P.showlights, E.showlightsXml(project.arrangements[0] ? project.arrangements[0].doc : { sections: project.sections, songLength: project.meta.songLength }));
    if (!has(P.flatRoot)) put(P.flatRoot, E.fromBase64(E.FLAT_ROOT));
    if (!has(P.flatSong)) put(P.flatSong, E.fromBase64(E.FLAT_SONG));
    if (!has("appid.appid")) put("appid.appid", E.APP_ID);
    if (!has("toolkit.version") || fresh) put("toolkit.version", E.toolkitVersionText(project.meta.author, project.meta.version));

    // everything else: the original archive's files (unless replaced / removed), then the new ones
    const removed = new Set(project.removed || []);
    const names = [];
    for (const n of source.arc ? source.arc.names() : []) {
      if (removed.has(n)) continue;
      if (opts.platformChanged && /^(audio\/|songs\/bin\/)/.test(n)) continue;   // re-added under the new platform's paths
      names.push(n);
    }
    for (const n of source.added.keys()) if (!names.includes(n)) names.push(n);
    for (const n of out.keys()) if (!names.includes(n)) names.push(n);
    const files = [];
    for (const n of names) {
      if (out.has(n)) files.push({ name: n, data: out.get(n) });
      else files.push({ name: n, data: await source.read(n) });
    }
    if (opts.platformChanged && source.arc) {
      const oldP = E.PLATFORMS[opts.fromPlatform], newP = E.PLATFORMS[plat];
      for (const n of source.arc.names()) {
        if (n.startsWith(oldP.audio + "/")) files.push({ name: newP.audio + n.slice(oldP.audio.length), data: await source.read(n) });
      }
      for (const n of source.arc.names()) {
        if (!n.startsWith(oldP.sng + "/")) continue;
        const nn = newP.sng + n.slice(oldP.sng.length);
        if (files.some((f) => f.name === nn)) continue;
        const body = (await E.sngDecrypt(await source.read(n), opts.fromPlatform)).body;
        files.push({ name: nn, data: await E.sngEncrypt(body, plat) });
      }
    }
    // the aggregate graph names every asset: rebuilt when files were added or moved
    const graphName = files.find((f) => /_aggregategraph\.nt$/.test(f.name));
    const originalSet = new Set(source.arc ? source.arc.names() : []);
    const changedSet = files.some((f) => !originalSet.has(f.name)) || (source.arc && source.arc.names().some((n) => !files.some((f) => f.name === n)));
    const graph = E.aggregateGraph(songMeta, files.map((f) => f.name), plat);
    if (!graphName) files.unshift({ name: P.graph, data: E.utf8(graph) });
    else if (changedSet || fresh) graphName.data = E.utf8(graph);
    // root files first, like the toolkit
    const rank = (n) => (n === "appid.appid" ? 0 : /_aggregategraph\.nt$/.test(n) ? 1 : n === "toolkit.version" ? 2 : 3);
    files.sort((a, b) => rank(a.name) - rank(b.name) || (fresh ? a.name.localeCompare(b.name) : 0));
    return files;
  };

  /** Save: -> .psarc bytes. opts.platform converts PC <-> Mac. */
  E.projectSave = async function (project, source, opts) {
    opts = opts || {};
    let plat = project.platform, o = {};
    if (opts.platform && opts.platform !== project.platform) { o = { platformChanged: true, fromPlatform: project.platform }; project.platform = opts.platform; }
    try {
      const files = await E.projectFiles(project, source, o);
      return await E.psarcWrite(files);
    } finally { project.platform = plat; }
  };

  /** File name of a saved package: Artist_Title_v1_p.psarc / _m.psarc */
  E.packageFileName = function (project, platform) {
    const clean = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const v = String(project.meta.version || "1").replace(/[^0-9A-Za-z.]/g, "");
    return (clean(project.meta.artist) || "Artist") + "_" + (clean(project.meta.title) || "Song") + "_v" + v + E.PLATFORMS[platform || project.platform].suffix + ".psarc";
  };

  // ---- new songs ---------------------------------------------------------------------------------------------
  /**
   * A new song from scratch.
   * opts: {title, artist, album, year, platform, audio: {channels: [Float32Array], sampleRate} | {wem: bytes},
   *        bpm, offset (first beat, s), beatsPerBar, arrangements: [{kind, tuning}], art: {rgba, width, height}}
   * -> {project, source}
   */
  E.projectNew = async function (opts) {
    const platform = opts.platform || "pc", key = opts.key || E.songKey(opts.artist, opts.title);
    const source = E.makeSource(null);
    const P0 = E.PLATFORMS[platform];
    let wem, codec, duration, sampleRate, channels = 2;
    if (opts.audio && opts.audio.wem) {
      wem = opts.audio.wem; const info = E.wemInfo(wem); codec = info.codec; duration = info.duration; sampleRate = info.sampleRate; channels = info.channels;
    } else if (opts.audio && opts.audio.channels) {
      sampleRate = opts.audio.sampleRate; channels = opts.audio.channels.length; duration = opts.audio.channels[0].length / sampleRate;
      wem = E.pcmToWem(opts.audio.channels, sampleRate); codec = "pcm";
    } else throw new Error("A new song needs its audio.");
    const length = Math.round(duration * 1000) / 1000;
    const project = {
      format: E.PROJECT_FORMAT, key, platform, files: [],
      meta: { title: opts.title || "Untitled", titleSort: opts.title || "Untitled", artist: opts.artist || "Unknown Artist", artistSort: opts.artist || "Unknown Artist",
        album: opts.album || "", albumSort: opts.album || "", year: opts.year ? String(opts.year) : String(new Date().getFullYear()),
        averageTempo: opts.bpm || 120, songLength: length, volume: -7, previewVolume: -7, author: opts.author || "", version: "1", metaEdited: false },
      beats: opts.beats || E.beatsFromTempo(opts.bpm || 120, opts.offset || 0, length, opts.beatsPerBar || 4),
      sections: opts.sections || [{ name: "intro", number: 1, startTime: Math.round((opts.offset || 0) * 1000) / 1000 }],
      arrangements: [], vocals: null, beatsEdited: false, sectionsEdited: false
    };
    project.meta.averageTempo = E.averageTempo(project.beats);
    const lower = key.toLowerCase(), used = {};
    for (const spec of opts.arrangements || [{ kind: "lead" }]) {
      const K = E.ARRANGEMENT_KINDS[spec.kind];
      used[spec.kind] = (used[spec.kind] || 0) + 1;
      const id = lower + "_" + spec.kind + (used[spec.kind] > 1 ? used[spec.kind] : "");
      project.arrangements.push({ id, name: K.label + (used[spec.kind] > 1 ? " " + used[spec.kind] : ""), kind: spec.kind, represent: used[spec.kind] === 1,
        bonus: used[spec.kind] > 1, levels: 1, doc: E.newArrangementDoc(project, spec.kind, spec.tuning), dd: null, origin: null, persistentId: null, tones: null, edited: true });
    }
    // audio: the song and a 30 s preview (from the middle of the song for PCM), with their banks
    const wemId = E.fnv1_32("rsc-wem:" + key) & 0x7fffffff, prevId = E.fnv1_32("rsc-wem-preview:" + key) & 0x7fffffff;
    let prevWem = wem;
    if (codec === "pcm") {
      const ch = opts.audio.channels || E.wemPcmChannels(wem);
      const sr = sampleRate, start = Math.floor(Math.max(0, (opts.previewStart != null ? opts.previewStart : duration * 0.35)) * sr);
      const end = Math.min(ch[0].length, start + 30 * sr);
      const fade = Math.floor(sr * 1.5);
      const clip = ch.map((c) => { const x = c.slice(start, end); for (let i = 0; i < fade && i < x.length; i++) { x[i] *= i / fade; x[x.length - 1 - i] *= i / fade; } return x; });
      prevWem = E.pcmToWem(clip, sr);
    }
    const songBank = E.bankBuild({ name: key, wemId, wem, codec, volume: -7 });
    const prevBank = E.bankBuild({ name: key + "_Preview", wemId: prevId, wem: prevWem, codec, preview: true, volume: -7 });
    const P = E.pathsFor(project);
    source.put(P.wem(wemId), wem); source.put(P.wem(prevId), prevWem);
    source.put(P.bank, songBank.bytes); source.put(P.previewBank, prevBank.bytes);
    project.audio = { song: P.wem(wemId), preview: P.wem(prevId), songBank: P.bank, previewBank: P.previewBank, replaced: true, dir: P0.audio,
      codec, sampleRate, channels, duration: length };
    if (opts.art && opts.art.rgba) {
      const set = E.albumArtSet(opts.art.rgba, opts.art.width, opts.art.height);
      for (const n of [256, 128, 64]) source.put(P.art(n), set[n]);
      project.art = { names: [256, 128, 64].map((n) => P.art(n)), replaced: true };
    } else project.art = { names: [], replaced: false };
    return { project, source };
  };

  /** Replace the album art of a project (any RGBA image). */
  E.projectSetArt = function (project, source, rgba, w, h) {
    const P = E.pathsFor(project), set = E.albumArtSet(rgba, w, h);
    for (const old of project.art.names || []) (project.removed = project.removed || []).push(old);
    const names = [256, 128, 64].map((n) => P.art(n));
    for (const n of [256, 128, 64]) source.put(P.art(n), set[n]);
    project.removed = (project.removed || []).filter((n) => !names.includes(n));
    project.art = { names, replaced: true };
  };

  /** Add an arrangement (kind, tuning) to a project. */
  E.projectAddArrangement = function (project, kind, tuning) {
    const K = E.ARRANGEMENT_KINDS[kind], lower = lowerKey(project);
    let n = 1, id = lower + "_" + kind;
    while (project.arrangements.some((a) => a.id === id)) { n++; id = lower + "_" + kind + n; }
    const a = { id, name: K.label + (n > 1 ? " " + n : ""), kind, represent: !project.arrangements.some((x) => x.kind === kind), bonus: n > 1,
      levels: 1, doc: E.newArrangementDoc(project, kind, tuning), dd: null, origin: null, persistentId: null, tones: null, edited: true };
    project.arrangements.push(a);
    return a;
  };

  /** Remove an arrangement (its files are dropped from the package). */
  E.projectRemoveArrangement = function (project, id) {
    const i = project.arrangements.findIndex((a) => a.id === id);
    if (i < 0) return;
    const a = project.arrangements[i];
    project.removed = project.removed || [];
    if (a.origin) for (const n of [a.origin.xml, a.origin.sng, a.origin.manifest]) if (n) project.removed.push(n);
    project.arrangements.splice(i, 1);
  };
})(typeof window !== "undefined" ? window : globalThis);
