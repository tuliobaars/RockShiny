"""
Singing: the original voice turned down (karaoke-voice.js) and microphone
scoring (karaoke-sing.js), in a real browser -- correctness, accuracy,
benchmarks and stress tests. Needs Python 3 + playwright (chromium) +
`pip install wem2ogg` (the songs' audio).

  python3 tests/frontend/check_sing.py            # all sections
  python3 tests/frontend/check_sing.py live page  # some: voice pitch offline live stress controls page

The singer is synthetic (tests/frontend/sing_synth.js): a formant voice with
vibrato, drift and breath, singing a song's charted melody (or a wrong one).

1. voice processor: exact pass-through when off; a centre tone removed, side
   tones and the bass kept; speed (x real time)
2. the voice in real songs: vocal-band energy turned down while lines are sung,
   untouched between them
3. pitch tracker: synthetic voices (bass .. soprano) with noise and with the song
   bleeding into the microphone; speed
4. scoring, offline over whole song sections: right melody vs transposed,
   random, silent, late, half the lines, with the song bleeding in -- melody
   mode (charted pitches) and tonality mode (measured from the audio)
5. live: the song playing, the singer fed in as the microphone, the voice
   turned down -- scores, frame cost, message rate, at 1.0x and 0.75x
6. stress: an hour of pitch frames through one scorer; the microphone toggled
   40 times (some stopped mid-start); 40 seeks while singing; 400 voice-slider
   changes; 4 songs switched under a singing microphone; a full lane; leaks
7. controls: the voice popover and the microphone button by clicks, and what the
   host (Shiny) hears
8. the standalone HTML page (opened from disk): voice and scoring work there too
"""
import asyncio, functools, http.server, json, os, statistics, subprocess, sys, tempfile, threading
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "tests", "frontend", "fixtures")
sys.path.insert(0, os.path.join(ROOT, "tests", "reference"))
sys.path.insert(0, os.path.join(ROOT, "tools"))
PORT = 8776
ONLY = set(sys.argv[1:])          # e.g. `check_sing.py live page`: only those sections
def want(s): return not ONLY or s in ONLY
SONGS = {"getlucky": "DaftPunk_GetLucky_m.psarc", "steady": "The-Raconteurs_Steady-As-She-Goes_v1_1_DD_m.psarc",
         "sultans": "Dire-Straits_Sultans-of-Swing_v443_m.psarc"}
failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg, flush=True)
    if not cond: failures.append(msg)

def fixtures():
    import karaoke_ref as KR, rockshiny_ref as R
    os.makedirs(FIX, exist_ok=True)
    try:
        import wem2ogg
    except ImportError:
        sys.exit("pip install wem2ogg (the songs' audio)")
    for tag, f in SONGS.items():
        p = os.path.join(ROOT, "songs", f)
        if not os.path.exists(p): sys.exit(f"{f} is not in songs/")
        j = os.path.join(FIX, f"karaoke_{tag}.json")
        if not os.path.exists(j):
            with open(j, "w") as h: json.dump(KR.karaoke_payload(p, online=False), h, separators=(",", ":"))
        o = os.path.join(FIX, f"wem_{tag}.ogg")
        if not os.path.exists(o):
            a = R.Psarc(p)
            with open(o, "wb") as h: h.write(wem2ogg.wem_to_ogg(a.read(R.find_song_wem(a))))

VOICE_UNIT = """async () => {
  const sr = 48000, n = sr * 4, K = RSKaraoke, T = SingTest;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr), b = 0.3 * Math.sin(2 * Math.PI * 80 * i / sr);
    L[i] = c + b + 0.2 * Math.sin(2 * Math.PI * 660 * i / sr); R[i] = c + b + 0.2 * Math.sin(2 * Math.PI * 990 * i / sr + 1);
  }
  const pass = await T.offline("rs-voice", K.voiceProcessorUrl(), 2, sr, [L, R], {amount: 0, gate: 1});
  const yl = pass.out.getChannelData(0), yr = pass.out.getChannelData(1), N = 2048;
  let err = 0; for (let i = N + 100; i < n; i++) err = Math.max(err, Math.abs(yl[i] - L[i - N]), Math.abs(yr[i] - R[i - N]));
  const rem = await T.offline("rs-voice", K.voiceProcessorUrl(), 2, sr, [L, R], {amount: 1, gate: 1});
  const comp = (y, f, ph) => { let s = 0, c = 0; for (let i = sr; i < 3.5 * sr; i++) { const t = (i - N) / sr;
    s += y[i] * Math.sin(2 * Math.PI * f * t + (ph || 0)); c += y[i] * Math.cos(2 * Math.PI * f * t + (ph || 0)); } return Math.sqrt(s * s + c * c) / (2.5 * sr / 2); };
  const a = rem.out.getChannelData(0), bR = rem.out.getChannelData(1), db = (x, ref) => 20 * Math.log10(x / ref);
  const gated = await T.offline("rs-voice", K.voiceProcessorUrl(), 2, sr, [L, R], {amount: 1, gate: 0});
  let gerr = 0; const gl = gated.out.getChannelData(0); for (let i = N + 100; i < n; i++) gerr = Math.max(gerr, Math.abs(gl[i] - L[i - N]));
  // speed: a minute of stereo noise
  const m = sr * 60, r = T.rng(1), X = new Float32Array(m), Y = new Float32Array(m);
  for (let i = 0; i < m; i++) { X[i] = r() - 0.5; Y[i] = 0.5 * X[i] + 0.5 * (r() - 0.5); }
  const sp = await T.offline("rs-voice", K.voiceProcessorUrl(), 2, sr, [X, Y], {amount: 1, gate: 1});
  return { passErr: err, gateErr: gerr, centre: db(comp(a, 440), 0.3), bass: db(comp(a, 80), 0.3), left: db(comp(a, 660), 0.2),
           right: db(comp(bR, 990, 1), 0.2), speed: 60000 / sp.ms };
}"""

