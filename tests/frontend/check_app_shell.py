"""
The app's shell (app.R) in a real browser, with the real bslib and shiny.js:
the page_navbar with the Instrument | Karaoke switch, one layout_sidebar per
mode, both players, inst/app/{app.css, app.js}, and app.R's mode-switch logic
(the hidden mode's player is paused).

No R is needed: py-shiny ships the same bslib (0.12) and the same client-side
shiny.js, so the page is rebuilt here with the same calls (page_navbar,
navbar_options, nav_panel, layout_sidebar, card). What it cannot check is R
server code; the players are loaded with test fixtures.

  pip install playwright shiny libsass && playwright install chromium
  python3 tests/frontend/check_app_shell.py

1. topbar: the mode switch sits next to the brand, sized to its buttons,
   vertically centred, on one row at 1440 / 700 / 420 px
2. play / pause with clicks and keys in both modes, across mode switches;
   arrows after clicking a mode tab seek (they used to switch the mode)
3. a hidden player never plays (a mode switch during the audio start-up)
4. the home page is the first page; a song played from it switches to its
   mode and shows the loading overlay until the player has the song
"""
import asyncio, os, socket, subprocess, sys, tempfile, textwrap, time
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "tests", "frontend", "fixtures")
failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

APP = r'''
from shiny import App, ui, reactive
ROOT, FIX = {root!r}, {fix!r}
css = [ui.tags.link(rel="stylesheet", href=f"/inst/{{f}}") for f in ("highway/highway.css", "karaoke/karaoke.css", "home/home.css", "app/app.css")]
js = [ui.tags.script(src=f"/inst/{{f}}") for f in ("highway/clock.js", "highway/dds.js", "highway/renderer.js", "highway/renderer-dom.js",
      "highway/renderer-lanes.js", "highway/overlays.js", "highway/input.js", "highway/mic.js", "highway/guide.js", "highway/binding.js",
      "karaoke/karaoke.js", "karaoke/karaoke-sync.js", "karaoke/karaoke-shiny.js", "home/home.js", "app/app.js")]
boot = ui.tags.script("""
$(document).on('shiny:connected', async () => {{
  const hw = document.getElementById('player-highway'), kk = document.getElementById('karaoke-stage');
  const chart = await (await fetch('/fx/modes_sultans_lead.json')).text(), song = await (await fetch('/fx/karaoke_sultans.json')).text();
  RSHighway.controllerFor(hw).load({{chart, options: {{}}}});
  RSKaraoke.playerFor(kk).load({{song, options: {{}}}});
  RSHighway.controllers.get('player-highway').setAudio('/fx/karaoke_clicks.ogg', JSON.parse(chart).songKey, 'full');
  RSKaraoke.players.get('karaoke-stage').setAudio('/fx/karaoke_clicks.ogg', JSON.parse(song).songKey, 'full');
  // the home page (R: renderHome() -> home.js), its actions go to the server like mod_home_server()'s
  const cat = await (await fetch('/fx/home_songs.json')).json();
  window.home = new RSHome.Home(document.getElementById('home_home'), {{
    action: (a) => Shiny.setInputValue('home_home_action', a, {{priority: 'event'}}) }});
  home.load({{catalog: cat.catalog, artUrl: '/fx/art/{{id}}-{{size}}.dds', user: {{playlists: [], recent: []}}}});
  // stand-in for R opening the song: a moment later the player gets it (and reports _ready)
  Shiny.addCustomMessageHandler('rs-test-open', (m) => setTimeout(() => {{
    const other = (j) => {{ const o = JSON.parse(j); o.songKey = 'opened-' + Date.now(); return JSON.stringify(o); }};   // a new song
    if (m.target === 'karaoke-stage') RSKaraoke.playerFor(kk).load({{song: other(song), options: {{}}}});
    else RSHighway.controllerFor(hw).load({{chart: other(chart), options: {{}}}});
  }}, 700));
  window.__ready = true;
}});""")
brand = ui.div(ui.HTML('<svg viewBox="0 0 32 32" class="rs-logo"><path fill="#f5a524" d="M16 2C9 2 4 5 4 10c0 8 7 17 12 20 5-3 12-12 12-20 0-5-5-8-12-8z"/></svg>'),
               ui.span("RockShiny", class_="rs-brand-name"), ui.span("play · sing", class_="rs-brand-sub"), class_="rs-brand")
theme = ui.Theme(preset="shiny").add_defaults(body_bg="#0b0d13", body_color="#e8eaf1", primary="#f5a524", secondary="#3a4256",
                                               font_size_base="0.9rem", border_radius="0.55rem")
dz = [ui.tags.link(rel="stylesheet", href="/inst/dropzone/dropzone.css"), ui.tags.script(src="/inst/dropzone/dropzone.js")]
def dropzone(value):                                             # mod_import_ui(): the dropzone around a Shiny fileInput
    return ui.div(ui.div(ui.HTML("&#9729;"), class_="rs-dropzone-icon"),
                  ui.div(ui.tags.strong("Drop a .psarc or .mid"), ui.span("or click to browse"), class_="rs-dropzone-label"),
                  ui.input_file(value + "_file", None, accept=[".psarc", ".mid"], width="100%"),
                  class_="rs-dropzone", data_accept=".psarc,.mid,.midi,.kar", tabindex="0", role="button")
def mode(title, value, player):
    return ui.nav_panel(title, ui.layout_sidebar(
        ui.sidebar(dropzone(value), ui.input_slider("s_" + value, "Text size", 60, 160, 100), width=340, class_="rs-sidebar"),
        ui.card(ui.card_body(player, padding=0), full_screen=True, class_="rs-stage"),
        border=False, border_radius=False, fillable=True), value=value)
home = ui.nav_panel("Home", ui.div(ui.div(id="home_home", class_="rs-home-output", style="width:100%;height:100%"),
                                   class_="rs-homepage"), value="home")
app_ui = ui.page_navbar(                                         # app.R: bslib::page_navbar(...)
    home,
    mode("Instrument", "instrument", ui.div(id="player-highway", class_="rs-highway", tabindex="0", style="width:100%;height:100%")),
    mode("Karaoke", "karaoke", ui.div(id="karaoke-stage", class_="rs-karaoke", tabindex="0", style="width:100%;height:100%")),
    title=brand, id="mode", fillable=True, padding=0, gap=0, theme=theme, window_title="RockShiny",
    navbar_options=ui.navbar_options(underline=False, collapsible=False),
    header=ui.head_content(*css, *dz, *js, boot))
def server(input, output, session):
    @reactive.effect
    @reactive.event(input.mode, ignore_init=True)
    async def _():                                               # app.R: one mode plays at a time
        if input.mode() != "instrument":
            await session.send_custom_message("rs-highway", {{"id": "player-highway", "cmd": "pause", "args": {{}}}})
        if input.mode() != "karaoke":
            await session.send_custom_message("rs-karaoke", {{"id": "karaoke-stage", "cmd": "pause", "args": {{}}}})
    @reactive.effect
    @reactive.event(input.instrument_file)
    async def _():                                               # mod_import_server(): an upload opens (overlay + dropzone states)
        f = input.instrument_file()[0]
        await session.send_custom_message("rs-loading", {{"target": "player-highway", "state": "start", "text": "Opening " + f["name"] + "\u2026",
                                                           "zone": "instrument_file", "name": f["name"]}})
        await session.send_custom_message("rs-test-open", {{"target": "player-highway"}})
    @reactive.effect
    @reactive.event(input["home_home_action"])
    async def _():                                               # app.R: home$request() -> the mode, with the loading overlay
        a = input["home_home_action"]()
        if a.get("op") != "play": return
        target = "karaoke-stage" if a["mode"] == "karaoke" else "player-highway"
        ui.update_navset("mode", selected=a["mode"])
        await session.send_custom_message("rs-loading", {{"target": target, "state": "start", "text": "Opening the song\u2026", "sub": "Unpacking the archive"}})
        await session.send_custom_message("rs-test-open", {{"target": target}})
app = App(app_ui, server, static_assets={{"/inst": ROOT + "/inst", "/fx": FIX}})
'''

