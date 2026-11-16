"""
Automated checks for the karaoke player (inst/karaoke/karaoke.js), in the
style of check_frontend.py. Needs Python 3 + playwright (chromium) + ffmpeg.

  python3 tests/frontend/check_karaoke.py

1. builds karaoke fixtures from songs/ (tests/reference/karaoke_ref.py) if missing
2. render smoke: 3 songs x 2 views, no JS errors, ready input
3. highlighting: at every syllable onset the right line is current and exactly
   that syllable is being wiped (all songs, every syllable); wipe progress;
   the focus line never moves backwards while time advances
4. intro / instrumental-break cue with countdown and count-in dots
5. A/V sync: clock vs audio.currentTime (1.0x, 0.8x), seek / pause, and end to
   end: the lyric time on screen at the instant each click (one per syllable
   onset) leaves the audio output (AudioWorklet tap)
6. quick-start clip -> full audio handover while playing; seek past the clip holds
7. transport + keys (Space, arrows, line click), keys ignored while hidden,
   settings (offset, view, text size, speed)
8. both players on one page (the app's two modes): keys reach only the visible
   one; the note highway survives being hidden (0 x 0) and shown again; real
   mouse clicks on the pause button always pause (press held 30-250 ms)
9. cost of a frame during playback
10. lyrics from LRC (songs without lyrics in the archive): parsing, syllables,
    per-syllable highlighting (estimated for line-timed LRC, exact for word tags),
    the browser's LRCLIB lookup (mocked) and automatic sync
11. the estimated syllable timing vs the songs' charted syllables (exact line times)
12. sync accuracy on the songs' real audio (when a Wwise decoder is installed):
    LRC lines made from the studio-timed lyrics, shifted and jittered like LRCLIB
"""
import asyncio, functools, http.server, os, statistics, subprocess, sys, threading
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "tests", "frontend", "fixtures")
PORT = 8798
SONGS = ["karaoke_sultans", "karaoke_keyhighway", "karaoke_ridingking"]

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

HIGHLIGHT = """() => {
  const c = harness.ctl(), S = c.song, K = RSKaraoke; c._stop();
  let total = 0, ok = 0, bad = [], pOk = 0, pTot = 0;
  S.lines.forEach((L, li) => L.words.forEach((W, wi) => {
    total++;
    const t = W.t + Math.min(0.01, W.d / 2);
    c.render(t);
    const line = c.lineEls[li], spans = c.sylEls[li];
    const now = spans.map((s, k) => s.classList.contains('is-now') ? k : -1).filter(k => k >= 0);
    const sung = spans.slice(0, wi).every(s => s.classList.contains('is-sung'));
    const rest = spans.slice(wi + 1).every(s => !s.classList.contains('is-now') && !s.classList.contains('is-sung'));
    const good = line.classList.contains('is-current') && now.length === 1 && now[0] === wi && sung && rest &&
                 document.querySelectorAll('#kk .rs-k-line.is-current').length === 1;
    if (good) ok++; else if (bad.length < 5) bad.push({li, wi, w: W.w, t, now, cls: line.className});
    if (W.d >= 0.2) {                       // wipe progress half-way through the syllable
      pTot++; c.render(W.t + W.d / 2);
      if (Math.abs(+spans[wi].style.getPropertyValue('--p') - 0.5) < 0.02) pOk++;
    }
  }));
  // the focus never moves backwards as time advances (10 ms grid over the whole song)
  let back = 0, last = -1;
  for (let t = 0; t < S.duration; t += 0.01) { const f = K.state(S, t).focus; if (f < last) back++; last = f; }
  return {total, ok, bad, pOk, pTot, back};
}"""

SAMPLE = """async (ms) => {
  const c = harness.ctl(), out = [];
  await new Promise(res => { const t0 = performance.now();
    (function f(ts) { out.push({ts, clock: c.clock.time(ts), media: c.deck.audio ? c.deck.audio.currentTime : null});
      if (ts - t0 < ms) requestAnimationFrame(f); else res(); })(performance.now()); });
  return out; }"""

