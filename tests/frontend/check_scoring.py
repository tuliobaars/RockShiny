"""
Microphone scoring accuracy (offline, deterministic). Needs Python + Playwright
+ numpy/scipy; run after tests/reference/make_fixtures.py.

Synthesized guitar performances with known mistakes (synth_performance.py) are
rendered through the real analysis worklet (pitch-worklet.js) in an
OfflineAudioContext; the emitted onsets/spectra are replayed through the real
NoteVerifier + HitJudge (mic.js, input.js). Every event is compared with the
ground truth: correct -> should be hit, wrong pitch / omitted -> should not.
"""
import asyncio, functools, http.server, json, os, statistics, subprocess, sys, threading
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "tests", "frontend", "fixtures")
PORT = 8798
CASES = [("sultans_lead", "perf_sultans", 10, 70, 8192), ("wywh_lead", "perf_wywh", 60, 120, 8192),
         ("sultans_bass", "perf_bass", 20, 80, 16384),
         # added later while tuning (different charts + random seeds):
         ("getlucky_lead", "perf_getlucky", 30, 90, 8192), ("allmylife_rhythm", "perf_allmylife", 40, 100, 8192),
         # never used for tuning (held out):
         ("stillgotblues_lead", "perf_stillgot", 110, 170, 8192), ("ridingking_rhythm", "perf_riding", 0, 60, 8192),
         # other instruments (R/instruments.R): synthesized piano / harmonica takes
         ("wywh_piano", "perf_wywh_piano", 100, 160, None), ("allmylife_piano", "perf_allmylife_piano", 40, 100, None),
         ("sultans_harmonica", "perf_sultans_harp", 200, 260, None), ("getlucky_vocals_harmonica", "perf_getlucky_harp", 120, 180, None),
         ("stillgot_harmonica", "perf_stillgot_harp", 160, 220, None),
         # never used for tuning (held out):
         ("riding_piano", "perf_riding_piano", 0, 60, None), ("numb_harmonica", "perf_numb_harp", 300, 360, None)]
SEEDS = {"perf_getlucky": 11, "perf_allmylife": 23, "perf_stillgot": 31, "perf_riding": 37, "perf_wywh_piano": 41,
         "perf_allmylife_piano": 43, "perf_sultans_harp": 47, "perf_getlucky_harp": 53, "perf_stillgot_harp": 59,
         "perf_riding_piano": 61, "perf_numb_harp": 67}

EVAL = """async ({wav, truth, win, opts}) => {
  const c = harness.ctl(); c._stop();
  const J = new RSHighway.HitJudge(); J.setChart(c.chart); J.active = true; J.missDelay = 0.35;
  const judged = [];
  const ver = new RSHighway.NoteVerifier(J, (tc, ev) => { const r = J.judgeHit(tc, ev); if (r) judged.push(r); }, opts);
  const data = await (await fetch(wav)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 48000 * 63, 48000);
  const audio = await ctx.decodeAudioData(data);
  await ctx.audioWorklet.addModule(RSHighway.PITCH_WORKLET_URL);
  const node = new AudioWorkletNode(ctx, "rs-guitar-analyzer", { processorOptions: { window: win || RSHighway.analysisWindow(c.chart) } });
  const msgs = []; node.port.onmessage = (e) => msgs.push(e.data);
  const src = ctx.createBufferSource(); src.buffer = audio; src.connect(node).connect(ctx.destination); src.start();
  await ctx.startRendering();
  await new Promise((r) => setTimeout(r, 1500));                     // let queued port messages arrive
  msgs.sort((a, b) => a.t - b.t);
  let onsets = 0, frames = 0;
  const cost = [];
  for (const m of msgs) {
    const tc = truth.start + m.t;
    if (m.type === "onset") { ver.onOnset(tc, m.strength); onsets++; }
    else if (m.type === "frame") { J.tick(tc); const c0 = performance.now(); ver.onFrame(tc, m.mag, m.n, m.sr, m.rms, m.win); cost.push(performance.now() - c0); frames++; }
  }
  cost.sort((a, b) => a - b);
  const byNote = {}; for (const r of judged) for (const i of r.notes) byNote[i] = r;
  const ev = truth.events.map((e) => { const r = e.notes.map((i) => byNote[i]).find(Boolean);
    return { outcome: e.outcome, hit: !!r, err: r ? 1000 * (r.t - e.played) : null, chord: e.notes.length > 1 }; });
  return { ev, onsets, frames, msgs: msgs.length, costMean: cost.reduce((a, b) => a + b, 0) / cost.length,
           costP99: cost[Math.floor(0.99 * cost.length)], costMax: cost[cost.length - 1], over8: cost.filter((x) => x > 8).length };
}"""