# vocal-band (200-4000 Hz) energy before / after the processor, in sung lines vs between them
VOICE_SONG = """async ([song, audio]) => {
  const K = RSKaraoke, T = SingTest, sr = 44100;
  const S = K.prepare(await (await fetch('/tests/frontend/fixtures/' + song + '.json')).json());
  const buf = await T.decode('/tests/frontend/fixtures/' + audio, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
  // the gate as the player drives it (lines + margins), as an automation curve on "gate"
  const ctx = new OfflineAudioContext(2, n + 4096, sr);
  await ctx.audioWorklet.addModule(K.voiceProcessorUrl());
  const b2 = ctx.createBuffer(2, n, sr); b2.copyToChannel(L, 0); b2.copyToChannel(R, 1);
  const src = ctx.createBufferSource(); src.buffer = b2;
  const node = new AudioWorkletNode(ctx, "rs-voice", {outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit"});
  node.parameters.get("amount").value = 1;
  const g = node.parameters.get("gate"); g.setValueAtTime(0, 0);
  const spans = [];                                                   // lines + margins, merged
  for (const l of S.lines) { const a = Math.max(0, l.start - 0.35), b = l.end + 0.5;
    if (spans.length && a <= spans[spans.length - 1][1]) spans[spans.length - 1][1] = Math.max(spans[spans.length - 1][1], b); else spans.push([a, b]); }
  for (const [a, b] of spans) { g.setValueAtTime(1, a); g.setValueAtTime(0, b); }
  src.connect(node).connect(ctx.destination); src.start();
  const t0 = performance.now(); const out = await ctx.startRendering(); const ms = performance.now() - t0;
  const yl = out.getChannelData(0), yr = out.getChannelData(1), D = 2048, F = 4096, fft = K._fft(F);
  const win = new Float64Array(F); for (let i = 0; i < F; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / F);
  const k0 = Math.round(200 * F / sr), k1 = Math.round(4000 * F / sr);
  const band = (x, y, s) => { const re = new Float64Array(F), im = new Float64Array(F);
    for (let i = 0; i < F; i++) { re[i] = x[s + i] * win[i]; im[i] = y[s + i] * win[i]; }
    fft(re, im); let e = 0; for (let k = k0; k <= k1; k++) e += re[k] * re[k] + im[k] * im[k] + re[F - k] * re[F - k] + im[F - k] * im[F - k]; return e; };
  let sIn = 0, sOut = 0, oIn = 0, oOut = 0;
  const inLine = (t) => S.lines.some(l => t >= l.start && t <= l.end);
  const nearLine = (t) => S.lines.some(l => t >= l.start - 1.5 && t <= l.end + 1.5);
  for (let s = 0; s + F + D < n; s += 4 * F) {
    const t = (s + F / 2) / sr, a = band(L, R, s), b = band(yl, yr, s + D);
    if (inLine(t)) { sIn += a; sOut += b; } else if (!nearLine(t)) { oIn += a; oOut += b; }
  }
  // charted songs: energy at the sung pitch class (100-1000 Hz, +-1/3 semitone) vs the other pitch classes, per note
  let vIn = 0, vOut = 0, xIn = 0, xOut = 0, notes = 0;
  const pc = (x, y, s0) => { const re = new Float64Array(F), im = new Float64Array(F);
    for (let i = 0; i < F; i++) { re[i] = x[s0 + i] * win[i]; im[i] = y[s0 + i] * win[i]; }
    fft(re, im); const e = new Float64Array(36);
    for (let k = Math.ceil(100 * F / sr); k <= 1000 * F / sr; k++) {
      const m = 69 + 12 * Math.log2(k * sr / F / 440), c = ((Math.round(m * 3) % 36) + 36) % 36;
      e[c] += re[k] * re[k] + im[k] * im[k] + re[F - k] * re[F - k] + im[F - k] * im[F - k]; }
    return e; };
  for (const l of S.lines) for (const w of l.words) {
    if (w.n == null || w.d < 0.15) continue;
    const s0 = Math.round((w.t + 0.05) * sr); if (s0 + F + D >= n) continue;
    const a = pc(L, R, s0), b = pc(yl, yr, s0 + D), c = ((w.n % 12) * 3 + 36) % 36;
    for (let q = 0; q < 36; q++) { const on = [c, (c + 1) % 36, (c + 35) % 36].includes(q); if (on) { vIn += a[q]; vOut += b[q]; } else { xIn += a[q]; xOut += b[q]; } }
    notes++;
  }
  return { sung: 10 * Math.log10(sIn / sOut), between: 10 * Math.log10(oIn / Math.max(1e-12, oOut)), speed: buf.duration * 1000 / ms,
           notes, voicePc: notes ? 10 * Math.log10(vIn / vOut) : null, otherPc: notes ? 10 * Math.log10(xIn / xOut) : null };
}"""

