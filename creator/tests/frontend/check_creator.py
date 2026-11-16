"""
End-to-end checks of RockShiny Creator in a real browser (headless Chromium):

  A. the offline page (creator_build_html(), opened from file://, every network
     request blocked): open a .psarc, edit notes with the mouse and the keyboard,
     undo / redo, lyrics (paste + auto-sync), stems, beat detection, a new song
     from an audio file, save and re-open, the package check
  B. the standalone Shiny app (shiny::runApp("creator")): the library, save to the
     library (checked by RockShiny's readers), download, a new song from an upload,
     stems saved on the server
  C. the Creator inside RockShiny (app.R): the page in the navbar, "Play it" opens
     the saved song in the Instrument mode; options(rockshiny.creator = FALSE)
  D. difficulty levels (the offline page): show and edit one level, an easier copy
     by hand, levels built automatically, undo, PageUp / PageDown, save modes; the
     saved package passes RockShiny's checks at every difficulty

  E. help and the guided tour: the Help dialog (what it can and can't do),
     summoned from the empty studio, the header, the ? key and the toolbar; the
     tour's steps on the page's own parts

  F. by ear (the offline page): the demo song, the voice under the lyrics, lyrics
     synced line by line, chord and bass drafts from the recording, and the tuner
     (a fake microphone playing notes and strums) writing into a chart

  python3 creator/tests/frontend/check_creator.py [A B C D E F]

Needs Python 3 + playwright (chromium), R with shiny/bslib, ffmpeg, node. Uses the
sample songs in RockShiny's songs/ when they are there, else the demo song the engine
makes from scratch (the creator/ folder on its own); C needs RockShiny itself.
"""
import asyncio, base64, os, shutil, socket, subprocess, sys, tempfile, time
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CREATOR = os.path.abspath(os.path.join(HERE, "..", ".."))
ROOT = os.path.abspath(os.path.join(CREATOR, ".."))
SONGS = os.path.join(ROOT, "songs")
RSCRIPT = shutil.which("Rscript") or "Rscript"
TMP = tempfile.mkdtemp(prefix="rsc-fe-")
failures = []

def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def rscript(code, **kw):
    return subprocess.run([RSCRIPT, "-e", code], cwd=kw.get("cwd", ROOT), capture_output=True, text=True, timeout=kw.get("timeout", 300))

def start_app(code, cwd):
    port = free_port()
    p = subprocess.Popen([RSCRIPT, "-e", code.replace("PORT", str(port))], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for _ in range(120):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close(); break
        except OSError: time.sleep(0.5)
    return p, "http://127.0.0.1:%d" % port

NODE = shutil.which("node") or "node"
_demo = {}
def song(name, kind="plain"):
    """A sample song from songs/, or the demo song standing in for it (made once by the engine)."""
    f = os.path.join(SONGS, name)
    if os.path.exists(f): return f
    if kind not in _demo:
        out = os.path.join(TMP, "RockShiny-Demo_Night-Drive_v1%s_m.psarc" % ("_DD" if kind == "dd" else ""))
        cli = os.path.join(CREATOR, "tests", "js", "cli.js")
        if kind == "dd": subprocess.run([NODE, cli, "dd-auto", song(name, "plain"), out, "2"], check=True, capture_output=True)
        else: subprocess.run([NODE, cli, "demo", out, "mac"], check=True, capture_output=True)
        _demo[kind] = out
    return _demo[kind]
def is_demo(path): return os.path.basename(path).startswith("RockShiny-Demo")

def make_wav(path, secs=14):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=110:duration=%d" % secs, "-f", "lavfi", "-i",
                    "aevalsrc=0.4*sin(2*PI*220*t)*exp(-8*mod(t\\,0.5)):d=%d" % secs, "-filter_complex", "[0][1]amerge=inputs=2,volume=0.5",
                    "-ar", "44100", path], check=True)

async def page_with_log(browser, **kw):
    pg = await browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1, accept_downloads=True, **kw)
    pg.errors = []
    pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    pg.on("pageerror", lambda e: pg.errors.append("PAGEERROR " + str(e)))
    return pg

STUDIO_PAGE = "creator"
LINES = """(() => { const S = %s.project.vocals ? %s.project.vocals.syllables : []; return S.filter((s, i, a) => i === 0 || /\\+$/.test(a[i - 1].lyric)).map(s => s.time); })()"""

