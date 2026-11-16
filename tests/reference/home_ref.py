"""
Mirror of R/home.R's home_catalog() for the browser checks: the catalog
columns home.js reads, from song folders (library index via library_ref.py;
ids = first 12 hex digits of the md5 of the path), and the songs' album art
extracted the way home_art() serves it (<out>/art/<id>-<64|128|256>.dds).
"""
import hashlib, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
import library_ref as L, rockshiny_ref as R


def song_id(path):                                     # song_id()
    return hashlib.md5(path.encode("utf-8")).hexdigest()[:12]


def catalog(dirs, cache, out, art=True):
    """dirs: [(folder, source)] -> {"catalog": columns} (home_catalog_json())."""
    songs = []
    for d, src in dirs:
        lib = L.open_library(d, budget=float("inf"), threshold=10**9, cache=cache)
        for s in lib["songs"]:
            s["source"] = src
            songs.append(s)
    cols = {k: [] for k in ("id", "title", "artist", "album", "year", "length", "lyrics", "kind", "source", "genre", "added")}
    os.makedirs(os.path.join(out, "art"), exist_ok=True)
    for s in songs:
        sid = song_id(s["path"])
        side = os.path.exists(re.sub(r"\.psarc$", ".lrc", s["path"], flags=re.I))
        lyr = "" if s["kind"] != "psarc" else "archive" if (s.get("lyrics") or side) else "web"
        for k, v in (("id", sid), ("title", s.get("title") or os.path.basename(s["path"])), ("artist", s.get("artist") or ""),
                     ("album", s.get("album") or ""), ("year", s.get("year") or ""), ("length", round(s.get("length") or 0, 1)),
                     ("lyrics", lyr), ("kind", s["kind"]), ("source", s["source"]), ("genre", ""), ("added", s.get("mtime") or 0)):
            cols[k].append(v)
        if art and s["kind"] == "psarc":
            if all(os.path.exists(os.path.join(out, "art", f"{sid}-{z}.dds")) for z in (64, 128, 256)):
                continue
            a = R.Psarc(s["path"])
            for z in (64, 128, 256):
                e = [n for n in a.find(r"album_art/.*\.dds$") if n.endswith(f"_{z}.dds")]
                if e:
                    with open(os.path.join(out, "art", f"{sid}-{z}.dds"), "wb") as f:
                        f.write(a.read(e[0]))
    return {"catalog": cols}
