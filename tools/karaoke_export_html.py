#!/usr/bin/env python3
"""
karaoke_export_html.py -- R's karaoke_export_html() in Python, for machines
without R (e.g. a sandbox or a CI runner). Writes the same standalone karaoke
page, byte for byte: same template and player (inst/karaoke), same song data
(the Python mirror of R/karaoke.R and R/lyrics_online.R in tests/reference).

  python3 tools/karaoke_export_html.py          # -> exports/index.html: every song in songs/
  python3 tools/karaoke_export_html.py songs/Dire-Straits_Sultans-of-Swing_v443_m.psarc -o sultans.html
  python3 tools/karaoke_export_html.py --library songs -o songbook.html --audio files
  python3 tools/karaoke_export_html.py SONG.psarc -o lyrics.html --audio none

Big libraries (more than 50 songs; R: karaoke_export_library()) become a
*catalog*: one small page listing the songs and one script per song, loaded
when the song is picked -- from disk or any web server:

  python3 tools/karaoke_export_html.py --library ~/dlc --recursive -o karaoke/index.html --jobs 4
  python3 tools/karaoke_export_html.py --library ~/dlc --audio none -o karaoke/index.html   # lyrics only: fast
  python3 tools/karaoke_export_html.py --library ~/dlc --serve     # nothing built up front: each song (lyrics,
                                                                    # then audio) is made when first opened

The library is read through the index the app keeps (<cache>/library/index.tsv:
title, artist, lyrics or not, per file), so listing 827 songs takes ~0.1 s once
they were scanned; converting the audio is the slow part (seconds per song), done
in --jobs processes, and skipped for songs whose page script is up to date.

Lyrics: from the archive; for songs without, a sidecar .lrc (same name), the
cache, or LRCLIB (lrclib.net; --no-online to skip). Songs whose lyrics cannot
be found now are kept and looked up by the page in the browser
(--no-lookup-in-browser to drop them). LRC lyrics are synced to the recording
by the page itself (inst/karaoke/karaoke-sync.js).

Requirements: Python 3.9+ only. Optional: `pip install cryptography` (faster
decryption; a pure-Python AES is used otherwise). For audio, a Wwise decoder
plus ffmpeg:
  * vgmstream-cli on PATH (what the app uses), or
  * `pip install wem2ogg` (repackages the Wwise Vorbis stream losslessly; its
    output is sample-identical to vgmstream's);
  * ffmpeg re-encodes to the delivery format (without it, the repackaged Ogg
    stream is embedded as is, about twice the size).

Audio and lyrics are shared with the app: conversions and lookups already in
RockShiny's cache (tools::R_user_dir("RockShiny", "cache")) are reused, and new
ones are stored there (--cache-dir to change, --no-cache to skip). Only share
pages with embedded audio when you have the rights to the recording.
"""
import argparse, base64, hashlib, json, os, re, shutil, subprocess, sys, tempfile, time, unicodedata

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "tests", "reference"))
import karaoke_ref as KR          # noqa: E402  (mirror of R/karaoke.R)
import rockshiny_ref as R         # noqa: E402  (mirror of R/psarc.R, R/audio.R, ...)

# R/karaoke_export.R: KARAOKE_AUDIO_MIME; R/audio.R: AUDIO_FORMATS (ffmpeg arguments)
AUDIO_MIME = {"ogg": "audio/ogg", "opus": "audio/ogg", "m4a": "audio/mp4", "mp3": "audio/mpeg",
              "flac": "audio/flac", "wav": "audio/wav"}
FFMPEG_ARGS = {"ogg": ["-c:a", "libvorbis", "-q:a", "5"],
               "m4a": ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"],
               "mp3": ["-c:a", "libmp3lame", "-q:a", "2"]}
CACHED_FORMATS = ["ogg", "m4a", "opus", "flac", "wav"]      # audio_cache_state(): best first


def log(*a):
    print(*a, file=sys.stderr)


