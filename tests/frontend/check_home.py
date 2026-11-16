"""
The home screen (inst/home/home.js) in a real browser. Needs Python 3 +
playwright (chromium).

  python3 tests/frontend/check_home.py [/tmp/biglib]

The catalog is made from songs/ (plus the bundled MIDI demo) the way R's
home_catalog() makes it (library index via tests/reference/library_ref.py, ids =
md5 of the path), with the songs' real album art; a big library folder, when
given (or /tmp/biglib exists), is used for the performance checks.

1. home: greeting, quick tiles, shelves (sing along, artists, albums, recently
   added), album art painted from the archives' DDS files, no errors
2. navigation: artist / album / genre pages, back and forward, search
3. playing: card and row buttons send {op: "play", ids, start, mode, context};
   the "Open in" switch; MIDI songs are left out when singing
4. playlists: create (opens it), add from a menu, reorder by dragging, remove,
   rename, delete -- round-tripped through a stand-in for the R side
5. genres: set by hand for an artist -> a Genres shelf and a genre page
6. a big library: load, home, all albums, search -- times and DOM size
"""
import asyncio, functools, http.server, json, os, sys, threading, time
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "tests", "frontend", "fixtures")
sys.path.insert(0, os.path.join(ROOT, "tests", "reference"))
import home_ref as HR
BIG = (sys.argv[1] if len(sys.argv) > 1 else "/tmp/biglib")
BIG = BIG if BIG and os.path.isdir(BIG) else None
PORT = 8797
failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

