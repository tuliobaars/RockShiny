"""
A folder of .psarc files -> a standalone karaoke folder (tools/karaoke_export_html.py FOLDER,
R: karaoke_export_html("FOLDER", ...)): one page + <page>_files/ with every song's audio,
no library index, no catalog. Checked in a real browser (headless Chromium):

  1. built from a small folder (a song with lyrics, two without), then the karaoke folder is
     moved elsewhere and the original deleted: it must not need anything outside itself
  2. opened from disk (file://), every network request blocked: every file of the folder is
     listed; each song loads, its audio plays from the file next to the page, lyrics on stage;
     a song without lyrics asks the page's online lookup (offline here: says so)
  3. --lyrics-only: only the song whose lyrics are in the file
  4. karaoke/index.html (the repository's standalone folder, when built): every audio file it
     names is in karaoke/index_files/, nothing outside the folder, each file decodes (ffprobe)

  python3 tests/frontend/check_karaoke_folder.py

Needs Python 3 + playwright (chromium), ffmpeg + a Wwise decoder (vgmstream-cli or wem2ogg),
the sample songs in songs/. The browser test uses Ogg audio (Playwright's Chromium has no AAC).
"""
import asyncio, json, os, re, shutil, subprocess, sys, tempfile
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import karaoke_export_html as X

SONGS = ["Dire-Straits_Sultans-of-Swing_v443_m.psarc", "Daft-Punk_Derezzed_v1_m.psarc", "Daft-Punk_Son-of-Flynn_v1_1_m.psarc"]
failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

def page_data(path):
    html = open(path, encoding="utf-8").read()
    m = re.search(r'<script type="application/json" id="rs-karaoke-data">(.*?)</script>', html, re.S)
    return json.loads(m.group(1))

async def browser_check(b, page):
    pg = await b.new_page(viewport={"width": 1400, "height": 850})
    errs, blocked = [], []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    async def route(r):
        if r.request.url.startswith("file://"): await r.continue_()
        else: blocked.append(r.request.url); await r.abort()
    await pg.route("**/*", route)
    await pg.goto("file://" + page)
    await pg.wait_for_function("() => window.karaokePage && karaokePage.player.song", timeout=60000)
    res = await pg.evaluate("""async () => {
      const P = karaokePage.player, out = [];
      for (let i = 0; i < karaokePage.songs.length; i++) {
        karaokePage.load(i);
        const t0 = performance.now();
        while (!(P.song && P.song.songKey === karaokePage.songs[i].songKey && P.deck.kind === 'full') && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 50));
        await P.play();
        await new Promise(r => setTimeout(r, 1800));
        const a = P.deck.audio;
        out.push({title: P.song.meta.title, full: P.deck.kind === 'full', t: a ? a.currentTime : -1, src: a ? a.src : '',
                  lines: P.song.lines ? P.song.lines.length : 0, lookup: !!(karaokePage.songs[i].lyrics && karaokePage.songs[i].lyrics.lookup),
                  banner: (P.banner && P.banner.textContent) || ''});
        P.pause();
      }
      return out; }""")
    await pg.close()
    return res, errs, blocked

async def main():
    cache = tempfile.mkdtemp(prefix="rs-kf-cache-")
    tmp = tempfile.mkdtemp(prefix="rs-kf-")
    src = os.path.join(tmp, "my songs"); os.makedirs(src)
    for f in SONGS: shutil.copy(os.path.join(ROOT, "songs", f), src)
    try:
        print("1. a folder -> a standalone karaoke folder")
        built = os.path.join(tmp, "build", "karaoke", "index.html")
        X.main([src, "-o", built, "--audio", "files", "--no-online", "--cache-dir", cache, "--jobs", "3"])
        moved = os.path.join(tmp, "elsewhere", "karaoke")
        shutil.copytree(os.path.dirname(built), moved); shutil.rmtree(os.path.join(tmp, "build"))
        page = os.path.join(moved, "index.html")
        d = page_data(page)
        srcs = [s.get("audio", {}).get("src", "") for s in d["songs"]]
        files = sorted(os.listdir(os.path.join(moved, "index_files")))
        check(len(d["songs"]) == 3 and all(x.startswith("index_files/") for x in srcs) and sorted(os.path.basename(x) for x in srcs) == files,
              f"every file of the folder in the page ({len(d['songs'])}), each with its audio in index_files/: {files}")
        check(not os.path.exists(os.path.join(cache, "library")) and not os.path.exists(os.path.join(moved, "index_files", "songs")),
              "no library index and no catalog written")
        print("2. opened from disk, no network")
        async with async_playwright() as p:
            b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
            res, errs, blocked = await browser_check(b, page)
            for r in res:
                check(r["full"] and r["t"] > 0.8 and r["src"].startswith("file://" + moved),
                      f"{r['title']}: its audio plays from the folder ({r['t']:.1f} s in; {os.path.basename(r['src'])})")
            wl = [r for r in res if not r["lookup"]]
            nl = [r for r in res if r["lookup"]]
            check(len(wl) == 1 and wl[0]["title"] == "Sultans of Swing" and len(nl) == 2,
                  f"lyrics: {[r['title'] for r in wl]} from the file, {[r['title'] for r in nl]} looked up by the page (offline here)")
            check(not errs, f"no page errors {errs[:3]}")
            check(all(u.startswith("https://lrclib.net") for u in blocked), f"the only network requests are the lyrics lookups ({len(blocked)} blocked)")
            print("3. --lyrics-only")
            lo = os.path.join(tmp, "lo", "karaoke", "index.html")
            X.main([src, "-o", lo, "--audio", "none", "--lyrics-only", "--cache-dir", cache])
            check([s["meta"]["title"] for s in page_data(lo)["songs"]] == ["Sultans of Swing"], "only the song whose lyrics are in the file")
            await b.close()
        print("4. the repository's karaoke/ folder")
        kp = os.path.join(ROOT, "karaoke", "index.html")
        if not os.path.exists(kp):
            print("  skip karaoke/index.html is not built (python3 tools/karaoke_export_html.py)")
        else:
            d = page_data(kp)
            html = open(kp, encoding="utf-8").read()
            srcs = [s["audio"]["src"] for s in d["songs"] if s.get("audio", {}).get("src")]
            present = [x for x in srcs if os.path.isfile(os.path.join(ROOT, "karaoke", x))]
            files = set(os.listdir(os.path.join(ROOT, "karaoke", "index_files")))
            check(len(srcs) == len(d["songs"]) and len(present) == len(srcs) and set(os.path.basename(x) for x in srcs) == files,
                  f"{len(d['songs'])} songs, {len(present)} audio files, all in karaoke/index_files/ and nothing else there")
            check("../" not in "".join(srcs) and not re.search(r'src="(?!data:)[^"#]', html), "nothing outside the folder is referenced")
            bad = []
            for x in srcs:
                r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", os.path.join(ROOT, "karaoke", x)],
                                   capture_output=True, text=True)
                try:
                    if float(r.stdout.strip()) < 10: bad.append(x)
                except ValueError: bad.append(x)
            check(not bad, f"every audio file decodes (ffprobe){'; bad: ' + ', '.join(bad) if bad else ''}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True); shutil.rmtree(cache, ignore_errors=True)
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    asyncio.run(main())