E2E = """async (secs) => {
  const c = harness.ctl(), S = c.song;
  c.seek(15); await c.togglePlay();
  const ctx = c.deck.out.ctx;
  const code = `class Tap extends AudioWorkletProcessor { constructor() { super(); this.last = -1; }
    process(inputs) { const x = inputs[0] && inputs[0][0]; if (!x) return true;
      for (let k = 0; k < x.length; k++) if (Math.abs(x[k]) > 0.3) { const t = (currentFrame + k) / sampleRate;
        if (t - this.last > 0.04) this.port.postMessage(t); this.last = t; } return true; } }
    registerProcessor('ktap', Tap);`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], {type: 'text/javascript'})));
  const tap = new AudioWorkletNode(ctx, 'ktap'), sink = ctx.createGain(); sink.gain.value = 0;
  c.deck.audio._src.connect(tap); tap.connect(sink).connect(ctx.destination);
  const onsets = S.lines.flatMap(L => L.wordT), heard = [];
  tap.port.onmessage = (e) => { const ts = ctx.getOutputTimestamp();
    const perf = ts.performanceTime + (e.data - ts.contextTime) * 1000;
    const lt = c.lyricTime(perf), st = RSKaraoke.state(S, lt + 1 / 60);      // highlighted within one frame
    heard.push({lt, word: st.mode === 'sing' ? S.lines[st.focus].words[st.word] : null}); };
  await new Promise(r => setTimeout(r, secs * 1000)); c.pause();
  const nearest = (x) => onsets.reduce((a, b) => Math.abs(b - x) < Math.abs(a - x) ? b : a);
  const errs = heard.map(h => 1000 * (h.lt - nearest(h.lt)));
  const right = heard.filter(h => h.word && Math.abs(h.word.t - nearest(h.lt)) < 1e-6).length;
  return { errs, right, n: heard.length, lat: 1000 * c._lat, routed: !!c.deck.audio._gain };
}"""

# per-line LRC made from the charted lyrics (exact line times) -> estimated syllables vs the charted ones
SYLLABLE_EVAL = """() => {
  const c = harness.ctl(), K = RSKaraoke, truth = c.song.lines.map(L => {
    const words = []; let cur = null;
    for (const W of L.words) { if (!cur) { cur = {t: W.t, text: '', notes: []}; } cur.notes.push([cur.text.length, W.t]); cur.text += W.w; if (!W.j) { words.push(cur); cur = null; } }
    if (cur) words.push(cur);
    return {start: L.start, words}; });
  const ts = (x) => `[${String(Math.floor(x / 60)).padStart(2, '0')}:${(x % 60).toFixed(2).padStart(5, '0')}]`;
  const v = K.vocalsFromLRC(K.parseLRC(truth.map(L => ts(L.start) + L.words.map(w => w.text).join(' ')).join('\\n')));
  const out = {word: [], note: [], same: 0, near: 0, tot: 0};
  truth.forEach((L, k) => {
    const idx = v.l.map((l, i) => l === k ? i : -1).filter(i => i >= 0), wOn = [], chars = [];
    let first = true;
    for (const i of idx) { if (first) wOn.push(v.t[i]); first = !v.j[i]; }
    let w = -1; first = true;
    for (const i of idx) { if (first) { w++; chars[w] = []; } for (let q = 0; q < v.w[i].length; q++) chars[w].push(v.t[i] + v.d[i] * q / v.w[i].length); first = !v.j[i]; }
    L.words.forEach((W, wi) => { if (wOn[wi] == null) return; out.word.push(Math.abs(wOn[wi] - W.t));
      for (const [pos, t] of W.notes) if (chars[wi][pos] != null) out.note.push(Math.abs(chars[wi][pos] - t)); });
    const end = L.words[L.words.length - 1].t + 0.4;
    for (let t = L.start; t < end; t += 0.02) {
      const tw = L.words.filter(W => W.t <= t).length - 1, ew = wOn.filter(x => x <= t).length - 1;
      out.tot++; if (tw === ew) out.same++; if (Math.abs(tw - ew) <= 1) out.near++;
    }
  });
  return out; }"""