PITCH = """async ([lo, hi, noise, bleedDb, seed]) => {
  const sr = 48000, K = RSKaraoke, T = SingTest, r = T.rng(seed);
  const notes = []; let t = 0.3;
  while (t < 28) { const d = 0.3 + 0.5 * r(); notes.push({t, d, midi: lo + Math.floor(r() * (hi - lo + 1))}); t += d + 0.15 + 0.2 * r(); }
  let opts = {noise, vibrato: 30, seed};
  if (bleedDb != null) { const song = await T.decode('/tests/frontend/fixtures/wem_sultans.ogg', sr);
    opts = Object.assign(opts, {bleed: song.getChannelData(0), bleedAt: 60, bleedGain: Math.pow(10, bleedDb / 20)}); }
  const x = T.voice(notes, sr, 30, opts);
  const res = await T.offline("rs-sing", K.singProcessorUrl(), 1, sr, [x], {}, 1);
  await new Promise(r => setTimeout(r, 300));
  let inN = 0, voiced = 0, good = 0, oct = 0, errs = [], outN = 0, fa = 0;
  const isV = (f) => f.f0 > 0 && f.conf >= K.SING.MIN_CONF && f.db >= K.SING.MIN_DB;
  for (const f of res.frames) {
    const no = notes.find(n => f.t >= n.t + 0.07 && f.t <= n.t + n.d - 0.07);
    if (no) {
      inN++;
      if (isV(f)) {
        voiced++;
        const c = 1200 * Math.log2(f.f0 / (440 * Math.pow(2, (no.midi - 69) / 12)));
        if (Math.abs(c) <= 100) { good++; errs.push(Math.abs(c)); }
        else if ([1200, 2400].some(o => Math.abs(Math.abs(c) - o) <= 100)) oct++;
      }
    } else if (!notes.some(n => f.t >= n.t - 0.1 && f.t <= n.t + n.d + 0.1)) { outN++; if (isV(f)) fa++; }
  }
  errs.sort((a, b) => a - b);
  return { recall: voiced / inN, within: good / Math.max(1, voiced), octave: oct / Math.max(1, voiced), med: errs[errs.length >> 1] || 0,
           falseAlarm: fa / Math.max(1, outN), speed: 30000 / res.ms };
}"""

SCORE = """async ([song, audio, until, scen]) => {
  const K = RSKaraoke, T = SingTest, sr = 48000;
  const S = K.prepare(await (await fetch('/tests/frontend/fixtures/' + song + '.json')).json());
  S.lines = S.lines.filter(L => L.end < until);
  if (!window.__prof || window.__prof.song !== song) {
    const buf = await T.decode('/tests/frontend/fixtures/' + audio, 8000);
    const t0 = performance.now(); const prof = await K.tonalityProfiles(buf, S.lines);
    window.__prof = { song, prof, ms: performance.now() - t0, secs: until };
  }
  const out = {};
  for (const sc of scen) {
    const o = Object.assign({seed: 5}, sc.o || {});
    if (sc.half) o.only = (k) => k % 2 === 0;
    let notes = sc.silent ? [] : T.notesOf(S, o);
    let opts = {noise: -30, seed: 9};
    if (sc.bleed != null) {
      if (!window.__bleed || window.__bleed.song !== song) window.__bleed = { song, buf: await T.decode('/tests/frontend/fixtures/' + audio, sr) };
      opts = Object.assign(opts, {bleed: window.__bleed.buf.getChannelData(0), bleedAt: 0, bleedGain: Math.pow(10, sc.bleed / 20)});
    }
    const x = T.voice(notes, sr, until + 1, opts);
    const res = await T.offline("rs-sing", K.singProcessorUrl(), 1, sr, [x], {}, 1);
    await new Promise(r => setTimeout(r, 200));
    for (const mode of ["melody", "tonality"]) {
      const scorer = new K.SingScorer(S, mode, mode === 'tonality' ? window.__prof.prof : null);
      for (const f of res.frames) scorer.frame(f.t, f.f0, f.conf, f.db);
      scorer.finishAll();
      const r = scorer.result();
      out[sc.name + '|' + mode] = [r.score, r.pitch, r.timing];
    }
  }
  return { out, profMs: window.__prof.ms };
}"""

LIVE = """async ([from, secs, late, transpose, rate]) => {
  const c = harness.ctl(), K = RSKaraoke, T = SingTest, wait = (ms) => new Promise(r => setTimeout(r, ms));
  await c.deck.out.ensure();
  c.applyOptions({playbackRate: rate});
  const ctx = c.deck.out.ctx, S = c.song;
  // the singer (the charted melody, or a wrong one), at the song's pace, as the page's microphone
  const notes = T.notesOf(S, {late, transpose}).filter(n => n.t > from - 1 && n.t < from + secs * rate + 2)
    .map(n => Object.assign({}, n, {t: (n.t - from + 1) / rate, d: n.d / rate}));
  const x = T.voice(notes, ctx.sampleRate, secs + 4, {noise: -30, seed: 4});
  const buf = ctx.createBuffer(1, x.length, ctx.sampleRate); buf.copyToChannel(x, 0);
  const dest = ctx.createMediaStreamDestination();
  navigator.mediaDevices.getUserMedia = async () => dest.stream;
  c.seek(from - 1);
  const ok = await c.sing.start({quiet: true});
  while (!c.sing.scorer) await wait(50);
  c.sing.scorer.seek(0); c.sing.scorer.seeked = false;
  // the player's own per-frame cost, and that of the singing plugin
  let plug = [], render = []; const pf = c.sing.frame.bind(c.sing), rf = c.render.bind(c);
  c.sing.frame = (t) => { const a = performance.now(); pf(t); plug.push(performance.now() - a); };
  c.render = (t) => { const a = performance.now(); rf(t); render.push(performance.now() - a); };
  await c.togglePlay();
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
  src.start(ctx.currentTime, Math.max(0, (c.lyricTime(performance.now()) - (from - 1)) / rate));
  const gaps = []; let last = performance.now(); const t0 = last, ct0 = ctx.currentTime;
  const heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  const vf0 = c.deck.audio._voice ? await new Promise(r => { c.deck.audio._voice.port.onmessage = e => r(e.data.frames); c.deck.audio._voice.port.postMessage({ping: 1}); }) : 0;
  while (performance.now() - t0 < secs * 1000) { await new Promise(r => requestAnimationFrame(r)); const n2 = performance.now(); gaps.push(n2 - last); last = n2; }
  const vf1 = c.deck.audio._voice ? await new Promise(r => { c.deck.audio._voice.port.onmessage = e => r(e.data.frames); c.deck.audio._voice.port.postMessage({ping: 2}); }) : 0;
  const audioPace = (ctx.currentTime - ct0) / ((performance.now() - t0) / 1000);   // 1 = the audio thread kept up
  const ctSpan = ctx.currentTime - ct0;
  c.pause(); src.stop();
  const sc = c.sing.scorer, sung = sc.lines.filter(l => l.done && l.frames > 0);
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
  return { ok, mode: sc.mode, lines: sung.length, pitch: sung.reduce((a, l) => a + l.pitchAvg, 0) / Math.max(1, sung.length),
           timing: sung.reduce((a, l) => a + l.timing, 0) / Math.max(1, sung.length), msgs: c.sing.frames / secs,
           plug95: q(plug, 0.95), plug50: q(plug, 0.5), render95: q(render, 0.95), fps: 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length),
           voiceFps: (vf1 - vf0) / ctSpan, expectVoiceFps: ctx.sampleRate / 512, audioPace,
           heapMB: performance.memory ? (performance.memory.usedJSHeapSize - heap0) / 1e6 : null, voice: !!c.deck.audio._voice,
           lat: c.deck.latency(performance.now()) };
}"""

