/* ---------------------------------------------------------------------------
 * karaoke-voice.js -- the singer's voice in the song: turned down / muted while
 * you sing, in real time (a player plugin for karaoke.js; Shiny and HTML page).
 *
 * There is no separate vocal track in a Rocksmith archive: the song is one
 * stereo mix. Lead vocals are mixed in the centre (the same in both channels),
 * most instruments are not, so the voice is estimated per time-frequency bin:
 *
 *   STFT of L and R (2048 points at 44.1/48 kHz, hop 512, sqrt-Hann windows;
 *   both channels in one complex FFT)
 *   centre weight  c = (|L + R|^2 / (2 (|L|^2 + |R|^2)))^2      (1 = identical in L and R)
 *   vocal band     150 Hz - 7 kHz (ramps below), so bass and kick stay
 *   voice          V = c * band * (L + R) / 2
 *   output         L - a V,  R - a V,   a = (1 - voice volume) * gate
 *
 * The gate opens only around the sung lines (from the lyric timing: 0.35 s
 * before a line, 0.5 s after it): centre-panned instruments in the vocal band
 * are touched only while somebody sings. Everything else passes unchanged
 * (with a = 0 the output is the input, delayed by 2048 samples: 43-46 ms,
 * which the player adds to its latency compensation).
 *
 * Chosen on the 39 library songs with lyrics and the 4 whose charts carry the
 * sung pitches (numpy prototype, see docs): the voice's pitch stays the strongest
 * pitch class left in the song in 6 % of the charted notes (22 % before), and its
 * share of the energy at the sung pitch class drops from 50 % to 23 %.
 *
 *   RSKaraoke.voiceProcessorUrl()       Blob URL of the AudioWorklet "rs-voice"
 *   player.voice.set({volume, mute})    0..1; mute = volume 0
 * ------------------------------------------------------------------------- */
