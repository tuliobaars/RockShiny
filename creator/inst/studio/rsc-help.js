/* ---------------------------------------------------------------------------
 * rsc-help.js -- help for RockShiny Creator, inside the app:
 *
 *   RSC.help.open(studio, section)   the Help dialog: Start, What it can do,
 *                                    What it can't do, Difficulty levels, Keyboard
 *   RSC.tour.start(studio)           the guided tour: a spotlight on each part of
 *                                    the studio (and of its host: open, save) with
 *                                    a card that explains it; arrows / Esc
 *
 * Summoned by the studio's ? button, the ? key, the buttons of the empty studio,
 * "Help & tour" in the Shiny sidebar and "Help" in the offline page's header.
 * Hosts name their own parts for the tour in opts.host.tour:
 *   {open: selector | [selector, closest], library, save, hostName}.
 * Everything lives under .rsc-help / .rsc-tour (appended to <body>).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = root.RSCreator;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const el = (tag, cls, html) => { const x = document.createElement(tag); if (cls) x.className = cls; if (html != null) x.innerHTML = html; return x; };
  const li = (items) => "<ul>" + items.map((x) => "<li>" + x + "</li>").join("") + "</ul>";

  // ---- the Help dialog --------------------------------------------------------------------------------------
  const SECTIONS = [
    ["start", "Start here"], ["can", "What it can do"], ["cant", "What it can\u2019t do"], ["levels", "Difficulty levels"], ["keys", "Keyboard"]
  ];
  function sectionHtml(id, st) {
    const host = st && st.host && st.host.name === "page" ? "page" : "shiny";
    if (id === "start") return '<h3>RockShiny Creator</h3><p class="rsc-help-lead">The song studio of RockShiny: open a Rocksmith 2014 song to change it, or start a new song from any audio file, then save it for the game and for RockShiny.</p>' +
      '<div class="rsc-help-steps">' +
      '<div><span>1</span><b>Open a song</b><p>' + (host === "page" ? "Drop a <code>.psarc</code> on the left (or click to browse)." : "Pick a song from the library, or drop a <code>.psarc</code> on the left.") +
      " To make a new song, drop an audio file (mp3, wav, ogg, flac, m4a) instead.</p></div>" +
      "<div><span>2</span><b>Change it on the timeline</b><p>Each row is a track: sections, beats, the recording, one row per chart (tablature), and the lyrics. <b>Select</b> (V), <b>Draw</b> (D) and <b>Erase</b> (E) work on all of them; the panel on the right shows what you selected.</p></div>" +
      "<div><span>3</span><b>Save</b><p>Choose PC or Mac. " + (host === "page" ? "<b>Download .psarc</b> builds the file in this page; <b>Check the package</b> reads it back." :
        "<b>Save to the library</b> writes it next to your songs and checks it with RockShiny\u2019s own readers; then <b>Play it</b> or <b>Sing it</b>.") + "</p></div></div>" +
      '<p class="rsc-help-note">Nothing is changed until you save, and a save never overwrites a file: it gets a new name. <kbd>Ctrl</kbd> <kbd>Z</kbd> undoes any edit.</p>';
    if (id === "can") return "<h3>What it can do</h3>" +
      '<div class="rsc-help-grid">' +
      "<div><b>Open and save songs</b>" + li(["Rocksmith 2014 <code>.psarc</code> files for PC or Mac, custom or official", "Save for PC or Mac (also converts one to the other)", "Unchanged parts of a song are saved byte for byte"]) + "</div>" +
      "<div><b>Edit charts</b>" + li(["Notes, chords, sustains, anchors", "Techniques: bends, slides, hammer-ons, pull-offs, vibrato, palm mutes, harmonics, taps\u2026", "Draw, drag, stretch, erase, copy, paste, snap to the grid, undo", "Add or remove lead, rhythm, bass or combo charts, in any tuning"]) + "</div>" +
      "<div><b>Fill a chart by ear</b>" + li(["A first draft of the rhythm chords and the bass line, heard in the recording", "A tuner: play your guitar into the microphone and each note or chord you play is written at the playhead, or as you play along", "The demo song \u201cNight Drive\u201d to try it all on"]) + "</div>" +
      "<div><b>Make a new song</b>" + li(["From an mp3, wav, ogg, flac or m4a file", "The tempo and beat grid are found in the audio", "Title and artist are read from the file name", "Album art from any image"]) + "</div>" +
      "<div><b>Difficulty levels</b>" + li(["Keeps a song\u2019s own levels when you edit it", "Look at any level and change it by hand", "Creates easier levels automatically from the full chart"]) + "</div>" +
      "<div><b>Lyrics</b>" + li(["Find them online (LRCLIB), import a <code>.lrc</code> / <code>.txt</code>, or paste them", "Sync them to the singing automatically (a model of the voice finds the sung phrases and the silences), line by line, by tapping, or by dragging", "Split into Rocksmith syllables for the game and RockShiny\u2019s karaoke"]) + "</div>" +
      "<div><b>Stems and beats</b>" + li(["Split the recording into vocals, guitar, bass, drums and the rest", "Mute, solo, mix and download each one as WAV", "Fix the beat grid: tempo, \u00d72 / \u00f72, bar starts, shift everything"]) + "</div>" +
      "</div>" +
      '<p class="rsc-help-note">It runs inside RockShiny (the Creator page), on its own (<code>shiny::runApp("creator")</code>), or as one HTML file that works offline.</p>';
    if (id === "cant") return "<h3>What it can\u2019t do</h3><p class=\"rsc-help-lead\">Good to know before you start:</p>" +
      '<div class="rsc-help-limits">' +
      "<div><b>It does not transcribe a song for you.</b> Drafts heard in the recording are rough: about half of the chords come out right and a third of the bass notes (the bass draft plays the chords\u2019 roots), and lead parts are not drafted at all. Use the tuner to play the notes in, then fix them by hand.</div>" +
      "<div><b>Stems are not studio quality.</b> They are made by signal processing guided by the chart and the lyrics, not by an AI model. Parts that have no chart stay in \u201cOther\u201d. Good for practising and muting; not for release.</div>" +
      "<div><b>Automatic levels pick notes, they don\u2019t re-arrange.</b> Easier levels keep the notes on the strongest beats and play chords on fewer strings. They never change a fingering or a rhythm the way a person might.</div>" +
      "<div><b>Lyrics sync is a first pass.</b> Auto-sync puts most lines within about 0.3 s (the typical line within 0.1 s); \u201cSync each line\u201d, tap-sync or a drag finishes the job. Loud guitars or backing vocals can fool the voice model. Finding lyrics online needs an internet connection.</div>" +
      "<div><b>Detected beats may need a fix.</b> The tempo can come out twice or half as fast, or a bar can start one beat late: use \u00d72 / \u00f72 and \u201cBar starts at playhead\u201d.</div>" +
      "<div><b>No tone designer.</b> A song keeps its guitar tones; new songs get a plain default tone.</div>" +
      "<div><b>Not tested in the game.</b> Saved songs are checked with RockShiny\u2019s readers, but nobody has loaded them in Rocksmith itself yet. New songs store uncompressed audio, so their files are larger.</div>" +
      "<div><b>Rocksmith 2014 on PC or Mac only.</b> Not Rocksmith+, not the 2012 edition, not console packages.</div>" +
      "<div><b>Browsers.</b> Use Chrome, Edge or Firefox for the offline HTML file; Safari may not play its audio.</div>" +
      "</div>" + '<p class="rsc-help-note">Only open and share songs you own.</p>';
    if (id === "levels") return "<h3>Difficulty levels</h3>" +
      '<p class="rsc-help-lead">In Rocksmith every player chooses how hard a song is. A chart can have <b>difficulty levels</b>: level 0 is the easiest, each level adds notes, and the top level is the full chart.</p>' +
      '<div class="rsc-help-levels" aria-hidden="true">' + [1, 3, 5, 8].map((n, i) => '<div><span>' + (i === 3 ? "Full chart" : "Level " + i) + "</span><i>" +
        Array.from({ length: 8 }, (_, j) => (j < n ? "<b></b>" : "<em></em>")).join("") + "</i></div>").join("") + "</div>" +
      "<p>The song is cut into parts (Rocksmith calls them <i>phrases</i>; they start at the sections). Each part has its own number of levels: a quiet intro may have two, a busy solo nine.</p>" +
      "<h4>In the Levels tab</h4><ol>" +
      "<li><b>No levels yet?</b> Click <b>Create easier levels</b>. The Creator makes them from the full chart: the easiest level keeps about one note in eight, on the strongest beats; chords are played on fewer strings. \u201cHow many\u201d sets the number of levels in the busiest parts.</li>" +
      "<li><b>Look at a level:</b> click its number (or press <kbd>PgUp</kbd> / <kbd>PgDn</kbd>). The timeline shows what a player at that level plays; dashed notes are in the full chart but not in this level.</li>" +
      "<li><b>Change it by hand:</b> delete or draw notes while a level is shown: only that level changes. <b>Add a level</b> copies the level you are looking at as a new, easier one for the part at the playhead; thin it out by deleting notes.</li>" +
      "<li><b>When you save</b>, choose: keep the levels as they are, re-create them from the full chart (they then follow your edits of the full chart), or save the full chart only.</li></ol>" +
      '<p class="rsc-help-note">Songs that already have levels keep them when you edit: the Creator never flattens them unless you ask.</p>';
    if (id === "keys") return "<h3>Keyboard</h3>" + '<div class="rsc-keys rsc-help-keys">' + (RSC.KEYS || []).map(([a, b]) => "<kbd>" + esc(a) + "</kbd><span>" + esc(b) + "</span>").join("") + "</div>" +
      '<p class="rsc-help-note">Click the timeline first so the studio has the keyboard.</p>';
    return "";
  }

  let dlg = null;
  RSC.help = {
    open(st, section) {
      RSC.help.close();
      RSC.tour.end();
      const sec = SECTIONS.some((x) => x[0] === section) ? section : "start";
      const back = el("div", "rsc-help-backdrop");
      const box = el("div", "rsc-help");
      box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true"); box.setAttribute("aria-label", "RockShiny Creator help"); box.tabIndex = -1;
      box.innerHTML = '<header><span class="rsc-help-logo">' + ((RSC.ICON && RSC.ICON.song) || "") + '</span><div><b>Creator help</b><small>What it does, how to use it, and what it can\u2019t do</small></div>' +
        '<button class="rsc-help-x" data-help="close" aria-label="Close">\u00d7</button></header>' +
        '<nav class="rsc-help-nav">' + SECTIONS.map(([id, label]) => '<button data-sec="' + id + '">' + label + "</button>").join("") + "</nav>" +
        '<div class="rsc-help-body"></div>' +
        '<footer><button class="rsc-help-btn" data-help="close">Close</button><button class="rsc-help-btn is-accent" data-help="tour">\u25b6 Take the tour</button></footer>';
      back.appendChild(box);
      document.body.appendChild(back);
      const show = (id) => {
        box.querySelector(".rsc-help-body").innerHTML = sectionHtml(id, st);
        box.querySelectorAll("[data-sec]").forEach((b) => b.classList.toggle("is-on", b.dataset.sec === id));
        box.querySelector(".rsc-help-body").scrollTop = 0;
        box.dataset.section = id;
      };
      show(sec);
      box.addEventListener("click", (e) => {
        const s = e.target.closest("[data-sec]");
        if (s) { show(s.dataset.sec); return; }
        const a = e.target.closest("[data-help]");
        if (!a) return;
        if (a.dataset.help === "close") RSC.help.close();
        if (a.dataset.help === "tour") { RSC.help.close(); RSC.tour.start(st); }
      });
      back.addEventListener("pointerdown", (e) => { if (e.target === back) RSC.help.close(); });
      const key = (e) => {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); RSC.help.close(); }
      };
      document.addEventListener("keydown", key, true);
      dlg = { back, key, st };
      requestAnimationFrame(() => { back.classList.add("is-on"); box.focus({ preventScroll: true }); });
      if (st && st.emit) st.emit("help", { section: sec });
      return box;
    },
    close() {
      if (!dlg) return;
      document.removeEventListener("keydown", dlg.key, true);
      dlg.back.remove();
      const st = dlg.st;
      dlg = null;
      if (st && st.root) st.root.focus({ preventScroll: true });
    },
    isOpen: () => !!dlg,
    sections: SECTIONS.map((x) => x[0])
  };

  // ---- the guided tour ----------------------------------------------------------------------------------------
  /** The steps: target (in the studio, or a host part), title, text, and what to show first. */
  function steps(st) {
    const host = (st.host && st.host.tour) || {};
    const page = st.host && st.host.name === "page";
    const has = !!st.project;
    const tab = (t) => () => { st.insTab = t; st.renderInspector(); };
    return [
      { title: "Welcome to RockShiny Creator", text: "A two-minute tour of the studio. Use the buttons, or <kbd>\u2192</kbd> and <kbd>\u2190</kbd>; <kbd>Esc</kbd> ends the tour. You can start it again any time from the <b>?</b> button." },
      { host: host.open, title: "1 \u00b7 Open a song", text: "Drop a Rocksmith 2014 <code>.psarc</code> here (or click to browse) to change it. Drop an audio file \u2014 mp3, wav, ogg, flac, m4a \u2014 to start a <b>new song</b>: the Creator finds its tempo and gets empty charts ready." +
        (page ? " Files stay on this computer." : "") },
      { host: host.library, title: "\u2026or pick one from the library", text: "Every song in RockShiny\u2019s library folder. Type to search." },
      { target: ".rsc-card", title: "The song", text: "Title, artist and album art. The tags show the package (PC or Mac), its charts, the tempo, lyrics, difficulty levels and whether there are unsaved changes." },
      { target: ".rsc-tools", title: "Tools", text: "<b>Select</b> (V) picks and drags, <b>Draw</b> (D) adds notes, syllables, sections and beats, <b>Erase</b> (E) removes them. <b>Grid</b> is what new and moved things snap to. Then zoom, and undo / redo." },
      { target: ".rsc-scroll", title: "The timeline", text: has ? "Each row is a track: <b>sections</b>, <b>beats</b>, the recording (<b>Mix</b>), one row per <b>chart</b> drawn as tablature (a line per string, the fret on each note), and the <b>lyrics</b>. Scroll with the wheel, <kbd>Ctrl</kbd> + wheel zooms; drag on the time ruler to loop a passage." :
        "Once a song is open, each row here is a track: sections, beats, the recording, one row per chart (tablature) and the lyrics." },
      { target: ".rsc-heads", title: "Track names", text: "Click a name for its settings (a chart\u2019s tuning, capo, name\u2026) and <b>Fill this chart by ear</b>: a draft of the chords or the bass from the recording, or the <b>tuner</b> to play notes in with your guitar. <b>M</b> / <b>S</b> mute or solo the audio; the headphones play a chart as guide tones so you can hear what is written.", need: has },
      { target: ".rsc-inspector", before: tab("edit"), title: "The panel on the right", text: "<b>Edit</b> shows what you selected: a note\u2019s fret, string, sustain and techniques, a chord\u2019s frets, a syllable\u2019s text. <b>Song</b> has the title, artist, album art and the list of charts." },
      { target: ".rsc-inspector", before: tab("levels"), title: "Difficulty levels", text: "Easier versions of each chart for beginners. <b>Create easier levels</b> makes them from the full chart; click a level to see it and change it by hand. The Help explains how they work." },
      { target: ".rsc-inspector", before: tab("lyrics"), title: "Lyrics", text: "Find lyrics online, import a <code>.lrc</code> or paste them; <b>Auto-sync</b> fits them to the singing, <b>Sync each line</b> fine-tunes every line, <b>Show the voice</b> draws where someone sings, <b>Tap-sync</b> lets you tap each line as it is sung." },
      { target: ".rsc-inspector", before: tab("stems"), title: "Stems", text: "Split the recording into vocals, guitar, bass, drums and the rest. Mute the guitar to play along, or download each stem as a WAV file." },
      { target: ".rsc-inspector", before: tab("beats"), title: "Beats", text: "The beat grid notes snap to and the game counts bars by: detect it from the audio, fix the tempo (\u00d72, \u00f72), set where bars start, or move everything in time." },
      { target: ".rsc-transport", title: "Play", text: "Play / pause (<kbd>Space</kbd>), back to the start, loop (<kbd>L</kbd>), metronome, follow the playhead, and slow the song down to check a fast passage." },
      { host: host.save, title: "Save", text: page ? "Choose PC or Mac, then <b>Download .psarc</b>. <b>Check the package</b> reads the file back to make sure it opens." :
        "Choose PC or Mac. <b>Save to the library</b> writes a new file next to your songs and checks it with RockShiny\u2019s own readers; <b>Download</b> gives you the file. Then play or sing it in RockShiny." },
      { title: "Good to know", text: "The Creator doesn\u2019t transcribe recordings: drafts of chords and bass are rough, and you draw, play in (tuner) or edit the charts yourself. Stems and automatic levels are helpers, not studio-grade. The Help (<b>?</b>) lists everything it can and can\u2019t do." }
    ];
  }
  function find(spec, st) {
    if (!spec) return null;
    let node;
    if (Array.isArray(spec)) { node = document.querySelector(spec[0]); if (node && spec[1]) node = node.closest(spec[1]); }
    else node = (st.root.querySelector(spec) || document.querySelector(spec));
    if (!node) return null;
    const r = node.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || node.offsetParent === null && getComputedStyle(node).position !== "fixed") return null;
    return node;
  }

  let tour = null;
  RSC.tour = {
    start(st) {
      RSC.tour.end();
      RSC.help.close();
      if (st.audio && st.audio.playing) st.audio.toggle();
      const all = steps(st);
      const layer = el("div", "rsc-tour");
      layer.innerHTML = '<div class="rsc-tour-spot"></div><div class="rsc-tour-card" role="dialog" aria-live="polite"><div class="rsc-tour-count"></div><h4></h4><p></p>' +
        '<div class="rsc-tour-btns"><button data-tour="end">End tour</button><span></span><button data-tour="back">Back</button><button data-tour="next" class="is-accent">Next</button></div></div>';
      document.body.appendChild(layer);
      st.root.classList.add("is-touring");            // the empty studio's welcome makes room for the parts shown
      const tabBefore = st.insTab;
      tour = { st, layer, i: -1, list: [], tabBefore };
      // only the steps whose part is on screen (a host part may be missing or hidden)
      tour.list = all.filter((s) => (s.need === undefined || s.need) && (!("host" in s) || find(s.host, st)) && (!s.target || find(s.target, st)));
      layer.addEventListener("click", (e) => {
        const b = e.target.closest("[data-tour]");
        if (!b) return;
        if (b.dataset.tour === "end") RSC.tour.end();
        if (b.dataset.tour === "next") RSC.tour.go(tour.i + 1);
        if (b.dataset.tour === "back") RSC.tour.go(tour.i - 1);
      });
      tour.key = (e) => {
        if (!tour) return;
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); RSC.tour.end(); }
        else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); RSC.tour.go(tour.i + 1); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); RSC.tour.go(tour.i - 1); }
        else { e.stopPropagation(); }
      };
      tour.place = () => tour && RSC.tour.go(tour.i, true);
      document.addEventListener("keydown", tour.key, true);
      root.addEventListener("resize", tour.place);
      RSC.tour.go(0);
      if (st.emit) st.emit("tour", { step: 0 });
      return tour.list.length;
    },
    go(i, again) {
      if (!tour) return;
      if (i >= tour.list.length) { RSC.tour.end(); return; }
      i = Math.max(0, i);
      const s = tour.list[i], st = tour.st;
      if (!again && s.before) s.before();
      tour.i = i;
      const spot = tour.layer.querySelector(".rsc-tour-spot"), card = tour.layer.querySelector(".rsc-tour-card");
      card.querySelector(".rsc-tour-count").textContent = (i + 1) + " / " + tour.list.length;
      card.querySelector("h4").innerHTML = s.title;
      card.querySelector("p").innerHTML = s.text;
      card.querySelector('[data-tour="back"]').disabled = i === 0;
      card.querySelector('[data-tour="next"]').textContent = i === tour.list.length - 1 ? "Finish" : "Next";
      const node = s.target ? find(s.target, st) : s.host ? find(s.host, st) : null;
      const W = root.innerWidth, H = root.innerHeight;
      if (!node) {
        tour.layer.classList.add("is-center");
        spot.style.cssText = "left:50%;top:50%;width:0;height:0";
        card.style.cssText = "";
      } else {
        tour.layer.classList.remove("is-center");
        if (node.scrollIntoView) node.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = node.getBoundingClientRect(), pad = 6;
        const x = Math.max(4, r.left - pad), y = Math.max(4, r.top - pad), w = Math.min(W - 8, r.width + 2 * pad), h = Math.min(H - 8, r.height + 2 * pad);
        spot.style.cssText = "left:" + x + "px;top:" + y + "px;width:" + w + "px;height:" + h + "px";
        // the card next to the spot: below, above, right or left, whichever fits
        const cw = Math.min(360, W - 24), ch = card.offsetHeight || 170;
        let cx, cy;
        if (y + h + 12 + ch < H) { cy = y + h + 12; cx = x; }
        else if (y - 12 - ch > 0) { cy = y - 12 - ch; cx = x; }
        else if (x + w + 12 + cw < W) { cx = x + w + 12; cy = y; }
        else { cx = x - 12 - cw; cy = y; }
        cx = Math.max(12, Math.min(W - cw - 12, cx)); cy = Math.max(12, Math.min(H - ch - 12, cy));
        card.style.cssText = "left:" + cx + "px;top:" + cy + "px;width:" + cw + "px";
      }
      if (!again && st.emit) st.emit("tour", { step: i, title: s.title });
    },
    end() {
      if (!tour) return;
      const t = tour;
      tour = null;
      document.removeEventListener("keydown", t.key, true);
      root.removeEventListener("resize", t.place);
      t.layer.remove();
      if (t.st && t.st.root) t.st.root.classList.remove("is-touring");
      if (t.st && t.tabBefore && t.st.insTab !== t.tabBefore) { t.st.insTab = t.tabBefore; t.st.renderInspector(); }
      if (t.st && t.st.root) t.st.root.focus({ preventScroll: true });
    },
    isOn: () => !!tour,
    step: () => (tour ? { i: tour.i, n: tour.list.length, title: tour.list[tour.i] && tour.list[tour.i].title } : null)
  };
})(typeof window !== "undefined" ? window : globalThis);
