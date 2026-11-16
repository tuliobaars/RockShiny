/* ---------------------------------------------------------------------------
 * binding.js -- Shiny output binding + per-element controller.
 *
 * HighwayController owns: the renderer (canvas or DOM), the SongClock, the
 * <audio> element, the HTML overlays (song card, lyrics, countdown,
 * transport), the practice loop, keyboard shortcuts and the rAF loop.
 *
 * Channels:
 *   renderValue(el, {chart: "<json>", options})        chart (once per arrangement)
 *   custom message "rs-highway" {id, cmd, args}         audio / settings / transport
 *   Shiny input <id>_ready {songKey, hasAudio, formats} chart is on screen
 *   Shiny input <id>_state {t, playing, section, ...}   ~4 Hz telemetry
 *   Shiny input <id>_section_pick {index}               double-click on a section
 *   Shiny input <id>_loop_toggle                        "L" key / loop badge
 *   Shiny input <id>_benchmark {results, ...}           renderer benchmark
 *   Shiny input <id>_judge {hits, misses, ...}          live scoring summary (~2 Hz)
 *   Shiny input <id>_result {kind, accuracy, ...}       end of song / loop pass
 *   Shiny input <id>_input_status {source, ok, error}   input source started / failed
 *   Shiny input <id>_devices {devices, current, ...}    microphone inputs (after permission)
 *   Shiny input <id>_calibration {ok, latencyMs, ...}   input latency calibration
 *   Shiny input <id>_ended {songKey, nonce}             the song played to its end (play queue)
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});
  const controllers = new Map();

  function h(tag, cls, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  // Formats the R side may encode (ids must match AUDIO_FORMATS in R/audio.R).
  const AUDIO_MIME = {
    ogg: 'audio/ogg; codecs="vorbis"', m4a: 'audio/mp4; codecs="mp4a.40.2"',
    opus: 'audio/ogg; codecs="opus"', flac: "audio/flac", wav: 'audio/wav; codecs="1"',
  };
  function playableFormats() {
    const a = document.createElement("audio");
    return Object.keys(AUDIO_MIME).filter((k) => a.canPlayType(AUDIO_MIME[k]) !== "");
  }
  function setInput(name, value) {
    if (root.Shiny && root.Shiny.setInputValue) root.Shiny.setInputValue(name, value, { priority: "event" });
  }

  function inputErrorText(err) {
    const n = err && err.name;
    if (!root.isSecureContext) return "the microphone needs a secure page (https:// or http://localhost).";
    if (n === "NotAllowedError" || n === "SecurityError") return "microphone permission was denied (allow it in the browser's site settings).";
    if (n === "NotFoundError") return "no audio input found (connect a microphone or audio interface).";
    if (n === "OverconstrainedError") return "the selected input device is not available (pick another one).";
    if (n === "NotReadableError") return "the input device is busy or unavailable.";
    return (err && err.message) || String(err);
  }

  class HighwayController {
    constructor(el) {
      this.el = el;
      this.id = el.id;
      el.classList.add("rs-hw");
      el.innerHTML = "";
      this.canvas = h("canvas", "rs-hw-canvas", el);
      this.empty = h("div", "rs-hw-empty", el);
      this.empty.innerHTML = '<div class="rs-hw-empty-icon"><svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg></div>' +
        "<div><b>No song loaded</b><br><span>Drop a Rocksmith <code>.psarc</code> on the sidebar, or pick one from the library.</span></div>";
      this.hud = new NS.HudView(el);
      this.feedback = new NS.FeedbackView(el);
      this.lyrics = new NS.LyricsView(el);
      this.countdown = new NS.CountdownView(el);
      this.banner = h("div", "rs-hw-banner", el);
      this.hud.hide();

      this.renderOpts = {};
      this.rendererKind = null;
      // input & judgement: sources (keyboard, microphone) push to the bus, the judge
      // matches events to notes, renderers read judge.state
      this.bus = new NS.InputBus();
      this.judge = new NS.HitJudge();
      this.judge.onJudged = (r) => { this._judgeDirty = true; if (r.type === "hit") this._lastJudged = r; };
      this.inputSource = null;
      this.inputOpts = { deviceId: null, echoCancellation: false, sensitivity: 1, latencyMs: null };
      // a detector that already mapped its onset to chart time (mic.js) passes ev.chartTime
      this.bus.on("hit", (ev) => this.judge.judgeHit(ev.chartTime != null ? ev.chartTime : this.chartTime(ev.at), ev));
      this.bus.on("miss", (ev) => this.judge.judgeMiss(this.chartTime(ev.at)));
      this.setRenderer("canvas");
      this.clock = new NS.SongClock();
      this.clock.onStateChange = (_c, err) => {
        this._syncTransport();
        if (err) this.status(`Playback blocked: ${err.message || err}`, "error");
      };
      this.clock.onEnded = () => {                        // the song played to its end (-> <id>_ended: the app's play queue)
        this._syncTransport(); this._finishRun();
        setInput(this.id + "_ended", { songKey: this.songKey, nonce: Date.now() });
      };
      this.chart = null;
      this.songKey = null;
      this.audio = null;
      this.audioUrl = null;
      this.avOffset = 0;
      this.frameLead = 1 / 60;           // present-time prediction (EMA of the frame interval)
      this.audioOut = new NS.AudioOut(); // Web Audio routing -> known output latency
      this.guide = new NS.GuideSynth(this.audioOut);   // guide tones (the only sound of MIDI songs)
      this.guide.pitchOf = (i) => (this.judge.kind[i] === NS.NOTE_KIND.PITCHED ? this.judge.midi[i] : null);
      this.autoLatency = true;
      this._lat = 0;                     // output latency currently compensated (s)
      this._latReported = 0;
      this._lastNoteEnd = 0;             // chart time after which a scored run is complete
      this.audioKind = null;             // null | "head" (quick-start clip) | "full"
      this.headLimit = Infinity;
      this.fps = 0;
      this.practice = { loop: false, start: 0, end: 0, leadIn: 2, ramp: 0 };
      this.loopCount = 0;
      this._rateSetting = 1;
      this._lastFrame = 0;
      this._lastUi = 0;
      this._lastTelemetry = 0;
      this._raf = 0;
      this.transport = new NS.TransportView(el, {
        toggle: () => this.togglePlay(),
        restart: () => this.seek(this.practice.loop ? this._loopFrom() : 0),
        seek: (t) => this.seek(t),
        pickSection: (i) => setInput(this.id + "_section_pick", { index: i, nonce: Date.now() }),
        toggleLoop: () => setInput(this.id + "_loop_toggle", Date.now()),
      });
      this.results = new NS.ResultsView(el, {
        close: () => this.el.focus({ preventScroll: true }),
        replay: () => { this.seek(this.practice.loop ? this._loopFrom() : 0); if (!this.clock.playing) this.togglePlay(); },
        practice: (i) => setInput(this.id + "_section_pick", { index: i, nonce: Date.now() }),
      });
      this._syncTransport();

      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(el);
      this._resize();
      this._onKey = (e) => this._key(e);
      document.addEventListener("keydown", this._onKey);
      this._loop = this._loop.bind(this);
    }

    // ---- data ----------------------------------------------------------------
    load(data) {
      if (!data || !data.chart) { this.clear(); return; }
      const json = typeof data.chart === "string" ? JSON.parse(data.chart) : data.chart;
      const chart = NS.prepareChart(json);
      chart.art = json.art || null;
      const sameSong = chart.songKey && chart.songKey === this.songKey;
      if (!sameSong) {
        this._unloadAudio();
        this.clock.pause();
        this.clock.seek(0);
        this.loopCount = 0;
      }
      const prevWindow = this.chart && NS.analysisWindow ? NS.analysisWindow(this.chart) : null;
      this.songKey = chart.songKey;
      this.chart = chart;
      this._applyRenderer();                                            // piano / harmonica: lane renderer
      this._runReported = false;
      this.results.root.style.display = "none";
      this.clock.duration = Math.max(chart.duration, this.audio && isFinite(this.audio.duration) ? this.audio.duration : 0);
      this.renderer.setChart(chart);
      this.judge.setChart(chart);
      this.guide.setChart(chart);
      this._lastNoteEnd = 0;                                           // results once the last note is done
      for (let i = Math.max(0, chart.notes.n - 64); i < chart.notes.n; i++) {
        this._lastNoteEnd = Math.max(this._lastNoteEnd, chart.notes.t[i] + chart.notes.sus[i]);
      }
      this._judgeDirty = true;
      // the analysis window depends on the lowest notes (bass, low piano: longer): restart the microphone
      if (this.inputSource && this._inputSetting === "microphone" && prevWindow != null && prevWindow !== NS.analysisWindow(chart)) this.setInputSource("microphone");
      this.hud.setChart(chart);
      this.lyrics.setVocals(json.vocals || null);
      if (data.options) this.settings(data.options);
      this.transport.setChart(chart, this.clock.duration);
      this.transport.setLoop(this.practice);
      this.empty.style.display = "none";
      this.el.classList.add("has-chart");
      this._syncTransport();
      this._start();
      setInput(this.id + "_ready", { songKey: this.songKey, audio: this.audioKind || "none", hasAudio: this.audioKind === "full",
                                     formats: playableFormats(), nonce: Date.now() });
    }

    clear() {
      this._unloadAudio();
      this.chart = null;
      this.renderer.setChart(null);
      this.hud.hide();
      this.lyrics.setVocals(null);
      this.transport.setChart(null, 0);
      this.el.classList.remove("has-chart");
      this.empty.style.display = "";
      this._stop();
      this._drawOnce();
    }

    /**
     * Attach audio. kind "head" = quick-start clip of the first `seconds`
     * (playback can start right away); kind "full" = the whole song. A full
     * file arriving while the clip plays is handed over seamlessly.
     */
    async setAudio(url, songKey, kind, seconds) {
      kind = kind === "head" ? "head" : "full";
      if (songKey && songKey !== this.songKey) return;                 // stale message
      if (this.audioKind === "full" || (kind === "head" && this.audioKind === "head")) return;
      if (!this.audio) this.status(kind === "head" ? "Loading quick-start audio\u2026" : "Loading audio\u2026", "info");
      let audio;
      try {
        // Fetch into a Blob: seeking a blob: URL never depends on server Range support.
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (songKey && songKey !== this.songKey) return;
        if (this.audioKind === "full") return;                        // full won the race
        audio = new Audio();
        audio.preload = "auto";
        audio._url = URL.createObjectURL(blob);
        audio.src = audio._url;
        // Join the audio graph (for latency compensation) only while nothing is
        // playing: a graph source starting during playback disturbed the playing
        // audio in our measurements (~50 ms skips). The quick-start clip never
        // joins; a full file handed over during playback joins at the next
        // pause / seek / loop wrap (_joinGraph).
        if (kind === "full" && !this.clock.playing) this._joinGraph(audio);
        await new Promise((resolve, reject) => {
          audio.addEventListener("canplaythrough", resolve, { once: true });
          audio.addEventListener("error", () => reject(new Error("browser cannot decode this audio format")), { once: true });
        });
      } catch (e) {
        this.status(`Audio failed: ${e.message}`, "error");
        return;
      }
      if (kind === "full" && this.audioKind === "head" && this.audio && this.clock.playing && !this.clock.holding) {
        await this._handoverTo(audio);                                 // seamless, while playing
      } else {
        this._unloadAudio();
        this.audio = audio; this.audioUrl = audio._url;
        this.clock.partialAudio = kind === "head";
        this.clock.attach(audio);                                      // resumes a hold if playing
      }
      this.audioKind = kind;
      this.headLimit = kind === "head" ? Math.max(0, (+seconds || audio.duration || 0) - 0.25) : Infinity;
      if (kind === "full" && isFinite(audio.duration)) {
        this.clock.duration = Math.max(this.clock.duration, audio.duration);
        this.transport.setChart(this.chart, this.clock.duration);
        this.transport.setLoop(this.practice);
      }
      this.status("", "clear");
      this._syncTransport();
    }

    /**
     * Swap the playing quick-start clip for the full file without a gap:
     * 1. start the full file muted slightly ahead of the clip;
     * 2. align it by nudging its playbackRate (muted, so pitch is irrelevant)
     *    until both report the same position within a few ms;
     * 3. cross-fade over 80 ms and make it the clock master (clock.handover).
     */
    async _handoverTo(full) {
      const head = this.audio, rate = this.clock.rate, vol = NS.AudioOut.setVolume;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      full.muted = true;
      full.preservesPitch = true;
      full.playbackRate = rate;
      full.currentTime = head.currentTime + 0.08;
      try { await full.play(); } catch (e) { /* falls back to a plain swap below */ }
      // align by rate nudging; then join the graph (if the clip is routed) and
      // re-align briefly, since joining can shift the new element's timeline
      let smooth = null, aligned = false;
      const align = async (limitMs) => {
        smooth = null; aligned = false;
        const t0 = performance.now();
        while (performance.now() - t0 < limitMs && !full.paused) {
          await frame();
          if (head.paused || !this.clock.playing || this.audio !== head) return;
          const d = full.currentTime - head.currentTime;             // + = full ahead
          if (Math.abs(d) > 0.5) { full.currentTime = head.currentTime + 0.08; smooth = null; continue; }
          smooth = smooth == null ? d : smooth * 0.6 + d * 0.4;
          if (Math.abs(smooth) < 0.006) { aligned = true; return; }
          full.playbackRate = rate * (1 - Math.max(-0.12, Math.min(0.12, smooth * 3)));
        }
      };
      await align(4000);
      // (the full file stays native for now; it joins the audio graph at the next
      //  pause / seek / loop wrap -- see _joinGraph())
      full.playbackRate = rate;
      this.handoverError = aligned ? smooth : null;                   // exposed for tests
      if (!aligned || full.paused || this.audio !== head || !this.clock.playing) {
        full.pause(); full.muted = false;                              // plain swap at the current position
        this._unloadAudio();
        this.audio = full; this.audioUrl = full._url;
        this.clock.partialAudio = false;
        this.clock.attach(full);
        return;
      }
      vol(full, 0); full.muted = false;
      const old = this.clock.handover(full);
      this.clock.partialAudio = false;
      this.audio = full; this.audioUrl = full._url;
      const f0 = performance.now();
      while (performance.now() - f0 < 80) {
        await frame();
        const k = Math.min(1, (performance.now() - f0) / 80);
        vol(full, k); vol(old, 1 - k);
      }
      vol(full, 1);
      old.pause(); old.removeAttribute("src"); old.load();
      if (old._url) URL.revokeObjectURL(old._url);
    }

    /** Route the full audio through the Web Audio graph (output-latency
     *  compensation). Called only at discontinuities: load while paused, pause,
     *  seek, loop wrap. The compensation then ramps in (see _loop). */
    _joinGraph(audio) {
      audio = audio || this.audio;
      if (!audio || audio._gain || !this.autoLatency || !this.audioOut.ready) return;
      if (audio === this.audio && this.audioKind !== "full") return;
      if (this.audioOut.route(audio)) this._reportLatency();
    }

    /** All seeks go through here: keeps the judge in step, and holds when
     *  seeking past the quick-start clip before the full audio is there. */
    seek(t) {
      t = Math.max(0, t);
      this._joinGraph();                                   // a seek is a discontinuity anyway
      if (this._runReported && t < this._lastNoteEnd) this._newRun();      // replaying after the results
      this.judge.jump(t - this.avOffset - this._lat);
      if (this.audioKind === "head" && t >= this.headLimit) {
        this.clock.hold(t);
        this.status("Loading the rest of the audio\u2026", "info");
      } else {
        this.clock.seek(t);
        if (this.audioKind !== "head" || !this.clock.holding) this.status("", "clear");
      }
      this._syncTransport();
    }

    /** Chart time (as drawn) of a performance.now() timestamp -- for input events. */
    chartTime(perfMs) { return this.clock.time(perfMs) - this.avOffset - this._lat; }

    /** Input source: "none" | "keyboard" | "microphone" | any name registered with registerInputSource(). */
    setInputSource(name) {
      if (this.inputSource) { this.inputSource.stop(); this.inputSource = null; }
      this.hud.showMeter(false);
      const token = (this._inputToken = (this._inputToken || 0) + 1);
      const f = name && name !== "none" ? NS.inputSources[name] : null;
      if (f) {
        const self = this;
        const src = f({
          bus: this.bus, judge: this.judge, get chart() { return self.chart; },
          expectedAt: (t, w) => this.judge.expectedAt(t, w), chartTime: (ms) => this.chartTime(ms),
          options: Object.assign({}, this.inputOpts),
          onLevel: (rms, peak) => this.hud.setLevel(rms, peak),
          onDevices: (devices, current, estimatedMs) => setInput(this.id + "_devices",
            { devices, current, estimatedLatencyMs: estimatedMs, latencyMs: src.latencyMs ? Math.round(src.latencyMs()) : null, nonce: Date.now() }),
          onOnsetRaw: (perfMs) => { if (this._calib) this._calib.onsets.push(perfMs); },
        });
        this.inputSource = src;
        Promise.resolve().then(() => src.start()).then(() => {
          if (token !== this._inputToken) return;
          if (name === "microphone") this.hud.showMeter(true);
          setInput(this.id + "_input_status", { source: name, ok: true, label: src.trackLabel || "", nonce: Date.now() });
        }).catch((err) => {
          if (token !== this._inputToken) return;
          const msg = inputErrorText(err);
          this.status(`Input unavailable: ${msg}`, "error");
          setInput(this.id + "_input_status", { source: name, ok: false, error: msg, nonce: Date.now() });
          this.inputSource = null; this.judge.active = false; this.hud.setJudge(null); this.hud.showMeter(false);
        });
      }
      // audio detectors report an onset only after analysing it: give them extra time before "missed"
      this.judge.missDelay = name === "microphone" ? 0.35 : 0;
      this.judge.active = !!f;
      this.judge.jump(this.chartTime(performance.now()));
      this.judge._resetStats();
      this._runReported = false;
      this.hud.setJudge(this.judge.active ? this.judge.summary() : null);
      this.transport.setSectionScores(null);
      this._judgeDirty = true;
    }

    /**
     * Input latency calibration (microphone source): plays `clicks` clicks through the
     * output; the onsets heard by the input -- the speakers' clicks picked up by the
     * microphone, or the player strumming a muted string on each click (instrument cable
     * + headphones) -- are matched to the clicks; the median offset is the round-trip
     * input latency. Result -> <id>_calibration and the source's latencyMs.
     */
    async calibrate(a) {
      const src = this.inputSource, n = Math.max(4, Math.min(16, +(a && a.clicks) || 8)), gap = 0.6, lead = 1;
      const fail = (msg) => { this.status(`Calibration: ${msg}`, "error"); setInput(this.id + "_calibration", { ok: false, error: msg, nonce: Date.now() }); };
      if (this._calib) return;
      if (!src || !src.setOptions || this._inputSetting !== "microphone") return fail("switch the input to Microphone first.");
      if (this.clock.playing) this.clock.pause();
      if (!(await this.audioOut.ensure())) return fail("audio output unavailable.");
      const ctx = this.audioOut.ctx, clicks = [];
      const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      const lat = this.audioOut.latency(performance.now()) * 1000;
      // context time -> performance.now() at which it is audible
      const perfOf = ts && ts.performanceTime > 0 ? (x) => ts.performanceTime + (x - ts.contextTime) * 1000
        : ((now, cur) => (x) => now + (x - cur) * 1000 + lat)(performance.now(), ctx.currentTime);
      const t0 = ctx.currentTime + lead;
      for (let k = 0; k < n; k++) {
        const at = t0 + k * gap, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "square"; o.frequency.value = k % 4 ? 880 : 1320;
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.5, at + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
        o.connect(g).connect(ctx.destination); o.start(at); o.stop(at + 0.08);
        clicks.push(perfOf(at));
      }
      this._calib = { onsets: [], clicks };                      // (clicks: exposed for tests)
      this.status(`Calibrating input latency: strum a muted string on each of the ${n} clicks (or let the microphone hear the speakers)\u2026`, "info");
      await new Promise((r) => setTimeout(r, (lead + n * gap + 0.6) * 1000));
      const ons = this._calib.onsets.slice().sort((x, y) => x - y);
      this._calib = null;
      const d = [];
      for (const c of clicks) {
        const o = ons.find((x) => x >= c - 150 && x <= c + 450);
        if (o != null) d.push(o - c);
      }
      if (d.length < Math.ceil(n / 2)) return fail(`heard only ${d.length} of ${n} clicks \u2014 raise the input level or move the microphone closer.`);
      d.sort((x, y) => x - y);
      const q = (p) => d[Math.min(d.length - 1, Math.floor(p * d.length))];
      const ms = Math.max(0, Math.round(q(0.5))), spread = Math.round((q(0.75) - q(0.25)) / 2);
      this.inputOpts.latencyMs = ms;
      src.setOptions({ latencyMs: ms });
      this.status(`Input latency ${ms} ms (${d.length}/${n} clicks, \u00b1${spread} ms)`, "info");
      setTimeout(() => { if (!this._calib) this.status("", "clear"); }, 4000);
      setInput(this.id + "_calibration", { ok: true, latencyMs: ms, matched: d.length, clicks: n, spreadMs: spread, nonce: Date.now() });
    }

    /** Start a fresh scored run (after the results, or when a practice loop is set). */
    _newRun() {
      this._runReported = false; this._bestPass = 0;
      this.judge._resetStats();
      this.transport.setSectionScores(null);
      this._judgeDirty = true;
    }

    /** End of a run (song end, or the last note passed): results card + <id>_result. */
    _finishRun() {
      const J = this.judge;
      if (!J.active || this._runReported || !this.chart || J.hits + J.misses === 0) return;
      this._runReported = true;
      const r = J.result(), m = this.chart.meta || {};
      this.results.show(r, { kind: "song", title: m.title, arrangement: m.arrangement, perfectWindow: J.perfectWindow });
      setInput(this.id + "_result", Object.assign({ kind: "song", songKey: this.songKey, title: m.title || "", artist: m.artist || "",
        arrangement: m.arrangement || "", difficulty: m.difficulty != null ? m.difficulty : 1, source: this._inputSetting,
        rate: this.clock.rate, nonce: Date.now() }, r));
    }

    /** A practice-loop pass ended: short toast + <id>_result (kind "loop"); stats restart per pass. */
    _finishPass() {
      const J = this.judge;
      if (!J.active || !this.chart || J.hits + J.misses === 0) return;
      const r = J.result(), m = this.chart.meta || {};
      this._bestPass = Math.max(this._bestPass || 0, r.accuracy || 0);
      this.status(`Pass ${this.loopCount}: ${Math.round(100 * r.accuracy)}%  \u00b7  best pass ${Math.round(100 * this._bestPass)}%`, "info");
      clearTimeout(this._passToast);
      this._passToast = setTimeout(() => this.status("", "clear"), 2500);
      setInput(this.id + "_result", Object.assign({ kind: "loop", pass: this.loopCount, songKey: this.songKey, title: m.title || "",
        artist: m.artist || "", arrangement: m.arrangement || "", difficulty: m.difficulty != null ? m.difficulty : 1,
        source: this._inputSetting, rate: this.clock.rate, loopStart: this.practice.start, loopEnd: this.practice.end, nonce: Date.now() }, r));
      J._resetStats();
    }

    _unloadAudio() {
      this.clock.detach();
      this.clock.partialAudio = false;
      if (this.audio) { this.audio.removeAttribute("src"); this.audio.load(); }
      if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
      this.audio = null; this.audioUrl = null; this.audioKind = null; this.headLimit = Infinity;
    }

    /**
     * "canvas" (default): Canvas 2D. "dom": HTML/SVG elements moved by
     * compositor transforms (renderer-dom.js). Switchable at runtime.
     */
    /** Lane charts (piano, harmonica) always use the lane renderer; guitar charts the preferred one. */
    _applyRenderer() { this.setRenderer(this.chart && this.chart.lanes ? "lanes" : this._rendererPref || "canvas"); }

    setRenderer(kind) {
      if (kind === "dom" && !NS.DomHighwayRenderer) kind = "canvas";
      if (kind === "lanes" && !NS.LaneHighwayRenderer) kind = "canvas";
      if (kind !== "dom" && kind !== "lanes") kind = "canvas";
      if (kind === this.rendererKind) return;
      if (this.renderer) this.renderer.destroy();
      this.canvas.style.display = kind === "dom" ? "none" : "";
      this.renderer = kind === "dom" ? new NS.DomHighwayRenderer(this.el, this.empty)
        : kind === "lanes" ? new NS.LaneHighwayRenderer(this.canvas)
        : new NS.HighwayRenderer(this.canvas);
      this.rendererKind = kind;
      this.renderer.setOptions(this.renderOpts);
      this.renderer.setJudge(this.judge);
      if (this.chart) this.renderer.setChart(this.chart);
      if (this._ro) this._resize();
    }

    settings(o) {
      if (!o) return;
      if (o.renderer) { this._rendererPref = String(o.renderer); this._applyRenderer(); }
      if (o.guideTones != null) { this.guide.setEnabled(!!o.guideTones); if (o.guideTones && this.clock.playing) this.audioOut.ensure(); }
      if (o.guideVolume != null) this.guide.setVolume(+o.guideVolume);
      const r = {};
      if (o.lookahead != null) r.lookahead = +o.lookahead;
      if (o.invertStrings != null) r.invertStrings = !!o.invertStrings;
      if (o.showFretNumbers != null) r.showFretNumbers = !!o.showFretNumbers;
      if (o.maxDpr != null) r.maxDpr = Math.max(0.5, +o.maxDpr);
      Object.assign(this.renderOpts, r);
      this.renderer.setOptions(r);
      if (r.maxDpr) this._resize();
      if (o.avOffsetMs != null) this.avOffset = +o.avOffsetMs / 1000;
      if (o.autoLatency != null) this.autoLatency = !!o.autoLatency;
      if (o.lyrics != null) this.lyrics.setVisible(!!o.lyrics);
      // apply the speed only when the *setting* changes, so a running loop
      // speed ramp is not reset whenever another setting is touched
      if (o.playbackRate != null && +o.playbackRate !== this._rateSetting) {
        this._rateSetting = +o.playbackRate;
        this.clock.setRate(this._rateSetting);
      }
      if (o.practice) this.setPractice(o.practice);
      // input options (microphone): device / echo cancellation need a restart, the rest is live
      const io = this.inputOpts, was = { deviceId: io.deviceId, echoCancellation: io.echoCancellation };
      if (typeof o.inputDevice === "string") io.deviceId = o.inputDevice || null;
      if (o.echoCancellation != null) io.echoCancellation = !!o.echoCancellation;
      if (o.inputSensitivity != null && +o.inputSensitivity > 0) io.sensitivity = +o.inputSensitivity;
      if (o.inputLatencyMs != null && isFinite(+o.inputLatencyMs)) io.latencyMs = +o.inputLatencyMs;        // null: keep (remembered / calibrated)
      const restart = io.deviceId !== was.deviceId || io.echoCancellation !== was.echoCancellation;
      if (o.inputSource !== undefined && o.inputSource !== this._inputSetting) {
        this._inputSetting = o.inputSource;
        this.setInputSource(o.inputSource);
      } else if (restart && this._inputSetting === "microphone") {
        this.setInputSource("microphone");
      } else if (this.inputSource && this.inputSource.setOptions) {
        this.inputSource.setOptions({ sensitivity: io.sensitivity, latencyMs: io.latencyMs });
      }
      if (o.hitWindowMs != null) this.judge.window = Math.max(0.03, +o.hitWindowMs / 1000);
      if (o.hitFeedback != null) this.feedback.visible = !!o.hitFeedback;
      this._syncTransport();
      this._drawOnce();
    }

    // ---- practice (Riff-Repeater-style loop) -----------------------------------------
    /** {loop, start, end, leadIn, ramp}: loop [start, end) with a lead-in; each
     *  pass can raise the speed by `ramp` (e.g. 0.05) until 100%. */
    setPractice(p) {
      const prev = this.practice;
      const next = {
        loop: !!p.loop, start: +p.start || 0, end: +p.end || 0,
        leadIn: Math.max(0, +p.leadIn || 0), ramp: Math.max(0, +p.ramp || 0),
      };
      if (next.end <= next.start) next.loop = false;
      const changed = next.loop !== prev.loop || next.start !== prev.start || next.end !== prev.end;
      this.practice = next;
      if (changed) {
        this.loopCount = 0;
        if (this.judge.active) this._newRun();                  // loop passes are scored on their own
        if (this.clock.rate !== this._rateSetting) this.clock.setRate(this._rateSetting);
        if (next.loop) {
          const t = this.clock.time(performance.now());
          if (t < this._loopFrom() - 0.05 || t >= next.end) this.seek(this._loopFrom());
        }
      }
      this.transport.setLoop(next);
    }
    _loopFrom() { return Math.max(0, this.practice.start - this.practice.leadIn); }

    async togglePlay() {
      if (this.inputSource && this.inputSource.resume) this.inputSource.resume();   // user gesture
      if (!this.clock.playing && (this.autoLatency || this.guide.enabled) && !this.audioOut.ctx && !this.audioOut.failed) {
        await this.audioOut.ensure();                     // user gesture: create + resume the graph
        this._reportLatency();
        if (!this.clock.playing && this._hidden) return;  // hidden meanwhile (the app switched modes)
      }
      if (!this.clock.playing) this._joinGraph();         // about to start: nothing else is playing
      if (!this.clock.playing && this.practice.loop) {
        const t = this.clock.time(performance.now());
        if (t >= this.practice.end || t < this._loopFrom() - 0.05) this.seek(this._loopFrom());
      }
      const t = this.clock.time(performance.now());
      if (!this.clock.playing && this.audioKind === "head" && t >= this.headLimit) {
        this.clock.playHeld(t);                           // wait for the full audio
        this.status("Loading the rest of the audio\u2026", "info");
        return;
      }
      const wasPlaying = this.clock.playing;
      this.clock.toggle();
      if (wasPlaying) this._joinGraph();                  // just paused: safe moment to join
    }

    _reportLatency() {
      const ms = Math.round(1000 * this.audioOut.latency(performance.now() + 2000));
      setInput(this.id + "_latency", { outputMs: ms, routed: !!(this.audio && this.audio._gain), auto: this.autoLatency, nonce: Date.now() });
    }

    _practiceTick(t) {
      const p = this.practice;
      if (p.loop && this.clock.playing && t >= p.end) {
        this.loopCount++;
        this._finishPass();
        if (p.ramp > 0 && this.clock.rate < 1) this.clock.setRate(Math.min(1, +(this.clock.rate + p.ramp).toFixed(3)));
        this.seek(this._loopFrom());
        this._syncTransport();
        return;
      }
      this.countdown.update(p.loop && p.leadIn > 0 && t < p.start && t >= this._loopFrom() - 0.05 ? p.start - t : null);
    }

    status(text, level) {
      this.banner.textContent = text || "";
      this.banner.className = "rs-hw-banner" + (text && level !== "clear" ? " is-" + level : "");
    }

    command(msg) {
      const a = msg.args || {};
      switch (msg.cmd) {
        case "audio": this.setAudio(a.url, a.songKey, a.kind, a.seconds); break;
        case "play": if (!this.clock.playing) this.togglePlay(); break;
        case "pause": this.clock.pause(); break;
        case "seek": this.seek(+a.time || 0); break;
        case "settings": this.settings(a.settings); break;
        case "status": this.status(a.text, a.level); break;
        case "benchmark": this.benchmark(a); break;
        case "calibrate": this.calibrate(a); break;
        case "result_ack": this.results.ack(a); break;
        case "input":                                   // external trigger (e.g. from R / a test)
          if (a.hit === false) this.bus.noteMiss = true;
          else this.bus.hit({ midi: a.midi, string: a.string, fret: a.fret, source: "external" });
          break;
        default: console.warn("rs-highway: unknown command", msg.cmd);
      }
    }

    // ---- in-browser renderer benchmark -------------------------------------------
    /**
     * Renders the densest stretch of the loaded chart with each renderer for
     * `seconds`, on this machine's real browser/GPU, and reports per renderer:
     * achieved fps, frame-interval percentiles, % janky frames (>25 ms) and the
     * JS time of draw(). Result -> Shiny input <id>_benchmark.
     */
    async benchmark(a) {
      if (!this.chart || this._benchmarking) return;
      this._benchmarking = true;
      const secs = Math.max(1, +(a && a.seconds) || 4);
      const wasPlaying = this.clock.playing, keep = this.rendererKind;
      this.clock.pause();
      this._stop();
      const t0 = this._densestWindow(this.renderer.opts.lookahead);
      const results = [];
      for (const kind of this.chart.lanes ? ["lanes"] : ["canvas", "dom"]) {
        this.status(`Benchmarking ${kind} renderer\u2026`, "info");
        this.setRenderer(kind);
        results.push(Object.assign({ renderer: kind }, await this._benchRun(t0, secs)));
      }
      this.setRenderer(keep);
      this.status(results.map((r) => `${r.renderer}: ${r.fps} fps, p95 frame ${r.p95FrameMs} ms`).join("  |  "), "info");
      this._benchmarking = false;
      this._start();
      if (wasPlaying) this.clock.play();
      const rect = this.el.getBoundingClientRect();
      setInput(this.id + "_benchmark", {
        results, chartTime: +t0.toFixed(2), width: Math.round(rect.width), height: Math.round(rect.height),
        dpr: window.devicePixelRatio || 1, userAgent: navigator.userAgent, nonce: Date.now(),
      });
      return results;
    }

    _densestWindow(win) {
      const t = this.chart.notes.t, n = t.length;
      let best = 0, bestCount = -1, j = 0;
      for (let i = 0; i < n; i++) {
        while (j < n && t[j] < t[i] + win) j++;
        if (j - i > bestCount) { bestCount = j - i; best = t[i]; }
      }
      return Math.max(0, best - 0.5);
    }

    _benchRun(t0, secs) {
      return new Promise((resolve) => {
        const frames = [], draws = [];
        let start = 0, last = 0;
        const warm = 500;
        const step = (ts) => {
          if (!start) start = ts;
          const el = ts - start;
          const d0 = performance.now();
          this.renderer.draw(t0 + el / 1000, last ? (ts - last) / 1000 : 0);
          const d = performance.now() - d0;
          if (el > warm && last) { frames.push(ts - last); draws.push(d); }
          last = ts;
          if (el < warm + secs * 1000) requestAnimationFrame(step);
          else {
            const q = (arr, p) => { const s = arr.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
            const total = frames.reduce((x, y) => x + y, 0);
            resolve({
              fps: +(1000 * frames.length / total).toFixed(1),
              p50FrameMs: +q(frames, 0.5).toFixed(1), p95FrameMs: +q(frames, 0.95).toFixed(1),
              jankPct: +(100 * frames.filter((f) => f > 25).length / frames.length).toFixed(1),
              drawMsP50: +q(draws, 0.5).toFixed(2), drawMsP95: +q(draws, 0.95).toFixed(2),
            });
          }
        };
        requestAnimationFrame(step);
      });
    }

    // ---- render loop -----------------------------------------------------------
    _start() { if (!this._raf && !this._benchmarking) { this._lastFrame = 0; this._raf = requestAnimationFrame(this._loop); } }
    _stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }

    _loop(ts) {
      this._raf = 0;
      if (!this.el.isConnected) { this.destroy(); return; }
      const dt = this._lastFrame ? (ts - this._lastFrame) / 1000 : 0;
      this._lastFrame = ts;
      if (dt > 0) this.fps = this.fps ? this.fps * 0.95 + (1 / dt) * 0.05 : 1 / dt;

      if (dt > 0 && dt < 0.1) this.frameLead = this.frameLead * 0.9 + dt * 0.1;
      this.clock.tick(ts);
      // Draw the state for when this frame will actually be on screen (about one
      // frame after the rAF timestamp), so notes cross the strike line in step
      // with the sound rather than one frame late.
      const t = this.clock.time(ts + this.frameLead * 1000);
      this._practiceTick(t);
      if (this.audioKind === "head" && this.clock.playing && !this.clock.holding && t >= this.headLimit) {
        this.clock.hold(t);
        this.status("Loading the rest of the audio\u2026", "info");
      }
      // compensate the device output latency (known because playback runs through Web Audio)
      // (ramped at 0.1 s/s, so switching from the unrouted clip to the routed full
      // file, or a device change, never makes the notes jump)
      const target = this.autoLatency && this.audio && this.audio._gain ? this.audioOut.latency(ts) : 0;
      const was = this._lat;
      this._lat += Math.max(-0.1 * dt, Math.min(0.1 * dt, target - this._lat)) || 0;
      if (dt <= 0 || dt > 0.5) this._lat = target;
      if (Math.abs(target - this._latReported) > 0.002 && Math.abs(this._lat - target) < 0.001) { this._latReported = target; this._reportLatency(); }
      if (was !== this._lat && Math.abs(this._lat - target) < 1e-4) this._lat = target;
      const tv = t - this.avOffset - this._lat;           // + offset = notes later
      if (this._lastTv != null && (tv < this._lastTv - 0.05 || tv > this._lastTv + 1)) this.judge.jump(tv);   // seek/loop
      this._lastTv = tv;
      this.judge.tick(tv);
      if (this._lastJudged) { this.feedback.show(this._lastJudged); this._lastJudged = null; }
      if (this.judge.active && this.clock.playing && !this.practice.loop && tv > this._lastNoteEnd + 3) this._finishRun();
      if (!this._hidden) this.renderer.draw(tv, dt);
      this.lyrics.update(tv);
      if (this.guide.enabled) { const now = performance.now(); this.guide.update(this.clock.playing && !this.clock.holding, this.chartTime(now), this.clock.rate, now); }
      if (this.chart) this.hud.update(this._sectionIndex(tv), this.chart.sections);

      if (ts - this._lastUi > 100) {
        this._lastUi = ts; this._syncTransport(t);
        if (this._judgeDirty && this.judge.active) {
          this._judgeDirty = false;
          const sum = this.judge.summary();
          this.hud.setJudge(sum);
          this.transport.setSectionScores(this.judge.sectionAccuracy());
          if (ts - (this._lastJudgeSent || 0) > 400) { this._lastJudgeSent = ts; setInput(this.id + "_judge", sum); }
          else this._judgeDirty = true;
        }
      }
      if (this.clock.playing && ts - this._lastTelemetry > 250) {
        this._lastTelemetry = ts;
        const si = this._sectionIndex(t);
        setInput(this.id + "_state", {
          t: +t.toFixed(3), playing: true, fps: Math.round(this.fps), rate: this.clock.rate, loops: this.loopCount,
          sectionIndex: si, section: si >= 0 ? this.chart.sections.label[si] : "",
        });
      }
      this._raf = requestAnimationFrame(this._loop);
    }

    _sectionIndex(t) {
      const s = this.chart && this.chart.sections;
      if (!s || !s.n) return -1;
      let lo = 0, hi = s.n;
      while (lo < hi) { const m = (lo + hi) >>> 1; if (s.t[m] <= t + 1e-6) lo = m + 1; else hi = m; }
      return lo - 1;
    }

    _drawOnce() {
      if (this._raf || this._benchmarking) return;   // the loop will pick it up
      const now = performance.now();
      this.renderer.draw(this.clock.time(now) - this.avOffset, 0);
    }

    _resize() {
      const r = this.el.getBoundingClientRect();
      this._hidden = r.width < 1 || r.height < 1;            // e.g. the app is in karaoke mode: skip drawing
      if (this._hidden && this.clock.playing) { this.clock.pause(); this._joinGraph(); }   // a hidden player never plays
      this.renderer.resize(r.width, r.height, window.devicePixelRatio || 1);
      this.el.classList.toggle("is-compact", r.width < 760);
      this.el.classList.toggle("is-narrow", r.width < 1400);   // lyrics move below the song card
      this._drawOnce();
    }

    _syncTransport(t) {
      if (!this.transport) return;
      if (t == null) t = this.clock.time(performance.now());
      this.transport.update({
        t, duration: this.clock.duration || 0, playing: this.clock.playing, rate: this.clock.rate,
        hasAudio: !!this.audio || this.guide.enabled, loopCount: this.loopCount,
      });
    }

    _key(e) {
      if (!this.chart || !this.el.isConnected) return;
      if (!this.el.getClientRects().length) return;      // hidden (e.g. the app is in karaoke mode)
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(tag) || (e.target && e.target.isContentEditable)) return;
      const t = this.clock.time(performance.now());
      switch (e.code) {
        case "Space": this.togglePlay(); break;
        case "ArrowLeft": this.seek(t - 5); break;
        case "ArrowRight": this.seek(t + 5); break;
        case "Home": this.seek(this.practice.loop ? this._loopFrom() : 0); break;
        case "KeyL": setInput(this.id + "_loop_toggle", Date.now()); break;
        case "Escape": if (!this.results.open) return; this.results.hide(); break;
        default: return;
      }
      e.preventDefault();
    }

    destroy() {
      this._stop();
      if (this.renderer) this.renderer.destroy();
      if (this.inputSource) this.inputSource.stop();
      this._unloadAudio();
      this._ro.disconnect();
      document.removeEventListener("keydown", this._onKey);
      controllers.delete(this.id);
    }
  }

  function controllerFor(el) {
    let c = controllers.get(el.id);
    if (!c || c.el !== el) { if (c) c.destroy(); c = new HighwayController(el); controllers.set(el.id, c); }
    return c;
  }
  NS.HighwayController = HighwayController;
  NS.controllerFor = controllerFor;
  NS.controllers = controllers;

  // ---- Shiny registration ---------------------------------------------------------
  function register() {
    const Shiny = root.Shiny;
    const binding = new Shiny.OutputBinding();
    Object.assign(binding, {
      find: (scope) => $(scope).find(".rs-highway"),
      renderValue: (el, data) => controllerFor(el).load(data),
      renderError: (el, err) => controllerFor(el).status(err.message, "error"),
      clearError: (el) => controllerFor(el).status("", "clear"),
    });
    Shiny.outputBindings.register(binding, "rockshiny.highway");
    Shiny.addCustomMessageHandler("rs-highway", (msg) => {
      const el = document.getElementById(msg.id);
      if (el) controllerFor(el).command(msg);
    });
  }
  if (root.Shiny && root.Shiny.OutputBinding) register();
  else document.addEventListener("DOMContentLoaded", () => { if (root.Shiny) register(); });
})(window);