(function (root) {
  "use strict";
  const K = (root.RSKaraoke = root.RSKaraoke || {});

  // ---- the AudioWorklet (runs on the audio thread; self-contained) -----------------------
  function voiceProcessor() {
    /* global sampleRate, registerProcessor, AudioWorkletProcessor */
    class FFT {                                         // in-place complex radix-2 FFT
      constructor(n) {
        this.n = n; const bits = Math.log2(n);
        this.rev = new Uint32Array(n);
        for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
        this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
        for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = Math.sin(2 * Math.PI * i / n); }
      }
      run(re, im, inverse) {
        const n = this.n, rev = this.rev, s = inverse ? 1 : -1;
        for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
        for (let size = 2; size <= n; size <<= 1) {
          const half = size >> 1, step = n / size;
          for (let i = 0; i < n; i += size) {
            for (let j = 0, k = 0; j < half; j++, k += step) {
              const a = i + j, b = a + half, wr = this.cos[k], wi = s * this.sin[k];
              const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
              re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
            }
          }
        }
      }
    }
    class RSVoice extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [{ name: "amount", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
                { name: "gate", defaultValue: 1, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
      }
      constructor() {
        super();
        const N = sampleRate > 32000 ? 2048 : 1024, H = N / 4;
        this.N = N; this.H = H; this.fft = new FFT(N);
        this.win = new Float64Array(N);
        for (let i = 0; i < N; i++) this.win[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));   // periodic sqrt-Hann
        this.band = new Float64Array(N / 2 + 1);
        for (let k = 0; k <= N / 2; k++) {
          const f = k * sampleRate / N;
          this.band[k] = f < 150 ? 0 : f < 225 ? (f - 150) / 75 : f <= 7000 ? 1 : f < 9000 ? (9000 - f) / 2000 : 0;
        }
        this.inL = new Float64Array(N); this.inR = new Float64Array(N); this.pos = 0; this.fill = 0;
        this.olaL = new Float64Array(N); this.olaR = new Float64Array(N);
        this.outL = new Float64Array(H); this.outR = new Float64Array(H); this.outPos = H;    // starts silent: latency N
        this.re = new Float64Array(N); this.im = new Float64Array(N);
        this.a = 0;                                    // smoothed removal amount
        this.frames = 0;
        this.port.onmessage = (e) => { if (e.data && e.data.ping) this.port.postMessage({ pong: e.data.ping, frames: this.frames, N, sr: sampleRate }); };
      }
      _frame(target) {
        const N = this.N, re = this.re, im = this.im, w = this.win;
        for (let i = 0, j = this.pos; i < N; i++, j = (j + 1) % N) { re[i] = this.inL[j] * w[i]; im[i] = this.inR[j] * w[i]; }
        this.a += (target - this.a) * 0.25;            // ~45 ms to settle (hops of ~11 ms)
        const a = this.a < 1e-4 ? 0 : this.a;
        if (a > 0) {
          this.fft.run(re, im, false);
          for (let k = 0; k <= N / 2; k++) {
            const q = (N - k) % N;
            // L_k = (Z_k + conj Z_{N-k}) / 2,  R_k = (Z_k - conj Z_{N-k}) / 2i
            const lr = 0.5 * (re[k] + re[q]), li = 0.5 * (im[k] - im[q]);
            const rr = 0.5 * (im[k] + im[q]), ri = -0.5 * (re[k] - re[q]);
            let gl = lr, gi = li, hr = rr, hi = ri;
            const bw = this.band[k];
            if (bw > 0) {
              const sr = lr + rr, si = li + ri, pl = lr * lr + li * li, pr = rr * rr + ri * ri;
              const c = (sr * sr + si * si) / (2 * (pl + pr) + 1e-20);
              const m = a * bw * c * c * 0.5;          // V = c^2 band (L + R) / 2, times the amount
              gl = lr - m * sr; gi = li - m * si; hr = rr - m * sr; hi = ri - m * si;
            }
            // back into one complex spectrum: Y = L' + i R'  (conjugate-symmetric parts at N - k)
            re[k] = gl - hi; im[k] = gi + hr;
            if (q !== k) { re[q] = gl + hi; im[q] = -gi + hr; }
          }
          this.fft.run(re, im, true);
          for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
        }
        // overlap-add (sqrt-Hann twice = Hann; 4 hops sum to 2)
        for (let i = 0; i < N; i++) { this.olaL[i] += re[i] * w[i] * 0.5; this.olaR[i] += im[i] * w[i] * 0.5; }
        const H = this.H;
        for (let i = 0; i < H; i++) { this.outL[i] = this.olaL[i]; this.outR[i] = this.olaR[i]; }
        this.olaL.copyWithin(0, H); this.olaR.copyWithin(0, H);
        this.olaL.fill(0, N - H); this.olaR.fill(0, N - H);
        this.outPos = 0;
        this.frames++;
      }
      process(inputs, outputs, params) {
        const inp = inputs[0], out = outputs[0];
        if (!out || !out.length) return true;
        const n = out[0].length;
        const xl = inp && inp[0] ? inp[0] : null, xr = inp && inp[1] ? inp[1] : xl;
        const target = Math.max(0, Math.min(1, params.amount[0] * params.gate[0]));
        const yl = out[0], yr = out[1] || out[0];
        for (let i = 0; i < n; i++) {
          this.inL[this.pos] = xl ? xl[i] : 0; this.inR[this.pos] = xr ? xr[i] : 0;
          this.pos = (this.pos + 1) % this.N;
          if (this.outPos >= this.H) { yl[i] = 0; yr[i] = 0; } else { yl[i] = this.outL[this.outPos]; yr[i] = this.outR[this.outPos]; this.outPos++; }
          if (++this.fill === this.H) { this.fill = 0; this._frame(target); }
        }
        return true;
      }
    }
    registerProcessor("rs-voice", RSVoice);
  }
  /** Worklet code -> module URL: a Blob URL, or (pages opened from disk, where Chromium will not
   *  load a worklet from a blob: URL) a data: URL. */
  const urls = new Map();
  K.workletUrl = (fn, kind) => {
    const k = fn.name + ":" + kind;
    if (!urls.has(k)) {
      const code = "(" + fn.toString() + ")();";
      urls.set(k, kind === "data" ? "data:text/javascript;charset=utf-8," + encodeURIComponent(code)
                                  : URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
    }
    return urls.get(k);
  };
  K.voiceProcessorUrl = () => K.workletUrl(voiceProcessor, "blob");
  K.voiceProcessorSource = voiceProcessor;

  const loaded = new WeakMap();                       // AudioContext -> Map(worklet function -> Promise)
  K.loadWorklet = function (ctx, fn) {
    if (typeof fn === "string") fn = fn === K.voiceProcessorUrl() ? voiceProcessor : fn;   // (a URL: as given)
    let m = loaded.get(ctx);
    if (!m) { m = new Map(); loaded.set(ctx, m); }
    if (!m.has(fn)) {
      const p = typeof fn === "string" ? ctx.audioWorklet.addModule(fn)
        : ctx.audioWorklet.addModule(K.workletUrl(fn, "blob")).catch(() => ctx.audioWorklet.addModule(K.workletUrl(fn, "data")));
      m.set(fn, p);
    }
    return m.get(fn);
  };

  // ---- the plugin: routing, gate, controls ---------------------------------------------
  const MARGIN_BEFORE = 0.35, MARGIN_AFTER = 0.5;
  const HINT = "Estimated from the stereo mix: the centre of the mix is turned down while lines are sung.";
  const HINT_DISK = "Not available in a page opened from disk with its audio in a separate file: open it through a web server (e.g. the exporter's --serve), or export it with the audio embedded.";
  const HINT_NONE = "Not available in this browser (it needs Web Audio worklets).";
  class VoiceControl {
    constructor(player) {
      this.p = player;
      let saved = {};
      try { saved = JSON.parse(root.localStorage.getItem("rs-karaoke-voice") || "{}") || {}; } catch (e) { saved = {}; }
      this.volume = saved.volume != null ? +saved.volume : 1;
      this.muted = !!saved.muted;
      this.wanted = this.amount() > 0;                // insert the processing only once it is wanted
      this._gate = -1;
      this._build();
      setTimeout(() => { if (player.hooks.onVoice) player.hooks.onVoice({ volume: this.volume, mute: this.muted, available: this.available(), nonce: Date.now() }); }, 0);
    }
    amount() { return this.muted ? 1 : 1 - Math.max(0, Math.min(1, this.volume)); }
    /** The latency the processing adds (s): the player compensates it like output latency. */
    latency(audio) { return audio && audio._voice ? audio._voiceLatency : 0; }

    /** {volume 0..1, mute}; from = "host" when the host (R) asked: it is not told back (a slider
     *  being dragged there would otherwise be reset by its own echo). */
    set(o, from) {
      if (o.volume != null && isFinite(+o.volume)) this.volume = Math.max(0, Math.min(1, +o.volume));
      if (o.mute != null) this.muted = !!o.mute;
      if (this.amount() > 0) this.wanted = true;
      this._apply();
      this._paint();
      clearTimeout(this._saveT);                      // a dragged slider: store / report once it rests
      this._saveT = setTimeout(() => {
        try { root.localStorage.setItem("rs-karaoke-voice", JSON.stringify({ volume: this.volume, muted: this.muted })); } catch (e) { /* private */ }
        if (from !== "host" && this.p.hooks.onVoice) this.p.hooks.onVoice({ volume: this.volume, mute: this.muted, available: this.available(), nonce: Date.now() });
      }, 120);
    }
    available() {
      const out = this.p.deck.out, a = this.p.deck.audio;
      return !out.failed && !!(root.AudioWorkletNode) && !(a && a._direct);
    }

    /** Put the voice processor between the element and its gain (once per element). */
    async _insert(audio) {
      const out = this.p.deck.out;
      if (!audio || audio._voice || audio._voicePending || !audio._src || !out.ready) return;
      audio._voicePending = true;
      try {
        await K.loadWorklet(out.ctx, voiceProcessor);
        if (audio._voice || !audio._src) return;
        const node = new AudioWorkletNode(out.ctx, "rs-voice", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
          channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
        audio._src.disconnect();
        audio._src.connect(node).connect(audio._gain);
        audio._voice = node;
        audio._voiceLatency = (out.ctx.sampleRate > 32000 ? 2048 : 1024) / out.ctx.sampleRate;
        this._gate = -1;
        this._apply();
      } catch (e) {
        this.error = e;
      } finally { audio._voicePending = false; }
    }
    _apply() {
      const a = this.p.deck.audio;
      if (a && a._voice) a._voice.parameters.get("amount").setValueAtTime(this.amount(), a._voice.context.currentTime);
    }
    /** Every frame: insert when wanted (at a quiet moment), open the gate around sung lines. */
    frame_voice(songTime) {
      const deck = this.p.deck, a = deck.audio;
      const av = this.available();
      if (av !== this._av) { this._av = av; this._paint(); }
      if (this.wanted && a && a._src && !a._voice && (!this.p.clock.playing || this.amount() > 0)) this._insert(a);
      if (!a || !a._voice) return;
      const S = this.p.song;
      let g = 1;
      if (S && S.lines.length && !(S.lyrics && S.lyrics.plain)) {
        g = 0;
        for (const L of S.lines) {
          if (L.start - MARGIN_BEFORE <= songTime && songTime <= L.end + MARGIN_AFTER) { g = 1; break; }
          if (L.start - MARGIN_BEFORE > songTime) break;
        }
      }
      if (g !== this._gate) { this._gate = g; a._voice.parameters.get("gate").setValueAtTime(g, a._voice.context.currentTime); }
    }

    // controls: a button in the transport; its popover has the slider and mute
    _build() {
      const p = this.p, bar = p.transport;
      const b = (this.btn = document.createElement("button"));
      b.type = "button"; b.className = "rs-k-btn rs-k-btn-voice";
      b.title = "The singer's voice in the song: volume, mute"; b.setAttribute("aria-label", b.title);
      b.addEventListener("click", (e) => { e.stopPropagation(); this.pop.classList.toggle("is-open"); b.blur(); });
      bar.insertBefore(b, p.time);
      const pop = (this.pop = document.createElement("div"));
      pop.className = "rs-k-pop rs-k-voicepop";
      pop.innerHTML = '<div class="rs-k-pop-title">Original voice</div>' +
        '<div class="rs-k-pop-row"><button type="button" class="rs-k-btn rs-k-voice-mute"></button>' +
        '<input type="range" min="0" max="100" step="5" class="rs-k-range" aria-label="Original voice volume"><b class="rs-k-pop-val"></b></div>' +
        '<div class="rs-k-pop-hint"></div>';
      p.el.appendChild(pop);
      this.hint = pop.querySelector(".rs-k-pop-hint");
      this.range = pop.querySelector("input"); this.val = pop.querySelector(".rs-k-pop-val"); this.muteBtn = pop.querySelector(".rs-k-voice-mute");
      this.range.addEventListener("input", () => this.set({ volume: +this.range.value / 100, mute: false }));
      this.muteBtn.addEventListener("click", () => this.set({ mute: !this.muted }));
      pop.addEventListener("keydown", (e) => e.stopPropagation());
      this._outside = (e) => { if (!pop.contains(e.target) && e.target !== b) pop.classList.remove("is-open"); };
      document.addEventListener("pointerdown", this._outside, true);
      this._paint();
    }
    _paint() {
      const v = this.muted ? 0 : this.volume, icon = this.muted || v === 0 ? ICON_OFF : v < 1 ? ICON_LOW : ICON_ON;
      if (this._icon !== icon) { this._icon = icon; this.btn.innerHTML = icon; }   // (only on change: see the pause-button fix)
      this.btn.classList.toggle("is-on", this.muted || v < 1);
      this.range.value = String(Math.round(100 * this.volume));
      this.val.textContent = this.muted ? "muted" : Math.round(100 * this.volume) + "%";
      if (this._muteIcon !== this.muted) { this._muteIcon = this.muted; this.muteBtn.innerHTML = this.muted ? ICON_OFF : ICON_ON; }
      this.muteBtn.title = this.muted ? "Unmute the original voice" : "Mute the original voice";
      const av = this.available();
      this.range.disabled = !av;
      this.btn.classList.toggle("is-unavailable", !av);
      this.hint.textContent = av ? HINT : (this.p.deck.audio && this.p.deck.audio._direct ? HINT_DISK : HINT_NONE);
    }
    destroy() { clearTimeout(this._saveT); document.removeEventListener("pointerdown", this._outside, true); this.pop.remove(); }
  }
  const ICON_ON = '<svg viewBox="0 0 24 24"><path d="M9 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c4.4 0 8 1.8 8 4v2H1v-2c0-2.2 3.6-4 8-4zm8.5-9.6l1.4-1.4a9 9 0 0 1 0 12.7l-1.4-1.4a7 7 0 0 0 0-9.9zm-2.8 2.8l1.4-1.4a5 5 0 0 1 0 7.1l-1.4-1.4a3 3 0 0 0 0-4.3z"/></svg>';
  const ICON_LOW = '<svg viewBox="0 0 24 24"><path d="M9 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c4.4 0 8 1.8 8 4v2H1v-2c0-2.2 3.6-4 8-4zm5.7-6.8l1.4-1.4a5 5 0 0 1 0 7.1l-1.4-1.4a3 3 0 0 0 0-4.3z"/></svg>';
  const ICON_OFF = '<svg viewBox="0 0 24 24"><path d="M9 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 10c4.4 0 8 1.8 8 4v2H1v-2c0-2.2 3.6-4 8-4zm7.6-7.4l2.1 2.1 2.1-2.1 1.4 1.4-2.1 2.1 2.1 2.1-1.4 1.4-2.1-2.1-2.1 2.1-1.4-1.4 2.1-2.1-2.1-2.1z"/></svg>';

  K.VoiceControl = VoiceControl;
  (K.plugins = K.plugins || []).push({ name: "voice", create: (player) => new VoiceControl(player) });
})(window);
