/* ---------------------------------------------------------------------------
 * rsc-tools.js -- the studio's longer operations: lyrics (import, online
 * lookup, auto-sync, tap-sync, stretch), stems (separation in a Web Worker,
 * downloads), the beat grid (detection, tempo, bars), shifting a whole chart,
 * album art, and downloads.
 *
 * Lyrics reuse RockShiny's karaoke-sync.js (RSKaraoke): its LRC parser, its
 * syllable splitter and timing model, its LRCLIB lookup and its aligner.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator, E = RSC.engine, D = RSC.dsp;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const K = () => root.RSKaraoke;

  /** Save bytes as a file (a Blob download). */
  RSC.download = function (bytes, name, mime) {
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  };

  // ---- lyrics -----------------------------------------------------------------------------------
  /**
   * LRC / plain text -> Rocksmith syllables [{time, length, lyric, note}] ("-" joins a
   * word's syllables, "+" ends a line). Plain lines get a first guess spread over the
   * song (then Tap-sync or Stretch place them).
   */
  RSC.lyricsToSyllables = function (text, duration) {
    const k = K();
    if (!k) throw new Error("The lyrics tools are not loaded (karaoke-sync.js).");
    const P = k.parseLRC(text);
    let v;
    if (P.synced === "none") {
      const lines = P.lines.filter((l) => l.text);
      const a = Math.max(5, duration * 0.08), b = Math.max(a + lines.length * 2, duration * 0.92), step = (b - a) / Math.max(1, lines.length);
      P.lines = lines.map((l, i) => ({ t: a + i * step, text: l.text, words: null }));
      P.synced = "guess";
    }
    v = k.vocalsFromLRC(P);
    const out = [];
    for (let i = 0; i < v.t.length; i++) {
      const lineEnd = i + 1 >= v.t.length || v.l[i + 1] !== v.l[i];
      out.push({ time: r3(v.t[i]), length: r3(Math.max(0.05, v.d[i])), lyric: v.w[i] + (lineEnd ? "+" : v.j[i] ? "-" : ""), note: 254 });
    }
    return { syllables: out, synced: P.synced, lines: P.lines.length };
  };
  function setLyrics(st, syl, info) {
    const p = st.project;
    st.edit("Lyrics", ["vocals"], () => {
      if (!p.vocals) p.vocals = { id: null, syllables: [], origin: null, persistentId: null, edited: true };
      p.vocals.syllables = syl;
    });
    st.lyricsInfo = info;
    st.renderHeads(); st.renderInspector();
    st.toast(syl.length + " syllables");
  }
  RSC.importLyrics = function (st, text, source) {
    const r = RSC.lyricsToSyllables(text, st.duration());
    if (!r.syllables.length) { st.toast("No lyrics found in that text", "error"); return; }
    setLyrics(st, r.syllables, (source || "Imported") + ": " + r.lines + " lines, " +
      (r.synced === "word" ? "timed per word" : r.synced === "line" ? "timed per line (syllables estimated)" : "no timing yet \u2014 use Tap-sync or Stretch") + ".");
    st.lyricsSynced = r.synced;
  };
  /** Lines of the current lyrics: [{start, words: [{w, j}], idx: [syllable indices]}] */
  function lyricLines(st) {
    const S = st.project.vocals ? st.project.vocals.syllables : [], lines = [];
    let cur = null;
    S.forEach((s, i) => {
      if (!cur) { cur = { start: s.time, words: [], idx: [] }; lines.push(cur); }
      cur.words.push({ w: s.lyric.replace(/[+-]$/, ""), j: /-$/.test(s.lyric) ? 1 : 0 });
      cur.idx.push(i);
      if (/\+$/.test(s.lyric)) cur = null;
    });
    return lines;
  }
  function shiftLyrics(st, fn, label) {
    const p = st.project;
    if (!p.vocals || !p.vocals.syllables.length) return;
    st.edit(label, ["vocals"], () => { for (const s of p.vocals.syllables) s.time = Math.max(0, r3(fn(s.time))); p.vocals.syllables.sort((a, b) => a.time - b.time); });
  }

  async function lyricsOnline(st) {
    const m = st.project.meta, q = { artist: m.artist, title: m.title, album: m.album, duration: st.audio.duration || m.songLength };
    st.busy("Looking up the lyrics\u2026", (m.artist || "") + " \u2014 " + (m.title || "") + " on lrclib.net");
    try {
      let res = null;
      if (st.host.fetchLyrics) res = await st.host.fetchLyrics(q);
      else if (K() && K().lookupLRCLIB) res = await K().lookupLRCLIB(q);
      if (res && res.offline) { st.toast("LRCLIB could not be reached (offline?). Import a .lrc or paste the lyrics.", "error", 5000); return; }
      if (!res || !res.lrc) { st.toast("No lyrics found online for this song.", "error", 4000); return; }
      RSC.importLyrics(st, res.lrc, "LRCLIB");
      if (res.synced !== "none" && st.audio.mix) await autoSync(st, res.lrcDuration);
    } catch (e) { st.toast("Lyrics lookup failed: " + e.message, "error", 5000); }
    finally { st.busy(null); }
  }
  // ---- where the voice sings (rsc-voice.js), in a Worker when there is one ----------------------------
  function voiceWorker() {
    const f = RSC.factories;
    if (!f || !f.dsp || !f.voice || typeof Worker === "undefined") return null;
    const src = "self.RSCreator = {};\n(" + f.dsp.toString() + ")(self);\n(" + f.voice.toString() + ")(self);\n" +
      "self.onmessage = async (e) => { try { const r = await self.RSCreator.voice.activity(e.data.channels, e.data.sr, { onProgress: (p) => self.postMessage({ progress: p }) });" +
      " self.postMessage({ done: r }, [r.p.buffer]); } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };";
    try { return new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))); } catch (e) { return null; }
  }
  /** p(voice) of the song's recording, 100 frames/s (computed once per recording). */
  RSC.voiceActivity = async function (st) {
    const a = st.audio;
    if (!a.mix) throw new Error("Needs the song's audio.");
    if (st.voice && st.voice.mix === a.mix) return st.voice;
    const chs = a.channels(), sr = a.sr;
    let r = null;
    const w = voiceWorker();
    if (w) {
      r = await new Promise((resolve) => {
        w.onmessage = (e) => {
          if (e.data.progress != null) st.busy("Listening for the voice\u2026", "The voice's frequencies, its silences and sung phrases", e.data.progress);
          else { w.terminate(); resolve(e.data.done || null); }
        };
        w.onerror = () => { w.terminate(); resolve(null); };
        w.postMessage({ channels: chs.map((c) => c.slice()), sr });
      });
    }
    if (!r) r = await RSC.voice.activity(chs, sr, { onProgress: (p) => st.busy("Listening for the voice\u2026", "The voice's frequencies, its silences and sung phrases", p) });
    st.voice = { mix: a.mix, p: r.p, fps: r.fps, segments: RSC.voice.segments(r.p) };
    return st.voice;
  };

  /**
   * Auto-sync, one shift for all the lyrics (lyrics timed on this recording, e.g.
   * LRCLIB). Two detectors: the voice model (rsc-voice.js: where the voice's
   * frequencies sing, centre channel, syllable rhythm) lays the syllables over
   * the sung phrases; RockShiny's onset aligner (karaoke-sync.js) does it its own
   * way. They agree on most songs, and the voice model is then the more precise;
   * when they are more than 0.8 s apart (a voice the model does not hear well),
   * the onset aligner is taken -- unless its result puts the syllables clearly
   * less on the singing (p(voice) coverage 0.1 lower: an onset search fooled by
   * a steady beat, as on the synthetic demo song). Measured on 11 songs (lyrics shifted by up to
   * 2.5 s, each song scored by a model trained without it): median line error
   * 0.08 s, 75 % of lines within 0.3 s, 92 % within 0.5 s, worst 0.72 s (the
   * onset aligner alone: 0.30 s, 48 %, 84 %).
   */
  async function autoSync(st, lrcDuration) {
    const k = K(), lines = lyricLines(st), S = st.project.vocals ? st.project.vocals.syllables : [];
    if (!st.audio.mix) { st.toast("Needs the song's audio.", "error"); return; }
    if (!S.length) { st.toast("Add lyrics first.", "error"); return; }
    st.busy("Syncing the lyrics to the recording\u2026", "Listening for the voice");
    try {
      await E.tick();
      const dur = st.audio.duration, maxLag = Math.max(4, lrcDuration ? Math.abs(dur - lrcDuration) + 2 : 4);
      const v = await RSC.voiceActivity(st), ev = RSC.voice.evidence(v.p);
      st.busy("Syncing the lyrics to the recording\u2026", "Laying the lines over the sung phrases");
      await E.tick();
      const g = RSC.voice.alignGlobal(RSC.voice.linesOf(S), ev, { maxLag });
      let shift = g.shift, how = "voice";
      if (k && lines.length >= 8) {
        const pr = RSC.sync.presence(st.audio.channels(), st.audio.sr);
        const coarse = RSC.sync.activityLag(S, pr, maxLag, 0);
        const r = await k.alignLRC(st.audio.mix, lines.map((l) => ({ start: l.start + coarse, words: l.words })), { audioDuration: dur, lrcDuration: 0, window: 0.8, margin: 0 });
        const onset = coarse + r.offset;
        // they disagree: the onsets, unless they put the syllables clearly less on the singing than the voice does
        // (an onset search fooled by a steady beat; on the sample songs the two cover the singing within 0.05)
        if (Math.abs(onset - shift) > 0.8 && RSC.voice.coverage(S, v.p, onset) >= RSC.voice.coverage(S, v.p, shift) - 0.1) { shift = onset; how = "onsets"; }
      }
      shift = Math.round(shift * 1000) / 1000;
      if (Math.abs(shift) >= 0.01) shiftLyrics(st, (t) => t + shift, "Auto-sync");
      st.showVoice = true; st.buildLanes();
      st.lyricsInfo = "Auto-sync moved the lyrics by " + (shift >= 0 ? "+" : "") + shift.toFixed(2) + " s (" +
        (how === "voice" ? "where the voice sings" : "on the vocal onsets: the voice was hard to hear") + "). Typically within 0.1\u20130.3 s: check a line or two; " +
        "if single lines are off (lyrics of another take), use \u201cSync each line\u201d.";
      st.toast(st.lyricsInfo, null, 5000);
      st.draw(); st.renderInspector();
    } finally { st.busy(null); }
  }
  /**
   * Sync each line (lyrics of another take, or timed roughly): a shift and a small
   * drift for the whole, then every line moved on its own within +-1 s onto the
   * sung phrases (lines keep their order). Measured (11 songs, models trained
   * without the song): lines timed roughly (+-0.8 s) median error 0.35 s (one
   * shift: 0.51 s); another take 0.5 % slower: 0.28 s (0.38 s). For lyrics timed
   * on this recording, Auto-sync (one shift) is the better choice.
   */
  async function syncLines(st) {
    const S = st.project.vocals ? st.project.vocals.syllables : [];
    if (!st.audio.mix) { st.toast("Needs the song's audio.", "error"); return; }
    if (!S.length) { st.toast("Add lyrics first.", "error"); return; }
    st.busy("Syncing each line\u2026", "Listening for the voice");
    try {
      await E.tick();
      const v = await RSC.voiceActivity(st), ev = RSC.voice.evidence(v.p), L = RSC.voice.linesOf(S);
      st.busy("Syncing each line\u2026", "Each line onto its sung phrase");
      await E.tick();
      const r = RSC.voice.alignLines(L, ev, { maxLag: 4 });
      const lineOf = RSC.sync.lineIndex(S);
      st.edit("Sync each line", ["vocals"], () => { st.project.vocals.syllables = RSC.sync.retime(S, lineOf, r.starts); });
      const moved = r.starts.map((t, i) => Math.abs(t - L[i].start)), med = moved.slice().sort((x, y) => x - y)[moved.length >> 1] || 0;
      st.showVoice = true; st.buildLanes();
      st.lyricsInfo = "Each line synced: the lyrics moved by " + (r.shift >= 0 ? "+" : "") + r.shift.toFixed(2) + " s" +
        (Math.abs(r.drift - 1) > 1e-6 ? " with a " + ((r.drift - 1) * 100).toFixed(1) + " % stretch" : "") + ", lines by a median " + med.toFixed(2) + " s. Check the lines; Tap-sync or drag any that are off.";
      st.toast(st.lyricsInfo, null, 5000);
      st.draw(); st.renderInspector();
    } finally { st.busy(null); }
  }
  /** Show (or hide) where the voice sings, under the lyrics. */
  async function toggleVoice(st) {
    if (st.showVoice) { st.showVoice = false; st.buildLanes(); st.draw(); st.renderInspector(); return; }
    try { await RSC.voiceActivity(st); st.showVoice = true; st.buildLanes(); } catch (e) { st.toast(e.message, "error"); } finally { st.busy(null); }
    st.draw(); st.renderInspector();
  }
  /** Tap-sync: each tap sets the start of the next line (its syllables move with it). */
  RSC.tapLine = function (st) {
    const p = st.project, lines = lyricLines(st);
    const k = st.tapLine || 0;
    if (k >= lines.length) { st.tapping = false; st.renderInspector(); return; }
    const t = Math.max(0, st.audio.time() - 0.06), L = lines[k], d = t - L.start;
    st.edit("Tap line " + (k + 1), ["vocals"], () => {
      const S = p.vocals.syllables;
      for (const i of L.idx) S[i].time = r3(S[i].time + d);
      // later lines that now overlap move along
      for (let j = k + 1; j < lines.length; j++) {
        const first = S[lines[j].idx[0]];
        const lastPrev = S[lines[j - 1].idx[lines[j - 1].idx.length - 1]];
        if (first.time < lastPrev.time + 0.1) { const dd = lastPrev.time + 0.1 - first.time; for (const i of lines[j].idx) S[i].time = r3(S[i].time + dd); } else break;
      }
    });
    st.tapLine = k + 1;
    const nxt = lyricLines(st)[k + 1];
    st.tapText = nxt ? nxt.words.map((w) => w.w + (w.j ? "" : " ")).join("").trim() : "";
    if (!nxt) { st.tapping = false; st.toast("All lines tapped"); }
    st.renderInspector();
  };

  // ---- stems ------------------------------------------------------------------------------------------
  function stemWorker() {
    const f = RSC.factories;
    if (!f || !f.dsp || !f.stems || typeof Worker === "undefined") return null;
    const src = "self.RSCreator = {};\n(" + f.dsp.toString() + ")(self);\n(" + f.stems.toString() + ")(self);\n" +
      "self.onmessage = async (e) => { const m = e.data; try { const r = await self.RSCreator.stems.separate(m.channels, m.sr, m.guide, Object.assign(m.opts, { onProgress: (p) => self.postMessage({ progress: p }) }));" +
      " const tr = []; for (const id of r.ids) for (const a of r.stems[id]) tr.push(a.buffer); self.postMessage({ done: r }, tr); } catch (err) { self.postMessage({ error: String(err && err.message || err) }); } };";
    try { return new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" }))); } catch (e) { return null; }
  }
  async function runStems(st) {
    const a = st.audio;
    if (!a.mix) { st.toast("Needs the song's audio.", "error"); return; }
    const guide = RSC.stems.guideFromProject(st.project);
    const chs = a.channels(), sr = a.sr;
    let range = null;
    if (a.loop.b > a.loop.a + 1 && (a.loop.on || a.duration > 720)) range = [a.loop.a, a.loop.b];
    else if (a.duration > 720) range = [0, 720];
    const t0 = performance.now();
    st.stemsProgress = 0; st.renderInspector();
    const progress = (f) => { st.stemsProgress = f; st.busy("Separating the stems\u2026", "Guided by " + guide.guitar.length + " guitar, " + guide.bass.length + " bass notes and " + guide.lyrics.length + " syllables", f); const bar = st.insp.querySelector(".rsc-progress > i"); if (bar) bar.style.width = (100 * f).toFixed(1) + "%"; };
    progress(0);
    let res = null;
    try {
      const w = stemWorker();
      if (w) {
        res = await new Promise((resolve, reject) => {
          w.onmessage = (e) => { if (e.data.progress != null) progress(e.data.progress); if (e.data.done) resolve(e.data.done); if (e.data.error) reject(new Error(e.data.error)); };
          w.onerror = (e) => reject(new Error(e.message || "worker failed"));
          const L = chs[0].slice(), R = (chs[1] || chs[0]).slice();
          w.postMessage({ channels: [L, R], sr, guide, opts: { range } }, [L.buffer, R.buffer]);
        });
        w.terminate();
      } else res = await RSC.stems.separate(chs, sr, guide, { range, onProgress: progress });
      a.setStems(res);
      st.stemsInfo = res;
      st.toast("Stems ready in " + ((performance.now() - t0) / 1000).toFixed(1) + " s");
      st.emit("stems", res);
    } catch (e) { st.toast("Separation failed: " + e.message, "error", 6000); }
    finally { st.stemsProgress = null; st.busy(null); st.renderInspector(); st.renderCard(); }
  }
  RSC.stemWav = function (st, id) {
    const s = st.audio.stems;
    if (!s || !s.stems[id]) return null;
    return D.wavBytes(RSC.stems.toFloat(s.stems[id]), s.sr);
  };
  RSC.downloadStem = function (st, id) {
    const w = RSC.stemWav(st, id);
    if (!w) return;
    const base = (st.project.meta.artist + " - " + st.project.meta.title).replace(/[\\/:*?"<>|]+/g, "_");
    RSC.download(w, base + " (" + id + ").wav", "audio/wav");
  };

  // ---- beats --------------------------------------------------------------------------------------------
  function shiftAll(p, d) {
    const sh = (t) => Math.max(0, r3(t + d));
    for (const b of p.beats) b.time = sh(b.time);
    for (const s of p.sections) s.startTime = sh(s.startTime);
    for (const a of p.arrangements) {
      const doc = a.doc;
      const shiftLevel = (lv) => {
        for (const n of lv.notes) { n.time = sh(n.time); for (const b of n.bendValues || []) b.time = sh(b.time); }
        for (const c of lv.chords) { c.time = sh(c.time); for (const q of c.chordNotes || []) { q.time = c.time; for (const b of q.bendValues || []) b.time = sh(b.time); } }
        for (const x of lv.anchors) x.time = sh(x.time);
        for (const h of lv.handShapes) { h.startTime = sh(h.startTime); h.endTime = sh(h.endTime); }
        for (const x of lv.fretHandMutes || []) x.time = sh(x.time);
      };
      // every difficulty level moves with its phrases (the view alone for a chart with one level)
      if (a.dd) { E.ddCommit(a); a.dd.levels.forEach(shiftLevel); } else shiftLevel(doc.levels[0]);
      for (const it of doc.phraseIterations) if (it.time > 0) it.time = sh(it.time);
      if (a.dd) doc.levels[0] = E.ddExtract(a.dd.levels, doc, a.dd.view);
      for (const e of doc.events) e.time = sh(e.time);
      for (const t of doc.tones || []) t.time = sh(t.time);
      doc.sections = JSON.parse(JSON.stringify(p.sections));
      a.edited = true;
    }
    if (p.vocals) for (const s of p.vocals.syllables) s.time = sh(s.time);
  }
  RSC.shiftAll = shiftAll;

  RSC.toolAct = async function (st, a, b) {
    const p = st.project;
    const [grp, what, arg] = a.split(":");
    if (grp === "lyr") {
      if (what === "online") return lyricsOnline(st);
      if (what === "paste") { const t = st.insp.querySelector('[data-role="paste"]'); if (t && t.value.trim()) RSC.importLyrics(st, t.value, "Pasted"); return; }
      if (what === "auto") return autoSync(st);
      if (what === "lines") return syncLines(st);
      if (what === "voice") return toggleVoice(st);
      if (what === "tap") {
        st.tapping = !st.tapping;
        if (st.tapping) {
          const lines = lyricLines(st);
          if (!lines.length) { st.tapping = false; st.toast("Add lyrics first", "error"); return; }
          st.tapLine = 0; st.tapText = lines[0].words.map((w) => w.w + (w.j ? "" : " ")).join("").trim();
          if (!st.audio.playing) st.audio.play(Math.max(0, lines[0].start - 4));
          st.root.focus({ preventScroll: true });
          st.toast("Press T at the start of each line");
        }
        st.renderInspector(); return;
      }
      if (what === "shift") { const d = +arg; const sel = st.sel.kind === "syl" && st.sel.items.length ? new Set(st.sel.items) : null; shiftLyrics(st, (t) => t + d, "Shift lyrics"); void sel; return; }
      if (what === "first") { const L = lyricLines(st); if (!L.length) return; const d = st.audio.time() - L[0].start; shiftLyrics(st, (t) => t + d, "First line to playhead"); return; }
      if (what === "last") {
        const L = lyricLines(st); if (L.length < 2) return;
        const a0 = L[0].start, a1 = L[L.length - 1].start, b1 = st.audio.time();
        if (b1 <= a0 + 1) { st.toast("Put the playhead where the last line is sung (after the first line)", "error"); return; }
        const fit = RSC.sync.fitDrift([[a0, a0], [a1, b1]]);
        shiftLyrics(st, (t) => fit.a * t + fit.b, "Stretch lyrics");
        st.toast("Stretched by " + ((fit.a - 1) * 100).toFixed(2) + " %");
        return;
      }
      if (what === "clear") { if (root.confirm && !root.confirm("Remove all the lyrics?")) return; st.edit("Remove lyrics", ["vocals"], () => { p.vocals.syllables = []; }); st.renderInspector(); return; }
    }
    if (grp === "stems") {
      if (what === "run") return runStems(st);
      if (what === "all") { for (const id of st.audio.stems.ids) { RSC.downloadStem(st, id); await new Promise((r) => setTimeout(r, 400)); } return; }
      if (what === "save" && st.host.saveStems) {
        st.busy("Saving the stems\u2026", "To the song's folder");
        try { const files = st.audio.stems.ids.map((id) => ({ id, bytes: RSC.stemWav(st, id) })); const msg = await st.host.saveStems(files, st.project); st.toast(msg || "Stems saved"); }
        catch (e) { st.toast("Could not save the stems: " + e.message, "error"); }
        finally { st.busy(null); }
        return;
      }
    }
    if (grp === "beats") {
      if (what === "detect") {
        if (!st.audio.mix) { st.toast("Needs the song's audio.", "error"); return; }
        st.busy("Finding the beats\u2026", "Onsets, tempo, bars");
        await E.tick();
        try {
          const r = RSC.beats.track(st.audio.channels(), st.audio.sr, { bpm: st.beatHint || undefined, beatsPerBar: st.perBar || 4 });
          if (!r.grid.length) { st.toast("No steady beat found; set the tempo by hand.", "error"); return; }
          st.edit("Detect beats", ["beats"], () => { p.beats = r.grid; });
          p.meta.averageTempo = r.bpm;
          st.toast("Beats: " + r.bpm.toFixed(1) + " BPM (confidence " + r.confidence + "). Check the bar lines; \u00d72 / \u00f72 if the tempo is an octave off.", null, 5000);
        } finally { st.busy(null); st.renderInspector(); }
        return;
      }
      if (what === "double") {
        st.edit("Double tempo", ["beats"], () => {
          const B = p.beats, out = [];
          B.forEach((b, i) => { out.push(b); if (i + 1 < B.length) out.push({ time: r3((b.time + B[i + 1].time) / 2), measure: -1 }); });
          p.beats = out; RSC.renumberMeasures(p.beats);
        });
        return;
      }
      if (what === "half") {
        st.edit("Half tempo", ["beats"], () => {
          const B = p.beats, first = Math.max(0, B.findIndex((b) => b.measure >= 0));
          p.beats = B.filter((b, i) => (i - first) % 2 === 0 || b.measure >= 0);
          RSC.renumberMeasures(p.beats);
        });
        return;
      }
      if (what === "barhere") {
        const t = st.audio.time(), B = p.beats;
        let i = 0, bd = Infinity;
        B.forEach((b, k) => { const d = Math.abs(b.time - t); if (d < bd) { bd = d; i = k; } });
        st.edit("Bar start", ["beats"], () => {
          const per = st.perBar || 4;
          for (let k = 0; k < B.length; k++) B[k].measure = ((k - i) % per + per) % per === 0 ? 0 : -1;
          RSC.renumberMeasures(B);
        });
        return;
      }
      if (what === "const") {
        const bpm = st.constBpm || (p.beats.length > 1 ? E.averageTempo(p.beats) : 120), first = st.constFirst != null ? st.constFirst : p.beats.length ? p.beats[0].time : 0;
        st.edit("Constant tempo", ["beats"], () => { p.beats = E.beatsFromTempo(bpm, first, st.duration(), st.perBar || 4); });
        return;
      }
      if (what === "tap") {
        const now = performance.now();
        st._taps = (st._taps || []).filter((x) => now - x < 3000).concat(now);
        if (st._taps.length >= 3) {
          const iv = st._taps.slice(1).map((x, i) => x - st._taps[i]).sort((x, y) => x - y);
          st.tapTempo = 60000 / iv[iv.length >> 1]; st.constBpm = Math.round(st.tapTempo * 100) / 100;
        }
        st.renderInspector(); return;
      }
      if (what === "shift") {
        const d = st.shiftBy;
        if (!d) { st.toast("Type how far to move (seconds; negative = earlier)", "error"); return; }
        st.edit("Shift the chart", ["beats", "sections", "vocals"].concat(p.arrangements.map((x, i) => "chart:" + i)), () => shiftAll(p, d));
        st.toast("Moved everything by " + (d >= 0 ? "+" : "") + d + " s");
        return;
      }
    }
  };

  // ---- files dropped into the inspector -----------------------------------------------------------------
  RSC.fileAction = async function (st, kind, file) {
    if (kind === "lyrics") { RSC.importLyrics(st, await file.text(), file.name); return; }
    if (kind === "art") {
      try {
        const bmp = await createImageBitmap(file);
        const cv = document.createElement("canvas"); cv.width = bmp.width; cv.height = bmp.height;
        const g = cv.getContext("2d"); g.drawImage(bmp, 0, 0);
        const img = g.getImageData(0, 0, bmp.width, bmp.height);
        E.projectSetArt(st.project, st.source, img.data, bmp.width, bmp.height);
        st._artKey = null; st.dirty = true; st.renderCard(); st.emit("change", { what: ["art"] });
        st.toast("Album art set");
      } catch (e) { st.toast("Could not read that image: " + e.message, "error"); }
    }
  };

  /** Decode any browser-playable audio file (new songs): -> AudioBuffer */
  RSC.decodeAudioFile = async function (st, bytes) {
    const ctx = st.audio.ensureCtx();
    return ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  };

  /**
   * A new song from an audio file: beats detected (or a given tempo), the charts asked
   * for, the audio stored as 16-bit PCM .wem. opts as E.projectNew, plus {file: bytes} or
   * {wem: bytes}; {detectBeats: true}.
   */
  /** "Night Drive": the demo song made from scratch (engine/rsc-demo.js), opened like any song. */
  RSC.openDemo = async function (st) {
    st.busy("Making the demo song\u2026", "An original song, played from its own charts");
    try {
      await E.tick();
      const made = await E.demoSong({ platform: (st.host && st.host.platform) || "pc" });
      st.fileName = null;
      await st.open(made);
      st.dirty = true; st.renderCard();
      st.toast("Night Drive: a song made from scratch \u2014 its charts, lyrics and audio. Try anything on it; save it like any song.", null, 5500);
      return made;
    } finally { st.busy(null); }
  };

  RSC.newSong = async function (st, opts) {
    st.busy("Creating the song\u2026", "Decoding the audio");
    try {
      let buf = null, audio;
      if (opts.wem) {
        audio = { wem: opts.wem };
        const play = E.wemToPlayable(opts.wem);
        buf = await RSC.decodeAudioFile(st, play.bytes);
      } else {
        buf = await RSC.decodeAudioFile(st, opts.file);
        const sr = buf.sampleRate >= 44100 ? buf.sampleRate : 48000;
        const chs = [];
        for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
        if (chs.length === 1) chs.push(chs[0]);
        audio = { channels: chs, sampleRate: buf.sampleRate || sr };
      }
      let beats = null, bpm = opts.bpm;
      if (opts.detectBeats !== false && !opts.bpm) {
        st.busy("Creating the song\u2026", "Finding the beats");
        await E.tick();
        const chs = [];
        for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
        const r = RSC.beats.track(chs, buf.sampleRate, { beatsPerBar: opts.beatsPerBar || 4 });
        if (r.grid.length) { beats = r.grid; bpm = r.bpm; }
      }
      st.busy("Creating the song\u2026", "Building the package");
      const made = await E.projectNew(Object.assign({}, opts, { audio, beats: beats || undefined, bpm: bpm || 120 }));
      await st.open(made, { audioBuffer: buf });
      st.dirty = true; st.renderCard();
      // optional: rough drafts of the rhythm and bass charts from the recording (lead: the tuner)
      if (opts.draft && RSC.fill) {
        const ok = root.confirm; root.confirm = null;
        try {
          for (let i = 0; i < st.project.arrangements.length; i++) {
            const k = st.project.arrangements[i].kind;
            if (k === "rhythm" || k === "bass" || k === "combo") await RSC.fill.draft(st, i);
          }
        } finally { root.confirm = ok; }
      }
      return made;
    } finally { st.busy(null); }
  };
})(typeof window !== "undefined" ? window : globalThis);