def real_audio_fixtures():
    """The songs' own audio (decoded like tools/karaoke_export_html.py does), if a Wwise decoder is installed."""
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    try:
        import karaoke_export_html as X
    except Exception:
        return
    for fname, tag in (("Dire-Straits_Sultans-of-Swing_v443_m.psarc", "sultans"), ("B_B_ King & Eric Clapton - Key to the Highway_m.psarc", "keyhighway"),
                       ("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "ridingking")):
        out, src = os.path.join(FIX, f"real_{tag}.ogg"), os.path.join(ROOT, "songs", fname)
        if os.path.exists(out) or not os.path.exists(src): continue
        try:
            path, how = X.song_audio(X.Song(src, online=False), "auto", None)
            import shutil; shutil.move(path, out); print(f"  (real audio fixture {tag}: {how})")
        except Exception as e:
            print(f"  (no real audio for {tag}: {e})"); return

def sync_stats(samples, rate):
    s = samples[5:]
    fresh = [s[i]["clock"] - s[i]["media"] for i in range(1, len(s)) if s[i]["media"] != s[i - 1]["media"]]
    adv = [(b["clock"] - a["clock"], (b["ts"] - a["ts"]) / 1000) for a, b in zip(s, s[1:])]
    return statistics.mean(fresh), max(map(abs, fresh)), sum(c < 0 for c, _ in adv)

async def main():
    if not all(os.path.exists(os.path.join(FIX, f)) for f in [s + ".json" for s in SONGS] + ["karaoke_clicks.ogg", "modes_sultans_lead.json"]):
        subprocess.run([sys.executable, os.path.join(ROOT, "tests", "reference", "karaoke_ref.py"), FIX], check=True)
    real_audio_fixtures()
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{PORT}/tests/frontend/karaoke_harness.html"

    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        async def page(q, vp=(1280, 720)):
            pg = await b.new_page(viewport={"width": vp[0], "height": vp[1]}); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(f"{base}?{q}"); await pg.wait_for_function("() => window.__ready")
            return pg, errs

        print("render smoke (both views)")
        for view in ("stage", "sheet"):
            for song in SONGS:
                pg, errs = await page(f"song={song}&view={view}&t=60")
                await pg.wait_for_timeout(300)
                r = await pg.evaluate("""() => { const c = harness.ctl(), ready = window.__inputs.find(i => i.name === 'kk_ready');
                  return { lines: c.lineEls.length, payload: c.song.lines.length, cur: document.querySelectorAll('#kk .rs-k-line.is-current, #kk .rs-k-line.is-next').length,
                           sheet: c.el.classList.contains('is-sheet'), ready: ready && ready.value, title: c.title.textContent, art: !c.art.classList.contains('is-empty') }; }""")
                check(not errs and r["lines"] == r["payload"] > 0 and r["cur"] == 1 and r["sheet"] == (view == "sheet") and r["ready"]
                      and r["ready"]["audio"] == "none" and "ogg" in r["ready"]["formats"] and r["art"],
                      f"{view:5s} {song}: {r['lines']} lines, title '{r['title']}', album art, ready sent {r['ready'] and r['ready']['formats']}, errors={errs}")
                await pg.close()

        print("highlighting: every syllable onset, wipe progress, focus monotonic")
        for song in SONGS:
            pg, errs = await page(f"song={song}")
            r = await pg.evaluate(HIGHLIGHT)
            check(r["ok"] == r["total"] and r["pOk"] == r["pTot"] and r["back"] == 0 and not errs,
                  f"{song}: {r['ok']}/{r['total']} syllables highlighted at their onset, wipe at 50% on {r['pOk']}/{r['pTot']}, "
                  f"focus steps back {r['back']}x {r['bad'] if r['bad'] else ''}")
            await pg.close()

        print("intro / instrumental cue")
        pg, errs = await page("song=karaoke_keyhighway")
        r = await pg.evaluate("""() => { const c = harness.ctl(), S = c.song; c._stop();
          const gap = S.lines.findIndex((L, k) => k > 0 && L.start - S.lines[k - 1].end > 8);
          const at = (t) => { c.render(t); return { on: c.cue.classList.contains('is-on'), text: c.cueText.textContent,
            dots: c.cueDots.querySelectorAll('i.is-on').length, next: c.lineEls[c._state.focus].className, focus: c._state.focus }; };
          return { intro: at(S.lines[0].start - 10), introDots: at(S.lines[0].start - 2.5), gap,
                   brk: at(S.lines[gap].start - 8), brkDots: at(S.lines[gap].start - 1.2), sing: at(S.lines[gap].start + 0.01) }; }""")
        check(r["intro"]["on"] and r["intro"]["text"].startswith("Intro") and r["introDots"]["dots"] == 3 and r["brk"]["on"]
              and r["brk"]["text"].startswith("Instrumental") and r["brk"]["focus"] == r["gap"] and "is-next" in r["brk"]["next"]
              and r["brkDots"]["dots"] == 2 and not r["sing"]["on"] and "is-current" in r["sing"]["next"] and not errs,
              f"intro '{r['intro']['text']}' -> {r['introDots']['dots']} count-in dots; break before line {r['gap']}: "
              f"'{r['brk']['text']}' (next line previewed) -> {r['brkDots']['dots']} dots -> cue hidden when singing")
        await pg.close()

        print("A/V sync (click track: one click per syllable onset)")
        pg, errs = await page("song=karaoke_sultans&audio=karaoke_clicks.ogg")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'")
        await pg.evaluate("async () => { const c = harness.ctl(); c.seek(20); await c.togglePlay(); }")
        await pg.wait_for_timeout(400)
        for rate in (1.0, 0.8):
            if rate != 1.0:
                await pg.evaluate(f"() => harness.message('settings', {{settings: {{playbackRate: {rate}}}}})")
                await pg.wait_for_timeout(400)
            mean, worst, backwards = sync_stats(await pg.evaluate(SAMPLE, 3000), rate)
            check(abs(mean) < 0.005 and worst < 0.05 and backwards == 0,
                  f"{rate:.2f}x: clock-audio mean {1000 * mean:+.1f} ms, worst {1000 * worst:.1f} ms, backwards steps {backwards}")
        await pg.evaluate("() => harness.message('settings', {settings: {playbackRate: 1}})")
        await pg.evaluate("() => harness.message('seek', {time: 50})"); await pg.wait_for_timeout(300)
        r = await pg.evaluate("() => { const c = harness.ctl(); return [c.clock.time(performance.now()), c.deck.audio.currentTime] }")
        check(abs(r[0] - r[1]) < 0.05 and r[0] > 50, f"seek while playing re-locks (clock {r[0]:.3f} vs audio {r[1]:.3f})")
        await pg.evaluate("() => harness.message('pause')"); await pg.wait_for_timeout(200)
        a = await pg.evaluate("() => harness.ctl().clock.time(performance.now())"); await pg.wait_for_timeout(400)
        check(a == await pg.evaluate("() => harness.ctl().clock.time(performance.now())"), "pause freezes the clock")
        await pg.close()

        print("end to end: lyric time on screen when each syllable's click is heard")
        pg, errs = await page("song=karaoke_sultans&audio=karaoke_clicks.ogg")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'")
        r = await pg.evaluate(E2E, 12)
        steady = r["errs"][2:]
        # criterion: within one 60 Hz frame. (The note highway's own E2E check measures the same
        # -15 ms on this headless Chromium: its reported output latency exceeds the measured path.)
        q = statistics.quantiles(steady, n=10)                     # p10 .. p90: robust to one late click
        check(r["routed"] and len(steady) > 15 and abs(statistics.median(steady)) < 17 and q[-1] - q[0] < 30
              and r["right"] >= 0.95 * r["n"],
              f"compensating {r['lat']:.0f} ms output latency; heard-vs-shown median {statistics.median(steady):+.1f} ms "
              f"(range {min(steady):+.0f}..{max(steady):+.0f} ms) over {len(steady)} clicks; "
              f"the heard syllable was highlighted within a frame for {r['right']}/{r['n']}")
        await pg.close()

        print("quick-start clip -> full audio")
        pg, errs = await page("song=karaoke_sultans")
        key = await pg.evaluate("() => harness.ctl().song.songKey")
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/karaoke_clicks_head.ogg', songKey: '{key}', kind: 'head', seconds: 30}})")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'head'")
        await pg.evaluate("async () => { harness.ctl().seek(16); await harness.ctl().togglePlay(); }")
        await pg.wait_for_timeout(1200)
        trace = asyncio.ensure_future(pg.evaluate("""(ms) => new Promise(res => { const c = harness.ctl(), out = []; const t0 = performance.now();
          (function f(ts) { out.push([ts, c.clock.time(ts), c.clock.playing, c.deck.kind]); if (ts - t0 < ms) requestAnimationFrame(f); else res(out); })(t0); })""", 4000))
        await pg.wait_for_timeout(200)
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/karaoke_clicks.ogg', songKey: '{key}', kind: 'full'}})")
        tr = await trace
        st = await pg.evaluate("() => { const c = harness.ctl(); return {kind: c.deck.kind, err: c.deck.handoverError} }")
        sw = next((k for k, (x, y) in enumerate(zip(tr, tr[1:])) if x[3] == "head" and y[3] == "full"), 0)
        near = tr[max(0, sw - 10): sw + 12]
        jump = max(abs((y[1] - x[1]) - (y[0] - x[0]) / 1000) for x, y in zip(near, near[1:])) * 1000
        check(st["kind"] == "full" and st["err"] is not None and abs(st["err"]) < 0.01 and all(x[2] for x in tr) and jump < 40 and not errs,
              f"handed over while playing: alignment {1000 * (st['err'] or 0):.1f} ms, largest clock step around the switch {jump:.1f} ms, never paused")
        await pg.close()
        pg, errs = await page("song=karaoke_sultans")
        key = await pg.evaluate("() => harness.ctl().song.songKey")
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/karaoke_clicks_head.ogg', songKey: '{key}', kind: 'head', seconds: 30}})")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'head'")
        await pg.evaluate("async () => { const c = harness.ctl(); await c.togglePlay(); c.seek(50); }"); await pg.wait_for_timeout(400)
        hd = await pg.evaluate("() => { const c = harness.ctl(); return {t: c.clock.time(performance.now()), holding: c.clock.holding, banner: c.banner.textContent} }")
        await pg.evaluate(f"() => harness.message('audio', {{url: 'fixtures/karaoke_clicks.ogg', songKey: '{key}', kind: 'full'}})")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'"); await pg.wait_for_timeout(600)
        r = await pg.evaluate("() => { const c = harness.ctl(); return {t: c.clock.time(performance.now()), playing: c.clock.playing} }")
        check(hd["holding"] and abs(hd["t"] - 50) < 0.01 and "Loading" in hd["banner"] and r["playing"] and 50 < r["t"] < 51.5,
              f"seek past the clip holds at {hd['t']:.2f} s ('{hd['banner']}'), resumes there when the full audio arrives ({r['t']:.2f} s)")
        stale = await pg.evaluate("async () => harness.ctl().setAudio('fixtures/karaoke_clicks.ogg', 'someothersong', 'full')")
        check(stale is False, "audio for another song is ignored")
        await pg.close()

        print("transport, keys, settings")
        pg, errs = await page("song=karaoke_sultans&audio=karaoke_clicks.ogg")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'")
        r = await pg.evaluate("""async () => { const c = harness.ctl(), S = c.song, wait = (ms) => new Promise(r => setTimeout(r, ms));
          const key = (code) => document.dispatchEvent(new KeyboardEvent('keydown', {code, bubbles: true}));
          const now = () => c.clock.time(performance.now()), lyr = () => c.lyricTime(performance.now()), out = {};
          const at = () => { const t = lyr(); let b = 0; S.lines.forEach((L, k) => { if (Math.abs(L.start - 1.5 - t) < Math.abs(S.lines[b].start - 1.5 - t)) b = k; }); return b; };
          const seekLyr = (x) => c.seek(x + c.offset + c._lat);
          seekLyr(S.lines[3].start + 0.2); await wait(50); key('ArrowDown'); await wait(50);
          out.down = lyr() - S.lines[4].start;                          // line 4 with a 1.5 s run-up
          const seq = [];
          for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp']) { key(k); await wait(40); seq.push(at()); }
          out.seq = seq.join(',');                                      // 5, 6, 7, 6, 5 (repeated presses never stick)
          seekLyr(S.lines[8].start + 2.0); await wait(50); key('ArrowUp'); await wait(40); out.restart = at();   // restarts line 8
          seekLyr(S.lines[8].start + 0.3); await wait(50); key('ArrowUp'); await wait(40); out.prevEarly = at(); // just began: line 7
          seekLyr(S.lines[0].start - 8); await wait(50); key('ArrowDown'); await wait(40); out.intro = at();    // intro: first line
          seekLyr(S.lines[3].start + 0.2); await wait(50); key('ArrowDown'); await wait(50);
          key('ArrowUp'); await wait(50); out.up = lyr() - S.lines[3].start;
          key('Space'); await wait(300); out.playing = c.clock.playing; key('Space'); await wait(50); out.paused = !c.clock.playing;
          c.lineEls[10].click(); await wait(50); out.click = lyr() - S.lines[10].start;
          key('Home'); await wait(50); out.home = now();
          c.el.style.display = 'none'; await wait(100); key('Space'); await wait(100); out.hiddenPlaying = c.clock.playing;
          c.el.style.display = ''; await wait(100);
          harness.message('settings', {settings: {offsetMs: 200}}); c.seek(30); await wait(50);
          out.offset = lyr() - now() + c._lat;
          harness.message('settings', {settings: {offsetMs: 0, view: 'sheet', textScale: 0.8}}); await wait(100);
          out.sheet = c.el.classList.contains('is-sheet'); out.scale = getComputedStyle(c.el).getPropertyValue('--rs-k-scale').trim();
          harness.message('settings', {settings: {playbackRate: 0.75}}); await wait(50); out.rate = c.clock.rate; out.badge = c.rateBadge.textContent;
          return out; }""")
        check(abs(r["down"] + 1.5) < 0.05 and abs(r["up"] + 1.5) < 0.05 and r["seq"] == "5,6,7,6,5" and r["restart"] == 8
              and r["prevEarly"] == 7 and r["intro"] == 0 and r["playing"] and r["paused"] and abs(r["click"] + 1.5) < 0.05
              and r["home"] == 0 and not r["hiddenPlaying"] and abs(r["offset"] + 0.2) < 0.002 and r["sheet"] and r["scale"] == "0.8"
              and r["rate"] == 0.75 and r["badge"] == "75%" and not errs,
              f"down/up/line-click seek to the line with a 1.5 s run-up (repeated presses step on; up restarts a line under way); Space plays/pauses; ignored while hidden; offset, sheet view, text size, speed: {r}")
        await pg.close()

        print("two modes on one page (Instrument | Karaoke)")
        pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"http://127.0.0.1:{PORT}/tests/frontend/modes_harness.html"); await pg.wait_for_function("() => window.__ready")
        r = await pg.evaluate("""async () => { const wait = (ms) => new Promise(r => setTimeout(r, ms)), H = modes.hw(), Kp = modes.kk();
          const key = (code) => document.dispatchEvent(new KeyboardEvent('keydown', {code, bubbles: true}));
          const out = {};
          H.seek(100); await wait(100);
          key('Space'); await wait(150); out.instrument = {hw: H.clock.playing, kk: Kp.clock.playing};
          H.clock.pause();
          modes.show('karaoke'); await wait(200);
          key('Space'); await wait(150); out.karaoke = {hw: H.clock.playing, kk: Kp.clock.playing};
          Kp.pause();
          // the hidden highway does not draw (its loop skips a 0 x 0 element) -- even when asked to play
          let draws = 0; const draw = H.renderer.draw.bind(H.renderer); H.renderer.draw = (t, dt) => { draws++; draw(t, dt); };
          H.clock.play(); await wait(500); H.clock.pause(); out.hiddenDraws = draws;
          // a renderer drawn at 0 x 0 anyway must come back with a finite camera
          for (let i = 0; i < 30; i++) draw(100 + i / 60, 1 / 60);
          modes.show('instrument'); await wait(300); out.shownDraws = draws;
          H.seek(203); await wait(200);                    // (a busy moment of the lead part)
          const cam = H.renderer.cam || {};
          out.camFinite = Object.values(cam).filter(v => typeof v === 'number').every(Number.isFinite);
          out.notesDrawn = H.renderer.stats.notesDrawn;
          modes.show('karaoke'); await wait(300);
          out.kkLines = Kp._pos && Kp._pos.every(Number.isFinite) && Kp._vpH > 0;
          return out; }""")
        check(r["instrument"] == {"hw": True, "kk": False} and r["karaoke"] == {"hw": False, "kk": True} and r["camFinite"]
              and r["notesDrawn"] > 0 and r["kkLines"] and r["hiddenDraws"] == 0 and r["shownDraws"] > 0 and not errs,
              f"Space in instrument mode -> highway only {r['instrument']}; in karaoke mode -> karaoke only {r['karaoke']}; "
              f"hidden highway: {r['hiddenDraws']} draws in 0.5 s of playback; shown again: drawing, camera finite, {r['notesDrawn']} gems; errors={errs}")
        await pg.close()

        print("pause button: real mouse clicks (press held 30 / 120 / 250 ms) while playing")
        pg = await b.new_page(viewport={"width": 1280, "height": 720}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"http://127.0.0.1:{PORT}/tests/frontend/modes_harness.html"); await pg.wait_for_function("() => window.__ready")
        await pg.evaluate("() => { modes.hw().setAudio('fixtures/karaoke_clicks.ogg', null, 'full'); modes.kk().setAudio('fixtures/karaoke_clicks.ogg', modes.kk().song.songKey, 'full'); }")
        await pg.wait_for_function("() => modes.hw().audioKind === 'full' && modes.kk().deck.kind === 'full'")
        res = {}
        for mode, ctl, sel in (("instrument", "modes.hw()", "#hw .rs-hw-btn-play"), ("karaoke", "modes.kk()", "#kk .rs-k-btn-play")):
            await pg.evaluate(f"() => modes.show('{mode}')"); await pg.wait_for_timeout(300)
            ok = n = 0
            for hold in (30, 120, 250) * 4:
                await pg.evaluate(f"async () => {{ const c = {ctl}; if (!c.clock.playing) await c.togglePlay(); }}")
                await pg.wait_for_timeout(350)
                box = await pg.locator(sel).bounding_box()
                await pg.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)   # on the icon
                await pg.mouse.down(); await pg.wait_for_timeout(hold); await pg.mouse.up(); await pg.wait_for_timeout(200)
                n += 1
                if not await pg.evaluate(f"() => {ctl}.clock.playing"): ok += 1
                else: await pg.evaluate(f"async () => {{ const c = {ctl}; if (c.clock.playing) await c.togglePlay(); }}")
            res[mode] = (ok, n)
        check(all(ok == n for ok, n in res.values()) and not errs,
              f"clicks that paused: highway {res['instrument'][0]}/{res['instrument'][1]}, karaoke {res['karaoke'][0]}/{res['karaoke'][1]} "
              "(the highway used to redraw its play icon every 100 ms, and a click spanning a redraw was dropped)")
        await pg.close()

        print("lyrics from LRC: per-syllable highlighting, LRCLIB lookup in the browser (mocked), automatic sync")
        pg, errs = await page("song=karaoke_sultans&audio=karaoke_clicks.ogg")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'")
        calls = []
        async def lrclib(route):
            calls.append(route.request.url)
            await route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                                body='[{"id": 7, "trackName": "Sultans of Swing", "artistName": "Dire Straits", "duration": 346, "instrumental": false,'
                                     ' "plainLyrics": "x", "syncedLyrics": "[00:16.16]You get a shiver in the dark\\n[00:17.97]It\'s raining in the park but meantime\\n[00:23.30]South of the river"}]')
        await pg.route("https://lrclib.net/**", lrclib)
        r = await pg.evaluate("""async () => { const c = harness.ctl(), K = RSKaraoke, n0 = window.__inputs.length;
          const p = JSON.parse(JSON.stringify(c._payload));
          p.vocals = {t: [], d: [], w: [], j: [], l: []};
          p.lyrics = {source: 'lookup', align: true, lookup: {artist: 'Dire Straits', title: 'Sultans of Swing (Live)', album: '', duration: 346}};
          c.load({song: p});
          await new Promise(res => { const iv = setInterval(() => { if (window.__inputs.slice(n0).some(i => i.name === 'kk_aligned')) { clearInterval(iv); res(); } }, 50); });
          const found = window.__inputs.slice(n0).find(i => i.name === 'kk_lyrics'), al = window.__inputs.slice(n0).find(i => i.name === 'kk_aligned');
          c._stop(); const L = c.song.lines[1]; c.render(L.start + 0.2);
          const spans = c.sylEls[1], lit = spans.filter(x => /is-sung|is-now/.test(x.className)).length;
          c.render(L.end - 0.01); const litEnd = spans.filter(x => /is-sung|is-now/.test(x.className)).length;
          const badge = getComputedStyle(c.estBadge).display !== 'none' && c.el.classList.contains('is-estimated');
          const P = K.parseLRC('[offset:+250]\\n[00:10.00][00:40.00]Two <00:10.60>everything\\n[00:12.00]');
          const V = K.vocalsFromLRC(P);
          return { lines: c.song.lines.length, estimated: c.song.estimated, lit, litEnd, syl: spans.length, text: L.text, badge,
                   found: !!found, aligned: al && al.value, v: [V.t, V.w, V.j],
                   parse: P.lines.map(x => [x.t, x.text, x.words && x.words.map(w => w.t)]), synced: P.synced,
                   syl2: ['everything', 'table', 'going', 'Mississippi', 'strictly', 'time'].map(w => K.syllabify(w).join('|')) }; }""")
        check(r["found"] and r["lines"] == 3 and r["estimated"] and r["badge"] and r["lit"] == 1 and r["litEnd"] == r["syl"] and r["syl"] > 8
              and r["text"] == "It's raining in the park but meantime" and r["aligned"] and r["aligned"]["offsetMs"] == 0
              and len(calls) >= 1 and not errs,
              f"looked up ({len(calls)} request(s), '(Live)' dropped), 3 lines, highlighted per syllable: {r['lit']} of {r['syl']} syllables lit "
              f"0.2 s into the line, all by its end, text intact, '\u2248 syllables' badge shown; "
              f"3 lines: left in place ({r['aligned'] and r['aligned']['offsetMs']} ms, too few to sync)")
        check(r["parse"] == [[9.75, "Two everything", [None, 10.35]], [11.75, "", None], [39.75, "Two everything", [None, 40.35]]] and r["synced"] == "word"
              and r["v"][1][:5] == ["Two", "e", "ve", "ry", "thing"] and r["v"][2][:5] == [0, 1, 1, 1, 0] and r["v"][0][:2] == [9.75, 10.35]
              and r["syl2"] == ["e|ve|ry|thing", "ta|ble", "go|ing", "Mis|sis|sip|pi", "strict|ly", "time"],
              f"LRC parser: [offset:], repeated lines, word tags (enhanced LRC: words at their own times, {r['v'][0][:5]}); syllables {r['syl2']}")
        await pg.close()

        print("syllable timing of lyrics timed per line (estimated) vs the songs' charted syllables")
        rows = []
        for t in ("sultans", "keyhighway", "ridingking"):
            pg, errs = await page(f"song=karaoke_{t}")
            rows.append(await pg.evaluate(SYLLABLE_EVAL))
            await pg.close()
        med = lambda xs: sorted(xs)[len(xs) // 2]
        we = [x for r in rows for x in r["word"]]; ne = [x for r in rows for x in r["note"]]
        same = sum(r["same"] for r in rows) / sum(r["tot"] for r in rows); near = sum(r["near"] for r in rows) / sum(r["tot"] for r in rows)
        check(med(we) < 0.25 and near > 0.7,
              f"exact line times: word onsets median error {1000 * med(we):.0f} ms ({100 * sum(x < 0.15 for x in we) / len(we):.0f}% within 150 ms), "
              f"charted syllable onsets {1000 * med(ne):.0f} ms; the sung word is highlighted {100 * same:.0f}% of the sung time, "
              f"the sung word or a neighbour {100 * near:.0f}%")

        real = [t for t in ("sultans", "keyhighway", "ridingking") if os.path.exists(os.path.join(FIX, f"real_{t}.ogg"))]
        print("sync accuracy on the songs' real audio" + ("" if real else " -- skipped (no Wwise decoder: pip install wem2ogg)"))
        if real:
            import random
            rnd = random.Random(8); rows = []
            for t in real:
                pg, errs = await page(f"song=karaoke_{t}&audio=real_{t}.ogg")
                await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'", timeout=60000)
                truth = await pg.evaluate("() => harness.ctl().song.lines.map(L => ({t: L.start, text: L.words.map(W => W.w).join('')}))")
                words = await pg.evaluate("() => harness.ctl().song.lines.map(L => { let out = [], cur = ''; L.words.forEach(W => { cur += W.w; if (!W.j) { out.push(cur); cur = ''; } }); if (cur) out.push(cur); return out.join(' '); })")
                for shift in (0.0, 1.5, -1.0):
                    lrc = "\n".join(f"[{int(max(0, x['t'] + shift + j) // 60):02d}:{max(0, x['t'] + shift + j) % 60:05.2f}]{w}"
                                    for x, w, j in zip(truth, words, [max(-0.4, min(0.4, rnd.gauss(0, 0.15))) for _ in truth]))
                    a = await pg.evaluate("""async (lrc) => { const c = harness.ctl(), n0 = window.__inputs.length; c.setLyrics({lrc});
                      await new Promise(res => { const iv = setInterval(() => { if (window.__inputs.slice(n0).some(i => i.name === 'kk_aligned')) { clearInterval(iv); res(); } }, 50); });
                      return { offset: window.__inputs.slice(n0).find(i => i.name === 'kk_aligned').value.offsetMs / 1000, starts: c.song.lines.map(L => L.start) }; }""", lrc)
                    line_err = statistics.median(abs(x - y["t"]) for x, y in zip(a["starts"], truth))
                    rows.append((t, shift, abs(a["offset"] + shift), line_err))
                await pg.close()
            errs_ = [e for *_, e, _ in rows]; kept = [e < 0.15 for _, sh, e, _ in rows if sh == 0]
            check(statistics.median(errs_) < 0.25 and sum(e < 0.3 for e in errs_) >= 0.7 * len(errs_) and sum(kept) >= len(kept) - 1,
                  f"offset error median {1000 * statistics.median(errs_):.0f} ms, within 300 ms {sum(e < 0.3 for e in errs_)}/{len(errs_)}; "
                  f"lyrics already in sync kept {sum(kept)}/{len(kept)}; line starts after sync: median {1000 * statistics.median(r[3] for r in rows):.0f} ms "
                  f"({', '.join(f'{t} {sh:+.1f} s -> {1000 * e:.0f} ms' for t, sh, e, _ in rows)})")

        print("frame cost during playback (headless software raster)")
        pg, errs = await page("song=karaoke_ridingking&audio=karaoke_clicks.ogg")
        await pg.wait_for_function("() => harness.ctl().deck.kind === 'full'")
        r = await pg.evaluate("""async () => { const c = harness.ctl(); c.seek(20); await c.togglePlay();
          const js = [], gaps = []; let last = 0; const orig = c.render.bind(c);
          c.render = (t) => { const t0 = performance.now(); orig(t); js.push(performance.now() - t0); };
          await new Promise(res => { const t0 = performance.now(); (function f(ts) { if (last) gaps.push(ts - last); last = ts;
            if (ts - t0 < 5000) requestAnimationFrame(f); else res(); })(t0); });
          c.pause(); const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * a.length)];
          return { p50: q(js, 0.5), p95: q(js, 0.95), fps: 1000 / (gaps.reduce((a, b) => a + b) / gaps.length), jank: gaps.filter(g => g > 25).length / gaps.length }; }""")
        # pass/fail on the player's own JS cost; fps depends on the machine (headless = software raster,
        # where compositing the lyrics' fade mask dominates; with a GPU it is negligible)
        check(r["p95"] < 4, f"render() p50 {r['p50']:.2f} ms, p95 {r['p95']:.2f} ms per frame")
        print(f"  info {r['fps']:.0f} fps, {100 * r['jank']:.1f}% frames > 25 ms (software raster)")
        await pg.close()
        await b.close()
    srv.shutdown()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

asyncio.run(main())
