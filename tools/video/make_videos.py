#!/usr/bin/env python3
"""
The RockShiny videos, recorded from the running apps in headless Chromium:

  docs/video/rockshiny-teaser.mp4   ~1 min: the whole project (highway, piano, karaoke,
                                    home, then the Creator), for the README and sharing
  docs/video/creator-tour.mp4       ~3 min: a guided tour of the Creator (what it can and
                                    can't do, every tab, a new song, saving, the offline file)

plus a poster image for each. Captions, the pointer and click ripples are drawn in
the page (tools/video/record.py); title cards are tools/video/card.html; the music
is original, synthesised by tools/video/music.py. No narration.

  python3 tools/video/make_videos.py [teaser] [tour]      (both by default)

Needs R (shiny, bslib), Python 3 + playwright (chromium) + numpy, ffmpeg (libx264),
the sample songs in songs/ and the audio tools RockShiny uses. Starts its own two
apps (the Creator on its own, RockShiny with the Creator page) on a scratch library.
"""
import asyncio, os, shutil, socket, subprocess, sys, tempfile, time, urllib.parse
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from record import Recorder, OVERLAY_JS, W, H, DPR, concat, duration, run

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
CREATOR = os.path.join(ROOT, "creator")
SONGS = os.path.join(ROOT, "songs")
OUT = os.path.join(ROOT, "docs", "video")
WORK = tempfile.mkdtemp(prefix="rsv-")
LIB = os.path.join(WORK, "Rocksmith")
RSCRIPT = shutil.which("Rscript") or "Rscript"
CARD = "file://" + os.path.join(HERE, "card.html")
LIBRARY = ["Dire-Straits_Sultans-of-Swing_v443_m.psarc", "Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "DaftPunk_GetLucky_m.psarc",
           "Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc", "Gary-Moore_Still-Got-the-Blues-Live_v1_m.psarc", "Daft-Punk_Derezzed_v1_m.psarc"]
S = "[...RSCreator.shinyStudios.values()][0]"
DEMO_WAV = os.path.join(WORK, "RockShiny - Night Drive.wav")


