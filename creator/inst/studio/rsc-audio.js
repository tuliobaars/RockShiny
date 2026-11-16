/* ---------------------------------------------------------------------------
 * rsc-audio.js -- the studio's audio: the song, its stems, a metronome and
 * guide tones (the chart played back as plucked notes), on Web Audio.
 *
 * Stems add up to the mix, so any mute / solo / volume combination is played
 * as  a * mix + sum_s (g_s - a) * stem_s  with `a` chosen to need the fewest
 * stem buffers (muting the vocals = the mix minus the vocal stem: two sources).
 * Stem buffers are made on demand from their 16-bit samples (a few kept).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const RSC = (root.RSCreator = root.RSCreator || {});
  const D = RSC.dsp;
  const STANDARD = [40, 45, 50, 55, 59, 64];

  class AudioEngine {
    constructor() {
      this.ctx = null; this.mix = null; this.duration = 0; this.sr = 44100;
      this.stems = null; this.stemBuffers = new Map();
      this.lanes = { mix: { gain: 1, mute: false, solo: false } };
      this.playing = false; this.pos = 0; this.rate = 1; this.volume = 0.9;
      this.loop = { on: false, a: 0, b: 0 };
      this.metronome = false; this.beats = [];
      this.guides = [];                                  // [{notes: [{t, d, midi}], on}]
      this.sources = []; this.listeners = new Set();
      this.peaks = null;
    }
    on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    emit(type, data) { for (const fn of this.listeners) fn(type, data); }
    ensureCtx() {
      if (!this.ctx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        this.ctx = new AC({ latencyHint: "interactive" });
        this.master = this.ctx.createGain(); this.master.gain.value = this.volume; this.master.connect(this.ctx.destination);
        this.fx = this.ctx.createGain(); this.fx.gain.value = 0.5; this.fx.connect(this.master);
      }
      return this.ctx;
    }

    /** Decode a browser-playable file (Ogg / WAV / MP3...). */
    async load(bytes) {
      const ctx = this.ensureCtx();
      const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      this.setBuffer(buf);
      return buf;
    }
    setBuffer(buf) {
      this.stop();
      this.mix = buf; this.duration = buf.duration; this.sr = buf.sampleRate;
      this.stems = null; this.stemBuffers.clear();
      for (const k of Object.keys(this.lanes)) if (k !== "mix") delete this.lanes[k];
      const m = buf.numberOfChannels > 1 ? D.mono([buf.getChannelData(0), buf.getChannelData(1)]) : buf.getChannelData(0);
      this.peaks = { mix: D.peaks(m, 256) };
      this.pos = 0;
      this.emit("loaded", { duration: this.duration });
    }
    channels() {
      if (!this.mix) return null;
      const out = [];
      for (let c = 0; c < Math.min(2, this.mix.numberOfChannels); c++) out.push(this.mix.getChannelData(c));
      return out;
    }

    /** Stems from the separation: {ids, stems: {id: [Int16 L, Int16 R]}, sr, start}. */
    setStems(sep) {
      const was = this.playing;
      if (was) this.pause();
      this.stems = sep; this.stemBuffers.clear();
      for (const id of sep.ids) {
        this.lanes[id] = this.lanes[id] || { gain: 1, mute: false, solo: false };
        const st = sep.stems[id], m = new Float32Array(st[0].length);
        for (let i = 0; i < m.length; i++) m[i] = (st[0][i] + st[1][i]) / 65536;
        this.peaks[id] = D.peaks(m, 256);
      }
      this.emit("stems", sep);
      if (was) this.play();
    }
    clearStems() { this.stems = null; this.stemBuffers.clear(); for (const k of Object.keys(this.lanes)) if (k !== "mix") delete this.lanes[k]; this.emit("stems", null); }
    stemBuffer(id) {
      if (this.stemBuffers.has(id)) { const b = this.stemBuffers.get(id); this.stemBuffers.delete(id); this.stemBuffers.set(id, b); return b; }
      const st = this.stems.stems[id], ctx = this.ensureCtx();
      const b = ctx.createBuffer(2, st[0].length, this.stems.sr);
      for (let c = 0; c < 2; c++) { const x = b.getChannelData(c), s = st[c]; for (let i = 0; i < s.length; i++) x[i] = s[i] / 32768; }
      this.stemBuffers.set(id, b);
      while (this.stemBuffers.size > 3) this.stemBuffers.delete(this.stemBuffers.keys().next().value);
      return b;
    }

    /** Effective gain of each lane after mute / solo. */
    gains() {
      const ids = Object.keys(this.lanes), anySolo = ids.some((k) => this.lanes[k].solo), g = {};
      for (const k of ids) { const l = this.lanes[k]; g[k] = l.mute || (anySolo && !l.solo) ? 0 : l.gain; }
      return g;
    }
    /**
     * The sources to play: [{buf, gain, offset}] (the decomposition above). The mix lane is
     * the recording's master (its mute silences everything, its solo plays the untouched
     * mix); stem mute / solo / volume act within it.
     */
    plan() {
      const mixLane = this.lanes.mix, master = mixLane.mute ? 0 : mixLane.gain;
      if (!this.stems || mixLane.solo) return master > 0 ? [{ buf: this.mix, gain: master, offset: 0 }] : [];
      const ids = this.stems.ids, anySolo = ids.some((i) => this.lanes[i].solo), eff = {};
      for (const i of ids) { const l = this.lanes[i]; eff[i] = master * (l.mute || (anySolo && !l.solo) ? 0 : l.gain); }
      let best = null;
      for (const a of [0].concat(ids.map((i) => eff[i]))) {              // fewest stem buffers wins
        const need = ids.filter((i) => Math.abs(eff[i] - a) > 1e-4);
        if (!best || need.length < best.need.length || (need.length === best.need.length && a > best.a)) best = { a, need };
      }
      const out = [];
      if (best.a > 1e-4) out.push({ buf: this.mix, gain: best.a, offset: 0 });
      for (const i of best.need) out.push({ buf: this.stemBuffer(i), gain: eff[i] - best.a, offset: this.stems.start || 0 });
      return out;
    }

    time() {
      if (!this.playing) return this.pos;
      return this.pos + (this.ctx.currentTime - this.t0) * this.rate;
    }
    play(from) {
      if (!this.mix) return;
      const ctx = this.ensureCtx();
      if (ctx.state === "suspended") ctx.resume();
      if (from != null) this.pos = Math.max(0, Math.min(this.duration, from));
      if (this.pos >= this.duration - 0.05) this.pos = 0;
      this.stopSources();
      const when = ctx.currentTime + 0.03;
      for (const p of this.plan()) {
        const src = ctx.createBufferSource(), gn = ctx.createGain();
        src.buffer = p.buf; src.playbackRate.value = this.rate; gn.gain.value = p.gain;
        src.connect(gn).connect(this.master);
        const off = this.pos - p.offset;
        if (off >= p.buf.duration) continue;
        if (off >= 0) src.start(when, off); else src.start(when + (-off) / this.rate, 0);
        this.sources.push(src);
      }
      this.t0 = when; this.playing = true;
      this.schedPos = this.pos;
      this.startScheduler();
      this.emit("play", this.pos);
    }
    stopSources() { for (const s of this.sources) { try { s.stop(); } catch (e) { /* already stopped */ } } this.sources = []; }
    pause() {
      if (!this.playing) return;
      this.pos = Math.min(this.duration, this.time());
      this.stopSources(); this.playing = false; this.stopScheduler();
      this.emit("pause", this.pos);
    }
    stop() { if (this.playing) this.pause(); }
    toggle() { if (this.playing) this.pause(); else this.play(); }
    seek(t) {
      t = Math.max(0, Math.min(this.duration || 0, t));
      if (this.playing) this.play(t); else { this.pos = t; this.emit("seek", t); }
    }
    setRate(r) { const was = this.playing; const t = this.time(); if (was) this.pause(); this.rate = r; this.pos = t; if (was) this.play(); }
    setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
    setLane(id, patch) {
      this.lanes[id] = Object.assign(this.lanes[id] || { gain: 1, mute: false, solo: false }, patch);
      if (this.playing) this.play(this.time());
      this.emit("lanes", this.lanes);
    }
    /** Called every animation frame by the studio: loops and song end. */
    tick() {
      if (!this.playing) return;
      const t = this.time();
      if (this.loop.on && this.loop.b > this.loop.a + 0.05 && t >= this.loop.b) this.play(this.loop.a);
      else if (t >= this.duration) { this.pause(); this.pos = this.duration; this.emit("ended"); }
    }

    // ---- metronome and guide tones (scheduled a little ahead) ----
    startScheduler() {
      this.stopScheduler();
      const look = 0.15;
      const run = () => {
        if (!this.playing) return;
        const now = this.time(), until = now + look * this.rate;
        const from = Math.max(this.schedPos, now);
        const at = (t) => this.t0 + (t - this.pos) / this.rate;
        if (this.metronome) for (const b of this.beats) if (b.time >= from && b.time < until) this.click(at(b.time), b.measure >= 0);
        for (const g of this.guides) if (g.on) for (const n of g.notes) if (n.t >= from && n.t < until) this.pluck(at(n.t), n.midi, Math.max(0.12, n.d) / this.rate, g.bass);
        this.schedPos = until;
      };
      run();
      this.timer = setInterval(run, 40);
    }
    stopScheduler() { clearInterval(this.timer); this.timer = null; }
    click(when, strong) {
      const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = strong ? 1760 : 1175; o.type = "square";
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(strong ? 0.35 : 0.22, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      o.connect(g).connect(this.fx); o.start(when); o.stop(when + 0.06);
    }
    pluck(when, midi, dur, bass) {
      const ctx = this.ctx, hz = 440 * Math.pow(2, (midi - 69) / 12);
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = "sawtooth"; o2.type = "triangle"; o.frequency.value = hz; o2.frequency.value = hz * 2;
      f.type = "lowpass"; f.frequency.setValueAtTime(bass ? 1200 : 3800, when); f.frequency.exponentialRampToValueAtTime(bass ? 300 : 900, when + Math.min(1.5, dur + 0.2));
      const peak = bass ? 0.22 : 0.13, end = when + Math.min(4, dur + 0.25);
      g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(peak, when + 0.004);
      g.gain.exponentialRampToValueAtTime(peak * 0.35, when + Math.min(dur, 0.4) + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, end);
      o.connect(f); o2.connect(f); f.connect(g).connect(this.fx);
      o.start(when); o2.start(when); o.stop(end + 0.02); o2.stop(end + 0.02);
    }
    /** Guide notes of an arrangement document: [{t, d, midi}] */
    static guideNotes(doc, bass) {
      const out = [], lv = doc.levels[0];
      const midi = (s, f) => STANDARD[s] + (doc.tuning[s] || 0) + f + (f === 0 && doc.capo ? doc.capo : 0) - (bass ? 12 : 0);
      for (const n of lv.notes) if (!n.mute) out.push({ t: n.time, d: n.sustain, midi: midi(n.string, n.fret) });
      for (const c of lv.chords) {
        const tp = doc.chordTemplates[c.chordId];
        if (!tp) continue;
        const sus = Math.max(0, ...(c.chordNotes || []).map((x) => x.sustain || 0));
        tp.frets.forEach((f, s) => { if (f >= 0) out.push({ t: c.time + s * 0.008, d: sus, midi: midi(s, f) }); });
      }
      return out.sort((a, b) => a.t - b.t);
    }
  }
  RSC.AudioEngine = AudioEngine;
})(typeof window !== "undefined" ? window : globalThis);
