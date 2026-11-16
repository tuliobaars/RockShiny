"""
A big synthetic song library for stress tests: N distinct Rocksmith .psarc
archives built from the sample songs in songs/ (real charts, lyrics, album art
and Wwise audio), each with its own artist, title, album and year in the
manifests -- so every file has its own content hash, like a real library.

About a quarter have no lyrics (vocals removed), like CDLC collections; sizes
follow the sources (4-18 MB), mixed to a chosen average (default: 827 files,
~7.5 MB each, ~6.2 GB, the size of a real library we were asked to handle).

  python3 tests/reference/make_big_library.py OUT_DIR [--n 827] [--avg-mb 7.5] [--nested]

Also the PSARC *writer* (the inverse of rockshiny_ref.Psarc): header, AES-CFB
encrypted TOC, 64 KiB zlib blocks (raw when they do not compress).
"""
import argparse, hashlib, json, os, random, struct, sys, zlib
sys.path.insert(0, os.path.dirname(__file__))
import rockshiny_ref as R

BLOCK = 65536

def aes_cfb128_encrypt(data, key, iv):          # C_i = P_i xor E(C_{i-1}), C_0 = IV
    out = bytearray(); prev = iv
    for i in range(0, len(data), 16):
        ks = R.aes_encrypt_block(prev, key)
        c = bytes(a ^ b for a, b in zip(data[i:i + 16], ks)); out += c
        if len(c) == 16: prev = c
    return bytes(out)

def write_psarc(path, files):
    """files: list of (name, bytes). Writes a Rocksmith 2014 PSARC (encrypted TOC)."""
    names = [n for n, _ in files]
    entries = [("", "\n".join(names).encode())] + files
    zlens, blobs, toc_entries, z = [], [], [], 0
    for name, data in entries:
        blocks = [data[i:i + BLOCK] for i in range(0, len(data), BLOCK)] or [b""]
        start_z, length = z, len(data)
        chunk = bytearray()
        for blk in blocks:
            c = zlib.compress(blk, 6)
            if len(c) < len(blk) and len(c) < BLOCK: zlens.append(len(c)); chunk += c
            elif len(blk) == BLOCK: zlens.append(0); chunk += blk                  # full raw block
            else: zlens.append(len(c)); chunk += c                                 # partial block: keep zlib (unambiguous)
            z += 1
        md5 = bytes(16) if name == "" else hashlib.md5(name.encode()).digest()
        toc_entries.append((md5, start_z, length, bytes(chunk)))
    n = len(entries)
    toc_len = 32 + 30 * n + 2 * len(zlens)
    offset = toc_len; toc = bytearray()
    for md5, zi, length, chunk in toc_entries:
        toc += md5 + struct.pack(">I", zi) + length.to_bytes(5, "big") + offset.to_bytes(5, "big")
        offset += len(chunk)
    for zl in zlens: toc += struct.pack(">H", zl)
    toc = aes_cfb128_encrypt(bytes(toc), R.KEYS["toc_key"], R.KEYS["toc_iv"])
    hdr = b"PSAR" + struct.pack(">HH", 1, 4) + b"zlib" + struct.pack(">IIIII", toc_len, 30, n, BLOCK, 4)
    with open(path, "wb") as f:
        f.write(hdr); f.write(toc)
        for *_, chunk in toc_entries: f.write(chunk)

ADJ = "Electric Silver Velvet Midnight Broken Golden Wild Crimson Hollow Neon Lonely Burning Frozen Rolling Purple Savage Quiet Iron Paper Lucky".split()
NOUN = "Horses Rivers Machines Hearts Wolves Engines Shadows Lanterns Saints Ghosts Tigers Satellites Bandits Diamonds Echoes Strangers Arrows Kings Sparrows Giants".split()
WORD = "Night Road Fire Rain Heart Highway Dream Light Train Stone City Blues River Moon Summer Thunder Desert Mirror Radio Ocean".split()

def load_sources(song_dir):
    out = []
    for f in sorted(os.listdir(song_dir)):
        if not f.lower().endswith(".psarc"): continue
        a = R.Psarc(os.path.join(song_dir, f))
        files = [(e["name"], a.read_entry(e)) for e in a.entries]
        has_lyrics = any(n.endswith("vocals.xml") or n.endswith("vocals.sng") for n, _ in files)
        size = os.path.getsize(os.path.join(song_dir, f))
        out.append(dict(name=f, files=files, has_lyrics=has_lyrics, size=size))
    return out

def retitle(files, artist, title, album, year, drop_vocals):
    out = []
    for name, data in files:
        if drop_vocals and ("vocals" in name.rsplit("/", 1)[-1]): continue
        if name.startswith("manifests/") and name.endswith(".json"):
            j = json.loads(data)
            for e in j.get("Entries", {}).values():
                a = e.get("Attributes", {})
                if "SongName" in a:
                    a.update(SongName=title, ArtistName=artist, AlbumName=album, SongYear=year,
                             ArtistNameSort=artist, SongNameSort=title)
            data = json.dumps(j, indent=2).encode()
        out.append((name, data))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("--n", type=int, default=827); ap.add_argument("--avg-mb", type=float, default=7.5)
    ap.add_argument("--songs", default=os.path.join(os.path.dirname(__file__), "..", "..", "songs"))
    ap.add_argument("--nested", action="store_true", help="spread the files over artist sub-folders")
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    src = load_sources(a.songs)
    small = [s for s in src if s["size"] < 10e6]; large = [s for s in src if s["size"] >= 10e6]
    ms, ml = sum(s["size"] for s in small) / len(small), sum(s["size"] for s in large) / len(large)
    p_small = min(1, max(0, (ml - a.avg_mb * 1e6) / (ml - ms)))
    os.makedirs(a.out, exist_ok=True)
    total = 0; stats = dict(lyrics=0, none=0)
    for i in range(a.n):
        s = rnd.choice(small if rnd.random() < p_small else large)
        artist = f"The {rnd.choice(ADJ)} {rnd.choice(NOUN)}" if rnd.random() < 0.6 else f"{rnd.choice(ADJ)} {rnd.choice(NOUN)}"
        title = f"{rnd.choice(WORD)} {rnd.choice(['of', 'in the', 'on the', 'and'])} {rnd.choice(WORD)}" if rnd.random() < 0.5 else f"{rnd.choice(ADJ)} {rnd.choice(WORD)}"
        drop = s["has_lyrics"] and rnd.random() < 0.25
        files = retitle(s["files"], artist, title, f"{rnd.choice(ADJ)} {rnd.choice(NOUN)}", 1960 + rnd.randrange(60), drop)
        stats["lyrics" if s["has_lyrics"] and not drop else "none"] += 1
        slug = lambda x: "".join(c if c.isalnum() else "-" for c in x).strip("-")
        fname = f"{slug(artist)}_{slug(title)}_{i:04d}_v1_m.psarc"
        d = os.path.join(a.out, slug(artist)) if a.nested else a.out
        os.makedirs(d, exist_ok=True)
        write_psarc(os.path.join(d, fname), files)
        total += os.path.getsize(os.path.join(d, fname))
        if (i + 1) % 100 == 0: print(f"{i + 1} files, {total / 1e9:.2f} GB", flush=True)
    print(f"done: {a.n} files, {total / 1e9:.2f} GB, {stats['lyrics']} with lyrics, {stats['none']} without")

if __name__ == "__main__":
    main()
