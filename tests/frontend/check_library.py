"""
Big song libraries (R/library.R, tools/karaoke_export_html.py catalogs) in a
real browser. Needs Python 3 + playwright (chromium); the app-UI part also
py-shiny (pip install shiny libsass); the lazy-server part a Wwise decoder
(pip install wem2ogg).

  python3 tests/reference/make_big_library.py /tmp/biglib       # 827 songs, 6.2 GB (once)
  python3 tests/frontend/check_library.py [/tmp/biglib]

Without a big library folder the checks run on songs/ (4 songs).

1. catalog page, static (file://): every song listed and grouped (lyrics in the
   file / from the web); search box; a song's script loads when it is picked;
   load times; the page stays small
2. catalog served lazily (karaoke_export_html.py --serve): nothing is built up
   front; picking a song builds its lyrics at once and its audio in the
   background; the audio plays; a second visit is served from disk
3. the app's library UI (app.R's sidebars rebuilt with py-shiny, which ships
   the same bslib and shiny.js): the status line, a song list of the whole
   library (grouped like karaoke_groups()), search in it, and the folder dialog
4. the small-library page is unchanged: songs/ as one songbook with embedded
   audio (the default build), song switching, settings kept over a reload
"""
import asyncio, os, shutil, socket, subprocess, sys, tempfile, textwrap, time
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tests", "reference"))
sys.path.insert(0, os.path.join(ROOT, "tools"))
LIB = sys.argv[1] if len(sys.argv) > 1 else ("/tmp/biglib" if os.path.isdir("/tmp/biglib") else os.path.join(ROOT, "songs"))
failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def wait_port(port, secs=60):
    for _ in range(int(secs * 4)):
        try: socket.create_connection(("127.0.0.1", port), 0.2).close(); return True
        except OSError: time.sleep(0.25)
    return False

PICK = """async ([q, timeout]) => {            // search, take the first match, wait until its lyrics are on stage
  const t0 = performance.now(), find = document.getElementById('rs-kp-find'), sel = document.getElementById('rs-kp-song');
  find.value = q; find.dispatchEvent(new Event('input'));
  const shown = sel.options.length, tFilter = performance.now() - t0;
  find.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
  const P = karaokePage.player, i = +sel.value;
  while (!(P.song && karaokePage.songs[i].vocals && P.song.meta.title === karaokePage.songs[i].meta.title) && performance.now() - t0 < timeout)
    await new Promise(r => setTimeout(r, 20));
  return {shown, tFilter, tSong: performance.now() - t0, i, title: P.song && P.song.meta.title, label: sel.options[sel.selectedIndex].textContent,
          lines: P.song ? P.song.lines.length : -1, lyrics: P.song && P.song.lyrics.source, loaded: !!karaokePage.songs[i].vocals}; }"""