# ---- song data ------------------------------------------------------------------------
class Song:
    """load_karaoke_song(): lyrics (archive, .lrc, cache, LRCLIB), metadata, sections, art."""
    def __init__(self, path, online=True, cache=None, allow_missing=False, fetch=None):
        if not path.lower().endswith(".psarc"):
            raise ValueError(f"Karaoke needs a Rocksmith .psarc file ({os.path.basename(path)} is not one).")
        if not os.path.exists(path):
            raise ValueError(f"{path}: no such file.")
        self.path = os.path.abspath(path)
        self.name = os.path.basename(path)
        self.arc = R.Psarc(self.path)
        self.key = file_md5(self.path)
        self.payload = KR.karaoke_payload(self.path, key=self.key, online=online, fetch=fetch or KR.lrclib_fetch,
                                          cache=cache, allow_missing=allow_missing)
        if self.payload is None:
            raise ValueError(f"{self.name} has no lyrics in the file" + (", and none were found online (LRCLIB)" if online else "")
                             + ". Put a .lrc file next to it (same name).")
        m = self.payload["meta"]
        self.title, self.artist = m.get("title") or self.name, m.get("artist")
        ly = self.payload.get("lyrics")
        self.lyrics_note = ("" if not ly else " (lyrics: looked up by the page)" if ly["source"] == "lookup"
                            else f" (lyrics: {'.lrc file' if ly['source'] == 'file' else 'LRCLIB'})")

    def slug(self):                                           # karaoke_slug()
        s = f"{self.artist or ''}-{self.payload['meta'].get('title') or self.key}"
        s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
        s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-")
        return s.lower() if s else self.key[:12]


def file_md5(path):                                           # file_key(): the cache key
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# ---- audio ----------------------------------------------------------------------------
def r_cache_root():
    """tools::R_user_dir("RockShiny", "cache") (the app's audio cache)."""
    if os.environ.get("R_USER_CACHE_DIR"):
        base = os.environ["R_USER_CACHE_DIR"]
    elif sys.platform == "darwin":
        return os.path.expanduser("~/Library/Caches/org.R-project.R/R/RockShiny")
    elif os.name == "nt":
        base = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "R", "cache")
    else:
        base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
    return os.path.join(base, "R", "RockShiny")


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{os.path.basename(cmd[0])} failed: {(r.stderr or r.stdout).strip()[-400:]}")


def decode_wem(song, tmp):
    """The song's .wem (find_song_wem()) -> a decodable file: WAV via vgmstream-cli,
    else an Ogg Vorbis stream via wem2ogg."""
    wem = song.arc.read(R.find_song_wem(song.arc))
    vgm = shutil.which("vgmstream-cli") or shutil.which("vgmstream_cli") or shutil.which("vgmstream")
    if vgm:
        src, out = os.path.join(tmp, "audio.wem"), os.path.join(tmp, "decoded.wav")
        with open(src, "wb") as f:
            f.write(wem)
        run([vgm, "-o", out, src])
        return out
    try:
        import wem2ogg
    except ImportError:
        raise RuntimeError("no Wwise decoder: put vgmstream-cli on PATH, or `pip install wem2ogg`")
    out = os.path.join(tmp, "decoded.ogg")
    with open(out, "wb") as f:
        f.write(wem2ogg.wem_to_ogg(wem))
    return out


def encode(src, out, fmt, ffmpeg):
    part = f"{out}.partial.{os.getpid()}.{fmt}"          # renamed when complete (cache safety)
    try:
        run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", src, "-vn", *FFMPEG_ARGS[fmt], part])
        os.replace(part, out)
    finally:
        if os.path.exists(part):
            os.remove(part)
    return out


