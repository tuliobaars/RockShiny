#!/usr/bin/env python3
"""
The Creator builds on RockShiny's R code (PSARC reading, chart parsing, lyrics
lookup, audio conversion, the library) and a few of its assets (the app's CSS,
the drop zone, the lyrics tools of the karaoke). Inside RockShiny it uses them
from the folder above; on its own (the creator/ folder alone) it uses the copy
in creator/rockshiny/, which this script refreshes:

  python3 creator/tools/vendor_rockshiny.py            # copy RockShiny's files into creator/rockshiny/
  python3 creator/tools/vendor_rockshiny.py --check    # exit 1 if the copy differs (the tests run this)

Every file is small (the whole copy is ~0.4 MB); the manifest lists them with
their MD5s.
"""
import hashlib, json, os, shutil, sys

CREATOR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
ROOT = os.path.abspath(os.path.join(CREATOR, ".."))
DEST = os.path.join(CREATOR, "rockshiny")
FILES = (["R/" + f for f in sorted(os.listdir(os.path.join(ROOT, "R"))) if f.endswith(".R")] if os.path.isdir(os.path.join(ROOT, "R")) else []) + [
    "inst/app/app.css", "inst/app/app.js", "inst/dropzone/dropzone.css", "inst/dropzone/dropzone.js",
    "inst/karaoke/karaoke-sync.js", "inst/bin/rs-convert.sh", "LICENSE", "LICENSE.md"]

def md5(p):
    return hashlib.md5(open(p, "rb").read()).hexdigest()

def main():
    check = "--check" in sys.argv
    if not os.path.exists(os.path.join(ROOT, "R", "psarc.R")):
        print("RockShiny is not next to this creator/ folder: nothing to compare (the bundled copy is used).")
        return 0
    manifest = {f: md5(os.path.join(ROOT, f)) for f in FILES}
    if check:
        bad = [f for f in FILES if not os.path.exists(os.path.join(DEST, f)) or md5(os.path.join(DEST, f)) != manifest[f]]
        have = set()
        for d, _, fs in os.walk(DEST):
            for f in fs:
                rel = os.path.relpath(os.path.join(d, f), DEST).replace(os.sep, "/")
                if rel != "MANIFEST.json" and rel != "README.md": have.add(rel)
        extra = sorted(have - set(FILES))
        if bad or extra:
            print("creator/rockshiny/ is out of date with RockShiny:", ", ".join(bad + ["(extra) " + e for e in extra]))
            print("run: python3 creator/tools/vendor_rockshiny.py")
            return 1
        print("creator/rockshiny/ matches RockShiny (%d files)" % len(FILES))
        return 0
    if os.path.isdir(DEST):
        for f in os.listdir(DEST):
            p = os.path.join(DEST, f)
            if f in ("README.md",): continue
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    for f in FILES:
        os.makedirs(os.path.dirname(os.path.join(DEST, f)), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, f), os.path.join(DEST, f))
    with open(os.path.join(DEST, "MANIFEST.json"), "w") as fh:
        json.dump({"source": "RockShiny (the folder above creator/)", "files": manifest}, fh, indent=1)
    print("copied %d files (%.0f KB) into creator/rockshiny/" % (len(FILES), sum(os.path.getsize(os.path.join(DEST, f)) for f in FILES) / 1024))
    return 0

if __name__ == "__main__":
    sys.exit(main())