# ---- apps ------------------------------------------------------------------------------------------
def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def start_app(code, cwd):
    port = free_port()
    p = subprocess.Popen([RSCRIPT, "-e", code.replace("PORT", str(port))], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(240):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close(); break
        except OSError:
            time.sleep(0.5)
    return p, "http://127.0.0.1:%d" % port

def opts(extra=""):
    return ('rockshiny.cache_dir="%s", rockshiny.prewarm=FALSE, rockshiny.lyrics_online=FALSE, rockshiny.genres_online=FALSE, '
            'rockshiny.library_dir="%s", rockshiny.uploads_dir="%s"%s') % (os.path.join(WORK, "cache"), LIB, os.path.join(WORK, "up"), extra)


# ---- recording helpers ----------------------------------------------------------------------------
class Session:
    def __init__(self, browser, name):
        self.browser, self.name = browser, name

    async def __aenter__(self):
        self.ctx = await self.browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=DPR, accept_downloads=True)
        await self.ctx.add_init_script(OVERLAY_JS)
        self.pg = await self.ctx.new_page()
        self.rec = Recorder(self.pg, os.path.join(WORK, "frames", self.name))
        return self

    async def __aexit__(self, *a):
        await self.rec.stop()
        await self.ctx.close()

    async def start(self):
        await self.rec.start()

    def mark(self, n):
        return self.rec.mark(n)

    def clip(self, a, b, name=None, speed=1.0):
        out = os.path.join(WORK, (name or self.name) + ".mp4")
        self.rec.clip(out, a, b, speed)
        return out

    def clips(self, ranges, name):
        """Stretches of time joined (to leave out waiting)."""
        out = os.path.join(WORK, name + ".mp4")
        self.rec.clip_ranges(out, [(self.rec.marks.get(a, a) if isinstance(a, str) else a, self.rec.marks.get(b, b) if isinstance(b, str) else b) for a, b in ranges])
        return out

    async def cap(self, title, sub="", **kw):
        await self.pg.evaluate("([t, s, o]) => window.__rsv.caption(t, s, o)", [title, sub, kw])

    async def wait(self, s):
        await self.pg.wait_for_timeout(int(s * 1000))

    async def move(self, x, y, steps=12):
        await self.pg.mouse.move(x, y, steps=steps)

    async def click(self, selector=None, xy=None, pause=0.2, steps=12):
        if selector:
            loc = self.pg.locator(selector).first
            await loc.scroll_into_view_if_needed()
            box = await loc.bounding_box()
            xy = (box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        await self.move(xy[0], xy[1], steps)
        await self.wait(pause)
        await self.pg.mouse.down(); await self.wait(0.06); await self.pg.mouse.up()

    async def key(self, k, label=None):
        await self.pg.evaluate("(t) => window.__rsv.key(t)", label or k)
        await self.pg.keyboard.press(k)


async def card(browser, name, secs, **q):
    async with Session(browser, name) as s:
        await s.pg.goto(CARD + "?" + urllib.parse.urlencode(q))
        await s.start()
        s.mark("a"); await s.wait(secs); s.mark("b")
        return s.clip("a", "b")


async def center(loc):
    b = await loc.bounding_box()
    return (b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)

async def open_library(s, query):
    await s.click("#creator-project-library + .selectize-control .selectize-input")
    await s.pg.keyboard.type(query, delay=60); await s.wait(0.4); await s.pg.keyboard.press("Enter")
    await s.pg.wait_for_function(S + ".project && " + S + ".audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=240000)
    await s.wait(0.6)

async def view(s, t0, pps, pos=None, studio=S):
    await s.pg.evaluate("(() => { const st = %s; st.view.pps = %f; st.view.t0 = %f; %s st.clampView(); st.drawNow(); })()" %
                        (studio, pps, t0, ("st.audio.seek(%f);" % pos) if pos is not None else ""))

async def note_xy(s, lane_id, pred_js, studio=S):
    """Screen position of the first note of a chart lane matching pred(n)."""
    return await s.pg.evaluate("""(() => { const st = %s, lane = st.lanes.find(l => l.id === '%s'), lv = st.project.arrangements[lane.arr].doc.levels[0];
        const n = lv.notes.find(%s); if (!n) return null; const r = st.wrap.getBoundingClientRect();
        return [r.left + st.x(n.time) + 7, r.top + lane.y + 20 + (lane.strings - 1 - n.string) * 15 + 7, n.time]; })()""" % (studio, lane_id, pred_js))


# ---- RockShiny (the main app) scenes ---------------------------------------------------------------
async def main_app_scenes(browser, main):
    clips = {}
    async with Session(browser, "main") as s:
        pg = s.pg
        await pg.goto(main); await s.wait(5)
        await s.start()
        # home
        s.mark("home_a")
        await s.cap("Your library, like a music app", "Artists, albums, genres and playlists; play in the highway or sing in karaoke", bottom=60)
        await s.move(700, 230); await s.wait(0.4)
        await s.move(*(await center(pg.get_by_text("Money for Nothing").first))); await s.wait(1.4)
        s.mark("home_b")
        await s.cap("")
        # instrument: the highway
        await s.click("#mode .nav-link[data-value='instrument']"); await s.wait(0.8)
        song = await pg.evaluate("Object.keys($('#import-library')[0].selectize.options).find(v => /Sultans/.test(v))")
        await pg.evaluate("(v) => $('#import-library')[0].selectize.setValue(v)", song)
        await pg.wait_for_function("(() => { const c = [...RSHighway.controllers.values()][0]; return c && c.chart && c.audioKind === 'full'; })()", timeout=300000)
        await s.wait(1)
        await pg.evaluate("document.querySelector('.bslib-sidebar-layout .collapse-toggle') && document.querySelector('#mode-instrument .collapse-toggle, .tab-pane.active .collapse-toggle').click()")
        await s.wait(0.8)
        await pg.evaluate("""(() => { const c = [...RSHighway.controllers.values()][0], N = c.chart.notes; let best = 0, bt = 30;
            for (let t = 20; t < 300; t += 1) { let k = 0; for (let i = 0; i < N.n; i++) if (N.t[i] >= t && N.t[i] < t + 8) k++; if (k > best) { best = k; bt = t; } }
            c.seek(bt - 1.5); if (!c.clock.playing) c.togglePlay(); })()""")
        await s.wait(1.2)
        s.mark("hw_a")
        await s.cap("A Rocksmith-style 3-D note highway", "Any .psarc: notes, chords, bends and slides, in sync with the song", bottom=64)
        await s.wait(5.5)
        s.mark("hw_b")
        await s.cap("")
        # piano
        await pg.evaluate("$('input[name=\"player-instrument\"][value=\"piano\"]').prop('checked', true).trigger('change')")
        await s.wait(2.5)
        s.mark("pno_a")
        await s.cap("\u2026or play it on piano, or harmonica", "Any guitar or bass part, on a 3-D keyboard or a 10-hole harp", bottom=64)
        await s.wait(4.5)
        s.mark("pno_b")
        await s.cap("")
        await pg.evaluate("(() => { const c = [...RSHighway.controllers.values()][0]; if (c.clock.playing) c.togglePlay(); })()")
        # karaoke
        await s.click("#mode .nav-link[data-value='karaoke']"); await s.wait(0.8)
        ksong = await pg.evaluate("Object.keys($('#karaoke-library')[0].selectize.options).find(v => /Riding/.test(v))")
        await pg.evaluate("(v) => $('#karaoke-library')[0].selectize.setValue(v)", ksong)
        await pg.wait_for_function("(() => { const p = [...RSKaraoke.players.values()][0]; return p && p.deck && p.deck.audio && p.deck.kind === 'full'; })()", timeout=300000)
        await s.wait(1)
        await pg.evaluate("document.querySelector('.tab-pane.active .collapse-toggle') && document.querySelector('.tab-pane.active .collapse-toggle').click()")
        await pg.evaluate("(() => { const p = [...RSKaraoke.players.values()][0]; p.seek(64); })()")
        await s.wait(0.4)
        await s.click(".tab-pane.active .rs-k-transport button", pause=0.2)
        await s.wait(1.5)
        s.mark("kar_a")
        await s.cap("Karaoke, syllable by syllable", "Lyrics from the song, a .lrc or the web, synced to the recording; sing and get scored", bottom=64)
        await s.wait(5)
        s.mark("kar_b")
        await s.cap("")
        clips["home"] = s.clip("home_a", "home_b", "t-home")
        clips["highway"] = s.clip("hw_a", "hw_b", "t-highway")
        clips["piano"] = s.clip("pno_a", "pno_b", "t-piano")
        clips["karaoke"] = s.clip("kar_a", "kar_b", "t-karaoke")
    return clips


def start_apps():
    os.makedirs(LIB, exist_ok=True)
    for f in LIBRARY:
        if os.path.exists(os.path.join(SONGS, f)): shutil.copy(os.path.join(SONGS, f), LIB)
    creator, c_url = start_app("options(%s); shiny::runApp('.', port=PORT, launch.browser=FALSE)" % opts(), CREATOR)
    main, m_url = start_app("options(%s); shiny::runApp('.', port=PORT, launch.browser=FALSE)" % opts(), ROOT)
    return [creator, main], c_url, m_url


# ---- Creator scenes --------------------------------------------------------------------------------
LRC_SHIFTED = """() => { const S = %s.project.vocals.syllables, L = []; let cur = null;
  for (const s of S) { if (!cur) { cur = {t: s.time, w: ''}; L.push(cur); } cur.w += s.lyric.replace(/[+-]$/, '') + (/-$/.test(s.lyric) ? '' : ' '); if (/\\+$/.test(s.lyric)) cur = null; }
  const f = (t) => { t += 1.6; const m = Math.floor(t / 60); return '[' + String(m).padStart(2, '0') + ':' + (t - 60 * m).toFixed(2).padStart(5, '0') + ']'; };
  return L.map(l => f(l.t) + l.w.trim()).join('\\n'); }"""

async def busiest(s, span, studio=S):
    return await s.pg.evaluate("""(() => { const st = %s, p = st.project, ev = [];
      p.arrangements.forEach((a, i) => { const lv = a.doc.levels[0]; for (const n of lv.notes) ev.push(n.time); for (const c of lv.chords) ev.push(c.time); });
      if (p.vocals) for (const y of p.vocals.syllables) ev.push(y.time);
      let best = 0, bt = 5; for (let t = 5; t < st.duration() - %f; t += 0.5) { const k = ev.filter(e => e >= t && e < t + %f).length; if (k > best) { best = k; bt = t; } }
      return bt; })()""" % (studio, span, span))

async def wait_idle(s, studio=S, timeout=300000):
    await s.pg.wait_for_function("!document.querySelector('.rsc-busy.is-on')", timeout=timeout)


async def creator_teaser_scenes(browser, main):
    """The Creator inside RockShiny: timeline, editing, levels, stems, lyrics, save -> play."""
    clips = {}
    async with Session(browser, "cr") as s:
        pg = s.pg
        await pg.goto(main); await s.wait(5)
        await pg.click("#mode .nav-link[data-value='creator']"); await s.wait(1)
        await open_library(s, "Riding")
        t = await busiest(s, 8)
        await view(s, t - 1, 95, t)
        await s.start()
        await s.wait(0.5)
        # the timeline, playing
        s.mark("tl_a")
        await s.cap("RockShiny Creator: edit any song", "Open a .psarc: every chart, the lyrics, sections, beats and the audio on one timeline", bottom=60)
        await pg.evaluate(S + ".view.follow = true; " + S + ".audio.toggle()")
        await s.wait(3.8)
        await pg.evaluate(S + ".audio.toggle()")
        s.mark("tl_b")
        # edit a note: click, type a fret, bend
        await s.cap("")
        tt = await pg.evaluate(S + ".audio.time()")
        await view(s, tt - 1.2, 130)
        xy = await note_xy(s, "arr:0", "n => n.time > %f && n.time < %f" % (tt - 0.6, tt + 4))
        s.mark("ed_a")
        await s.cap("Notes, chords and techniques", "Click, type a fret, add a bend or a slide; draw, drag, copy, undo", bottom=60)
        if xy:
            await s.click(xy=(xy[0], xy[1])); await s.wait(0.5)
            await s.key("1"); await s.wait(0.2); await s.key("2"); await s.wait(0.6); await s.key("b", "B  bend"); await s.wait(1.6)
        s.mark("ed_b")
        await s.cap("")
        # levels: the easiest level of the lead, ghosts of the full chart
        await s.click('.rsc-insp-tabs [data-tab="levels"]'); await s.wait(0.3)
        s.mark("lv_a")
        await s.cap("Difficulty levels, kept and editable", "See what a beginner plays: dashed notes are only in the full chart", bottom=60)
        await s.click('[data-act="dd:view:0"]'); await s.wait(1.3)
        await s.click('[data-act="dd:chart:1"]'); await s.wait(0.3)
        await s.click('[data-act="dd:auto:all"]'); await wait_idle(s); await s.wait(0.3)
        await s.cap("Easier levels in one click", "Made from the full chart: strongest beats first, chords on fewer strings", bottom=60)
        await s.click('[data-act="dd:view:1"]'); await s.wait(2.0)
        s.mark("lv_b")
        await s.cap("")
        await pg.evaluate(S + ".showLevel(0, null); " + S + ".showLevel(1, null)")
        # stems
        await s.click('.rsc-insp-tabs [data-tab="stems"]'); await s.wait(0.3)
        await s.click('[data-act="stems:run"]'); await s.wait(1.0)
        s.mark("st_wait")
        await pg.wait_for_function(S + ".audio.stems && !document.querySelector('.rsc-busy.is-on')", timeout=400000)
        await pg.evaluate("(() => { const st = %s; st.laneState['arr:0'] = {collapsed: true}; st.laneState['arr:1'] = {collapsed: true}; st.buildLanes(); st.drawNow(); })()" % S)
        await s.wait(0.6)
        s.mark("st_a")
        await s.cap("Stems: vocals, guitar, bass, drums", "Separated with the song's own charts and lyrics; mute one to play or sing along", bottom=60)
        await s.click('[data-act="mute:guitar"]'); await s.wait(0.8); await s.click('[data-act="solo:vocals"]'); await s.wait(1.6)
        s.mark("st_b")
        await s.cap("")
        await s.click('[data-act="solo:vocals"]')
        await pg.evaluate("(() => { const st = %s; st.laneState = {}; st.buildLanes(); st.drawNow(); })()" % S)
        # lyrics: pasted 1.6 s late, auto-synced
        lrc = await pg.evaluate(LRC_SHIFTED % S)
        await s.click('.rsc-insp-tabs [data-tab="lyrics"]'); await s.wait(0.3)
        await pg.fill('[data-role="paste"]', lrc)
        await pg.click('[data-act="lyr:paste"]'); await s.wait(0.3)
        lt = await pg.evaluate("%s.project.vocals.syllables[40].time" % S)
        await view(s, lt - 3, 80)
        s.mark("ly_a")
        await s.cap("Lyrics, synced to the recording", "From LRCLIB, a .lrc or pasted; auto-sync fits them to the singing", bottom=60)
        await s.wait(1.0)
        await s.click('[data-act="lyr:auto"]'); s.mark("ly_m"); await wait_idle(s); s.mark("ly_r"); await s.wait(2.2)
        s.mark("ly_b")
        await s.cap("")
        # save to the library, then play it in RockShiny
        await s.click('.rsc-insp-tabs [data-tab="edit"]')
        s.mark("sv_a")
        await s.cap("Save for PC or Mac, checked", "Into the library, read back by RockShiny's own parsers, then play it", bottom=60)
        await s.click("#creator-export-save"); s.mark("sv_m")
        await pg.wait_for_selector("#creator-export-play_instrument", timeout=240000); s.mark("sv_r"); await s.wait(1.6)
        await s.click("#creator-export-play_instrument"); await s.wait(1.0)
        s.mark("sv_b")
        await pg.wait_for_function("(() => { const c = [...RSHighway.controllers.values()][0]; return c && c.chart && c.audioKind === 'full'; })()", timeout=300000)
        await pg.evaluate("(() => { const c = [...RSHighway.controllers.values()][0]; c.seek(%f); if (!c.clock.playing) c.togglePlay(); })()" % (t + 2))
        await s.wait(0.8)
        s.mark("pl_a")
        await s.cap("\u2026and play it", "Saved songs open right away in the Instrument or Karaoke mode", bottom=64)
        await s.wait(3.5)
        s.mark("pl_b")
        clips["timeline"] = s.clip("tl_a", "tl_b", "c-timeline")
        clips["edit"] = s.clip("ed_a", "ed_b", "c-edit")
        clips["levels"] = s.clip("lv_a", "lv_b", "c-levels")
        clips["stems"] = s.clip("st_a", "st_b", "c-stems")
        clips["lyrics"] = s.clips([("ly_a", s.rec.marks["ly_m"] + 0.9), (s.rec.marks["ly_r"] - 0.2, "ly_b")], "c-lyrics")
        clips["save"] = s.clips([("sv_a", s.rec.marks["sv_m"] + 0.9), (s.rec.marks["sv_r"] - 0.2, "sv_b")], "c-save")
        clips["play"] = s.clip("pl_a", "pl_b", "c-play")
    return clips


async def offline_scene(browser, name="offline", secs=4.5, caption=("One HTML file, works offline", "The whole studio opens from disk: no server, no network")):
    html = os.path.join(WORK, "RockShinyCreator.html")
    if not os.path.exists(html):
        run([RSCRIPT, "-e", 'setwd("%s"); source("global.R"); creator_build_html("%s")' % (CREATOR, html)])
    async with Session(browser, name) as s:
        pg = s.pg
        await pg.goto("file://" + html); await s.wait(0.6)
        await pg.set_input_files('[data-role="file"]', os.path.join(SONGS, "Gary-Moore_Still-Got-the-Blues-Live_v1_m.psarc"))
        await pg.wait_for_function("creator.project && creator.audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=240000)
        t = await busiest(s, 8, "creator")
        await view(s, t, 80, t + 1, "creator")
        await s.start()
        s.mark("a")
        await s.cap(caption[0], caption[1], bottom=60)
        await pg.evaluate("creator.view.follow = true; creator.audio.toggle()")
        await s.wait(secs)
        s.mark("b")
        return s.clip("a", "b", "c-" + name)


async def tour_scenes(browser, creator_url, main_url):
    """The Creator, feature by feature (the standalone app; saving and playing in RockShiny)."""
    clips = []
    async with Session(browser, "tour") as s:
        pg = s.pg
        await pg.goto(creator_url); await s.wait(4)
        await s.start()
        # 1. help: what it can and can't do
        s.mark("a1")
        await s.cap("Start with Help", "The ? button, the ? key or Help in the sidebar: what it can do, what it can't, how to use it", bottom=40)
        await s.wait(1.2)
        await s.click('[data-rsc-what="help"]'); await s.cap("")
        await s.wait(2.4)
        await s.click('[data-sec="can"]'); await s.wait(2.6)
        await s.click('[data-sec="cant"]'); await s.wait(1.4)
        await pg.mouse.wheel(0, 300); await s.wait(2.2)
        await s.click('[data-sec="levels"]'); await s.wait(2.6)
        s.mark("b1")
        # 2. the guided tour
        await s.key("Escape", "Esc"); await s.wait(0.4)
        await s.cap("\u2026or take the guided tour", "A spotlight on each part of the studio, with what it does", bottom=40)
        s.mark("a2")
        await s.wait(1.6)
        await s.click('[data-rsc-what="help"]'); await s.wait(0.6)
        await s.click('[data-help="tour"]'); await s.wait(1.6); await s.cap("")
        for _ in range(4):
            await s.click('[data-tour="next"]'); await s.wait(1.9)
        await s.key("Escape", "Esc")
        await s.wait(0.6)
        s.mark("b2")
        await s.cap("")
        # 3. open a song from the library
        s.mark("a3")
        await s.cap("Open a song", "From the library, or drop a .psarc; an audio file starts a new song", bottom=40)
        await s.click("#creator-project-library + .selectize-control .selectize-input")
        await pg.keyboard.type("Riding", delay=90); await s.wait(0.6); await pg.keyboard.press("Enter")
        s.mark("b3")
        await pg.wait_for_function(S + ".project && " + S + ".audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=240000)
        t = await busiest(s, 8)
        await view(s, t - 1, 70, t)
        await s.wait(0.4)
        # 4. the timeline
        s.mark("a4")
        await s.cap("Every track on one timeline", "Sections, beats, the recording, one row per chart (tablature) and the lyrics", bottom=40)
        await pg.evaluate(S + ".view.follow = true; " + S + ".audio.toggle()")
        await s.wait(3.5)
        await s.key(" ", "Space")
        await s.move(700, 400, 20)
        for _ in range(3):
            await pg.keyboard.down("Control"); await pg.mouse.wheel(0, -240); await pg.keyboard.up("Control"); await s.wait(0.35)
        await s.wait(1.2)
        s.mark("b4")
        # 5. editing
        tt = await pg.evaluate(S + ".audio.time()")
        await view(s, tt - 1.0, 140)
        xy = await note_xy(s, "arr:0", "n => n.time > %f && n.time < %f" % (tt - 0.5, tt + 3.5))
        s.mark("a5")
        await s.cap("Edit notes with the mouse and the keyboard", "Click a note, type its fret, add techniques; the panel on the right shows it all", bottom=40)
        if xy:
            await s.click(xy=(xy[0], xy[1])); await s.wait(0.8)
            await s.key("1"); await s.wait(0.25); await s.key("2"); await s.wait(0.8)
            await s.key("v", "V  vibrato"); await s.wait(0.9); await s.key("b", "B  bend"); await s.wait(1.2)
            await s.key("ArrowUp", "\u2191  string"); await s.wait(1.0)
        await s.cap("Draw, erase, undo", "D draws at the grid, E erases, Ctrl+Z undoes anything", bottom=40)
        await s.key("d", "D  draw")
        lane = await pg.evaluate("(() => { const st = %s, l = st.lanes.find(x => x.id === 'arr:0'), r = st.wrap.getBoundingClientRect(); return [r.left, r.top + l.y + 20 + 2 * 15 + 7, st.x(%f), st.x(%f)]; })()" % (S, tt + 0.9, tt + 1.6))
        await s.click(xy=(lane[0] + lane[2], lane[1])); await s.wait(0.7)
        await s.click(xy=(lane[0] + lane[3], lane[1] - 15)); await s.wait(0.9)
        await s.key("Control+z", "Ctrl+Z"); await s.wait(1.0)
        await s.key("v", "V  select")
        await s.wait(0.6)
        s.mark("b5")
        # 6. difficulty levels
        await s.click('.rsc-insp-tabs [data-tab="levels"]')
        s.mark("a6")
        await s.cap("Difficulty levels", "Keep a song's own levels: look at any of them, edit them by hand", bottom=40)
        await s.wait(1.2)
        await s.click('[data-act="dd:view:0"]'); await s.wait(1.8)
        await s.key("PageUp", "PgUp"); await s.wait(1.4); await s.key("PageUp", "PgUp"); await s.wait(1.2)
        await s.cap("Create easier levels automatically", "From the full chart: strongest beats first, chords on fewer strings", bottom=40)
        await s.click('[data-act="dd:chart:1"]'); await s.wait(0.6)
        await s.click('[data-act="dd:auto:all"]'); await wait_idle(s); await s.wait(0.8)
        await s.click('[data-act="dd:view:1"]'); await s.wait(2.0)
        await s.move(1140, 560, 25); await pg.mouse.wheel(0, 420); await s.wait(2.0)
        s.mark("b6")
        await pg.evaluate(S + ".showLevel(0, null); " + S + ".showLevel(1, null)")
        # 7. lyrics
        lrc = await pg.evaluate(LRC_SHIFTED % S)
        await s.click('.rsc-insp-tabs [data-tab="lyrics"]'); await s.wait(0.3)
        await pg.fill('[data-role="paste"]', lrc); await pg.click('[data-act="lyr:paste"]'); await s.wait(0.3)
        lt = await pg.evaluate("%s.project.vocals.syllables[40].time" % S)
        await view(s, lt - 3, 80)
        s.mark("a7")
        await s.cap("Lyrics", "Find them online, import a .lrc or paste them; Auto-sync fits them to the singing", bottom=40)
        await s.wait(1.5)
        await s.click('[data-act="lyr:auto"]'); s.mark("m7"); await wait_idle(s); s.mark("r7"); await s.wait(2.2)
        s.mark("b7")
        # 8. stems
        await s.click('.rsc-insp-tabs [data-tab="stems"]'); await s.wait(0.3)
        s.mark("a8")
        await s.cap("Stems", "Split the recording into vocals, guitar, bass, drums and the rest", bottom=40)
        await s.click('[data-act="stems:run"]'); await s.wait(1.6)
        s.mark("b8")
        await pg.wait_for_function(S + ".audio.stems && !document.querySelector('.rsc-busy.is-on')", timeout=400000)
        await pg.evaluate("(() => { const st = %s; st.laneState['arr:0'] = {collapsed: true}; st.laneState['arr:1'] = {collapsed: true}; st.buildLanes(); st.drawNow(); })()" % S)
        await s.wait(0.5)
        s.mark("a9")
        await s.cap("Mute, solo, mix, download", "Mute the guitar to play along; each stem downloads as a WAV", bottom=40)
        await s.click('[data-act="mute:guitar"]'); await s.wait(1.0); await s.click('[data-act="solo:vocals"]'); await s.wait(1.6)
        await s.click('[data-act="solo:vocals"]'); await s.wait(0.8)
        s.mark("b9")
        await pg.evaluate("(() => { const st = %s; st.laneState = {}; st.buildLanes(); st.drawNow(); })()" % S)
        # 9. a new song from an audio file
        await s.cap("")
        s.mark("a10")
        await s.cap("A new song from any audio file", "Its tempo and beat grid come from the audio; title and artist from the file name", bottom=40)
        await pg.set_input_files("#creator-project-file", DEMO_WAV)
        await pg.wait_for_selector("#creator-project-create", timeout=60000); await s.wait(2.4)
        await s.click("#creator-project-create")
        s.mark("b10")
        await pg.wait_for_function(S + ".project && " + S + ".project.meta.title === 'Night Drive' && !document.querySelector('.rsc-busy.is-on')", timeout=240000)
        await view(s, 4, 90)
        await s.click('.rsc-insp-tabs [data-tab="beats"]'); await s.wait(0.3)
        s.mark("a11")
        await s.cap("Draw the charts on the beat grid", "Beats detected from the audio; Draw (D) snaps notes to the grid", bottom=40)
        await s.key("d", "D  draw")
        base = await pg.evaluate("(() => { const st = %s, l = st.lanes.find(x => x.id === 'arr:0'), r = st.wrap.getBoundingClientRect(), B = st.project.beats.filter(b => b.time > 4.2).slice(0, 8);"
                                 " return B.map((b, i) => [r.left + st.x(b.time) + 2, r.top + l.y + 20 + ([4, 3, 3, 2, 4, 3, 2, 1][i]) * 15 + 7]); })()" % S)
        for i, (x, y) in enumerate(base):
            await s.click(xy=(x, y), pause=0.08, steps=10)
            await s.key(str([5, 7, 7, 5, 3, 5, 7, 8][i])); await s.wait(0.15)
        await s.key("v", "V  select"); await s.wait(1.6)
        s.mark("b11")
        clips = [s.clip("a1", "b1", "tour-01-help"), s.clip("a2", "b2", "tour-02-tour"), s.clip("a3", "b3", "tour-03-open"), s.clip("a4", "b4", "tour-04-timeline"),
                 s.clip("a5", "b5", "tour-05-edit"), s.clip("a6", "b6", "tour-06-levels"), s.clips([("a7", s.rec.marks["m7"] + 0.9), (s.rec.marks["r7"] - 0.2, "b7")], "tour-07-lyrics"), s.clip("a8", "b8", "tour-08-stems"),
                 s.clip("a9", "b9", "tour-09-mix"), s.clip("a10", "b10", "tour-10-new"), s.clip("a11", "b11", "tour-11-draw")]
    return clips


async def tour_save_scene(browser, main_url):
    """Saving in RockShiny's Creator page and playing the song."""
    async with Session(browser, "tour-save") as s:
        pg = s.pg
        await pg.goto(main_url); await s.wait(5)
        await pg.click("#mode .nav-link[data-value='creator']"); await s.wait(1)
        await open_library(s, "Wish You")
        t = await busiest(s, 8)
        await view(s, t - 1, 80, t)
        await s.start()
        s.mark("a")
        await s.cap("Save for PC or Mac", "Into the library: a new file, checked with RockShiny's own readers", bottom=40)
        await s.wait(0.6)
        await s.click('.rsc-platform label:has-text("PC")'); await s.wait(0.6)
        await s.click("#creator-export-save"); s.mark("m")
        await pg.wait_for_selector("#creator-export-play_instrument", timeout=240000); s.mark("r"); await s.wait(2.2)
        await s.cap("Then play it, or sing it", "The Creator is a page of RockShiny: the saved song opens at once", bottom=40)
        await s.wait(0.8)
        await s.click("#creator-export-play_instrument"); await s.wait(0.6)
        s.mark("b")
        await pg.wait_for_function("(() => { const c = [...RSHighway.controllers.values()][0]; return c && c.chart && c.audioKind === 'full'; })()", timeout=300000)
        await pg.evaluate("(() => { const c = [...RSHighway.controllers.values()][0]; c.seek(%f); if (!c.clock.playing) c.togglePlay(); })()" % (t + 1))
        await s.wait(0.8)
        s.mark("c")
        await s.wait(4.5)
        s.mark("d")
        return [s.clips([("a", s.rec.marks["m"] + 0.9), (s.rec.marks["r"] - 0.2, "b")], "tour-12-save"), s.clip("c", "d", "tour-13-play")]


# ---- the two videos ---------------------------------------------------------------------------------
def music(kind, seconds, path):
    import music as M
    M.write(path, M.render(kind, seconds))
    return path

def poster(video, t, out):
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", "%.2f" % t, "-i", video, "-frames:v", "1", "-q:v", "3", out])

async def make(parts):
    os.makedirs(OUT, exist_ok=True)
    import music as M
    M.write(DEMO_WAV, M.render("teaser", 42))
    procs, creator_url, main_url = start_apps()
    made = []
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            if "teaser" in parts:
                m = await main_app_scenes(b, main_url)
                c = await creator_teaser_scenes(b, main_url)
                off = await offline_scene(b)
                seq = [await card(b, "k-title", 3.6, kind="title", title="Rock_Shiny_", sub="Rocksmith 2014 songs, in R and Shiny", items="Play|Sing|Create"),
                       m["home"], m["highway"], m["piano"], m["karaoke"],
                       await card(b, "k-creator", 2.8, kind="section", tag="New", title="RockShiny _Creator_", sub="The song studio"),
                       c["timeline"], c["edit"], c["levels"], c["stems"], c["lyrics"], c["save"], c["play"], off,
                       await card(b, "k-end", 5.0, kind="end", title="Rock_Shiny_", sub="Play \u00b7 Sing \u00b7 Create",
                                  items="`shiny::runApp()`|One offline HTML file|MIT licence")]
                total = sum(duration(x) for x in seq) - 0.5 * (len(seq) - 1)
                bed = music("teaser", total + 1, os.path.join(WORK, "teaser.wav"))
                out = os.path.join(OUT, "rockshiny-teaser.mp4")
                concat(seq, out, bed, fade=0.5)
                d = [duration(x) for x in seq]
                poster(out, sum(d[:2]) - 0.5 * 2 + 0.5 * d[2], os.path.join(OUT, "rockshiny-teaser-poster.jpg"))       # the highway
                made.append(out)
            if "tour" in parts:
                t = await tour_scenes(b, creator_url, main_url)
                sv = await tour_save_scene(b, main_url)
                off = await offline_scene(b, "tour-offline", 5.0, ("One HTML file, works offline", "RockShinyCreator.html: open a .psarc from disk, edit and save it with no server"))
                seq = [await card(b, "k-tour", 4.0, kind="title", title="RockShiny _Creator_", sub="A guided tour", items="Edit songs|Difficulty levels|Lyrics|Stems|New songs")] + t + sv + [off,
                       await card(b, "k-cant", 9.0, kind="list", title="What it can\u2019t do",
                                  items="*No transcription*: it won't write the notes of a recording for you|*Stems and automatic levels are helpers*, not studio-grade|"
                                        "*Lyrics auto-sync is a first pass*: tap or drag to finish|*Not tested in the Rocksmith game itself* yet; Rocksmith 2014 on PC or Mac only"),
                       await card(b, "k-tour-end", 4.5, kind="end", title="RockShiny _Creator_", sub="Press ? in the studio for help and the tour",
                                  items="`shiny::runApp(\"creator\")`|The Creator page of RockShiny|RockShinyCreator.html")]
                total = sum(duration(x) for x in seq) - 0.5 * (len(seq) - 1)
                bed = music("tour", total + 1, os.path.join(WORK, "tour.wav"))
                out = os.path.join(OUT, "creator-tour.mp4")
                concat(seq, out, bed, fade=0.5, music_gain_db=-5.0)
                d = [duration(x) for x in seq]
                poster(out, sum(d[:6]) - 0.5 * 6 + 0.6 * d[6], os.path.join(OUT, "creator-tour-poster.jpg"))           # difficulty levels
                made.append(out)
            await b.close()
    finally:
        for x in procs: x.terminate()
    for f in made: print("wrote %s (%.1f s, %.1f MB)" % (f, duration(f), os.path.getsize(f) / 1e6))
    shutil.rmtree(WORK, ignore_errors=True)

if __name__ == "__main__":
    asyncio.run(make(sys.argv[1:] or ["teaser", "tour"]))
