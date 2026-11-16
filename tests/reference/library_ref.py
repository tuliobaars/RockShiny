"""
Mirror of R/library.R: the song library index shared by the app and
tools/karaoke_export_html.py (<cache>/library/index.tsv), file-name guesses,
lazy opening of big libraries and the karaoke grouping.

  lib = open_library("/path/to/dlc", recursive=True, cache=CACHE)   # {"songs": [...], "lazy", "pending"}
  scan_more(lib, seconds=1.0, cache=CACHE)
  karaoke_groups(lib, cache=CACHE)        # {"with": [...], "online": [...], "unknown": [...]}
"""
import collections, json, os, re, sys, time
sys.path.insert(0, os.path.dirname(__file__))
import rockshiny_ref as R
import karaoke_ref as KR

FORMAT = "rockshiny-library/1"
FIELDS = ["path", "size", "mtime", "kind", "artist", "title", "album", "year", "length", "lyrics", "md5", "error"]
PATTERN = re.compile(r"\.(psarc|mid|midi|kar)$", re.I)
LAZY_THRESHOLD = 50                       # getOption("rockshiny.library_lazy_threshold", 50)


def library_files(d, recursive=False):    # library_files()
    if not d or not os.path.isdir(d):
        return []
    out = []
    if recursive:
        for root, dirs, files in os.walk(d):
            dirs[:] = [x for x in dirs if not x.startswith(".")]
            out += [os.path.join(root, f) for f in files if PATTERN.search(f) and not f.startswith(".")]
    else:
        out = [os.path.join(d, f) for f in os.listdir(d) if PATTERN.search(f) and not f.startswith(".")
               and os.path.isfile(os.path.join(d, f))]
    base = os.path.realpath(d)               # R: file.path(normalizePath(dir, winslash = "/"), relative)
    return sorted((base + "/" + os.path.relpath(p, d).replace(os.sep, "/")).replace(os.sep, "/") for p in out)


def _clean(x):
    return re.sub(r"\s+", " ", re.sub(r"[_]+|(?<=\S)-(?=\S)", " ", x)).strip()


def library_guess(path):                  # library_guess()
    b = PATTERN.sub("", os.path.basename(path))
    b = re.sub(r"(_v[0-9][0-9_.]*)?(_DD)?(_[mp])?$", "", b, flags=re.I)
    if " - " in b:
        parts = b.split(" - ")
        return dict(artist=_clean(parts[0]), title=_clean(" - ".join(parts[1:])))
    if "_" in b:
        a, t = b.split("_", 1)
        return dict(artist=_clean(a), title=_clean(t))
    return dict(artist=None, title=_clean(b))


def song_meta(arc):                        # psarc_song_meta()
    for m in arc.find(r"^manifests/.*\.json$"):
        try:
            a = list(json.loads(arc.read(m))["Entries"].values())[0]["Attributes"]
        except Exception:
            continue
        if a.get("SongName") is None:
            continue
        return dict(title=a["SongName"], artist=a.get("ArtistName"), album=a.get("AlbumName"),
                    year=None if a.get("SongYear") is None else str(a["SongYear"]), song_length=a.get("SongLength"))
    return None


def scan_file(path, st=None):              # library_scan_file()
    st = st or os.stat(path)
    g = library_guess(path)
    row = dict(path=path, size=st.st_size, mtime=int(st.st_mtime), kind="psarc" if path.lower().endswith(".psarc") else "midi",
               artist=g["artist"], title=g["title"], album=None, year=None, length=None, lyrics=None, md5=None, error=None)
    if row["kind"] == "midi":
        row["title"] = re.sub(r"[_]+", " ", PATTERN.sub("", os.path.basename(path))) + " (MIDI)"
        row["artist"] = None
        return row
    try:
        arc = R.Psarc(path)
        m = song_meta(arc)
        if m:
            row.update(artist=m["artist"], title=m["title"], album=m["album"], year=m["year"], length=m["song_length"])
        row["lyrics"] = KR.lyrics_present(KR.vocals_raw(arc))
    except Exception as e:
        row["error"], row["lyrics"] = str(e) or type(e).__name__, False
    return row


# ---- index ---------------------------------------------------------------------------------
def index_file(cache):
    return os.path.join(cache, "library", "index.tsv")


def read_index(cache):
    f = index_file(cache) if cache else None
    if not f or not os.path.exists(f):
        return {}
    out = {}
    try:
        with open(f, encoding="utf-8") as h:
            first = h.readline()
            if first[2:].split("\t")[0].strip() != FORMAT:
                return {}
            head = h.readline().rstrip("\n").split("\t")
            for line in h:
                cells = line.rstrip("\n").split("\t")
                r = {k: (v if v != "" else None) for k, v in zip(head, cells)}
                for k in ("size", "mtime"):
                    r[k] = None if r.get(k) is None else int(float(r[k]))
                r["length"] = None if r.get("length") is None else float(r["length"])
                r["lyrics"] = None if r.get("lyrics") is None else r["lyrics"] == "1"
                out[r["path"]] = {k: r.get(k) for k in FIELDS}
    except Exception:
        return {}
    return out