def song_audio(song, fmt, cache_dir):
    """karaoke_export_audio(): the cached conversion (or a new one, stored in the cache),
    re-encoded to mp3 / m4a on request, or the repackaged Wwise stream ("copy")."""
    ffmpeg = shutil.which("ffmpeg")
    d = os.path.join(cache_dir, song.key) if cache_dir else None
    if d and fmt in ("auto", "mp3", "m4a"):
        for ext in CACHED_FORMATS:
            p = os.path.join(d, f"audio.{ext}")
            if os.path.isfile(p) and os.path.getsize(p) > 0:
                if fmt == "auto" or ext == fmt:
                    return p, "cache"
                out = os.path.join(d, f"export.{fmt}")
                if os.path.isfile(out) and os.path.getsize(out) > 0 and os.path.getmtime(out) >= os.path.getmtime(p):
                    return out, "cache"
                if not ffmpeg:
                    raise RuntimeError(f"ffmpeg is needed to re-encode the audio as {fmt}")
                return encode(p, out, fmt, ffmpeg), "re-encoded"
    with tempfile.TemporaryDirectory() as tmp:
        dec = decode_wem(song, tmp)
        how = "vgmstream" if dec.endswith(".wav") else "wem2ogg"
        target = {"auto": "ogg", "copy": None}.get(fmt, fmt)
        if target and not ffmpeg:
            if dec.endswith(".ogg"):
                target = None                                  # keep the repackaged Vorbis stream
            else:
                raise RuntimeError("ffmpeg is needed to encode the decoded audio")
        if target is None:
            ext = os.path.splitext(dec)[1][1:]
            name = f"audio.{ext}" if fmt == "auto" else f"export-copy.{ext}"
        else:
            ext, name = target, ("audio.ogg" if fmt == "auto" else f"export.{target}")
        if d:
            os.makedirs(d, exist_ok=True)
            out = os.path.join(d, name)
        else:
            out = os.path.join(tempfile.mkdtemp(prefix="rs-karaoke-"), name)
        if target is None:
            shutil.copyfile(dec, out)
        else:
            encode(dec, out, target, ffmpeg)
        return out, how


# ---- page -----------------------------------------------------------------------------
def jnum(o):
    """jsonlite-compatible numbers: whole doubles without ".0" (toJSON(digits = NA))."""
    if isinstance(o, float) and o.is_integer():
        return int(o)
    if isinstance(o, dict):
        return {k: jnum(v) for k, v in o.items()}
    if isinstance(o, list):
        return [jnum(v) for v in o]
    return o


def to_json(o):
    return json.dumps(jnum(o), separators=(",", ":"), ensure_ascii=False)


def asset(*parts):                      # readLines() + paste(collapse = "\n")
    with open(os.path.join(ROOT, "inst", *parts), encoding="utf-8") as f:
        return "\n".join(f.read().splitlines())


def script(code):
    return "<script>\n" + re.sub(r"</(script)", r"<\\/\1", code, flags=re.I) + "\n</script>"


def fill(html, key, value):             # karaoke_fill(): first occurrence, literally
    i = html.find(key)
    if i < 0:
        raise ValueError(f"template placeholder {key} not found")
    return html[:i] + value + html[i + len(key):]


def export(songs, out, audio="embed", audio_format="auto", title=None, options=None, cache_dir=None):
    files_dir = os.path.splitext(out)[0] + "_files"
    payloads, blobs = [], []
    for i, song in enumerate(songs, 1):
        p = dict(song.payload)
        if audio != "none":
            try:
                src, how = song_audio(song, audio_format, cache_dir)
                ext = os.path.splitext(src)[1][1:].lower()
                mime = AUDIO_MIME.get(ext, "application/octet-stream")
                if audio == "embed":
                    sid = f"rs-karaoke-audio-{i}"
                    with open(src, "rb") as f:
                        blobs.append(f'<script type="text/plain" id="{sid}">{base64.b64encode(f.read()).decode()}</script>')
                    p["audio"] = {"embed": sid, "type": mime}
                else:
                    os.makedirs(files_dir, exist_ok=True)
                    dest = os.path.join(files_dir, f"{song.slug()}.{ext}")
                    shutil.copyfile(src, dest)
                    p["audio"] = {"src": f"{os.path.basename(files_dir)}/{os.path.basename(dest)}", "type": mime}
                log(f"  audio: {song.title}: {ext}, {os.path.getsize(src) / 1e6:.1f} MB ({how})")
            except Exception as e:
                log(f"  warning: no audio for {song.title}: {e} (the page will offer 'Load audio...').")
        payloads.append(to_json(p))
    if title is None:
        title = f"{songs[0].title} \u2014 karaoke" if len(songs) == 1 else "RockShiny karaoke"
    return write_page(out, title, options, payloads, blobs)


