"""
R and Python write the same karaoke pages, byte for byte: a single-song page,
a songbook, a library catalog (page + one script per song) and a folder's page
(every file; and only those with lyrics in the file), lyrics only.
R runs in webR (tests/webr/run_webr.mjs; needs node + the webr npm package).

  WEBR_DIST=/path/to/webr/dist python3 tests/reference/check_export_parity.py
  python3 tests/reference/check_export_parity.py --rscript        # with the local R instead
"""
import filecmp, os, shutil, subprocess, sys, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import karaoke_export_html as X

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

R = r'''
options(rockshiny.cache_dir = file.path(tempdir(), "parity-cache"))
out <- ".parity/r"
karaoke_export_html("songs/Dire-Straits_Sultans-of-Swing_v443_m.psarc", file.path(out, "single.html"), audio = "none", online = FALSE)
karaoke_export_html(karaoke_choices("songs"), file.path(out, "book.html"), audio = "none", online = FALSE)
karaoke_export_library("songs", file.path(out, "catalog.html"), audio = "none", online = FALSE)
karaoke_export_html("songs", file.path(out, "folder.html"), audio = "none", online = FALSE)
karaoke_export_html("songs", file.path(out, "lyrics-only.html"), audio = "none", lyrics_only = TRUE)
'''

def main():
    work = os.path.join(ROOT, ".parity")                         # inside the project: webR sees it as /work/.parity
    shutil.rmtree(work, ignore_errors=True); os.makedirs(work)
    try:
        script = os.path.join(work, "parity.R")
        with open(script, "w") as f: f.write(R)
        if "--rscript" in sys.argv:                                # a local R instead of webR
            with open(script, "w") as f:
                f.write('for (f in list.files("R", full.names = TRUE)) sys.source(f, envir = globalenv())\n'
                        'options(rockshiny.root = getwd())\n' + R)
            r = subprocess.run(["Rscript", script], capture_output=True, text=True, cwd=ROOT)
        else:
            r = subprocess.run(["node", os.path.join(ROOT, "tests", "webr", "run_webr.mjs"), script], capture_output=True, text=True, cwd=ROOT)
        if r.returncode != 0 or not os.path.exists(os.path.join(work, "r", "catalog.html")):
            print(r.stdout[-2000:], r.stderr[-2000:]); sys.exit("the R run failed (webR: set WEBR_DIST?; or --rscript)")
        py, cache = os.path.join(work, "py"), tempfile.mkdtemp(prefix="rs-parity-")
        songs = os.path.join(ROOT, "songs")
        X.main([os.path.join(songs, "Dire-Straits_Sultans-of-Swing_v443_m.psarc"), "-o", os.path.join(py, "single.html"),
                "--audio", "none", "--no-online", "--cache-dir", cache])
        X.main(["--library", songs, "--single", "--no-lookup-in-browser", "-o", os.path.join(py, "book.html"), "--audio", "none",
                "--no-online", "--cache-dir", cache])
        X.main(["--library", songs, "--catalog", "-o", os.path.join(py, "catalog.html"), "--audio", "none", "--no-online", "--cache-dir", cache])
        X.main([songs, "-o", os.path.join(py, "folder.html"), "--audio", "none", "--no-online", "--cache-dir", cache])
        X.main([songs, "-o", os.path.join(py, "lyrics-only.html"), "--audio", "none", "--lyrics-only", "--cache-dir", cache])
        for f in ("single.html", "book.html", "catalog.html", "folder.html", "lyrics-only.html"):
            a, b = os.path.join(work, "r", f), os.path.join(py, f)
            check(filecmp.cmp(a, b, shallow=False), f"{f}: identical ({os.path.getsize(a)} bytes)")
        rs = sorted(os.listdir(os.path.join(work, "r", "catalog_files", "songs")))
        ps = sorted(os.listdir(os.path.join(py, "catalog_files", "songs")))
        same = [f for f in rs if f in ps and filecmp.cmp(os.path.join(work, "r", "catalog_files", "songs", f),
                                                          os.path.join(py, "catalog_files", "songs", f), shallow=False)]
        check(rs == ps and len(same) == len(rs) > 0, f"catalog song scripts: {len(same)}/{len(rs)} identical ({', '.join(rs)})")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    sys.exit(1 if failures else 0)

if __name__ == "__main__":
    main()
