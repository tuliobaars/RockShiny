"""
Automated checks for the JS highway (optional dev tooling; needs Python 3 +
`pip install playwright cryptography numpy && playwright install chromium`,
plus ffmpeg for the click track).

  python3 tests/frontend/check_frontend.py

1. builds fixtures from songs/ (tests/reference/make_fixtures.py) if missing
2. render smoke test on each fixture (no JS errors, notes drawn)
3. A/V sync: plays a click track, compares the render clock with
   audio.currentTime every frame at 1.0x and 0.75x, plus seek/pause
4. per-frame draw cost over contiguous 60 fps playback (incl. raster flush)
"""
import asyncio, functools, http.server, os, statistics, subprocess, sys, threading
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "tests", "frontend", "fixtures")
PORT = 8799

SAMPLE = """async (ms) => {
  const c = harness.ctl(), out = [];
  await new Promise(res => { const t0 = performance.now();
    (function f(ts) { out.push({ts, clock: c.clock.time(ts), media: c.audio ? c.audio.currentTime : null});
      if (ts - t0 < ms) requestAnimationFrame(f); else res(); })(performance.now()); });
  return out; }"""
BENCH = """(n) => {
  const c = harness.ctl(), r = c.renderer; c._stop(); const ts = [];
  for (let i = 0; i < n; i++) { const t = [40, 120, 200][Math.floor(3 * i / n)] + (i % (n / 3)) / 60;
    const t0 = performance.now(); r.draw(t, 1 / 60); r.ctx.getImageData(0, 0, 1, 1); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b); return {p50: ts[n >> 1], p95: ts[Math.floor(n * 0.95)]}; }"""

E2E = """async (secs) => {
  const c = harness.ctl(), N = c.chart.notes;
  c.seek(20); await c.togglePlay();
  const ctx = c.audioOut.ctx;
  const code = `class Tap extends AudioWorkletProcessor { constructor() { super(); this.last = -1; }
    process(inputs) { const x = inputs[0] && inputs[0][0]; if (!x) return true;
      for (let k = 0; k < x.length; k++) if (Math.abs(x[k]) > 0.3) { const t = (currentFrame + k) / sampleRate;
        if (t - this.last > 0.05) this.port.postMessage(t); this.last = t; } return true; } }
    registerProcessor('tap', Tap);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})));
  const tap = new AudioWorkletNode(ctx, 'tap'), sink = ctx.createGain(); sink.gain.value = 0;
  c.audio._src.connect(tap); tap.connect(sink).connect(ctx.destination);
  const found = [];
  tap.port.onmessage = (e) => { const ts = ctx.getOutputTimestamp(); found.push(c.chartTime(ts.performanceTime + (e.data - ts.contextTime) * 1000)); };
  await new Promise(r => setTimeout(r, secs * 1000)); c.clock.pause();
  const lb = (x) => { let lo = 0, hi = N.n; while (lo < hi) { const m = (lo + hi) >> 1; if (N.t[m] < x) lo = m + 1; else hi = m; } return lo; };
  const errs = found.map(s => { const i = lb(s); const cs = [N.t[i - 1], N.t[i]].filter(v => v != null);
    return 1000 * (s - cs.reduce((a, b) => Math.abs(b - s) < Math.abs(a - s) ? b : a)); });
  return { errs, lat: 1000 * c._lat, routed: !!c.audio._gain };
}"""

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