def write_page(out, title, options, payloads, blobs=()):
    """page.html filled like karaoke_export_html() does: the player, its page host and the data."""
    data = ('{"format":"rockshiny-karaoke-page/1","title":' + to_json(title) + ',"options":' +
            (to_json(options) if options else "{}") + ',"songs":[' + ",".join(payloads) + "]}")
    html = asset("karaoke", "page.html")
    esc = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = fill(html, "{{TITLE}}", esc)
    html = fill(html, "{{STYLE}}", "<style>\n" + asset("karaoke", "karaoke.css") + "\n" + asset("karaoke", "page.css") + "\n</style>")
    html = fill(html, "{{DATA}}", '<script type="application/json" id="rs-karaoke-data">' + data.replace("<", "\\u003c") + "</script>")
    html = fill(html, "{{AUDIO}}", "\n".join(blobs))
    html = fill(html, "{{SCRIPTS}}", "\n".join(script(asset(*a)) for a in
                (("highway", "clock.js"), ("highway", "dds.js"), ("karaoke", "karaoke.js"), ("karaoke", "karaoke-sync.js"), ("karaoke", "karaoke-page.js"))))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "wb") as f:
        f.write(html.encode("utf-8"))
    return out


# ---- catalogs: big libraries (karaoke_export_library()) ------------------------------------
# One page with the song list (from the library index: no archive is opened to
# write it) plus one small script per song, loaded when the song is picked:
#   <out>.html  <out>_files/songs/<id>.js  <out>_files/audio/<id>.<ext>
# Works from disk (file://) and from any static server; --serve builds each song
# (payload, audio) the first time it is requested instead of all of them up front.
CATALOG_MIN = 50          # --library builds with more songs than this become catalogs (the app's
                          # library threshold, R/library.R)
EMBED_MAX = 12            # songs with embedded audio in one page: ~0.45 s each before the first
                          # note plays (tests/perf/embed_bench.py); R: KARAOKE_EMBED_MAX


def catalog_id(e):
    """karaoke_catalog_id(): "artist-title-" + 6 hex digits of the md5 of the path inside the library folder."""
    s = unicodedata.normalize("NFKD", f"{e.get('artist') or ''}-{e.get('title') or ''}").encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").lower()[:60].strip("-")
    return f"{s or 'song'}-{hashlib.md5(e['rel'].encode('utf-8')).hexdigest()[:6]}"


def catalog_stub(e, files_rel):
    sid = catalog_id(e)
    meta = dict(title=e.get("title"), artist=e.get("artist"), album=e.get("album"), year=e.get("year"),
                duration=None if e.get("length") is None else round(e["length"], 3))
    return dict(id=sid, meta=meta, lyrics="archive" if e.get("lyrics") else "web", src=f"{files_rel}/songs/{sid}.js")


def catalog_entries(library, recursive=False, cache=None, lookup_in_browser=True, progress=True):
    """The songs of a library folder that can be sung: lyrics in the archive, a sidecar .lrc or
    cached lyrics, plus (lookup_in_browser) the ones whose lyrics are looked up online."""
    import library_ref as L
    t0 = time.time()
    def tick(i, n):
        if progress and n > 50 and sys.stderr.isatty():
            print(f"\r  scanning the library: {i}/{n}", end="", file=sys.stderr, flush=True)
    lib = L.open_library(library, recursive=recursive, budget=float("inf"), cache=cache, progress=tick)
    if progress and lib["songs"] and time.time() - t0 > 1:
        print(f"\r  scanned {len(lib['songs'])} files in {time.time() - t0:.1f} s" + " " * 20, file=sys.stderr)
    g = L.karaoke_groups(lib, cache=cache, key_of=file_md5)
    base = os.path.realpath(library).replace(os.sep, "/") + "/"
    out = g["with"] + (g["online"] if lookup_in_browser else [])
    for e in out:
        e["rel"] = e["path"][len(base):] if e["path"].startswith(base) else os.path.basename(e["path"])
    return out, lib


