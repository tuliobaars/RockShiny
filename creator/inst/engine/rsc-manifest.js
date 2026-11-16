/* ---------------------------------------------------------------------------
 * rsc-manifest.js -- everything around the charts that makes a Rocksmith 2014
 * song package: song keys and file layout per platform, the per-arrangement
 * JSON manifests, the .hsan header, the game xblock, the aggregate graph,
 * flat models, showlights, appid and toolkit.version.
 *
 * New songs get all of these generated; edited songs keep theirs and only get
 * the fields patched that an edit changes (E.manifestPatch).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const E = root.RSCreator.engine;

  E.APP_ID = "248750";                         // Rocksmith 2014 (Cherub Rock DLC app id, as the toolkit)
  E.PLATFORMS = {
    pc: { audio: "audio/windows", audioTag: "dx9", sng: "songs/bin/generic", sngTag: "generic", suffix: "_p", label: "PC" },
    mac: { audio: "audio/mac", audioTag: "macos", sng: "songs/bin/macos", sngTag: "macos", suffix: "_m", label: "Mac" }
  };
  E.platformOf = function (names) {
    if (names.some((n) => /^songs\/bin\/macos\//.test(n) || /^audio\/mac\//.test(n))) return "mac";
    return "pc";
  };

  /** DLC key from artist + title: letters and digits in PascalCase, at most 30 characters. */
  E.songKey = function (artist, title) {
    const part = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 ]+/g, " ")
      .split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join("");
    let k = (part(artist).slice(0, 12) + part(title)).slice(0, 30);
    if (!k) k = "RockShinySong";
    if (/^\d/.test(k)) k = "S" + k.slice(0, 29);
    return k;
  };
  /** "persistent id": 32 hex digits (a GUID without dashes), deterministic from a seed. */
  E.guidHex = function (seed) {
    const a = E.md5("rsc-guid:" + seed);
    return E.hex(a).toUpperCase();
  };
  const masterId = (seed) => (E.fnv1_32("rsc-master:" + seed) & 0x7fffffff);

  // Section names the game translates ("$[id] Name [n]"); others are shown as written.
  const SECTION_UI = {
    intro: [34286, "Intro"], verse: [34304, "Verse"], bridge: [34282, "Bridge"], chorus: [34279, "Chorus"], solo: [34300, "Solo"],
    outro: [34291, "Outro"], noguitar: [6091, "No Guitar"], riff: [34298, "Riff"], breakdown: [34284, "Breakdown"],
    melody: [34287, "Melody"], postchorus: [34293, "Post Chorus"], interlude: [34285, "Interlude"], prechorus: [34296, "Pre Chorus"],
    transition: [34301, "Transition"], fadein: [34283, "Fade In"], fadeout: [34281, "Fade Out"], hook: [34290, "Hook"],
    buildup: [34280, "Buildup"], ambient: [34288, "Ambient"], silence: [34299, "Silence"], vamp: [34302, "Vamp"],
    tapping: [34306, "Tapping"], head: [34289, "Head"], variation: [34303, "Variation"]
  };
  E.SECTION_NAMES = Object.keys(SECTION_UI);
  E.sectionUIName = function (name, number) {
    const u = SECTION_UI[String(name).toLowerCase()];
    return (u ? "$[" + u[0] + "] " + u[1] : String(name)) + " [" + number + "]";
  };
  E.TONE_DESCRIPTORS = { CLEAN: 35720, LEAD: 35724, BASS: 35715, OVERDRIVE: 35716, ACOUSTIC: 35721, DISTORTION: 35722,
    CHORUS: 35723, PHASER: 35730, PROCESSED: 35734, "SPECIAL EFFECT": 35750, "MULTI-EFFECT": 35751 };

  /** Default tones for new arrangements (gear of the sample songs' tones). */
  E.defaultTone = function (key, bass) {
    const desc = bass ? "BASS" : "CLEAN";
    const gear = bass
      ? { Amp: { Type: "Amps", KnobValues: { Bass_Amp_EdenE300_Gain: 12, Bass_Amp_EdenE300_Bass: 4, Bass_Amp_EdenE300_Mid: 4, Bass_Amp_EdenE300_Treble: -5, Bass_Amp_EdenE300_Enhance: 35 }, Key: "Bass_Amp_EdenE300" },
          Cabinet: { Type: "Cabinets", KnobValues: {}, Key: "Bass_Cab_EdenD610XST_Tube_Edge" } }
      : { Amp: { Type: "Amps", KnobValues: { Amp_TW26_Pres: 50, Amp_TW26_Gain: 20, Amp_TW26_Bass: 50, Amp_TW26_Mid: 50, Amp_TW26_Treble: 55 }, Key: "Amp_TW26" },
          Cabinet: { Type: "Cabinets", KnobValues: {}, Key: "Cab_CS1120C_57_Cone" } };
    return { GearList: gear, IsCustom: true, Volume: bass ? "-12.000" : "-18.000", ToneDescriptors: ["$[" + E.TONE_DESCRIPTORS[desc] + "]" + desc],
      Key: key, NameSeparator: " - ", Name: key, SortOrder: 0.0 };
  };

  /** Arrangement kind -> manifest type / route / XML label / properties. */
  E.ARRANGEMENT_KINDS = {
    lead: { type: 0, route: 1, label: "Lead", path: { pathLead: 1, pathRhythm: 0, pathBass: 0 } },
    rhythm: { type: 1, route: 2, label: "Rhythm", path: { pathLead: 0, pathRhythm: 1, pathBass: 0 } },
    combo: { type: 2, route: 3, label: "Combo", path: { pathLead: 1, pathRhythm: 1, pathBass: 0 } },
    bass: { type: 3, route: 4, label: "Bass", path: { pathLead: 0, pathRhythm: 0, pathBass: 1 } }
  };
  E.kindOf = function (name, props) {
    const n = String(name || "").toLowerCase();
    if (/bass/.test(n) || (props && +props.pathBass === 1)) return "bass";
    if (/rhythm/.test(n) || (props && +props.pathRhythm === 1 && +props.pathLead !== 1)) return "rhythm";
    if (/combo/.test(n)) return "combo";
    return "lead";
  };

  const STANDARD = [0, 0, 0, 0, 0, 0];
  /** Arrangement properties derived from a chart (techniques used), as the toolkit sets them. */
  E.arrProperties = function (doc, kind, base) {
    const p = Object.assign({ represent: 1, bonusArr: 0 }, base || {});
    const notes = [], chords = [];
    for (const lv of doc.levels) { notes.push(...lv.notes); chords.push(...lv.chords); }
    const cn = chords.flatMap((c) => c.chordNotes || []);
    const all = notes.concat(cn);
    const any = (f) => (all.some(f) ? 1 : 0);
    Object.assign(p, {
      standardTuning: doc.tuning.every((v, i) => v === STANDARD[i]) ? 1 : 0,
      nonStandardChords: 0, barreChords: 0, powerChords: 0, dropDPower: 0, openChords: 0, fingerPicking: 0,
      pickDirection: any((n) => n.pickDirection), doubleStops: chords.some((c) => (doc.chordTemplates[c.chordId] || { frets: [] }).frets.filter((f) => f >= 0).length === 2) ? 1 : 0,
      palmMutes: any((n) => n.palmMute) || (chords.some((c) => c.palmMute) ? 1 : 0), harmonics: any((n) => n.harmonic),
      pinchHarmonics: any((n) => n.harmonicPinch), hopo: any((n) => n.hammerOn || n.pullOff || n.hopo), tremolo: any((n) => n.tremolo),
      slides: any((n) => n.slideTo >= 0), unpitchedSlides: any((n) => n.slideUnpitchTo >= 0), bends: any((n) => n.bend > 0),
      tapping: any((n) => n.tap), vibrato: any((n) => n.vibrato), fretHandMutes: any((n) => n.mute) || (chords.some((c) => c.fretHandMute) ? 1 : 0),
      slapPop: any((n) => n.slap >= 0 || n.pluck >= 0), twoFingerPicking: 0, fifthsAndOctaves: 0, syncopation: 0, bassPick: 0,
      sustain: any((n) => n.sustain > 0)
    }, E.ARRANGEMENT_KINDS[kind].path);
    for (const c of chords) {
      const t = doc.chordTemplates[c.chordId];
      if (!t) continue;
      const fr = t.frets.filter((f) => f >= 0);
      if (fr.length >= 3 && fr.includes(0)) p.openChords = 1;
      if (fr.length === 2 && kind !== "bass") p.powerChords = 1;
      if (/[^0-9]/.test(t.chordName || "") && !/^[A-G][#b]?(m|min|maj|7|5)?$/.test(t.chordName || "")) p.nonStandardChords = 1;
    }
    return p;
  };

  const round6 = (v) => Math.round(v * 1e6) / 1e6;
  /** Dynamic visual density: 4.5 at the easiest level down to a floor at the hardest (as the samples). */
  E.visualDensity = function (maxDifficulty, floor) {
    floor = floor || 2.0;
    const out = [];
    for (let i = 0; i < 20; i++) out.push(maxDifficulty > 0 && i < maxDifficulty ? round6(4.5 * Math.pow(floor / 4.5, i / maxDifficulty)) : floor);
    return out;
  };

  /** Notes at a share of each phrase's max difficulty (easy 1/3, medium 2/3, hard 1). */
  function notesAt(doc, share) {
    const it = doc.phraseIterations;
    let total = 0;
    it.forEach((p, j) => {
      const ph = doc.phrases[p.phraseId];
      if (!ph) return;
      const want = Math.round(ph.maxDifficulty * share);
      let lv = null;
      for (const l of doc.levels) if (l.difficulty <= want && (!lv || l.difficulty > lv.difficulty)) lv = l;
      if (!lv) return;
      const t0 = p.time, t1 = j + 1 < it.length ? it[j + 1].time : Infinity;
      total += lv.notes.filter((n) => n.time >= t0 && n.time < t1).length + lv.chords.filter((c) => c.time >= t0 && c.time < t1).length;
    });
    return total;
  }
  /** A difficulty figure from the note rate and the techniques (0..~2; the toolkit's formula is not public). */
  function difficultyOf(doc, notes) {
    const len = Math.max(30, doc.songLength || 60);
    const rate = notes / len;
    return round6(Math.min(2, 0.08 + rate / 5));
  }

  /**
   * Attributes of an instrumental arrangement manifest.
   * song: {key, title, titleSort, artist, artistSort, album, albumSort, year, averageTempo, songLength,
   *        volume, previewVolume, platform}
   * arr:  {id (file base), name (Lead...), kind, doc, sng (struct), tones: [tone objects], persistentId}
   */
  E.arrAttributes = function (song, arr) {
    const doc = arr.doc, sng = arr.sng, kind = arr.kind, K = E.ARRANGEMENT_KINDS[kind];
    const key = song.key, lower = key.toLowerCase(), base = arr.id;
    const maxDiff = Math.max(0, ...doc.phrases.map((p) => p.maxDifficulty));
    const hard = sng.metadata.maxNotesAndChords, easy = notesAt(doc, 1 / 3), med = notesAt(doc, 2 / 3);
    const diff = difficultyOf(doc, hard);
    const props = Object.assign({ routeMask: K.route }, E.arrProperties(doc, kind, { represent: arr.represent === false ? 0 : 1, bonusArr: arr.bonus ? 1 : 0 }));
    const iters = doc.phraseIterations;
    const tones = arr.tones && arr.tones.length ? arr.tones : [E.defaultTone(doc.tonebase || (key + "_" + (kind === "bass" ? "Bass" : "Clean")), kind === "bass")];
    const toneName = (n) => (n == null ? "" : n);
    return {
      ArrangementProperties: props,
      ArrangementSort: 0,
      ArrangementType: K.type,
      BlockAsset: "urn:emergent-world:" + lower,
      ChordTemplates: doc.chordTemplates.map((c, i) => ({ ChordId: i, ChordName: c.chordName || "", Fingers: c.fingers.slice(), Frets: c.frets.slice() })),
      DynamicVisualDensity: E.visualDensity(maxDiff, kind === "bass" ? 1.5 : 2.0),
      FullName: key + "_" + arr.name,
      LastConversionDateTime: doc.lastConversionDateTime || "",
      MasterID_PS3: masterId(base), MasterID_Xbox360: masterId(base),
      MaxPhraseDifficulty: maxDiff,
      PhraseIterations: iters.map((p, j) => ({ PhraseIndex: p.phraseId, MaxDifficulty: (doc.phrases[p.phraseId] || {}).maxDifficulty || 0,
        Name: (doc.phrases[p.phraseId] || {}).name || "", StartTime: round6(p.time), EndTime: round6(j + 1 < iters.length ? iters[j + 1].time : doc.songLength) })),
      Phrases: doc.phrases.map((p, i) => ({ MaxDifficulty: p.maxDifficulty, Name: p.name, IterationCount: iters.filter((x) => x.phraseId === i).length })),
      PreviewBankPath: "song_" + lower + "_preview.bnk",
      RelativeDifficulty: 0,
      Score_MaxNotes: hard,
      Score_PNV: round6(sng.metadata.pointsPerNote),
      Sections: doc.sections.map((s, i) => {
        const end = i + 1 < doc.sections.length ? doc.sections[i + 1].startTime : doc.songLength;
        const si = sng.sections[i] || {};
        return { Name: s.name, UIName: E.sectionUIName(s.name, s.number), Number: s.number, StartTime: round6(s.startTime), EndTime: round6(end),
          StartPhraseIterationIndex: si.startPhraseIterationId || 0, EndPhraseIterationIndex: si.endPhraseIterationId || 0, IsSolo: /solo/i.test(s.name) };
      }),
      ShowlightsXML: "urn:application:xml:" + lower + "_showlights",
      SongAsset: "urn:application:musicgame-song:" + base,
      SongAverageTempo: round6(song.averageTempo || doc.averageTempo),
      SongBank: "song_" + lower + ".bnk",
      SongEvent: "Play_" + key,
      SongOffset: round6(-(doc.offset || 0)),
      SongPartition: doc.part || 1,
      SongXml: "urn:application:xml:" + base,
      TargetScore: 100000,
      Tone_A: toneName(doc.tonea), Tone_B: toneName(doc.toneb), Tone_Base: toneName(doc.tonebase || tones[0].Key),
      Tone_C: toneName(doc.tonec), Tone_D: toneName(doc.toned), Tone_Multiplayer: "",
      Tones: tones,
      SongVolume: song.volume != null ? song.volume : -7, PreviewVolume: song.previewVolume != null ? song.previewVolume : -7,
      AlbumArt: "urn:image:dds:album_" + lower,
      AlbumName: song.album || "", AlbumNameSort: song.albumSort || song.album || "",
      ArrangementName: K.label === arr.name ? K.label : arr.name,
      ArtistName: song.artist || "", ArtistNameSort: song.artistSort || song.artist || "",
      CapoFret: doc.capo || 0, CentOffset: doc.centOffset || 0,
      DLC: true, DLCKey: key, DNA_Chords: 0, DNA_Riffs: 0, DNA_Solo: 0,
      EasyMastery: hard ? round6(easy / hard) : 1, LeaderboardChallengeRating: 0,
      ManifestUrn: "urn:database:json-db:" + base, MasterID_RDV: masterId(base), MediumMastery: hard ? round6(med / hard) : 1,
      NotesEasy: easy, NotesHard: hard, NotesMedium: med,
      PersistentID: arr.persistentId || E.guidHex(base), Representative: arr.represent === false ? 0 : 1, RouteMask: K.route,
      Shipping: true, SKU: "RS2",
      SongDiffEasy: easy ? round6(diff * hard / easy) : diff, SongDiffHard: diff, SongDiffMed: med ? round6(diff * hard / med) : diff, SongDifficulty: diff,
      SongKey: key, SongLength: round6(doc.songLength), SongName: song.title || "", SongNameSort: song.titleSort || song.title || "",
      SongYear: +song.year || 0,
      Tuning: Object.fromEntries(doc.tuning.map((v, i) => ["string" + i, v]))
    };
  };

  /** Attributes of a vocals manifest. */
  E.vocalsAttributes = function (song, arr) {
    const key = song.key, lower = key.toLowerCase(), base = arr.id;
    return {
      ArrangementSort: 0, ArrangementType: 4, BlockAsset: "urn:emergent-world:" + lower,
      DynamicVisualDensity: new Array(20).fill(2.0), FullName: key + "_" + (arr.japanese ? "JVocals" : "Vocals"),
      MasterID_PS3: -1, MasterID_Xbox360: -1, MaxPhraseDifficulty: 0, PreviewBankPath: "song_" + lower + "_preview.bnk",
      RelativeDifficulty: 0, Score_MaxNotes: 0, Score_PNV: 0, ShowlightsXML: "urn:application:xml:" + lower + "_showlights",
      SongAsset: "urn:application:musicgame-song:" + base, SongAverageTempo: 0, SongBank: "song_" + lower + ".bnk",
      SongEvent: "Play_" + key, SongOffset: 0, SongPartition: 0, SongXml: "urn:application:xml:" + base, TargetScore: 0,
      InputEvent: "Play_Tone_Standard_Mic", SongVolume: song.volume != null ? song.volume : -7, PreviewVolume: song.previewVolume != null ? song.previewVolume : -7,
      AlbumArt: "urn:image:dds:album_" + lower, ArrangementName: arr.japanese ? "JVocals" : "Vocals", CapoFret: 0, DLC: true, DLCKey: key,
      LeaderboardChallengeRating: 0, ManifestUrn: "urn:database:json-db:" + base, MasterID_RDV: masterId(base),
      PersistentID: arr.persistentId || E.guidHex(base), Shipping: true, SKU: "RS2", SongKey: key
    };
  };

  /** Wrap attributes as a manifest file (JSON text, 2-space indent like the toolkit). */
  E.manifestJson = function (attrs) {
    const j = { Entries: {}, ModelName: "RSEnumerable_Song", IterationVersion: 2, InsertRoot: "Static.Songs.Entries" };
    j.Entries[attrs.PersistentID] = { Attributes: attrs };
    return JSON.stringify(j, null, 2);
  };

  const HSAN_KEYS = ["AlbumArt", "AlbumName", "AlbumNameSort", "ArrangementName", "ArtistName", "ArtistNameSort", "CapoFret", "CentOffset",
    "DLC", "DLCKey", "DNA_Chords", "DNA_Riffs", "DNA_Solo", "EasyMastery", "LeaderboardChallengeRating", "ManifestUrn", "MasterID_RDV",
    "MediumMastery", "NotesEasy", "NotesHard", "NotesMedium", "PersistentID", "Representative", "RouteMask", "Shipping", "SKU",
    "SongDiffEasy", "SongDiffHard", "SongDiffMed", "SongDifficulty", "SongKey", "SongLength", "SongName", "SongNameSort", "SongYear", "Tuning"];
  /** The .hsan header: the header attributes of every arrangement (vocals keep fewer). */
  E.hsanJson = function (allAttrs) {
    const j = { Entries: {}, InsertRoot: "Static.Songs.Headers" };
    for (const a of allAttrs) {
      const h = {};
      for (const k of HSAN_KEYS) if (a[k] !== undefined) h[k] = a[k];
      j.Entries[a.PersistentID] = { Attributes: h };
    }
    return JSON.stringify(j, null, 2);
  };

  /** The game entity set (gamexblocks/nsongs/<key>.xblock). arrs: [{id, name, persistentId}] */
  E.xblockXml = function (song, arrs) {
    const lower = song.key.toLowerCase();
    const prop = (name, value) => '        <property name="' + name + '">\n          <set value="' + value + '" />\n        </property>';
    const ents = arrs.map((a) => [
      '    <entity id="' + (a.persistentId || E.guidHex(a.id)).toLowerCase() + '" modelName="RSEnumerable_Song" name="' + song.key + "_" + a.name + '" iterations="0">',
      "      <properties>",
      prop("Header", "urn:database:hsan-db:songs_dlc_" + lower),
      prop("Manifest", "urn:database:json-db:" + a.id),
      prop("SngAsset", "urn:application:musicgame-song:" + a.id),
      prop("AlbumArtSmall", "urn:image:dds:album_" + lower + "_64"),
      prop("AlbumArtMedium", "urn:image:dds:album_" + lower + "_128"),
      prop("AlbumArtLarge", "urn:image:dds:album_" + lower + "_256"),
      prop("LyricArt", ""),
      prop("ShowLightsXMLAsset", "urn:application:xml:" + lower + "_showlights"),
      prop("SoundBank", "urn:audio:wwise-sound-bank:song_" + lower),
      prop("PreviewSoundBank", "urn:audio:wwise-sound-bank:song_" + lower + "_preview"),
      "      </properties>",
      "    </entity>"
    ].join("\n"));
    return '<?xml version="1.0"?>\n<game>\n  <entitySet>\n' + ents.join("\n") + "\n  </entitySet>\n</game>\n";
  };

  /** The aggregate graph (N-Triples) naming every asset of the package. */
  E.aggregateGraph = function (song, files, platform) {
    const P = E.PLATFORMS[platform], lower = song.key.toLowerCase(), lines = [];
    const uuid = (s) => { const h = E.hex(E.md5("rsc-uuid:" + song.key + ":" + s)); return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20, 32); };
    const llid = (s) => E.hex(E.md5("rsc-llid:" + s)).slice(0, 8) + "-0000-0000-0000-000000000000";
    const add = (path, tags, canonical, name, withLl, logpath) => {
      const u = "<urn:uuid:" + uuid(path) + ">";
      const t = (p, v) => lines.push(u + " <http://emergent.net/aweb/1.0/" + p + "> \"" + v + "\".");
      for (const g of tags) t("tag", g);
      t("canonical", canonical); t("name", name); t("relpath", "/" + path);
      if (withLl) { t("llid", llid(path)); t("logpath", logpath || "/" + path); }
    };
    for (const f of files) {
      const base = f.replace(/^.*\//, "").replace(/\.[^.]+$/, "");
      if (/\.json$/.test(f)) add(f, ["database", "json-db"], "/manifests/songs_dlc_" + lower, base, false);
      else if (/\.hsan$/.test(f)) add(f, ["database", "hsan-db"], "/manifests/songs_dlc_" + lower, base, false);
      else if (/\.xml$/.test(f)) add(f, ["application", "xml"], "/songs/arr", base, true);
      else if (/\.sng$/.test(f)) add(f, ["application", "musicgame-song"], "/" + P.sng, base, true);
      else if (/\.dds$/.test(f)) add(f, ["dds", "image"], "/gfxassets/album_art", base, true);
      else if (/\.bnk$/.test(f)) add(f, ["audio", "wwise-sound-bank", P.audioTag], "/" + P.audio, base, true, "/audio/" + f.replace(/^.*\//, ""));
      else if (/\.xblock$/.test(f)) add(f, ["emergent-world", "x-world"], "/gamexblocks/nsongs", base, false);
    }
    return lines.join("\n") + "\n";
  };

  E.FLAT_ROOT = "77u/PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPG1vZGVsCiAgbmFtZT0iUlNFbnVtZXJhYmxlX1Jvb3QiCiAgaWQ9IjE5MTczMTI4MDMiPgogIDx0cmFpdAogICAgdmFsdWU9IkFjdGl2ZSIgLz4KICA8cHJvcGVydHkKICAgIHR5cGU9IkFzc2V0SUQiCiAgICBuYW1lPSJNYW5pZmVzdCIKICAgIGlkPSIzNDAyNjYyMTc4Ij4KICAgIDxzZXQKICAgICAgdmFsdWU9IiIgLz4KICA8L3Byb3BlcnR5PgogIDxwcm9wZXJ0eQogICAgdHlwZT0iQXNzZXRJRCIKICAgIG5hbWU9IkhlYWRlciIKICAgIGlkPSIzNTI5ODEzMTgyIj4KICAgIDxzZXQKICAgICAgdmFsdWU9IiIgLz4KICA8L3Byb3BlcnR5Pgo8L21vZGVsPg==";
  E.FLAT_SONG = "77u/PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPG1vZGVsCiAgbmFtZT0iUlNFbnVtZXJhYmxlX1NvbmciCiAgaWQ9IjM4NzE0NjUyNjgiPgogIDx0cmFpdAogICAgdmFsdWU9IkFjdGl2ZSIgLz4KICA8bWl4aW4KICAgIG5hbWU9IlJTRW51bWVyYWJsZV9Sb290IgogICAgaWQ9IjE5MTczMTI4MDMiCiAgICB0eXBlPSJBY3RpdmUiIC8+CiAgPHByb3BlcnR5CiAgICB0eXBlPSJBc3NldElEIgogICAgbmFtZT0iWG1sQXNzZXQiCiAgICBpZD0iMTk0MzMyNTM4Ij4KICAgIDxzZXQKICAgICAgdmFsdWU9IiIgLz4KICA8L3Byb3BlcnR5PgogIDxwcm9wZXJ0eQogICAgdHlwZT0iQXNzZXRJRCIKICAgIG5hbWU9IlNuZ0Fzc2V0IgogICAgaWQ9IjIxMzIxMDU1NjAiPgogICAgPHNldAogICAgICB2YWx1ZT0iIiAvPgogIDwvcHJvcGVydHk+CiAgPHByb3BlcnR5CiAgICB0eXBlPSJBc3NldElEIgogICAgbmFtZT0iQWxidW1BcnRTbWFsbCIKICAgIGlkPSIyMjk1MTAzNzIwIj4KICAgIDxzZXQKICAgICAgdmFsdWU9IiIgLz4KICA8L3Byb3BlcnR5PgogIDxwcm9wZXJ0eQogICAgdHlwZT0iQXNzZXRJRCIKICAgIG5hbWU9IkFsYnVtQXJ0TWVkaXVtIgogICAgaWQ9IjMwNjc1MzUzMzYiPgogICAgPHNldAogICAgICB2YWx1ZT0iIiAvPgogIDwvcHJvcGVydHk+CiAgPHByb3BlcnR5CiAgICB0eXBlPSJBc3NldElEIgogICAgbmFtZT0iQWxidW1BcnRMYXJnZSIKICAgIGlkPSIyMjM4ODc1MTEiPgogICAgPHNldAogICAgICB2YWx1ZT0iIiAvPgogIDwvcHJvcGVydHk+CiAgPHByb3BlcnR5CiAgICB0eXBlPSJBc3NldElEIgogICAgbmFtZT0iTHlyaWNBcnQiCiAgICBpZD0iMzg0MjcxOTc0MyI+CiAgICA8c2V0CiAgICAgIHZhbHVlPSIiIC8+CiAgPC9wcm9wZXJ0eT4KICA8cHJvcGVydHkKICAgIHR5cGU9IkFzc2V0SUQiCiAgICBuYW1lPSJTaG93TGlnaHRzWE1MQXNzZXQiCiAgICBpZD0iMjAyNDUyNzIwMyI+CiAgICA8c2V0CiAgICAgIHZhbHVlPSIiIC8+CiAgPC9wcm9wZXJ0eT4KICA8cHJvcGVydHkKICAgIHR5cGU9IkFzc2V0SUQiCiAgICBuYW1lPSJTb3VuZEJhbmsiCiAgICBpZD0iNDE3NzQ4MjI2OSI+CiAgICA8c2V0CiAgICAgIHZhbHVlPSIiIC8+CiAgPC9wcm9wZXJ0eT4KICA8cHJvcGVydHkKICAgIHR5cGU9IkFzc2V0SUQiCiAgICBuYW1lPSJQcmV2aWV3U291bmRCYW5rIgogICAgaWQ9IjE4MjAxMzgxODQiPgogICAgPHNldAogICAgICB2YWx1ZT0iIiAvPgogIDwvcHJvcGVydHk+CiAgPHByb3BlcnR5CiAgICB0eXBlPSJBc3NldElEIgogICAgbmFtZT0iTWFuaWZlc3QiCiAgICBpZD0iMzQwMjY2MjE3OCI+CiAgICA8c2V0CiAgICAgIHZhbHVlPSIiIC8+CiAgPC9wcm9wZXJ0eT4KICA8cHJvcGVydHkKICAgIHR5cGU9IkFzc2V0SUQiCiAgICBuYW1lPSJIZWFkZXIiCiAgICBpZD0iMzUyOTgxMzE4MiI+CiAgICA8c2V0CiAgICAgIHZhbHVlPSIiIC8+CiAgPC9wcm9wZXJ0eT4KPC9tb2RlbD4=";

  /** Showlights for a song without any: a fog colour per section, beams on the beat, lasers in the last chorus. */
  E.showlightsXml = function (doc) {
    const out = [];
    const fog = [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35], beam = [48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59];
    const add = (t, n) => out.push({ t: Math.max(0, t), n });
    add(0, fog[5]);
    doc.sections.forEach((s, i) => { add(s.startTime, fog[(i * 5) % fog.length]); add(s.startTime, beam[(i * 7) % beam.length]); });
    const lastChorus = doc.sections.filter((s) => /chorus/i.test(s.name)).pop();
    if (lastChorus) { add(lastChorus.startTime, 66); add(Math.max(lastChorus.startTime, doc.songLength - 5), 67); }
    out.sort((a, b) => a.t - b.t);
    return '<?xml version="1.0" encoding="utf-8"?>\n<showlights count="' + out.length + '">\n' +
      out.map((x) => '  <showlight time="' + E.fmtNum(x.t) + '" note="' + x.n + '" />').join("\n") + "\n</showlights>\n";
  };

  E.toolkitVersionText = (author, version) =>
    "Toolkit version: RockShiny Creator 0.1.0\r\nPackage Author: " + (author || "RockShiny Creator") + "\r\nPackage Version: " + (version || "1") + "\r\n";

  /**
   * Patch an existing manifest (JSON text) with new song metadata and, when given, the
   * attributes recomputed from an edited chart. Other fields (tones, ids...) are kept.
   */
  E.manifestPatch = function (text, song, computed) {
    const j = JSON.parse(text);
    const id = Object.keys(j.Entries)[0], a = j.Entries[id].Attributes;
    const meta = { SongName: song.title, SongNameSort: song.titleSort || song.title, ArtistName: song.artist, ArtistNameSort: song.artistSort || song.artist,
      AlbumName: song.album, AlbumNameSort: song.albumSort || song.album, SongYear: +song.year || 0 };
    for (const k in meta) if (k in a && meta[k] != null) a[k] = meta[k];
    if (song.volume != null && "SongVolume" in a) a.SongVolume = song.volume;
    if (song.previewVolume != null && "PreviewVolume" in a) a.PreviewVolume = song.previewVolume;
    if (computed) {
      for (const k of ["ChordTemplates", "MaxPhraseDifficulty", "PhraseIterations", "Phrases", "Score_MaxNotes", "Score_PNV", "Sections",
        "SongAverageTempo", "SongLength", "NotesEasy", "NotesMedium", "NotesHard", "EasyMastery", "MediumMastery", "Tuning", "CapoFret",
        "CentOffset", "DynamicVisualDensity", "LastConversionDateTime", "SongDifficulty", "SongDiffEasy", "SongDiffMed", "SongDiffHard"]) {
        if (computed[k] !== undefined && k in a) a[k] = computed[k];
      }
      if (computed.ArrangementProperties && a.ArrangementProperties) {
        for (const k in computed.ArrangementProperties) if (k in a.ArrangementProperties && !/^(represent|bonusArr|routeMask|path)/.test(k)) a.ArrangementProperties[k] = computed.ArrangementProperties[k];
      }
    }
    return JSON.stringify(j, null, 2);
  };
  /** Patch the .hsan header from the (patched) manifests' attributes. */
  E.hsanPatch = function (text, attrsById) {
    const j = JSON.parse(text);
    for (const id of Object.keys(j.Entries)) {
      const a = attrsById[id];
      if (!a) continue;
      const h = j.Entries[id].Attributes;
      for (const k of Object.keys(h)) if (a[k] !== undefined) h[k] = a[k];
    }
    return JSON.stringify(j, null, 2);
  };
})(typeof window !== "undefined" ? window : globalThis);