def sync_stats(samples, rate):
    s = samples[5:]
    fresh = [s[i]["clock"] - s[i]["media"] for i in range(1, len(s)) if s[i]["media"] != s[i - 1]["media"]]
    adv = [(b["clock"] - a["clock"], (b["ts"] - a["ts"]) / 1000) for a, b in zip(s, s[1:])]
    wobble = sorted(abs(c / (d * rate) - 1) for c, d in adv if d > 0)
    return statistics.mean(fresh), max(map(abs, fresh)), wobble[len(wobble) // 2], sum(c < 0 for c, _ in adv)

async def main():
    if not os.path.exists(os.path.join(FIX, "clicks.ogg")):
        subprocess.run([sys.executable, os.path.join(ROOT, "tests", "reference", "make_fixtures.py"), FIX], check=True)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{PORT}/tests/frontend/harness.html"

    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        print("render smoke (both renderers)")
        for renderer in ("canvas", "dom"):
            for chart, t in (("wywh_lead", 95), ("sultans_lead", 203), ("sultans_bass", 60)):
                pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []
                pg.on("pageerror", lambda e: errs.append(str(e)))
                await pg.goto(f"{base}?chart={chart}&t={t}&renderer={renderer}"); await pg.wait_for_timeout(800)
                n = await pg.evaluate("() => harness.ctl().renderer.stats.notesDrawn")
                kind = await pg.evaluate("() => harness.ctl().rendererKind")
                ready = await pg.evaluate("() => window.__inputs.find(i => i.name === 'hw_ready')?.value")
                check(not errs and n > 0 and ready and kind == renderer and "flac" in ready["formats"],
                      f"{renderer:6s} {chart}: {n} gems drawn, ready sent (formats {ready and ready['formats']}), errors={errs}")
                await pg.close()

        print("renderer switch + in-browser benchmark command")
        pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=sultans_lead&t=100"); await pg.wait_for_timeout(500)
        await pg.evaluate("() => harness.message('play')")
        await pg.evaluate("() => harness.message('settings', {settings: {renderer: 'dom'}})"); await pg.wait_for_timeout(300)
        st = await pg.evaluate("() => ({kind: harness.ctl().rendererKind, canvases: document.querySelectorAll('#hw canvas').length, "
                               "hidden: harness.ctl().canvas.style.display, playing: harness.ctl().clock.playing})")
        check(st["kind"] == "dom" and st["hidden"] == "none" and st["canvases"] == 1 and st["playing"],
              f"switch to dom while playing: {st}")
        await pg.evaluate("() => harness.message('settings', {settings: {renderer: 'canvas'}})"); await pg.wait_for_timeout(300)
        st = await pg.evaluate("() => ({kind: harness.ctl().rendererKind, canvases: document.querySelectorAll('#hw canvas').length, dom: document.querySelectorAll('#hw .rs-hwd').length})")
        check(st == {"kind": "canvas", "canvases": 1, "dom": 0}, f"switch back to canvas, DOM renderer removed: {st}")
        await pg.evaluate("() => harness.message('benchmark', {seconds: 1})")
        await pg.wait_for_function("() => window.__inputs.some(i => i.name === 'hw_benchmark')", timeout=20000)
        bm = await pg.evaluate("() => window.__inputs.find(i => i.name === 'hw_benchmark').value")
        kinds = [r["renderer"] for r in bm["results"]]
        after = await pg.evaluate("() => ({kind: harness.ctl().rendererKind, playing: harness.ctl().clock.playing})")
        check(kinds == ["canvas", "dom"] and all(r["fps"] > 0 for r in bm["results"]) and after == {"kind": "canvas", "playing": True} and not errs,
              "benchmark: " + ", ".join(f"{r['renderer']} {r['fps']} fps p95 {r['p95FrameMs']} ms" for r in bm["results"]) + f"; state restored {after}")
        await pg.close()

        print("practice loop: lead-in countdown on screen, wrap, speed ramp")
        pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=sultans_lead"); await pg.wait_for_function("() => window.__ready")
        r = await pg.evaluate("""async () => { const c = harness.ctl(), wait = (ms) => new Promise(r => setTimeout(r, ms));
          harness.message('settings', {settings: {playbackRate: 0.8, practice: {loop: true, start: 100, end: 102, leadIn: 1.5, ramp: 0.1}}});
          c.seek(98.5); await c.togglePlay(); await wait(400);
          const e = c.countdown.root, shown = getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0;
          const out = { shown, text: e.textContent };
          await wait(4800);                                             // past the loop end (4.4 s at 0.8x) -> wrapped once
          out.loops = c.loopCount; out.rate = c.clock.rate; out.t = c.clock.time(performance.now());
          c.clock.pause(); return out; }""")
        check(r["shown"] and r["text"] in ("1", "2") and r["loops"] >= 1 and abs(r["rate"] - 0.9) < 1e-6 and 98.4 < r["t"] < 102 and not errs,
              f"countdown '{r['text']}' visible during the lead-in: {r['shown']}; {r['loops']} wrap(s), speed ramped to {r['rate']:.2f}; errors={errs}")
        await pg.close()

        print("A/V sync (click track)")
        pg = await b.new_page(viewport={"width": 1280, "height": 720})
        await pg.goto(f"{base}?chart=wywh_lead&audio=clicks.ogg")
        await pg.wait_for_function("() => window.harness && harness.ctl() && harness.ctl().audio")
        await pg.evaluate("async () => { harness.message('seek', {time: 20}); await harness.ctl().togglePlay(); }")
        await pg.wait_for_timeout(400)
        for rate in (1.0, 0.75):
            if rate != 1.0:
                await pg.evaluate(f"() => harness.message('settings', {{settings: {{playbackRate: {rate}}}}})")
                await pg.wait_for_timeout(400)
            mean, worst, wobble, backwards = sync_stats(await pg.evaluate(SAMPLE, 4000), rate)
            check(abs(mean) < 0.005 and worst < 0.05 and backwards == 0,
                  f"{rate:.2f}x: clock-audio mean {1000 * mean:+.1f} ms, worst {1000 * worst:.1f} ms, "
                  f"per-frame wobble {100 * wobble:.1f}%, backwards steps {backwards}")
        await pg.evaluate("() => harness.message('seek', {time: 50})"); await pg.wait_for_timeout(300)
        r = await pg.evaluate("() => { const c = harness.ctl(); return [c.clock.time(performance.now()), c.audio.currentTime] }")
        check(abs(r[0] - r[1]) < 0.05 and r[0] > 50, f"seek while playing re-locks (clock {r[0]:.3f} vs audio {r[1]:.3f})")
        await pg.evaluate("() => harness.message('pause')"); await pg.wait_for_timeout(200)
        a = await pg.evaluate("() => harness.ctl().clock.time(performance.now())"); await pg.wait_for_timeout(400)
        check(a == await pg.evaluate("() => harness.ctl().clock.time(performance.now())"), "pause freezes the clock")
        await pg.close()

        print("techniques: bend curves drive ribbon + string deflection (both renderers)")
        for renderer in ("canvas", "dom"):
            pg = await b.new_page(viewport={"width": 1000, "height": 560}); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(f"{base}?chart=sultans_lead&renderer={renderer}"); await pg.wait_for_function("() => window.__ready")
            r = await pg.evaluate("""() => { const c = harness.ctl(), r = c.renderer, N = c.chart.notes;
              let i = -1; for (let k = 0; k < N.n; k++) if (N.bendStart[k] >= 0 && N.sus[k] > 0.6) { i = k; break; }
              const t = N.t[i] + 0.5 * N.sus[i]; c._stop(); r.cam.init = false; r.draw(t, 1/60);
              let rib = 0; r.forEachRibbon(i, N.t[i] - 0.3, 7.33, () => rib++);
              return { bendMid: r.bendAt(i, t), peak: N.bend[i], deflected: r._deflOn[N.s[i]] === 1, rib }; }""")
            check(not errs and r["bendMid"] > 0 and r["deflected"] and r["rib"] > 0,
                  f"{renderer:6s} bend {r['bendMid']:.2f}/{r['peak']:.1f} semitones mid-sustain, string deflected={r['deflected']}, errors={errs}")
            await pg.close()

        print("input seam: judge via bus.noteHit = true / pitch-aware hits / external trigger")
        pg = await b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=sultans_lead"); await pg.wait_for_function("() => window.__ready")
        r = await pg.evaluate("""async () => {
          const c = harness.ctl(), N = c.chart.notes, J = c.judge, wait = (ms) => new Promise(r => setTimeout(r, ms));
          harness.message('settings', {settings: {inputSource: 'keyboard'}});
          const ons = []; for (let i = 0; i < N.n; i++) if (N.t[i] > 10 && (!ons.length || N.t[i] - ons[ons.length - 1].t > 0.01)) ons.push({t: N.t[i], i});
          c.seek(ons[0].t - 0.5); await c.togglePlay();
          const at = (tc) => performance.now() + (tc - c.chartTime(performance.now())) * 1000;
          await wait(Math.max(0, at(ons[0].t) - performance.now())); c.bus.noteHit = true;            // boolean trigger
          await wait(Math.max(0, at(ons[1].t) - performance.now())); c.bus.hit({midi: J.midi[ons[1].i] + 3});   // wrong pitch
          await wait(Math.max(0, at(ons[2].t) - performance.now())); harness.message('input', {hit: true});     // R-style
          await wait(Math.max(0, at(ons[2].t + 0.2) - performance.now()));
          return { states: [0, 1, 2].map(k => J.state[ons[k].i]), sum: J.summary() }; }""")
        check(r["states"] == [1, 2, 1] and r["sum"]["hits"] == 2 and r["sum"]["extra"] == 1 and not errs,
              f"states {r['states']} (1=hit, 2=missed), summary {r['sum']}")
        await pg.close()

        print("scoring UI: results card at the end of a run, loop-pass results, latency calibration")
        pg = await b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=sultans_lead"); await pg.wait_for_function("() => window.__ready")
        r = await pg.evaluate("""async () => {
          const c = harness.ctl(), N = c.chart.notes, wait = (ms) => new Promise(r => setTimeout(r, ms));
          const res = () => window.__inputs.filter((x) => x.name === "hw_result").map((x) => x.value);
          harness.message('settings', {settings: {inputSource: 'keyboard'}});
          const at = (tc) => performance.now() + (tc - c.chartTime(performance.now())) * 1000;
          // 1. song run: last few notes, hit every other onset -> results card + hw_result
          const ons = []; for (let i = 0; i < N.n; i++) if (!ons.length || N.t[i] - ons[ons.length - 1] > 0.01) ons.push(N.t[i]);
          const tail = ons.slice(-6);
          c.seek(tail[0] - 0.6); await c.togglePlay();
          const expected = ons.filter((t) => t >= tail[0] - 0.6 - c.judge.window).length;
          // (chart-time hits, as the microphone sends them: immune to timer jitter on a loaded machine)
          for (let k = 0; k < tail.length; k += 2) { await wait(Math.max(0, at(tail[k]) - performance.now())); c.bus.hit({ chartTime: tail[k] + 0.01 }); }
          await wait(Math.max(0, at(c._lastNoteEnd + 3.3) - performance.now()));
          const song = res().find((x) => x.kind === 'song');
          const card = document.querySelector('.rs-hw-results');
          const shown = !!card && card.style.display !== 'none';
          harness.message('result_ack', { newBest: true, previous: 0.5, best: song && song.accuracy });
          const best = document.querySelector('.rs-hw-results-best').textContent;
          document.querySelector('.rs-hw-results-btn:last-child').click();       // Close
          const closed = card.style.display === 'none';
          // 2. loop pass: 3 s loop, one hit -> hw_result kind "loop", stats restart
          c.clock.pause();
          const S = ons[Math.floor(ons.length / 3)];
          c.setPractice({ loop: true, start: S - 0.2, end: S + 2.8, leadIn: 0, ramp: 0 });
          c.seek(S - 0.2); await c.togglePlay();
          await wait(Math.max(0, at(S) - performance.now())); c.bus.hit({ chartTime: S });
          await wait(Math.max(0, at(S + 2.8) - performance.now()) + 300);
          const loop = res().find((x) => x.kind === 'loop');
          const after = c.judge.hits;
          c.clock.pause(); c.setPractice({ loop: false, start: 0, end: 0 });
          return { song, expected, shown, best, closed, loop, after, fb: document.querySelector('.rs-hw-feedback').textContent }; }""")
        s, lp = r["song"], r["loop"]
        check(s and s["hits"] == 3 and s["misses"] == r["expected"] - 3 and s["coverage"] > 0 and r["shown"]
              and "New personal best" in r["best"] and r["closed"] and not errs,
              f"song run: {s and s['hits']} hit / {s and s['misses']} missed, results card shown {r['shown']}, ack -> '{r['best']}', closed {r['closed']}, feedback '{r['fb']}'")
        check(lp and lp["pass"] == 1 and lp["hits"] == 1 and r["after"] == 0,
              f"loop pass result: pass {lp and lp['pass']}, {lp and lp['hits']} hit / {lp and lp['misses']} missed; stats restarted for the next pass (hits now {r['after']})")
        r = await pg.evaluate("""async () => {
          harness.message('settings', {settings: {inputSource: 'microphone'}});   // headless: no capture device
          const t0 = performance.now();
          const mine = () => window.__inputs.find((x) => x.name === 'hw_input_status' && x.value.source === 'microphone');
          while (!mine() && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 50));
          const c = harness.ctl();
          return { st: (mine() || {}).value, active: c.judge.active, src: !!c.inputSource }; }""")
        check(r["st"] and r["st"]["ok"] is False and not r["active"] and not r["src"] and not errs,
              f"microphone unavailable -> reported, scoring off: '{r['st'] and r['st'].get('error')}'")
        await pg.evaluate("() => harness.message('settings', {settings: {inputSource: 'none'}})")
        r = await pg.evaluate("""async () => {
          const c = harness.ctl(), NS = RSHighway;
          // stand-in microphone: "hears" every click 37 +/- 1 ms late, misses one, plus one stray onset
          NS.registerInputSource("microphone", (ctx) => ({
            start() { this.timer = setInterval(() => { const k = c._calib; if (k && !k.fed) { k.fed = true;
              k.clicks.forEach((t, j) => { if (j !== 3) ctx.onOnsetRaw(t + 37 + (j % 3) - 1); });
              ctx.onOnsetRaw(k.clicks[1] + 900); } }, 50); },
            stop() { clearInterval(this.timer); }, setOptions(o) { this.set = o; }, latencyMs() { return 0; } }));
          harness.message('settings', {settings: {inputSource: 'microphone'}});
          await new Promise((r) => setTimeout(r, 100));
          harness.message('calibrate', {});
          const t0 = performance.now();
          while (!window.__inputs.some((x) => x.name === 'hw_calibration') && performance.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 100));
          return { cal: (window.__inputs.find((x) => x.name === 'hw_calibration') || {}).value, set: c.inputSource.set }; }""")
        cal = r["cal"] or {}
        check(cal.get("ok") and abs(cal["latencyMs"] - 37) <= 1 and cal["matched"] == 7 and r["set"] and r["set"]["latencyMs"] == cal["latencyMs"] and not errs,
              f"calibration: {cal.get('latencyMs')} ms from {cal.get('matched')}/{cal.get('clicks')} clicks (spread {cal.get('spreadMs')} ms), applied to the source")
        await pg.close()

        print("other instruments: piano / harmonica lane charts")
        for chart, t in [("wywh_piano", 110), ("allmylife_piano", 60), ("sultans_harmonica", 62), ("getlucky_vocals_harmonica", 60), ("midi_piano", 25)]:
            pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(f"{base}?chart={chart}&t={t}"); await pg.wait_for_function("() => window.__ready"); await pg.wait_for_timeout(300)
            r = await pg.evaluate("""() => { const c = harness.ctl(), R = c.renderer;
              return { kind: c.rendererKind, drawn: R.stats.notesDrawn, inst: c.chart.instrument, tag: document.querySelector('.rs-hw-card-tags').textContent,
                       width: R.width, fits: (() => { const p = {}; R.project(0, 0, -R.instLen, p); const a = p.x; R.project(R.width, 0, -R.instLen, p); return a >= 0 && p.x <= R.W; })() }; }""")
            check(r["kind"] == "lanes" and r["drawn"] > 0 and r["fits"] and not errs,
                  f"{chart}: {r['inst']} ({r['tag']}), {r['width']} lanes, {r['drawn']} blocks drawn, instrument fits the view, errors={errs}")
            await pg.close()
        pg = await b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=sultans_harmonica"); await pg.wait_for_function("() => window.__ready")
        r = await pg.evaluate("""async () => {
          const c = harness.ctl(), N = c.chart.notes, J = c.judge, wait = (ms) => new Promise(r => setTimeout(r, ms));
          harness.message('settings', {settings: {inputSource: 'keyboard'}});
          const at = (tc) => performance.now() + (tc - c.chartTime(performance.now())) * 1000;
          const i0 = N.t.findIndex((t) => t > 30);
          c.seek(N.t[i0] - 0.5); await c.togglePlay();
          await wait(Math.max(0, at(N.t[i0]) - performance.now())); c.bus.hit({ chartTime: N.t[i0] });
          await wait(30); const pressed = c.renderer.stats.pressed;
          await wait(Math.max(0, at(N.t[i0 + 1] + 0.6) - performance.now()));
          const st = [J.state[i0], J.state[i0 + 1]];
          // back to a guitar chart in the same page: guitar renderer again
          c.clock.pause(); await harness.loadChart('sultans_lead'); await wait(100);
          return { st, pressed, midi: J.midi ? null : null, freqOk: true, kind: c.rendererKind, guitar: c.chart.instrument }; }""")
        check(r["st"] == [1, 2] and r["pressed"] >= 1 and r["kind"] == "canvas" and not errs,
              f"harmonica judge: hit -> state {r['st'][0]}, unplayed -> {r['st'][1]} (1 hit, 2 missed); hole lit on hit ({r['pressed']}); back to guitar: {r['kind']} renderer")
        await pg.close()

        print("guide tones: synthesized chart notes heard when the notes reach the strike line")
        pg = await b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=midi_piano"); await pg.wait_for_function("() => window.__ready")
        r = await pg.evaluate("""async () => {
          const c = harness.ctl(), N = c.chart.notes, G = c.guide;
          harness.message('settings', {settings: {guideTones: true, guideVolume: 0.6}});
          // a click instead of the piano voice: sharp onsets to time (the scheduling path is the real one)
          G._voice = function (midi, when, dur) { const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
            o.type = 'square'; o.frequency.value = 1000; g.gain.setValueAtTime(0, 0); g.gain.setValueAtTime(1, when); g.gain.setValueAtTime(0, when + 0.004);
            o.connect(g).connect(this.master); o.start(when); o.stop(when + 0.01); this.voices.push({ o, g, end: when + 0.01 }); };
          c.seek(22); await c.togglePlay();
          const ctx = c.audioOut.ctx;
          const code = `class Tap extends AudioWorkletProcessor { constructor() { super(); this.last = -1; }
            process(inputs) { const x = inputs[0] && inputs[0][0]; if (!x) return true;
              for (let k = 0; k < x.length; k++) if (Math.abs(x[k]) > 0.1) { const t = (currentFrame + k) / sampleRate;
                if (t - this.last > 0.05) this.port.postMessage(t); this.last = t; } return true; } }
            registerProcessor('tap2', Tap);`;
          await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})));
          const tap = new AudioWorkletNode(ctx, 'tap2'), sink = ctx.createGain(); sink.gain.value = 0;
          G._graph(); G.master.connect(tap); tap.connect(sink).connect(ctx.destination);
          const found = [];
          tap.port.onmessage = (e) => { const ts = ctx.getOutputTimestamp(); found.push(c.chartTime(ts.performanceTime + (e.data - ts.contextTime) * 1000)); };
          await new Promise(r => setTimeout(r, 8000)); c.clock.pause();
          const errs = found.map((s) => { let best = 1e9; for (let i = 0; i < N.n; i++) if (Math.abs(N.t[i] - s) < Math.abs(best)) best = N.t[i] - s; return -1000 * best; });
          let expected = 0; for (let i = 0; i < N.n; i++) if (N.t[i] > 22.4 && N.t[i] < 29.5 && (i === 0 || N.t[i] - N.t[i - 1] > 0.05)) expected++;
          return { errs, expected, scheduled: G.scheduled, hasAudio: !c.el.querySelector('.rs-hw-transport').classList.contains('is-silent') }; }""")
        e = sorted(r["errs"][1:])
        med = statistics.median(e) if e else 99
        check(len(e) >= 0.8 * r["expected"] and abs(med) < 12 and r["hasAudio"] and not errs,
              f"{len(e)} guide notes heard (~{r['expected']} expected): heard-vs-shown median {med:+.1f} ms (range {e[0] if e else 0:+.0f}..{e[-1] if e else 0:+.0f} ms); transport shows sound: {r['hasAudio']}")
        await pg.close()

        print("quick-start clip -> full audio handover")
        pg = await b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"{base}?chart=wywh_lead"); await pg.wait_for_function("() => window.__ready")
        key = await pg.evaluate("() => harness.ctl().songKey")
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/clicks_head.ogg', songKey: '{key}', kind: 'head', seconds: 30}})")
        await pg.wait_for_function("() => harness.ctl().audioKind === 'head'")
        await pg.evaluate("async () => { harness.ctl().seek(18); await harness.ctl().togglePlay(); }")
        await pg.wait_for_timeout(1200)
        trace = asyncio.ensure_future(pg.evaluate("""(ms) => new Promise(res => { const c = harness.ctl(), out = []; const t0 = performance.now();
          (function f(ts) { out.push([ts, c.clock.time(ts), c.clock.playing, c.audioKind]); if (ts - t0 < ms) requestAnimationFrame(f); else res(out); })(t0); })""", 4000))
        await pg.wait_for_timeout(200)
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/clicks.ogg', songKey: '{key}', kind: 'full'}})")
        tr = await trace
        st = await pg.evaluate("() => { const c = harness.ctl(); return {kind: c.audioKind, err: c.handoverError, lag: c.clock.time(performance.now()) - c.audio.currentTime} }")
        sw = next((k for k, (a, b2) in enumerate(zip(tr, tr[1:])) if a[3] == "head" and b2[3] == "full"), 0)
        near = tr[max(0, sw - 10): sw + 12]                       # +/- 10 frames around the switch
        jump = max(abs((b2[1] - a[1]) - (b2[0] - a[0]) / 1000) for a, b2 in zip(near, near[1:])) * 1000
        check(st["kind"] == "full" and st["err"] is not None and abs(st["err"]) < 0.01 and all(x[2] for x in tr) and jump < 40 and not errs,
              f"handed over while playing: alignment {1000 * (st['err'] or 0):.1f} ms, largest clock step around the switch {jump:.1f} ms, never paused")
        await pg.evaluate(f"() => harness.ctl().seek(10)")
        await pg.close()
        pg = await b.new_page(); await pg.goto(f"{base}?chart=wywh_lead"); await pg.wait_for_function("() => window.__ready")
        key = await pg.evaluate("() => harness.ctl().songKey")
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/clicks_head.ogg', songKey: '{key}', kind: 'head', seconds: 30}})")
        await pg.wait_for_function("() => harness.ctl().audioKind === 'head'")
        await pg.evaluate("async () => { const c = harness.ctl(); await c.togglePlay(); c.seek(50); }"); await pg.wait_for_timeout(400)
        h = await pg.evaluate("() => { const c = harness.ctl(); return {t: c.clock.time(performance.now()), holding: c.clock.holding} }")
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/clicks.ogg', songKey: '{key}', kind: 'full'}})")
        await pg.wait_for_function("() => harness.ctl().audioKind === 'full'"); await pg.wait_for_timeout(600)
        r = await pg.evaluate("() => { const c = harness.ctl(); return {t: c.clock.time(performance.now()), playing: c.clock.playing} }")
        check(h["holding"] and abs(h["t"] - 50) < 0.01 and r["playing"] and 50 < r["t"] < 51.5,
              f"seek past the clip holds at {h['t']:.2f} s, resumes there when the full audio arrives ({r['t']:.2f} s)")
        await pg.close()

        print("end-to-end A/V: chart time on screen at the moment each click is heard (AudioWorklet tap)")
        pg = await b.new_page(); await pg.goto(f"{base}?chart=wywh_lead&audio=clicks.ogg")
        await pg.wait_for_function("() => harness.ctl() && harness.ctl().audioKind === 'full'")
        r = await pg.evaluate(E2E, 10)
        steady = r["errs"][3:]
        # within one 60 Hz frame, as in check_karaoke.py: this headless Chromium reports ~15 ms more
        # output latency than its measured path, so the median sits at -9..-16 ms here from run to run
        q = statistics.quantiles(steady, n=10) if len(steady) >= 2 else [0, 0]
        check(r["routed"] and abs(statistics.median(steady)) < 17 and q[-1] - q[0] < 30,
              f"compensating {r['lat']:.0f} ms output latency; heard-vs-shown median {statistics.median(steady):+.1f} ms "
              f"(range {min(steady):+.0f}..{max(steady):+.0f} ms) over {len(steady)} clicks")
        await pg.close()

        print("draw cost (contiguous playback, includes raster flush; headless = software raster)")
        for chart in ("wywh_lead", "sultans_lead"):
            pg = await b.new_page(viewport={"width": 1280, "height": 720})
            await pg.goto(f"{base}?chart={chart}"); await pg.wait_for_function("() => window.__ready")
            r = await pg.evaluate(BENCH, 360)
            print(f"  info {chart}: p50 {r['p50']:.1f} ms, p95 {r['p95']:.1f} ms per frame")
            await pg.close()
        await b.close()
    srv.shutdown()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

asyncio.run(main())
