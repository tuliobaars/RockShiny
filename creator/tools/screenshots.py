"""
Feature screenshots of RockShiny Creator for the README (docs/screenshots/*.jpg,
2880 x 1800): the running apps themselves in headless Chromium, with real
songs from songs/ and their own audio.

  python3 creator/tools/screenshots.py STANDALONE_URL MAIN_URL [OUT_DIR] [NEW_SONG_AUDIO] [--tuner]

STANDALONE_URL: shiny::runApp("creator"), MAIN_URL: RockShiny's app.R (the
Creator page), both reading a library with the songs used below (Riding With
The King, Get Lucky, Sultans of Swing, Wish You Were Here, Still Got the Blues);
the offline page is creator/RockShinyCreator.html. The new song's audio is made
by tools/video/music.py unless given. The tuner shot runs a second browser whose
microphone plays a plucked guitar (tests/js/cli.js guitar-wav); --tuner takes
only that one again.
"""
import asyncio, os, subprocess, sys, json, tempfile
sys.dont_write_bytecode = True                 # (imports tools/video/music.py: no __pycache__ in creator/)
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CREATOR = os.path.abspath(os.path.join(HERE, ".."))
ROOT = os.path.abspath(os.path.join(CREATOR, ".."))
SONGS = os.path.join(ROOT, "songs")
ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
STANDALONE, MAIN = ARGS[0], ARGS[1]
OUT = ARGS[2] if len(ARGS) > 2 else os.path.join(CREATOR, "docs", "screenshots")
os.makedirs(OUT, exist_ok=True)
S = "[...RSCreator.shinyStudios.values()][0]"
TMP = tempfile.mkdtemp(prefix="rsc-shots-")
DEMO_WAV = ARGS[3] if len(ARGS) > 3 else os.path.join(TMP, "Neon Harbor - Midnight Drive.wav")
if not os.path.exists(DEMO_WAV):
    sys.path.insert(0, os.path.join(HERE, "video"))
    import music
    music.write(DEMO_WAV, music.render("teaser", 42))
manifest = []

async def shot(pg, name, title, caption, settle=500):
    await pg.evaluate("document.querySelectorAll('.rsc-toast').forEach(t => t.classList.remove('is-on'))")
    if settle: await pg.wait_for_timeout(settle)
    await pg.screenshot(path=os.path.join(OUT, name), type="jpeg", quality=88)
    manifest.append({"file": name, "title": title, "caption": caption})
    print("saved", name)

async def new_page(browser):
    pg = await browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1.8, accept_downloads=True)
    pg.on("pageerror", lambda e: print("PAGEERROR", e))
    return pg