STRESS_SCORER = """async () => {
  // an hour of pitch frames (100/s) through one scorer: the song over and over, with a seek back at each end
  const K = RSKaraoke, S = K.prepare(await (await fetch('/tests/frontend/fixtures/karaoke_steady.json')).json());
  const sc = new K.SingScorer(S, "melody"), dur = S.lines[S.lines.length - 1].end + 1, N = 360000;
  let seed = 7; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let maxTrail = 0, out = 0, prev = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const s = (i / 100) % dur;
    if (s < prev) sc.seek(0);
    prev = s;
    sc.frame(s, r() < 0.3 ? 0 : 110 + 300 * r(), 0.9, -30);
    if (sc.trail.length > maxTrail) maxTrail = sc.trail.length;
    if (!(sc.points > -1e-6 && sc.points < 10000.001)) out++;
  }
  const ms = performance.now() - t0;
  sc.finishAll();
  return { usPerFrame: 1000 * ms / N, maxTrail, outOfRange: out, score: sc.result().score, passes: Math.floor(N / 100 / dur) };
}"""

STRESS_LIVE = """async () => {
  const c = harness.ctl(), wait = (ms) => new Promise(r => setTimeout(r, ms));
  let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  await c.deck.out.ensure(); const ctx = c.deck.out.ctx;
  const tracks = [];
  navigator.mediaDevices.getUserMedia = async () => {           // a new "microphone" per call, ready after 0-40 ms
    const d = ctx.createMediaStreamDestination(), o = ctx.createOscillator(); o.frequency.value = 220; o.connect(d); o.start();
    await wait(40 * rnd()); tracks.push(...d.stream.getTracks()); return d.stream; };
  const live = () => tracks.filter(t => t.readyState === 'live').length;
  const heap = () => { if (window.gc) window.gc(); return performance.memory ? performance.memory.usedJSHeapSize / 1e6 : 0; };
  c.seek(30); await c.togglePlay();
  const h0 = heap(), out = {};
  // 1. the microphone on and off 40 times; every third time stopped before it has started (a double click)
  for (let i = 0; i < 40; i++) {
    const p = c.sing.start({quiet: true});
    if (i % 3 === 0) { c.sing.stop(); await p; }
    else { await p; await wait(20 + 60 * rnd()); c.sing.stop(); }
  }
  await wait(300);
  out.toggles = { opened: tracks.length, leftOpen: live(), on: c.sing.on };
  out.restart = await c.sing.start({quiet: true});
  const f0 = c.sing.frames; await wait(1500);
  out.restart = { ok: out.restart, framesPerS: (c.sing.frames - f0) / 1.5, open: live() };
  // 2. 40 seeks while singing
  let bad = 0;
  for (let i = 0; i < 40; i++) {
    c.seek(15 + 150 * rnd()); await wait(40 + 160 * rnd());
    const sc = c.sing.scorer; if (!sc || !(sc.points > -1e-6 && sc.points < 10000.001)) bad++;
  }
  out.seeks = { bad, playing: c.clock.playing };
  // 3. the voice slider, 400 changes in ~4 s, mute flipping now and then
  const nIn = window.__inputs.length;
  for (let i = 0; i < 400; i++) { c.voice.set({volume: rnd(), mute: rnd() < 0.1}); if (i % 10 === 9) await wait(100); }
  c.voice.set({volume: 0.35, mute: false}); await wait(400);
  const vin = window.__inputs.slice(nIn).filter(x => x.name === 'kk_voice');
  out.voice = { inputs: vin.length, last: vin.length ? vin[vin.length - 1].value.volume : null, stored: JSON.parse(localStorage.getItem('rs-karaoke-voice')),
                amount: c.deck.audio._voice ? c.deck.audio._voice.parameters.get('amount').value : null };
  // 4. songs switched under a singing microphone
  out.songs = [];
  for (let k = 0; k < 4; k++) {
    const name = k % 2 ? 'getlucky' : 'steady', key = await harness.loadSong('karaoke_' + name);
    harness.message('audio', {url: 'fixtures/wem_' + name + '.ogg', songKey: key});
    const t0 = performance.now();
    while (!(c.song.songKey === key && c.deck.kind === 'full') && performance.now() - t0 < 30000) await wait(50);
    c.seek(40); if (!c.clock.playing) await c.togglePlay();
    while (!c.sing.scorer && performance.now() - t0 < 30000) await wait(50);
    const g0 = c.sing.frames; await wait(1200);
    out.songs.push({ name, on: c.sing.on, mode: c.sing.scorer && c.sing.scorer.mode, framesPerS: (c.sing.frames - g0) / 1.2,
                     voice: !!(c.deck.audio && c.deck.audio._voice), open: live() });
  }
  // 5. the lane, drawn with a full trail (800 points on screen)
  const sc = c.sing.scorer, t = c.lyricTime(performance.now());
  c.pause();
  sc.trail = Array.from({length: 800}, (_, i) => ({ s: t - 2.4 + i * 0.003, m: 55 + 10 * rnd(), v: rnd() < 0.2 ? null : rnd() }));
  const costs = [];
  for (let i = 0; i < 600; i++) { const a = performance.now(); c.sing.frame(t + i * 0.0005); costs.push(performance.now() - a); await (i % 60 === 59 ? new Promise(r => requestAnimationFrame(r)) : null); }
  costs.sort((a, b) => a - b);
  out.lane = { p50: costs[300], p95: costs[570] };
  c.sing.stop(); await wait(200);
  out.heapMB = heap() - h0; out.leftOpen = live();
  return out;
}"""