# ---------------------------------------------------------------------------------------------
async def part_a(browser):
    print("A. the offline page")
    html = os.path.join(TMP, "RockShinyCreator.html")
    r = rscript('setwd("%s"); source("global.R"); creator_build_html("%s")' % (CREATOR, html), cwd=CREATOR)
    check(os.path.exists(html), "creator_build_html() wrote the page (%s)" % r.stderr.strip()[-200:])
    pg = await page_with_log(browser)
    requests = []
    async def block(route):
        if route.request.url.startswith("file://"): await route.continue_()
        else: requests.append(route.request.url); await route.abort()
    await pg.route("**/*", block)
    await pg.goto("file://" + html); await pg.wait_for_timeout(500)
    check(await pg.evaluate("!!window.creator && document.querySelector('.rsc-studio.is-empty') !== null"), "the empty studio is up")
    sng = song("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "dd")
    await pg.set_input_files('[data-role="file"]', sng)
    await pg.wait_for_function("creator.project && creator.audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=180000)
    info = await pg.evaluate("({t: creator.project.meta.title, n: creator.project.arrangements.length, d: creator.audio.duration, lyr: creator.project.vocals.syllables.length})")
    want = ("Night Drive", 3, 30, 50) if is_demo(sng) else ("Riding With The King", 2, 250, 200)
    check(info["t"] == want[0] and info["n"] == want[1] and info["d"] > want[2] and info["lyr"] > want[3], "opened from disk with its audio decoded in the page: %s" % info)
    # notes: click, type a fret, a technique, draw, undo / redo
    T0 = await pg.evaluate("(() => { const N = creator.project.arrangements[0].doc.levels[0].notes; return N[Math.floor(N.length * 0.4)].time; })()")
    await pg.evaluate("creator.view.pps = 110; creator.view.t0 = %f; creator.clampView(); creator.drawNow()" % (T0 - 1.5))
    pos = await pg.evaluate("""(T0) => { const st = creator, lane = st.lanes.find(l => l.id === 'arr:0'), n = st.project.arrangements[0].doc.levels[0].notes.find(x => x.time >= T0 - 0.001);
      const r = st.wrap.getBoundingClientRect(); return {x: r.left + st.x(n.time) + 6, y: r.top + lane.y + 20 + (lane.strings - 1 - n.string) * 15 + 7}; }""", T0)
    await pg.mouse.click(pos["x"], pos["y"])
    check(await pg.evaluate("creator.sel.kind === 'note' && creator.sel.items.length === 1"), "a click selects a note")
    await pg.keyboard.press("1"); await pg.keyboard.press("2"); await pg.keyboard.press("v")
    check(await pg.evaluate("creator.sel.items[0].fret === 12 && creator.sel.items[0].vibrato > 0"), "typing 1 2 sets fret 12, V adds vibrato")
    await pg.click('[data-tool="draw"]')
    n0 = await pg.evaluate("creator.project.arrangements[0].doc.levels[0].notes.length")
    pt = await pg.evaluate("""(T0) => { const st = creator, lane = st.lanes.find(l => l.id === 'arr:0'), r = st.wrap.getBoundingClientRect(); return {x: r.left + st.x(T0 + 0.7), y: r.top + lane.y + 20 + (lane.strings - 1 - 0) * 15 + 7}; }""", T0)
    await pg.mouse.click(pt["x"], pt["y"])
    n1 = await pg.evaluate("creator.project.arrangements[0].doc.levels[0].notes.length")
    await pg.keyboard.press("Control+z"); n2 = await pg.evaluate("creator.project.arrangements[0].doc.levels[0].notes.length")
    await pg.keyboard.press("Control+Shift+z"); n3 = await pg.evaluate("creator.project.arrangements[0].doc.levels[0].notes.length")
    check((n1, n2, n3) == (n0 + 1, n0, n0 + 1), "draw adds a note, undo / redo (%d %d %d %d)" % (n0, n1, n2, n3))
    await pg.click('[data-tool="select"]')
    # lyrics: paste an LRC of this song timed 1.5 s late, auto-sync
    truth = await pg.evaluate(LINES % (STUDIO_PAGE, STUDIO_PAGE))
    lrc = await pg.evaluate("""() => { const S = creator.project.vocals.syllables, L = []; let cur = null;
      for (const s of S) { if (!cur) { cur = {t: s.time, w: ''}; L.push(cur); } cur.w += s.lyric.replace(/[+-]$/, '') + (/-$/.test(s.lyric) ? '' : ' '); if (/\\+$/.test(s.lyric)) cur = null; }
      const f = (t) => { t += 1.5; const m = Math.floor(t / 60); return '[' + String(m).padStart(2, '0') + ':' + (t - 60 * m).toFixed(2).padStart(5, '0') + ']'; };
      return L.map(l => f(l.t) + l.w.trim()).join('\\n'); }""")
    await pg.click('[data-tab="lyrics"]'); await pg.fill('[data-role="paste"]', lrc); await pg.click('[data-act="lyr:paste"]')
    await pg.click('[data-act="lyr:auto"]')
    await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on')", timeout=120000)
    after = await pg.evaluate(LINES % (STUDIO_PAGE, STUDIO_PAGE))
    errs = sorted(abs(a - b) for a, b in zip(after, truth))
    check(len(after) == len(truth) and errs[len(errs) // 2] < 0.3, "lyrics 1.5 s late, auto-synced: median line error %.3f s" % errs[len(errs) // 2])
    # save, re-open
    size = await pg.evaluate("creator.save({platform: 'pc'}).then(b => { window._saved = b; return b.length; })")
    back = await pg.evaluate("RSCreator.engine.projectFromPsarc(window._saved).then(r => ({p: r.project.platform, n: r.project.arrangements[0].doc.levels[0].notes.length, lines: r.project.vocals.syllables.length}))")
    check(size > 1e6 and back["p"] == "pc" and back["n"] == n0 + 1, "saved for PC (%.1f MB) and re-opened: %s" % (size / 1e6, back))
    # a new song from an audio file: beats, charts, stems, save + check
    wav = os.path.join(TMP, "Test Band - Test Tune.wav"); make_wav(wav)
    pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await pg.set_input_files('[data-role="file"]', wav); await pg.wait_for_timeout(300)
    check(await pg.input_value('[data-role="n-title"]') == "Test Tune" and await pg.input_value('[data-role="n-artist"]') == "Test Band", "dropped audio: title and artist guessed from the file name")
    await pg.click('[data-p="pc"]')
    await pg.click('[data-role="create"]')
    await pg.wait_for_function("creator.project && creator.project.meta.title === 'Test Tune' && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
    new = await pg.evaluate("({charts: creator.project.arrangements.map(a => a.name), beats: creator.project.beats.length, bpm: RSCreator.engine.averageTempo(creator.project.beats)})")
    check(new["charts"] == ["Lead", "Bass"] and new["beats"] > 10, "a new song: %s" % new)
    await pg.click('[data-tab="stems"]'); await pg.click('[data-act="stems:run"]')
    await pg.wait_for_function("creator.audio.stems && !document.querySelector('.rsc-busy.is-on')", timeout=180000)
    check(await pg.evaluate("creator.audio.stems.ids.length >= 4 && creator.lanes.filter(l => l.stem).length >= 4"), "stems separated in the page and shown as lanes")
    check(await pg.evaluate("creator.audio.setLane('vocals', {mute: true}), creator.audio.plan().length === 2"), "muting a stem plays the mix minus that stem (2 sources)")
    await pg.click('[data-role="check"]'); await pg.wait_for_function("document.querySelector('[data-role=report]').textContent.length > 5", timeout=60000)
    check("Package OK" in await pg.inner_text('[data-role="report"]'), "the new song's package checks out")
    async with pg.expect_download() as d:
        await pg.click('[data-role="save"]')
    dl = await d.value; dest = os.path.join(TMP, dl.suggested_filename); await dl.save_as(dest)
    check(dl.suggested_filename == "Test-Band_Test-Tune_v1_p.psarc" and os.path.getsize(dest) > 1e6, "downloaded %s" % dl.suggested_filename)
    r = rscript('setwd("%s"); source("global.R"); v <- creator_validate("%s"); cat(v$ok, paste(v$lines, collapse = " | "))' % (CREATOR, dest), cwd=CREATOR)
    check(r.stdout.startswith("TRUE"), "RockShiny's readers accept it: " + r.stdout.strip()[:160])
    check(not requests, "no network request (%d blocked)" % len(requests))
    check(not pg.errors, "no console errors %s" % pg.errors[:3])
    await pg.close()

# ---------------------------------------------------------------------------------------------
async def part_b(browser):
    print("B. the standalone Shiny app")
    lib = os.path.join(TMP, "lib-b"); os.makedirs(lib, exist_ok=True)
    src = song("Daft-Punk_Derezzed_v1_m.psarc"); shutil.copy(src, lib)
    title = "Night Drive" if is_demo(src) else "Derezzed"
    saved_as = os.path.basename(src).replace("_m.psarc", "-2_m.psarc")
    app, url = start_app('options(rockshiny.cache_dir="%s", rockshiny.prewarm=FALSE, rockshiny.lyrics_online=FALSE, rockshiny.library_dir="%s", '
                         'rockshiny.uploads_dir="%s"); shiny::runApp(".", port=PORT, launch.browser=FALSE)' % (os.path.join(TMP, "cache"), lib, os.path.join(TMP, "up-b")), CREATOR)
    try:
        pg = await page_with_log(browser)
        S = "[...RSCreator.shinyStudios.values()][0]"
        await pg.goto(url); await pg.wait_for_timeout(3000)
        await pg.click("#creator-project-library + .selectize-control .selectize-input")
        await pg.keyboard.type(title); await pg.wait_for_timeout(300); await pg.keyboard.press("Enter")
        await pg.wait_for_function(S + ".project && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
        check(await pg.evaluate(S + ".project.meta.title") == title, "opens a song from the library (served by R, decoded in the browser)")
        await pg.evaluate(S + ".edit('t', ['meta'], () => { " + S + ".project.meta.album = 'Edited album'; })")
        # difficulty levels for the lead, built in the Levels tab
        await pg.click('.rsc-insp-tabs [data-tab="levels"]'); await pg.click('[data-act="dd:auto:all"]')
        await pg.wait_for_function(S + ".project.arrangements[0].dd && !document.querySelector('.rsc-busy.is-on')", timeout=60000)
        await pg.wait_for_timeout(600)
        await pg.click("#creator-export-save")
        await pg.wait_for_selector("#creator-export-report .rsc-report", timeout=120000)
        rep = await pg.inner_text("#creator-export-report")
        check("Saved and checked" in rep and os.path.exists(os.path.join(lib, saved_as)), "saved to the library under a new name, checked: " + rep.replace("\n", " ")[:120])
        check("difficulty levels: " in rep, "the lead's new difficulty levels pass RockShiny's check at every difficulty: " + rep.replace("\n", " ")[rep.find("difficulty"):][:60])
        async with pg.expect_download() as d:
            await pg.click("#creator-export-download")
        check((await d.value).suggested_filename.endswith("_m.psarc"), "Download .psarc (built in the browser)")
        wav = os.path.join(TMP, "Shiny Band - Shiny Tune.wav"); make_wav(wav, 10)
        await pg.set_input_files("#creator-project-file", wav)
        await pg.wait_for_selector("#creator-project-create", timeout=30000); await pg.wait_for_timeout(400)
        check(await pg.input_value("#creator-project-title") == "Shiny Tune", "dropped audio opens the new-song form, prefilled")
        await pg.fill("#creator-project-bpm", "100"); await pg.click("#creator-project-create")
        await pg.wait_for_function(S + ".project && " + S + ".project.meta.title === 'Shiny Tune' && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
        check(abs(await pg.evaluate("RSCreator.engine.averageTempo(" + S + ".project.beats)") - 100) < 0.5, "the new song's beat grid follows the tempo given")
        await pg.click("#creator-sections .accordion-button:has-text('Stems')"); await pg.wait_for_timeout(300)
        await pg.click("#creator-stems-run")
        await pg.wait_for_function(S + ".audio.stems && !document.querySelector('.rsc-busy.is-on')", timeout=200000)
        await pg.click("#creator-stems-save"); await pg.wait_for_timeout(4000)
        stems_dir = os.path.join(lib, "Shiny Band - Shiny Tune (stems)")
        check(os.path.isdir(stems_dir) and len(os.listdir(stems_dir)) >= 4, "stems saved on the server: %s" % (os.listdir(stems_dir) if os.path.isdir(stems_dir) else "none"))
        await pg.click('[data-rsc-what="tour"]'); await pg.wait_for_timeout(300)
        titles = []
        while await pg.evaluate("RSCreator.tour.isOn()"):
            titles.append((await pg.evaluate("RSCreator.tour.step()"))["title"]); await pg.click('[data-tour="next"]'); await pg.wait_for_timeout(250)
        check("\u2026or pick one from the library" in titles and "Save" in titles, "the sidebar's 'Take the tour' includes the library and Save to the library (%d steps)" % len(titles))
        await pg.click('[data-rsc-what="help"]')
        check(await pg.evaluate("RSCreator.help.isOpen()") and "Save to the library" in await pg.inner_text(".rsc-help-body"), "the sidebar's Help opens the dialog, worded for Shiny")
        await pg.keyboard.press("Escape")
        check(not pg.errors, "no console errors %s" % pg.errors[:3])
        await pg.close()
    finally:
        app.terminate()

# ---------------------------------------------------------------------------------------------
async def part_c(browser):
    print("C. inside RockShiny")
    if not (os.path.exists(os.path.join(ROOT, "app.R")) and os.path.exists(os.path.join(ROOT, "R", "psarc.R"))):
        print("  skip RockShiny itself is not next to creator/ (C needs it)"); return
    lib = os.path.join(TMP, "lib-c"); os.makedirs(lib, exist_ok=True)
    src = song("Daft-Punk_Derezzed_v1_m.psarc"); shutil.copy(src, lib)
    title = "Night Drive" if is_demo(src) else "Derezzed"
    opts = 'rockshiny.cache_dir="%s", rockshiny.prewarm=FALSE, rockshiny.lyrics_online=FALSE, rockshiny.genres_online=FALSE, rockshiny.library_dir="%s", rockshiny.uploads_dir="%s"' % (
        os.path.join(TMP, "cache"), lib, os.path.join(TMP, "up-c"))
    app, url = start_app("options(%s); shiny::runApp('.', port=PORT, launch.browser=FALSE)" % opts, ROOT)
    try:
        pg = await page_with_log(browser)
        S = "[...RSCreator.shinyStudios.values()][0]"
        await pg.goto(url); await pg.wait_for_timeout(5000)
        tabs = await pg.evaluate("[...document.querySelectorAll('#mode .nav-link')].map(a => a.textContent.trim())")
        check(tabs == ["Home", "Instrument", "Karaoke", "Creator"], "the navbar has the Creator page: %s" % tabs)
        await pg.click("#mode .nav-link[data-value='creator']"); await pg.wait_for_timeout(1200)
        check(await pg.evaluate("document.activeElement && document.activeElement.classList.contains('rsc-studio')"), "the studio takes the keyboard when its page is shown")
        await pg.click("#creator-project-library + .selectize-control .selectize-input")
        await pg.keyboard.type(title); await pg.wait_for_timeout(300); await pg.keyboard.press("Enter")
        await pg.wait_for_function(S + ".project && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
        await pg.click("#creator-export-save")
        await pg.wait_for_selector("#creator-export-play_instrument", timeout=120000)
        await pg.click("#creator-export-play_instrument"); await pg.wait_for_timeout(5000)
        mode = await pg.evaluate("document.querySelector('#mode .nav-link.active').dataset.value")
        picked = await pg.evaluate("$('#import-library').val()")
        check(mode == "instrument" and picked.endswith(os.path.basename(src).replace("_m.psarc", "-2_m.psarc")), "Play it: the saved song opens in the Instrument mode (%s, %s)" % (mode, os.path.basename(picked or "")))
        check(not [e for e in pg.errors if "creator" in e.lower() or "rsc" in e.lower()], "no Creator errors in the console %s" % pg.errors[:3])
        await pg.close()
    finally:
        app.terminate()
    app, url = start_app("options(%s, rockshiny.creator = FALSE); shiny::runApp('.', port=PORT, launch.browser=FALSE)" % opts, ROOT)
    try:
        pg = await page_with_log(browser)
        await pg.goto(url); await pg.wait_for_timeout(4000)
        tabs = await pg.evaluate("[...document.querySelectorAll('#mode .nav-link')].map(a => a.textContent.trim())")
        check(tabs == ["Home", "Instrument", "Karaoke"] and not await pg.evaluate("!!window.RSCreator"), "options(rockshiny.creator = FALSE): no Creator page, nothing of it loaded")
        await pg.close()
    finally:
        app.terminate()

# ---------------------------------------------------------------------------------------------
async def part_d(browser):
    print("D. difficulty levels")
    html = os.path.join(TMP, "RockShinyCreator-d.html")
    rscript('setwd("%s"); source("global.R"); creator_build_html("%s")' % (CREATOR, html), cwd=CREATOR)
    pg = await page_with_log(browser)
    pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await pg.goto("file://" + html); await pg.wait_for_timeout(500)
    sng = song("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "dd")
    await pg.set_input_files('[data-role="file"]', sng)
    await pg.wait_for_function("creator.project && creator.audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=180000)
    A = "creator.project.arrangements"
    lv = await pg.evaluate(A + ".map(a => a.dd ? a.dd.levels.length : 1)")
    nch = len(lv)
    check(lv == [3] * nch and nch >= 2, "every chart opens with its 3 difficulty levels kept: %s" % lv)
    sngs = await pg.evaluate('''async () => { const E = RSCreator.engine, out = [];
      for (const n of creator.source.names().filter(n => n.endsWith('.sng'))) { const x = await E.sngDecrypt(await creator.source.read(n), 'mac'); out.push(E.sngParse(x.body).arrangements.length); }
      return out; }''')
    check(sorted(sngs) == [0] + [3] * nch, "the page decrypts SNGs padded after their zlib stream (levels per SNG: %s)" % sngs)
    await pg.click('[data-tab="levels"]')
    check(await pg.locator(".rsc-lv").count() == 4, "the Levels tab lists levels 0-2 and the full chart")
    # level 1 of the lead: pick a phrase with levels 0-2 and delete a note there with the keyboard
    await pg.click('[data-act="dd:view:1"]')
    check(await pg.evaluate(A + "[0].dd.view") == 1 and "Level 1 of 0\u20132" in await pg.inner_text(".rsc-head.is-level"), "level 1 shown (lane header and badge)")
    info = await pg.evaluate('''() => { const E = RSCreator.engine, a = creator.project.arrangements[0];
      const r = E.ddRanges(a.doc).find(x => x.phraseId >= 0 && a.doc.phrases[x.phraseId].maxDifficulty === 2 && a.doc.levels[0].notes.some(n => n.time >= x.t0 && n.time < x.t1 && n.time > Math.min(20, creator.audio.duration * 0.2)));
      const n = a.doc.levels[0].notes.find(n => n.time >= r.t0 && n.time < r.t1);
      return {t: n.time, s: n.string, l1: a.dd.levels[1].notes.length, l2: a.dd.levels[2].notes.length, l0: a.dd.levels[0].notes.length}; }''')
    await pg.evaluate("creator.view.pps = 120; creator.view.t0 = %f - 1; creator.view.follow = false; creator.clampView(); creator.drawNow()" % info["t"])
    pos = await pg.evaluate('''(t) => { const st = creator, lane = st.lanes.find(l => l.id === 'arr:0'), r = st.wrap.getBoundingClientRect();
      return {x: r.left + st.x(t.t) + 6, y: r.top + lane.y + 20 + (lane.strings - 1 - t.s) * 15 + 7}; }''', info)
    await pg.mouse.click(pos["x"], pos["y"]); await pg.keyboard.press("Delete")
    await pg.keyboard.press("PageUp")      # to level 2: commits level 1
    after = await pg.evaluate("(() => { const a = %s[0]; return {view: a.dd.view, l0: a.dd.levels[0].notes.length, l1: a.dd.levels[1].notes.length, l2: a.dd.levels[2].notes.length}; })()" % A)
    check(after == {"view": 2, "l0": info["l0"], "l1": info["l1"] - 1, "l2": info["l2"]}, "a note deleted at level 1 leaves levels 0 and 2 alone, PageUp shows level 2: %s" % after)
    await pg.keyboard.press("Control+z")
    back = await pg.evaluate("(() => { const a = %s[0]; return {view: a.dd.view, l1: a.dd.levels[1].notes.length + (a.dd.view === 1 ? 0 : 0), n: a.doc.levels[0].notes.length}; })()" % A)
    await pg.keyboard.press("PageDown"); await pg.keyboard.press("PageUp")
    restored = await pg.evaluate(A + "[0].dd.levels[1].notes.length")
    check(back["view"] == 1 and restored == info["l1"], "undo goes back to level 1 and brings the note back (%s, %d)" % (back, restored))
    # an easier copy of a phrase by hand
    await pg.evaluate("creator.audio.seek(%f)" % info["t"]); await pg.wait_for_timeout(200)
    await pg.click('[data-act="dd:view:2"]'); await pg.click('[data-act="dd:ins:phrase"]')
    ins = await pg.evaluate('''(t) => { const E = RSCreator.engine, a = creator.project.arrangements[0], r = E.ddRangeAt(a.doc, t);
      return {max: a.doc.phrases[r.phraseId].maxDifficulty, levels: a.dd.levels.length, view: a.dd.view}; }''', info["t"])
    check(ins == {"max": 3, "levels": 4, "view": 2}, "'+ Add a level' gives the phrase a 4th level and shows the copy: %s" % ins)
    # levels built automatically for the rhythm chart
    await pg.click('[data-act="dd:chart:1"]'); await pg.select_option('[data-f="dd.max"]', "12")
    await pg.click('[data-act="dd:auto:all"]')
    await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on') && creator.project.arrangements[1].dd.levels.length > 3", timeout=60000)
    built = await pg.evaluate(A + "[1].dd.levels.map(l => l.notes.length + l.chords.length)")
    # (13 levels in the busiest phrases; the demo song's short phrases need fewer)
    check((len(built) == 13 or (is_demo(sng) and 8 <= len(built) <= 13)) and built[0] < built[5] <= max(built), "rhythm: 'More (13 levels)' re-created from the full chart: %s" % built)
    await pg.click('[data-act="dd:mode:auto"]')
    check(await pg.evaluate(A + "[1].dd.mode") == "auto", "save mode 'Rebuild' for the rhythm chart")
    await pg.screenshot(path=os.path.join(TMP, "levels.png"))
    # save and check
    size = await pg.evaluate("creator.save({platform: 'mac'}).then(b => { window._saved = b; return b.length; })")
    dest = os.path.join(TMP, "rwtk-levels_m.psarc")
    data = await pg.evaluate("RSCreator.engine.toBase64(window._saved)")
    with open(dest, "wb") as f: f.write(base64.b64decode(data))
    re_ = await pg.evaluate("RSCreator.engine.projectFromPsarc(window._saved).then(r => r.project.arrangements.map(a => a.dd ? a.dd.levels.length : 1))")
    check(re_[:2] == [4, len(built)] and len(re_) == nch, "saved (%.1f MB) and re-opened with its levels: %s" % (size / 1e6, re_))
    r = rscript('setwd("%s"); source("global.R"); v <- creator_validate("%s"); cat(v$ok, paste(v$lines, collapse = " | "))' % (CREATOR, dest), cwd=CREATOR)
    check(r.stdout.startswith("TRUE") and "Lead 4" in r.stdout and "Rhythm %d" % len(built) in r.stdout, "RockShiny's readers agree at every difficulty: " + r.stdout.strip()[:200])
    check(not pg.errors, "no console errors %s" % pg.errors[:3])
    await pg.close()

# ---------------------------------------------------------------------------------------------
async def part_e(browser):
    print("E. help and the guided tour")
    html = os.path.join(TMP, "RockShinyCreator-e.html")
    rscript('setwd("%s"); source("global.R"); creator_build_html("%s")' % (CREATOR, html), cwd=CREATOR)
    pg = await page_with_log(browser)
    await pg.goto("file://" + html); await pg.wait_for_timeout(500)
    # the empty studio offers both
    await pg.click('.rsc-empty [data-act="help:can"]')
    sec = await pg.evaluate("document.querySelector('.rsc-help').dataset.section")
    text = await pg.inner_text(".rsc-help-body")
    check(sec == "can" and "Edit charts" in text and "Difficulty levels" in text, "'What can it do?' opens the Help dialog on that page")
    seen = []
    for s_ in ["start", "cant", "levels", "keys"]:
        await pg.click('[data-sec="%s"]' % s_); seen.append((await pg.inner_text(".rsc-help-body"))[:40].split("\n")[0])
    cant = None
    await pg.click('[data-sec="cant"]'); cant = await pg.inner_text(".rsc-help-body")
    check(seen == ["RockShiny Creator", "What it can\u2019t do", "Difficulty levels", "Keyboard"] and "does not transcribe a song for you" in cant and "Not tested in the game" in cant,
          "its sections: start, can, can't (limits stated), levels, keyboard: %s" % seen)
    await pg.keyboard.press("Escape")
    check(not await pg.evaluate("RSCreator.help.isOpen()"), "Esc closes it")
    await pg.click('[data-role="help"]')
    check(await pg.evaluate("RSCreator.help.isOpen()"), "the header's Help button opens it")
    await pg.click('[data-help="tour"]'); await pg.wait_for_timeout(300)
    st = await pg.evaluate("RSCreator.tour.step()")
    check(st and st["i"] == 0 and st["n"] >= 10, "'Take the tour' starts the tour (%s steps, nothing open)" % (st and st["n"]))
    await pg.keyboard.press("ArrowRight"); await pg.wait_for_timeout(300)
    box = await pg.evaluate("(() => { const s = document.querySelector('.rsc-tour-spot').getBoundingClientRect(), d = document.querySelector('.rscp-drop').getBoundingClientRect(); return [Math.abs(s.left - d.left) < 10, Math.abs(s.top - d.top) < 10]; })()")
    check(box == [True, True] and "Open a song" in await pg.inner_text(".rsc-tour-card"), "step 2 puts the spotlight on the page's drop zone")
    await pg.keyboard.press("Escape")
    check(not await pg.evaluate("RSCreator.tour.isOn()") and not await pg.evaluate("document.querySelector('.rsc-tour')"), "Esc ends the tour")
    # with a song: the ? key, every step on screen, the card inside the window
    await pg.set_input_files('[data-role="file"]', song("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "dd"))
    await pg.wait_for_function("creator.project && creator.audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=180000)
    await pg.evaluate("creator.root.focus()"); await pg.keyboard.press("Shift+Slash")
    check(await pg.evaluate("RSCreator.help.isOpen()"), "the ? key opens the Help")
    await pg.keyboard.press("Escape")
    await pg.click('.rsc-tools [data-act="help"]'); await pg.click('[data-help="tour"]'); await pg.wait_for_timeout(300)
    titles, inside = [], True
    while await pg.evaluate("RSCreator.tour.isOn()"):
        s_ = await pg.evaluate("RSCreator.tour.step()"); titles.append(s_["title"])
        r = await pg.evaluate("(() => { const c = document.querySelector('.rsc-tour-card').getBoundingClientRect(); return [c.left, c.top, c.right, c.bottom, innerWidth, innerHeight]; })()")
        if r[0] < 0 or r[1] < 0 or r[2] > r[4] + 1 or r[3] > r[5] + 1: inside = False
        await pg.click('[data-tour="next"]'); await pg.wait_for_timeout(320)
    want = ["The song", "Tools", "The timeline", "Track names", "Difficulty levels", "Lyrics", "Stems", "Beats", "Play", "Save", "Good to know"]
    check(all(w in titles for w in want) and inside, "with a song open the tour shows %d steps, every card inside the window: %s" % (len(titles), titles))
    check(await pg.evaluate("creator.insTab") == "edit" and await pg.evaluate("!document.querySelector('.rsc-studio.is-touring')"), "after the tour the studio is as it was")
    # the Levels tab links to the levels help
    await pg.click('[data-tab="levels"]'); await pg.click('[data-act="help:levels"]')
    check(await pg.evaluate("document.querySelector('.rsc-help').dataset.section") == "levels", "'How do levels work?' opens the Help on difficulty levels")
    await pg.keyboard.press("Escape")
    check(not pg.errors, "no console errors %s" % pg.errors[:3])
    await pg.close()

# ---------------------------------------------------------------------------------------------
ROOTS = """(arr) => { const lv = creator.project.arrangements[arr].doc.levels[0], d = creator.project.arrangements[arr].doc, B = creator.project.beats.map(b => b.time);
  const pc = {C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11};
  const at = (t) => { if (creator.project.arrangements[arr].kind === 'bass' || lv.chords.length === 0) {
      const n = lv.notes.filter(n => n.time <= t + 0.02).pop(); if (!n) return null; return (d.tuning[n.string] + [40, 45, 50, 55, 59, 64][n.string] - (creator.project.arrangements[arr].kind === 'bass' ? 12 : 0) + n.fret + 120) % 12; }
    const c = lv.chords.filter(c => c.time <= t + 0.02).pop(); if (!c) return null; const m = (d.chordTemplates[c.chordId].chordName || d.chordTemplates[c.chordId].displayName || '').match(/^[A-G][#b]?/); return m ? pc[m[0]] : null; };
  return B.map(at); }"""

async def tuner_run(p, html, wav, lane, mode, record=False):
    """A browser whose microphone plays wav; the demo song, the tuner on chart `lane` (Step), what it wrote."""
    b = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                      "--use-file-for-fake-audio-capture=%s%%noloop" % wav, "--autoplay-policy=no-user-gesture-required"])
    ctx = await b.new_context(viewport={"width": 1600, "height": 1000}); await ctx.grant_permissions(["microphone"])
    pg = await ctx.new_page(); pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append("PAGEERROR " + str(e))); pg.on("console", lambda m: pg.errors.append(m.text) if m.type == "error" else None)
    await pg.goto("file://" + html); await pg.wait_for_timeout(400)
    await pg.click('.rsc-empty [data-act="demo"]')
    await pg.wait_for_function("creator.project && creator.project.meta.title === 'Night Drive' && !document.querySelector('.rsc-busy.is-on')", timeout=60000)
    await pg.evaluate("creator.selectLane('arr:%d'); creator.insTab = 'edit'; creator.renderInspector(); creator.audio.seek(20)" % lane)
    n0 = await pg.evaluate("(() => { const lv = creator.project.arrangements[%d].doc.levels[0]; return lv.notes.length + lv.chords.length; })()" % lane)
    await pg.click('[data-act="tuner:open"]'); await pg.wait_for_function("RSCreator.tuner.isOpen()", timeout=10000)
    await pg.evaluate("RSCreator.tuner._debug().log = []"); await pg.wait_for_timeout(300)
    if mode == "chords": await pg.click('[data-tu="mode:chords"]')
    if record: await pg.click('[data-tu="act:record"]'); await pg.evaluate("creator.audio.seek(2); creator.audio.toggle()")
    await pg.wait_for_timeout(9500)
    if record: await pg.evaluate("creator.audio.playing && creator.audio.toggle()")
    st = await pg.evaluate("RSCreator.tuner.state()")
    n1 = await pg.evaluate("(() => { const lv = creator.project.arrangements[%d].doc.levels[0]; return lv.notes.length + lv.chords.length; })()" % lane)
    shot = os.path.join(TMP, "tuner-%s.png" % mode); await pg.screenshot(path=shot)
    st["events"] = await pg.evaluate("RSCreator.tuner._debug().log.filter(e => e[0] === 'EVENT')")
    await pg.click('[data-tu="close"]')
    closed = not await pg.evaluate("RSCreator.tuner.isOpen()") and not await pg.evaluate("!!document.querySelector('.rsc-tuner')")
    errs = pg.errors; await b.close()
    return st, n1 - n0, closed, errs

async def part_f(browser, p):
    print("F. by ear")
    html = os.path.join(TMP, "RockShinyCreator-f.html")
    rscript('setwd("%s"); source("global.R"); creator_build_html("%s")' % (CREATOR, html), cwd=CREATOR)
    pg = await page_with_log(browser)
    pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await pg.goto("file://" + html); await pg.wait_for_timeout(500)
    # the demo song, made in the page
    await pg.click('.rsc-empty [data-act="demo"]')
    await pg.wait_for_function("creator.project && creator.audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=60000)
    demo = await pg.evaluate("({t: creator.project.meta.title, a: creator.project.meta.artist, charts: creator.project.arrangements.map(a => a.name), lyr: creator.project.vocals.syllables.length, d: creator.audio.duration, art: !!creator.project.art})")
    check(demo["t"] == "Night Drive" and demo["charts"] == ["Lead", "Rhythm", "Bass"] and demo["lyr"] > 40 and demo["d"] > 30, "'Open the demo song' makes Night Drive in the page: %s" % demo)
    # the voice under the lyrics
    await pg.click('[data-tab="lyrics"]'); await pg.click('[data-act="lyr:voice"]')
    await pg.wait_for_function("creator.showVoice && creator.voice && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
    v = await pg.evaluate("""(() => { const v = creator.voice, S = creator.project.vocals.syllables, P = (t) => v.p[Math.min(v.p.length - 1, Math.round(t * v.fps))];
      const sung = S.map(s => P(s.time + Math.min(0.15, s.length / 2))), all = Array.from(v.p), m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
      const inSeg = S.filter(s => v.segments.some(g => s.time + 0.05 >= g.t0 - 0.25 && s.time + 0.05 <= g.t1 + 0.25)).length / S.length;
      const last = S[S.length - 1], a = S[0].time - 0.3, b = last.time + last.length + 0.3, D = creator.audio.duration;
      const out = v.segments.reduce((x, g) => x + Math.max(0, Math.min(g.t1, a) - g.t0) + Math.max(0, g.t1 - Math.max(g.t0, b)), 0) / (a + D - b);
      return {segments: v.segments.length, sung: m(sung), all: m(all), inSeg, out}; })()""")
    check(v["sung"] > v["all"] + 0.1 and v["inSeg"] > 0.9 and v["out"] < 0.35,
          "'Show the voice': p(voice) is higher where syllables are sung (%.2f vs %.2f); %d sung phrase(s) hold %.0f%% of the syllables and %.0f%% of the intro and outro" % (v["sung"], v["all"], v["segments"], 100 * v["inSeg"], 100 * v["out"]))
    check("Hide the voice" in await pg.inner_text(".rsc-inspector"), "the button turns into 'Hide the voice'")
    # lyrics of another take: every line off by 1 s and a bit more; Sync each line
    truth = await pg.evaluate(LINES % (STUDIO_PAGE, STUDIO_PAGE))
    await pg.evaluate("""(() => { const st = creator, S = st.project.vocals.syllables, li = RSCreator.sync.lineIndex(S), L = RSCreator.voice.linesOf(S);
      const starts = L.map((l, i) => l.start + 1.0 + 0.3 * Math.sin(i * 2.3)); st.edit('mess', ['vocals'], () => { st.project.vocals.syllables = RSCreator.sync.retime(S, li, starts); }); })()""")
    before = await pg.evaluate(LINES % (STUDIO_PAGE, STUDIO_PAGE))
    await pg.click('[data-act="lyr:lines"]')
    await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on')", timeout=120000); await pg.wait_for_timeout(200)
    after = await pg.evaluate(LINES % (STUDIO_PAGE, STUDIO_PAGE))
    med = lambda xs: sorted(xs)[len(xs) // 2]
    e0, e1 = med([abs(a - b) for a, b in zip(before, truth)]), med([abs(a - b) for a, b in zip(after, truth)])
    check(len(after) == len(truth) and e1 < 0.25 and e1 < e0 / 3, "'Sync each line' on lines 0.7-1.3 s off: median line error %.2f s -> %.2f s" % (e0, e1))
    await pg.evaluate("creator.undo(); creator.undo()")
    check(med([abs(a - b) for a, b in zip(await pg.evaluate(LINES % (STUDIO_PAGE, STUDIO_PAGE)), truth)]) < 1e-6, "undo takes both back")
    # drafts from the recording: the rhythm's chords, the bass line
    for arr, what, act in [(1, "chords", "Draft the chords"), (2, "bass", "Draft the bass line")]:
        want = await pg.evaluate(ROOTS, arr)
        await pg.evaluate("creator.selectLane('arr:%d'); creator.insTab = 'edit'; creator.renderInspector()" % arr)
        check(act in await pg.inner_text(".rsc-inspector") and "Fill this chart by ear" in await pg.inner_text(".rsc-inspector"), "the %s chart's panel offers '%s'" % (what, act))
        u0 = await pg.evaluate("creator.undoStack.length")
        await pg.click('[data-act="fill:draft"]')
        await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on') && creator.undoStack.length > %d" % u0, timeout=120000); await pg.wait_for_timeout(300)
        got = await pg.evaluate(ROOTS, arr)
        pairs = [(a, b) for a, b in zip(want, got) if a is not None]
        hit = sum(1 for a, b in pairs if a == b) / max(1, len(pairs))
        check(hit >= 0.4, "'%s' from the recording: the root is right on %.0f%% of %d beats" % (act, 100 * hit, len(pairs)))
        await pg.evaluate("creator.root.focus()"); await pg.keyboard.press("Control+z"); await pg.wait_for_timeout(150)   # the keyboard's undo
        check(await pg.evaluate(ROOTS, arr) == want, "undo brings the %s chart back" % what)
    # the lead chart: no draft (a lead line can't be drafted from a mix), the tuner only
    await pg.evaluate("creator.selectLane('arr:0'); creator.insTab = 'edit'; creator.renderInspector()")
    check(await pg.locator('.rsc-inspector [data-act="fill:draft"]').count() == 0 and await pg.locator('.rsc-inspector [data-act="tuner:open"]').count() == 1,
          "the lead chart offers the tuner, not a draft")
    check(not pg.errors, "no console errors %s" % pg.errors[:3])
    await pg.close()
    # the tuner, with a fake microphone
    for what, mode, lane, want in [("notes", "notes", 0, [40, 45, 50, 55, 59, 64]), ("repeats", "notes", 0, [40, 40, 40, 45, 47, 45, 52, 52]), ("chords", "chords", 1, ["G", "C", "D", "Em"])]:
        wav = os.path.join(TMP, "guitar-%s.wav" % what)
        subprocess.run([NODE, os.path.join(CREATOR, "tests", "js", "cli.js"), "guitar-wav", what, wav], check=True)
        st, added, closed, errs = await tuner_run(p, html, wav, lane, mode)
        got = [w.get("midi") if mode == "notes" else w.get("chord") for w in (st or {}).get("written", [])]
        times = [w["time"] for w in (st or {}).get("written", [])]
        check(got == want and added == len(want) and times == sorted(times) and len(set(times)) == len(times),
              "tuner (%s, Step): a microphone playing %s writes %s, one after the other%s" % (what, want, got, "" if got == want else " (events %s)" % (st or {}).get("events")))
        check(closed and not errs, "the tuner closes, its microphone released; no console errors %s" % errs[:3])
    # Record: play along with the song; each note goes in at the time it was played
    wav = os.path.join(TMP, "guitar-notes.wav")
    st, added, closed, errs = await tuner_run(p, html, wav, 0, "notes", record=True)
    w = (st or {}).get("written", [])
    gaps = [round(b["time"] - a["time"], 2) for a, b in zip(w, w[1:])]
    check([x.get("midi") for x in w] == [40, 45, 50, 55, 59, 64] and all(abs(g - 1.0) <= 0.2 for g in gaps) and closed and not errs,
          "tuner (Record, the song playing): notes played a second apart go in a second apart, at the song's time: %s" % [(x.get("midi"), x["time"]) for x in w])

async def main(parts):
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        for name, fn in [("A", part_a), ("B", part_b), ("C", part_c), ("D", part_d), ("E", part_e), ("F", part_f)]:
            if name in parts: await (fn(browser, p) if name == "F" else fn(browser))
        await browser.close()
    print("\n%d failure(s)" % len(failures) if failures else "\nall checks passed")
    shutil.rmtree(TMP, ignore_errors=True)
    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:] or ["A", "B", "C", "D", "E", "F"]))