LIVE = """async ({truth, seconds}) => {
  const c = harness.ctl(), wait = (ms) => new Promise((r) => setTimeout(r, ms));
  harness.message("settings", { settings: { inputSource: "microphone", inputLatencyMs: 0 } });
  const t0 = performance.now();
  while (!window.__inputs.some((x) => x.name === "hw_input_status") && performance.now() - t0 < 5000) await wait(50);
  const st = (window.__inputs.find((x) => x.name === "hw_input_status") || {}).value;
  if (!st || !st.ok) return { status: st || null };
  // 1. where is the capture file now? match raw onsets to the performance's known note times
  c._calib = { onsets: [] };
  await wait(4000);
  const raw = c._calib.onsets; c._calib = null;
  const rel = truth.events.filter((e) => e.outcome !== "omitted").map((e) => (e.played - truth.start) * 1000);
  const votes = new Map();
  for (const o of raw) for (const r of rel) { const k = Math.round((o - r) / 10); votes.set(k, (votes.get(k) || 0) + 1); }
  let best = [0, -1];
  for (const [k, v] of votes) { const s = v + (votes.get(k - 1) || 0) + (votes.get(k + 1) || 0); if (s > best[1]) best = [k, s]; }
  const fileStart = best[0] * 10;                                      // performance.now() of file time 0
  // 2. run the song clock in step with the file and score it live
  const chartNow = () => truth.start + (performance.now() - fileStart) / 1000;
  c.seek(chartNow()); await c.togglePlay();
  await wait(300);
  c.avOffset += c.chartTime(performance.now()) - chartNow();           // remove the seek/play latency
  const from = chartNow() + 0.5;
  c._calib = { onsets: [] };                                          // raw onsets during the run: capture-clock check
  await wait(seconds * 1000);
  const during = c._calib.onsets.map((o) => truth.start + (o - fileStart) / 1000); c._calib = null;
  const to = chartNow() - 1;
  const J = c.judge, ev = truth.events.filter((e) => e.time > from && e.time < to);
  const out = ev.map((e) => ({ outcome: e.outcome, hit: e.notes.some((i) => J.state[i] === 1) }));
  const level = document.querySelector(".rs-hw-meter");
  return { status: st, onsets: raw.length, votes: best[1], out, during, from, to, meter: level && level.style.display !== "none",
           devices: (window.__inputs.find((x) => x.name === "hw_devices") || {}).value };
}"""

async def live_microphone(p):
    """The real MicSource end to end: Chromium's fake capture device plays a synthesized
    performance as 'microphone' input; getUserMedia -> worklet -> verifier -> judge live."""
    print("live microphone (fake capture device playing perf_sultans.wav)")
    wav = os.path.join(FIX, "perf_sultans.wav")
    b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                      f"--use-file-for-fake-audio-capture={wav}%noloop", "--autoplay-policy=no-user-gesture-required"])
    # small viewport: headless software raster of a full-size highway can starve the (fake) capture
    # thread on a loaded host; the render loop still runs (the judge's misses come from it)
    pg = await b.new_page(viewport={"width": 480, "height": 270}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e) + " " + (e.stack or "")[:300]))
    await pg.goto(f"http://127.0.0.1:{PORT}/tests/frontend/harness.html?chart=sultans_lead")
    await pg.wait_for_function("() => window.__ready")
    truth = json.load(open(os.path.join(FIX, "perf_sultans.json")))
    r = await pg.evaluate(LIVE, {"truth": truth, "seconds": 25})
    await b.close()
    if not r.get("out"):
        print(f"  FAIL microphone did not start: {r.get('status')} {errs}")
        return False
    # Is the fake capture device real-time? (On an overloaded host it skips / stalls, which no
    # detector can follow.) Residual of each raw onset vs the nearest played note, early vs late.
    played = sorted(e["played"] for e in truth["events"] if e["outcome"] != "omitted")
    res = [(o, min((abs(o - x), o - x) for x in played)[1]) for o in r["during"]]
    near = [(o, d) for o, d in res if abs(d) < 0.08]
    half = (r["from"] + r["to"]) / 2
    early = statistics.median([d for o, d in near if o < half] or [0]); late = statistics.median([d for o, d in near if o >= half] or [0])
    realtime = len(near) >= 0.6 * max(1, len(res)) and abs(late - early) < 0.04
    good = [e for e in r["out"] if e["outcome"] == "correct"]; bad = [e for e in r["out"] if e["outcome"] != "correct"]
    recall = sum(e["hit"] for e in good) / max(1, len(good)); fa = sum(e["hit"] for e in bad) / max(1, len(bad))
    ok = recall >= 0.85 and fa <= 0.2 and r["meter"] and not errs and len(good) >= 20
    clock = f"capture clock: {100 * len(near) / max(1, len(res)):.0f}% of onsets on a played note, drift {1000 * (late - early):+.0f} ms"
    if not ok and realtime is False and not errs and r["meter"]:
        print(f"  SKIP live accuracy inconclusive: the fake capture device is not real-time on this host ({clock}); "
              f"measured {100 * recall:.0f}% / {100 * fa:.0f}%")
        return True
    print(f"  {'ok  ' if ok else 'FAIL'} {clock}; device '{r['status'].get('label')}', {len(r['devices']['devices'])} input(s); "
          f"{r['onsets']} onsets in 4 s ({r['votes']} aligned); live over {len(r['out'])} events: correct -> hit "
          f"{100 * recall:.0f}% ({len(good)}), wrong/omitted -> hit {100 * fa:.0f}% ({len(bad)}); meter shown {r['meter']} {errs or ''}")
    return ok