def build_catalog_song(e, files_dir, files_rel, audio="files", audio_format="auto", cache=None, online=True,
                       allow_missing=True, force=False):
    """One song of a catalog: <files_dir>/songs/<id>.js (+ audio). -> (id, md5 or None, message)."""
    sid = catalog_id(e)
    js = os.path.join(files_dir, "songs", sid + ".js")
    src_mtime = os.path.getmtime(e["path"])
    if not force and os.path.exists(js) and os.path.getmtime(js) >= src_mtime:
        return sid, e.get("md5"), "up to date"
    song = Song(e["path"], online=online, cache=cache, allow_missing=allow_missing)
    p = dict(song.payload)
    note = ""
    if audio == "files":
        try:
            src, how = song_audio(song, audio_format, cache)
            ext = os.path.splitext(src)[1][1:].lower()
            os.makedirs(os.path.join(files_dir, "audio"), exist_ok=True)
            dest = os.path.join(files_dir, "audio", f"{sid}.{ext}")
            shutil.copyfile(src, dest)
            p["audio"] = {"src": f"{files_rel}/audio/{sid}.{ext}", "type": AUDIO_MIME.get(ext, "application/octet-stream")}
            note = f"audio {ext} ({how})"
        except Exception as ex:
            note = f"no audio: {ex}"
    elif isinstance(audio, dict):                                  # lazy server: audio made on request
        p["audio"] = audio
    os.makedirs(os.path.dirname(js), exist_ok=True)
    tmp = f"{js}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(f"RSKaraokeSong({json.dumps(sid)},{to_json(p)});\n")
    os.replace(tmp, js)
    return sid, song.key, note


def _build_one(args):                                              # (process pool)
    try:
        return build_catalog_song(*args[0], **args[1])
    except Exception as ex:
        return catalog_id(args[0][0]), None, f"error: {ex}"


def export_catalog(entries, out, audio="files", audio_format="auto", title=None, options=None, cache=None,
                   online=True, allow_missing=True, jobs=1, build=True):
    """Write a catalog page; build every song's script (and audio) unless build=False (--serve builds on request)."""
    files_dir = os.path.splitext(out)[0] + "_files"
    files_rel = os.path.basename(files_dir)
    stubs = [catalog_stub(e, files_rel) for e in entries]
    if build:
        t0, done, failed = time.time(), 0, set()
        tasks = [((e, files_dir, files_rel), dict(audio=audio, audio_format=audio_format, cache=cache, online=online,
                                                   allow_missing=allow_missing)) for e in entries]
        if jobs > 1:
            from concurrent.futures import ProcessPoolExecutor
            with ProcessPoolExecutor(jobs) as pool:
                results = pool.map(_build_one, tasks, chunksize=1)
                results = list(_progress(results, len(tasks), t0))
        else:
            results = list(_progress(map(_build_one, tasks), len(tasks), t0))
        import library_ref as L
        for (sid, key, note), e in zip(results, entries):
            if note.startswith("error"):
                failed.add(sid)
                log(f"  skipped {e['label']}: {note[7:]}")
            elif key and cache:
                L.note_key(cache, e["path"], key)
        stubs = [s for s in stubs if s["id"] not in failed]
        log(f"  built {len(entries) - len(failed)} song(s) in {time.time() - t0:.1f} s")
    write_page(out, title or "RockShiny karaoke", options, [to_json(s) for s in stubs])
    return out, stubs


