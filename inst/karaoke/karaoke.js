/* ---------------------------------------------------------------------------
 * karaoke.js -- synchronized karaoke lyrics for RockShiny.
 *
 * Host-agnostic: the same player runs inside Shiny (karaoke-shiny.js, an
 * output binding) and in a standalone HTML page (karaoke-page.js, written by
 * karaoke_export_html()). It needs clock.js (SongClock, AudioOut) and dds.js
 * (album art) from inst/highway -- the note highway's own sync machinery:
 *
 *   <audio> = master clock, extrapolated per frame (SongClock), drawn for the
 *   moment the frame is on screen, minus the device output latency (AudioOut,
 *   Web Audio) and a manual offset. Lyrics are therefore highlighted when the
 *   syllable is *heard*, not when the element reports it.
 *
 *   RSKaraoke.prepare(json)     payload (karaoke_json() in R) -> song model
 *   RSKaraoke.state(song, t)    pure timing model: which line / syllable when
 *   RSKaraoke.AudioDeck         audio element(s): quick-start clip -> full file
 *                               handover, Web Audio routing, latency
 *   RSKaraoke.KaraokePlayer     view + transport + keys + rAF loop
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const HW = root.RSHighway || {};
  const K = (root.RSKaraoke = root.RSKaraoke || {});

  // ---- timing rules (seconds) -------------------------------------------------------
  const LEAD = 0.5;        // a line becomes current this long before its first syllable...
  const LATE = 0.05;       // ...but at least this long before it (when the previous line runs late)
  const HOLD = 1.0;        // a finished line stays current this long if nothing follows soon
  const BREAK = 4;         // gaps of at least this long are instrumental breaks (cue + countdown)
  const COUNT_IN = 3;      // count-in dots during the last seconds of an intro / break
  const MIN_WIPE = 0.08;   // shortest highlight wipe of one syllable
  K.TIMING = { LEAD, LATE, HOLD, BREAK, COUNT_IN, MIN_WIPE };

  const upperBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; };
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  function h(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }
  K.fmtTime = fmt;
  const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);   // tolerate unboxed length-1 columns

  // ---- song model ---------------------------------------------------------------------
  /**
   * json: {format, songKey, meta: {title, artist, album, year, duration},
   *        vocals: {t, d, w, j, l}, sections: {t, name, label}, art?, audio?}
   * -> {songKey, meta, lines: [{start, end, words: [{t, d, w, j}], wordT, text}],
   *     showAt (when each line becomes current), sections, cues (section label
   *     before line i), duration, art, audio}
   */
  K.prepare = function (json) {
    const j = typeof json === "string" ? JSON.parse(json) : json || {};
    let v = j.vocals || {};
    // lyrics that are not in the archive: LRC text (sidecar .lrc or LRCLIB), see karaoke-sync.js
    const lyr = j.lyrics || null;
    let lrc = null;
    if (!arr(v.t).length && lyr && lyr.lrc && K.parseLRC) {
      lrc = K.parseLRC(lyr.lrc);
      v = K.vocalsFromLRC(lrc);
      const shift = (+lyr.offsetMs || 0) / 1000;                 // automatic alignment (or a cached one)
      if (shift) v.t = v.t.map((x) => +(x + shift).toFixed(3));
    }
    const t = arr(v.t), d = arr(v.d), w = arr(v.w), jn = arr(v.j), li = arr(v.l), nn = arr(v.n);   // n: charted pitches (optional)
    const byId = new Map(), lines = [];
    for (let i = 0; i < t.length; i++) {
      const id = li[i] == null ? 0 : +li[i];
      let L = byId.get(id);
      if (!L) { L = { words: [] }; byId.set(id, L); lines.push(L); }
      const W = { t: +t[i], d: Math.max(0, +d[i] || 0), w: w[i] == null ? "" : String(w[i]), j: !!+jn[i] };
      if (nn.length && nn[i] != null && +nn[i] !== 254) W.n = +nn[i];
      L.words.push(W);
    }
    for (const L of lines) L.words.sort((a, b) => a.t - b.t);
    lines.sort((a, b) => a.words[0].t - b.words[0].t);
    // lyrics timed per line: syllable times are estimated (K.timeLine), not measured
    const estimated = !!lrc && lrc.synced === "line";
    for (const L of lines) {
      L.start = L.words[0].t;
      L.end = 0;
      for (const W of L.words) L.end = Math.max(L.end, W.t + Math.max(W.d, 0.3));
      L.wordT = L.words.map((W) => W.t);
      L.text = L.words.map((W) => W.w + (W.j ? "" : " ")).join("").trim();
    }
    // when each line becomes "current": LEAD before its first syllable, or as soon as
    // the previous line has finished when that is later -- never after LATE before it
    const showAt = lines.map((L, k) => {
      if (k === 0) return L.start - LEAD;
      return clamp(lines[k - 1].end - 0.05, L.start - LEAD, L.start - LATE);
    });
    for (let k = 1; k < showAt.length; k++) showAt[k] = Math.max(showAt[k], showAt[k - 1]);

    const s = j.sections || {};
    const sections = { t: arr(s.t).map(Number), name: arr(s.name).map(String), label: arr(s.label || s.name).map(String) };
    sections.n = sections.t.length;
    // Section names in the lyrics: Rocksmith sections are fine-grained ("Verse 1" ...
    // "Verse 11", every few bars), so a label goes before a line only when the kind
    // of section changes (Verse -> Chorus), or when another kind lies in between
    // (Verse, solo, Verse). A line belongs to the section holding its midpoint:
    // sung pick-ups often start just before the section boundary.
    const kind = (i) => (i < 0 ? null : sections.label[i].replace(/\s+\d+$/, ""));
    const cues = new Array(lines.length).fill(null);
    let prevSi = -1;
    lines.forEach((L, k) => {
      const si = upperBound(sections.t, (L.start + L.end) / 2) - 1;
      if (si < 0) { prevSi = si; return; }
      let change = k === 0 || kind(si) !== kind(prevSi);
      for (let x = Math.max(prevSi + 1, 0); x < si && !change; x++) change = kind(x) !== kind(si);
      if (change && kind(si)) cues[k] = kind(si);
      prevSi = si;
    });
    const meta = j.meta || {};
    const lastEnd = lines.length ? lines[lines.length - 1].end : 0;
    const lyrics = lyr ? Object.assign({}, lyr, { synced: lrc ? lrc.synced : "syllable",
      plain: lrc && lrc.synced === "none" ? lrc.lines.map((x) => x.text) : null }) : { source: "archive", synced: "syllable" };
    return {
      format: j.format, songKey: j.songKey || null, meta, lines, showAt, sections, cues, lyrics, estimated,
      duration: Math.max(+meta.duration || 0, lastEnd + 2), art: j.art || null, audio: j.audio || null,
    };
  };

  /**
   * Timing model (pure): what to show at lyric time t.
   * -> {mode, focus, word, p, until}
   *    mode  "empty" | "intro" (before the first line) | "sing" | "break"
   *          (long instrumental gap: the next line is previewed) | "outro"
   *    focus line index in view; word = syllable being sung (-1: none yet,
   *    words.length: all sung); p = wipe progress of that syllable (0..1);
   *    until = start of the awaited line (intro / break).
   */
  K.state = function (S, t) {
    const L = S.lines, n = L.length;
    if (!n) return { mode: "empty", focus: -1, word: -1, p: 0 };
    const k = upperBound(S.showAt, t) - 1;                  // last line whose showAt <= t
    if (k < 0) return { mode: "intro", focus: 0, word: -1, p: 0, until: L[0].start };
    const cur = L[k];
    if (t >= cur.end + HOLD) {
      if (k + 1 >= n) return { mode: "outro", focus: k, word: cur.words.length, p: 1 };
      if (L[k + 1].start - cur.end >= BREAK) return { mode: "break", focus: k + 1, word: -1, p: 0, until: L[k + 1].start };
    }
    const w = upperBound(cur.wordT, t) - 1;                 // last syllable that has started
    let p = 0;
    if (w >= 0) { const W = cur.words[w]; p = clamp((t - W.t) / Math.max(W.d, MIN_WIPE), 0, 1); }
    return { mode: "sing", focus: k, word: w, p };
  };

  // ---- audio --------------------------------------------------------------------------
  // Formats the R side may encode (ids must match AUDIO_FORMATS in R/audio.R).
  const AUDIO_MIME = {
    ogg: 'audio/ogg; codecs="vorbis"', m4a: 'audio/mp4; codecs="mp4a.40.2"',
    opus: 'audio/ogg; codecs="opus"', flac: "audio/flac", wav: 'audio/wav; codecs="1"',
  };
  K.playableFormats = function () {
    const a = document.createElement("audio");
    return Object.keys(AUDIO_MIME).filter((k) => a.canPlayType(AUDIO_MIME[k]) !== "");
  };

  /**
   * AudioDeck -- the song's <audio> element(s) behind a SongClock.
   * kind "head" = quick-start clip of the first `seconds` (playback starts at
   * once; past its end the clock *holds*), kind "full" = the whole song. A full
   * file arriving while the clip plays is started muted, aligned by nudging its
   * playbackRate, cross-faded in 80 ms and made the clock master without a gap
   * (the algorithm of the note highway, binding.js). Elements join the Web Audio
   * graph (-> known output latency) only while nothing plays.
   * hooks: {status(text, level), changed()}
   */
  class AudioDeck {
    constructor(hooks) {
      this.hooks = hooks || {};
      this.clock = new HW.SongClock();
      this.out = new HW.AudioOut();
      this.audio = null; this.kind = null; this.key = null; this.headLimit = Infinity;
      this.autoLatency = true;
      this.handoverError = null;
    }
    _status(text, level) { if (this.hooks.status) this.hooks.status(text, level); }

    /** Attach audio for song `key`. `url` is fetched into a Blob (seeking never
     *  depends on HTTP Range support); relative URLs in a page opened from disk
     *  (file://, where fetch() is not allowed) are loaded by the element directly. */
    async set(url, key, kind, seconds) {
      kind = kind === "head" ? "head" : "full";
      if (key && this.key && key !== this.key) return false;            // stale
      if (this.kind === "full" || (kind === "head" && this.kind === "head")) return false;
      if (!this.audio) this._status(kind === "head" ? "Loading quick-start audio\u2026" : "Loading audio\u2026", "info");
      let audio;
      try {
        let src = url, blobUrl = null;
        // a page opened from disk cannot fetch() files next to it: the element loads those directly
        const direct = location.protocol === "file:" && !/^(blob|data|https?):/i.test(url);
        if (!direct) {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          blobUrl = src = URL.createObjectURL(await resp.blob());
        }
        if ((key && this.key && key !== this.key) || this.kind === "full") { if (blobUrl) URL.revokeObjectURL(blobUrl); return false; }
        audio = new Audio();
        audio.preload = "auto";
        audio._url = blobUrl;
        audio._direct = direct;     // its samples are off limits (file://): never routed through Web Audio
        audio.src = src;
        if (kind === "full" && !this.clock.playing) this.joinGraph(audio);
        await new Promise((resolve, reject) => {
          audio.addEventListener("canplaythrough", resolve, { once: true });
          audio.addEventListener("error", () => reject(new Error("this browser cannot play the audio format")), { once: true });
        });
      } catch (e) {
        this._status(`Audio failed: ${e.message}`, "error");
        return false;
      }
      if ((key && this.key && key !== this.key) || this.kind === "full") { this._release(audio); return false; }
      if (kind === "full" && this.kind === "head" && this.audio && this.clock.playing && !this.clock.holding) {
        await this._handover(audio);
      } else {
        this.unload();
        this.audio = audio;
        this.clock.partialAudio = kind === "head";
        this.clock.attach(audio);                                       // resumes a hold if playing
      }
      this.kind = kind;
      this.headLimit = kind === "head" ? Math.max(0, (+seconds || audio.duration || 0) - 0.25) : Infinity;
      if (kind === "full" && isFinite(audio.duration)) this.clock.duration = Math.max(this.clock.duration, audio.duration);
      this._status("", "clear");
      if (this.hooks.changed) this.hooks.changed();
      return true;
    }

    async _handover(full) {
      const head = this.audio, rate = this.clock.rate, vol = HW.AudioOut.setVolume;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      full.muted = true; full.preservesPitch = true; full.playbackRate = rate;
      full.currentTime = head.currentTime + 0.08;
      try { await full.play(); } catch (e) { /* plain swap below */ }
      let smooth = null, aligned = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 4000 && !full.paused) {
        await frame();
        if (head.paused || !this.clock.playing || this.audio !== head) break;
        const d = full.currentTime - head.currentTime;                   // + = full ahead
        if (Math.abs(d) > 0.5) { full.currentTime = head.currentTime + 0.08; smooth = null; continue; }
        smooth = smooth == null ? d : smooth * 0.6 + d * 0.4;
        if (Math.abs(smooth) < 0.006) { aligned = true; break; }
        full.playbackRate = rate * (1 - clamp(smooth * 3, -0.12, 0.12));
      }
      full.playbackRate = rate;
      this.handoverError = aligned ? smooth : null;
      if (!aligned || full.paused || this.audio !== head || !this.clock.playing) {
        full.pause(); full.muted = false;                                // plain swap at the current position
        this.unload();
        this.audio = full; this.clock.partialAudio = false; this.clock.attach(full);
        return;
      }
      vol(full, 0); full.muted = false;
      const old = this.clock.handover(full);
      this.clock.partialAudio = false;
      this.audio = full;
      const f0 = performance.now();
      while (performance.now() - f0 < 80) {
        await frame();
        const k = Math.min(1, (performance.now() - f0) / 80);
        vol(full, k); vol(old, 1 - k);
      }
      vol(full, 1);
      this._release(old);
    }

    /** Route the full audio through Web Audio (output-latency compensation); only at discontinuities. */
    joinGraph(audio) {
      audio = audio || this.audio;
      if (!audio || audio._gain || !(this.autoLatency || this.wantGraph) || !this.out.ready) return false;
      if (audio === this.audio && this.kind !== "full") return false;
      // an element playing a file next to a page opened from disk: Web Audio would get silence
      // from it ("outputs zeroes due to CORS access restrictions"), so it plays on its own
      if (audio._direct) return false;
      return this.out.route(audio);
    }
    /** Device output latency (s) to compensate now: only when the playing element is routed. */
    latency(nowMs) {
      const a = this.audio;
      if (!a || !a._gain) return 0;
      return (this.autoLatency ? this.out.latency(nowMs) : 0) + (a._voice ? a._voiceLatency || 0 : 0);   // + the voice processing (karaoke-voice.js)
    }

    _release(a) {
      if (!a) return;
      a.pause(); a.removeAttribute("src"); a.load();
      if (a._url) URL.revokeObjectURL(a._url);
    }
    unload() {
      this.clock.detach();
      this.clock.partialAudio = false;
      this._release(this.audio);
      this.audio = null; this.kind = null; this.headLimit = Infinity;
    }
    /** A new song: drop its audio, rewind. */
    reset(key, duration) {
      this.unload();
      this.key = key || null;
      this.clock.pause();
      this.clock.duration = duration || 0;
      this.clock.seek(0);
    }
  }
  K.AudioDeck = AudioDeck;

  // ---- player -------------------------------------------------------------------------
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
    restart: '<svg viewBox="0 0 24 24"><path d="M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
  };
  const DEFAULTS = { view: "stage", textScale: 1, countIn: true, sectionLabels: true, backdrop: true,
                     offsetMs: 0, autoLatency: true, playbackRate: 1 };

  /**
   * KaraokePlayer(el, hooks) -- hooks (all optional):
   *   onReady({songKey, audio: "none"|"head"|"full", formats, nonce})  after each song load
   *   onLatency({outputMs, routed, auto})                               when compensation changes
   *   onState({t, playing, line, nonce})                                ~2 Hz while playing
   *   emptyHtml                                                         empty-state message
   */
  class KaraokePlayer {
    constructor(el, hooks) {
      this.el = el;
      this.hooks = hooks || {};
      el.classList.add("rs-k");
      el.innerHTML = "";
      if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
      this.opts = Object.assign({}, DEFAULTS);
      this.song = null;
      this.deck = new AudioDeck({ status: (t, l) => this.status(t, l, "audio"), changed: () => this._audioChanged() });
      this.clock = this.deck.clock;
      this.clock.onStateChange = (_c, err) => { this._sync(); if (err) this.status(`Playback blocked: ${err.message || err}`, "error"); };
      this.clock.onEnded = () => {                       // played to the end (the app's play queue moves on)
        this._sync();
        this._plug("ended");
        if (this.hooks.onEnded) this.hooks.onEnded({ songKey: this.song && this.song.songKey, nonce: Date.now() });
      };
      this._lat = 0; this._latReported = -1; this.frameLead = 1 / 60;
      this.offset = 0; this._rateSetting = 1;

      this.backdrop = h("div", "rs-k-backdrop", el);
      this.viewport = h("div", "rs-k-viewport", el);
      this.track = h("div", "rs-k-track", this.viewport);
      this.cue = h("div", "rs-k-cue", el);
      this.cueText = h("span", "rs-k-cue-text", this.cue);
      this.cueDots = h("span", "rs-k-cue-dots", this.cue);
      for (let i = 0; i < COUNT_IN; i++) h("i", null, this.cueDots);
      const card = (this.card = h("div", "rs-k-card", el));
      this.art = h("div", "rs-k-art is-empty", card);
      const meta = h("div", "rs-k-card-meta", card);
      this.title = h("div", "rs-k-card-title", meta);
      this.sub = h("div", "rs-k-card-sub", meta);
      this.pill = h("div", "rs-k-pill", el);
      this.empty = h("div", "rs-k-empty", el);
      this.empty.innerHTML = `<div class="rs-k-empty-icon">${ICON.mic}</div><div>${this.hooks.emptyHtml ||
        "<b>No song loaded</b><br><span>Pick a song with lyrics, or drop a Rocksmith <code>.psarc</code> that has a vocals track.</span>"}</div>`;
      this.banner = h("div", "rs-k-banner", el);
      this._buildTransport();
      // plugins (karaoke-voice.js: the original voice; karaoke-sing.js: microphone scoring), when loaded
      this.plugins = {};
      for (const pl of K.plugins || []) { try { this.plugins[pl.name] = pl.create(this); } catch (e) { /* a plugin failed: the player still works */ } }
      this.voice = this.plugins.voice || null;
      this.sing = this.plugins.sing || null;
      if (this.voice) this.deck.wantGraph = true;

      this._ro = new ResizeObserver(() => this._resize());
      this._ro.observe(el);
      this._onKey = (e) => this._key(e);
      document.addEventListener("keydown", this._onKey);
      this.track.addEventListener("click", (e) => {
        const line = e.target.closest && e.target.closest(".rs-k-line");
        if (line && this.song) this.seekLine(+line.dataset.i);
      });
      this._loop = this._loop.bind(this);
      this._raf = 0;
      this.applyOptions({});
      this._sync();
    }

    // ---- data ------------------------------------------------------------------------
    /** data: {song: payload (JSON string or object), options} -- or the payload itself. */
    load(data) {
      if (!data) { this.clear(); return; }
      let payload = data.song !== undefined ? data.song : data;
      if (!payload) { this.clear(); return; }
      if (typeof payload === "string") payload = JSON.parse(payload);
      this._payload = payload;
      this._syncState = null;
      const S = K.prepare(payload);
      const same = S.songKey && this.song && S.songKey === this.song.songKey;
      if (!same) this.deck.reset(S.songKey, S.duration);
      else this.clock.duration = Math.max(this.clock.duration, S.duration);
      this.song = S;
      this._buildLines();
      this._setMeta();
      if (data.options) this.applyOptions(data.options);
      this.el.classList.add("has-song");
      this._buildStrip();
      this._state = null; this._sec = undefined; this._cueOn = undefined; this._cueTxt = undefined; this._cueDots = undefined;
      this._jumpTo = null;
      this._layout(true);
      this._sync();
      this._start();
      this._plug("load", S);
      if (this.hooks.onReady) this.hooks.onReady({ songKey: S.songKey, audio: this.deck.kind || "none",
        hasAudio: this.deck.kind === "full", formats: K.playableFormats(), nonce: Date.now() });
      this._lyricsNotice();
      if (!S.lines.length && payload.lyrics && payload.lyrics.lookup && !payload.lyrics.lrc) this._lookup();
      else this._autoSync();
    }

    /** Rebuild the song model from the (changed) payload, keeping audio and position. */
    _reprepare() {
      const S = K.prepare(this._payload);
      this.song = S;
      this.clock.duration = Math.max(this.clock.duration, S.duration);
      this._buildLines(); this._buildStrip();
      this._state = null; this._sec = undefined; this._cueOn = undefined;
      this._layout(true); this._sync();
    }

    _lyricsNotice() {
      const L = this.song && this.song.lyrics;
      this.el.classList.toggle("is-unsynced", !!(L && L.plain));
      const est = !!(this.song && this.song.estimated);
      this.el.classList.toggle("is-estimated", est);
      if (this.estBadge) this.estBadge.style.display = est ? "" : "none";
      if (L && L.plain) this.status("These lyrics have no timing: they are shown as a sheet to scroll.", "info");
    }

    /** No lyrics yet, only who to ask: look them up on LRCLIB from the browser. */
    async _lookup() {
      const p = this._payload, key = p.songKey;
      this.status("Looking up the lyrics online (LRCLIB)\u2026", "info");
      const hit = K.lookupLRCLIB ? await K.lookupLRCLIB(p.lyrics.lookup) : null;
      if (!this.song || this.song.songKey !== key) return;
      if (!hit || hit.offline) {
        this.status(hit && hit.offline ? "Could not reach the lyrics service (LRCLIB) \u2014 offline? Load a .lrc file to sing along."
                                       : "No lyrics found online for this song. Load a .lrc file (\u201cLyrics\u2026\u201d) to sing along.", "error");
        return;
      }
      Object.assign(p.lyrics, hit);
      this._reprepare();
      this._lyricsNotice();
      if (this.hooks.onLyrics) this.hooks.onLyrics({ songKey: key, lyrics: hit, nonce: Date.now() });
      this._autoSync();
    }

    /** Lyrics from an LRC: align them to this recording once its full audio is in. */
    async _autoSync() {
      const p = this._payload, L = p && p.lyrics, S = this.song;
      if (!L || !L.lrc || L.align === false || L.offsetMs != null || !S || !S.lines.length || S.lyrics.plain) return;
      if (this.deck.kind !== "full" || this._syncState) return;          // retried when the full audio arrives
      const key = S.songKey, audio = this.deck.audio;
      this._syncState = "running";
      this.status("Syncing the lyrics to this recording\u2026", "info");
      let res = null, err = null;
      try {
        const ab = audio ? await this.decodeAudio(8000) : null;
        if (!ab) throw new Error("the audio could not be decoded for syncing");
        if (!this.song || this.song.songKey !== key) return;
        res = await K.alignLRC(ab, S.lines, { audioDuration: ab.duration, lrcDuration: L.lrcDuration });
      } catch (e) { err = e; }
      if (!this.song || this.song.songKey !== key) return;
      this._syncState = "done";
      if (!res) {
        this.status(`Could not sync the lyrics automatically (${err && err.message || err}); use Lyrics timing to adjust.`, "error");
        return;
      }
      L.offsetMs = Math.round(1000 * res.offset);
      L.confidence = res.confidence;
      this._reprepare();
      const s = res.offset;
      this.status(res.moved ? `Lyrics synced to this recording (${s > 0 ? "+" : ""}${s.toFixed(2)} s).`
                            : "Lyrics checked against this recording: they already fit.", "info");
      setTimeout(() => { if (this.song && this.song.songKey === key && /^Lyrics (synced|checked)/.test(this.banner.textContent)) this.status("", "clear"); }, 5000);
      if (this.hooks.onAligned) this.hooks.onAligned({ songKey: key, offsetMs: L.offsetMs, confidence: res.confidence, moved: res.moved, nonce: Date.now() });
    }

    clear() {
      this.deck.reset(null, 0);
      this.song = null;
      this.track.innerHTML = ""; this.lineEls = []; this.secEls = []; this.sylEls = [];
      this._jumpTo = null; this._payload = null; this._syncState = null;
      this.el.classList.remove("has-song", "is-unsynced", "is-estimated");
      if (this.estBadge) this.estBadge.style.display = "none";
      this.backdrop.style.backgroundImage = ""; this.art.style.backgroundImage = "";
      this.art.classList.add("is-empty");
      this.cue.classList.remove("is-on"); this.pill.classList.remove("is-on");
      this._stop();
      this._sync();
      this._plug("load", null);
    }

    setAudio(url, songKey, kind, seconds) {
      if (songKey && this.song && songKey !== this.song.songKey) return Promise.resolve(false);
      return this.deck.set(url, songKey || (this.song && this.song.songKey), kind, seconds);
    }

    _setMeta() {
      const m = this.song.meta || {};
      this.title.textContent = m.title || "Untitled";
      this.sub.textContent = [m.artist, m.album && m.album !== m.title ? m.album : null, m.year].filter(Boolean).join("  \u00b7  ");
      let url = null;
      if (this.song.art && HW.ddsToDataURL) { try { url = HW.ddsToDataURL(this.song.art); } catch (e) { url = null; } }
      this.art.style.backgroundImage = url ? `url(${url})` : "";
      this.art.classList.toggle("is-empty", !url);
      this.backdrop.style.backgroundImage = url ? `url(${url})` : "";
    }

    _buildLines() {
      const S = this.song;
      this.track.innerHTML = "";
      this.lineEls = []; this.secEls = []; this.sylEls = [];
      if (S.lyrics && S.lyrics.plain) {                         // unsynced lyrics
        for (const text of S.lyrics.plain) h("div", "rs-k-line is-next", this.track, text);
        return;
      }
      S.lines.forEach((L, k) => {
        if (S.cues[k]) { const c = h("div", "rs-k-sec", this.track, S.cues[k]); this.secEls.push(c); }
        const el = h("div", "rs-k-line is-future", this.track);
        el.dataset.i = k;
        el.title = `${fmt(L.start)}  \u00b7  click to sing from here`;
        const spans = [];
        for (const W of L.words) {
          spans.push(h("span", "rs-k-syl", el, W.w));
          if (!W.j) el.appendChild(document.createTextNode(" "));
        }
        this.lineEls.push(el); this.sylEls.push(spans);
      });
    }

    // ---- options -----------------------------------------------------------------------
    applyOptions(o) {
      if (!o) return;
      const O = this.opts;
      for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined && o[k] !== null) O[k] = o[k];
      this.el.classList.toggle("is-sheet", O.view === "sheet");
      this.el.classList.toggle("no-sections", !O.sectionLabels);
      this.el.classList.toggle("no-backdrop", !O.backdrop);
      this.el.style.setProperty("--rs-k-scale", String(clamp(+O.textScale || 1, 0.4, 3)));
      this.offset = (+O.offsetMs || 0) / 1000;
      this.deck.autoLatency = !!O.autoLatency;
      // apply the speed only when the *setting* changes
      if (+O.playbackRate > 0 && +O.playbackRate !== this._rateSetting) {
        this._rateSetting = +O.playbackRate;
        this.clock.setRate(this._rateSetting);
      }
      this._layout(true);
      this._sync();
    }
    /** Shiny-style alias */
    settings(o) { this.applyOptions(o); }

    // ---- transport ---------------------------------------------------------------------
    _buildTransport() {
      const bar = (this.transport = h("div", "rs-k-transport", this.el));
      const btn = (cls, svg, title, fn) => {
        const b = h("button", "rs-k-btn" + (cls ? " " + cls : ""), bar);
        b.type = "button"; b.innerHTML = svg; b.title = title; b.setAttribute("aria-label", title);
        b.addEventListener("click", (e) => { fn(); e.currentTarget.blur(); });
        return b;
      };
      this.btnPlay = btn("rs-k-btn-play", ICON.play, "Play / pause (Space)", () => this.togglePlay());
      btn("", ICON.restart, "Back to the start (Home)", () => this.seek(0));
      btn("", ICON.prev, "Previous line (\u2191)", () => this.stepLine(-1));
      btn("", ICON.next, "Next line (\u2193)", () => this.stepLine(1));
      this.time = h("span", "rs-k-time", bar);
      this.strip = h("div", "rs-k-strip", bar);
      this.segs = h("div", "rs-k-segs", this.strip);
      this.future = h("div", "rs-k-future", this.strip);
      this.head = h("div", "rs-k-head", this.strip);
      this.hover = h("div", "rs-k-hovertip", this.strip);
      this.rateBadge = h("span", "rs-k-badge", bar);
      this.estBadge = h("span", "rs-k-badge rs-k-badge-est", bar, "\u2248 syllables");
      this.estBadge.title = "These lyrics are timed per line: the syllable highlight is estimated, not measured.";
      this.estBadge.style.display = "none";
      const at = (e) => { const r = this.strip.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * (this.clock.duration || 0); };
      this.strip.addEventListener("pointerdown", (e) => {
        if (!this.song) return;
        this.strip.setPointerCapture(e.pointerId);
        this.seek(at(e));
        const move = (ev) => this.seek(at(ev));
        const up = () => { this.strip.removeEventListener("pointermove", move); this.strip.removeEventListener("pointerup", up); };
        this.strip.addEventListener("pointermove", move);
        this.strip.addEventListener("pointerup", up);
      });
      this.strip.addEventListener("mousemove", (e) => {
        if (!this.song) return;
        const t = at(e), s = this.song.sections, r = this.strip.getBoundingClientRect();
        const i = upperBound(s.t, t + 1e-6) - 1;
        this.hover.textContent = (i >= 0 ? s.label[i] + "  \u00b7  " : "") + fmt(t);
        this.hover.style.left = clamp(e.clientX - r.left, 0, r.width) + "px";
      });
    }

    /** Timeline: sections as segments, sung lines as bars. */
    _buildStrip() {
      this.segs.innerHTML = "";
      const S = this.song, d = this.clock.duration || S.duration || 1;
      this._stripDur = d;
      const s = S.sections;
      for (let i = 0; i < s.n; i++) {
        const t0 = s.t[i], t1 = i + 1 < s.n ? s.t[i + 1] : d;
        const seg = h("div", "rs-k-seg" + (i % 2 ? " is-odd" : ""), this.segs);
        seg.style.left = (100 * t0 / d) + "%"; seg.style.width = Math.max(0, 100 * (t1 - t0) / d) + "%";
      }
      for (const L of S.lines) {
        const b = h("div", "rs-k-sung", this.segs);
        b.style.left = (100 * L.start / d) + "%"; b.style.width = Math.max(0.15, 100 * (L.end - L.start) / d) + "%";
      }
    }

    _sync(t) {
      if (t == null) t = this.clock.time(performance.now());
      const playing = this.clock.playing;
      if (playing !== this._shownPlaying) {
        this._shownPlaying = playing;
        this.btnPlay.innerHTML = playing ? ICON.pause : ICON.play;
        this.btnPlay.classList.toggle("is-playing", playing);
      }
      const d = this.clock.duration || 0;
      this.time.textContent = `${fmt(t)} / ${fmt(d)}`;
      const u = d ? clamp(t / d, 0, 1) : 0;
      this.head.style.left = (100 * u) + "%";
      this.future.style.left = (100 * u) + "%";
      this.transport.classList.toggle("is-silent", !this.deck.audio);
      const r = this.clock.rate;
      this.rateBadge.textContent = r !== 1 ? `${Math.round(r * 100)}%` : "";
      this.rateBadge.style.display = r !== 1 ? "" : "none";
      if (this.song && d && Math.abs(d - (this._stripDur || 0)) > 0.5) this._buildStrip();
    }

    _audioChanged() {
      if (this.song) this._buildStrip();
      this._sync();
      this._autoSync();
    }

    async togglePlay() {
      if (!this.song) return;
      const c = this.clock, deck = this.deck;
      if (!c.playing && deck.autoLatency && !deck.out.ctx && !deck.out.failed) {
        await deck.out.ensure();                     // user gesture: create + resume the graph
        if (!c.playing && this._visible === false) return;   // hidden meanwhile (the app switched modes)
      }
      if (!c.playing) deck.joinGraph();             // about to start: nothing else is playing
      const t = c.time(performance.now());
      if (!c.playing && deck.kind === "head" && t >= deck.headLimit) {
        c.playHeld(t);
        this.status("Loading the rest of the audio\u2026", "info");
        return;
      }
      if (!c.playing && c.duration > 0 && t >= c.duration - 0.05) this.seek(0);
      const was = c.playing;
      c.toggle();
      if (!was && c.playing) this._plug("playing");
      if (was) deck.joinGraph();                    // just paused: safe moment to join
      this._sync();
    }
    play() { if (!this.clock.playing) return this.togglePlay(); }
    pause() { if (this.clock.playing) { this.clock.pause(); this.deck.joinGraph(); this._sync(); } }

    seek(t) {
      if (!this.song) return;
      t = Math.max(0, t);
      this._jumpTo = null;
      this.deck.joinGraph();
      if (this.deck.kind === "head" && t >= this.deck.headLimit) {
        this.clock.hold(t);
        this.status("Loading the rest of the audio\u2026", "info");
      } else {
        this.clock.seek(t);
        if (this.deck.kind !== "head" || !this.clock.holding) this.status("", "clear");
      }
      this._jump = true;                            // no scroll animation after a jump
      this._sync();
      this._drawOnce();
      this._plug("seeked", t - this.offset - this._lat);
    }
    /** Jump to a line with a 1.5 s run-up (in song time, i.e. as heard). */
    seekLine(k) {
      if (!this.song) return;
      k = clamp(k | 0, 0, this.song.lines.length - 1);
      this.seek(this.song.lines[k].start - 1.5 + this.offset + this._lat);
      this._jumpTo = k;                               // (after seek(), which forgets it)
    }
    /** Previous / next line (up / down). Relative to the line being sung -- or, during
     *  the run-up after a jump, to the line jumped to (the previous line is still
     *  shown then). "Previous" first restarts the current line once it is under way. */
    stepLine(dir) {
      if (!this.song) return;
      const L = this.song.lines, t = this.lyricTime(performance.now());
      let cur = -1;
      while (cur + 1 < L.length && L[cur + 1].start <= t + 1e-6) cur++;
      const pending = this._jumpTo != null && this._jumpTo < L.length && t < L[this._jumpTo].start ? this._jumpTo : null;
      let k;
      if (dir > 0) k = (pending != null ? pending : cur) + 1;
      else k = pending != null ? pending - 1 : cur >= 0 && t - L[cur].start > 1 ? cur : cur - 1;
      this.seekLine(clamp(k, 0, L.length - 1));
    }

    /** Replace the lyrics of the current song with an LRC ({lrc, source, songKey?}); it is synced to the audio. */
    setLyrics(a) {
      if (!this._payload || !a || !a.lrc || (a.songKey && a.songKey !== this._payload.songKey)) return false;
      this._payload.vocals = { t: [], d: [], w: [], j: [], l: [] };
      this._payload.lyrics = { source: a.source || "file", lrc: a.lrc, lrcDuration: a.lrcDuration || null, align: a.align !== false };
      this._syncState = null;
      this._reprepare();
      this._lyricsNotice();
      this._autoSync();
      return true;
    }

    /** Lyric time (as heard) of a performance.now() timestamp. */
    lyricTime(perfMs) { return this.clock.time(perfMs) - this.offset - this._lat; }

    /** Banner. `owner` ("audio" for the audio loader) may clear only its own messages,
     *  so audio finishing to load does not wipe e.g. a lyrics message. */
    status(text, level, owner) {
      owner = owner || "player";
      if ((!text || level === "clear") && this._bannerOwner && owner !== this._bannerOwner && owner === "audio") return;
      this._bannerOwner = text && level !== "clear" ? owner : null;
      this.banner.textContent = text || "";
      this.banner.className = "rs-k-banner" + (text && level !== "clear" ? " is-" + level : "");
    }

    command(msg) {
      const a = msg.args || {};
      switch (msg.cmd) {
        case "audio": this.setAudio(a.url, a.songKey, a.kind, a.seconds); break;
        case "play": this.play(); break;
        case "pause": this.pause(); break;
        case "seek": this.seek(+a.time || 0); break;
        case "settings": this.applyOptions(a.settings); break;
        case "status": this.status(a.text, a.level); break;
        case "lyrics": this.setLyrics(a); break;
        case "voice": if (this.voice) this.voice.set(a, "host"); break;                        // {volume, mute}
        case "sing": if (this.sing) { if (a.on) this.sing.start(); else this.sing.stop(); } break;
        case "score_ack": if (this.sing) this.sing.ack(a); break;                      // {newBest, best, previous}
        default: console.warn("rs-karaoke: unknown command", msg.cmd);
      }
    }

    // ---- view ----------------------------------------------------------------------------
    /** Re-measure line positions (after load, resize, text size / view change). */
    _layout(jump) {
      if (!this.song || !this.lineEls || !this.lineEls.length) return;
      this._vpH = this.viewport.clientHeight;
      this._pos = this.lineEls.map((e) => e.offsetTop + e.offsetHeight / 2);
      // top of each line's block: its section label when it has one (and labels are shown)
      this._top = this.lineEls.map((e) => {
        const sec = e.previousElementSibling;
        return sec && sec.classList.contains("rs-k-sec") && sec.offsetHeight ? sec.offsetTop : e.offsetTop;
      });
      this._scrolledTo = null;
      if (jump) this._jump = true;
      this._drawOnce();
    }

    _anchor() { return this._vpH * (this.opts.view === "sheet" ? 0.34 : 0.44); }

    _scrollTo(k) {
      if (!this._pos || k < 0 || k >= this._pos.length) return;
      const y = Math.round(this._anchor() - this._pos[k]);
      if (y === this._scrolledTo) return;
      this._scrolledTo = y;
      this.track.classList.toggle("no-anim", !!this._jump);
      this.track.style.transform = `translate3d(0, ${y}px, 0)`;
      if (this._jump) { void this.track.offsetHeight; this.track.classList.remove("no-anim"); }
      this._jump = false;
      // the cue (intro / break countdown) sits just above the focus line and its section label
      this.cue.style.top = Math.max(8, this.viewport.offsetTop + this._anchor() - this._pos[k] + this._top[k] - 8) + "px";
    }

    /** Draw the lyrics for lyric time t (only touches the DOM when something changed). */
    render(t) {
      const S = this.song;
      if (!S || !this.lineEls) return;
      if (S.lyrics && S.lyrics.plain) return;                   // unsynced lyrics: a sheet to scroll by hand
      const st = K.state(S, t), prev = this._state;
      this._state = st;
      const lineChanged = !prev || prev.focus !== st.focus || prev.mode !== st.mode;
      if (lineChanged) {
        const cur = st.mode === "sing" || st.mode === "outro";
        for (let k = 0; k < this.lineEls.length; k++) {
          const cls = k < st.focus ? "is-past" : k > st.focus ? "is-future" : cur ? "is-current" : "is-next";
          const e = this.lineEls[k];
          if (e._cls !== cls) { e.className = "rs-k-line " + cls; e._cls = cls; }
        }
        if (prev && prev.focus >= 0 && prev.focus !== st.focus) this._paintWords(prev.focus, -1, 0, true);
      }
      this._scrollTo(st.focus);
      if (st.mode === "sing" || st.mode === "outro") this._paintWords(st.focus, st.word, st.p, lineChanged || !prev || prev.word !== st.word);
      // intro / break cue: "Intro . 0:12" or "Instrumental . 0:08", count-in dots in the last seconds
      const waiting = st.mode === "intro" || st.mode === "break";
      if (waiting) {
        const left = st.until - t;
        const dots = this.opts.countIn && left <= COUNT_IN ? Math.ceil(left) : 0;
        const txt = left > COUNT_IN || !this.opts.countIn ? `${st.mode === "intro" ? "Intro" : "Instrumental"}  \u00b7  ${fmt(Math.ceil(left))}` : "";
        if (txt !== this._cueTxt) { this.cueText.textContent = txt; this._cueTxt = txt; }
        if (dots !== this._cueDots) {
          this._cueDots = dots;
          const ds = this.cueDots.children;
          for (let i = 0; i < ds.length; i++) ds[i].className = i < dots ? "is-on" : "";
          this.cue.classList.toggle("is-counting", dots > 0);
        }
      }
      if (waiting !== this._cueOn) { this._cueOn = waiting; this.cue.classList.toggle("is-on", waiting); }
      // section pill
      const si = upperBound(S.sections.t, t + 1e-6) - 1;
      if (si !== this._sec) {
        this._sec = si;
        this.pill.textContent = si >= 0 ? S.sections.label[si] : "";
        this.pill.classList.toggle("is-on", si >= 0);
      }
    }

    /** Syllable classes of line k: before `word` sung, `word` wiping (p), after unsung. */
    _paintWords(k, word, p, full) {
      const spans = this.sylEls[k];
      if (!spans) return;
      if (full) {
        for (let i = 0; i < spans.length; i++) {
          const cls = i < word ? "rs-k-syl is-sung" : i === word ? "rs-k-syl is-now" : "rs-k-syl";
          if (spans[i].className !== cls) spans[i].className = cls;
          if (i !== word && spans[i]._p != null) { spans[i].style.removeProperty("--p"); spans[i]._p = null; }
        }
      }
      if (word >= 0 && word < spans.length) {
        const q = Math.round(p * 200) / 200;
        const sp = spans[word];
        if (sp._p !== q) { sp._p = q; sp.style.setProperty("--p", String(q)); }
      }
    }

    // ---- loop ----------------------------------------------------------------------------
    _start() { if (!this._raf) { this._lastFrame = 0; this._raf = requestAnimationFrame(this._loop); } }
    _stop() { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; }

    /** Call a method on every plugin that has it. */
    _plug(name, ...args) {
      for (const k in this.plugins || {}) { const x = this.plugins[k]; if (x && typeof x[name] === "function") { try { x[name](...args); } catch (e) { /* keep playing */ } } }
    }

    /** The song's audio decoded at `sr` Hz (stereo AudioBuffer; cached per song), or null. */
    async decodeAudio(sr) {
      const audio = this.deck.audio, key = this.song && this.song.songKey;
      if (!audio || this.deck.kind !== "full") return null;
      const ck = key + "@" + sr;
      if (this._decoded && this._decoded.key === ck) return this._decoded.buf;
      if (audio._direct) throw new Error("a page opened from disk cannot read the audio files next to it (open it through a web server, or export it with the audio embedded)");
      const src = audio._url || audio.currentSrc || audio.src;
      const data = await (await fetch(src)).arrayBuffer();
      let ab = null;
      for (const rate of [sr, 16000, 22050, 44100]) {
        try {
          const OAC = root.OfflineAudioContext || root.webkitOfflineAudioContext;
          ab = await new OAC(2, rate, rate).decodeAudioData(data.slice(0)); break;
        } catch (e) { ab = null; }
      }
      if (ab && this.song && this.song.songKey === key) this._decoded = { key: ck, buf: ab };
      return ab;
    }

    _loop(ts) {
      this._raf = 0;
      if (!this.el.isConnected) { this.destroy(); return; }
      const dt = this._lastFrame ? (ts - this._lastFrame) / 1000 : 0;
      this._lastFrame = ts;
      if (dt > 0 && dt < 0.1) this.frameLead = this.frameLead * 0.9 + dt * 0.1;
      this.clock.tick(ts);
      const t = this.clock.time(ts + this.frameLead * 1000);      // when this frame is on screen
      const deck = this.deck;
      if (deck.kind === "head" && this.clock.playing && !this.clock.holding && t >= deck.headLimit) {
        this.clock.hold(t);
        this.status("Loading the rest of the audio\u2026", "info");
      }
      // output latency, ramped at 0.1 s/s so the highlight never jumps
      const target = deck.latency(ts);
      this._lat += clamp(target - this._lat, -0.1 * dt, 0.1 * dt) || 0;
      if (dt <= 0 || dt > 0.5 || Math.abs(this._lat - target) < 1e-4) this._lat = target;
      if (Math.abs(target - this._latReported) > 0.002 && this._lat === target) {
        this._latReported = target;
        if (this.hooks.onLatency) this.hooks.onLatency({ outputMs: Math.round(1000 * deck.out.latency(ts + 2000)),
          routed: !!(deck.audio && deck.audio._gain), auto: deck.autoLatency, nonce: Date.now() });
      }
      if (this.voice) this._plug("frame_voice", t - this.offset);   // the audio being processed (before the output delay)
      if (this._visible !== false) {
        this.render(t - this.offset - this._lat);
        this._plug("frame", t - this.offset - this._lat);
        if (ts - (this._lastUi || 0) > 100) { this._lastUi = ts; this._sync(t); }
      }
      if (this.hooks.onState && this.clock.playing && ts - (this._lastState || 0) > 500) {
        this._lastState = ts;
        this.hooks.onState({ t: +t.toFixed(3), playing: true, line: this._state ? this._state.focus : -1, nonce: Date.now() });
      }
      this._raf = requestAnimationFrame(this._loop);
    }

    _drawOnce() {
      if (!this.song || this._raf) return;           // the loop will pick it up
      this.render(this.lyricTime(performance.now()));
    }

    _resize() {
      const r = this.el.getBoundingClientRect();
      this._visible = r.width > 0 && r.height > 0;
      if (!this._visible && this.clock.playing) this.pause();   // a hidden player never plays
      this.el.classList.toggle("is-compact", r.width < 720);
      if (this._visible) this._layout(true);
    }

    _key(e) {
      if (!this.song || !this.el.isConnected || !this._visible || !this.el.getClientRects().length) return;
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|SELECT|TEXTAREA|BUTTON/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const t = this.clock.time(performance.now());
      switch (e.code) {
        case "Space": this.togglePlay(); break;
        case "ArrowLeft": this.seek(t - 5); break;
        case "ArrowRight": this.seek(t + 5); break;
        case "ArrowUp": this.stepLine(-1); break;
        case "ArrowDown": this.stepLine(1); break;
        case "Home": this.seek(0); break;
        default: return;
      }
      e.preventDefault();
    }

    destroy() {
      this._plug("destroy");
      this._stop();
      this.deck.unload();
      this._ro.disconnect();
      document.removeEventListener("keydown", this._onKey);
      if (this.hooks.onDestroy) this.hooks.onDestroy(this);
    }
  }
  K.KaraokePlayer = KaraokePlayer;
})(window);