async def main():
    for chart, perf, t0, t1, _ in CASES:
        if not os.path.exists(os.path.join(FIX, perf + ".wav")):
                subprocess.run([sys.executable, os.path.join(ROOT, "tests", "reference", "synth_performance.py"),
                            os.path.join(FIX, chart + ".json"), str(t0), str(t1), os.path.join(FIX, perf + ".wav"),
                            os.path.join(FIX, perf + ".json"), str(SEEDS.get(perf, 7))], check=True)
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    live_only = "--live" in sys.argv
    only = next((a.split("=", 1)[1].split(",") for a in sys.argv[1:] if a.startswith("--only=")), None)
    args = [a for a in sys.argv[1:] if a != "--live" and not a.startswith("--only=")]
    opts = json.loads(args[0]) if args else {}
    ok = True
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for chart, perf, t0, t1, win in ([] if live_only else [c for c in CASES if not only or c[0] in only]):
            pg = await b.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(f"http://127.0.0.1:{PORT}/tests/frontend/harness.html?chart={chart}")
            await pg.wait_for_function("() => window.__ready")
            truth = json.load(open(os.path.join(FIX, perf + ".json")))
            r = await pg.evaluate(EVAL, {"wav": f"fixtures/{perf}.wav", "truth": truth, "win": win, "opts": opts})
            ev = r["ev"]
            good = [e for e in ev if e["outcome"] == "correct"]; bad = [e for e in ev if e["outcome"] != "correct"]
            recall = sum(e["hit"] for e in good) / len(good)
            false_acc = sum(e["hit"] for e in bad) / max(1, len(bad))
            chords = [e for e in good if e["chord"]]
            errs_ms = [e["err"] for e in good if e["hit"]]
            print(f"{chart:18s} {len(ev):3d} events | correct played -> hit: {100*recall:5.1f}% "
                  f"(chords {sum(e['hit'] for e in chords)}/{len(chords)}) | wrong/omitted -> hit: {100*false_acc:4.1f}% "
                  f"({sum(e['hit'] for e in bad)}/{len(bad)}) | timing error median {statistics.median(errs_ms):+.0f} ms "
                  f"(|err| p90 {sorted(map(abs, errs_ms))[int(.9*len(errs_ms))]:.0f}) | verifier {r['costMean']:.2f} ms/frame (p99 {r['costP99']:.1f}, max {r['costMax']:.1f}, {r['over8']} frames > 8 ms) {errs or ''}")
            ok &= recall >= 0.9 and false_acc <= 0.15 and not errs
            await pg.close()
        await b.close()
        if not only: ok &= await live_microphone(p)
    srv.shutdown()
    print("SCORING CHECKS PASSED" if ok else "SCORING CHECKS FAILED")
    sys.exit(0 if ok else 1)

asyncio.run(main())
