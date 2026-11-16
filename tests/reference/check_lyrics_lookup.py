"""
The Python lyrics lookup (karaoke_ref.py, used by tools/karaoke_export_html.py)
over real HTTP, against a local stand-in for LRCLIB's /api/search:
query variants, the choice of result, the cache (same files as R/lyrics_online.R),
404 / offline handling.

  python3 tests/reference/check_lyrics_lookup.py
"""
import json, os, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
sys.path.insert(0, os.path.dirname(__file__))
import karaoke_ref as KR

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SONG = os.path.join(ROOT, "songs", "Carlos-Santana-ft-Chad-Kroeger_Into-The-Night_v2_m.psarc")
RESULTS = [
    {"id": 1, "trackName": "Into the Night (Live)", "artistName": "Santana", "duration": 200, "instrumental": False, "plainLyrics": "unsynced"},
    {"id": 2, "trackName": "Into the Night", "artistName": "Santana", "duration": 226, "instrumental": False,
     "syncedLyrics": "[00:10.00]stand-in line\n[00:14.00]another stand-in line", "plainLyrics": "x"},
    {"id": 3, "trackName": "Some Other Song", "artistName": "Santana", "duration": 226, "instrumental": False, "syncedLyrics": "[00:01.00]no"},
]
seen = []
class LRCLIB(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query); seen.append((u.path, q, self.headers.get("User-Agent")))
        if u.path != "/api/search": self.send_response(404); self.end_headers(); return
        # like LRCLIB: the full "Carlos Santana (ft Chad Kroeger)" finds nothing, the main artist does
        body = [] if "(ft" in q.get("artist_name", [""])[0] else RESULTS
        data = json.dumps(body).encode(); self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)

failures = []
def check(cond, msg):
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond: failures.append(msg)

def main():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), LRCLIB); port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    KR.LRCLIB_API = f"http://127.0.0.1:{port}/api"
    cache = tempfile.mkdtemp(prefix="rs-lyrics-")
    meta = dict(title="Into The Night", artist="Carlos Santana (ft Chad Kroeger)", album="Single", song_length=225.6)
    if not os.path.exists(SONG):
        print("skipped: the sample song without lyrics is not in songs/"); return
    key = KR.hashlib.md5(open(SONG, "rb").read()).hexdigest()

    print("lookup over HTTP")
    l = KR.lyrics_lookup(SONG, key, meta, online=True, cache=cache)
    check(l and l["source"] == "lrclib" and l["synced"] == "line" and l["lrc"].startswith("[00:10.00]stand-in") and l["lrc_duration"] == 226,
          f"picked the synced result of the same song and length: {l and l['url']}")
    check(len(seen) == 2 and seen[0][1]["artist_name"] == ["Carlos Santana (ft Chad Kroeger)"] and seen[1][1]["artist_name"] == ["Carlos Santana"]
          and seen[1][1]["track_name"] == ["Into The Night"] and "RockShiny" in (seen[0][2] or ""),
          f"{len(seen)} requests: full artist, then the main artist; User-Agent {seen[0][2]!r}")
    n = len(seen)
    l2 = KR.lyrics_lookup(SONG, key, meta, online=True, cache=cache)
    c = json.load(open(KR.lyrics_cache_file(cache, key), encoding="utf-8"))
    check(l2["lrc"] == l["lrc"] and len(seen) == n and c["found"] is True and c["source"] == "lrclib" and "time" in c,
          "second lookup from the cache (no request); cache file in R's format")
    p = KR.karaoke_payload(SONG, key=key, online=True, cache=cache)
    check(p["lyrics"]["source"] == "lrclib" and p["vocals"]["t"] == [] and p["lyrics"]["align"] is True and "offsetMs" not in p["lyrics"],
          "payload: empty vocals + the LRC, to be synced by the page")

    print("not found, offline, 404")
    KR.LRCLIB_API = f"http://127.0.0.1:{port}/nothing"
    cache2 = tempfile.mkdtemp(prefix="rs-lyrics-")
    check(KR.lrclib_fetch(f"http://127.0.0.1:{port}/nothing/search?q=x") is None, "HTTP 404 -> None (not an error)")
    KR.LRCLIB_API = "http://127.0.0.1:9/api"                   # nothing listens on port 9
    r = KR.lyrics_lookup(SONG, key, meta, online=True, cache=cache2)
    check(r == "offline" and not os.path.exists(KR.lyrics_cache_file(cache2, key)), "unreachable -> 'offline', nothing cached")
    check(KR.karaoke_payload(SONG, key=key, online=True, cache=cache2) is None and
          KR.karaoke_payload(SONG, key=key, online=True, cache=cache2, allow_missing=True)["lyrics"]["source"] == "lookup",
          "without lyrics: dropped, or kept for the page to look up (allow_missing)")
    srv.shutdown()
    print("\nALL CHECKS PASSED" if not failures else f"\n{len(failures)} FAILURE(S)")
    return cache, key

if __name__ == "__main__":
    out = main()
    if out and "--print-cache" in sys.argv: print("CACHE", out[0], out[1])
    sys.exit(1 if failures else 0)
