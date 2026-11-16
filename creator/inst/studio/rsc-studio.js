/* ---------------------------------------------------------------------------
 * rsc-studio.js -- the Creator's studio: a timeline editor for a song's beats,
 * sections, audio / stems, charts (guitar & bass) and lyrics, with an
 * inspector and a transport. The same front end in both hosts:
 *
 *   const studio = new RSCreator.Studio(el, {host})
 *   await studio.open({project, source})      // from E.projectFromPsarc / projectNew
 *   const bytes = await studio.save({platform})
 *
 * host (optional): {fetchLyrics(query) -> Promise<{lrc, synced, source} | null>,
 *                   name: "shiny" | "page"}
 * events (studio.on(fn)): "open", "change", "select", "status", "busy", "stems", "save"
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const E = RSC.engine, D = RSC.dsp;

  const STRING_COLORS = ["#e8203a", "#f2d40c", "#1f9cf0", "#f5891d", "#22c55e", "#b04ee6"];
  RSC.STRING_COLORS = STRING_COLORS;
  const SECTION_COLORS = { intro: "#5b6b8c", outro: "#5b6b8c", verse: "#2f7fd1", chorus: "#f5a524", prechorus: "#d9892b", postchorus: "#d9892b",
    bridge: "#9b59d0", solo: "#e8203a", riff: "#22a35a", breakdown: "#b04ee6", interlude: "#3aa6a0", transition: "#6f7a94", noguitar: "#3a4256",
    melody: "#1fa3c4", hook: "#f2b705", ambient: "#4d6a8a", buildup: "#c76b2c" };
  RSC.sectionColor = (n) => SECTION_COLORS[String(n || "").toLowerCase().replace(/[0-9 ]/g, "")] || "#4a5878";
  const SNAPS = [["Off", 0], ["1/1", 1], ["1/2", 2], ["1/3", 3], ["1/4", 4], ["1/6", 6], ["1/8", 8], ["1/12", 12], ["1/16", 16]];
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6L18 18V6z"/></svg>',
    loop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
    metro: '<svg viewBox="0 0 24 24"><path d="M12 2 7 3 4 21h16L17 3l-5-1zm0 2.1 3.3.7L16 9l-3 2.5V6h-2v7l-3.3 2.8L9.5 5zM6.4 19l.6-3.5L12 11.3l6 5L17.6 19z"/></svg>',
    follow: '<svg viewBox="0 0 24 24"><path d="M11 4h2v16h-2zM3 11h5l-2-2 1.4-1.4L11.8 12l-4.4 4.4L6 15l2-2H3zm18 2h-5l2 2-1.4 1.4L12.2 12l4.4-4.4L18 9l-2 2h5z"/></svg>',
    select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 9-6 1.5L16 20l-2.5 1.2-3-6.5L6 19z"/></svg>',
    draw: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.8 9.9 14 6.1zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8z"/></svg>',
    erase: '<svg viewBox="0 0 24 24"><path d="M16.2 3.6 21 8.4a2 2 0 0 1 0 2.8L12 20h8v2H7.8L3 17.2a2 2 0 0 1 0-2.8L13.4 3.6a2 2 0 0 1 2.8 0zM5 15.8 8.6 19.4h1.2l4.6-4.6-4.8-4.8z"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A7.5 7.5 0 0 1 20 16.4l2.4-.8A10 10 0 0 0 12.5 8z"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M18.4 10.6A10 10 0 0 0 1.6 15.6l2.4.8a7.5 7.5 0 0 1 12.6-4L13 16h9V7z"/></svg>',
    zin: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
    zout: '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
    song: '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3z"/></svg>',
    help: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2zm2.1-7.7-.9.9c-.7.7-1.2 1.3-1.2 2.8h-2v-.5c0-1.1.5-2.1 1.2-2.8l1.2-1.3A2 2 0 0 0 12 6a2 2 0 0 0-2 2H8a4 4 0 0 1 8 0c0 .9-.4 1.7-.9 2.3z"/></svg>',
    headphones: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9v7a2 2 0 0 0 2 2h3v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h3a2 2 0 0 0 2-2v-7a9 9 0 0 0-9-9z"/></svg>',
    wand: '<svg viewBox="0 0 24 24"><path d="M7.5 5.6 10 7 8.6 4.5 10 2 7.5 3.4 5 2l1.4 2.5L5 7zm12 9.8L17 14l1.4 2.5L17 19l2.5-1.4L22 19l-1.4-2.5L22 14zM22 2l-2.5 1.4L17 2l1.4 2.5L17 7l2.5-1.4L22 7l-1.4-2.5zm-7.6 5.3a1 1 0 0 0-1.4 0L1.3 19a1 1 0 0 0 0 1.4l2.3 2.3a1 1 0 0 0 1.4 0L16.7 11a1 1 0 0 0 0-1.4zm-1.1 5.5-2.1-2.1 2.4-2.4 2.1 2.1z"/></svg>'
  };
  RSC.ICON = ICON;
  const el = (tag, cls, html) => { const x = document.createElement(tag); if (cls) x.className = cls; if (html != null) x.innerHTML = html; return x; };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  RSC.esc = esc;
  const fmtTime = (t, ms) => {
    if (!Number.isFinite(t)) t = 0;
    const s = Math.max(0, t), m = Math.floor(s / 60), r = s - 60 * m;
    return m + ":" + (ms ? r.toFixed(3).padStart(6, "0") : String(Math.floor(r)).padStart(2, "0"));
  };
  RSC.fmtTime = fmtTime;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const lowerBound = (arr, t, key) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m][key] < t) lo = m + 1; else hi = m; } return lo; };

  const TUNINGS = {
    "E standard": [0, 0, 0, 0, 0, 0], "Drop D": [-2, 0, 0, 0, 0, 0], "Eb standard": [-1, -1, -1, -1, -1, -1], "Drop C#": [-3, -1, -1, -1, -1, -1],
    "D standard": [-2, -2, -2, -2, -2, -2], "Drop C": [-4, -2, -2, -2, -2, -2], "Open G": [-2, -2, 0, 0, 0, -2], "Open D": [-2, 0, 0, -1, -2, -2],
    "Open E": [0, 2, 2, 1, 0, 0], "DADGAD": [-2, 0, 0, 0, -2, -2], "C standard": [-4, -4, -4, -4, -4, -4], "B standard": [-5, -5, -5, -5, -5, -5]
  };
  RSC.TUNINGS = TUNINGS;
  RSC.tuningName = (t, n) => {
    const v = (t || []).slice(0, n || 6);
    for (const [name, tt] of Object.entries(TUNINGS)) if (tt.slice(0, v.length).every((x, i) => x === v[i])) return name;
    return "Custom";
  };

  class Studio {
    constructor(host, opts) {
      opts = opts || {};
      this.root = host; this.opts = opts; this.host = opts.host || {};
      this.listeners = new Set();
      this.project = null; this.source = null;
      this.audio = new RSC.AudioEngine();
      this.view = { t0: 0, pps: 60, follow: true };
      this.tool = "select"; this.snap = 4; this.fret = 0;
      this.sel = { lane: null, kind: null, items: [] };
      this.undoStack = []; this.redoStack = [];
      this.laneState = {};                 // per-lane UI state: {collapsed, guide}
      this.insTab = "edit";
      this.dirty = false;
      this.build();
      this.audio.on((type) => this.onAudio(type));
      this.loop = this.loop.bind(this);
      requestAnimationFrame(this.loop);
      RSC.studios = RSC.studios || new Map();
      if (host.id) RSC.studios.set(host.id, this);
    }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, data) { for (const fn of this.listeners) { try { fn(type, data); } catch (e) { console.error(e); } } }

    // ---------------------------------------------------------------------------------------------
    // DOM
    build() {
      const r = this.root;
      r.classList.add("rsc-studio", "is-empty");
      r.tabIndex = 0;
      r.innerHTML = "";
      const top = el("div", "rsc-top");
      this.card = el("div", "rsc-card rsc-glass",
        '<div class="rsc-art is-empty">' + ICON.song + '</div><div class="rsc-card-meta"><div class="rsc-card-title">RockShiny Creator</div>' +
        '<div class="rsc-card-sub">Open a song or start a new one</div><div class="rsc-chips"></div></div>');
      top.appendChild(this.card);
      const tools = el("div", "rsc-tools");
      tools.innerHTML =
        '<div class="rsc-seg" data-role="tool">' +
        '<button data-tool="select" title="Select and move (V)">' + ICON.select + "Select</button>" +
        '<button data-tool="draw" title="Draw notes, syllables, sections, beats (D)">' + ICON.draw + "Draw</button>" +
        '<button data-tool="erase" title="Erase (E)">' + ICON.erase + "Erase</button></div>" +
        '<span class="rsc-lbl">Grid</span><select class="rsc-select" data-role="snap" title="Snap to the beat grid (G cycles)">' +
        SNAPS.map(([l, v]) => '<option value="' + v + '">' + l + "</option>").join("") + "</select>" +
        '<div class="rsc-seg"><button data-act="zout" title="Zoom out (-)">' + ICON.zout + '</button><button data-act="fit" title="Whole song (0)">' + ICON.fit +
        '</button><button data-act="zin" title="Zoom in (+)">' + ICON.zin + "</button></div>" +
        '<button class="rsc-ibtn" data-act="undo" title="Undo (Ctrl+Z)">' + ICON.undo + '</button><button class="rsc-ibtn" data-act="redo" title="Redo (Ctrl+Shift+Z)">' + ICON.redo + "</button>" +
        '<button class="rsc-ibtn rsc-helpbtn" data-act="help" title="Help and the guided tour (?)">' + ICON.help + "</button>";
      top.appendChild(tools);
      r.appendChild(top);

      const body = el("div", "rsc-body");
      const center = el("div", "rsc-center");
      this.overview = el("div", "rsc-overview", "<canvas></canvas>");
      this.scroll = el("div", "rsc-scroll");
      const lanes = el("div", "rsc-lanes");
      this.heads = el("div", "rsc-heads");
      this.wrap = el("div", "rsc-canvas-wrap");
      this.canvas = el("canvas"); this.over = el("canvas");
      this.wrap.append(this.canvas, this.over);
      lanes.append(this.heads, this.wrap);
      this.scroll.appendChild(lanes);
      this.hscroll = el("div", "rsc-hscroll", '<div class="rsc-hthumb"></div>');
      center.append(this.overview, this.scroll, this.hscroll);
      this.insp = el("aside", "rsc-inspector");
      this.insp.innerHTML = '<div class="rsc-insp-tabs">' + [["edit", "Edit"], ["song", "Song"], ["levels", "Levels"], ["lyrics", "Lyrics"], ["stems", "Stems"], ["beats", "Beats"]]
        .map(([k, l]) => '<button data-tab="' + k + '">' + l + "</button>").join("") + '</div><div class="rsc-insp-body"></div>';
      body.append(center, this.insp);
      r.appendChild(body);

      const tr = el("div", "rsc-transport rsc-glass");
      tr.innerHTML =
        '<button class="rsc-tbtn is-play" data-act="play" title="Play / pause (Space)">' + ICON.play + "</button>" +
        '<button class="rsc-tbtn" data-act="home" title="Back to the start (Home)">' + ICON.home + "</button>" +
        '<div class="rsc-time"><span data-role="time">0:00.000</span><small data-role="dur">/ 0:00</small></div>' +
        '<div class="rsc-pos" data-role="pos" title="Bar.beat">1.1</div>' +
        '<button class="rsc-tbtn" data-act="loop" title="Loop the selected range (L)">' + ICON.loop + "</button>" +
        '<button class="rsc-tbtn" data-act="metro" title="Metronome on the beat grid (M)">' + ICON.metro + "</button>" +
        '<button class="rsc-tbtn is-on" data-act="follow" title="Follow the playhead (F)">' + ICON.follow + "</button>" +
        '<select class="rsc-select" data-role="rate" title="Speed (the pitch follows)"><option value="1">100%</option><option value="0.9">90%</option>' +
        '<option value="0.75">75%</option><option value="0.5">50%</option></select>' +
        '<div class="rsc-status" data-role="status"></div>' +
        '<span class="rsc-lbl">Vol</span><input class="rsc-vol" type="range" min="0" max="1" step="0.01" value="0.9" data-role="vol" title="Volume">';
      this.transport = tr;
      r.appendChild(tr);
      r.appendChild(el("div", "rsc-empty",
        '<div class="rsc-empty-icon">' + ICON.song + '</div><div><b>RockShiny Creator</b>Open a Rocksmith <code>.psarc</code> to edit it, or start a new song from an audio file.' +
        "<ul><li>edit charts, beats, sections and lyrics on the timeline</li><li>pull out instrument stems</li><li>fetch lyrics and sync them to the recording</li>" +
        "<li>save a new <code>.psarc</code> for RockShiny (PC or Mac)</li></ul>" +
        '<div class="rsc-empty-btns"><button class="rsc-btn is-accent" data-act="demo">\u266b Open the demo song</button><button class="rsc-btn" data-act="tour">\u25b6 Take the tour</button>' +
        '<button class="rsc-btn" data-act="help:can">What can it do?</button></div></div>'));
      this.busyEl = el("div", "rsc-busy", '<div class="rsc-busy-card"><div class="rsc-eq"><i></i><i></i><i></i><i></i></div><div style="flex:1;min-width:0"><b></b><span></span><div class="rsc-progress"><i></i></div></div></div>');
      this.toastEl = el("div", "rsc-toast");
      this.tipEl = el("div", "rsc-tip");
      r.append(this.busyEl, this.toastEl, this.tipEl);
      this.bindUI();
      this.resize();
      if (root.ResizeObserver) { this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(this.wrap); this.ro.observe(r); }
      this.setTool("select");
      this.renderInspector();
    }

    bindUI() {
      const r = this.root;
      r.addEventListener("click", (e) => {
        const b = e.target.closest("[data-act]");
        if (b && r.contains(b)) { this.act(b.dataset.act, b); return; }
        const t = e.target.closest("[data-tool]");
        if (t) this.setTool(t.dataset.tool);
        const tab = e.target.closest("[data-tab]");
        if (tab) { this.insTab = tab.dataset.tab; this.renderInspector(); }
      });
      r.querySelector('[data-role="snap"]').addEventListener("change", (e) => { this.snap = +e.target.value; this.draw(); });
      r.querySelector('[data-role="snap"]').value = String(this.snap);
      r.querySelector('[data-role="rate"]').addEventListener("change", (e) => this.audio.setRate(+e.target.value));
      r.querySelector('[data-role="vol"]').addEventListener("input", (e) => this.audio.setVolume(+e.target.value));
      r.addEventListener("keydown", (e) => this.onKey(e));
      // canvas
      this.wrap.addEventListener("pointerdown", (e) => this.onDown(e));
      this.wrap.addEventListener("pointermove", (e) => this.onMove(e));
      this.wrap.addEventListener("pointerup", (e) => this.onUp(e));
      this.wrap.addEventListener("pointerleave", () => { this.tipEl.classList.remove("is-on"); });
      this.wrap.addEventListener("dblclick", (e) => this.onDbl(e));
      this.wrap.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      this.wrap.addEventListener("contextmenu", (e) => e.preventDefault());
      // overview + horizontal scrollbar
      const ov = this.overview;
      const ovSeek = (e) => { const rc = ov.getBoundingClientRect(), t = (e.clientX - rc.left) / rc.width * this.duration(); this.centerOn(t); };
      ov.addEventListener("pointerdown", (e) => { ov.setPointerCapture(e.pointerId); ovSeek(e); ov._drag = true; });
      ov.addEventListener("pointermove", (e) => { if (ov._drag) ovSeek(e); });
      ov.addEventListener("pointerup", () => { ov._drag = false; });
      const th = this.hscroll.firstChild;
      th.addEventListener("pointerdown", (e) => { th.setPointerCapture(e.pointerId); th._x = e.clientX; th._t0 = this.view.t0; e.stopPropagation(); });
      th.addEventListener("pointermove", (e) => { if (th._x == null) return; const w = this.hscroll.clientWidth; this.view.t0 = th._t0 + (e.clientX - th._x) / w * this.duration(); this.clampView(); this.draw(); });
      th.addEventListener("pointerup", () => { th._x = null; });
      this.hscroll.addEventListener("pointerdown", (e) => { if (e.target !== this.hscroll) return; const rc = this.hscroll.getBoundingClientRect(); this.centerOn((e.clientX - rc.left) / rc.width * this.duration()); });
    }

    setTool(t) {
      this.tool = t;
      this.root.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("is-on", b.dataset.tool === t));
      this.wrap.classList.toggle("tool-draw", t === "draw");
      this.wrap.classList.toggle("tool-erase", t === "erase");
    }

    act(a, b) {
      switch (a) {
        case "play": this.audio.toggle(); break;
        case "home": this.audio.seek(this.audio.loop.on ? this.audio.loop.a : 0); this.centerOn(this.audio.time(), true); break;
        case "loop": this.audio.loop.on = !this.audio.loop.on && this.audio.loop.b > this.audio.loop.a; if (!this.audio.loop.on && this.audio.loop.b <= this.audio.loop.a) this.toast("Drag on the ruler (or Shift-drag a lane) to choose the loop range"); this.syncButtons(); this.drawOver(); break;
        case "metro": this.audio.metronome = !this.audio.metronome; this.syncButtons(); break;
        case "follow": this.view.follow = !this.view.follow; this.syncButtons(); break;
        case "zin": this.zoom(1.5); break;
        case "zout": this.zoom(1 / 1.5); break;
        case "fit": this.fit(); break;
        case "undo": this.undo(); break;
        case "help": if (RSC.help) RSC.help.open(this); break;
        case "tour": if (RSC.tour) RSC.tour.start(this); break;
        case "demo": if (RSC.openDemo) RSC.openDemo(this).catch((e) => this.toast(e.message, "error")); break;
        case "redo": this.redo(); break;
        default:
          if (a.startsWith("help:") && RSC.help) { RSC.help.open(this, a.slice(5)); break; }
          if (RSC.inspectorAct) RSC.inspectorAct(this, a, b);
      }
    }
    syncButtons() {
      const t = this.transport;
      t.querySelector('[data-act="play"]').innerHTML = this.audio.playing ? ICON.pause : ICON.play;
      t.querySelector('[data-act="loop"]').classList.toggle("is-on", this.audio.loop.on);
      t.querySelector('[data-act="metro"]').classList.toggle("is-on", this.audio.metronome);
      t.querySelector('[data-act="follow"]').classList.toggle("is-on", this.view.follow);
      this.root.querySelector('[data-act="undo"]').disabled = !this.undoStack.length;
      this.root.querySelector('[data-act="redo"]').disabled = !this.redoStack.length;
    }

    // ---------------------------------------------------------------------------------------------
    // feedback
    status(text, level) {
      const s = this.transport.querySelector('[data-role="status"]');
      s.textContent = text || ""; s.className = "rsc-status" + (level ? " is-" + level : "");
      this.emit("status", { text, level });
    }
    toast(text, level, ms) {
      const t = this.toastEl;
      t.textContent = text; t.className = "rsc-toast is-on" + (level === "error" ? " is-error" : "");
      clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("is-on"), ms || 2600);
    }
    busy(title, sub, frac) {
      const b = this.busyEl;
      if (title == null) { b.classList.remove("is-on"); this.emit("busy", null); return; }
      b.classList.add("is-on");
      b.querySelector("b").textContent = title; b.querySelector("span").textContent = sub || "";
      const bar = b.querySelector(".rsc-progress");
      bar.style.display = frac == null ? "none" : "block";
      bar.firstChild.style.width = (100 * (frac || 0)).toFixed(1) + "%";
      this.emit("busy", { title, sub, frac });
    }

    // ---------------------------------------------------------------------------------------------
    // project
    /** Open a project ({project, source} from the engine). Decodes its audio. */
    async open(p, opts) {
      opts = opts || {};
      this.audio.stop();
      this.project = p.project; this.source = p.source;
      this.undoStack = []; this.redoStack = []; this.sel = { lane: null, kind: null, items: [] };
      this.dirty = false; this.laneState = {};
      this.stemsInfo = null; this.showVoice = false;
      this.root.classList.remove("is-empty");
      this.normalize();
      this.ghosts = {};
      this.buildLanes();
      this.renderCard();
      this.busy("Opening " + (this.project.meta.title || "the song") + "\u2026", "Decoding the audio");
      try {
        const name = this.project.audio && this.project.audio.song;
        if (opts.audioBuffer) this.audio.setBuffer(opts.audioBuffer);
        else if (name && this.source.has(name)) {
          const wem = await this.source.read(name);
          const play = E.wemToPlayable(wem);
          await E.tick();
          await this.audio.load(play.bytes);
        }
      } catch (err) {
        this.toast("The audio could not be decoded in this browser: " + err.message, "error", 6000);
        if (this.host.audioFallback) {
          try { const bytes = await this.host.audioFallback(this.project); if (bytes) await this.audio.load(bytes); } catch (e2) { /* no audio */ }
        }
      } finally { this.busy(null); }
      this.audio.beats = this.project.beats;
      this.audio.loop = { on: false, a: 0, b: 0 };
      this.refreshGuides();
      this.renderHeads();
      this.fit();
      requestAnimationFrame(() => { this.resize(); this.fit(); });
      this.renderInspector();
      this.syncButtons();
      this.status((this.project.arrangements.length || 0) + " arrangement(s)" + (this.project.vocals ? ", lyrics" : "") + (this.audio.mix ? ", " + fmtTime(this.audio.duration) + " of audio" : ", no audio"));
      this.emit("open", this.project);
      this.root.focus({ preventScroll: true });
    }
    /** Make a project safe to edit (one level per chart, sorted, ids). */
    normalize() {
      const p = this.project;
      p.sections = p.sections || []; p.beats = p.beats || [];
      for (const a of p.arrangements) {
        const lv = a.doc.levels[0] || (a.doc.levels[0] = { difficulty: 0, notes: [], chords: [], fretHandMutes: [], anchors: [], handShapes: [] });
        lv.notes.sort((x, y) => x.time - y.time || x.string - y.string);
        lv.chords.sort((x, y) => x.time - y.time);
      }
      if (p.vocals) p.vocals.syllables.sort((x, y) => x.time - y.time);
    }
    duration() {
      const p = this.project;
      return Math.max(this.audio.duration || 0, p ? p.meta.songLength || 0 : 0, 10);
    }
    /** Mark what changed (for saving) and redraw. */
    touched(what) {
      const p = this.project;
      for (const w of what) {
        if (w === "beats") p.beatsEdited = true;
        else if (w === "sections") p.sectionsEdited = true;
        else if (w === "meta") p.meta.metaEdited = true;
        else if (w === "vocals") { if (p.vocals) p.vocals.edited = true; }
        else if (/^arr:/.test(w)) { const a = p.arrangements[+w.slice(4)]; if (a) a.edited = true; }
        else if (/^(dd|chart):/.test(w)) { const a = p.arrangements[+w.split(":")[1]]; if (a) a.edited = true; this.renderHeads(); }
      }
      this.dirty = true;
      this.refreshGhosts();
      this.audio.beats = p.beats;
      this.refreshGuides();
      this.renderCard();
      this.draw();
      this.syncButtons();
      this.emit("change", { what });
    }

    // ---- undo: snapshots of the containers an edit changes ----
    target(key) {
      const p = this.project;
      if (key === "beats") return { get: () => p.beats, set: (v) => { p.beats = v; } };
      if (key === "sections") return { get: () => p.sections, set: (v) => { p.sections = v; } };
      if (key === "meta") return { get: () => p.meta, set: (v) => { p.meta = v; } };
      if (key === "vocals") return { get: () => p.vocals, set: (v) => { p.vocals = v; } };
      if (key === "arrangements") return { get: () => p.arrangements, set: (v) => { p.arrangements = v; } };
      if (/^arr:/.test(key)) {
        const i = +key.slice(4);
        // the view (the chart at one difficulty level) is part of the snapshot: undo goes back to the level it was made on
        return { get: () => { const a = p.arrangements[i]; return a ? { level: a.doc.levels[0], templates: a.doc.chordTemplates, tuning: a.doc.tuning, capo: a.doc.capo, centOffset: a.doc.centOffset, name: a.name, view: a.dd ? a.dd.view : undefined } : null; },
          set: (v) => {
            const a = p.arrangements[i]; if (!a || !v) return;
            if (a.dd && v.view !== undefined && v.view !== a.dd.view) { E.ddCommit(a); a.dd.view = v.view; }
            a.doc.levels[0] = v.level; a.doc.chordTemplates = v.templates; a.doc.tuning = v.tuning; a.doc.capo = v.capo; a.doc.centOffset = v.centOffset; a.name = v.name;
          } };
      }
      if (/^chart:/.test(key)) {
        // a whole chart: its document and its difficulty levels
        const i = +key.slice(6);
        return { get: () => { const a = p.arrangements[i]; if (!a) return null; E.ddCommit(a); return { doc: a.doc, dd: a.dd, levels: a.levels }; },
          set: (v) => { const a = p.arrangements[i]; if (!a || !v) return; a.doc = v.doc; a.dd = v.dd; a.levels = v.levels; } };
      }
      if (/^dd:/.test(key)) {
        // difficulty levels: the stored levels, the phrases and the view together
        const i = +key.slice(3);
        return { get: () => {
            const a = p.arrangements[i]; if (!a) return null;
            E.ddCommit(a);
            const d = a.doc;
            return { dd: a.dd, levels: a.levels, phrases: d.phrases, phraseIterations: d.phraseIterations, newLinkedDiffs: d.newLinkedDiffs, sections: d.sections,
              chordTemplates: d.chordTemplates, level: d.levels[0] };
          },
          set: (v) => {
            const a = p.arrangements[i]; if (!a || !v) return;
            const d = a.doc;
            a.dd = v.dd; a.levels = v.levels; d.phrases = v.phrases; d.phraseIterations = v.phraseIterations; d.newLinkedDiffs = v.newLinkedDiffs;
            d.sections = v.sections; d.chordTemplates = v.chordTemplates; d.levels[0] = v.level;
          } };
      }
      throw new Error("unknown edit target " + key);
    }
    /** Run an edit: keys name what it changes (snapshotted for undo). */
    edit(label, keys, fn) {
      if (!this.project) return;
      const before = keys.map((k) => [k, clone(this.target(k).get())]);
      let res;
      try { res = fn(); } catch (err) { for (const [k, v] of before) this.target(k).set(v); this.toast(err.message, "error"); return; }
      const after = keys.map((k) => [k, clone(this.target(k).get())]);
      this.undoStack.push({ label, before, after, keys });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack = [];
      this.touched(keys.filter((k) => k !== "arrangements"));
      if (keys.includes("arrangements")) { this.buildLanes(); this.draw(); }
      return res;
    }
    undo() {
      const u = this.undoStack.pop();
      if (!u) return;
      for (const [k, v] of u.before) this.target(k).set(clone(v));
      this.redoStack.push(u);
      this.clearSelection();
      if (u.keys.includes("arrangements")) this.buildLanes();
      this.touched(u.keys.filter((k) => k !== "arrangements"));
      this.toast("Undo: " + u.label);
    }
    redo() {
      const u = this.redoStack.pop();
      if (!u) return;
      for (const [k, v] of u.after) this.target(k).set(clone(v));
      this.undoStack.push(u);
      this.clearSelection();
      if (u.keys.includes("arrangements")) this.buildLanes();
      this.touched(u.keys.filter((k) => k !== "arrangements"));
      this.toast("Redo: " + u.label);
    }

    // ---------------------------------------------------------------------------------------------
    // lanes
    buildLanes() {
      const p = this.project, L = [];
      if (!p) { this.lanes = []; return; }
      L.push({ id: "ruler", kind: "ruler", h: 26, name: "Time" });
      L.push({ id: "sections", kind: "sections", h: 28, name: "Sections" });
      L.push({ id: "beats", kind: "beats", h: 30, name: "Beats" });
      L.push({ id: "mix", kind: "wave", h: 62, name: "Mix", color: "#aeb7cc", audio: "mix" });
      if (this.audio.stems) for (const s of RSC.stems.STEMS) if (this.audio.stems.ids.includes(s.id)) L.push({ id: "stem:" + s.id, kind: "wave", h: 40, name: s.label, color: s.color, audio: s.id, stem: true });
      p.arrangements.forEach((a, i) => {
        const ns = a.kind === "bass" ? 4 : 6, st = this.laneState["arr:" + i] || {};
        L.push({ id: "arr:" + i, kind: "arr", arr: i, strings: ns, h: st.collapsed ? 30 : 20 + ns * 15 + 8, collapsed: !!st.collapsed, name: a.name });
      });
      L.push({ id: "vocals", kind: "vocals", h: this.showVoice ? 76 : 44, name: "Lyrics", voice: !!this.showVoice });   // taller: the voice under the syllables
      let y = 0;
      for (const l of L) { l.y = y; y += l.h; }
      this.lanes = L; this.lanesH = y;
      this.renderHeads();
      this.resize();
    }
    renderHeads() {
      const h = this.heads, p = this.project;
      h.innerHTML = "";
      h.style.height = this.lanesH + "px";
      for (const l of this.lanes) {
        const d = el("div", "rsc-head" + (l.kind === "ruler" || l.kind === "beats" || l.kind === "sections" ? " rsc-head-small" : ""));
        d.style.top = l.y + "px"; d.style.height = l.h + "px"; d.dataset.lane = l.id;
        if (this.sel.lane === l.id) d.classList.add("is-sel");
        let sub = "", color = l.color, btns = "";
        if (l.kind === "ruler") { sub = ""; }
        else if (l.kind === "beats") { sub = p.beats.length ? E.averageTempo(p.beats).toFixed(1) + " BPM" : "no beats"; }
        else if (l.kind === "sections") { sub = p.sections.length + " sections"; }
        else if (l.kind === "wave") {
          const lane = this.audio.lanes[l.audio] || { mute: false, solo: false };
          sub = l.stem ? "stem" : this.audio.mix ? fmtTime(this.audio.duration) + (this.audio.stems ? " \u00b7 master" : "") : "no audio";
          btns = '<button class="rsc-hb' + (lane.mute ? " is-m" : "") + '" data-hact="mute" title="Mute">M</button><button class="rsc-hb' + (lane.solo ? " is-s" : "") + '" data-hact="solo" title="Solo">S</button>';
        } else if (l.kind === "arr") {
          const a = p.arrangements[l.arr], lv = a.doc.levels[0];
          color = a.kind === "bass" ? "#b04ee6" : a.kind === "rhythm" ? "#22c55e" : "#1f9cf0";
          const dd = a.dd ? (a.dd.view == null ? "Full chart, " + a.dd.levels.length + " levels \u00b7 " : "Level " + a.dd.view + " of 0\u2013" + (a.dd.levels.length - 1) + " \u00b7 ") : "";
          sub = dd + RSC.tuningName(a.doc.tuning, l.strings) + (a.doc.capo ? " \u00b7 capo " + a.doc.capo : "") + " \u00b7 " + (lv.notes.length + lv.chords.length) + " notes" + (a.edited ? " \u00b7 edited" : "");
          if (a.dd && a.dd.view != null) d.classList.add("is-level");
          const st = this.laneState[l.id] || {};
          btns = '<button class="rsc-hb' + (st.guide ? " is-g" : "") + '" data-hact="guide" title="Guide tones: hear this chart">' + ICON.headphones + "</button>" +
            '<button class="rsc-hb" data-hact="collapse" title="Collapse / expand">' + (st.collapsed ? "+" : "\u2212") + "</button>";
        } else if (l.kind === "vocals") {
          color = "#f5a524";
          sub = p.vocals && p.vocals.syllables.length ? p.vocals.syllables.length + " syllables" : "no lyrics";
        }
        d.innerHTML = (color ? '<span class="rsc-head-dot" style="background:' + color + '"></span>' : "") +
          '<div class="rsc-head-text"><span class="rsc-head-name">' + esc(l.name) + "</span>" + (sub ? '<span class="rsc-head-sub">' + esc(sub) + "</span>" : "") + "</div>" +
          (btns ? '<div class="rsc-head-btns">' + btns + "</div>" : "");
        d.addEventListener("click", (e) => {
          const b = e.target.closest("[data-hact]");
          if (b) { this.headAction(l, b.dataset.hact); return; }
          this.selectLane(l.id);
        });
        h.appendChild(d);
      }
    }
    headAction(l, a) {
      if (l.kind === "wave") {
        const lane = this.audio.lanes[l.audio] || {};
        if (a === "mute") this.audio.setLane(l.audio, { mute: !lane.mute });
        if (a === "solo") this.audio.setLane(l.audio, { solo: !lane.solo });
      } else if (l.kind === "arr") {
        const st = (this.laneState[l.id] = this.laneState[l.id] || {});
        if (a === "guide") { st.guide = !st.guide; this.refreshGuides(); }
        if (a === "collapse") { st.collapsed = !st.collapsed; this.buildLanes(); }
      }
      this.renderHeads(); this.draw();
    }
    refreshGuides() {
      const p = this.project;
      if (!p) return;
      this.audio.guides = p.arrangements.map((a, i) => ({ on: !!(this.laneState["arr:" + i] || {}).guide, bass: a.kind === "bass",
        notes: RSC.AudioEngine.guideNotes(a.doc, a.kind === "bass") }));
    }
    selectLane(id) {
      this.sel = { lane: id, kind: null, items: [] };
      this.renderHeads(); this.draw(); this.renderInspector();
      this.emit("select", this.sel);
    }
    laneAt(y) { for (const l of this.lanes || []) if (y >= l.y && y < l.y + l.h) return l; return null; }

    // ---------------------------------------------------------------------------------------------
    // view
    resize() {
      const w = Math.max(50, this.wrap.clientWidth), h = Math.max(50, this.lanesH || 200), dpr = root.devicePixelRatio || 1;
      for (const c of [this.canvas, this.over]) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + "px"; c.style.height = h + "px";
      }
      this.wrap.style.height = h + "px";
      this.W = w; this.H = h; this.dpr = dpr;
      const ov = this.overview.firstChild;
      ov.width = Math.round(this.overview.clientWidth * dpr); ov.height = Math.round(this.overview.clientHeight * dpr);
      this.root.classList.toggle("is-compact", this.root.clientWidth < 900);
      this.clampView();
      this.draw();
    }
    viewDur() { return this.W / this.view.pps; }
    clampView() {
      const d = this.duration(), vd = this.viewDur();
      this.view.t0 = Math.max(-0.5, Math.min(this.view.t0, d - vd * 0.5));
    }
    x(t) { return (t - this.view.t0) * this.view.pps; }
    t(x) { return this.view.t0 + x / this.view.pps; }
    zoom(f, atX) {
      const ax = atX == null ? this.W / 2 : atX, ta = this.t(ax);
      this.view.pps = Math.max(4, Math.min(2400, this.view.pps * f));
      this.view.t0 = ta - ax / this.view.pps;
      this.clampView(); this.draw();
    }
    fit() { this.view.pps = Math.max(4, (this.W - 20) / this.duration()); this.view.t0 = 0; this.clampView(); this.draw(); }
    centerOn(t, force) { const vd = this.viewDur(); if (force || t < this.view.t0 || t > this.view.t0 + vd) this.view.t0 = t - vd * 0.3; else this.view.t0 = t - vd / 2; this.clampView(); this.draw(); }

    // ---- the grid (beats and their subdivisions) ----
    snapTime(t, force) {
      const b = this.project ? this.project.beats : [];
      if (!(this.snap || force) || b.length < 2) return Math.round(t * 1000) / 1000;
      const s = this.snap || 4;
      let i = lowerBound(b, t, "time") - 1;
      i = Math.max(0, Math.min(b.length - 2, i));
      const t0 = b[i].time, t1 = b[i + 1].time, step = (t1 - t0) / s;
      let k = Math.round((t - t0) / step);
      return Math.round((t0 + k * step) * 1000) / 1000;
    }
    gridStep(t) {
      const b = this.project.beats;
      if (b.length < 2) return 0.25;
      let i = Math.max(0, Math.min(b.length - 2, lowerBound(b, t, "time") - 1));
      return (b[i + 1].time - b[i].time) / (this.snap || 4);
    }
    /** "bar.beat" of a time. */
    barBeat(t) {
      const b = this.project ? this.project.beats : [];
      if (!b.length) return "";
      let i = Math.max(0, lowerBound(b, t + 1e-6, "time") - 1);
      let bar = 0, beat = 0;
      for (let k = 0; k <= i; k++) { if (b[k].measure >= 0) { bar = b[k].measure; beat = 1; } else beat++; }
      return bar + "." + beat;
    }

    // ---------------------------------------------------------------------------------------------
    // drawing
    loop() {
      requestAnimationFrame(this.loop);
      if (!this.project) return;
      this.audio.tick();
      const t = this.audio.time();
      if (this.audio.playing) {
        if (this.view.follow) {
          const vd = this.viewDur();
          if (t > this.view.t0 + vd * 0.85 || t < this.view.t0) { this.view.t0 = t - vd * 0.1; this.clampView(); this.draw(); }
        }
        this.drawOver();
      }
      if (this._lastT !== t) {
        this._lastT = t;
        const tr = this.transport;
        tr.querySelector('[data-role="time"]').textContent = fmtTime(t, true);
        tr.querySelector('[data-role="pos"]').textContent = this.barBeat(t);
        if (!this.audio.playing) this.drawOver();
      }
    }
    draw() {
      if (!this.project || !this.lanes) return;
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this.drawNow());
    }
    drawNow() {
      RSC.drawTimeline(this);
      this.drawOverview();
      this.drawOver();
      const th = this.hscroll.firstChild, d = this.duration(), w = this.hscroll.clientWidth;
      th.style.left = Math.max(0, this.view.t0 / d * w) + "px";
      th.style.width = Math.max(24, Math.min(w, this.viewDur() / d * w)) + "px";
      this.transport.querySelector('[data-role="dur"]').textContent = "/ " + fmtTime(d);
    }
    drawOverview() {
      const c = this.overview.firstChild, g = c.getContext("2d"), w = c.width, h = c.height, d = this.duration(), p = this.project;
      g.clearRect(0, 0, w, h);
      p.sections.forEach((s, i) => {
        const x0 = s.startTime / d * w, x1 = (i + 1 < p.sections.length ? p.sections[i + 1].startTime : d) / d * w;
        g.fillStyle = RSC.sectionColor(s.name); g.globalAlpha = 0.28; g.fillRect(x0, 0, x1 - x0, h); g.globalAlpha = 1;
      });
      const pk = this.audio.peaks && this.audio.peaks.mix;
      if (pk) {
        g.fillStyle = "rgba(210,218,236,0.55)";
        const n = pk.length / 2;
        for (let x = 0; x < w; x++) {
          const a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 1) / w * n));
          let lo = 0, hi = 0;
          for (let i = a; i < b; i++) { if (pk[2 * i] < lo) lo = pk[2 * i]; if (pk[2 * i + 1] > hi) hi = pk[2 * i + 1]; }
          g.fillRect(x, h / 2 - hi * h * 0.45, 1, Math.max(1, (hi - lo) * h * 0.45));
        }
      }
      const vx = this.view.t0 / d * w, vw = this.viewDur() / d * w;
      g.strokeStyle = "rgba(245,165,36,0.9)"; g.lineWidth = 1.5 * this.dpr; g.strokeRect(vx, 1, vw, h - 2);
      g.fillStyle = "rgba(245,165,36,0.08)"; g.fillRect(vx, 0, vw, h);
    }
    drawOver() {
      const c = this.over, g = c.getContext("2d");
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.clearRect(0, 0, this.W, this.H);
      if (!this.project) return;
      const L = this.audio.loop;
      if (L.b > L.a) {
        g.fillStyle = L.on ? "rgba(245,165,36,0.10)" : "rgba(255,255,255,0.05)";
        g.fillRect(this.x(L.a), 0, (L.b - L.a) * this.view.pps, this.H);
        g.fillStyle = L.on ? "#f5a524" : "rgba(255,255,255,0.35)";
        g.fillRect(this.x(L.a) - 1, 0, 2, 26); g.fillRect(this.x(L.b) - 1, 0, 2, 26);
      }
      if (this.marquee) {
        const m = this.marquee;
        g.fillStyle = "rgba(245,165,36,0.12)"; g.strokeStyle = "rgba(245,165,36,0.8)"; g.lineWidth = 1;
        g.fillRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0); g.strokeRect(m.x0 + 0.5, m.y0 + 0.5, m.x1 - m.x0, m.y1 - m.y0);
      }
      if (this.ghost) { g.globalAlpha = 0.55; RSC.drawGhost(this, g, this.ghost); g.globalAlpha = 1; }
      const x = this.x(this.audio.time());
      if (x >= -2 && x <= this.W + 2) {
        g.fillStyle = "#fff"; g.shadowColor = "rgba(255,255,255,0.8)"; g.shadowBlur = 6;
        g.fillRect(Math.round(x) - 1, 0, 2, this.H); g.shadowBlur = 0;
        g.fillStyle = "#f5a524"; g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x, 8); g.closePath(); g.fill();
      }
    }
    renderCard() {
      const p = this.project, c = this.card;
      if (!p) return;
      const m = p.meta;
      c.querySelector(".rsc-card-title").textContent = m.title || "Untitled";
      c.querySelector(".rsc-card-sub").textContent = [m.artist, m.album, m.year].filter(Boolean).join(" \u00b7 ");
      const chips = [];
      chips.push('<span class="rsc-chip is-accent">' + (E.PLATFORMS[p.platform] || {}).label + "</span>");
      chips.push('<span class="rsc-chip">' + p.arrangements.length + " chart" + (p.arrangements.length === 1 ? "" : "s") + "</span>");
      if (p.beats.length > 1) chips.push('<span class="rsc-chip">\u2669 ' + Math.round(E.averageTempo(p.beats)) + " BPM</span>");
      if (p.vocals && p.vocals.syllables.length) chips.push('<span class="rsc-chip">Lyrics</span>');
      if (this.audio.stems) chips.push('<span class="rsc-chip is-ok">Stems</span>');
      const dd = Math.max(0, ...p.arrangements.map((a) => (a.dd ? a.dd.levels.length : 0)));
      if (dd > 1) chips.push('<span class="rsc-chip" title="Difficulty levels (dynamic difficulty)">' + dd + " levels</span>");
      chips.push(this.dirty ? '<span class="rsc-chip is-dirty">Unsaved changes</span>' : '<span class="rsc-chip">' + (this.savedOnce ? "Saved" : "Unchanged") + "</span>");
      c.querySelector(".rsc-chips").innerHTML = chips.join("");
      const art = c.querySelector(".rsc-art");
      this.artUrl(p).then((url) => {
        if (url) { art.classList.remove("is-empty"); art.innerHTML = ""; art.style.backgroundImage = "url(" + url + ")"; }
        else { art.classList.add("is-empty"); art.innerHTML = ICON.song; art.style.backgroundImage = ""; }
      });
    }
    async artUrl(p) {
      const names = (p.art && p.art.names) || [];
      const best = names.find((n) => /_256\.dds$/.test(n)) || names[0];
      if (!best || !this.source.has(best)) return null;
      if (this._artKey === best + (p.art.replaced ? "*" : "")) return this._artUrl;
      try {
        const img = E.ddsDecode(await this.source.read(best));
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
        cv.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
        this._artKey = best + (p.art.replaced ? "*" : ""); this._artUrl = cv.toDataURL("image/png");
        return this._artUrl;
      } catch (e) { return null; }
    }

    // ---------------------------------------------------------------------------------------------
    // pointer
    pos(e) { const r = this.wrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    onDown(e) {
      if (!this.project) return;
      this.tipEl.classList.remove("is-on");
      this.root.focus({ preventScroll: true });
      const { x, y } = this.pos(e), lane = this.laneAt(y);
      if (!lane) return;
      this.wrap.setPointerCapture(e.pointerId);
      const t = this.t(x);
      // ruler, or Shift on any lane: seek / loop range
      if (lane.kind === "ruler" || (e.shiftKey && lane.kind === "wave")) {
        this.drag = { kind: "range", x0: x, t0: t, moved: false };
        return;
      }
      const hit = RSC.hitTest(this, lane, x, y);
      if (this.tool === "erase") { if (hit) RSC.eraseHit(this, lane, hit); return; }
      if (this.tool === "draw" && !hit) { RSC.drawAt(this, lane, x, y, e); return; }
      if (hit) {
        const already = this.isSelected(hit.item);
        if (e.ctrlKey || e.metaKey) { this.toggleSelect(lane, hit); this.drag = null; return; }
        if (!already) this.select(lane, hit.kind, [hit.item], e.shiftKey);
        this.drag = { kind: hit.edge ? "resize" : "move", lane, hit, x0: x, y0: y, t0: t, moved: false, edge: hit.edge };
        return;
      }
      if (lane.kind === "wave") { this.audio.seek(this.snapTime(t)); this.selectLane(lane.id); return; }
      // empty space: marquee (and clear the selection)
      if (!e.shiftKey) this.clearSelection(lane.id);
      this.drag = { kind: "marquee", lane, x0: x, y0: y, moved: false };
    }
    onMove(e) {
      if (!this.project) return;
      const { x, y } = this.pos(e);
      const d = this.drag;
      if (!d) { this.hover(x, y); return; }
      if (Math.abs(x - d.x0) + Math.abs(y - (d.y0 || y)) > 3) d.moved = true;
      if (!d.moved) return;
      if (d.kind === "range") {
        const a = Math.max(0, Math.min(d.t0, this.t(x))), b = Math.max(d.t0, this.t(x));
        this.audio.loop.a = this.snapTime(a); this.audio.loop.b = this.snapTime(b);
        this.drawOver();
      } else if (d.kind === "marquee") {
        this.marquee = { x0: Math.min(d.x0, x), x1: Math.max(d.x0, x), y0: Math.max(d.lane.y, Math.min(d.y0, y)), y1: Math.min(d.lane.y + d.lane.h, Math.max(d.y0, y)) };
        this.drawOver();
      } else if (d.kind === "move" || d.kind === "resize") {
        this.ghost = RSC.dragPreview(this, d, x, y, e);
        this.drawOver();
        this.tip(x, y, this.ghost && this.ghost.tip);
      }
    }
    onUp(e) {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      const { x, y } = this.pos(e);
      if (d.kind === "range") {
        if (!d.moved) { this.audio.seek(Math.max(0, this.snapTime(d.t0))); this.audio.loop.on = false; }
        else this.audio.loop.on = true;
        this.syncButtons(); this.drawOver();
      } else if (d.kind === "marquee") {
        if (d.moved && this.marquee) RSC.marqueeSelect(this, d.lane, this.marquee, e.shiftKey);
        else if (!d.moved) { this.audio.seek(this.snapTime(this.t(x))); }
        this.marquee = null; this.drawOver();
      } else if ((d.kind === "move" || d.kind === "resize") && d.moved) {
        RSC.dragCommit(this, d, x, y, e);
        this.ghost = null; this.tipEl.classList.remove("is-on"); this.drawOver();
      } else if (d.kind === "move" && !d.moved && !e.shiftKey) {
        // a click on an already selected item among several selects just that one
        if (this.sel.items.length > 1 && d.hit) this.select(d.lane, d.hit.kind, [d.hit.item], false);
        if (d.lane.kind === "vocals" || d.lane.kind === "sections" || d.lane.kind === "beats") this.audio.seek(d.hit.time != null ? d.hit.time : this.t(x));
      }
    }
    onDbl(e) {
      if (!this.project) return;
      const { x, y } = this.pos(e), lane = this.laneAt(y);
      if (lane) RSC.doubleClick(this, lane, x, y);
    }
    onWheel(e) {
      if (!this.project) return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(Math.pow(1.0015, -e.deltaY), this.pos(e).x); return; }
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (dx) { e.preventDefault(); this.view.t0 += dx / this.view.pps; this.clampView(); this.draw(); }
    }
    hover(x, y) {
      const lane = this.laneAt(y);
      if (!lane) return;
      const hit = RSC.hitTest(this, lane, x, y);
      this.wrap.classList.toggle("is-resize", !!(hit && hit.edge));
      if (hit && hit.tip) this.tip(x, y, hit.tip); else this.tipEl.classList.remove("is-on");
    }
    tip(x, y, text) {
      if (!text) { this.tipEl.classList.remove("is-on"); return; }
      const r = this.wrap.getBoundingClientRect(), R = this.root.getBoundingClientRect();
      this.tipEl.textContent = text; this.tipEl.classList.add("is-on");
      const w = this.tipEl.offsetWidth || 160, base = r.left - R.left;
      const left = (x + 14 + w > r.width - 4) ? base + x - 14 - w : base + x + 14;
      this.tipEl.style.left = Math.max(base + 4, left) + "px";
      this.tipEl.style.top = (r.top - R.top + y - 30) + "px";
    }

    // ---- selection ----
    isSelected(item) { return this.sel.items.includes(item); }
    select(lane, kind, items, add) {
      if (add && this.sel.lane === lane.id && this.sel.kind === kind) items = this.sel.items.concat(items.filter((i) => !this.sel.items.includes(i)));
      this.sel = { lane: lane.id, kind, items };
      this.renderHeads(); this.draw(); this.renderInspector();
      this.emit("select", this.sel);
    }
    toggleSelect(lane, hit) {
      if (this.sel.lane !== lane.id || this.sel.kind !== hit.kind) { this.select(lane, hit.kind, [hit.item]); return; }
      const i = this.sel.items.indexOf(hit.item);
      if (i >= 0) this.sel.items.splice(i, 1); else this.sel.items.push(hit.item);
      this.draw(); this.renderInspector();
    }
    clearSelection(laneId) {
      this.sel = { lane: laneId || this.sel.lane, kind: null, items: [] };
      if (this.project) { this.renderHeads(); this.draw(); this.renderInspector(); }
    }
    renderInspector() { if (RSC.renderInspector) RSC.renderInspector(this); }

    // ---------------------------------------------------------------------------------------------
    // keyboard
    onKey(e) {
      this.tipEl.classList.remove("is-on");
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
      if (e.key === "?" && RSC.help) { e.preventDefault(); e.stopPropagation(); RSC.help.open(this); return; }
      if (!this.project) return;
      const k = e.key, mod = e.ctrlKey || e.metaKey;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (mod && (k === "z" || k === "Z")) { stop(); if (e.shiftKey) this.redo(); else this.undo(); return; }
      if (mod && (k === "y" || k === "Y")) { stop(); this.redo(); return; }
      if (mod && (k === "a" || k === "A")) { stop(); RSC.selectAll(this); return; }
      if (mod && (k === "c" || k === "C")) { stop(); RSC.copy(this); return; }
      if (mod && (k === "v" || k === "V")) { stop(); RSC.paste(this); return; }
      if (mod) return;
      if (this.tapping && (k === "t" || k === "T" || k === "Enter")) { stop(); RSC.tapLine(this); return; }
      switch (k) {
        case " ": stop(); this.audio.toggle(); return;
        case "Home": stop(); this.act("home"); return;
        case "End": stop(); this.audio.seek(this.duration()); return;
        case "+": case "=": stop(); this.zoom(1.5); return;
        case "-": case "_": stop(); this.zoom(1 / 1.5); return;
        case "0": if (!this.sel.items.length) { stop(); this.fit(); return; } break;
        case "v": case "V": if (this.sel.kind !== "note" && this.sel.kind !== "chord") { stop(); this.setTool("select"); return; } break;
        case "d": case "D": stop(); this.setTool("draw"); return;
        case "e": case "E": if (!this.sel.items.length || this.sel.kind !== "note") { stop(); this.setTool("erase"); return; } break;
        case "l": case "L": stop(); this.act("loop"); return;
        case "m": case "M": if (this.sel.kind !== "note" && this.sel.kind !== "chord") { stop(); this.act("metro"); return; } break;
        case "f": case "F": stop(); this.act("follow"); return;
        case "g": case "G": { stop(); const opts = SNAPS.map((s) => s[1]); this.snap = opts[(opts.indexOf(this.snap) + 1) % opts.length]; this.root.querySelector('[data-role="snap"]').value = String(this.snap); this.toast("Grid " + SNAPS.find((s) => s[1] === this.snap)[0]); this.draw(); return; }
        case "Escape": stop(); this.clearSelection(); this.tapping = false; return;
        case "Delete": case "Backspace": stop(); RSC.deleteSelection(this); return;
        case "ArrowLeft": case "ArrowRight":
          stop();
          if (this.sel.items.length) RSC.nudge(this, k === "ArrowLeft" ? -1 : 1, e.altKey);
          else this.audio.seek(this.audio.time() + (k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 5));
          return;
        case "ArrowUp": case "ArrowDown":
          if (this.sel.items.length) { stop(); RSC.moveVertical(this, k === "ArrowUp" ? 1 : -1, e.altKey); }
          return;
        case "[": case "]": if (this.sel.items.length) { stop(); RSC.nudgeMs(this, k === "[" ? -10 : 10); } return;
        case "q": case "Q": if (this.sel.items.length) { stop(); RSC.quantize(this); } return;
        case "PageUp": case "PageDown": { const i = this.levelArr(); if (i != null) { stop(); this.levelStep(i, k === "PageUp" ? 1 : -1); } return; }
      }
      if (RSC.techKey && RSC.techKey(this, e)) stop();
    }

    // ---------------------------------------------------------------------------------------------
    onAudio(type) {
      if (type === "play" || type === "pause" || type === "ended") this.syncButtons();
      if (type === "stems") { this.buildLanes(); this.renderCard(); this.renderInspector(); }
      if (type === "lanes") this.renderHeads();
      if (type === "seek" || type === "pause") this.drawOver();
      if ((type === "seek" || type === "pause") && this.insTab === "levels" && this.project) this.renderInspector();   // the phrase at the playhead
    }

    // ---- difficulty levels ----
    /** The chart the level controls act on: the selected chart lane, else the last one used, else the first. */
    levelArr() {
      const p = this.project;
      if (!p || !p.arrangements.length) return null;
      const l = (this.lanes || []).find((x) => x.id === this.sel.lane);
      if (l && l.kind === "arr") this.ddArr = l.arr;
      if (this.ddArr == null || !p.arrangements[this.ddArr]) this.ddArr = 0;
      return this.ddArr;
    }
    /** Ghost notes for the charts shown at an easier level (what the hardest chart plays there). */
    refreshGhosts() {
      this.ghosts = {};
      const p = this.project;
      if (!p) return;
      p.arrangements.forEach((a, i) => { if (a.dd && a.dd.view != null) this.ghosts[i] = E.ddGhost(a); });
    }
    /** Show chart i at difficulty level k (null: the hardest chart). Not an edit (undo returns to the level an edit was made on). */
    showLevel(i, k) {
      const a = this.project && this.project.arrangements[i];
      if (!a || !a.dd) return;
      E.ddShow(a, k);
      this.refreshGhosts();
      this.ddArr = i;
      this.sel = { lane: "arr:" + i, kind: null, items: [] };
      this.renderHeads(); this.refreshGuides(); this.draw(); this.renderInspector();
      this.toast(a.name + ": " + (a.dd.view == null ? "the full chart" : "level " + a.dd.view + (a.dd.view === 0 ? " (easiest)" : "") + " \u2014 dashed notes are only in the full chart"));
      this.emit("change", { what: ["view"] });
    }
    /** PageUp / PageDown: one level harder / easier (past the top: the hardest chart). */
    levelStep(i, delta) {
      const a = this.project.arrangements[i];
      if (!a || !a.dd) { this.toast(a ? a.name + " has no easier levels yet: create them in the Levels tab" : "No chart", "error"); return; }
      const top = a.dd.levels.length - 1, cur = a.dd.view == null ? top + 1 : a.dd.view;
      const next = Math.max(0, Math.min(top + 1, cur + delta));
      this.showLevel(i, next > top ? null : next);
    }

    /** Save the package: -> Uint8Array (.psarc). opts.platform: "pc" | "mac". */
    async save(opts) {
      opts = opts || {};
      if (!this.project) throw new Error("Nothing to save.");
      this.busy("Building the package\u2026", "Compiling the charts, packing the archive");
      try {
        RSC.prepareForSave(this.project);
        const bytes = await E.projectSave(this.project, this.source, { platform: opts.platform });
        this.dirty = false; this.savedOnce = true; this.renderCard();
        this.emit("save", { bytes, platform: opts.platform || this.project.platform });
        return bytes;
      } finally { this.busy(null); }
    }
  }
  RSC.Studio = Studio;
})(typeof window !== "undefined" ? window : globalThis);
