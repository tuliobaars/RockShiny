"""
How many songs with embedded audio can one karaoke page hold? (the EMBED_MAX
threshold of karaoke_export_html() / tools/karaoke_export_html.py)

Builds pages with N songs whose audio is embedded (the sample songs' converted
audio, repeated) and measures in Chromium: time until the first song is ready
to play, and the time to switch to the last song. Measured in the development
sandbox (docs/IMPLEMENTATION_GUIDE.md): ready after 3.0 s (4 songs, 30 MB),
6.2 s (12, 84 MB), 10.9 s (24, 167 MB), 15.0 s (32, 223 MB) -- about 0.45 s
per song, all of it before the first note can play; hence 12.

  python3 tests/perf/embed_bench.py [N ...]      (default 4 8 12 16 24 32)
"""
import asyncio, base64, glob, json, os, sys, tempfile, time
from playwright.async_api import async_playwright
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools")); sys.path.insert(0, os.path.join(ROOT, "tests", "reference"))
import karaoke_export_html as X, karaoke_ref as KR

def pages(ns):
    cache = X.r_cache_root()
    songs = []
    for f, tag in KR.SONGS:
        s = X.Song(os.path.join(ROOT, "songs", f), online=False, cache=cache)
        a = sorted(glob.glob(os.path.join(cache, s.key, "audio.*")))
        if a: songs.append((s, a[0]))
    if not songs: sys.exit("convert the sample songs' audio first (run the app, or tools/karaoke_export_html.py)")
    tmp = tempfile.mkdtemp(prefix="rs-embed-")
    for n in ns:
        payloads, blobs = [], []
        for i in range(n):
            s, a = songs[i % len(songs)]
            p = dict(s.payload, songKey=f"{s.key}-{i}")
            sid = f"rs-karaoke-audio-{i + 1}"
            with open(a, "rb") as f: blobs.append(f'<script type="text/plain" id="{sid}">{base64.b64encode(f.read()).decode()}</script>')
            p["audio"] = {"embed": sid, "type": "audio/ogg"}
            payloads.append(X.to_json(p))
        out = os.path.join(tmp, f"embed{n}.html")
        X.write_page(out, "bench", {}, payloads, blobs)
        yield n, out

async def main():
    ns = [int(x) for x in sys.argv[1:]] or [4, 8, 12, 16, 24, 32]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"])
        print(f"{'songs':>5} {'page MB':>8} {'ready s':>8} {'switch s':>9}")
        for n, out in pages(ns):
            pg = await b.new_page()
            t0 = time.time()
            await pg.goto("file://" + out, timeout=300000)
            await pg.wait_for_function("() => window.karaokePage && karaokePage.player.deck.kind === 'full'", timeout=300000)
            ready = time.time() - t0
            t0 = time.time()
            await pg.evaluate(f"() => karaokePage.load({n - 1})")
            await pg.wait_for_function(f"() => karaokePage.player.deck.kind === 'full' && karaokePage.player.song.songKey === karaokePage.songs[{n - 1}].songKey", timeout=300000)
            switch = time.time() - t0
            print(f"{n:5d} {os.path.getsize(out) / 1e6:8.1f} {ready:8.2f} {switch:9.2f}")
            await pg.close()
        await b.close()

asyncio.run(main())