CONTROLS = """async () => {
  // the controls a person uses, by clicks and keys; what the host (Shiny) hears
  const c = harness.ctl(), wait = (ms) => new Promise(r => setTimeout(r, ms)), out = {};
  await c.deck.out.ensure(); const ctx = c.deck.out.ctx;
  navigator.mediaDevices.getUserMedia = async () => ctx.createMediaStreamDestination().stream;
  const inputs = (name, n0) => window.__inputs.slice(n0).filter(x => x.name === name).map(x => x.value);
  const vb = c.el.querySelector('.rs-k-btn-voice'), pop = c.el.querySelector('.rs-k-voicepop');
  vb.click(); out.popOpen = pop.classList.contains('is-open');
  let n0 = window.__inputs.length;
  const range = pop.querySelector('input[type=range]');
  for (const v of [90, 70, 50, 40]) { range.value = String(v); range.dispatchEvent(new Event('input', {bubbles: true})); await wait(20); }
  await wait(300);
  out.drag = inputs('kk_voice', n0);
  n0 = window.__inputs.length;
  pop.querySelector('.rs-k-voice-mute').click(); await wait(300);
  out.mute = inputs('kk_voice', n0);
  n0 = window.__inputs.length;
  harness.message('voice', {volume: 0.8, mute: false}); await wait(300);
  out.host = { echoed: inputs('kk_voice', n0).length, volume: c.voice.volume, muted: c.voice.muted, label: pop.querySelector('.rs-k-pop-val').textContent };
  document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); out.popClosed = !pop.classList.contains('is-open');
  n0 = window.__inputs.length;
  const mb = c.el.querySelector('.rs-k-btn-mic');
  c.seek(40); await c.togglePlay();
  mb.click(); await wait(800);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const lr = c.sing.lane.getBoundingClientRect(), pr = c.el.getBoundingClientRect();
  out.micOn = { on: c.sing.on, inputs: inputs('kk_sing', n0), lane: getComputedStyle(c.sing.lane).display, hud: getComputedStyle(c.sing.hud).display,
                laneW: lr.width / pr.width, laneH: lr.height, pixels: c.sing.lane.width / Math.max(1, lr.width) };
  n0 = window.__inputs.length;
  harness.message('sing', {on: false}); await wait(300);
  out.micOff = { on: c.sing.on, inputs: inputs('kk_sing', n0), card: c.sing.card.classList.contains('is-open') };
  c.pause();
  return out;
}"""

