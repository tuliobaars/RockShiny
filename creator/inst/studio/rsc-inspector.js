/* ---------------------------------------------------------------------------
 * rsc-inspector.js -- the studio's right-hand panel: the properties of what is
 * selected (Edit), the song and its charts (Song), lyrics tools (Lyrics), stem
 * separation and the mixer (Stems), the beat grid (Beats), the difficulty
 * levels of each chart (Levels).
 * Buttons carry data-act (RSC.inspectorAct), fields data-f (applied on change).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator, E = RSC.engine, esc = RSC.esc;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const num = (v) => (v == null || v === "" ? "" : String(r3(+v)));
  const field = (label, f, value, attrs) => '<label class="rsc-field"><span>' + label + '</span><input class="rsc-input" data-f="' + f + '" value="' + esc(value) + '"' + (attrs || "") + "></label>";
  const btn = (act, label, cls, title) => '<button class="rsc-btn' + (cls ? " " + cls : "") + '" data-act="' + act + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + label + "</button>";
  const techBtn = (key, label, on, kb) => '<button class="rsc-tech' + (on ? " is-on" : "") + '" data-act="tech:' + key + '">' + label + (kb ? " <kbd>" + kb + "</kbd>" : "") + "</button>";
  const lanesOf = (st) => st.lanes || [];
  const laneById = (st, id) => lanesOf(st).find((l) => l.id === id);
  const all = (items, f) => { const v = items.map((i) => i[f]); return v.every((x) => x === v[0]) ? v[0] : ""; };

  RSC.renderInspector = function (st) {
    const body = st.insp.querySelector(".rsc-insp-body");
    st.insp.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("is-on", b.dataset.tab === st.insTab));
    if (!st.project) { body.innerHTML = '<div class="rsc-insp-sub">Nothing open yet.</div>' + keysHelp(); return; }
    const html = { edit: editTab, song: songTab, levels: levelsTab, lyrics: lyricsTab, stems: stemsTab, beats: beatsTab }[st.insTab](st);
    const hadFocus = typeof document !== "undefined" && st.insp.contains(document.activeElement) && document.activeElement.tagName === "BUTTON";
    body.innerHTML = html;
    // a button that re-rendered the panel must not leave the keyboard nowhere: the studio keeps it
    if (hadFocus && !st.insp.contains(document.activeElement)) st.root.focus({ preventScroll: true });
    body.querySelectorAll("[data-f]").forEach((inp) => {
      inp.addEventListener("change", () => applyField(st, inp.dataset.f, inp.type === "checkbox" ? inp.checked : inp.value, inp));
      inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter" && inp.tagName !== "TEXTAREA") inp.blur(); });
    });
    body.querySelectorAll("input[type=range][data-lane]").forEach((r) => r.addEventListener("input", () => st.audio.setLane(r.dataset.lane, { gain: +r.value })));
    body.querySelectorAll("input[type=file][data-file]").forEach((f) => f.addEventListener("change", () => { if (f.files[0]) RSC.fileAction(st, f.dataset.file, f.files[0]); f.value = ""; }));
  };

  // ---- Edit: the selection ----------------------------------------------------------------------
  function editTab(st) {
    const s = st.sel, lane = laneById(st, s.lane), items = s.items;
    if (items.length && s.kind === "note") return noteEditor(st, lane, items);
    if (items.length && s.kind === "chord") return chordEditor(st, lane, items);
    if (items.length && s.kind === "anchor") return '<div class="rsc-insp-title">Anchor</div><div class="rsc-insp-sub">Where the fretting hand sits (the highway zooms here).</div>' +
      '<div class="rsc-row2">' + field("Fret", "anchor.fret", all(items, "fret"), ' type="number" min="1" max="22"') + field("Width (frets)", "anchor.width", all(items, "width"), ' type="number" min="4" max="8"') + "</div>" +
      field("Time (s)", "time", items.length === 1 ? num(items[0].time) : "") + '<div class="rsc-btns">' + btn("delete", "Delete") + "</div>";
    if (items.length && s.kind === "syl") return sylEditor(st, items);
    if (items.length && s.kind === "section") return sectionEditor(st, items);
    if (items.length && s.kind === "beat") return beatEditor(st, items);
    if (lane && lane.kind === "arr") return arrangementEditor(st, lane);
    if (lane && lane.kind === "wave") return stemsTab(st);
    if (lane && lane.kind === "vocals") return lyricsTab(st);
    if (lane && lane.kind === "beats") return beatsTab(st);
    if (lane && lane.kind === "sections") return sectionsList(st);
    return overview(st);
  }

  function overview(st) {
    const p = st.project, m = p.meta;
    const notes = p.arrangements.reduce((n, a) => n + a.doc.levels[0].notes.length + a.doc.levels[0].chords.length, 0);
    return '<div class="rsc-insp-title">' + esc(m.title || "Untitled") + '</div><div class="rsc-insp-sub">' + esc([m.artist, m.album, m.year].filter(Boolean).join(" \u00b7 ")) + "</div>" +
      '<div class="rsc-kv"><span>Charts</span><span>' + p.arrangements.map((a) => esc(a.name)).join(", ") + "</span><span>Notes</span><span>" + notes +
      "</span><span>Sections</span><span>" + p.sections.length + "</span><span>Beats</span><span>" + p.beats.length + " \u00b7 " + (p.beats.length > 1 ? E.averageTempo(p.beats).toFixed(1) + " BPM" : "\u2013") +
      "</span><span>Lyrics</span><span>" + (p.vocals ? p.vocals.syllables.length + " syllables" : "none") + "</span><span>Audio</span><span>" +
      (st.audio.mix ? RSC.fmtTime(st.audio.duration) + " \u00b7 " + (p.audio.codec === "pcm" ? "PCM" : "Wwise Vorbis") : "none") + "</span><span>Package</span><span>" + (E.PLATFORMS[p.platform] || {}).label + "</span></div>" +
      '<div class="rsc-hint">Click a note, a syllable, a section or a beat to edit it; click a lane name for its settings. <b>Draw</b> (D) adds, <b>Erase</b> (E) removes, drag moves, the right edge of a note sets its sustain. Shift-drag the ruler to loop a passage.</div>' + keysHelp();
  }
  RSC.KEYS = [["Space", "play / pause"], ["V D E", "select / draw / erase"], ["0\u20139", "type a fret (two digits: 1 then 2 = 12)"], ["\u2191 \u2193", "string (Alt: fret)"],
      ["\u2190 \u2192", "nudge by the grid (Alt: 10 ms)"], ["[ ]", "nudge \u00b110 ms"], ["H P B S V", "hammer, pull, bend, slide, vibrato"], ["M X A T N", "palm mute, mute, accent, tap, harmonic"],
      ["C", "notes \u2192 chord"], ["Q", "snap to the grid"], ["G", "grid size"], ["L", "loop"], ["PgUp PgDn", "difficulty level up / down"], ["Ctrl Z / Y", "undo / redo"], ["Ctrl C / V", "copy / paste at the playhead"], ["Del", "delete"],
      ["Ctrl + wheel", "zoom"], ["Shift + wheel", "scroll"], ["?", "help and the tour"]];
  function keysHelp() {
    const k = RSC.KEYS;
    return '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Keyboard</div><div class="rsc-keys">' + k.map(([a, b]) => "<kbd>" + a + "</kbd><span>" + b + "</span>").join("") + "</div>";
  }

  function noteEditor(st, lane, items) {
    const a = st.project.arrangements[lane.arr], one = items.length === 1 ? items[0] : null;
    const on = (f) => items.every((n) => n[f]);
    const midi = one ? E.midiNote(a.doc.tuning, one.string, one.fret, a.kind === "bass", a.doc.capo) : null;
    return '<div class="rsc-insp-title">' + (one ? "Note " + RSC.noteName(midi) : items.length + " notes") + '</div><div class="rsc-insp-sub">' + esc(a.name) +
      (one ? " \u00b7 bar " + st.barBeat(one.time) : "") + "</div>" +
      '<div class="rsc-row3">' + field("Fret", "note.fret", all(items, "fret"), ' type="number" min="0" max="24"') +
      field("String", "note.string", one ? lane.strings - one.string : "", ' type="number" min="1" max="' + lane.strings + '" title="1 = the highest string"') +
      field("Sustain", "note.sustain", num(all(items, "sustain")), ' type="number" step="0.05" min="0"') + "</div>" +
      (one ? field("Time (s)", "time", num(one.time), ' type="number" step="0.001"') : "") +
      '<div class="rsc-field-label" style="margin:4px 0 6px">Techniques</div><div class="rsc-techs">' +
      techBtn("hammerOn", "Hammer", on("hammerOn"), "H") + techBtn("pullOff", "Pull-off", on("pullOff"), "P") + techBtn("bend", "Bend", items.every((n) => n.bend > 0), "B") +
      techBtn("slide", "Slide", items.every((n) => n.slideTo >= 0), "S") + techBtn("vibrato", "Vibrato", on("vibrato"), "V") + techBtn("palmMute", "Palm mute", on("palmMute"), "M") +
      techBtn("mute", "Mute", on("mute"), "X") + techBtn("accent", "Accent", on("accent"), "A") + techBtn("tap", "Tap", on("tap"), "T") +
      techBtn("harmonic", "Harmonic", on("harmonic"), "N") + techBtn("harmonicPinch", "Pinch harm.", on("harmonicPinch")) + techBtn("tremolo", "Tremolo", on("tremolo"), "R") +
      techBtn("linkNext", "Link next", on("linkNext"), "K") + techBtn("ignore", "Ignore", on("ignore"), "I") + "</div>" +
      '<div class="rsc-row2">' + '<label class="rsc-field"><span>Bend (half steps)</span><select class="rsc-input" data-f="note.bend">' +
      [0, 0.5, 1, 1.5, 2, 3].map((v) => '<option value="' + v + '"' + (all(items, "bend") === v ? " selected" : "") + ">" + (v ? v : "none") + "</option>").join("") + "</select></label>" +
      field("Slide to fret", "note.slideTo", all(items, "slideTo") >= 0 ? all(items, "slideTo") : "", ' type="number" min="0" max="24" placeholder="none"') + "</div>" +
      '<div class="rsc-btns">' + (items.length > 1 ? btn("chord", "Make chord", "", "C: notes that start together become a chord") : "") + btn("delete", "Delete") + "</div>";
  }

  function chordEditor(st, lane, items) {
    const a = st.project.arrangements[lane.arr], doc = a.doc, c = items[0], tp = doc.chordTemplates[c.chordId] || { frets: [-1, -1, -1, -1, -1, -1], fingers: [] };
    const on = (f) => items.every((x) => x[f]);
    const frets = [];
    for (let s = lane.strings - 1; s >= 0; s--) frets.push('<input class="rsc-input" style="text-align:center;padding:0 2px" data-f="chord.fret.' + s + '" value="' + (tp.frets[s] >= 0 ? tp.frets[s] : "x") + '" title="String ' + (lane.strings - s) + '">');
    const sus = Math.max(0, ...(c.chordNotes || []).map((q) => q.sustain || 0));
    return '<div class="rsc-insp-title">' + (items.length === 1 ? "Chord " + esc(tp.chordName || "") : items.length + " chords") + '</div><div class="rsc-insp-sub">' + esc(a.name) +
      (items.length === 1 ? " \u00b7 bar " + st.barBeat(c.time) : "") + "</div>" +
      field("Name", "chord.name", tp.chordName || "") +
      '<div class="rsc-field"><span>Frets (high string first; x = not played)</span><div style="display:grid;grid-template-columns:repeat(' + lane.strings + ',1fr);gap:4px">' + frets.join("") + "</div></div>" +
      '<div class="rsc-row2">' + field("Sustain", "chord.sustain", num(sus), ' type="number" step="0.05" min="0"') + (items.length === 1 ? field("Time (s)", "time", num(c.time), ' type="number" step="0.001"') : "") + "</div>" +
      '<div class="rsc-techs">' + techBtn("palmMute", "Palm mute", on("palmMute"), "M") + techBtn("fretHandMute", "Mute", on("fretHandMute")) + techBtn("accent", "Accent", on("accent"), "A") +
      techBtn("highDensity", "Repeat", on("highDensity")) + techBtn("linkNext", "Link next", on("linkNext"), "K") + techBtn("ignore", "Ignore", on("ignore"), "I") + "</div>" +
      '<div class="rsc-hint">"Repeat" marks a strum of the same chord (high density: drawn without frame in the game).</div>' +
      '<div class="rsc-btns">' + btn("breakchord", "Break into notes") + btn("delete", "Delete") + "</div>";
  }

  function sylEditor(st, items) {
    const one = items.length === 1 ? items[0] : null, S = st.project.vocals.syllables;
    const text = one ? one.lyric.replace(/[+-]$/, "") : "";
    return '<div class="rsc-insp-title">' + (one ? "Syllable" : items.length + " syllables") + '</div><div class="rsc-insp-sub">' +
      (one ? "Line: " + esc(lineText(S, S.indexOf(one))) : "Move, nudge ([ ]) or snap (Q) them together.") + "</div>" +
      (one ? field("Text", "syl.text", text) +
        '<div class="rsc-row2">' + field("Time (s)", "time", num(one.time), ' type="number" step="0.001"') + field("Length (s)", "syl.length", num(one.length), ' type="number" step="0.01" min="0.02"') + "</div>" +
        '<div class="rsc-techs" style="grid-template-columns:1fr 1fr">' + techBtn("syl.join", "Joins next (-)", /-$/.test(one.lyric)) + techBtn("syl.end", "Ends line (+)", /\+$/.test(one.lyric)) + "</div>" +
        field("Sung pitch (MIDI, 254 = none)", "syl.note", one.note, ' type="number" min="0" max="254"') : "") +
      '<div class="rsc-btns">' + btn("delete", "Delete") + "</div>";
  }
  function lineText(S, i) {
    let a = i, b = i;
    while (a > 0 && !/\+$/.test(S[a - 1].lyric)) a--;
    while (b < S.length - 1 && !/\+$/.test(S[b].lyric)) b++;
    return S.slice(a, b + 1).map((s) => s.lyric.replace(/\+$/, "")).join(" ").replace(/- /g, "");
  }

  function sectionEditor(st, items) {
    const one = items.length === 1 ? items[0] : null;
    const opts = E.SECTION_NAMES.map((n) => '<option value="' + n + '"' + (one && one.name === n ? " selected" : "") + ">" + n + "</option>").join("");
    return '<div class="rsc-insp-title">' + (one ? "Section " + esc(one.name) + " " + one.number : items.length + " sections") + '</div><div class="rsc-insp-sub">Sections name the parts of the song (the game translates the usual names); a phrase starts at each.</div>' +
      (one ? '<label class="rsc-field"><span>Name</span><select class="rsc-input" data-f="section.name">' + opts + (E.SECTION_NAMES.includes(one.name) ? "" : '<option selected value="' + esc(one.name) + '">' + esc(one.name) + "</option>") + "</select></label>" +
        field("Start (s)", "section.start", num(one.startTime), ' type="number" step="0.001"') : "") +
      '<div class="rsc-btns">' + btn("delete", "Delete") + "</div>";
  }
  function sectionsList(st) {
    return '<div class="rsc-insp-title">Sections</div><div class="rsc-insp-sub">Draw (D) on the sections lane adds one at the grid; drag a section\'s left edge to move it; double-click renames it.</div>' +
      '<div class="rsc-kv">' + st.project.sections.map((s) => "<span>" + esc(s.name) + " " + s.number + "</span><span>" + RSC.fmtTime(s.startTime, true) + "</span>").join("") + "</div>";
  }

  function beatEditor(st, items) {
    const one = items.length === 1 ? items[0] : null, B = st.project.beats, i = one ? B.indexOf(one) : -1;
    const bpm = one && i + 1 < B.length ? 60 / (B[i + 1].time - one.time) : null;
    return '<div class="rsc-insp-title">' + (one ? (one.measure >= 0 ? "Bar " + one.measure : "Beat") : items.length + " beats") + '</div><div class="rsc-insp-sub">' +
      (bpm ? bpm.toFixed(2) + " BPM to the next beat" : "") + "</div>" +
      (one ? field("Time (s)", "time", num(one.time), ' type="number" step="0.001"') +
        '<div class="rsc-techs" style="grid-template-columns:1fr"> ' + techBtn("beat.bar", "Starts a bar", one.measure >= 0) + "</div>" +
        '<div class="rsc-row2">' + field("Tempo from here (BPM)", "beat.bpm", bpm ? bpm.toFixed(2) : "", ' type="number" step="0.01" min="20" max="400"') +
        field("Beats per bar from here", "beat.perbar", "", ' type="number" min="1" max="12" placeholder="4"') + "</div>" +
        '<div class="rsc-hint">Tempo from here re-spaces every later beat. Drag a beat to move it; Shift-drag moves it and all that follow.</div>' : "") +
      '<div class="rsc-btns">' + btn("delete", "Delete") + "</div>";
  }

  function arrangementEditor(st, lane) {
    const a = st.project.arrangements[lane.arr], d = a.doc, lv = d.levels[0];
    const tname = RSC.tuningName(d.tuning, lane.strings);
    const tunings = Object.keys(RSC.TUNINGS).map((n) => '<option' + (n === tname ? " selected" : "") + ">" + n + "</option>").join("") + (tname === "Custom" ? "<option selected>Custom</option>" : "");
    const offs = [];
    for (let s = lane.strings - 1; s >= 0; s--) offs.push('<input class="rsc-input" style="text-align:center;padding:0 2px" data-f="arr.tune.' + s + '" value="' + (d.tuning[s] || 0) + '" title="String ' + (lane.strings - s) + ': semitones from standard">');
    return '<div class="rsc-insp-title">' + esc(a.name) + '</div><div class="rsc-insp-sub">' + (lv.notes.length) + " notes \u00b7 " + lv.chords.length + " chords \u00b7 " +
      lv.anchors.length + " anchors" + (a.dd ? " \u00b7 " + (a.dd.view == null ? "full chart (" + a.dd.levels.length + " difficulty levels)" : "difficulty level " + a.dd.view) +
        ' (<button class="rsc-link" data-act="dd:tab">Levels</button>)' : a.levels > 1 ? " \u00b7 " + a.levels + " difficulty levels merged (saved as one)" : "") + "</div>" +
      field("Name", "arr.name", a.name) +
      '<label class="rsc-field"><span>Part</span><select class="rsc-input" data-f="arr.kind">' + ["lead", "rhythm", "combo", "bass"].map((k) => '<option value="' + k + '"' + (a.kind === k ? " selected" : "") + ">" + k + "</option>").join("") + "</select></label>" +
      '<label class="rsc-field"><span>Tuning</span><select class="rsc-input" data-f="arr.tuning">' + tunings + "</select></label>" +
      '<div class="rsc-field"><span>Semitones per string (high string first)</span><div style="display:grid;grid-template-columns:repeat(' + lane.strings + ',1fr);gap:4px">' + offs.join("") + "</div></div>" +
      '<div class="rsc-row2">' + field("Capo", "arr.capo", d.capo || 0, ' type="number" min="0" max="12"') + field("Cent offset", "arr.cents", d.centOffset || 0, ' type="number" step="1" title="Tuning off A440, in cents"') + "</div>" +
      field("Fret for new notes", "arr.drawfret", st.fret, ' type="number" min="0" max="24"') +
      '<div class="rsc-btns">' + btn("autoanchors", "Re-build anchors", "", "Where the hand moves, from the notes") + btn("removearr", "Remove chart") + "</div>" +
      '<div class="rsc-hint">Draw (D) on a string adds a note with the fret above; type digits to set the fret of the selected notes.</div>' +
      fillSection(st, a);
  }

  /** Filling a chart by ear: a draft from the recording, or played in with the tuner. */
  function fillSection(st, a) {
    const bass = a.kind === "bass", lead = a.kind === "lead" && !bass;
    const loop = st.audio.loop && st.audio.loop.on ? " (the loop range)" : "";
    return '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Fill this chart by ear</div>' +
      '<div class="rsc-btns">' + btn("tuner:open", "\u266a Tuner: play it in", "is-accent", "Play your " + (bass ? "bass" : "guitar") + " into the microphone: the tuner shows the note or chord and writes it into this chart") +
      (lead ? "" : btn("fill:draft", bass ? "Draft the bass line" : "Draft the chords", "", "From the recording" + loop + ": " + (bass ? "the chord roots on every beat, in the bass's octave" : "a chord on every beat")) ) + "</div>" +
      '<div class="rsc-hint"><b>Tuner</b>: Step puts each note or chord you play at the playhead and moves on; Record writes what you play along with the song. ' +
      (lead ? "A lead line can't be drafted from a full mix: play it in with the tuner." :
        "<b>Draft</b>: a rough start from the recording" + loop + " \u2014 on the sample songs " + (bass ? "about a third of the bass notes" : "about half the chords") + " come out right; listen (the headphones button) and fix the rest.") + "</div>";
  }

  // ---- Song ---------------------------------------------------------------------------------------
  function songTab(st) {
    const p = st.project, m = p.meta;
    const arrs = p.arrangements.map((a, i) => '<div class="rsc-stemrow"><span class="rsc-head-dot" style="background:' + (a.kind === "bass" ? "#b04ee6" : a.kind === "rhythm" ? "#22c55e" : "#1f9cf0") + '"></span><b>' +
      esc(a.name) + '</b><span class="rsc-head-sub">' + RSC.tuningName(a.doc.tuning, a.kind === "bass" ? 4 : 6) + '</span><button class="rsc-hb" data-act="selarr:' + i + '" title="Edit">\u270e</button></div>').join("");
    return '<div class="rsc-insp-title">Song</div><div class="rsc-insp-sub">What the game and RockShiny show. Key: <code>' + esc(p.key) + "</code></div>" +
      field("Title", "meta.title", m.title) + field("Artist", "meta.artist", m.artist) +
      '<div class="rsc-row2">' + field("Album", "meta.album", m.album) + field("Year", "meta.year", m.year, ' inputmode="numeric"') + "</div>" +
      '<div class="rsc-row2">' + field("Title (sorting)", "meta.titleSort", m.titleSort || "") + field("Artist (sorting)", "meta.artistSort", m.artistSort || "") + "</div>" +
      '<div class="rsc-row2">' + field("Song volume (dB)", "meta.volume", m.volume, ' type="number" step="0.5" min="-20" max="0"') + field("Preview volume (dB)", "meta.previewVolume", m.previewVolume, ' type="number" step="0.5" min="-20" max="0"') + "</div>" +
      '<label class="rsc-field"><span>Album art (any image; stored as 256 / 128 / 64 px DDS)</span><input class="rsc-input" style="padding-top:5px" type="file" accept="image/*" data-file="art"></label>' +
      '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Charts</div>' + arrs +
      '<div class="rsc-row2" style="margin-top:8px"><label class="rsc-field"><span>Add a chart</span><select class="rsc-input" data-f="add.kind"><option value="lead">Lead</option><option value="rhythm">Rhythm</option><option value="bass">Bass</option><option value="combo">Combo</option></select></label>' +
      '<label class="rsc-field"><span>Tuning</span><select class="rsc-input" data-f="add.tuning">' + Object.keys(RSC.TUNINGS).map((n) => "<option>" + n + "</option>").join("") + "</select></label></div>" +
      '<div class="rsc-btns">' + btn("addarr", "Add chart", "is-ghost") + "</div>";
  }

  // ---- Levels: dynamic difficulty ---------------------------------------------------------------------
  const KIND_COLOR = (a) => (a.kind === "bass" ? "#b04ee6" : a.kind === "rhythm" ? "#22c55e" : "#1f9cf0");
  /** How many levels "Create easier levels" makes in a busy part (quiet parts get fewer). */
  const LEVEL_SIZES = [[4, "Fewer (5 levels)"], [8, "Standard (9 levels)"], [12, "More (13 levels)"], [20, "Most (21 levels)"]];
  function levelsTab(st) {
    const p = st.project;
    const head = '<div class="rsc-insp-title">Difficulty levels <button class="rsc-link rsc-help-link" data-act="help:levels" title="How difficulty levels work">How do levels work?</button></div>';
    if (!p.arrangements.length) return head + '<div class="rsc-insp-sub">No charts yet: add one in the Song tab.</div>';
    const i = st.levelArr(), a = p.arrangements[i], info = E.ddInfo(a), top = info.levels - 1;
    const charts = p.arrangements.map((x, j) => '<button class="rsc-lvchart' + (j === i ? " is-on" : "") + '" data-act="dd:chart:' + j + '" title="Work on the levels of ' + esc(x.name) + '"><span class="rsc-head-dot" style="background:' +
      KIND_COLOR(x) + '"></span>' + esc(x.name) + "<small>" + (x.dd ? x.dd.levels.length + " levels" : "no levels") + "</small></button>").join("");
    const max = st.ddMax || (a.dd && a.dd.auto && a.dd.auto.maxLevels) || 8;
    const sizes = '<select class="rsc-input" data-f="dd.max" title="How many levels the busiest parts get (quiet parts get fewer)">' +
      LEVEL_SIZES.map(([v, l]) => '<option value="' + v + '"' + (v === max ? " selected" : "") + ">" + l + "</option>").join("") + "</select>";
    const r = E.ddRangeAt(a.doc, st.audio.time()), ph = r && r.phraseId >= 0 ? info.phrases[r.phraseId] : null;
    let h = head + '<div class="rsc-insp-sub">Players choose how hard a song is: at the easiest level they play a few notes, and the game adds notes as they get better. ' +
      "Each chart has its own levels.</div>" + '<div class="rsc-lvcharts">' + charts + "</div>";

    if (!a.dd) {
      // no levels yet: one clear thing to do
      h += '<div class="rsc-lvcard"><b>' + esc(a.name) + " has no easier levels.</b> Every player gets the full chart.</div>" +
        '<div class="rsc-step"><span class="rsc-step-n">1</span><b>Create easier levels</b></div>' +
        '<div class="rsc-field-label" style="margin-bottom:6px">How many levels</div><div class="rsc-lvmake">' + sizes + "</div>" +
        '<div class="rsc-btns">' + btn("dd:auto:all", "\u2728 Create easier levels", "is-accent is-wide", "Make easier versions of this chart from the full chart") + "</div>" +
        '<div class="rsc-hint">The Creator makes them from the full chart. The easiest level keeps about one note in eight, on the strongest beats; each level above adds notes until the top level is the full chart. ' +
        "Chords get fewer strings at easy levels. Notes keep their fret and techniques. You can look at every level afterwards, change it by hand, or undo.</div>" +
        (ph ? '<div class="rsc-btns">' + btn("dd:auto:phrase", "Only for \u201c" + esc(ph.name) + "\u201d", "", "Only the part of the song at the playhead gets levels") + "</div>" : "");
      return h;
    }

    // 1. see a level
    const played = E.ddPlayedCounts(a), most = Math.max(1, ...played);
    const hardN = played[played.length - 1];
    const btns = [];
    for (let k = 0; k <= top; k++) btns.push('<button class="rsc-lv' + (info.view === k ? " is-on" : "") + '" data-act="dd:view:' + k + '" title="Level ' + k + (k === 0 ? " (easiest)" : "") + ": a player plays " + played[k] + ' notes and chords">' + k +
      '<i style="height:' + Math.max(2, Math.round(14 * played[k] / most)) + 'px"></i></button>');
    btns.push('<button class="rsc-lv is-all' + (info.view == null ? " is-on" : "") + '" data-act="dd:view:all" title="The full chart: every part at its top level (' + hardN + ' notes and chords)">Full chart</button>');
    h += '<div class="rsc-step"><span class="rsc-step-n">1</span><b>Look at a level</b></div>' +
      '<div class="rsc-lvs">' + btns.join("") + '</div><div class="rsc-lvscale"><span>\u2190 easiest</span><span>bars: notes played</span><span>hardest \u2192</span></div>' +
      '<div class="rsc-lvcard">' + (info.view == null
        ? "<b>Showing the full chart</b> (" + hardN + " notes and chords). Edits change the full chart; the easier levels do not follow by themselves \u2014 see step 3."
        : "<b>Showing level " + info.view + "</b> \u2014 what a player at level " + info.view + " plays. Dashed notes are in the full chart but not in this level. Edits change level " + info.view + " only.") +
      ' <span class="rsc-muted"><kbd>PgUp</kbd> <kbd>PgDn</kbd> step through the levels.</span></div>';

    // 2. change levels
    const k = info.view, lvl = (m) => (k == null ? "its top level (" + m + ")" : "level " + Math.min(k, m));
    h += '<div class="rsc-step"><span class="rsc-step-n">2</span><b>Change the levels</b></div>' +
      '<div class="rsc-field-label" style="margin-bottom:6px">Re-create every level from the full chart</div>' +
      '<div class="rsc-lvmake">' + sizes + btn("dd:auto:all", "Re-create", "is-accent", "Replace all the levels of this chart with new ones made from the full chart") + "</div>" +
      '<div class="rsc-hint">Replaces the levels of ' + esc(a.name) + " (undo brings them back).</div>";
    if (ph) {
      h += '<div class="rsc-field-label" style="margin:4px 0 6px">Only the part at the playhead: \u201c' + esc(ph.name) + "\u201d" + (ph.iterations.length > 1 ? " (played " + ph.iterations.length + " times)" : "") +
        ", levels 0\u2013" + ph.max + "</div>" +
        '<div class="rsc-btns">' + btn("dd:auto:phrase", "Re-create its levels", "", "New levels for this part only, from the full chart") +
        btn("dd:ins:phrase", "+ Add a level", "", "Copy " + lvl(ph.max) + " of this part as a new, easier level; then delete notes from it") +
        btn("dd:del:phrase", "\u2212 Remove " + (k == null ? "top level" : "level " + Math.min(k, ph.max)), "", "Remove " + lvl(ph.max) + " of this part; the levels above move down") + "</div>" +
        '<div class="rsc-hint"><b>Add a level</b> copies the level you are looking at and puts the copy below it: delete notes from the copy to make it easier. ' +
        "Rocksmith calls these parts <i>phrases</i>; they start at the sections.</div>";
    }

    // 3. when saving
    const mode = info.mode;
    const opt = (m, label, sub) => '<button class="rsc-choice' + (mode === m ? " is-on" : "") + '" data-act="dd:mode:' + m + '"><i></i><span><b>' + label + "</b><small>" + sub + "</small></span></button>";
    h += '<div class="rsc-step"><span class="rsc-step-n">3</span><b>When you save</b></div><div class="rsc-choices">' +
      opt("keep", "Keep the levels as they are", "Your hand edits stay. Best when you have worked on the levels.") +
      opt("auto", "Re-create them from the full chart", "Every save makes new levels from the full chart, so they follow your edits.") +
      opt("flat", "Save the full chart only", "No levels: every player gets the full chart.") + "</div>";

    // the parts of the song
    const used = info.phrases.filter((x) => x.iterations.length);
    const rows = used.map((x) => '<button class="rsc-lvrow' + (ph && ph.id === x.id ? " is-on" : "") + '" data-act="dd:seek:' + x.iterations[0] + '" title="Go to ' + esc(x.name) + '">' +
      "<span>" + esc(x.name) + (x.iterations.length > 1 ? " <small>\u00d7" + x.iterations.length + "</small>" : "") + "</span>" +
      '<i><b style="width:' + (top ? (100 * x.max / top).toFixed(1) : 0) + '%"></b></i><em>' + x.max + "</em></button>").join("");
    h += '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Parts of the song \u00b7 their top level <span class="rsc-muted">(click to go there)</span></div><div class="rsc-lvlist">' + rows + "</div>" +
      '<div class="rsc-btns" style="margin-top:8px">' + btn("dd:flatten", "Remove all levels", "", "Keep only the full chart") + "</div>";
    return h;
  }

  /** The chart's phrases follow the project's sections before levels are changed (as when saving). */
  function syncPhrases(st, a) {
    const p = st.project;
    if (!a.doc.phraseIterations.length || ((p.sectionsEdited || !a.origin) && JSON.stringify(a.doc.sections) !== JSON.stringify(p.sections))) E.arrApplySections(a, p.sections);
  }

  RSC.levelAct = function (st, act) {
    const p = st.project, parts = act.split(":"), what = parts[1], arg = parts[2];
    if (what === "tab") { st.insTab = "levels"; st.renderInspector(); return; }
    if (what === "chart") { st.ddArr = +arg; st.insTab = "levels"; st.selectLane("arr:" + arg); return; }
    const i = st.levelArr(), a = p.arrangements[i];
    if (!a) return;
    if (what === "view") { st.showLevel(i, arg === "all" ? null : +arg); return; }
    if (what === "seek") { const t = +arg; st.audio.seek(t); st.centerOn(t, true); st.renderInspector(); return; }
    const key = "dd:" + i, r = E.ddRangeAt(a.doc, st.audio.time()), phraseId = r && r.phraseId >= 0 ? r.phraseId : null;
    const scope = arg === "phrase" ? phraseId : null;
    if ((what === "ins" || what === "del" || what === "auto") && arg === "phrase" && phraseId == null) { st.toast("Move the playhead into the song first", "error"); return; }
    const k = a.dd ? a.dd.view : null;
    const done = (msg) => { st.refreshGhosts(); st.renderHeads(); st.renderCard(); st.refreshGuides(); st.draw(); st.renderInspector(); if (msg) st.toast(msg); };
    const partName = phraseId != null && a.doc.phrases[phraseId] ? "\u201c" + a.doc.phrases[phraseId].name + "\u201d" : "this part";
    if (what === "ins") {
      const m0 = scope != null ? ((a.doc.phrases[scope] || {}).maxDifficulty | 0) : null;
      st.edit(scope != null ? "Add a level to " + partName : "Add a level everywhere", [key], () => { syncPhrases(st, a); E.ddInsertLevel(a, scope, k); });
      // show the copy: the level to make easier
      if (a.dd) E.ddShow(a, k != null ? k : scope != null ? Math.min(m0, a.dd.levels.length - 1) : a.dd.view);
      done(scope != null ? "Level copied. Now delete notes from this copy to make it easier" : "A level was added to every part");
      return;
    }
    if (what === "del") {
      if (k == null && root.confirm && !root.confirm("Remove the top level of " + (scope != null ? partName : "every part") + "? The level below it becomes the full chart there, so notes disappear from the full chart.")) return;
      st.edit("Remove a level", [key], () => { syncPhrases(st, a); E.ddRemoveLevel(a, scope, k); });
      done("Level removed");
      return;
    }
    if (what === "auto") {
      const maxLevels = st.ddMax || (a.dd && a.dd.auto && a.dd.auto.maxLevels) || 8;
      st.busy("Creating easier levels\u2026", a.name + ": made from the full chart");
      setTimeout(() => {
        try {
          st.edit("Create easier levels", [key], () => { syncPhrases(st, a); E.ddAuto(a, { maxLevels, phrases: scope, beats: p.beats }); });
        } finally { st.busy(null); }
        done(a.dd ? a.name + ": levels 0\u2013" + (a.dd.levels.length - 1) + (scope != null ? " (" + partName + " re-created)" : " created. Click a level to look at it") : a.name + " has too few notes for levels");
      }, 30);
      return;
    }
    if (what === "mode") {
      st.edit("When saving: " + ({ keep: "keep the levels", auto: "re-create them", flat: "full chart only" })[arg], [key], () => { syncPhrases(st, a); E.ddSetMode(a, arg, { maxLevels: st.ddMax, beats: p.beats }); });
      done();
      return;
    }
    if (what === "flatten") {
      if (root.confirm && !root.confirm("Remove all difficulty levels of " + a.name + " and keep only the full chart?")) return;
      st.edit("Remove all levels", [key], () => E.ddFlatten(a));
      done(a.name + ": full chart only (no levels)");
    }
  };

  // ---- Lyrics -----------------------------------------------------------------------------------------
  function lyricsTab(st) {
    const p = st.project, v = p.vocals, n = v ? v.syllables.length : 0, lines = v ? RSC.sync.lineIndex(v.syllables) : [];
    const nl = n ? lines[lines.length - 1] + 1 : 0;
    const src = st.lyricsInfo ? '<div class="rsc-hint">' + esc(st.lyricsInfo) + "</div>" : "";
    return '<div class="rsc-insp-title">Lyrics</div><div class="rsc-insp-sub">' + (n ? n + " syllables in " + nl + " lines" : "No lyrics yet.") + "</div>" + src +
      '<div class="rsc-field-label" style="margin-bottom:6px">Get lyrics</div><div class="rsc-btns">' + btn("lyr:online", "Find online (LRCLIB)", "is-ghost", "Timed lyrics from lrclib.net (only the artist and title are sent)") + "</div>" +
      '<label class="rsc-field"><span>Import a .lrc or .txt file</span><input class="rsc-input" style="padding-top:5px" type="file" accept=".lrc,.txt,text/plain" data-file="lyrics"></label>' +
      '<label class="rsc-field"><span>Or paste them (LRC with [mm:ss.xx] times, or plain lines)</span><textarea class="rsc-input" data-role="paste" placeholder="[00:16.20] You get a shiver in the dark&#10;[00:19.80] It\'s raining in the park but meantime"></textarea></label>' +
      '<div class="rsc-btns">' + btn("lyr:paste", "Use these lyrics") + "</div>" +
      '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Sync to the recording</div>' +
      '<div class="rsc-btns">' + btn("lyr:auto", "Auto-sync", "is-accent", "One shift for all the lines, onto where the voice sings (lyrics timed on this recording, e.g. LRCLIB)") +
        btn("lyr:lines", "Sync each line", "", "Each line onto its sung phrase (lyrics of another take, or timed roughly)") + "</div>" +
      '<div class="rsc-btns">' + btn("lyr:tap", st.tapping ? "Stop tapping" : "Tap-sync", st.tapping ? "is-ghost" : "", "Play the song and press T at the start of each line") +
        btn("lyr:voice", st.showVoice ? "Hide the voice" : "Show the voice", st.showVoice ? "is-ghost" : "", "Where the voice sings, under the lyrics: its sung phrases and its silences") + "</div>" +
      (st.showVoice && st.voice ? '<div class="rsc-hint"><b>The voice:</b> ' + st.voice.segments.length + " sung phrases, " +
        RSC.fmtTime(st.voice.segments.reduce((x, g) => x + g.t1 - g.t0, 0)) + " of singing (the amber band under the lyrics: the higher, the surer; a line marks each sung phrase).</div>" : "") +
      (st.tapping ? '<div class="rsc-hint"><b>Tapping:</b> press <kbd>T</kbd> when line ' + ((st.tapLine || 0) + 1) + " starts: \u201c" + esc(st.tapText || "") + "\u201d</div>" : "") +
      '<div class="rsc-btns">' + btn("lyr:shift:-0.1", "\u2212100 ms") + btn("lyr:shift:-0.02", "\u221220") + btn("lyr:shift:0.02", "+20") + btn("lyr:shift:0.1", "+100 ms") + "</div>" +
      '<div class="rsc-btns">' + btn("lyr:first", "First line \u2192 playhead", "", "Put the first line at the playhead") + btn("lyr:last", "Stretch: last line \u2192 playhead", "", "Keep the first line and stretch every line so the last one starts at the playhead (lyrics of another take)") + "</div>" +
      '<div class="rsc-hint">Select syllables to move them together; [ and ] nudge by 10 ms. Syllables inside a line follow RockShiny\'s timing model; the sung pitch is optional.</div>' +
      (n ? '<div class="rsc-btns">' + btn("lyr:clear", "Remove the lyrics") + "</div>" : "");
  }

  // ---- Stems --------------------------------------------------------------------------------------------
  function stemsTab(st) {
    const a = st.audio, have = !!a.stems;
    const rows = [["mix", "Mix", "#aeb7cc"]].concat(have ? RSC.stems.STEMS.filter((s) => a.stems.ids.includes(s.id)).map((s) => [s.id, s.label, s.color]) : []).map(([id, label, color]) => {
      const l = a.lanes[id] || { gain: 1 };
      return '<div class="rsc-stemrow"><span class="rsc-head-dot" style="background:' + color + '"></span><b>' + label + "</b>" +
        '<input type="range" class="rsc-vol" min="0" max="1.5" step="0.01" value="' + l.gain + '" data-lane="' + id + '" title="Volume">' +
        '<button class="rsc-hb' + (l.mute ? " is-m" : "") + '" data-act="mute:' + id + '">M</button><button class="rsc-hb' + (l.solo ? " is-s" : "") + '" data-act="solo:' + id + '">S</button>' +
        (id !== "mix" ? '<button class="rsc-hb" data-act="dlstem:' + id + '" title="Download as WAV">\u2193</button>' : "") + "</div>";
    }).join("");
    const g = RSC.stems.guideFromProject(st.project);
    const long = st.audio.duration > 720;
    return '<div class="rsc-insp-title">Stems</div><div class="rsc-insp-sub">Vocals, guitar, bass, drums and the rest, separated using this song\'s own charts and lyrics (' +
      g.guitar.length + " guitar and " + g.bass.length + " bass notes, " + g.lyrics.length + " sung syllables).</div>" +
      (st.stemsProgress != null ? '<div class="rsc-progress"><i style="width:' + (100 * st.stemsProgress).toFixed(1) + '%"></i></div>' : "") +
      '<div class="rsc-btns">' + btn("stems:run", have ? "Separate again" : "Separate stems", "is-accent") + (have ? btn("stems:all", "Download all") : "") +
      (have && st.host.saveStems ? btn("stems:save", "Save to the library folder") : "") + "</div>" +
      (long ? '<div class="rsc-hint">This recording is long: the loop range (or the first 12 minutes) is separated.</div>' : "") +
      rows +
      '<div class="rsc-hint">Signal processing on the stereo mix guided by the chart (harmonic combs at every charted note, the lyrics\' timing and the centre of the stereo image) \u2014 not a neural network: uncharted parts stay in \u201cOther\u201d. The stems add up to the mix exactly. Mute a stem to practise without it.</div>';
  }

  // ---- Beats --------------------------------------------------------------------------------------------
  function beatsTab(st) {
    const B = st.project.beats, bpm = B.length > 1 ? E.averageTempo(B) : null;
    return '<div class="rsc-insp-title">Beat grid</div><div class="rsc-insp-sub">' + B.length + " beats" + (bpm ? " \u00b7 average " + bpm.toFixed(2) + " BPM" : "") +
      ". The grid the notes snap to, the bars the game counts, and the metronome.</div>" +
      '<div class="rsc-row2">' + field("Tempo hint (BPM)", "beats.hint", st.beatHint || "", ' type="number" min="40" max="240" placeholder="auto"') +
      field("Beats per bar", "beats.perbar", st.perBar || 4, ' type="number" min="2" max="12"') + "</div>" +
      '<div class="rsc-btns">' + btn("beats:detect", "Detect from the audio", "is-accent", "Beat tracking on the recording") + "</div>" +
      '<div class="rsc-btns">' + btn("beats:double", "\u00d72 tempo") + btn("beats:half", "\u00f72 tempo") + btn("beats:barhere", "Bar starts at playhead") + "</div>" +
      '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Constant tempo</div>' +
      '<div class="rsc-row2">' + field("BPM", "beats.bpm", bpm ? bpm.toFixed(2) : "120", ' type="number" step="0.01" min="20" max="400"') + field("First beat (s)", "beats.first", B.length ? num(B[0].time) : "0", ' type="number" step="0.001"') + "</div>" +
      '<div class="rsc-btns">' + btn("beats:const", "Rebuild the grid") + btn("beats:tap", "Tap tempo", "", "Click on the beat a few times") + "</div>" +
      (st.tapTempo ? '<div class="rsc-hint">Tapped: <b>' + st.tapTempo.toFixed(1) + " BPM</b></div>" : "") +
      '<div class="rsc-sep"></div><div class="rsc-field-label" style="margin-bottom:6px">Move everything</div>' +
      '<div class="rsc-row2">' + field("Shift the chart by (s)", "beats.shift", "", ' type="number" step="0.001" placeholder="e.g. -0.120"') + '<div style="display:flex;align-items:flex-end;padding-bottom:9px">' + btn("beats:shift", "Apply") + "</div></div>" +
      '<div class="rsc-hint">Moves beats, sections, notes and lyrics together (after replacing the audio, or when the whole chart is early or late).</div>';
  }

  // ---- field edits --------------------------------------------------------------------------------------
  function applyField(st, f, value, inp) {
    const s = st.sel, lane = laneById(st, s.lane), p = st.project, items = s.items;
    const key = lane ? (lane.kind === "arr" ? "arr:" + lane.arr : lane.kind === "vocals" ? "vocals" : lane.kind) : null;
    const n = +value;
    const [grp, prop, sub] = f.split(".");
    if (f === "time") {
      if (!items.length || !Number.isFinite(n)) return;
      st.edit("Time", [key], () => { for (const it of items) { if (it.startTime != null) it.startTime = r3(n); else it.time = r3(n); } if (lane.kind === "arr") RSC.sortLevel(p.arrangements[lane.arr].doc.levels[0]); if (lane.kind === "vocals") p.vocals.syllables.sort((a, b) => a.time - b.time); if (lane.kind === "beats") RSC.renumberMeasures(p.beats); if (lane.kind === "sections") RSC.renumberSections(p.sections); });
    } else if (grp === "note") {
      st.edit(prop, [key], () => {
        for (const it of items) {
          if (prop === "fret" && value !== "") it.fret = Math.max(0, Math.min(24, Math.round(n)));
          if (prop === "string" && value !== "") it.string = Math.max(0, Math.min(lane.strings - 1, lane.strings - Math.round(n)));
          if (prop === "sustain" && value !== "") it.sustain = Math.max(0, r3(n));
          if (prop === "bend") { it.bend = n; it.bendValues = n ? [{ time: r3(it.time + Math.min(0.1, (it.sustain || 0.3) * 0.3)), step: n, unk5: 0 }] : []; if (n && !(it.sustain > 0)) it.sustain = 0.3; }
          if (prop === "slideTo") { it.slideTo = value === "" ? -1 : Math.max(0, Math.min(24, Math.round(n))); if (it.slideTo >= 0 && !(it.sustain > 0)) it.sustain = 0.3; }
        }
        RSC.sortLevel(p.arrangements[lane.arr].doc.levels[0]);
      });
      if (prop === "fret" && value !== "") st.fret = Math.round(n);
    } else if (grp === "chord") {
      const doc = p.arrangements[lane.arr].doc;
      st.edit("Chord", [key], () => {
        for (const c of items) {
          const tp = doc.chordTemplates[c.chordId];
          if (prop === "name") { const frets = tp.frets.slice(); c.chordId = RSC.templateFor(doc, frets, tp.fingers, String(value).trim() || RSC.chordName(doc, frets)); }
          if (prop === "fret") {
            const frets = tp.frets.slice(), v = String(value).trim().toLowerCase();
            frets[+sub] = v === "x" || v === "" ? -1 : Math.max(0, Math.min(24, Math.round(+v)));
            c.chordId = RSC.templateFor(doc, frets, tp.fingers, "");
            c.chordNotes = (c.chordNotes || []).filter((q) => frets[q.string] >= 0);
            for (const q of c.chordNotes) q.fret = frets[q.string];
          }
          if (prop === "sustain") {
            const tp2 = doc.chordTemplates[c.chordId];
            tp2.frets.forEach((fr, s2) => { if (fr < 0) return; let q = (c.chordNotes || []).find((x) => x.string === s2); if (!q) { q = Object.assign({}, E.NOTE_DEFAULTS, { time: c.time, string: s2, fret: fr, bendValues: [] }); (c.chordNotes = c.chordNotes || []).push(q); } q.sustain = Math.max(0, r3(n)); });
          }
        }
      });
    } else if (grp === "anchor") {
      st.edit("Anchor", [key], () => { for (const a of items) a[prop] = Math.max(prop === "width" ? 4 : 1, Math.round(n)); });
    } else if (grp === "syl") {
      st.edit("Syllable", ["vocals"], () => {
        const it = items[0];
        if (prop === "text") it.lyric = String(value).replace(/[+-]$/, "") + (/-$/.test(it.lyric) ? "-" : /\+$/.test(it.lyric) ? "+" : "");
        if (prop === "length") it.length = Math.max(0.02, r3(n));
        if (prop === "note") it.note = Math.max(0, Math.min(254, Math.round(n)));
      });
    } else if (grp === "section") {
      st.edit("Section", ["sections"], () => {
        const it = items[0];
        if (prop === "name") it.name = String(value).toLowerCase();
        if (prop === "start") it.startTime = Math.max(0, r3(n));
        RSC.renumberSections(p.sections);
      });
    } else if (grp === "beat") {
      const b = items[0], B = p.beats, i = B.indexOf(b);
      if (prop === "bpm" && n > 0) st.edit("Tempo", ["beats"], () => RSC.retempoFrom(p, i, n));
      if (prop === "perbar" && n > 0) st.edit("Bars", ["beats"], () => RSC.barsFrom(p, i, Math.round(n)));
    } else if (grp === "meta") {
      st.edit("Song details", ["meta"], () => {
        const m = p.meta;
        if (prop === "volume" || prop === "previewVolume") m[prop] = Math.max(-30, Math.min(6, n));
        else m[prop] = String(value).trim();
        if (prop === "title" && !m.titleSort) m.titleSort = m.title;
        if (prop === "artist" && !m.artistSort) m.artistSort = m.artist;
      });
    } else if (grp === "arr") {
      const a = p.arrangements[lane.arr];
      if (prop === "drawfret") { st.fret = Math.max(0, Math.min(24, Math.round(n))); return; }
      st.edit("Chart settings", [key], () => {
        const d = a.doc;
        if (prop === "name") a.name = String(value).trim() || a.name;
        if (prop === "kind") { a.kind = value; Object.assign(d.properties, E.ARRANGEMENT_KINDS[value].path); }
        if (prop === "tuning" && RSC.TUNINGS[value]) d.tuning = RSC.TUNINGS[value].slice();
        if (prop === "tune") d.tuning[+sub] = Math.max(-12, Math.min(12, Math.round(n)));
        if (prop === "capo") d.capo = Math.max(0, Math.min(12, Math.round(n)));
        if (prop === "cents") d.centOffset = Math.max(-100, Math.min(100, n));
      });
      st.buildLanes(); st.draw();
    } else if (grp === "beats") {
      if (prop === "hint") st.beatHint = n > 0 ? n : null;
      if (prop === "perbar") st.perBar = Math.max(2, Math.min(12, Math.round(n)));
      if (prop === "bpm") st.constBpm = n;
      if (prop === "first") st.constFirst = n;
      if (prop === "shift") st.shiftBy = n;
      return;
    } else if (grp === "add") { st["add_" + prop] = value; return; }
    else if (grp === "dd") { if (prop === "max") st.ddMax = Math.max(1, Math.min(30, Math.round(n))); return; }
    st.renderInspector();
  }

  /** Re-space the beats from index i at a constant BPM (until the end). */
  RSC.retempoFrom = function (p, i, bpm) {
    const B = p.beats, t0 = B[i].time, step = 60 / bpm, end = Math.max(p.meta.songLength || 0, B[B.length - 1].time);
    const head = B.slice(0, i + 1), out = head.slice();
    for (let t = t0 + step, k = 1; t <= end + 1e-6; t += step, k++) out.push({ time: r3(t), measure: -1 });
    // keep the bar structure: the beats per bar of the bar the change starts in
    let per = 4, last = -1;
    for (let k = i; k >= 0; k--) if (B[k].measure >= 0) { last = k; break; }
    if (last >= 0) { let next = B.findIndex((b, k) => k > last && b.measure >= 0); if (next > last) per = next - last; }
    for (let k = i + 1; k < out.length; k++) out[k].measure = (k - Math.max(0, last)) % per === 0 ? 0 : -1;
    p.beats = out;
    RSC.renumberMeasures(p.beats);
  };
  RSC.barsFrom = function (p, i, per) {
    const B = p.beats;
    for (let k = i; k < B.length; k++) B[k].measure = (k - i) % per === 0 ? 0 : -1;
    RSC.renumberMeasures(B);
  };

  // ---- buttons ---------------------------------------------------------------------------------------
  RSC.inspectorAct = function (st, a, b) {
    const lane = laneById(st, st.sel.lane), p = st.project;
    if (!p) return;
    const key = lane ? (lane.kind === "arr" ? "arr:" + lane.arr : lane.kind === "vocals" ? "vocals" : lane.kind) : null;
    if (a.startsWith("tech:")) {
      const t = a.slice(5);
      if (t === "syl.join" || t === "syl.end") {
        const it = st.sel.items[0];
        st.edit("Syllable", ["vocals"], () => {
          const base = it.lyric.replace(/[+-]$/, ""), isJ = /-$/.test(it.lyric), isE = /\+$/.test(it.lyric);
          it.lyric = base + (t === "syl.join" ? (isJ ? "" : "-") : (isE ? "" : "+"));
        });
      } else if (t === "beat.bar") {
        st.edit("Bar start", ["beats"], () => { for (const x of st.sel.items) x.measure = x.measure >= 0 ? -1 : 0; RSC.renumberMeasures(p.beats); });
      } else if (lane && lane.kind === "arr") RSC.toggleTech(st, lane, t);
      st.renderInspector();
      return;
    }
    if (a === "delete") { RSC.deleteSelection(st); return; }
    if (a === "chord") { RSC.makeChord(st, lane); return; }
    if (a === "breakchord") { RSC.breakChord(st, lane); return; }
    if (a === "autoanchors" && lane) { st.edit("Anchors", [key], () => { p.arrangements[lane.arr].doc.levels[0].anchors = E.autoAnchors(p.arrangements[lane.arr].doc); }); st.toast("Anchors rebuilt from the notes"); return; }
    if (a === "removearr" && lane) {
      const name = p.arrangements[lane.arr].name;
      if (root.confirm && !root.confirm("Remove the chart \u201c" + name + "\u201d from the song?")) return;
      st.edit("Remove chart", ["arrangements"], () => E.projectRemoveArrangement(p, p.arrangements[lane.arr].id));
      st.clearSelection(null); st.renderCard(); return;
    }
    if (a === "addarr") {
      const kind = st.add_kind || "lead", tun = RSC.TUNINGS[st.add_tuning || "E standard"];
      st.edit("Add chart", ["arrangements"], () => E.projectAddArrangement(p, kind, tun));
      st.selectLane("arr:" + (p.arrangements.length - 1)); st.insTab = "edit"; st.renderInspector(); st.renderCard();
      return;
    }
    if (a.startsWith("selarr:")) { st.insTab = "edit"; st.selectLane("arr:" + a.slice(7)); return; }
    if (a.startsWith("mute:") || a.startsWith("solo:")) {
      const id = a.slice(5), l = st.audio.lanes[id] || {};
      st.audio.setLane(id, a.startsWith("mute:") ? { mute: !l.mute } : { solo: !l.solo });
      st.renderInspector(); st.renderHeads(); st.draw(); return;
    }
    if (a.startsWith("dlstem:")) { RSC.downloadStem(st, a.slice(7)); return; }
    if (a.startsWith("dd:")) { RSC.levelAct(st, a); return; }
    if (a === "tuner:open") { RSC.tuner.open(st); return; }
    if (a === "fill:draft" && lane && lane.kind === "arr") { RSC.fill.draft(st, lane.arr); return; }
    if (a.startsWith("lyr:") || a.startsWith("stems:") || a.startsWith("beats:")) { RSC.toolAct(st, a, b); return; }
  };
})(typeof window !== "undefined" ? window : globalThis);