async def catalog_static(b, cache):
    import karaoke_export_html as X
    out = os.path.join(tempfile.mkdtemp(prefix="rs-cat-"), "index.html")
    t0 = time.time()
    entries, lib = X.catalog_entries(LIB, cache=cache, progress=False)
    t_list = time.time() - t0
    X.export_catalog(entries, out, audio="none", cache=cache, online=False, jobs=4)
    t_build = time.time() - t0
    files = os.path.splitext(out)[0] + "_files"
    size_js = sum(os.path.getsize(os.path.join(files, "songs", f)) for f in os.listdir(os.path.join(files, "songs")))
    print(f"  info {len(entries)} songs listed in {t_list:.1f} s (library index), catalog built in {t_build:.1f} s (no audio): "
          f"page {os.path.getsize(out) / 1e6:.2f} MB, song scripts {size_js / 1e6:.1f} MB")
    pg = await b.new_page(viewport={"width": 1400, "height": 800}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    t0 = time.time()
    await pg.goto("file://" + out)
    await pg.wait_for_function("() => window.karaokePage && karaokePage.player.song", timeout=30000)
    t_open = time.time() - t0
    r = await pg.evaluate("""() => { const sel = document.getElementById('rs-kp-song');
      return {n: karaokePage.songs.length, options: sel.options.length, groups: [...sel.querySelectorAll('optgroup')].map(g => [g.label, g.children.length]),
              stubs: karaokePage.songs.filter(s => !s.vocals).length, find: getComputedStyle(document.getElementById('rs-kp-find')).display !== 'none',
              heap: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null}; }""")
    web = sum(1 for e in entries if not e.get("lyrics"))
    want_groups = [["Songs with lyrics", len(entries) - web], ["Lyrics from the web", web]] if len(entries) > 20 and web and web < len(entries) else []
    check(r["n"] == len(entries) and r["options"] == len(entries) and r["groups"] == want_groups and r["stubs"] == len(entries) - 1
          and (r["find"] == (len(entries) > 20)) and not errs,
          f"file:// page opens in {t_open:.2f} s with {r['options']} songs ({r['groups'] or 'no groups'}); only the first song's script "
          f"loaded ({r['stubs']} stubs); JS heap {r['heap'] or 0:.0f} MB")
    # search + pick: a song with lyrics in the file, then one whose lyrics come from the web (looked up by the page)
    withl = next(e for e in entries if e.get("lyrics"))
    q = lambda e: f"{e.get('artist') or ''} {e['title']}".strip()
    a = await pg.evaluate(PICK, [q(withl), 10000])
    check(a["loaded"] and a["title"] == withl["title"] and a["lines"] > 0 and a["lyrics"] == "archive" and a["shown"] >= 1,
          f"search '{q(withl)}': {a['shown']} match(es) in {a['tFilter']:.1f} ms; Enter opens it, lyrics on stage after {a['tSong']:.0f} ms ({a['lines']} lines)")
    webe = next((e for e in entries if not e.get("lyrics")), None)
    if webe:
        await pg.route("https://lrclib.net/**", lambda route: route.fulfill(status=404, body="[]", headers={"Access-Control-Allow-Origin": "*"}))
        a = await pg.evaluate(PICK, [q(webe), 10000])
        await pg.wait_for_timeout(300)
        banner = await pg.evaluate("() => karaokePage.player.banner.textContent")
        check(a["loaded"] and a["title"] == webe["title"] and a["lyrics"] == "lookup" and "online" in banner,
              f"a song without lyrics in the file: loaded in {a['tSong']:.0f} ms, lyrics looked up by the page (mocked: none) -> '{banner[:60]}...'")
    # stepping through many songs: every pick is a fresh script load
    t = await pg.evaluate("""async () => { const ts = [], sel = document.getElementById('rs-kp-song'); const P = karaokePage.player;
      document.getElementById('rs-kp-find').value = ''; document.getElementById('rs-kp-find').dispatchEvent(new Event('input'));
      for (let k = 0; k < 30; k++) { const i = Math.floor(k * karaokePage.songs.length / 30); const t0 = performance.now(); karaokePage.load(i);
        while (!(karaokePage.songs[i].vocals && P.song && P.song.meta.title === karaokePage.songs[i].meta.title)) await new Promise(r => setTimeout(r, 5));
        ts.push(performance.now() - t0); }
      ts.sort((a, b) => a - b); return {p50: ts[15], max: ts[29], heap: performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null}; }""")
    check(t["p50"] < 300 and not errs, f"30 songs across the list: opened in {t['p50']:.0f} ms (median), {t['max']:.0f} ms (slowest); JS heap {t['heap'] or 0:.0f} MB")
    await pg.close()
    shutil.rmtree(os.path.dirname(out), ignore_errors=True)
    return entries

async def catalog_lazy(b, cache, entries):
    try:
        import wem2ogg  # noqa: F401
    except ImportError:
        if not (shutil.which("vgmstream-cli") or shutil.which("vgmstream")):
            print("  skipped: no Wwise decoder (pip install wem2ogg)"); return
    tmp = tempfile.mkdtemp(prefix="rs-lazy-"); out = os.path.join(tmp, "index.html"); port = free_port()
    t0 = time.time()
    srv = subprocess.Popen([sys.executable, os.path.join(ROOT, "tools", "karaoke_export_html.py"), "--library", LIB, "--catalog", "-o", out,
                            "--serve", str(port), "--no-online", "--cache-dir", cache, "--audio-format", "copy"],
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        up = wait_port(port, 120); t_up = time.time() - t0
        built = len(os.listdir(os.path.join(tmp, "index_files", "songs"))) if os.path.isdir(os.path.join(tmp, "index_files", "songs")) else 0
        check(up and built == 0, f"server up in {t_up:.1f} s, {built} songs built up front")
        pg = await b.new_page(viewport={"width": 1400, "height": 800}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(f"http://127.0.0.1:{port}/index.html")
        await pg.wait_for_function("() => window.karaokePage && karaokePage.player.song", timeout=60000)
        e = entries[len(entries) // 2]
        q = f"{e.get('artist') or ''} {e['title']}".strip()
        a = await pg.evaluate(PICK, [q, 60000])
        t0 = time.time()
        await pg.wait_for_function("() => karaokePage.player.deck.kind === 'full'", timeout=180000)
        t_audio = time.time() - t0 + a["tSong"] / 1000
        played = await pg.evaluate("""async () => { const P = karaokePage.player; await P.togglePlay(); await new Promise(r => setTimeout(r, 1500));
          const t = P.clock.time(performance.now()); P.pause(); return t; }""")
        check(a["loaded"] and a["title"] == e["title"] and played > 1.0 and not errs,
              f"picked '{e['label']}': lyrics after {a['tSong']:.0f} ms, audio converted and ready after {t_audio:.1f} s "
              f"(Ogg stream repackaged, no re-encoding), plays ({played:.2f} s in 1.5 s)")
        built = sorted(os.listdir(os.path.join(tmp, "index_files", "songs")))
        await pg.reload(); await pg.wait_for_function("() => window.karaokePage && karaokePage.player.song", timeout=60000)
        a2 = await pg.evaluate(PICK, [q, 60000])
        t0 = time.time(); await pg.wait_for_function("() => karaokePage.player.deck.kind === 'full'", timeout=60000)
        check(a2["loaded"] and time.time() - t0 < 5, f"second visit: lyrics after {a2['tSong']:.0f} ms, audio after {time.time() - t0 + a2['tSong'] / 1000:.1f} s; "
              f"songs built so far: {len(built)} of {len(entries)}")
        await pg.close()
    finally:
        srv.terminate()
        try: srv.wait(5)
        except Exception: srv.kill()
        shutil.rmtree(tmp, ignore_errors=True)

# ---- the app's library UI (py-shiny replica of app.R's sidebars + mod_library.R) --------------
APP = r'''
import os, sys
sys.path.insert(0, {ref!r})
from shiny import App, ui, reactive, render
import library_ref as L
ROOT, LIB, CACHE = {root!r}, {lib!r}, {cache!r}
css = [ui.tags.link(rel="stylesheet", href="/inst/app/app.css")]
state = {{"lib": L.open_library(LIB, budget=float("inf"), cache=CACHE)}}
def bar(where):                                                   # mod_library_bar_ui()
    return ui.div(ui.HTML('<i class="fa fa-folder-open"></i>'), ui.div(ui.output_ui("bar_" + where, inline=True), class_="rs-libbar-text"),
                  ui.input_action_link("change_" + where, "Change\u2026", class_="rs-libbar-change"), class_="rs-libbar")
def side(where, label):
    return ui.sidebar(ui.input_selectize("library_" + where, label, choices=[""], options={{"placeholder": "Search songs\u2026", "maxOptions": 100000}}),
                      bar(where), ui.div(ui.output_text("info_" + where, inline=True), class_="rs-hint"), width=340, class_="rs-sidebar")
def mode(title, value, label):
    return ui.nav_panel(title, ui.layout_sidebar(side(value, label), ui.div("stage"), border=False, fillable=True), value=value)
theme = ui.Theme(preset="shiny").add_defaults(body_bg="#0b0d13", body_color="#e8eaf1", primary="#f5a524", secondary="#3a4256",
                                               font_size_base="0.9rem", border_radius="0.55rem", input_bg="#141824",
                                               white="#0b0d13", black="#e8eaf1")      # bs_theme(bg, fg) maps them to white / black
app_ui = ui.page_navbar(mode("Instrument", "instrument", "Library"), mode("Karaoke", "karaoke", "Songs"), title="RockShiny", id="mode",
                        fillable=True, padding=0, gap=0, theme=theme, navbar_options=ui.navbar_options(underline=False, collapsible=False),
                        header=ui.head_content(*css))
def short(d, width=34):                                           # library_short_dir()
    h = os.path.expanduser("~")
    d = "~" + d[len(h):] if d.startswith(h) else d
    return "\u2026" + d[-(width - 1):] if len(d) > width else d
def status(lib):                                                  # library_status_text()
    n = len(lib["songs"]); t = f"{{n}} song{{'' if n == 1 else 's'}}"
    return t + " \u00b7 large library: each song loads when picked" if lib["lazy"] else t
def server(input, output, session):
    ver = reactive.value(0)
    def lib(): ver(); return state["lib"]
    @reactive.effect
    def _():                                                      # mod_import_server() / mod_karaoke_server(): the lists
        l = lib()
        ui.update_selectize("library_instrument", choices={{"": ""}} | {{s["path"]: s["label"] for s in sorted(l["songs"], key=lambda s: s["label"].lower())}})
        g = L.karaoke_groups(l, cache=CACHE)
        ch = {{"": ""}}
        for name, k in (("Songs with lyrics", "with"), ("Find the lyrics online", "online"), ("Not checked yet", "unknown")):
            if g[k]: ch[name] = {{s["path"]: s["label"] for s in g[k]}}
        ui.update_selectize("library_karaoke", choices=ch)
    for where in ("instrument", "karaoke"):
        def make(where):
            @output(id="bar_" + where)
            @render.ui
            def _():
                l = lib()
                return ui.TagList(ui.span(short(l["dir"]), class_="rs-libbar-dir", title=l["dir"]), ui.span(status(l), class_="rs-libbar-count"))
            @reactive.effect
            @reactive.event(input["change_" + where])
            def _():                                              # the folder dialog
                ui.modal_show(ui.modal(ui.p("A folder with your Rocksmith .psarc files (and MIDI files) on the computer running RockShiny. "
                                            "Libraries of more than 50 songs are mapped at once and read song by song when you pick one.",
                                            class_="rs-hint", style="margin: 0 0 .8rem"),
                                       ui.input_text("dir", "Folder", value=lib()["dir"], width="100%"),
                                       ui.input_checkbox("recursive", "Include subfolders"), ui.output_ui("browse"),
                                       title="Song library", size="m", easy_close=True,
                                       footer=ui.TagList(ui.modal_button("Cancel"), ui.input_action_button("apply", "Use this folder", class_="btn-primary"))))
        make(where)
    @render.text
    def info_karaoke():
        g = L.karaoke_groups(lib(), cache=CACHE)
        return f"{{len(g['with'])}} of the library's songs have lyrics; {{len(g['online'])}} without are looked up online (LRCLIB) when opened."
    @reactive.effect
    @reactive.event(input.pick)
    def _(): ui.update_text("dir", value=input.pick())
    @render.ui
    def browse():
        d = os.path.expanduser((input.dir() or "").strip())
        if not os.path.isdir(d): return ui.div("No such folder.", class_="rs-libdir-msg is-error")
        d = os.path.realpath(d)
        subs = sorted(x for x in os.listdir(d) if os.path.isdir(os.path.join(d, x)) and not x.startswith("."))
        here = len(L.library_files(d))
        def pick(p, label, cls=""):
            return ui.tags.button(label, type="button", class_="rs-libdir " + cls, title=p,
                                  onclick=f"Shiny.setInputValue('pick', {{p!r}}, {{{{priority: 'event'}}}})")
        up = os.path.dirname(d)
        return ui.TagList(ui.div(f"{{here}} song file{{'' if here == 1 else 's'}} in this folder.", class_="rs-libdir-msg"),
                          ui.div(pick(up, "\u2191 Up", "is-up") if up != d else None, *[pick(os.path.join(d, s), "\U0001F4C1 " + s) for s in subs[:300]],
                                 class_="rs-libdirs"))
    @reactive.effect
    @reactive.event(input.apply)
    def _():
        d = os.path.expanduser(input.dir().strip())
        ui.modal_remove()
        state["lib"] = L.open_library(d, budget=float("inf"), cache=CACHE)
        ver.set(ver() + 1)
app = App(app_ui, server, static_assets={{"/inst": ROOT + "/inst"}})
'''

async def app_ui(b, cache, n_with):
    try:
        import shiny  # noqa: F401
    except ImportError:
        print("  skipped: py-shiny not installed"); return
    tmp = tempfile.mkdtemp(prefix="rs-libui-")
    with open(os.path.join(tmp, "app.py"), "w") as f:
        f.write(textwrap.dedent(APP.format(ref=os.path.join(ROOT, "tests", "reference"), root=ROOT, lib=LIB, cache=cache)))
    port = free_port()
    srv = subprocess.Popen([sys.executable, "-m", "shiny", "run", "--port", str(port), os.path.join(tmp, "app.py")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_port(port)
        pg = await b.new_page(viewport={"width": 1400, "height": 800}); errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        t0 = time.time()
        await pg.goto(f"http://127.0.0.1:{port}/")
        await pg.wait_for_function("() => { const s = document.getElementById('library_instrument'); return s && s.selectize && Object.keys(s.selectize.options).length > 1; }", timeout=60000)
        t_list = time.time() - t0
        g = await pg.evaluate("""() => { const r = (e) => e.getBoundingClientRect(), bar = document.querySelector('.rs-libbar'), sb = bar.closest('.sidebar');
          const dir = bar.querySelector('.rs-libbar-dir'), link = bar.querySelector('.rs-libbar-change');
          return {inside: r(bar).right <= r(sb).right - 8 && r(link).right <= r(bar).right, oneLink: r(link).height < 30,
                  ellipsis: dir.scrollWidth <= dir.clientWidth + 1 || getComputedStyle(dir).textOverflow === 'ellipsis',
                  text: bar.textContent.trim().replace(/\\s+/g, ' '), n: Object.keys(document.getElementById('library_instrument').selectize.options).filter(Boolean).length}; }""")
        check(g["inside"] and g["oneLink"] and g["ellipsis"] and not errs,
              f"status line fits the sidebar: '{g['text']}'; instrument list of {g['n']} songs filled {t_list:.1f} s after opening the page")
        r = await pg.evaluate("""async () => { const s = document.getElementById('library_instrument').selectize;
          let t0 = performance.now(); s.open(); await new Promise(r => requestAnimationFrame(() => r())); const tOpen = performance.now() - t0;
          t0 = performance.now(); s.setTextboxValue('ocean'); s.refreshOptions(true); await new Promise(r => requestAnimationFrame(() => r()));
          const tSearch = performance.now() - t0, shown = s.$dropdown_content.find('.option').length;
          const first = s.$dropdown_content.find('.option').first().attr('data-value'); s.setValue(first); s.close();
          return {tOpen, tSearch, shown, value: s.getValue() === first}; }""")
        check(r["value"] and r["tOpen"] < 1000 and r["tSearch"] < 300 and 0 < r["shown"] < g["n"],
              f"the list opens in {r['tOpen']:.0f} ms, search 'ocean' -> {r['shown']} songs in {r['tSearch']:.0f} ms, pick works")
        await pg.click("a[data-value=karaoke]")
        await pg.wait_for_function("() => { const s = document.getElementById('library_karaoke'); return s && s.selectize && Object.keys(s.selectize.options).length > 1; }", timeout=30000)
        k = await pg.evaluate("""() => { const s = document.getElementById('library_karaoke').selectize;
          return {groups: Object.keys(s.optgroups), n: Object.keys(s.options).filter(Boolean).length}; }""")
        check(k["groups"][:1] == ["Songs with lyrics"] and k["n"] >= n_with, f"karaoke list: {k['n']} songs in groups {k['groups']}")
        # the folder dialog: browse up, into a folder, apply
        await pg.click("#change_karaoke")
        await pg.wait_for_selector(".modal .rs-libdirs", timeout=10000)
        d = await pg.evaluate("""() => ({msg: document.querySelector('.rs-libdir-msg').textContent, dirs: document.querySelectorAll('.rs-libdir').length,
                                        fits: document.querySelector('.rs-libdirs').scrollWidth <= document.querySelector('.rs-libdirs').clientWidth + 1})""")
        await pg.click(".rs-libdir.is-up"); await pg.wait_for_timeout(800)
        upv = await pg.input_value("#dir")
        songs = os.path.join(ROOT, "songs")
        await pg.fill("#dir", songs); await pg.wait_for_timeout(800)
        await pg.click("#apply"); await pg.wait_for_timeout(1500)
        after = await pg.evaluate("() => ({bar: document.querySelector('#bar_karaoke .rs-libbar-count').textContent, n: Object.keys(document.getElementById('library_karaoke').selectize.options).filter(Boolean).length,"
                                  " modal: !!document.querySelector('.modal.show')})")
        check(upv == os.path.dirname(os.path.realpath(LIB)) and d["dirs"] >= 1 and d["fits"] and after["n"] == 4 and after["bar"].startswith("4 songs")
              and not after["modal"] and not errs,
              f"folder dialog: '{d['msg']}', Up -> {upv}; another folder applied -> status '{after['bar']}', karaoke list {after['n']} songs")
        await pg.screenshot(path=os.path.join(tmp, "library.png"))
        await pg.close()
    finally:
        srv.terminate()
        shutil.rmtree(tmp, ignore_errors=True)

async def songbook(b, cache):
    import karaoke_export_html as X
    tmp = tempfile.mkdtemp(prefix="rs-book-"); out = os.path.join(tmp, "index.html")
    X.main(["--library", os.path.join(ROOT, "songs"), "-o", out, "--no-online", "--cache-dir", cache])
    pg = await b.new_page(viewport={"width": 1400, "height": 800}); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.goto("file://" + out)
    await pg.wait_for_function("() => window.karaokePage && karaokePage.player.song", timeout=60000)
    r = await pg.evaluate("""async () => { const sel = document.getElementById('rs-kp-song'), P = karaokePage.player;
      const out = {n: sel.options.length, groups: sel.querySelectorAll('optgroup').length,
                   find: getComputedStyle(document.getElementById('rs-kp-find')).display, embedded: karaokePage.songs.filter(s => s.audio && s.audio.embed).length};
      karaokePage.load(2); const t0 = performance.now();
      while (!(P.deck.kind === 'full' && P.song.songKey === karaokePage.songs[2].songKey) && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 20));
      out.switched = P.song.songKey === karaokePage.songs[2].songKey && P.deck.kind === 'full';
      document.getElementById('rs-kp-bigger').click(); out.scale = P.opts ? P.opts.textScale : null;
      return out; }""")
    await pg.reload(); await pg.wait_for_function("() => window.karaokePage && karaokePage.player.song", timeout=60000)
    after = await pg.evaluate("() => ({song: karaokePage.player.song.songKey === karaokePage.songs[2].songKey, "
                              "scale: JSON.parse(localStorage.getItem('rs-karaoke-page')).opts.textScale})")
    check(r["n"] >= 3 and r["groups"] == 0 and r["find"] == "none" and r["embedded"] >= 1 and r["switched"] and after["song"]
          and after["scale"] > 1 and not errs,
          f"songs/ as one page ({os.path.getsize(out) / 1e6:.0f} MB, {r['embedded']} songs with embedded audio): {r['n']} songs, no groups or search box; "
          f"switching plays the new song; after a reload the last song and the text size ({after['scale']}) are back")
    await pg.close()
    shutil.rmtree(tmp, ignore_errors=True)

async def main():
    import karaoke_export_html as X
    cache = os.environ.get("RS_CACHE") or X.r_cache_root()
    print(f"library: {LIB}")
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"])
        print("catalog page (static, opened from disk)")
        entries = await catalog_static(b, cache)
        print("catalog served lazily (karaoke_export_html.py --serve)")
        await catalog_lazy(b, cache, entries)
        print("the app's library UI (py-shiny replica of the sidebars and the folder dialog)")
        await app_ui(b, cache, sum(1 for e in entries if e.get("lyrics")))
        print("the small-library page (songs/ as one songbook)")
        await songbook(b, cache)
        await b.close()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

asyncio.run(main())