def write_index(cache, idx):
    f = index_file(cache)
    os.makedirs(os.path.dirname(f), exist_ok=True)
    def cell(k, v):
        if v is None:
            return ""
        if k in ("size", "mtime"):
            return "%.0f" % v
        if k == "length":
            return "%.3f" % v
        if k == "lyrics":
            return "1" if v else "0"
        return re.sub(r"[\t\r\n]+", " ", str(v))
    lines = [f"# {FORMAT}\tsongs scanned by RockShiny (R and tools/karaoke_export_html.py)", "\t".join(FIELDS)]
    lines += ["\t".join(cell(k, idx[p].get(k)) for k in FIELDS) for p in sorted(idx)]
    tmp = f"{f}.tmp{os.getpid()}"
    with open(tmp, "w", encoding="utf-8", newline="\n") as h:
        h.write("\n".join(lines) + "\n")
    os.replace(tmp, f)


def note_key(cache, path, key):            # library_note_key()
    if not cache:
        return
    idx = read_index(cache)
    if path in idx and idx[path].get("md5") != key:
        idx[path]["md5"] = key
        write_index(cache, idx)


# ---- libraries -----------------------------------------------------------------------------
def labels(songs):                         # library_labels()
    lab = [f"{s['artist']} \u2014 {s['title']}" if s.get("artist") else (s.get("title") or os.path.basename(s["path"])) for s in songs]
    dup = {x for x, n in collections.Counter(lab).items() if n > 1}
    lab = [x + f" ({s['album']})" if x in dup and s.get("album") else x for x, s in zip(lab, songs)]
    dup = {x for x, n in collections.Counter(lab).items() if n > 1}
    return [x + f" [{os.path.basename(s['path'])}]" if x in dup else x for x, s in zip(lab, songs)]


def open_library(d, recursive=False, budget=None, threshold=LAZY_THRESHOLD, cache=None, progress=None):
    """library_open(): map the folder, reuse the index, scan within `budget` seconds (None: all if small)."""
    t0 = time.time()
    files = library_files(d, recursive)
    idx = read_index(cache) if cache else {}
    songs = []
    for p in files:
        st = os.stat(p)
        hit = idx.get(p)
        if hit and hit["size"] == st.st_size and hit["mtime"] == int(st.st_mtime) and not hit.get("error"):   # (errors: tried again)
            s = dict(hit, scanned=True)
        else:
            g = library_guess(p)
            s = dict({k: None for k in FIELDS}, path=p, size=st.st_size, mtime=int(st.st_mtime), artist=g["artist"], title=g["title"],
                     kind="psarc" if p.lower().endswith(".psarc") else "midi", scanned=False)
        songs.append(s)
    lib = dict(dir=d, recursive=recursive, lazy=len(files) > threshold, songs=songs, map_seconds=time.time() - t0)
    if budget is None:
        budget = 1.0 if lib["lazy"] else float("inf")
    scan_more(lib, budget, cache=cache, progress=progress)
    lib["open_seconds"] = time.time() - t0
    return lib


def scan_more(lib, seconds=0.5, cache=None, progress=None):   # library_scan_more()
    todo = [s for s in lib["songs"] if not s["scanned"]]
    t0, rows = time.time(), []
    for i, s in enumerate(todo):
        if time.time() - t0 >= seconds:
            break
        if os.path.exists(s["path"]):
            r = scan_file(s["path"])
            s.update(r)
            rows.append(r)
        s["scanned"] = True
        if progress and (i % 25 == 0):
            progress(i, len(todo))
    if rows and cache:
        idx = read_index(cache)
        for r in rows:
            idx[r["path"]] = {k: r.get(k) for k in FIELDS}
        write_index(cache, idx)
    lib["pending"] = sum(not s["scanned"] for s in lib["songs"])
    for s, lab in zip(lib["songs"], labels(lib["songs"])):
        s["label"] = lab
    return lib


def karaoke_groups(lib, cache=None, key_of=None):              # karaoke_groups()
    """key_of(path) -> md5 for small libraries (the exporter passes its memoised md5)."""
    out = {"with": [], "online": [], "unknown": []}
    for s in lib["songs"]:
        if s["kind"] != "psarc":
            continue
        known = os.path.exists(re.sub(r"\.psarc$", ".lrc", s["path"], flags=re.I))
        if not known and not s.get("lyrics") and s["scanned"] and cache:
            key = s.get("md5") or (key_of(s["path"]) if key_of and not lib["lazy"] else None)
            if key:
                c = KR.lyrics_cache_read(cache, key)
                known = bool(c and c.get("found"))
        g = "with" if (s.get("lyrics") or known) else "online" if s["scanned"] else "unknown"
        out[g].append(s)
    for g in out:
        out[g].sort(key=lambda s: s["label"].lower())
    return out
