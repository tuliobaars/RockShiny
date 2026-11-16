/* ---------------------------------------------------------------------------
 * clock.js -- playback clock for the note highway.
 *
 * The <audio> element is the MASTER. The chart is never "played" on its own
 * timer, which is what causes drift in naive implementations.
 *
 * Problem: HTMLMediaElement.currentTime is updated at a coarse, browser-
 * specific cadence (and is stale by the time you read it), so drawing with it
 * directly makes notes judder at 60 fps.
 * Solution: keep an anchor (mediaTime, perfTime) and extrapolate with the
 * frame timestamp. Whenever the element reports a new currentTime we measure
 * the error and slew towards it (small errors) or snap (seek/stall).
 *
 * Without audio (not converted yet / no decoder) the clock free-runs, so
 * the chart is still usable silently. Audio attached later takes over at the
 * current position.
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});

  const SNAP_THRESHOLD = 0.05;  // s: larger errors -> hard resync (seek, stall, GC pause)
  // Error correction is time-based (not per report) so it converges equally
  // fast at 60 fps and on a slow machine rendering 20 fps. 0.33 s matches the
  // previously tuned 5 %-per-frame at 60 fps.
  const SLEW_TAU = 0.33;        // s

  class SongClock {
    constructor() {
      this.audio = null;
      this.duration = 0;
      this.rate = 1;
      this.playing = false;       // transport intent
      this._running = false;      // clock actually advancing
      this._anchorMedia = 0;
      this._anchorPerf = 0;
      this._lastReported = NaN;
      this._listeners = null;
      this.onEnded = null;
      this.onStateChange = null;
      this.partialAudio = false;    // true while the attached audio is a quick-start clip
    }

    /** Current media time (s) at performance timestamp `nowMs`. */
    time(nowMs) {
      let t = this._anchorMedia;
      if (this._running && !this._waiting) t += ((nowMs - this._anchorPerf) / 1000) * this.rate;
      if (t < 0) return 0;
      return this.duration > 0 && t > this.duration ? this.duration : t;
    }

    /** Call once per animation frame with the rAF timestamp. */
    tick(nowMs) {
      const a = this.audio;
      if (a && this._running && !a.paused) {
        const reported = a.currentTime;
        if (reported !== this._lastReported) {
          this._lastReported = reported;
          if (this._waiting) {                       // paused for the audio to catch up
            if (reported >= this._anchorMedia - 0.002) this._anchor(reported, nowMs);
            return;
          }
          const err = reported - this.time(nowMs);
          const since = this._lastReportPerf ? (nowMs - this._lastReportPerf) / 1000 : 1 / 60;
          this._lastReportPerf = nowMs;
          if (err < -SNAP_THRESHOLD && err > -0.5) {
            // audio fell behind (start-up, stall): wait for it -- never step back while playing
            this._anchor(this.time(nowMs), nowMs);
            this._waiting = true;
          } else if (Math.abs(err) > SNAP_THRESHOLD) this._anchor(reported, nowMs);
          else this._anchorMedia += err * (1 - Math.exp(-Math.min(since, 0.25) / SLEW_TAU));
        }
      } else if (!a && this._running && this.duration > 0 && this.time(nowMs) >= this.duration) {
        this._stopAt(this.duration);
        if (this.onEnded) this.onEnded();
      }
    }

    play() {
      if (this.playing) return;
      this.playing = true;
      if (this.audio) {
        const p = this.audio.play();        // 'playing' event anchors the clock
        if (p && p.catch) p.catch((e) => { if (this._holding || e.name === "AbortError") return; this.playing = false; this._emit(e); });
      } else {
        if (this.duration > 0 && this._anchorMedia >= this.duration) this._anchorMedia = 0;
        this._anchor(this._anchorMedia, performance.now());
        this._running = true;
      }
      this._emit();
    }

    pause() {
      if (!this.playing) return;
      const now = performance.now();
      this.playing = false;
      this._holding = false;
      if (this.audio) {
        this.audio.pause();
        this._stopAt(this.audio.currentTime);
      } else {
        this._stopAt(this.time(now));
      }
      this._emit();
    }

    toggle() { this.playing ? this.pause() : this.play(); }

    seek(t) {
      t = Math.max(0, this.duration > 0 ? Math.min(t, this.duration) : t);
      this._anchor(t, performance.now());
      if (this.audio) this.audio.currentTime = t;   // 'seeked' re-anchors precisely
      if (this._holding) {                           // leaving a hold: resume if playing
        this._holding = false;
        if (this.playing) {
          if (this.audio) { const p = this.audio.play(); if (p && p.catch) p.catch(() => {}); }
          else this._running = true;
        }
      }
      this._emit();
    }

    /**
     * Freeze at `t` (default: now) but keep the intent to play: used while the
     * rest of the audio is still loading (quick-start clip ran out, or a seek
     * beyond it). Attaching the next audio element resumes playback.
     */
    hold(t) {
      const now = performance.now();
      if (t == null) t = this.time(now);
      this._holding = true;
      if (this.audio && !this.audio.paused) { this._ignorePause = true; this.audio.pause(); }
      this._stopAt(t);
      this._emit();
    }
    get holding() { return !!this._holding; }

    /** Start "playing" in the held state (e.g. play pressed beyond a quick-start clip). */
    playHeld(t) {
      this.playing = true;
      this.hold(t);
    }

    /**
     * Make `audio` (already playing, aligned with the current one) the master
     * without seeking it. Returns the previous element, still playing: the
     * caller fades it out and releases it.
     */
    handover(audio) {
      const old = this.audio;
      if (old && this._listeners) for (const k in this._listeners) old.removeEventListener(k, this._listeners[k]);
      this.audio = null; this._listeners = null;
      this._bind(audio);
      this.audio = audio;
      // no re-anchor: the new element is already aligned with the old one, so the
      // clock keeps its own continuous timeline and the normal slew absorbs the
      // few ms of difference (a hard anchor here showed up as a visible jump)
      this._lastReported = NaN;
      this._lastReportPerf = 0;
      this._running = !audio.paused;
      return old;
    }

    setRate(r) {
      const now = performance.now();
      this._anchor(this.time(now), now);
      this.rate = r;
      if (this.audio) {
        this.audio.playbackRate = r;
        this.audio.preservesPitch = true;
      }
    }

    /** Hand the clock over to an <audio> element, keeping the position. */
    attach(audio) {
      this.detach();
      const now = performance.now();
      const pos = this.time(now);
      this._holding = false;
      this._bind(audio);
      this.audio = audio;
      audio.playbackRate = this.rate;
      audio.preservesPitch = true;
      audio.currentTime = pos;
      if (this.playing) {
        // keep free-running until the element actually starts ('playing')
        const p = audio.play();
        if (p && p.catch) p.catch((e) => { if (this._holding || e.name === "AbortError") return; this.playing = false; this._stopAt(pos); this._emit(e); });
      }
    }

    _bind(audio) {
      const on = {
        playing: () => {
          if (this._holding) { this._ignorePause = true; audio.pause(); return; }   // a late 'playing' must not end a hold
          this._anchor(audio.currentTime, performance.now()); this._running = true;
        },
        play: () => { if (!this.playing) { this.playing = true; this._emit(); } },
        pause: () => {                                             // also OS media keys
          if (this._ignorePause) { this._ignorePause = false; return; }   // our own hold()
          if (this._holding) return;
          this._stopAt(audio.currentTime);
          if (this.playing && !audio.ended) { this.playing = false; this._emit(); }
        },
        // (while holding, the clock stays at the hold point: late events from the
        //  element -- e.g. 'waiting' after a play() that was just paused -- must not move it)
        waiting: () => { if (!this._holding) this._stopAt(audio.currentTime); },      // buffering stall
        seeked: () => { if (!this._holding) this._anchor(audio.currentTime, performance.now()); },
        ended: () => {
          // a quick-start clip running out is not the end of the song: hold
          if (this.partialAudio && this.playing) { this.hold(audio.duration); return; }
          this.playing = false; this._stopAt(audio.duration); this._emit(); if (this.onEnded) this.onEnded();
        },
        durationchange: () => { if (isFinite(audio.duration)) this.duration = Math.max(this.duration, audio.duration); },
      };
      for (const k in on) audio.addEventListener(k, on[k]);
      this._listeners = on;
    }

    detach() {
      const a = this.audio;
      if (!a) return;
      const now = performance.now();
      const pos = this.time(now);
      for (const k in this._listeners) a.removeEventListener(k, this._listeners[k]);
      a.pause();
      this.audio = null;
      this._listeners = null;
      this._anchor(pos, now);
      this._running = this.playing;             // continue silently if playing
    }

    _anchor(media, perf) {
      this._anchorMedia = media;
      this._anchorPerf = perf;
      this._lastReported = NaN;
      this._lastReportPerf = 0;
      this._waiting = false;
    }
    _stopAt(media) {
      this._running = false;
      this._anchor(media, performance.now());
    }
    _emit(err) { if (this.onStateChange) this.onStateChange(this, err); }
  }

  /**
   * AudioOut -- routes playback through a Web Audio graph so the remaining
   * piece of the A/V chain, the audio device's output latency, is known
   * (AudioContext.outputLatency) and can be compensated automatically:
   *   shown chart time = clock - outputLatency - manual offset
   * Measured in Chromium with an AudioWorklet tap: without compensation the
   * picture leads the sound by ~outputLatency; with it the residual is a few ms.
   * The context is created on the first user gesture; an element is routed only
   * once the context is running (otherwise it keeps playing natively).
   */
  class AudioOut {
    constructor() {
      this.ctx = null; this.failed = false; this._latency = 0; this._latencyAt = 0;
      // until the device reports (first ~0.5 s), use the value remembered from last time
      try { this._remembered = Math.max(0, Math.min(0.5, +root.localStorage.getItem("rs-output-latency") || 0)); } catch (e) { this._remembered = 0; }
    }
    get ready() { return !!this.ctx && this.ctx.state === "running"; }
    async ensure() {
      if (this.ctx || this.failed) return this.ready;
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) { this.failed = true; return false; }
      try {
        this.ctx = new AC({ latencyHint: "interactive" });
        if (this.ctx.state !== "running") await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 400))]);
      } catch (e) { this.failed = true; this.ctx = null; }
      return this.ready;
    }
    /** Route an element through the graph (once); gives it a gain node for fades. */
    route(audio) {
      if (!audio || audio._gain || !this.ready) return !!(audio && audio._gain);
      try {
        audio._src = this.ctx.createMediaElementSource(audio);
        audio._gain = this.ctx.createGain();
        audio._src.connect(audio._gain).connect(this.ctx.destination);
        return true;
      } catch (e) { return false; }
    }
    /** Device output latency in seconds (0 if unknown), refreshed at most once a second. */
    latency(nowMs) {
      if (!this.ready) return 0;
      if (nowMs - this._latencyAt > (this._latency > 0 ? 1000 : 200)) {   // poll fast until the device reports
        this._latencyAt = nowMs;
        const l = +this.ctx.outputLatency;
        this._latency = isFinite(l) && l > 0 && l < 1 ? l : 0;
        if (this._latency > 0) { try { root.localStorage.setItem("rs-output-latency", String(this._latency)); } catch (e) { /* private mode */ } }
      }
      return this._latency || this._remembered;
    }
  }
  /** Volume that works for routed (gain node) and plain elements. */
  AudioOut.setVolume = (audio, v) => { if (audio._gain) audio._gain.gain.value = v; else audio.volume = v; };

  NS.SongClock = SongClock;
  NS.AudioOut = AudioOut;
})(window);