STATE = """() => { const h = RSHighway.controllers.get('player-highway'), k = RSKaraoke.players.get('karaoke-stage');
  return {mode: document.querySelector('#mode .nav-link.active').dataset.value, hw: h.clock.playing, kk: k.clock.playing,
          hwT: h.clock.time(performance.now()), kkT: k.clock.time(performance.now())}; }"""

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

async def main():
    if not all(os.path.exists(os.path.join(FIX, f)) for f in ("karaoke_sultans.json", "karaoke_clicks.ogg", "modes_sultans_lead.json")):
        subprocess.run([sys.executable, os.path.join(ROOT, "tests", "reference", "karaoke_ref.py"), FIX], check=True)
    if not os.path.exists(os.path.join(FIX, "home_songs.json")):           # the home page's catalog (R: home_catalog())
        sys.path.insert(0, os.path.join(ROOT, "tests", "reference")); import home_ref, json
        with open(os.path.join(FIX, "home_songs.json"), "w") as f:
            json.dump(home_ref.catalog([(os.path.join(ROOT, "songs"), "library"), (os.path.join(ROOT, "inst", "examples"), "examples")],
                                       tempfile.mkdtemp(), FIX), f)
    tmp = tempfile.mkdtemp(prefix="rs-shell-")
    with open(os.path.join(tmp, "app.py"), "w") as f:
        f.write(textwrap.dedent(APP.format(root=ROOT, fix=FIX)))
    port = free_port()
    srv = subprocess.Popen([sys.executable, "-m", "shiny", "run", "--port", str(port), os.path.join(tmp, "app.py")],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}/"
    try:
        for _ in range(60):
            try: socket.create_connection(("127.0.0.1", port), 0.2).close(); break
            except OSError: time.sleep(0.25)
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            async def page(w=1400, start_mode="instrument"):
                pg = await b.new_page(viewport={"width": w, "height": 800}); errs = []
                pg.on("pageerror", lambda e: errs.append(str(e)))
                await pg.goto(url); await pg.wait_for_function("() => window.__ready", timeout=30000)
                if start_mode: await pg.click(f"a[data-value={start_mode}]"); await pg.wait_for_timeout(300)
                await pg.wait_for_function("() => RSHighway.controllers.get('player-highway').audioKind === 'full' && "
                                           "RSKaraoke.players.get('karaoke-stage').deck.kind === 'full'", timeout=30000)
                return pg, errs

            print("topbar: the mode switch")
            for w in (1440, 700, 420):
                pg, errs = await page(w)
                g = await pg.evaluate("""() => { const r = (s) => document.querySelector(s).getBoundingClientRect();
                  const nav = r('.navbar'), brand = r('.navbar-brand'), ul = r('#mode'), a = [...document.querySelectorAll('#mode .nav-link')].map(e => e.getBoundingClientRect());
                  return { gap: ul.left - brand.right, width: ul.width, rowOk: a.every(x => Math.abs(x.top - a[0].top) < 1),
                           inside: a.every(x => x.top >= ul.top - 0.5 && x.bottom <= ul.bottom + 0.5),
                           centre: Math.abs((ul.top + ul.bottom) / 2 - (nav.top + nav.bottom) / 2), navH: nav.height }; }""")
                check(0 <= g["gap"] < 40 and g["width"] < 360 and g["rowOk"] and g["inside"] and g["centre"] < 3 and g["navH"] < 70 and not errs,
                      f"{w:4d} px: switch {g['gap']:.0f} px after the brand, {g['width']:.0f} px wide, one row {g['rowOk']}, buttons inside {g['inside']}, "
                      f"off-centre {g['centre']:.1f} px, navbar {g['navH']:.0f} px high")
                await pg.close()

            print("play / pause across mode switches (clicks and keys)")
            pg, errs = await page()
            hw, kk = "#player-highway .rs-hw-btn-play", "#karaoke-stage .rs-k-btn-play"
            pg.set_default_timeout(4000)
            steps = [("click highway play", lambda: pg.click(hw), {"hw": True}),
                     ("click highway pause", lambda: pg.click(hw), {"hw": False}),
                     ("click highway play", lambda: pg.click(hw), {"hw": True}),
                     ("click Karaoke tab -> highway paused", lambda: pg.click("a[data-value=karaoke]"), {"mode": "karaoke", "hw": False}),
                     ("Space -> karaoke plays", lambda: pg.keyboard.press("Space"), {"kk": True}),
                     ("ArrowRight seeks, stays in karaoke", lambda: pg.keyboard.press("ArrowRight"), {"mode": "karaoke", "kk": True}),
                     ("click karaoke pause", lambda: pg.click(kk), {"kk": False}),
                     ("click karaoke play", lambda: pg.click(kk), {"kk": True}),
                     ("click Instrument tab -> karaoke paused", lambda: pg.click("a[data-value=instrument]"), {"mode": "instrument", "kk": False}),
                     ("ArrowLeft stays in instrument", lambda: pg.keyboard.press("ArrowLeft"), {"mode": "instrument", "hw": False}),
                     ("Space -> highway plays", lambda: pg.keyboard.press("Space"), {"hw": True, "kk": False}),
                     ("Space -> highway pauses", lambda: pg.keyboard.press("Space"), {"hw": False}),
                     ("Home stays in instrument", lambda: pg.keyboard.press("Home"), {"mode": "instrument"}),
                     ("click Karaoke tab, click play", lambda: pg.click("a[data-value=karaoke]"), {"mode": "karaoke"}),
                     ("click karaoke play", lambda: pg.click(kk), {"kk": True, "hw": False}),
                     ("click karaoke pause", lambda: pg.click(kk), {"kk": False})]
            bad = []
            for label, act, want in steps:
                before = await pg.evaluate(STATE)
                try: await act()
                except Exception as e: bad.append(f"{label}: {str(e).splitlines()[0]}"); continue
                await pg.wait_for_timeout(600)
                st = await pg.evaluate(STATE)
                if any(st[k] != v for k, v in want.items()): bad.append(f"{label}: {st}")
                if label.startswith("ArrowRight") and not (st["kkT"] - before["kkT"] > 4): bad.append(f"{label}: no +5 s seek ({before['kkT']:.1f} -> {st['kkT']:.1f})")
            check(not bad and not errs, f"{len(steps)} steps as expected" + (f"; wrong: {bad}" if bad else "") + (f"; errors {errs}" if errs else ""))
            await pg.close()

            print("a hidden player never plays (mode switch while the audio starts up)")
            for first, to in ((hw, "karaoke"), (kk, "instrument")):
                pg, errs = await page()
                if to == "instrument": await pg.click("a[data-value=karaoke]"); await pg.wait_for_timeout(400)
                await pg.evaluate("""() => { const E = RSHighway.AudioOut.prototype.ensure;     // a slow audio device
                  RSHighway.AudioOut.prototype.ensure = async function () { await new Promise(r => setTimeout(r, 350)); return E.call(this); }; }""")
                await pg.click(first); await pg.wait_for_timeout(60); await pg.click(f"a[data-value={to}]"); await pg.wait_for_timeout(1200)
                st = await pg.evaluate(STATE)
                check(not st["hw"] and not st["kk"] and st["mode"] == to and not errs,
                      f"play pressed in {'instrument' if to == 'karaoke' else 'karaoke'}, switched to {to} during start-up: nothing plays ({st['hw']}, {st['kk']})")
                await pg.close()

            print("home page: the first page; a song played from it opens in its mode, with a loading overlay")
            pg, errs = await page(start_mode=None)
            r = await pg.evaluate("""() => ({ mode: document.querySelector('#mode .nav-link.active').dataset.value,
              tabs: [...document.querySelectorAll('#mode .nav-link')].map(a => a.dataset.value),
              h: document.querySelector('#home_home').getBoundingClientRect().height, shelves: document.querySelectorAll('#home_home .rs-h-shelf').length })""")
            res = {}
            for m, card in (("karaoke", ".rs-h-shelf:has(h2:text('Sing along')) .rs-h-card >> nth=0"), ("instrument", ".rs-h-shelf:has(h2:text('Albums')) .rs-h-card >> nth=1")):
                await pg.click("a[data-value=home]"); await pg.wait_for_timeout(300)
                await pg.click(f".rs-h-mode-btn[data-mode={m}]")
                await pg.hover(card); await pg.click(card + " >> .rs-h-playfab")
                target = "karaoke-stage" if m == "karaoke" else "player-highway"
                try: await pg.wait_for_function(f"() => !!document.querySelector('#{target}').parentElement.querySelector('.rs-loading.is-on')", timeout=3000)
                except Exception: pass
                shown = await pg.evaluate(f"() => [document.querySelector('#mode .nav-link.active').dataset.value, "
                                          f"!!document.querySelector('#{target}').parentElement.querySelector('.rs-loading.is-on'), "
                                          f"(document.querySelector('#{target}').parentElement.querySelector('.rs-loading b') || {{}}).textContent]")
                await pg.wait_for_timeout(1500)
                gone = await pg.evaluate(f"() => !document.querySelector('#{target}').parentElement.querySelector('.rs-loading.is-on')")
                res[m] = (shown, gone)
            check(r["mode"] == "home" and r["tabs"] == ["home", "instrument", "karaoke"] and r["h"] > 600 and r["shelves"] >= 3
                  and all(v[0][0] == m and v[0][1] and v[1] for m, v in res.items()) and not errs,
                  f"opens on {r['mode']} ({r['h']:.0f} px high, {r['shelves']} shelves); tabs {r['tabs']}; "
                  + "; ".join(f"{m}: switched to {v[0][0]}, overlay '{v[0][2]}' shown {v[0][1]}, gone when the player had the song {v[1]}" for m, v in res.items()))
            await pg.close()

            print("upload: the dropzone shows uploading -> opening -> done; the player shows the overlay meanwhile")
            pg, errs = await page()
            await pg.evaluate("""() => { const z = document.querySelector('#instrument_file').closest('.rs-dropzone'); window.__dz = [];
              new MutationObserver(() => { const s = ['is-uploading', 'is-opening', 'is-done', 'is-failed'].find(c => z.classList.contains(c)) || 'idle';
                if (__dz[__dz.length - 1] !== s) __dz.push(s); window.__dzText = z.querySelector('.rs-dz-msg') && z.querySelector('.rs-dz-msg').textContent; })
                .observe(z, {attributes: true, attributeFilter: ['class']}); }""")
            big = os.path.join(ROOT, "songs", "Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc")
            await pg.set_input_files("#instrument_file", big)
            await pg.wait_for_timeout(500)
            mid = await pg.evaluate("() => [__dzText, !!document.querySelector('#player-highway').parentElement.querySelector('.rs-loading.is-on')]")
            await pg.wait_for_timeout(3500)
            seq = await pg.evaluate("() => __dz")
            check(seq[:3] == ["is-uploading", "is-opening", "is-done"] and seq[-1] == "idle" and mid[1] and not errs,
                  f"dropzone states {seq} ('{mid[0]}'); player overlay while opening: {mid[1]}")
            await pg.close()
            await b.close()
    finally:
        srv.terminate()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

asyncio.run(main())