def _progress(results, n, t0):
    tty = sys.stderr.isatty()
    for i, r in enumerate(results, 1):
        if n > 10 and (i == n or (tty and i % 10 == 0) or (not tty and i % max(1, n // 4) == 0)):
            print(f"{chr(13) if tty else ''}  songs: {i}/{n} ({time.time() - t0:.0f} s)", end="" if tty and i < n else "\n", file=sys.stderr, flush=True)
        yield r


def serve_catalog(out, entries, port, audio="files", audio_format="auto", cache=None, online=True, allow_missing=True):
    """Serve a catalog page; each song (payload, then audio) is built the first time it is requested."""
    import functools, http.server, threading, urllib.parse
    from concurrent.futures import ThreadPoolExecutor
    files_dir = os.path.splitext(out)[0] + "_files"
    files_rel = os.path.basename(files_dir)
    by_id = {catalog_id(e): e for e in entries}
    pool = ThreadPoolExecutor(max(1, min(4, (os.cpu_count() or 2) // 2)))
    audio_jobs, built, lock = {}, set(), threading.Lock()

    def audio_ext(song):
        d = os.path.join(cache, song.key) if cache else None
        if d and audio_format == "auto":
            for ext in CACHED_FORMATS:
                if os.path.isfile(os.path.join(d, f"audio.{ext}")):
                    return ext
        if audio_format == "copy":                                    # decode_wem(): WAV from vgmstream, else Ogg
            return "wav" if (shutil.which("vgmstream-cli") or shutil.which("vgmstream_cli") or shutil.which("vgmstream")) else "ogg"
        return {"auto": "ogg"}.get(audio_format, audio_format)

    def make_audio(sid, song, ext):
        src, how = song_audio(song, audio_format, cache)
        os.makedirs(os.path.join(files_dir, "audio"), exist_ok=True)
        dest = os.path.join(files_dir, "audio", f"{sid}.{ext}")
        shutil.copyfile(src, dest)
        log(f"  audio ready: {by_id[sid]['label']} ({how})")
        return dest

    def ensure_song(sid):
        js = os.path.join(files_dir, "songs", sid + ".js")
        e = by_id.get(sid)
        if e is None:
            return
        with lock:
            if sid in built and os.path.exists(js):
                return
            t0 = time.time()
            song = Song(e["path"], online=online, cache=cache, allow_missing=allow_missing)
            a = None
            if audio == "files":
                ext = audio_ext(song)
                a = {"src": f"{files_rel}/audio/{sid}.{ext}", "type": AUDIO_MIME.get(ext, "application/octet-stream")}
                dest = os.path.join(files_dir, "audio", f"{sid}.{ext}")
                if sid not in audio_jobs and not os.path.exists(dest):
                    audio_jobs[sid] = pool.submit(make_audio, sid, song, ext)       # starts now, while the lyrics load
            build_catalog_song(e, files_dir, files_rel, audio=a or "none", cache=cache, online=online,
                               allow_missing=allow_missing, force=True)
            built.add(sid)
            log(f"  song ready: {e['label']} ({time.time() - t0:.2f} s)")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
            m = re.match(rf"^/{re.escape(files_rel)}/(songs|audio)/([^/]+?)\.[A-Za-z0-9]+$", path)
            try:
                if m and m.group(1) == "songs":
                    ensure_song(m.group(2))
                elif m:
                    if m.group(2) not in audio_jobs:
                        ensure_song(m.group(2))
                    job = audio_jobs.get(m.group(2))
                    if job is not None:
                        job.result()                                   # wait for the conversion
            except Exception as ex:
                log(f"  {path}: {ex}")
                self.send_error(404, str(ex)[:200])
                return
            super().do_GET()

    handler = functools.partial(Handler, directory=os.path.dirname(os.path.abspath(out)))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    log(f"serving http://localhost:{port}/{os.path.basename(out)}  ({len(entries)} songs, each built when first opened; Ctrl-C to stop)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="Write a standalone RockShiny karaoke page (R: karaoke_export_html()). "
                                 "Without arguments: every song in songs/ -> exports/index.html.")
    ap.add_argument("songs", nargs="*", help=".psarc files (several make a songbook)")
    ap.add_argument("--library", metavar="DIR", help="all songs in DIR that can be sung (like karaoke_choices())")
    ap.add_argument("--recursive", action="store_true", help="--library: include subfolders")
    ap.add_argument("-o", "--output", help="output .html (default: exports/index.html, or karaoke.html for given songs)")
    ap.add_argument("--no-online", action="store_true", help="do not look up missing lyrics on LRCLIB")
    ap.add_argument("--no-lookup-in-browser", action="store_true",
                    help="drop songs whose lyrics cannot be found now (default: the page looks them up when opened)")
    ap.add_argument("--audio", choices=["embed", "files", "none"], default=None,
                    help="embed in the page (default for up to %d songs), copy next to it (<output>_files/), or none" % EMBED_MAX)
    ap.add_argument("--audio-format", choices=["auto", "mp3", "m4a", "copy"], default="auto",
                    help="auto: the app's format (Ogg Vorbis); mp3/m4a: widest browser support; "
                         "copy: the losslessly repackaged Wwise stream (larger, but no re-encoding)")
    ap.add_argument("--catalog", action="store_true",
                    help="one page listing the songs, each song loaded when picked (automatic for --library "
                         "with more than %d songs; --single to prevent)" % CATALOG_MIN)
    ap.add_argument("--single", action="store_true", help="never make a catalog")
    ap.add_argument("--jobs", type=int, default=1, help="catalog: songs built in parallel (audio conversion is the slow part)")
    ap.add_argument("--title", help="page title")
    ap.add_argument("--view", choices=["stage", "sheet"], help="initial view")
    ap.add_argument("--text-size", type=float, help="initial text size (1 = 100%%)")
    ap.add_argument("--cache-dir", help=f"audio cache shared with the app (default: {r_cache_root()})")
    ap.add_argument("--no-cache", action="store_true", help="neither read nor write the audio cache")
    ap.add_argument("--serve", nargs="?", const=8000, type=int, metavar="PORT",
                    help="serve the page at http://localhost:PORT/ (default 8000) until Ctrl-C; a catalog is then "
                         "not built up front: each song (lyrics, audio) is made the first time it is opened")
    a = ap.parse_args(argv)

    if not a.songs and not a.library:                           # the default build: the whole library
        a.library = os.path.join(ROOT, "songs")
        a.output = a.output or os.path.join(ROOT, "exports", "index.html")
    if a.library and not os.path.isdir(a.library):
        ap.error(f"{a.library}: no such folder")
    cache = None if a.no_cache else (a.cache_dir or r_cache_root())
    options = {k: v for k, v in (("view", a.view), ("textScale", a.text_size)) if v is not None}
    entries = []
    if a.library:
        entries, lib = catalog_entries(a.library, a.recursive, cache=cache, lookup_in_browser=not a.no_lookup_in_browser)
        log(f"{a.library}: {len(lib['songs'])} song file(s), {len(entries)} can be sung "
            f"({sum(1 for e in entries if e.get('lyrics'))} with lyrics in the file)")
        if not lib["songs"]:
            ap.exit(2, f"error: no .psarc files in {a.library}" + ("" if a.recursive else " (add --recursive for subfolders)") + "\n")
    catalog = not a.single and (a.catalog or len(entries) > CATALOG_MIN)

    if catalog:                                                 # big library: a catalog
        if a.songs:
            ap.error("a catalog is made from --library only")
        if not entries:
            ap.exit(2, "error: none of the songs has lyrics\n")
        a.output = a.output or "karaoke.html"
        audio = a.audio or "files"
        if audio == "embed":
            log("  note: a catalog keeps the audio next to the page (--audio files), not inside it")
            audio = "files"
        title = a.title or "RockShiny karaoke"
        if a.serve:
            out, stubs = export_catalog(entries, a.output, title=title, options=options, build=False)
            log(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB, {len(stubs)} songs)")
            serve_catalog(out, entries, a.serve, audio=audio, audio_format=a.audio_format, cache=cache,
                          online=not a.no_online, allow_missing=not a.no_lookup_in_browser)
            return out
        out, stubs = export_catalog(entries, a.output, audio=audio, audio_format=a.audio_format, title=title, options=options,
                                    cache=cache, online=not a.no_online, allow_missing=not a.no_lookup_in_browser,
                                    jobs=max(1, a.jobs))
        log(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB, {len(stubs)} songs) + {os.path.splitext(out)[0]}_files/")
        return out

    a.output = a.output or "karaoke.html"
    paths = list(a.songs) + [e["path"] for e in entries]
    if not paths:
        ap.error("no .psarc files found")
    songs = []
    for p in paths:
        try:
            songs.append(Song(p, online=not a.no_online, cache=cache, allow_missing=not a.no_lookup_in_browser))
        except Exception as e:
            if not a.library or p in a.songs:
                ap.exit(2, f"error: {e}\n")
            log(f"  skipped: {e}")
    if not songs:
        ap.exit(2, "error: none of the songs has lyrics\n")
    if a.library:                                               # library order: "Artist - Title"
        songs.sort(key=lambda s: f"{s.artist or ''} \u2014 {s.title}".lower())
    audio = a.audio or "embed"
    if audio == "embed" and len(songs) > EMBED_MAX:
        log(f"  note: {len(songs)} songs are too many to embed their audio in one page (max {EMBED_MAX}): "
            "the audio goes next to it (--audio files)")
        audio = "files"
    log(f"{len(songs)} song(s): " + ", ".join(s.title + s.lyrics_note for s in songs))
    out = export(songs, a.output, audio=audio, audio_format=a.audio_format, title=a.title, options=options, cache_dir=cache)
    log(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)")
    if a.serve:
        import functools, http.server
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.dirname(os.path.abspath(out)))
        srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.serve), handler)
        log(f"serving http://localhost:{a.serve}/{os.path.basename(out)}  (Ctrl-C to stop)")
        try: srv.serve_forever()
        except KeyboardInterrupt: pass
    return out


if __name__ == "__main__":
    main()