async def open_library(pg, query, studio=S):
    await pg.click("#creator-project-library + .selectize-control .selectize-input")
    await pg.keyboard.type(query); await pg.wait_for_timeout(400); await pg.keyboard.press("Enter")
    await pg.wait_for_function(studio + ".project && " + studio + ".audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=180000)
    await pg.wait_for_timeout(800)

async def view(pg, t0, pps, pos=None, studio=S):
    await pg.evaluate("(() => { const s = %s; s.view.pps = %f; s.view.t0 = %f; %s s.clampView(); s.drawNow(); })()" %
                      (studio, pps, t0, ("s.audio.pos = %f;" % pos) if pos is not None else ""))
    await pg.wait_for_timeout(300)

async def busiest(pg, span, studio=S, need_lyrics=True):
    """Start of the `span`-second window with the most notes, chords and syllables (all of them present)."""
    return await pg.evaluate("""(() => { const s = %s, p = s.project, ev = [];
      p.arrangements.forEach((a, i) => { const lv = a.doc.levels[0]; for (const n of lv.notes) ev.push([n.time, 'a' + i]); for (const c of lv.chords) ev.push([c.time, 'a' + i]); });
      if (p.vocals) for (const y of p.vocals.syllables) ev.push([y.time, 'v']);
      const kinds = new Set(ev.map(e => e[1])); let best = 0, bt = 0;
      for (let t = 5; t < s.duration() - %f; t += 0.5) { const w = ev.filter(e => e[0] >= t && e[0] < t + %f);
        const have = new Set(w.map(e => e[1])); const score = w.length * (have.size === kinds.size ? 2 : 1) * (%s || have.has('v') ? 1 : 0.2);
        if (score > best) { best = score; bt = t; } }
      return bt; })()""" % (studio, span, span, "false" if need_lyrics else "true"))

async def tuner_shot(p):
    """17. the tuner: a microphone playing a plucked guitar, notes written at the playhead."""
    wav = os.path.join(TMP, "guitar-notes.wav")
    subprocess.run(["node", os.path.join(CREATOR, "tests", "js", "cli.js"), "guitar-wav", "notes", wav], check=True)
    b2 = await p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                                      "--use-file-for-fake-audio-capture=%s%%noloop" % wav, "--autoplay-policy=no-user-gesture-required"])
    ctx = await b2.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=1.8)
    await ctx.grant_permissions(["microphone"])
    pg = await ctx.new_page()
    await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
    await pg.click('[data-rsc-what="demo"]')
    await pg.wait_for_function(S + ".project && " + S + ".project.meta.title === 'Night Drive' && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
    await pg.evaluate("(() => { const s = %s, lv = s.project.arrangements[0].doc.levels[0]; s.edit('clear', ['arr:0'], () => { lv.notes = lv.notes.filter(n => n.time < 9.6 || n.time > 15); });"
                      " s.selectLane('arr:0'); s.insTab = 'edit'; s.renderInspector(); s.audio.seek(9.6);"
                      " s.snap = 2; s.root.querySelector('[data-role=snap]').value = '2'; })()" % S)
    await view(pg, 7.6, 120, 9.6)
    await pg.click('[data-act="tuner:open"]')
    # the moment the 5th note (B3) has gone in and still sounds
    await pg.wait_for_function("(() => { const s = RSCreator.tuner.state(); return s && s.written.length >= 5 && s.note === 'B3'; })()", timeout=20000, polling=10)
    await shot(pg, "17-tuner.jpg", "Play it in with the tuner",
               "The tuner listens to your guitar or bass: the note and how many cents off, or the chord of each strum. In Step mode each note goes in at the playhead, on the string and fret nearest your hand, and the playhead moves on; Record writes what you play along with the song. Here the demo song, Night Drive, which the Creator makes from scratch.", settle=0)
    await b2.close()

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])

        # 1. the studio: a song open, charts, lyrics, sections, beats, the mix
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Riding")
        t = await busiest(pg, 8)
        await view(pg, t, 92, t + 3.1)
        await shot(pg, "01-studio.jpg", "The studio",
                   "Riding With The King open in the standalone app: the mix, the lead and rhythm charts drawn as tablature (chords framed and named, sustains, techniques), the lyrics syllable by syllable, sections and the beat grid on one timeline.")

        # 2. chart editing: a bent note selected, the inspector, the tooltip
        n = await pg.evaluate("""(() => { const s = %s, lv = s.project.arrangements[0].doc.levels[0]; const n = lv.notes.find(x => x.bend > 0 && x.time > 60 && x.sustain > 0.3); return {t: n.time, s: n.string}; })()""" % S)
        await view(pg, n["t"] - 3.2, 150, n["t"] - 1)
        pos = await pg.evaluate("""(() => { const s = %s, lane = s.lanes.find(l => l.id === 'arr:0'), r = s.wrap.getBoundingClientRect();
            return {x: r.left + s.x(%f) + 7, y: r.top + lane.y + 20 + (lane.strings - 1 - %d) * 15 + 7}; })()""" % (S, n["t"], n["s"]))
        await pg.mouse.click(pos["x"], pos["y"]); await pg.wait_for_timeout(300)
        await pg.mouse.move(pos["x"] + 2, pos["y"] + 1); await pg.wait_for_timeout(400)
        await shot(pg, "02-chart-editing.jpg", "Chart editing",
                   "A note selected: fret, string, sustain, bend, slide and every technique in the inspector (or from the keyboard: type the fret, H P B S V...). Draw, move, stretch, erase, quantize, copy and paste, with undo.")

        # 3. song details: the Song tab
        await pg.keyboard.press("Escape")
        await pg.click('[data-tab="song"]'); await view(pg, 40, 30, 52)
        await shot(pg, "03-song.jpg", "Song details and charts",
                   "Title, artist, album, sorting, volumes and album art (any image, stored as the game's DDS); add a lead, rhythm, bass or combo chart in any tuning.")

        # 4. lyrics: import LRC timed for another recording, auto-sync
        lrc = await pg.evaluate("""(() => { const S = %s.project.vocals.syllables, L = []; let cur = null;
          for (const s of S) { if (!cur) { cur = {t: s.time, w: ''}; L.push(cur); } cur.w += s.lyric.replace(/[+-]$/, '') + (/-$/.test(s.lyric) ? '' : ' '); if (/\\+$/.test(s.lyric)) cur = null; }
          const f = (t) => { t += 1.6; const m = Math.floor(t / 60); return '[' + String(m).padStart(2, '0') + ':' + (t - 60 * m).toFixed(2).padStart(5, '0') + ']'; };
          return L.map(l => f(l.t) + l.w.trim()).join('\\n'); })()""" % S)
        await pg.click('[data-tab="lyrics"]'); await pg.fill('[data-role="paste"]', lrc); await pg.click('[data-act="lyr:paste"]')
        await pg.click('[data-act="lyr:auto"]')
        await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on')", timeout=120000)
        await pg.evaluate("document.querySelector('[data-role=paste]').value = %s" % json.dumps("\n".join(lrc.split("\n")[:6])))
        await view(pg, 20, 60, 24)
        await shot(pg, "04-lyrics.jpg", "Lyrics, synced to the recording",
                   "Timed lyrics (LRCLIB, a .lrc file or pasted) become Rocksmith syllables. Auto-sync lays them over where the recording sings (here 1.6 s off, moved back): a voice model hears the singing, drawn as the band under the lyrics with a line under each sung phrase. Then tap-sync, stretch or drag any syllable.")

        # 5. stems
        await pg.click('[data-tab="stems"]')
        await pg.evaluate("(() => { const s = %s; s.laneState['arr:0'] = {collapsed: true}; s.laneState['arr:1'] = {collapsed: true}; s.buildLanes(); })()" % S)
        await pg.click('[data-act="stems:run"]')
        await pg.wait_for_function(S + ".audio.stems && !document.querySelector('.rsc-busy.is-on')", timeout=280000)
        await pg.click('[data-act="mute:vocals"]')
        await view(pg, 60, 22, 84)
        await shot(pg, "05-stems.jpg", "Instrument stems",
                   "Vocals, guitar, bass, drums and the rest, separated using the song's own charts (a harmonic comb at every charted note) and lyrics; mute, solo and mix them, download each as WAV or keep them next to the song. Here: the vocals muted to sing along.")
        await pg.close()

        # 6. beats
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Get Lucky")
        await pg.click('[data-tab="beats"]')
        await view(pg, 29.5, 130, 31.2)
        bx = await pg.evaluate("""(() => { const s = %s, lane = s.lanes.find(l => l.id === 'beats'), b = s.project.beats.find(x => x.time > 31 && x.measure >= 0), r = s.wrap.getBoundingClientRect();
           return {x: r.left + s.x(b.time), y: r.top + lane.y + lane.h / 2}; })()""" % S)
        await pg.mouse.click(bx["x"], bx["y"]); await pg.wait_for_timeout(200)
        await pg.click('[data-tab="beats"]')
        await shot(pg, "06-beats.jpg", "Beats and tempo",
                   "The beat grid the notes snap to and the game counts bars by: detected from the audio, or a tempo from any beat on; drag a beat, set bar starts, x2 / /2, shift the whole chart, metronome on playback.")

        # 7. a new song from an audio file
        await pg.set_input_files("#creator-project-file", DEMO_WAV)
        await pg.wait_for_selector("#creator-project-create", timeout=30000)
        await pg.fill("#creator-project-album", "Night Shift")
        await pg.wait_for_timeout(600)
        await shot(pg, "07-new-song.jpg", "A new song from an audio file",
                   "Drop an mp3, ogg, wav, flac or m4a (or a Wwise .wem): the details come from the file name, the beat grid from the audio, and empty lead / rhythm / bass charts are ready to draw in.")
        await pg.click("#creator-project-create")
        await pg.wait_for_function(S + ".project && " + S + ".project.meta.title === 'Midnight Drive' && !document.querySelector('.rsc-busy.is-on')", timeout=120000)
        await pg.evaluate("""(() => { const s = %s, lv = s.project.arrangements[0].doc.levels[0], B = s.project.beats, E = RSCreator.engine;
            const riff = [[0, 3, 5], [0, 3, 7], [1, 5, 5], [1, 3, 7], [0, 3, 5], [1, 2, 5], [2, 2, 7], [1, 2, 5]];
            for (let i = 4; i < 40; i++) { const [k, str, f] = riff[i %% riff.length]; lv.notes.push(Object.assign({}, E.NOTE_DEFAULTS, {time: B[i].time, string: str, fret: f + k, sustain: i %% 4 === 3 ? (B[i+1].time - B[i].time) * 0.9 : 0, bendValues: []})); }
            RSCreator.sortLevel(lv); s.project.arrangements[0].edited = true; s.refreshGuides(); s.drawNow(); })()""" % S)
        await pg.click('[data-tab="edit"]'); await view(pg, 0, 70, 6)
        await pg.close()

        # 8. save to the library, checked by RockShiny's readers
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Sultans")
        await pg.evaluate(S + ".edit('Title', ['meta'], () => { " + S + ".project.meta.album = 'Money for Nothing (remaster)'; })")
        t = await busiest(pg, 9)
        await view(pg, t, 70, t + 4)
        await pg.click("#creator-export-save")
        await pg.wait_for_selector("#creator-export-report .rsc-report", timeout=120000)
        await shot(pg, "08-save.jpg", "Save for PC or Mac, checked",
                   "The package is built in the browser (unchanged files byte for byte, edited charts recompiled), saved into the library and read back with RockShiny's own parsers: every chart's XML and SNG must agree.")
        await pg.close()

        # 9. inside RockShiny: the Creator page of the main app
        pg = await new_page(b)
        await pg.goto(MAIN); await pg.wait_for_timeout(4500)
        await pg.click("#mode .nav-link[data-value='creator']"); await pg.wait_for_timeout(1000)
        await open_library(pg, "Wish You")
        t = await busiest(pg, 9)
        await view(pg, t, 80, t + 4)
        await shot(pg, "09-in-rockshiny.jpg", "A page of RockShiny",
                   "The same module plugged into the RockShiny app: Home | Instrument | Karaoke | Creator. A song saved here opens at once in the Instrument or Karaoke mode (Play it / Sing it).")
        await pg.close()

        # 10. the offline page
        pg = await new_page(b)
        await pg.goto("file://" + os.path.join(CREATOR, "RockShinyCreator.html")); await pg.wait_for_timeout(600)
        await pg.set_input_files('[data-role="file"]', os.path.join(SONGS, "Gary-Moore_Still-Got-the-Blues-Live_v1_m.psarc"))
        await pg.wait_for_function("creator.project && creator.audio.mix && !document.querySelector('.rsc-busy.is-on')", timeout=180000)
        t = await busiest(pg, 9, "creator")
        await pg.evaluate("creator.view.pps = 75; creator.view.t0 = %f; creator.audio.pos = %f; creator.clampView(); creator.drawNow()" % (t, t + 4))
        await shot(pg, "10-offline.jpg", "One offline HTML file",
                   "RockShinyCreator.html: the whole studio in one file that opens from disk with no server and no network. .psarc files are read, decoded (Wwise audio included), edited and written in the page.")
        await pg.close()

        # 11. difficulty levels kept and edited by hand
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Get Lucky")
        await pg.click('.rsc-insp-tabs [data-tab="levels"]')
        await pg.evaluate("(() => { const s = %s; s.laneState['arr:2'] = {collapsed: true}; s.laneState['arr:3'] = {collapsed: true}; s.buildLanes(); })()" % S)
        await pg.click('[data-act="dd:view:1"]')
        t = await busiest(pg, 8, need_lyrics=False)
        await view(pg, t, 95, t + 3)
        await pg.click('.rsc-insp-tabs [data-tab="levels"]')
        await shot(pg, "11-levels.jpg", "Difficulty levels, kept and edited",
                   "Get Lucky's own difficulty levels, kept when the song is edited. The lead at level 1 of 0-7 (what a beginner plays), with the notes of the full chart it leaves out as dashed ghosts; the bonus lead below plays the full chart. Pick a level, edit it like any chart, add or remove a level for one part or everywhere; PgUp / PgDn step through the levels.")
        await pg.close()

        # 12. difficulty levels built automatically
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Sultans")
        await pg.evaluate("(() => { const s = %s; s.laneState['arr:0'] = {collapsed: true}; s.laneState['arr:2'] = {collapsed: true}; s.buildLanes(); s.selectLane('arr:1'); })()" % S)
        await pg.click('.rsc-insp-tabs [data-tab="levels"]')
        await pg.click('[data-act="dd:auto:all"]')
        await pg.wait_for_function(S + ".project.arrangements[1].dd && !document.querySelector('.rsc-busy.is-on')", timeout=60000)
        await pg.click('[data-act="dd:view:2"]')
        t = await busiest(pg, 8, need_lyrics=False)
        await view(pg, t, 110, t + 2)
        await pg.click('.rsc-insp-tabs [data-tab="levels"]')
        await shot(pg, "12-auto-levels.jpg", "Easier levels, created automatically",
                   "Sultans of Swing has no levels: 'Create easier levels' makes them from the full chart, as chart authors do: the strongest beats first, chords on fewer strings at easy levels, more levels for busy parts. Here the rhythm part at level 2, the rest of the full chart as dashed ghosts. Saved, RockShiny's difficulty slider uses the levels.")
        await pg.close()

        # 13. the Help dialog
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Riding")
        t = await busiest(pg, 9)
        await view(pg, t, 70, t + 4)
        await pg.click('[data-rsc-what="help"]'); await pg.click('[data-sec="can"]'); await pg.wait_for_timeout(300)
        await shot(pg, "13-help.jpg", "Help built in",
                   "The Help dialog (the ? button, the ? key, or Help in the sidebar): start here, what the Creator can do, what it can't do (drafts by ear are rough, stems and automatic levels are helpers, not studio-grade...), how difficulty levels work, and every shortcut.")
        await pg.keyboard.press("Escape")

        # 14. the guided tour
        await pg.click('[data-rsc-what="tour"]'); await pg.wait_for_timeout(300)
        for _ in range(20):
            st_ = await pg.evaluate("RSCreator.tour.step()")
            if not st_ or st_["title"] == "Difficulty levels": break
            await pg.click('[data-tour="next"]'); await pg.wait_for_timeout(300)
        await pg.wait_for_timeout(400)
        await shot(pg, "14-tour.jpg", "A guided tour",
                   "Take the tour: a spotlight moves over each part of the studio and of its page (open, the library, save) with a card that explains it; arrow keys to step, Esc to leave. Here: the difficulty levels.")
        await pg.close()

        # 15. sync each line: lyrics of another take, lines off on their own, over the voice
        pg = await new_page(b)
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Wish You")
        await pg.click('.rsc-insp-tabs [data-tab="lyrics"]')
        await pg.evaluate("""(() => { const st = %s, S = st.project.vocals.syllables, li = RSCreator.sync.lineIndex(S), L = RSCreator.voice.linesOf(S);
            const starts = L.map((l, i) => l.start + 0.9 + 0.004 * (l.start - L[0].start) + 0.6 * Math.sin(i * 2.7));
            st.edit('Another take', ['vocals'], () => { st.project.vocals.syllables = RSCreator.sync.retime(S, li, starts); }); st.renderInspector(); })()""" % S)
        await pg.click('[data-act="lyr:lines"]')
        await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on') && %s.showVoice" % S, timeout=180000)
        await pg.evaluate("(() => { const s = %s; for (const l of s.lanes) if (/^arr:/.test(l.id)) s.laneState[l.id] = {collapsed: true}; s.buildLanes(); })()" % S)
        lt = await pg.evaluate("%s.project.vocals.syllables[0].time" % S)
        await view(pg, lt - 9, 40, lt + 6)
        await shot(pg, "15-voice-sync.jpg", "Lyrics over the voice",
                   "Show the voice: where someone sings, as the band under the lyrics (how sure the voice model is) and a line under each sung phrase; the gaps are the silences. Sync each line fits lyrics of another take (here 0.4 % slower and every line off on its own) line by line onto the singing.")
        await pg.close()

        # 16. a draft of the chords from the recording
        pg = await new_page(b)
        pg.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await pg.goto(STANDALONE); await pg.wait_for_timeout(3000)
        await open_library(pg, "Still Got")
        ri = await pg.evaluate("%s.project.arrangements.findIndex(a => a.kind === 'rhythm')" % S)
        t = await pg.evaluate("(() => { const lv = %s.project.arrangements[%d].doc.levels[0]; return lv.chords[Math.floor(lv.chords.length * 0.3)].time; })()" % (S, ri))
        await pg.evaluate("(() => { const s = %s; for (const l of s.lanes) if (/^arr:/.test(l.id) && l.id !== 'arr:%d') s.laneState[l.id] = {collapsed: true}; s.buildLanes();"
                          " s.audio.loop = {on: true, a: %f, b: %f}; s.selectLane('arr:%d'); s.insTab = 'edit'; s.renderInspector(); })()" % (S, ri, t, t + 14, ri))
        await pg.click('[data-act="fill:draft"]')
        await pg.wait_for_function("!document.querySelector('.rsc-busy.is-on') && %s.undoStack.length > 0" % S, timeout=180000)
        await view(pg, t + 0.3, 125, t + 4)
        await shot(pg, "16-draft.jpg", "A chart drafted by ear",
                   "Fill this chart by ear: Draft the chords listens to the recording over the loop range and writes a chord on every beat, in shapes for the chart's tuning (a bass chart gets the chords' roots). A rough start, about half the chords right on the sample songs: listen with the headphones button and fix the rest.")
        await pg.close()
        await b.close()

        await tuner_shot(p)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)

async def only_tuner():
    """--tuner: just the tuner's shot (its manifest entry is kept)."""
    async with async_playwright() as p:
        await tuner_shot(p)

if "--tuner" in sys.argv: asyncio.run(only_tuner())
else: asyncio.run(main())
