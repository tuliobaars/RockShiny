"""
Mirror of R/karaoke.R (karaoke_manifest(), load_karaoke_song(), karaoke_json())
on top of rockshiny_ref.py, plus the frontend fixtures for the karaoke checks:

  karaoke_<tag>.json     exact karaoke_json() payloads of the sample songs
  karaoke_clicks.ogg     a click at every syllable onset of Sultans of Swing
  karaoke_clicks_head.ogg   its first 30 s (quick-start clip)
  modes_sultans_lead.json   a note-highway chart (chart_json()) for the two-mode page test

Usage: python3 tests/reference/karaoke_ref.py [out_dir]
       python3 tests/reference/karaoke_ref.py --compare r_payload.json song.psarc
"""
import hashlib, json, os, subprocess, sys, wave
import xml.etree.ElementTree as ET
sys.path.insert(0, os.path.dirname(__file__))
import rockshiny_ref as R

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SONGS = [("Dire-Straits_Sultans-of-Swing_v443_m.psarc", "sultans"),
         ("B_B_ King & Eric Clapton - Key to the Highway_m.psarc", "keyhighway"),
         ("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "ridingking")]
NO_LYRICS = "Carlos-Santana-ft-Chad-Kroeger_Into-The-Night_v2_m.psarc"

def parse_vocals_sng(buf):                 # mirrors parse_vocals_sng(): 5th array, 60-byte records
    import struct
    pos = 0
    for size in (16, 44, 72, 2376):
        pos += 4 + size * struct.unpack_from("<I", buf, pos)[0]
    n = struct.unpack_from("<I", buf, pos)[0]
    out = []
    for k in range(n):
        o = pos + 4 + 60 * k
        t, note, d = struct.unpack_from("<fif", buf, o)
        out.append((t, d, R.cstr(buf[o + 12:o + 60])))
    return out

def vocals_raw(arc):                       # mirrors song_vocals_raw() (XML preferred, SNG fallback, jvocals last)
    pick = lambda pat: (sorted(arc.find(pat), key=lambda f: "jvocals" in f) or [None])[0]
    xml, sng = pick(r"^songs/arr/.*vocals\.xml$"), pick(r"^songs/bin/.*vocals\.sng$")
    try:
        if xml:
            return [(float(e.get("time")), float(e.get("length") or 0), e.get("lyric") or "")
                    for e in ET.fromstring(arc.read(xml).decode("utf-8-sig")).findall("vocal")] or None
        if sng:
            return parse_vocals_sng(R.sng_decrypt(arc.read(sng))) or None
    except Exception:
        return None
    return None

def vocals_notes(arc):                     # the charted pitches of vocals_raw()'s syllables: [(t, d, lyric, note)]
    import struct
    pick = lambda pat: (sorted(arc.find(pat), key=lambda f: "jvocals" in f) or [None])[0]
    xml, sng = pick(r"^songs/arr/.*vocals\.xml$"), pick(r"^songs/bin/.*vocals\.sng$")
    try:
        if xml:
            return [(float(e.get("time")), float(e.get("length") or 0), e.get("lyric") or "", int(float(e.get("note") or 254)))
                    for e in ET.fromstring(arc.read(xml).decode("utf-8-sig")).findall("vocal")]
        if sng:
            buf = R.sng_decrypt(arc.read(sng)); pos = 0
            for size in (16, 44, 72, 2376): pos += 4 + size * struct.unpack_from("<I", buf, pos)[0]
            n = struct.unpack_from("<I", buf, pos)[0]
            out = []
            for k in range(n):
                o = pos + 4 + 60 * k
                t, note, d = struct.unpack_from("<fif", buf, o)
                out.append((t, d, R.cstr(buf[o + 12:o + 60]), note))
            return out
    except Exception:
        return []
    return []

def karaoke_melody(n):                     # mirrors karaoke_melody()
    p = [x for x in n if x != 254 and 20 < x < 110]
    return len(p) >= 8 and len(set(p)) >= 4 and max(p) - min(p) >= 5

def lyrics_present(v):                     # mirrors lyrics_present()
    import re
    return bool(v) and any(re.sub(r"[+-]+$", "", l or "").strip() for _, _, l in v)

def karaoke_manifest(arc, path=None):      # mirrors karaoke_manifest()
    meta, sections = None, []
    for m in arc.find(r"^manifests/.*\.json$"):
        try: a = list(json.loads(arc.read(m))["Entries"].values())[0]["Attributes"]
        except Exception: continue
        if a.get("SongName") is None: continue
        if meta is None:
            meta = dict(title=a["SongName"], artist=a.get("ArtistName"), album=a.get("AlbumName"),
                        year=None if a.get("SongYear") is None else str(a["SongYear"]), song_length=a.get("SongLength"))
        if a.get("Sections"):
            sections = [dict(name=s.get("Name") or "", number=s.get("Number"), time=s.get("StartTime")) for s in a["Sections"]]
            break
    if meta is None:                       # no manifest: library_meta()'s file-name fallback
        import re
        base = re.sub(r"(_v[0-9_]+)?(_DD)?(_[mp])?\.psarc$", "", os.path.basename(arc.path), flags=re.I)
        meta = dict(title=re.sub(r"[_-]+", " ", base), artist=None, album="", year=None, song_length=None)
    sections = sorted([s for s in sections if s["time"] is not None and s["name"]], key=lambda s: s["time"])
    return meta, R.section_labels(sections)

# ---------------------------------------------------------------- lyrics_online.R
import re, time, urllib.parse, urllib.request, urllib.error
LRCLIB_API = "https://lrclib.net/api"
def lrclib_fetch(url, timeout=10):           # mirrors lrclib_fetch(): JSON, None for 404, errors raise
    req = urllib.request.Request(url, headers={"User-Agent": "RockShiny karaoke (Python; https://lrclib.net/docs)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise
def clean_title(x): return re.sub(r"\s*[([][^)\]]*(live|remaster|version|edit|mix|mono|stereo|feat)[^)\]]*[)\]]", "", x or "", flags=re.I).strip()
def main_artist(x):
    x = re.sub(r"\s*[([]\s*(ft\.?|feat\.?|featuring|with)\s[^)\]]*[)\]]", "", x or "", flags=re.I)
    return re.split(r"\s+(?:ft\.?|feat\.?|featuring|with|&|and|x)\s+|,", x)[0].strip()
def norm(x):
    import unicodedata
    return re.sub(r"[^a-z0-9]+", "", unicodedata.normalize("NFKD", x or "").encode("ascii", "ignore").decode().lower())
def lrclib_search(meta, fetch=lrclib_fetch):  # mirrors lrclib_search()
    title, artist = meta.get("title") or "", meta.get("artist") or ""
    if not title: return None
    enc = lambda x: urllib.parse.quote(x, safe="")
    q = lambda a, t: f"{LRCLIB_API}/search?artist_name={enc(a)}&track_name={enc(t)}"
    urls = list(dict.fromkeys([q(artist, title), q(main_artist(artist), clean_title(title)),
                               f"{LRCLIB_API}/search?q={enc((main_artist(artist) + ' ' + clean_title(title)).strip())}"]))
    want, dur = norm(clean_title(title)), meta.get("song_length")
    for u in urls:
        res = fetch(u)
        if not res: continue
        ok = [r for r in res if (r.get("syncedLyrics") or r.get("plainLyrics")) and not r.get("instrumental")
              and (lambda got: got and (want in got or got in want))(norm(clean_title(r.get("trackName") or r.get("name") or "")))]
        if not ok: continue
        ok.sort(key=lambda r: (not r.get("syncedLyrics"), 0 if dur is None or r.get("duration") is None else abs(r["duration"] - dur)))
        b = ok[0]
        return dict(found=True, lrc=b.get("syncedLyrics") or b.get("plainLyrics"), synced="line" if b.get("syncedLyrics") else "none",
                    lrc_duration=b.get("duration"), source="lrclib", url=f"{LRCLIB_API}/get/{b.get('id', '')}")
    return None
def lyrics_result(x):                        # mirrors lyrics_result(): fixed fields
    return dict(lrc=x.get("lrc"), source=x.get("source"), synced=x.get("synced") or "line",
                lrc_duration=x.get("lrc_duration"), url=x.get("url"), offset_ms=x.get("offset_ms"))
def lyrics_cache_file(cache, key): return os.path.join(cache, "lyrics", key + ".json")
def lyrics_cache_read(cache, key):
    try: return json.load(open(lyrics_cache_file(cache, key), encoding="utf-8")) if cache else None
    except Exception: return None
def lyrics_cache_write(cache, key, entry):   # same file format as R (jsonlite, scalars)
    if not cache: return
    f = lyrics_cache_file(cache, key); os.makedirs(os.path.dirname(f), exist_ok=True)
    entry = dict(entry, time=time.strftime("%Y-%m-%dT%H:%M:%S"))
    with open(f, "w", encoding="utf-8") as fh: json.dump(entry, fh, ensure_ascii=False, separators=(",", ":"))
def lrc_has_times(lrc): return bool(re.search(r"^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]", lrc or "", flags=re.M))
def lyrics_lookup(path, key, meta, online=True, fetch=lrclib_fetch, cache=None, refresh=False):   # mirrors lyrics_lookup()
    side = os.path.splitext(path)[0] + ".lrc"
    cached = None if refresh else lyrics_cache_read(cache, key)
    if os.path.exists(side):
        lrc = "\n".join(open(side, encoding="utf-8-sig").read().splitlines())
        off = cached.get("offset_ms") if cached and cached.get("source") == "file" and cached.get("lrc") == lrc else None
        return lyrics_result(dict(lrc=lrc, source="file", synced="line" if lrc_has_times(lrc) else "none", offset_ms=off))
    if cached:
        if cached.get("found"): return lyrics_result(cached)
        try: age = (time.time() - time.mktime(time.strptime(cached["time"], "%Y-%m-%dT%H:%M:%S"))) / 86400
        except Exception: age = float("inf")
        if age < 7: return None
    if not online: return None
    try: hit = lrclib_search(meta, fetch)
    except Exception as e:
        print(f"  lyrics lookup failed ({e})", file=sys.stderr); return "offline"
    if not hit: lyrics_cache_write(cache, key, dict(found=False)); return None
    lyrics_cache_write(cache, key, hit)
    return lyrics_result(hit)
def lyrics_json(l):                          # mirrors karaoke_lyrics_json() (same member order)
    if "lookup" in l:
        return dict(source="lookup", align=True, lookup=l["lookup"])
    out = dict(source=l["source"], synced=l["synced"], lrc=l["lrc"], lrcDuration=l.get("lrc_duration"), url=l.get("url"), align=True)
    if l.get("offset_ms") is not None: out["offsetMs"] = round(l["offset_ms"])
    return out

def karaoke_payload(path, key=None, online=False, fetch=lrclib_fetch, cache=None, allow_missing=False):
    """mirrors karaoke_json(load_karaoke_song(path)); None when there are no lyrics (and not allow_missing)."""
    arc = R.Psarc(path)
    v = vocals_raw(arc)
    key = key or hashlib.md5(open(path, "rb").read()).hexdigest()
    meta, secs = karaoke_manifest(arc, path)
    lyrics = None
    if not lyrics_present(v):
        lyrics = lyrics_lookup(path, key, meta, online=online, fetch=fetch, cache=cache)
        if lyrics == "offline": lyrics = None
        if lyrics is None:
            if not allow_missing: return None
            lyrics = dict(lookup=dict(artist=meta["artist"] or "", title=meta["title"] or "", album=meta["album"] or "",
                                      duration=meta["song_length"]))
        v = []
    vl = R.vocals_lines([(t, d, l) for t, d, l in v])
    if v:
        notes = [x[3] for x in sorted(vocals_notes(arc))]
        if len(notes) == len(vl["t"]) and karaoke_melody(notes): vl["n"] = notes
    sl = meta["song_length"]
    out = dict(format="rockshiny-karaoke/1", songKey=key,
               meta=dict(title=meta["title"], artist=meta["artist"], album=meta["album"], year=meta["year"],
                         duration=None if sl is None else round(sl, 3)),
               vocals=vl,
               sections=dict(t=[round(s["time"], 3) for s in secs], name=[s["name"] for s in secs], label=[s["label"] for s in secs]))
    if lyrics is not None: out["lyrics"] = lyrics_json(lyrics)
    art = R.song_album_art(arc)
    if art: out["art"] = art
    return out

def click_track(times, path, seconds, sr=44100):
    import numpy as np
    x = np.zeros(int(seconds * sr), dtype=np.float32)
    k = np.arange(int(0.004 * sr))
    burst = (0.9 * np.sin(2 * np.pi * 2000 * k / sr) * np.exp(-k / (0.001 * sr))).astype(np.float32)
    for t in times:
        i = int(round(t * sr))
        if i + len(burst) < len(x): x[i:i + len(burst)] += burst
    wav = path + ".wav"
    with wave.open(wav, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
        w.writeframes(np.repeat(pcm, 2).tobytes())
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libvorbis", "-q:a", "5", path], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-t", "30", "-c:a", "libvorbis", "-q:a", "5",
                    path.replace(".ogg", "_head.ogg")], check=True)
    os.remove(wav)

def main(out):
    os.makedirs(out, exist_ok=True)
    for fname, tag in SONGS:
        p = karaoke_payload(os.path.join(ROOT, "songs", fname))
        with open(os.path.join(out, f"karaoke_{tag}.json"), "w") as f: json.dump(p, f, separators=(",", ":"), ensure_ascii=False)
        n_lines = max(p["vocals"]["l"]) + 1
        print(f"karaoke_{tag}: {len(p['vocals']['t'])} syllables, {n_lines} lines, {len(p['sections']['t'])} sections")
    assert karaoke_payload(os.path.join(ROOT, "songs", NO_LYRICS)) is None
    # a highway chart of the same song (both players on one page, as in the app)
    arc = R.Psarc(os.path.join(ROOT, "songs", SONGS[0][0]))
    chart = R.build_chart(R.parse_arrangement_xml(arc.read("songs/arr/direstraitssultansplum_lead.xml")), 1.0)
    chart["meta"].update(arrangement="Lead")
    with open(os.path.join(out, "modes_sultans_lead.json"), "w") as f:
        json.dump(R.chart_json(chart, hashlib.md5(b"modes").hexdigest(), vocals=R.song_vocals(arc), art=R.song_album_art(arc)), f, separators=(",", ":"))
    sul = json.load(open(os.path.join(out, "karaoke_sultans.json")))
    click_track(sul["vocals"]["t"], os.path.join(out, "karaoke_clicks.ogg"), 300)
    print("karaoke_clicks.ogg: clicks at", len(sul["vocals"]["t"]), "syllable onsets")

def compare(r_json, path):
    """Compare an R karaoke_json() payload (from webR) with this mirror, field by field."""
    r = json.load(open(r_json))
    p = karaoke_payload(path, key=r["songKey"])
    bad = [k for k in ("format", "songKey", "meta", "vocals", "sections", "art") if r.get(k) != p.get(k)]
    print(os.path.basename(path), "identical" if not bad else f"DIFFERENT in {bad}")
    return not bad

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--compare":
        ok = all(compare(a, b) for a, b in zip(sys.argv[2::2], sys.argv[3::2]))
        sys.exit(0 if ok else 1)
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "tests", "frontend", "fixtures"))