async def main():
    fixtures()
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{PORT}/tests/frontend/karaoke_harness.html"
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info", "--js-flags=--expose-gc"])
        async def page(q=""):
            pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(base + q); await pg.add_script_tag(url="/tests/frontend/sing_synth.js")
            return pg, errs

        if want("voice"):
            print("voice processor (rs-voice)")
            pg, errs = await page()
            r = await pg.evaluate(VOICE_UNIT)
            check(r["passErr"] == 0 and r["gateErr"] == 0 and r["centre"] < -40 and abs(r["bass"]) < 0.1 and -1.5 < r["left"] < 0 and -1.5 < r["right"] < 0 and not errs,
                  f"off (or gate closed): output = input delayed by 2048 samples (max error {r['passErr']:g} / {r['gateErr']:g}); on: centre 440 Hz {r['centre']:.0f} dB, "
                  f"centre 80 Hz bass {r['bass']:+.2f} dB, left-only {r['left']:+.2f} dB, right-only {r['right']:+.2f} dB; {r['speed']:.0f}x real time")
            for tag in ("getlucky", "steady", "sultans"):
                r = await pg.evaluate(VOICE_SONG, [f"karaoke_{tag}", f"wem_{tag}.ogg"])
                charted = f"; at the {r['notes']} charted notes: the sung pitch class {r['voicePc']:.1f} dB lower, the other pitch classes {r['otherPc']:.1f} dB" if r["notes"] else ""
                check(r["sung"] > 3 and r["between"] < 0.3 and (not r["notes"] or r["voicePc"] > r["otherPc"] + 1) and not errs,
                      f"{tag}: vocal band (200-4000 Hz) {r['sung']:.1f} dB lower while lines are sung, {r['between']:.2f} dB between them{charted}; {r['speed']:.0f}x real time")
            await pg.close()

        if want("pitch"):
            print("pitch tracker (rs-sing) on synthetic voices")
            pg, errs = await page()
            rows = []
            for name, lo, hi in (("bass", 40, 55), ("tenor", 48, 67), ("alto", 55, 74), ("soprano", 62, 81)):
                for cond, noise, bleed in (("clean", -40, None), ("noise -10 dB", -10, None), ("song -20 dB", -90, -20), ("song -10 dB", -90, -10)):
                    r = await pg.evaluate(PITCH, [lo, hi, noise, bleed, 11])
                    rows.append((name, cond, r))
                    print(f"  info {name:8s} {cond:13s} voiced {r['recall']:4.0%}  right note {r['within']:5.1%}  octave off {r['octave']:4.1%}  "
                          f"median {r['med']:3.0f} c  false alarms {r['falseAlarm']:4.1%}  {r['speed']:.0f}x real time", flush=True)
            clean = [r for n, c, r in rows if c in ("clean", "noise -10 dB", "song -20 dB")]
            check(all(r["recall"] > 0.95 and r["within"] + r["octave"] > 0.97 and r["falseAlarm"] < 0.1 for r in clean) and not errs,
                  f"clean, noise at -10 dB, the song at -20 dB: voiced >= {min(r['recall'] for r in clean):.0%}, right note or octave >= "
                  f"{min(r['within'] + r['octave'] for r in clean):.1%} (the score is octave-free); song at -10 dB (no headphones): right note or octave "
                  f"{min(r['within'] + r['octave'] for n, c, r in rows if c == 'song -10 dB'):.0%}..{max(r['within'] + r['octave'] for n, c, r in rows if c == 'song -10 dB'):.0%}")
            await pg.close()

        if want("offline"):
            print("scoring, offline (whole song sections; the synthetic singer)")
            scen = [dict(name="right melody"), dict(name="right, an octave up", o=dict(octave=1)), dict(name="+2 semitones", o=dict(transpose=2)),
                    dict(name="-3 semitones", o=dict(transpose=-3)), dict(name="random notes", o=dict(random=True)), dict(name="silent", silent=True),
                    dict(name="300 ms late", o=dict(late=0.3)), dict(name="every other line", half=True),
                    dict(name="right + song at -10 dB", bleed=-10), dict(name="no singer, song at -4 dB", silent=True, bleed=-4)]
            results = {}
            for tag, until in (("getlucky", 120), ("steady", 160)):
                pg, errs = await page()
                r = await pg.evaluate(SCORE, [f"karaoke_{tag}", f"wem_{tag}.ogg", until, scen])
                results[tag] = r["out"]
                for k, v in r["out"].items():
                    name, mode = k.split("|")
                    print(f"  info {tag:9s} {mode:8s} {name:26s} {v[0]:6d} points   pitch {v[1]:.2f}   timing {v[2]:.2f}", flush=True)
                print(f"  info {tag}: tonality profiles of {until} s of song in {r['profMs']:.0f} ms")
                await pg.close()
            for tag, R in results.items():
                g = lambda n, m: R[n + "|" + m][0]
                wrong = ["+2 semitones", "-3 semitones", "random notes"]
                check(g("right melody", "melody") > 9000 and g("right, an octave up", "melody") > 9000
                      and max(g(w, "melody") for w in wrong) < 0.65 * g("right melody", "melody")
                      and g("silent", "melody") == 0 and g("silent", "tonality") == 0
                      and g("right melody", "tonality") > max(g(w, "tonality") for w in wrong)
                      and g("every other line", "melody") < 0.6 * g("right melody", "melody"),
                      f"{tag}: melody mode right {g('right melody', 'melody')}, octave up {g('right, an octave up', 'melody')}, wrong notes "
                      f"{'/'.join(str(g(w, 'melody')) for w in wrong)}, silent 0; tonality mode right {g('right melody', 'tonality')} vs wrong "
                      f"{'/'.join(str(g(w, 'tonality')) for w in wrong)}")

        if want("live"):
            print("live: song playing, the voice turned down, the singer as the microphone")
            # calibration: the same page playing with the voice processor and the microphone off -- headless
            # chromium's fake audio device drifts from the wall clock when the machine is loaded, so the
            # audio-thread pace is judged against this, not against 1.0
            pg, errs = await page("?song=karaoke_getlucky&audio=wem_getlucky.ogg")
            await pg.wait_for_function("() => window.__ready && harness.ctl().deck.kind === 'full'", timeout=60000)
            cal = await pg.evaluate("""async () => { const c = harness.ctl(); c.seek(40); await c.togglePlay(); const ctx = c.deck.out.ctx;
              const gaps = []; let last = performance.now(); const t0 = last, ct0 = ctx.currentTime;
              while (performance.now() - t0 < 15000) { await new Promise(r => requestAnimationFrame(r)); const n2 = performance.now(); gaps.push(n2 - last); last = n2; }
              const pace = (ctx.currentTime - ct0) / ((performance.now() - t0) / 1000); c.pause();
              return { pace, fps: 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length) }; }""")
            await pg.close()
            print(f"  info calibration (voice processor and microphone off): audio clock pace {cal['pace']:.3f}, {cal['fps']:.0f} fps", flush=True)
            live = []
            for rate, late, tr, name in ((1.0, 0, 0, "right"), (1.0, 0.3, 0, "300 ms late"), (1.0, 0, 2, "+2 semitones"), (0.75, 0, 0, "right, at 75 %")):
                pg, errs = await page("?song=karaoke_getlucky&audio=wem_getlucky.ogg")
                await pg.wait_for_function("() => window.__ready && harness.ctl().deck.kind === 'full'", timeout=60000)
                await pg.evaluate("() => harness.ctl().voice.set({volume: 0.3})")
                r = await pg.evaluate(LIVE, [40, 35, late, tr, rate])
                live.append((name, r, errs))
                print(f"  info {name:15s} {r['lines']} lines: pitch {r['pitch']:.2f}, timing {r['timing']:.2f}; {r['msgs']:.0f} pitch frames/s, "
                      f"voice frames/s {r['voiceFps']:.1f} (expected {r['expectVoiceFps']:.1f}), audio clock pace {r['audioPace']:.3f}; render p95 {r['render95']:.2f} ms, singing plugin p50/p95 "
                      f"{r['plug50']:.2f}/{r['plug95']:.2f} ms, {r['fps']:.0f} fps; latency compensated {1000 * r['lat']:.0f} ms; heap {r['heapMB'] or 0:+.1f} MB", flush=True)
                await pg.close()
            ok = dict((n, r) for n, r, e in live)
            check(all(r["ok"] and r["voice"] and not e for n, r, e in live) and ok["right"]["pitch"] > 0.9 and ok["right"]["timing"] > 0.9
                  and ok["300 ms late"]["pitch"] < ok["right"]["pitch"] and ok["+2 semitones"]["pitch"] < 0.6 and ok["right, at 75 %"]["pitch"] > 0.85
                  and all(r["msgs"] / r["audioPace"] > 90 and abs(r["voiceFps"] - r["expectVoiceFps"]) < 2 and r["audioPace"] > cal["pace"] - 0.12
                          and r["plug50"] < 1.5 and r["plug95"] < 8 for n, r, e in live),
                  f"right: pitch {ok['right']['pitch']:.2f}, timing {ok['right']['timing']:.2f}; late {ok['300 ms late']['pitch']:.2f}; +2 {ok['+2 semitones']['pitch']:.2f}; "
                  f"at 75 %: {ok['right, at 75 %']['pitch']:.2f}; the voice processor kept pace with the audio clock, "
                  f"{min(r['msgs'] / r['audioPace'] for n, r, e in live):.0f}+ pitch frames per audio second, audio pace within 0.12 of the calibration "
                  f"({min(r['audioPace'] for n, r, e in live):.2f} vs {cal['pace']:.2f}), the lane + score median "
                  f"{max(r['plug50'] for n, r, e in live):.2f} ms / p95 {max(r['plug95'] for n, r, e in live):.1f} ms per frame")

        if want("stress"):
            print("stress: an hour of scoring, the microphone toggled, seeks, the voice slider, songs switched, a full lane")
            pg, errs = await page()
            r = await pg.evaluate(STRESS_SCORER)
            check(r["maxTrail"] <= 800 and r["outOfRange"] == 0 and 0 <= r["score"] <= 10000 and r["usPerFrame"] < 20 and not errs,
                  f"scorer: 360,000 pitch frames (an hour; the song {r['passes']} times, a seek back each time) at {r['usPerFrame']:.2f} us per frame; "
                  f"the singer's trail stays <= {r['maxTrail']} points; the score always within 0..10,000")
            await pg.close()
            pg, errs = await page("?song=karaoke_getlucky&audio=wem_getlucky.ogg")
            await pg.wait_for_function("() => window.__ready && harness.ctl().deck.kind === 'full'", timeout=60000)
            r = await pg.evaluate(STRESS_LIVE)
            T, R, V, S, L = r["toggles"], r["restart"], r["voice"], r["songs"], r["lane"]
            check(T["leftOpen"] == 0 and not T["on"] and R["ok"] and R["framesPerS"] > 60 and R["open"] == 1 and not errs,
                  f"microphone on/off 40 times (every third stopped before it had started): {T['opened']} streams opened, {T['leftOpen']} left open; "
                  f"on again: {R['framesPerS']:.0f} pitch frames/s, {R['open']} stream open")
            check(r["seeks"]["bad"] == 0 and r["seeks"]["playing"] and not errs, "40 seeks while singing: the score stays within 0..10,000, still playing")
            check(V["inputs"] <= 6 and abs(V["last"] - 0.35) < 1e-9 and V["stored"]["volume"] == 0.35 and abs(V["amount"] - 0.65) < 1e-6 and not errs,
                  f"voice slider, 400 changes in ~4 s: {V['inputs']} reports to the host (once it rests), stored {V['stored']}, processor amount {V['amount']:.2f}")
            check(all(x["on"] and x["mode"] == "melody" and x["framesPerS"] > 60 and x["voice"] and x["open"] == 1 for x in S) and not errs,
                  "4 songs switched under a singing microphone: " + "; ".join(f"{x['name']} {x['mode']}, {x['framesPerS']:.0f} frames/s" for x in S))
            check(L["p95"] < 4 and r["leftOpen"] == 0 and r["heapMB"] < 15 and not errs,
                  f"lane with 800 trail points: {L['p50']:.2f} ms median, {L['p95']:.2f} ms p95 per frame; after all this: {r['leftOpen']} streams open, "
                  f"heap {r['heapMB']:+.1f} MB (after GC)")
            await pg.close()

        if want("controls"):
            print("controls: the voice popover and the microphone button, and what Shiny hears")
            pg, errs = await page("?song=karaoke_getlucky&audio=wem_getlucky.ogg")
            await pg.wait_for_function("() => window.__ready && harness.ctl().deck.kind === 'full'", timeout=60000)
            r = await pg.evaluate(CONTROLS)
            check(r["popOpen"] and len(r["drag"]) == 1 and r["drag"][0]["volume"] == 0.4 and not r["drag"][0]["mute"]
                  and len(r["mute"]) == 1 and r["mute"][0]["mute"] and r["host"]["echoed"] == 0 and r["host"]["volume"] == 0.8
                  and r["host"]["label"] == "80%" and r["popClosed"] and not errs,
                  f"voice popover: a drag reports once ({r['drag']}), mute ({r['mute'][0]['mute'] if r['mute'] else None}); a host command is applied "
                  f"({r['host']['label']}) and not echoed back; a click outside closes it")
            check(r["micOn"]["on"] and r["micOn"]["inputs"] and r["micOn"]["inputs"][-1]["on"] and r["micOn"]["lane"] != "none"
                  and r["micOn"]["laneW"] > 0.9 and 60 < r["micOn"]["laneH"] < 120 and 0.99 < r["micOn"]["pixels"] < 2.01
                  and not r["micOff"]["on"] and r["micOff"]["inputs"] and not r["micOff"]["inputs"][-1]["on"] and not errs,
                  f"microphone button: on ({r['micOn']['inputs'][-1] if r['micOn']['inputs'] else None}), lane shown across the player "
                  f"({100 * r['micOn']['laneW']:.0f} % of its width, {r['micOn']['laneH']:.0f} px high, {r['micOn']['pixels']:.1f} canvas pixels per CSS pixel); off by the host: "
                  f"{r['micOff']['inputs'][-1] if r['micOff']['inputs'] else None}, results card {r['micOff']['card']}")
            await pg.close()

        if want("page"):
            print("the standalone HTML page, opened from disk")
            import karaoke_export_html as X
            out = os.path.join(tempfile.mkdtemp(prefix="rs-sing-"), "gl.html")
            X.main([os.path.join(ROOT, "songs", SONGS["getlucky"]), "-o", out, "--audio", "embed", "--audio-format", "copy", "--no-online", "--no-cache"])
            pg = await b.new_page(); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto("file://" + out)
            await pg.add_script_tag(path=os.path.join(ROOT, "tests", "frontend", "sing_synth.js"))
            await pg.wait_for_function("() => window.karaokePage && karaokePage.player.deck.kind === 'full'", timeout=60000)
            r = await pg.evaluate("""async () => { const c = karaokePage.player, T = SingTest; c.voice.set({mute: true});
              await c.deck.out.ensure(); const ctx = c.deck.out.ctx; const dest = ctx.createMediaStreamDestination();
              navigator.mediaDevices.getUserMedia = async () => dest.stream;
              const x = T.voice([{t: 0.2, d: 3, midi: 57}], ctx.sampleRate, 4, {}); const b = ctx.createBuffer(1, x.length, ctx.sampleRate); b.copyToChannel(x, 0);
              const s = ctx.createBufferSource(); s.buffer = b; s.connect(dest);
              c.seek(10); await c.togglePlay(); const ok = await c.sing.start({quiet: true}); s.start();
              await new Promise(r => setTimeout(r, 2500)); c.pause();
              return { ok, voice: !!c.deck.audio._voice, frames: c.sing.frames, mode: c.sing.scorer && c.sing.scorer.mode, secure: window.isSecureContext,
                       lane: getComputedStyle(c.sing.lane).display }; }""")
            check(r["ok"] and r["voice"] and r["frames"] > 150 and r["mode"] == "melody" and r["lane"] != "none" and not errs,
                  f"file:// page: voice processor inserted {r['voice']}, microphone scoring on ({r['frames']} pitch frames in 2.5 s, {r['mode']} mode), "
                  f"secure context {r['secure']}; errors {errs}")
            await pg.close()
            # a songbook opened from disk with its audio in files next to it: the element plays on its own
            # (Web Audio would get silence from a file:// element), so the voice control says why it is off
            out2 = os.path.join(tempfile.mkdtemp(prefix="rs-sing-"), "book.html")
            X.main([os.path.join(ROOT, "songs", SONGS["getlucky"]), os.path.join(ROOT, "songs", SONGS["sultans"]), "-o", out2,
                    "--audio", "files", "--audio-format", "copy", "--no-online", "--no-cache"])
            pg = await b.new_page(); errs = []; cors = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.on("console", lambda m: cors.append(m.text) if "CORS" in m.text else None)
            await pg.goto("file://" + out2)
            await pg.wait_for_function("() => window.karaokePage && karaokePage.player.deck.audio", timeout=60000)
            r = await pg.evaluate("""async () => { const c = karaokePage.player, wait = ms => new Promise(r => setTimeout(r, ms));
              karaokePage.load(karaokePage.songs.findIndex(s => /Get Lucky/.test(s.meta ? s.meta.title : s.title || '')));
              let t0 = performance.now(); while (!(c.deck.kind === 'full' && /Lucky/.test(c.song.meta.title)) && performance.now() - t0 < 20000) await wait(100);
              c.seek(30); await c.togglePlay(); await wait(600);
              const a = c.deck.audio, t1 = a.currentTime; await wait(1000);
              const out = { direct: a._direct, routed: !!a._gain, advanced: a.currentTime - t1 };
              c.voice.set({volume: 0.2}); await wait(400);
              out.voice = { available: c.voice.available(), inserted: !!a._voice, dimmed: c.voice.btn.classList.contains('is-unavailable'),
                            hint: c.voice.hint.textContent };
              const ctx = c.deck.out.ctx; const dest = ctx.createMediaStreamDestination(); navigator.mediaDevices.getUserMedia = async () => dest.stream;
              out.sing = await c.sing.start({quiet: true}); await wait(800); out.mode = c.sing.scorer && c.sing.scorer.mode;
              c.voice.set({volume: 1}); c.sing.stop(); c.pause(); return out; }""")
            check(r["direct"] and not r["routed"] and r["advanced"] > 0.8 and not cors and not r["voice"]["available"] and not r["voice"]["inserted"]
                  and r["voice"]["dimmed"] and "web server" in r["voice"]["hint"] and r["sing"] and r["mode"] == "melody" and not errs,
                  f"file:// songbook, audio in files next to it: plays on the element (not through Web Audio: {r['advanced']:.2f} s in 1 s, "
                  f"no CORS silence), the voice control off and saying why, singing on ({r['mode']} mode); errors {errs + cors}")
            await pg.close()
        await b.close()
    srv.shutdown()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

asyncio.run(main())
