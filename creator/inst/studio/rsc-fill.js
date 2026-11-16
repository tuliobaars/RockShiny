/* ---------------------------------------------------------------------------
 * rsc-fill.js -- filling a chart by ear.
 *
 *   RSC.fill.draft(st, arrIndex)   a draft from the recording: the chords of a
 *                                  6-string chart, the bass line of a bass chart
 *                                  (engine/rsc-transcribe.js; rough: to correct)
 *   RSC.tuner.open(st)             the tuner: play your guitar or bass into the
 *                                  microphone (or a line input); it shows the note
 *                                  (and how many cents off) or the chord, and
 *                                  writes what you play into the selected chart:
 *                                    Step   each note / chord at the playhead, then the
 *                                           playhead moves on by the grid
 *                                    Record while the song plays, at the time you play
 *                                           (the input's latency taken off)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator, E = RSC.engine, esc = RSC.esc;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const T = () => RSC.transcribe;

  function arrInfo(st, i) {
    const a = st.project.arrangements[i], bass = a.kind === "bass", strings = bass ? 4 : 6;
    return { a, bass, strings, open: T().openStrings(a.doc.tuning, strings, bass, a.doc.capo || 0) };
  }

  // ---- the analysis of the recording (once per recording), in a Worker when there is one --------------------
  function worker() {
    const f = RSC.factories;
    if (!f || !f.dsp || !f.voice || !f.transcribe || typeof Worker === "undefined") return null;
    const src = "self.RSCreator = {};\n(" + f.dsp.toString() + ")(self);\n(" + f.voice.toString() + ")(self);\n(" + f.transcribe.toString() + ")(self);\n" +
      "self.onmessage = async (e) => { try { const r = await self.RSCreator.transcribe.analyse(e.data.channels, e.data.sr, { onProgress: (p) => self.postMessage({ progress: p }) });" +
      " self.postMessage({ done: r }, [r.chroma.buffer, r.bass.buffer]); } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };";
    try { return new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))); } catch (e) { return null; }
  }
  async function analysis(st) {
    const au = st.audio;
    if (!au.mix) throw new Error("Needs the song's audio.");
    if (st._analysis && st._analysis.mix === au.mix) return st._analysis.r;
    const chs = au.channels(), sr = au.sr, msg = "The notes of the recording: chroma and bass";
    let r = null;
    const w = worker();
    if (w) {
      r = await new Promise((resolve) => {
        w.onmessage = (e) => { if (e.data.progress != null) st.busy("Listening to the recording\u2026", msg, e.data.progress); else { w.terminate(); resolve(e.data.done || null); } };
        w.onerror = () => { w.terminate(); resolve(null); };
        w.postMessage({ channels: chs.map((c) => c.slice()), sr });
      });
    }
    if (!r) r = await T().analyse(chs, sr, { onProgress: (p) => st.busy("Listening to the recording\u2026", msg, p) });
    st._analysis = { mix: au.mix, r };
    return r;
  }

  // ---- writing into a chart ---------------------------------------------------------------------------------
  /** A chord event of a template (frets), every fretted string sounding, sustain on its strings. */
  function chordEvent(doc, time, frets, name, sustain, repeat) {
    const chordId = RSC.templateFor(doc, frets, frets.map(() => -1), name);
    const chordNotes = [];
    frets.forEach((f, s) => { if (f >= 0) chordNotes.push(Object.assign({}, E.NOTE_DEFAULTS, { time, string: s, fret: f, sustain: r3(sustain || 0), bendValues: [] })); });
    return { time: r3(time), linkNext: 0, accent: 0, chordId, fretHandMute: 0, highDensity: repeat ? 1 : 0, ignore: 0, palmMute: 0, hopo: 0, strum: "down", chordNotes };
  }
  /** Remove a chart's notes and chords between t0 and t1. */
  function clearRange(lv, t0, t1) {
    lv.notes = lv.notes.filter((n) => n.time < t0 || n.time >= t1);
    lv.chords = lv.chords.filter((c) => c.time < t0 || c.time >= t1);
  }

  /**
   * A draft from the recording into chart i (over the loop range if one is set,
   * else the whole song): chords on every beat for a 6-string chart, the bass line
   * for a bass chart. Replaces what the chart has there (undo brings it back).
   */
  async function draft(st, i) {
    const p = st.project, { a, bass, open } = arrInfo(st, i);
    if (!p.beats || p.beats.length < 4) { st.toast("The song needs a beat grid first (Beats tab)", "error"); return; }
    const loop = st.audio.loop && st.audio.loop.on ? [st.audio.loop.a, st.audio.loop.b] : [0, Infinity];
    const lv = a.doc.levels[0], had = lv.notes.concat(lv.chords).filter((x) => x.time >= loop[0] && x.time < loop[1]).length;
    if (had && root.confirm && !root.confirm("Replace the " + had + " notes and chords of " + a.name + (loop[1] < Infinity ? " in the loop range" : "") + " with a draft from the recording?")) return;
    st.busy("Listening to the recording\u2026", "The notes of the recording", 0);
    try {
      const an = await analysis(st);
      const chords = T().chordsOnBeats(an, p.beats).filter((c) => c.time >= loop[0] && c.time < loop[1]);
      st.edit(bass ? "Draft bass line" : "Draft chords", ["arr:" + i], () => {
        clearRange(lv, loop[0], loop[1]);
        if (bass) {
          const notes = T().bassFromChords(an, chords), pos = T().placeNotes(notes.map((n) => n.midi), open, { maxFret: 12, home: 3 });
          notes.forEach((n, k) => lv.notes.push(Object.assign({}, E.NOTE_DEFAULTS, { time: r3(n.time), string: pos[k].string, fret: pos[k].fret, sustain: r3(n.sustain > 0.3 ? n.sustain : 0), bendValues: [] })));
        } else {
          const shapes = new Map();
          chords.forEach((c, k) => {
            const key = c.root + c.quality;
            if (!shapes.has(key)) shapes.set(key, T().chordShape(c.root, c.quality, open));
            const next = chords[k + 1], last = !next || next.name !== c.name, repeat = k > 0 && chords[k - 1].name === c.name;
            lv.chords.push(chordEvent(a.doc, c.time, shapes.get(key), c.name, last ? (c.end - c.time) * 0.9 : 0, repeat));
          });
        }
        RSC.sortLevel(lv);
        if (E.autoAnchors) lv.anchors = E.autoAnchors(a.doc);
      });
      const names = new Set(chords.map((c) => c.name));
      st.toast(a.name + ": " + (bass ? chords.length + " bass notes" : chords.length + " chords (" + [...names].slice(0, 6).join(", ") + (names.size > 6 ? "\u2026" : "") + ")") +
        " drafted from the recording. A rough draft: check it by ear (the headphones button plays the chart) and fix what is off.", null, 6500);
      st.renderHeads(); st.refreshGuides(); st.draw(); st.renderInspector();
    } catch (e) { st.toast(e.message, "error"); } finally { st.busy(null); }
  }
  RSC.fill = { draft, analysis };

  // ---- the tuner ----------------------------------------------------------------------------------------------
  const TU = (RSC.tuner = RSC.tuner || {});
  let tu = null;
  TU.isOpen = () => !!tu;
  TU._debug = () => tu;                 // (set TU._debug().log = [] to record every look and event)
  TU.state = () => tu && { mode: tu.mode, action: tu.action, note: tu.shown, written: tu.written.slice() };

  /** Open the tuner panel (asks for the microphone). opts.stream: a MediaStream to use instead. */
  TU.open = async function (st, opts) {
    opts = opts || {};
    if (tu) { TU.close(); }
    const lane = (st.lanes || []).find((l) => l.id === st.sel.lane);
    const arrIdx = lane && lane.kind === "arr" ? lane.arr : st.levelArr();
    if (arrIdx == null) { st.toast("Add a chart first", "error"); return; }
    let stream = opts.stream;
    try {
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { st.toast("No microphone: " + e.message + " (allow the microphone for this page)", "error", 6000); return; }
    const Ctx = root.AudioContext || root.webkitAudioContext, ctx = new Ctx();
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch (e) { /* resumed by the next click */ } }
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
    an.fftSize = 8192; an.smoothingTimeConstant = 0;
    src.connect(an);
    const info = arrInfo(st, arrIdx);
    const panel = document.createElement("div");
    panel.className = "rsc-tuner";
    st.root.appendChild(panel);
    tu = {
      st, ctx, an, stream, panel, arrIdx, info, mode: info.bass ? "notes" : (opts.mode || "notes"), action: "step",
      time: new Float32Array(an.fftSize), freq: new Float32Array(an.frequencyBinCount),
      hist: [], cur: null, shown: null, written: [], lastFret: null, timer: null,
      latency: Math.round(((ctx.baseLatency || 0.01) + (ctx.outputLatency || 0.02) + 0.06) * 1000) / 1000, peak: 0
    };
    render();
    panel.addEventListener("click", onClick);
    panel.addEventListener("change", onChange);
    panel.addEventListener("keydown", (e) => e.stopPropagation());
    tu.timer = setInterval(tick, 30);
    st.emit && st.emit("tuner", { open: true });
  };
  TU.close = function () {
    if (!tu) return;
    clearInterval(tu.timer);
    try { tu.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* already stopped */ }
    try { tu.ctx.close(); } catch (e) { /* closed */ }
    tu.panel.remove();
    const st = tu.st;
    tu = null;
    st.emit && st.emit("tuner", { open: false });
  };

  function render() {
    const a = tu.info.a, modeBtn = (m, l) => '<button class="' + (tu.mode === m ? "is-on" : "") + '" data-tu="mode:' + m + '">' + l + "</button>";
    const actBtn = (m, l, t) => '<button class="' + (tu.action === m ? "is-on" : "") + '" data-tu="act:' + m + '" title="' + t + '">' + l + "</button>";
    tu.panel.innerHTML =
      '<div class="rsc-tuner-head"><b>Tuner</b><span>into \u201c' + esc(a.name) + '\u201d</span><button class="rsc-tuner-x" data-tu="close" title="Close the tuner">\u00d7</button></div>' +
      '<div class="rsc-tuner-note"><span data-tu-el="note">\u2013</span><small data-tu-el="hz"></small></div>' +
      '<div class="rsc-tuner-meter"><i data-tu-el="needle"></i><em></em></div>' +
      '<div class="rsc-tuner-row"><span class="rsc-tuner-lbl">Level</span><div class="rsc-tuner-level"><i data-tu-el="level"></i></div></div>' +
      '<div class="rsc-tuner-seg">' + modeBtn("notes", "Notes") + (tu.info.bass ? "" : modeBtn("chords", "Chords")) + "</div>" +
      '<div class="rsc-tuner-seg">' + actBtn("watch", "Just tune", "Show the notes, write nothing") + actBtn("step", "Step", "Each note or chord you play goes at the playhead, then the playhead moves on by the grid") +
        actBtn("record", "Record", "Play along while the song plays: notes go in at the time you play them") + "</div>" +
      '<label class="rsc-tuner-row"><span class="rsc-tuner-lbl">Latency</span><input type="number" step="10" min="0" max="500" value="' + Math.round(tu.latency * 1000) + '" data-tu-in="latency"> ms</label>' +
      '<div class="rsc-tuner-hint" data-tu-el="hint">' + hint() + "</div>";
  }
  function hint() {
    if (tu.action === "watch") return "Play a note: its name and how far off it is (cents).";
    if (tu.action === "step") return "Play a " + (tu.mode === "chords" ? "chord" : "note") + ": it goes in at the playhead, which then moves on by the grid (" + (tu.st.snap ? (tu.st.snap === 1 ? "a beat" : "1/" + tu.st.snap + " beat") : "free") + "). Ctrl+Z takes one back.";
    return "Press Play (Space) and play along: what you play goes in at its time, the latency taken off. Stop when done.";
  }
  function onClick(e) {
    const b = e.target.closest("[data-tu]");
    if (!b) return;
    const [k, v] = b.dataset.tu.split(":");
    if (k === "close") { TU.close(); return; }
    if (k === "mode") tu.mode = v;
    if (k === "act") tu.action = v;
    if (tu.ctx.state === "suspended") tu.ctx.resume();
    render();
  }
  function onChange(e) {
    const i = e.target.closest("[data-tu-in]");
    if (i && i.dataset.tuIn === "latency") tu.latency = Math.max(0, Math.min(0.5, (+i.value || 0) / 1000));
  }

  /** One look at the input (every 30 ms): the note, the chord, and when one starts. */
  function tick() {
    if (!tu) return;
    const { an, ctx } = tu, sr = ctx.sampleRate;
    an.getFloatTimeDomainData(tu.time);
    const frame = tu.time.subarray(tu.time.length - 4096);
    const y = T().yin(frame, sr, { minHz: tu.info.bass ? 35 : 70, maxHz: 1400 });
    tu.peak = Math.max(y.rms, tu.peak * 0.97);
    const loud = y.rms > 0.008;
    let midi = loud && y.hz > 0 && y.clarity > 0.6 ? T().midiOf(y.hz) : null;
    let chord = null;
    if (tu.mode === "chords" && loud) {
      an.getFloatFrequencyData(tu.freq);
      const mag = new Float64Array(tu.freq.length);
      for (let k = 0; k < mag.length; k++) mag[k] = Math.pow(10, tu.freq[k] / 20);
      chord = T().chordOfSpectrum(mag, sr, an.fftSize);
      if (chord && chord.score < 0.7) chord = null;
      // a strum is judged on its sound 120-320 ms after it starts (not the pick's noise, not the decay)
      const since = tu.lastAttack ? performance.now() - tu.lastAttack : Infinity;
      if (since >= 120 && since <= 320) { tu.acc = tu.acc || new Float64Array(mag.length); for (let i = 0; i < mag.length; i++) tu.acc[i] += mag[i]; }
    }
    // a new event: the same note (or chord) for 3 looks in a row, after silence or a different one
    const key = tu.mode === "chords" ? (chord ? chord.name : null) : (midi != null ? Math.round(midi) : null);
    tu.hist.push({ key, rms: y.rms, t: performance.now() });
    if (tu.hist.length > 8) tu.hist.shift();
    const need = 3, lastN = tu.hist.slice(-need), now = performance.now();
    const stable = key != null && lastN.length === need && lastN.every((h) => h.key === key);
    // an attack: much louder than ~90 ms ago (a decaying or held note never is; a new pluck is)
    const attack = tu.hist.length >= 4 && y.rms > 0.008 && y.rms > 1.6 * tu.hist[tu.hist.length - 4].rms;
    if (tu.log) tu.log.push([Math.round(now), key, Math.round(y.rms * 1e4) / 1e4, attack ? 1 : 0]);
    if (attack && (!tu.lastAttack || now - tu.lastAttack > 200)) { tu.lastAttack = now; tu.attackSong = tu.st.audio.time(); tu.acc = null; tu.judged = false; }
    if (tu.mode === "chords") {
      // one chord per strum, judged once its sound has settled
      if (tu.lastAttack && !tu.judged && now - tu.lastAttack > 320 && tu.acc) {
        tu.judged = true;
        const ch = T().chordOfSpectrum(tu.acc, sr, an.fftSize);
        if (ch && ch.score >= 0.7) { tu.cur = { key: ch.name, chord: ch, at: tu.lastAttack, songTime: tu.attackSong }; onEvent(tu.cur); }
      }
    } else if (stable) {
      // a new note: plucked (an attack not used yet), or -- legato, a hammer-on or a slide -- a different note held
      // for 7 looks that is not the one just before it (two ringing strings make the pitch flicker between them)
      // (a pluck's note is judged on the looks after its attack: the looks before it hold the old note)
      let run = 0;
      for (let i = tu.hist.length - 1; i >= 0 && tu.hist[i].key === key && tu.hist[i].t >= (tu.lastAttack || 0); i--) run++;
      const fresh = tu.lastAttack && tu.lastAttack !== tu.usedAttack && now - tu.lastAttack < 500 && run >= need;
      const held = tu.hist.length >= 7 && tu.hist.slice(-7).every((h) => h.key === key);
      const legato = tu.cur && tu.cur.key !== key && held && !(tu.prev && tu.prev.key === key && now - tu.prev.at < 600);
      if (!tu.cur || fresh || legato) {
        if (fresh) tu.usedAttack = tu.lastAttack;
        if (tu.log) tu.log.push(["EVENT", key, fresh, legato]);
        tu.prev = tu.cur;
        tu.cur = { key, midi, chord, at: now, songTime: fresh ? tu.attackSong + 0.09 : tu.st.audio.time() };
        onEvent(tu.cur);
      }
    }
    if (!loud && tu.cur && performance.now() - tu.cur.at > 120) { endEvent(tu.cur); tu.cur = null; }
    show(midi, y, chord);
  }
  function show(midi, y, chord) {
    const q = (s) => tu.panel.querySelector('[data-tu-el="' + s + '"]');
    const lvl = q("level");
    if (lvl) lvl.style.width = Math.min(100, Math.sqrt(y.rms) * 300).toFixed(0) + "%";
    if (tu.mode === "chords") {
      q("note").textContent = chord ? chord.name : "\u2013";
      q("hz").textContent = chord ? "chord \u00b7 " + Math.round(chord.score * 100) + " %" : "";
      q("needle").style.left = "50%";
      tu.shown = chord ? chord.name : null;
      return;
    }
    if (midi == null) { q("note").textContent = "\u2013"; q("hz").textContent = ""; tu.shown = null; return; }
    const m = Math.round(midi), cents = Math.round((midi - m) * 100);
    q("note").textContent = T().noteName(m);
    q("hz").textContent = y.hz.toFixed(1) + " Hz \u00b7 " + (cents >= 0 ? "+" : "") + cents + " cents";
    q("needle").style.left = (50 + cents) + "%";
    q("needle").classList.toggle("is-ok", Math.abs(cents) <= 5);
    tu.shown = T().noteName(m);
  }

  /** A note or chord starts: written into the chart (Step: at the playhead; Record: at the time it was played). */
  function onEvent(ev) {
    const st = tu.st;
    if (tu.action === "watch") return;
    if (tu.action === "record" && !st.audio.playing) return;
    if (tu.action === "step" && st.audio.playing) return;
    const { a, open } = tu.info, lv = a.doc.levels[0];
    const t = tu.action === "step" ? st.snapTime(st.audio.time(), true) : Math.max(0, st.snapTime(ev.songTime - tu.latency - 0.09));
    const key = "arr:" + tu.arrIdx;
    if (tu.mode === "chords" && ev.chord) {
      const frets = T().chordShape(ev.chord.root, ev.chord.quality, open);
      st.edit("Tuner: " + ev.chord.name, [key], () => { lv.chords.push(chordEvent(a.doc, t, frets, ev.chord.name, 0, false)); RSC.sortLevel(lv); });
      ev.written = lv.chords.find((c) => Math.abs(c.time - t) < 1e-6);
      tu.written.push({ time: t, chord: ev.chord.name });
    } else if (ev.midi != null) {
      const m = Math.round(ev.midi);
      // the string and fret nearest the hand's last position
      let best = null;
      open.forEach((o, s) => {
        const f = m - o;
        if (f < 0 || f > 22) return;
        const cost = tu.lastFret == null ? Math.abs(f - 3) * 0.2 + f * 0.01 : (f === 0 ? 0.5 : Math.abs(f - tu.lastFret)) + f * 0.01;
        if (!best || cost < best.cost) best = { s, f, cost };
      });
      if (!best) { st.toast(T().noteName(m) + " is out of this chart's range", "error"); return; }
      if (best.f > 0) tu.lastFret = best.f;
      const n = Object.assign({}, E.NOTE_DEFAULTS, { time: t, string: best.s, fret: best.f, sustain: 0, bendValues: [] });
      st.edit("Tuner: " + T().noteName(m), [key], () => { lv.notes.push(n); RSC.sortLevel(lv); });
      ev.written = n;
      tu.written.push({ time: t, midi: m, string: best.s, fret: best.f });
    }
    ev.writtenAt = t;
    if (tu.action === "step") { const step = st.gridStep(t); st.audio.seek(r3(t + step)); st.centerOn && st.centerOn(t + step); }
    st.renderHeads(); st.draw();
  }
  /** A note ends: in Record mode it gets its sustain (long notes only). */
  function endEvent(ev) {
    if (!tu || tu.action !== "record" || !ev.written || ev.chord) return;
    const dur = (performance.now() - ev.at) / 1000;
    if (dur > 0.35) { ev.written.sustain = r3(dur - 0.1); tu.st.draw(); }
  }
})(typeof window !== "undefined" ? window : globalThis);
