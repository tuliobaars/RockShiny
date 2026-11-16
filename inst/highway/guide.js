/* ---------------------------------------------------------------------------
 * guide.js -- "guide tones": the chart played by a small Web Audio synth.
 *
 * MIDI songs have no recording, so this is their sound; for any chart it is a
 * learning aid (hear the part you are about to play). Notes are scheduled
 * ~0.3 s ahead on the AudioOut context (clock.js), at the context time that
 * is *audible* when the highway shows them at the strike line:
 *
 *   chart time tn --(display clock, rate)--> performance.now() P
 *                 --(AudioContext.getOutputTimestamp)--> context time T
 *
 * so output latency is accounted for. Seeks, loops, pauses and rate changes
 * silence the scheduled voices and re-plan from the new position.
 * Timbres: piano (decaying additive partials), harmonica (filtered sawtooth
 * reed with a breathy attack), guitar/bass (plucked triangle).
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const NS = (root.RSHighway = root.RSHighway || {});
  const AHEAD = 0.3;            // s of chart scheduled in advance
  const MAX_VOICES = 40;
  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

  class GuideSynth {
    constructor(audioOut) {
      this.out = audioOut;
      this.enabled = false; this.volume = 0.6;
      this.chart = null; this.voices = []; this.next = 0; this.lastTv = null; this.lastRate = 1;
      this.scheduled = 0;                         // notes scheduled (tests / telemetry)
    }
    setChart(chart) { this.chart = chart; this.reset(); }
    setEnabled(on) { this.enabled = !!on; if (!this.enabled) this.reset(); }
    setVolume(v) { this.volume = Math.max(0, Math.min(1, +v)); if (this.master) this.master.gain.value = this.volume * 0.5; }

    _graph() {
      const ctx = this.out && this.out.ctx;
      if (!ctx || ctx.state !== "running") return null;
      if (this.ctx !== ctx) {
        this.ctx = ctx;
        this.master = ctx.createGain(); this.master.gain.value = this.volume * 0.5;
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 4;
        this.master.connect(comp).connect(ctx.destination);
        const harm = [0, 1, 0.42, 0.22, 0.12, 0.07, 0.04, 0.025, 0.015];
        this.pianoWave = ctx.createPeriodicWave(new Float32Array(harm.length), Float32Array.from(harm));
      }
      return ctx;
    }

    /** performance.now() ms -> context time audible then. */
    _ctxTime(perfMs) {
      const ctx = this.ctx, ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
      return ctx.currentTime + (perfMs - performance.now()) / 1000 - (ctx.outputLatency || ctx.baseLatency || 0);
    }

    /** Silence everything scheduled and re-plan from the current position. */
    reset() {
      const now = this.ctx ? this.ctx.currentTime : 0;
      for (const v of this.voices) {
        try {
          v.g.gain.cancelScheduledValues(now);
          v.g.gain.setTargetAtTime(0, now, 0.015);
          v.o.stop(now + 0.08);
        } catch (e) { /* already stopped */ }
      }
      this.voices = []; this.lastTv = null;
    }

    /**
     * Per animation frame. `playing`: clock running; `tv`: chart time on screen
     * now (at performance.now() = nowMs); `rate`: playback rate.
     */
    update(playing, tv, rate, nowMs) {
      if (!this.enabled || !this.chart) return;
      if (!playing) { if (this.lastTv != null) this.reset(); return; }
      if (!this._graph()) return;
      const N = this.chart.notes;
      const jumped = this.lastTv == null || tv < this.lastTv - 0.05 || tv > this.lastTv + 0.5 || rate !== this.lastRate;
      if (jumped) { if (this.lastTv != null) this.reset(); this.next = lowerBound(N.t, tv - 0.01); }
      this.lastTv = tv; this.lastRate = rate;
      const horizon = tv + AHEAD * rate;
      const ctx = this.ctx;
      this.voices = this.voices.filter((v) => v.end > ctx.currentTime);
      while (this.next < N.n && N.t[this.next] <= horizon) {
        const i = this.next++;
        const when = this._ctxTime(nowMs + (N.t[i] - tv) * 1000 / rate);
        if (when < ctx.currentTime - 0.03) continue;                       // too late: skip rather than smear
        const midi = this._midi(i);
        if (midi == null) continue;
        this._voice(midi, Math.max(when, ctx.currentTime), Math.max(0.12, N.sus[i] / rate));
        this.scheduled++;
      }
    }

    /** Pitch of note i: the controller sets pitchOf (HitJudge tables: tuning, capo, harmonics; null = unpitched). */
    _midi(i) {
      if (this.pitchOf) return this.pitchOf(i);
      return this.chart.lanes ? this.chart.notes.midi[i] : null;
    }

    _voice(midi, when, dur) {
      const ctx = this.ctx, f = 440 * Math.pow(2, (midi - 69) / 12), kind = this.chart.instrument || "guitar";
      if (this.voices.length >= MAX_VOICES) {                             // steal the oldest
        const v = this.voices.shift();
        try { v.g.gain.setTargetAtTime(0, ctx.currentTime, 0.01); v.o.stop(ctx.currentTime + 0.05); } catch (e) { /* gone */ }
      }
      const o = ctx.createOscillator(), g = ctx.createGain();
      g.gain.setValueAtTime(0, when);
      let end;
      if (kind === "harmonica") {
        o.type = "sawtooth";
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass"; lp.frequency.value = Math.min(9000, f * 5); lp.Q.value = 2;
        o.connect(lp).connect(g);
        g.gain.linearRampToValueAtTime(0.16, when + 0.04);                 // breathy onset
        g.gain.setValueAtTime(0.16, when + dur);
        g.gain.linearRampToValueAtTime(0, when + dur + 0.07);
        end = when + dur + 0.1;
      } else {
        if (kind === "piano") o.setPeriodicWave(this.pianoWave); else o.type = "triangle";
        o.connect(g);
        const peak = kind === "piano" ? 0.3 : 0.28, tau = (kind === "piano" ? 0.9 : 0.5) * Math.pow(440 / f, 0.35);
        g.gain.linearRampToValueAtTime(peak, when + 0.004);
        g.gain.setTargetAtTime(0, when + 0.004, tau);                      // natural decay
        const rel = when + Math.max(dur, 0.15);
        g.gain.setTargetAtTime(0, rel, 0.06);                              // key / string released
        end = rel + 0.4;
      }
      o.frequency.value = f;
      g.connect(this.master);
      o.start(when); o.stop(end);
      this.voices.push({ o, g, end });
    }
  }

  NS.GuideSynth = GuideSynth;
})(window);