async def main():
    import tempfile
    cache = tempfile.mkdtemp(prefix="rs-home-cache-")
    os.makedirs(FIX, exist_ok=True)
    with open(os.path.join(FIX, "home_songs.json"), "w") as f:
        json.dump(HR.catalog([(os.path.join(ROOT, "songs"), "library"), (os.path.join(ROOT, "inst", "examples"), "examples")], cache, FIX), f)
    if BIG:
        t0 = time.time()
        with open(os.path.join(FIX, "home_big.json"), "w") as f:
            json.dump(HR.catalog([(BIG, "library")], cache, FIX), f)
        print(f"  info big catalog from {BIG}: {time.time() - t0:.1f} s to build the fixture ({os.path.getsize(os.path.join(FIX, 'home_big.json')) / 1e3:.0f} KB)")
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), functools.partial(Q, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{PORT}/tests/frontend/home_harness.html"
    async with async_playwright() as p:
        b = await p.chromium.launch()
        async def page(cat="home_songs", w=1440, h=900):
            pg = await b.new_page(viewport={"width": w, "height": h}); errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(f"{base}?catalog={cat}"); await pg.wait_for_function("() => window.__ready")
            return pg, errs
        last = lambda pg: pg.evaluate("() => __actions[__actions.length - 1]")

        print("home view")
        pg, errs = await page()
        await pg.wait_for_timeout(800)
        r = await pg.evaluate("""() => ({ greet: document.querySelector('.rs-h-homehero h1').textContent,
          tiles: document.querySelectorAll('.rs-h-quicktile').length,
          shelves: [...document.querySelectorAll('.rs-h-shelf-head h2')].map(e => e.textContent),
          art: document.querySelectorAll('.rs-h-art.has-art').length, songs: home.songs.length,
          side: document.querySelectorAll('.rs-h-side-list .rs-h-row').length })""")
        check(r["greet"] and r["tiles"] >= 4 and {"Sing along", "Artists", "Albums", "Recently added"} <= set(r["shelves"]) and r["art"] > 0 and not errs,
              f"'{r['greet']}', {r['tiles']} quick tiles, shelves {r['shelves']}, {r['art']} covers painted from the archives' art, {r['songs']} songs")

        print("navigation")
        await pg.click(".rs-h-shelf:has(h2:text('Artists')) .rs-h-card >> nth=0")
        a = await pg.evaluate("() => ({ view: home.route.view, type: document.querySelector('.rs-h-hero-type').textContent, "
                              "title: document.querySelector('.rs-h-hero-title').textContent, rows: document.querySelectorAll('.rs-h-track:not(.is-head)').length })")
        await pg.click(".rs-h-shelf:has(h2:text('Albums')) .rs-h-card >> nth=0")
        al = await pg.evaluate("() => ({ view: home.route.view, rows: document.querySelectorAll('.rs-h-track:not(.is-head)').length, "
                               "hero: getComputedStyle(document.querySelector('.rs-h-hero')).getPropertyValue('--hero') })")
        await pg.click(".rs-h-nav button >> nth=0"); await pg.wait_for_timeout(100)
        back = await pg.evaluate("() => home.route.view")
        await pg.click(".rs-h-nav button >> nth=1"); await pg.wait_for_timeout(100)
        fwd = await pg.evaluate("() => home.route.view")
        await pg.fill(".rs-h-search input", "sultans"); await pg.wait_for_timeout(150)
        s = await pg.evaluate("() => ({ view: home.route.view, rows: [...document.querySelectorAll('.rs-h-track:not(.is-head) .rs-h-tt-text b')].map(e => e.textContent) })")
        await pg.press(".rs-h-search input", "Escape"); await pg.wait_for_timeout(100)
        esc = await pg.evaluate("() => home.route.view")
        check(a["view"] == "artist" and a["type"] == "Artist" and a["rows"] >= 1 and al["view"] == "album" and al["rows"] >= 1
              and back == "artist" and fwd == "album" and s["view"] == "search" and s["rows"] == ["Sultans of Swing"] and esc == "album" and not errs,
              f"artist page '{a['title']}' ({a['rows']} songs) -> album page ({al['rows']}, backdrop {al['hero'].strip()}); back -> {back}, forward -> {fwd}; "
              f"search 'sultans' -> {s['rows']}; Escape -> {esc}")

        print("playing")
        await pg.evaluate("() => home.go({view: 'home'})")
        await pg.hover(".rs-h-shelf:has(h2:text('Albums')) .rs-h-card >> nth=0")
        await pg.click(".rs-h-shelf:has(h2:text('Albums')) .rs-h-card >> nth=0 >> .rs-h-playfab")
        p1 = await last(pg)
        await pg.click(".rs-h-mode-btn[data-mode=karaoke]")
        await pg.evaluate("() => home.go({view: 'all', kind: 'recent'})")
        await pg.evaluate("() => home.go({view: 'home'})")
        mode = await pg.evaluate("() => [home.mode, localStorage.getItem('rs-home-mode'), document.querySelector('.rs-h-bigplay') ? 1 : 0]")
        # all songs incl. the MIDI demo, sung: the MIDI song is left out
        await pg.evaluate("() => home.play(home.songs, 0, 'karaoke', {type: 'test'})")
        p2 = await last(pg)
        midi = await pg.evaluate("() => home.songs.filter(s => s.kind === 'midi').map(s => s.id)")
        await pg.evaluate("() => home.go({view: 'album', key: home.albums[0].key})")
        await pg.hover(".rs-h-track:not(.is-head) >> nth=0")
        await pg.click(".rs-h-track:not(.is-head) >> nth=0 >> .rs-h-rowbtn[title^='Play (instrument']")
        p3 = await last(pg)
        check(p1["op"] == "play" and p1["mode"] == "instrument" and p1["context"]["type"] == "album" and len(p1["ids"]) >= 1
              and mode[0] == "karaoke" and mode[1] == "karaoke" and p2["mode"] == "karaoke" and midi and not set(midi) & set(p2["ids"])
              and p3["mode"] == "instrument" and len(p3["ids"]) == 1 and not errs,
              f"album card play -> {{op: play, mode: {p1['mode']}, {len(p1['ids'])} ids, context album}}; 'Open in: Karaoke' kept ({mode[1]}); "
              f"singing everything leaves out {len(midi)} MIDI song(s) ({len(p2['ids'])} queued); a row's guitar button plays one song in the instrument mode")

        print("playlists")
        await pg.evaluate("() => home.go({view: 'home'})")
        await pg.click(".rs-h-side-head .rs-h-iconbtn")                    # + create
        await pg.wait_for_function("() => home.route.view === 'playlist'")
        pl = await pg.evaluate("() => ({ name: document.querySelector('.rs-h-hero-title').textContent, n: home.user.playlists.length, id: home.route.id })")
        # add three songs from the "all songs" of an artist page via the + menu
        for i in range(3):
            await pg.evaluate(f"() => home.go({{view: 'search', q: '{['highway', 'sultans', 'night'][i]}'}})")
            await pg.hover(".rs-h-track:not(.is-head) >> nth=0")
            await pg.click(".rs-h-track:not(.is-head) >> nth=0 >> .rs-h-rowbtn[title='Add to a playlist']")
            await pg.click(".rs-h-menu .rs-h-menu-item:not(.is-new) >> nth=0")
            await pg.wait_for_timeout(80)
        await pg.evaluate(f"() => home.go({{view: 'playlist', id: '{pl['id']}'}})"); await pg.wait_for_timeout(80)
        before = await pg.evaluate("() => [...document.querySelectorAll('.rs-h-track:not(.is-head) .rs-h-tt-text b')].map(e => e.textContent)")
        await pg.drag_and_drop(".rs-h-track:not(.is-head) >> nth=2", ".rs-h-track:not(.is-head) >> nth=0", target_position={"x": 200, "y": 5})
        await pg.wait_for_timeout(120)
        after = await pg.evaluate("() => [...document.querySelectorAll('.rs-h-track:not(.is-head) .rs-h-tt-text b')].map(e => e.textContent)")
        await pg.hover(".rs-h-track:not(.is-head) >> nth=1")
        await pg.click(".rs-h-track:not(.is-head) >> nth=1 >> .rs-h-rowbtn[title='Remove from this playlist']"); await pg.wait_for_timeout(80)
        removed = await pg.evaluate("() => [...document.querySelectorAll('.rs-h-track:not(.is-head) .rs-h-tt-text b')].map(e => e.textContent)")
        await pg.click(".rs-h-hero-title"); await pg.fill(".rs-h-rename", "Road trip"); await pg.press(".rs-h-rename", "Enter"); await pg.wait_for_timeout(80)
        renamed = await pg.evaluate("() => [document.querySelector('.rs-h-hero-title').textContent, document.querySelector('.rs-h-side-list .rs-h-row b').textContent]")
        await pg.click(".rs-h-actions .rs-h-bigplay")
        pp = await last(pg)
        await pg.click(".rs-h-actions .is-danger"); await pg.click(".rs-h-menu .is-danger"); await pg.wait_for_timeout(80)
        gone = await pg.evaluate("() => [home.route.view, home.user.playlists.length]")
        check(pl["n"] == 1 and pl["name"] == "My playlist #1" and len(before) == 3 and after == [before[2], before[0], before[1]]
              and removed == [after[0], after[2]] and renamed == ["Road trip", "Road trip"] and pp["context"]["type"] == "playlist"
              and len(pp["ids"]) == 2 and gone == ["home", 0] and not errs,
              f"+ made '{pl['name']}' and opened it; 3 songs added from menus {before}; dragged the 3rd to the top {after}; removed one; "
              f"renamed 'Road trip'; played it ({len(pp['ids'])} songs, context playlist); deleted -> back home")

        print("genres")
        await pg.evaluate("() => home.go({view: 'artist', name: home.artists.find(a => a.name === 'Dire Straits').name})")
        await pg.click(".rs-h-genrechip"); await pg.fill(".rs-h-menu-input", "Classic Rock"); await pg.press(".rs-h-menu-input", "Enter")
        await pg.wait_for_timeout(100)
        g = await pg.evaluate("""() => { home.go({view: 'home'});
          const heads = [...document.querySelectorAll('.rs-h-shelf-head h2')].map(e => e.textContent);
          const chip = home.genres.map(g => [g.name, g.songs.length]);
          home.go({view: 'genre', name: 'Classic Rock'});
          return { heads, chip, page: document.querySelector('.rs-h-hero-title') && document.querySelector('.rs-h-hero-title').textContent,
                   rows: document.querySelectorAll('.rs-h-track:not(.is-head)').length }; }""")
        check("Genres" in g["heads"] and g["chip"] == [["Classic Rock", 1]] and g["page"] == "Classic Rock" and g["rows"] == 1 and not errs,
              f"genre set on Dire Straits -> Genres shelf {g['chip']}, genre page with {g['rows']} song")
        await pg.evaluate("() => home.go({view: 'home'})")
        await pg.screenshot(path=os.path.join(FIX, "home_songs.png"))
        await pg.close()

        if BIG:
            print("a big library")
            pg, errs = await page("home_big")
            r = await pg.evaluate("""async () => { const wait = (ms) => new Promise(r => setTimeout(r, ms));
              const out = { load: __loadMs, songs: home.songs.length, artists: home.artists.length, albums: home.albums.length,
                            nodes: document.querySelectorAll('*').length };
              let t0 = performance.now(); home.go({view: 'all', kind: 'albums'}); out.allAlbums = performance.now() - t0;
              out.cardsFirst = document.querySelectorAll('.rs-h-card').length;
              const v = document.querySelector('.rs-h-view'); for (let i = 0; i < 20; i++) { v.scrollTop = v.scrollHeight; await wait(60); }
              out.cardsScrolled = document.querySelectorAll('.rs-h-card').length;
              t0 = performance.now(); home.go({view: 'search', q: 'river'}); out.search = performance.now() - t0;
              out.hits = document.querySelectorAll('.rs-h-track:not(.is-head)').length;
              t0 = performance.now(); home.go({view: 'artist', name: home.artists[5].name}); out.artist = performance.now() - t0;
              t0 = performance.now(); home.go({view: 'home'}); out.home = performance.now() - t0;
              await wait(1500); out.art = document.querySelectorAll('.rs-h-art.has-art').length;
              out.heap = performance.memory ? performance.memory.usedJSHeapSize / 1e6 : null;
              return out; }""")
            check(r["load"] < 1500 and r["allAlbums"] < 500 and r["search"] < 300 and r["home"] < 500 and r["cardsScrolled"] > r["cardsFirst"] and not errs,
                  f"{r['songs']} songs, {r['artists']} artists, {r['albums']} albums: loaded + home in {r['load']:.0f} ms ({r['nodes']} DOM nodes); "
                  f"all albums {r['allAlbums']:.0f} ms ({r['cardsFirst']} cards, {r['cardsScrolled']} after scrolling); search {r['search']:.0f} ms "
                  f"({r['hits']} rows); artist page {r['artist']:.0f} ms; back home {r['home']:.0f} ms, {r['art']} covers painted")
            await pg.close()
        await b.close()
    srv.shutdown()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

asyncio.run(main())
