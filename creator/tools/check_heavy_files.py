#!/usr/bin/env python3
"""
Heavy files: every file over 1 MB, and any heavy file stored more than once.

  python3 creator/tools/check_heavy_files.py [folder] [--min-mb 1] [--check]

folder: RockShiny's folder when creator/ sits in it, else creator/ itself. Skips .git,
node_modules, renv/library and the git-ignored output folders (deliverables/, creator/songs/).
Duplicates are byte-identical files (same size and SHA-1), found among the files over
--min-mb. --check exits with 1 when there is a duplicate (for CI). Big media should be
kept once and pointed to (relative paths) from the pages that use it.
"""
import hashlib, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CREATOR = os.path.dirname(HERE)
PARENT = os.path.dirname(CREATOR)
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".Rproj.user"}
SKIP_PATHS = {"renv/library", "deliverables", "creator/songs"}

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    min_mb = 1.0
    if "--min-mb" in sys.argv: min_mb = float(sys.argv[sys.argv.index("--min-mb") + 1]); args = [a for a in args if a != sys.argv[sys.argv.index("--min-mb") + 1]]
    top = os.path.abspath(args[0]) if args else (PARENT if os.path.exists(os.path.join(PARENT, "R", "psarc.R")) else CREATOR)
    heavy = []
    for d, dirs, files in os.walk(top):
        rel = os.path.relpath(d, top).replace(os.sep, "/")
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS and (rel + "/" + x).lstrip("./") not in SKIP_PATHS]
        for f in files:
            p = os.path.join(d, f)
            if os.path.islink(p): continue
            n = os.path.getsize(p)
            if n >= min_mb * 1e6: heavy.append((n, os.path.relpath(p, top)))
    heavy.sort(reverse=True)
    total = sum(n for n, _ in heavy)
    print("Files over %.1f MB in %s: %d, %.1f MB" % (min_mb, top, len(heavy), total / 1e6))
    for n, p in heavy: print("  %8.1f MB  %s" % (n / 1e6, p))
    groups = {}
    for n, p in heavy:
        h = hashlib.sha1()
        with open(os.path.join(top, p), "rb") as fh:
            for b in iter(lambda: fh.read(1 << 20), b""): h.update(b)
        groups.setdefault((n, h.hexdigest()), []).append(p)
    dups = [v for v in groups.values() if len(v) > 1]
    if dups:
        print("\nStored more than once (%d):" % len(dups))
        for v in dups: print("  " + "  =  ".join(v))
    else:
        print("\nNo heavy file is stored twice.")
    if "--check" in sys.argv and dups: sys.exit(1)

if __name__ == "__main__":
    main()
