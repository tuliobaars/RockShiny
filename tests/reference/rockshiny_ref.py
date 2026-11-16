"""
Reference mirror of the R pipeline (R/psarc.R, R/sng.R, R/arrangement_xml.R,
R/chart.R) used to (1) cross-validate the algorithms on real files and
(2) generate chart fixtures for the frontend tests (tests/frontend).

Each function names the R function it mirrors; keep them in lock-step.
Requires: python3 + `cryptography` (no R needed).
"""
import bisect, hashlib, json, struct, sys, zlib
import xml.etree.ElementTree as ET
try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
except ImportError:                          # no `cryptography`: the pure-Python AES below
    Cipher = None

KEYS = dict(
    toc_key=bytes.fromhex("C53DB23870A1A2F71CAE64061FDD0E1157309DC85204D4C5BFDF25090DF2572C"),
    toc_iv=bytes.fromhex("E915AA018FEF71FC508132E4BB4CEB42"),
    sng_mac=bytes.fromhex("9821330E34B91F70D0A48CBD625993126970CEA09192C0E6CDA676CC9838289D"),
    sng_pc=bytes.fromhex("CB648DF3D12A16BF71701414E69619EC171CCA5D2A142E3E59DE7ADDA18A3A30"),
)
TECH = dict(hammer_on=1, pull_off=2, palm_mute=4, fret_hand_mute=8, harmonic=16, pinch_harmonic=32,
            vibrato=64, tremolo=128, accent=256, link_next=512, tap=1024, bend=2048, slide=4096,
            slide_unpitched=8192, chord=16384, ignore=32768)

# ---------------------------------------------------------------- crypto.R
# Pure-Python AES-256 (forward cipher only: CFB and CTR decryption need no more);
# used when the `cryptography` package is not installed. Checked against NIST SP 800-38A.
_SBOX = bytes.fromhex(
    "637c777bf26b6fc53001672bfed7ab76ca82c97dfa5947f0add4a2af9ca472c0b7fd9326363ff7cc34a5e5f171d8311504c723c31896059a071280e2eb27b275"
    "09832c1a1b6e5aa0523bd6b329e32f8453d100ed20fcb15b6acbbe394a4c58cfd0efaafb434d338545f9027f503c9fa851a3408f929d38f5bcb6da2110fff3d2"
    "cd0c13ec5f974417c4a77e3d645d197360814fdc222a908846eeb814de5e0bdbe0323a0a4906245cc2d3ac629195e479e7c8376d8dd54ea96c56f4ea657aae08"
    "ba78252e1ca6b4c6e8dd741f4bbd8b8a703eb5664803f60e613557b986c11d9ee1f8981169d98e949b1e87e9ce5528df8ca1890dbfe6426841992d0fb054bb16")
_XT = bytes(((b << 1) ^ (0x1b if b & 0x80 else 0)) & 0xff for b in range(256))
_RK = {}
def _expand(key):
    if key in _RK: return _RK[key]
    w = [list(key[4 * i:4 * i + 4]) for i in range(8)]
    rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40]
    for i in range(8, 60):
        t = list(w[i - 1])
        if i % 8 == 0: t = [_SBOX[t[1]] ^ rcon[i // 8 - 1], _SBOX[t[2]], _SBOX[t[3]], _SBOX[t[0]]]
        elif i % 8 == 4: t = [_SBOX[b] for b in t]
        w.append([a ^ b for a, b in zip(w[i - 8], t)])
    _RK[key] = [sum(w[4 * r:4 * r + 4], []) for r in range(15)]
    return _RK[key]
_SHIFT = [0, 5, 10, 15, 4, 9, 14, 3, 8, 13, 2, 7, 12, 1, 6, 11]
def _aes_py(block, key):
    rk = _expand(key); s = [a ^ b for a, b in zip(block, rk[0])]
    for r in range(1, 15):
        s = [_SBOX[s[i]] for i in _SHIFT]
        if r < 14:
            m = []
            for c in range(4):
                a0, a1, a2, a3 = s[4 * c:4 * c + 4]
                m += [_XT[a0] ^ _XT[a1] ^ a1 ^ a2 ^ a3, a0 ^ _XT[a1] ^ _XT[a2] ^ a2 ^ a3,
                      a0 ^ a1 ^ _XT[a2] ^ _XT[a3] ^ a3, _XT[a0] ^ a0 ^ a1 ^ a2 ^ _XT[a3]]
            s = m
        s = [a ^ b for a, b in zip(s, rk[r])]
    return bytes(s)
def aes_ctr_decrypt(data, key, iv):          # 128-bit big-endian counter (OpenSSL semantics)
    if Cipher is not None:
        d = Cipher(algorithms.AES(key), modes.CTR(iv)).decryptor(); return d.update(data) + d.finalize()
    out = bytearray(); ctr = int.from_bytes(iv, "big")
    for i in range(0, len(data), 16):
        ks = _aes_py(ctr.to_bytes(16, "big"), key); ctr = (ctr + 1) % (1 << 128)
        out += bytes(a ^ b for a, b in zip(data[i:i + 16], ks))
    return bytes(out)

def aes_encrypt_block(block, key):          # mirrors aes_encrypt_block(): first CTR keystream block == ECB
    if Cipher is None: return _aes_py(block, key)
    e = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).encryptor()
    return (e.update(block) + e.finalize())[:16]

def aes_cfb128_decrypt(data, key, iv):      # mirrors aes_cfb128_decrypt()
    out = bytearray(); prev = iv
    for start in range(0, len(data), 16):
        chunk = data[start:start + 16]
        ks = aes_encrypt_block(prev, key)
        out += bytes(a ^ b for a, b in zip(chunk, ks))
        if len(chunk) == 16: prev = chunk
    return bytes(out)

# ---------------------------------------------------------------- psarc.R
def be_uint(b): return int.from_bytes(b, "big")

class Psarc:                                # mirrors psarc_open()
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            hdr = f.read(32)
            assert hdr[:4] == b"PSAR"
            self.toc_length, esz, n, self.block_size, flags = (be_uint(hdr[i:i + 4]) for i in (12, 16, 20, 24, 28))
            toc = f.read(self.toc_length - 32)
        if (flags // 4) % 2 == 1:
            toc = aes_cfb128_decrypt(toc, KEYS["toc_key"], KEYS["toc_iv"])
        self.entries = []
        for i in range(n):
            e = toc[i * esz:(i + 1) * esz]
            self.entries.append(dict(md5=e[:16].hex(), zindex=be_uint(e[16:20]), length=be_uint(e[20:25]), offset=be_uint(e[25:30])))
        zwidth = 2 if self.block_size <= 65536 else 3 if self.block_size <= 16777216 else 4
        zraw = toc[n * esz:]
        self.zlengths = [be_uint(zraw[i:i + zwidth]) for i in range(0, len(zraw) // zwidth * zwidth, zwidth)]
        names = self.read_entry(self.entries[0]).decode().replace("\r", "").split("\n")
        names = (names + [None] * n)[:n - 1]
        for e, nm in zip(self.entries[1:], names): e["name"] = nm
        self.entries = self.entries[1:]
        self.by_name = {e["name"]: e for e in self.entries}

    def read_entry(self, e):                # mirrors psarc_read()
        out = bytearray(); remaining = e["length"]; z = e["zindex"]
        with open(self.path, "rb") as f:
            f.seek(e["offset"])
            while remaining > 0:
                zlen = self.zlengths[z]; z += 1
                block = f.read(self.block_size) if zlen == 0 else inflate_or_raw(f.read(zlen))
                block = block[:remaining]; remaining -= len(block); out += block
                assert len(block) > 0
        return bytes(out)

    def read(self, name): return self.read_entry(self.by_name[name])
    def find(self, pattern):
        import re
        return [e["name"] for e in self.entries if re.search(pattern, e["name"])]

def inflate_or_raw(packed):                 # mirrors inflate_or_raw()
    if len(packed) >= 2 and packed[0] == 0x78 and ((0x78 * 256 + packed[1]) % 31) == 0:
        try: return zlib.decompress(packed)
        except zlib.error: pass
    return packed

# ---------------------------------------------------------------- sng.R
def sng_decrypt(data, platform="auto"):
    assert struct.unpack_from("<I", data, 0)[0] == 0x4A
    iv, payload = data[8:24], data[24:]
    keys = {"mac": ["sng_mac"], "pc": ["sng_pc"], "auto": ["sng_pc", "sng_mac"]}[platform]
    for k in keys:
        plain = aes_ctr_decrypt(payload, KEYS[k], iv)
        if len(plain) > 6 and plain[4] == 0x78:
            try: return zlib.decompressobj().decompress(plain[4:])
            except zlib.error: pass
    raise ValueError("could not decrypt SNG")

SNG_MASK = dict(chord=0x02, fret_hand_mute=0x08, tremolo=0x10, harmonic=0x20, palm_mute=0x40, hammer_on=0x200,
                pull_off=0x400, slide=0x800, bend=0x1000, tap=0x4000, pinch_harmonic=0x8000, vibrato=0x10000,
                mute=0x20000, ignore=0x40000, slide_unpitched=0x400000, accent=0x4000000, link_next=0x8000000)
MASK_MAP = dict(hammer_on="hammer_on", pull_off="pull_off", palm_mute="palm_mute", fret_hand_mute="fret_hand_mute",
                mute="fret_hand_mute", harmonic="harmonic", pinch_harmonic="pinch_harmonic", vibrato="vibrato",
                tremolo="tremolo", accent="accent", link_next="link_next", tap="tap", bend="bend", slide="slide",
                slide_unpitched="slide_unpitched", ignore="ignore")

def has_bit(mask, bit): return (mask // bit) % 2 == 1

def sng_mask_to_tech(mask, is_chord_note):
    tech = 0
    for src, dst in MASK_MAP.items():
        if has_bit(mask, SNG_MASK[src]) and not (tech & TECH[dst]): tech += TECH[dst]
    return tech + (TECH["chord"] if is_chord_note else 0)

def cstr(b): return b.split(b"\0")[0].decode("utf-8", "replace")

def parse_arrangement_sng(buf):             # mirrors parse_arrangement_sng()
    pos = 0
    def u32(o): return struct.unpack_from("<I", buf, o)[0]
    def count():
        nonlocal pos; n = u32(pos); pos += 4; return n
    def fixed_array(size):
        nonlocal pos; n = count(); offs = [pos + size * k for k in range(n)]; pos += size * n; return offs
    beats = fixed_array(16); phr = fixed_array(44); tmpl = fixed_array(72); cnotes = fixed_array(2376)
    if fixed_array(60): fixed_array(32); fixed_array(144); fixed_array(44)
    pis = fixed_array(24); fixed_array(16)
    for _ in range(count()): pos += 4; fixed_array(4)
    fixed_array(260); fixed_array(260); fixed_array(8); fixed_array(8)
    secs = fixed_array(88)
    notes, anchors, bends = [], [], []
    for _ in range(count()):
        diff = struct.unpack_from("<i", buf, pos)[0]; pos += 4
        anc = fixed_array(28); fixed_array(12); fixed_array(20); fixed_array(20)
        offs = []; bn = []
        for _ in range(count()):
            offs.append(pos); pos += 63; bn.append(u32(pos)); pos += 4 + 12 * bn[-1]
        fixed_array(4); fixed_array(4); fixed_array(4)
        for o in anc:
            anchors.append(dict(level=diff, time=struct.unpack_from("<f", buf, o)[0], fret=buf[o + 16], width=struct.unpack_from("<i", buf, o + 20)[0]))
        for o, nb in zip(offs, bn):
            key = "s%d" % o if nb else None
            for j in range(nb):
                bo = o + 67 + 12 * j
                bends.append(dict(key=key, time=struct.unpack_from("<f", buf, bo)[0], step=struct.unpack_from("<f", buf, bo + 4)[0]))
            notes.append(dict(level=diff, bend_key=key, mask=u32(o), time=struct.unpack_from("<f", buf, o + 12)[0], string=buf[o + 16], fret=buf[o + 17],
                              chord_id=struct.unpack_from("<i", buf, o + 20)[0], chord_notes=struct.unpack_from("<i", buf, o + 24)[0],
                              slide_to=struct.unpack_from("<b", buf, o + 46)[0], slide_unp=struct.unpack_from("<b", buf, o + 47)[0],
                              sustain=struct.unpack_from("<f", buf, o + 55)[0], bend=struct.unpack_from("<f", buf, o + 59)[0]))
    pos += 40
    capo = struct.unpack_from("<b", buf, pos)[0]; pos += 1 + 32 + 2
    song_length = struct.unpack_from("<f", buf, pos)[0]; pos += 4
    nt = count(); tuning = list(struct.unpack_from("<%dh" % nt, buf, pos))
    tmpl_frets = [list(struct.unpack_from("<6b", buf, o + 4)) for o in tmpl]
    templates = dict(name=[cstr(buf[o + 40:o + 72]) for o in tmpl], frets=tmpl_frets)

    # sng_expand_chords()
    singles = [n for n in notes if n["chord_id"] < 0]
    chs = [n for n in notes if n["chord_id"] >= 0]
    chords = [dict(level=c["level"], time=c["time"], template=c["chord_id"], high_density=has_bit(c["mask"], 0x200000), key=k + 1) for k, c in enumerate(chs)]
    out_notes = []
    for n in singles:
        out_notes.append(dict(level=n["level"], time=n["time"], string=n["string"], fret=n["fret"], sustain=n["sustain"],
                              slide_to=n["slide_to"], slide_unp=n["slide_unp"], bend=n["bend"], chord_key=None,
                              bend_key=n["bend_key"], tech=sng_mask_to_tech(n["mask"], False)))
    for k, c in enumerate(chs):
        frets = tmpl_frets[c["chord_id"]] if c["chord_id"] < len(tmpl_frets) else [-1] * 6
        for s in range(6):
            fr = frets[s]
            if fr < 0: continue
            mask, slide, sunp = c["mask"], -1, -1
            bkey, bmax = None, 0.0
            if c["chord_notes"] >= 0:
                o = cnotes[c["chord_notes"]]
                bd = o + 24 + 388 * s
                used = max(0, min(32, struct.unpack_from("<i", buf, bd + 384)[0]))
                if used:
                    bkey = "c%d:%d" % (chords[k]["key"], s)
                    for j in range(used):
                        st = struct.unpack_from("<f", buf, bd + 12 * j + 4)[0]; bmax = max(bmax, st)
                        bends.append(dict(key=bkey, time=struct.unpack_from("<f", buf, bd + 12 * j)[0], step=st))
                mask = u32(o + 4 * s)
                slide = struct.unpack_from("<b", buf, o + 2352 + s)[0]; sunp = struct.unpack_from("<b", buf, o + 2358 + s)[0]
            for b in ("palm_mute", "fret_hand_mute", "mute", "accent"):
                if has_bit(c["mask"], SNG_MASK[b]) and not has_bit(mask, SNG_MASK[b]): mask += SNG_MASK[b]
            out_notes.append(dict(level=c["level"], time=c["time"], string=s, fret=fr, sustain=c["sustain"], slide_to=slide,
                                  slide_unp=sunp, bend=bmax, chord_key=chords[k]["key"], bend_key=bkey, tech=sng_mask_to_tech(mask, True)))
    f32 = lambda o: struct.unpack_from("<f", buf, o)[0]
    return dict(
        meta=dict(song_length=song_length, capo=max(capo, 0), tuning=tuning, source="sng"),
        beats=[dict(time=f32(o), measure=(struct.unpack_from("<H", buf, o + 4)[0] if has_bit(u32(o + 12), 1) else -1)) for o in beats],
        sections=[dict(name=cstr(buf[o:o + 32]), time=f32(o + 36), number=struct.unpack_from("<i", buf, o + 32)[0]) for o in secs],
        phrases=[dict(max_difficulty=struct.unpack_from("<i", buf, o + 4)[0], name=cstr(buf[o + 12:o + 44])) for o in phr],
        phrase_iterations=[dict(time=f32(o + 4), phrase_id=struct.unpack_from("<i", buf, o)[0]) for o in pis],
        templates=templates, notes=out_notes, chords=chords, anchors=anchors, bends=bends)

# ---------------------------------------------------------------- arrangement_xml.R
def _num(e, a, d=None):
    v = e.get(a)
    try: return float(v)
    except (TypeError, ValueError): return d
def _int(e, a, d=None):
    v = e.get(a)
    try: return int(v)
    except (TypeError, ValueError):
        try: return int(float(v))
        except (TypeError, ValueError): return d
def _flag(e, a): return (_int(e, a, 0) or 0) > 0

def xml_note_tech(e):
    t = 0
    pairs = [(_flag(e, "hammerOn"), "hammer_on"), (_flag(e, "pullOff"), "pull_off"), (_flag(e, "palmMute"), "palm_mute"),
             (_flag(e, "mute"), "fret_hand_mute"), (_flag(e, "harmonic"), "harmonic"), (_flag(e, "harmonicPinch"), "pinch_harmonic"),
             (_flag(e, "vibrato"), "vibrato"), (_flag(e, "tremolo"), "tremolo"), (_flag(e, "accent"), "accent"),
             (_flag(e, "linkNext"), "link_next"), (_flag(e, "tap"), "tap"), (_num(e, "bend", 0) > 0, "bend"),
             (_int(e, "slideTo", -1) >= 0, "slide"), (_int(e, "slideUnpitchTo", -1) >= 0, "slide_unpitched"), (_flag(e, "ignore"), "ignore")]
    for on, b in pairs:
        if on: t += TECH[b]
    return t

def xml_note_row(e, level, bends=None):
    key = None
    bv = e.findall("bendValues/bendValue")
    if bv:
        key = "x%d" % id(e)
        if bends is not None:
            for b in bv: bends.append(dict(key=key, time=_num(b, "time"), step=_num(b, "step", 0.0)))
    return dict(level=level, bend_key=key, time=_num(e, "time"), string=_int(e, "string"), fret=_int(e, "fret", 0), sustain=_num(e, "sustain", 0.0),
                slide_to=_int(e, "slideTo", -1), slide_unp=_int(e, "slideUnpitchTo", -1), bend=_num(e, "bend", 0.0),
                tech=xml_note_tech(e), chord_key=None)

def parse_arrangement_xml(data):            # mirrors parse_arrangement_xml()
    song = ET.fromstring(data)
    assert song.tag == "song"
    txt = lambda p: (song.find(p).text if song.find(p) is not None else None)
    tun = song.find("tuning")
    props = song.find("arrangementProperties")
    arr = txt("arrangement") or ""
    meta = dict(title=txt("title"), artist=txt("artistName"), album=txt("albumName"), year=txt("albumYear"), arrangement=arr,
                song_length=float(txt("songLength")), tuning=[_int(tun, "string%d" % i, 0) for i in range(6)],
                is_bass=("bass" in arr.lower()) or (props is not None and _flag(props, "pathBass")), source="xml")
    tmpl = song.findall("chordTemplates/chordTemplate")
    names = []
    for t in tmpl:
        nm = t.get("chordName")
        if nm is None or nm == "": nm = t.get("displayName")
        names.append(nm)
    templates = dict(name=names, frets=[[_int(t, "fret%d" % i, -1) for i in range(6)] for t in tmpl])
    notes, chords, anchors, bends = [], [], [], []
    key_base = 0
    for lv in song.findall("levels/level"):
        d = _int(lv, "difficulty", 0)
        notes += [xml_note_row(n, d, bends) for n in lv.findall("notes/note")]
        ch = lv.findall("chords/chord")
        for k, c in enumerate(ch):
            key = key_base + k + 1
            chords.append(dict(level=d, time=_num(c, "time"), template=_int(c, "chordId", 0), high_density=_flag(c, "highDensity"), key=key))
            ctech = (TECH["palm_mute"] if _flag(c, "palmMute") else 0) + (TECH["fret_hand_mute"] if _flag(c, "fretHandMute") else 0) + (TECH["accent"] if _flag(c, "accent") else 0)
            # template decides strings/frets; chordNotes override per-string details
            kids = [xml_note_row(cn, d, bends) for cn in c.findall("chordNote")]
            by_string = {}
            for r in kids: by_string.setdefault(r["string"], r)
            csus = max([r["sustain"] for r in kids], default=0.0)
            tid = _int(c, "chordId", 0)
            frets = templates["frets"][tid] if 0 <= tid < len(templates["frets"]) else [-1] * 6
            used = set()
            for s in range(6):
                fr = frets[s]
                if fr is None or fr < 0: continue
                row = dict(level=d, time=_num(c, "time"), string=s, fret=fr, sustain=csus, slide_to=-1, slide_unp=-1,
                           bend=0.0, tech=ctech, chord_key=key, bend_key=None)
                if s in by_string:
                    r = by_string[s]; used.add(id(r))
                    row.update(sustain=r["sustain"], slide_to=r["slide_to"], slide_unp=r["slide_unp"], bend=r["bend"], tech=ctech | r["tech"], bend_key=r["bend_key"])
                row["tech"] += TECH["chord"]; notes.append(row)
            for r in kids:
                if id(r) in used: continue
                r["time"] = _num(c, "time"); r["chord_key"] = key; r["tech"] = (r["tech"] | ctech) + TECH["chord"]; notes.append(r)
        key_base += len(ch)
        anchors += [dict(level=d, time=_num(a, "time"), fret=_int(a, "fret", 1), width=_num(a, "width", 4.0)) for a in lv.findall("anchors/anchor")]
    return dict(
        meta=meta,
        beats=[dict(time=_num(b, "time"), measure=_int(b, "measure", -1)) for b in song.findall("ebeats/ebeat")],
        sections=[dict(name=s.get("name"), time=_num(s, "startTime"), number=_int(s, "number", 1)) for s in song.findall("sections/section")],
        phrases=[dict(max_difficulty=_int(p, "maxDifficulty", 0), name=p.get("name")) for p in song.findall("phrases/phrase")],
        phrase_iterations=[dict(time=_num(p, "time"), phrase_id=_int(p, "phraseId", 0)) for p in song.findall("phraseIterations/phraseIteration")],
        templates=templates, notes=notes, chords=chords, anchors=anchors, bends=bends)

# ---------------------------------------------------------------- chart.R
def find_interval(x, v): return bisect.bisect_right(v, x)    # == R findInterval()
def r_round(x):                                                # R round(): IEC 60559, half to even
    return int(round(x))

def build_chart(raw, difficulty=1.0):        # mirrors build_chart()
    pit = sorted(raw["phrase_iterations"], key=lambda p: p["time"])
    avail = sorted(set([n["level"] for n in raw["notes"]] + [c["level"] for c in raw["chords"]] + [a["level"] for a in raw["anchors"]]))
    def lv_for(target):
        ok = [a for a in avail if a <= target]
        return max(ok) if ok else min(avail)
    pi_time = [p["time"] for p in pit]
    if avail:
        pi_level = []
        for p in pit:
            pid = p["phrase_id"]
            target = raw["phrases"][pid]["max_difficulty"] if 0 <= pid < len(raw["phrases"]) else max(avail)
            pi_level.append(lv_for(r_round(target * max(0.0, min(1.0, difficulty)))))
    else:
        pi_level = [0] * len(pit)
    def keep(rows):
        if not rows: return []
        if not pi_time:
            m = max(r["level"] for r in rows); return [r for r in rows if r["level"] == m]
        return [r for r in rows if r["level"] == pi_level[max(find_interval(r["time"], pi_time), 1) - 1]]
    notes, chords, anchors = keep(raw["notes"]), keep(raw["chords"]), keep(raw["anchors"])
    notes = [n for n in notes if n["string"] is not None and 0 <= n["string"] <= 5]
    chords = sorted(chords, key=lambda c: c["time"])
    pos = {c["key"]: i for i, c in enumerate(chords)}
    for n in notes: n["chord"] = pos.get(n["chord_key"], -1) if n["chord_key"] is not None else -1
    notes = sorted(notes, key=lambda n: (n["time"], n["string"]))
    anchors = sorted(anchors, key=lambda a: a["time"])
    seen = {}
    for i, a in enumerate(anchors): seen[a["time"]] = i
    anchors = [a for i, a in enumerate(anchors) if seen[a["time"]] == i]
    owner = {n["bend_key"]: i for i, n in enumerate(notes) if n.get("bend_key")}
    bends = sorted([dict(note=owner[b["key"]], time=b["time"], step=b["step"]) for b in raw.get("bends", []) if b["key"] in owner],
                   key=lambda b: (b["note"], b["time"]))
    mx = {}
    for b in bends: mx[b["note"]] = max(mx.get(b["note"], -1e9), b["step"])
    for i, v in mx.items(): notes[i]["bend"] = v
    for c in chords:
        t = c["template"]; nm = raw["templates"]["name"][t] if 0 <= t < len(raw["templates"]["name"]) else None
        c["name"] = nm or ""
    meta = dict(raw["meta"])
    ns = 4 if meta.get("is_bass") else 6
    if notes: ns = max(ns, max(n["string"] for n in notes) + 1)
    meta.update(n_strings=ns, n_notes=len(notes), max_fret=max([n["fret"] for n in notes] + [n["slide_to"] for n in notes] + [12]),
                max_difficulty=max([p["max_difficulty"] for p in raw["phrases"]] + [0]), difficulty=difficulty,
                tuning_name=tuning_name(meta.get("tuning", [0] * 6), ns))
    return dict(meta=meta, notes=notes, chords=chords, anchors=anchors, bends=bends,
                beats=sorted(raw["beats"], key=lambda b: b["time"]),
                sections=section_labels(sorted(raw["sections"], key=lambda s: s["time"])))

SECTION_NAMES = dict(noguitar="No guitar", prechorus="Pre-chorus", postchorus="Post-chorus", modchorus="Mod. chorus",
                     modverse="Mod. verse", prevs="Pre-verse", postvs="Post-verse", fadein="Fade in", fadeout="Fade out",
                     buildup="Build-up", breakdown="Breakdown", interlude="Interlude")
def section_labels(secs):                    # mirrors section_labels()
    keys = [s["name"].lower() for s in secs]
    seen = {}
    for s, k in zip(secs, keys):
        seen[k] = seen.get(k, 0) + 1                  # R: ave(seq_along(key), key, FUN = seq_along) when no number
        pretty = SECTION_NAMES.get(k, k[:1].upper() + k[1:])
        s["label"] = f"{pretty} {s.get('number', seen[k])}" if keys.count(k) > 1 else pretty
    return secs

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
def tuning_name(tuning, n_strings=6):        # mirrors tuning_name()
    base = [28, 33, 38, 43] if n_strings == 4 else [40, 45, 50, 55, 59, 64]
    t = [int(x or 0) for x in list(tuning)[:len(base)]]
    t += [0] * (len(base) - len(t))
    open_ = [NOTE_NAMES[(b + x) % 12] for b, x in zip(base, t)]
    if all(x == t[0] for x in t): return f"{open_[0]} Standard"
    if all(x == t[1] for x in t[1:]) and t[0] == t[1] - 2: return f"Drop {open_[0]}"
    return " ".join(open_)

def vocals_lines(v):                         # mirrors vocals_lines(); v = [(time, length, lyric)]
    v = sorted(v); n = len(v)
    raw = [l or "" for _, _, l in v]
    ends = [l.endswith("+") for l in raw]
    text = [l[:-1] if l.endswith("+") else l for l in raw]
    join = [t.endswith("-") for t in text]
    text = [t[:-1] if t.endswith("-") else t for t in text]
    if n:
        gap = [v[i + 1][0] - (v[i][0] + v[i][1]) for i in range(n - 1)] + [float("inf")]
        seg, cur = [], 0
        for i in range(n):
            seg.append(cur)
            if ends[i]: cur += 1
        cnt = {}
        for i in range(n):
            if not join[i]: cnt[seg[i]] = cnt.get(seg[i], 0) + 1
        redo = [(not any(ends)) or cnt.get(seg[i], 0) > 14 for i in range(n)]
        words = 0
        for i in range(n):
            if not redo[i]: words = 0; continue
            if not join[i]: words += 1
            if gap[i] > 1.2 or (words >= 8 and not join[i]): ends[i] = True; words = 0
    line, cur = [], 0
    for i in range(n):
        line.append(cur)
        if ends[i]: cur += 1
    return dict(t=[round(x[0], 3) for x in v], d=[round(x[1], 3) for x in v], w=text, j=[int(b) for b in join], l=line)

def song_vocals(arc):                        # mirrors song_vocals() (XML path)
    xs = sorted(arc.find(r"^songs/arr/.*vocals\.xml$"), key=lambda f: "jvocals" in f)
    if not xs: return None
    v = [(float(e.get("time")), float(e.get("length") or 0), e.get("lyric")) for e in ET.fromstring(arc.read(xs[0])).findall("vocal")]
    return vocals_lines(v) if v else None

def song_album_art(arc):                     # mirrors song_album_art()
    import base64
    dds = arc.find(r"album_art/.*\.dds$")
    if not dds: return None
    best = [d for d in dds if d.endswith("_256.dds")] or [max(dds, key=lambda d: arc.by_name[d]["length"])]
    return base64.b64encode(arc.read(best[0])).decode()

def chart_json(chart, song_key=None, vocals=None, art=None):   # mirrors chart_json()
    r3 = lambda v: round(v, 3)
    n = chart["notes"]
    out = dict(format="rockshiny-chart/1", songKey=song_key, meta=chart["meta"],
                notes=dict(t=[r3(x["time"]) for x in n], s=[x["string"] for x in n], f=[x["fret"] for x in n],
                           sus=[r3(x["sustain"]) for x in n], tech=[x["tech"] for x in n], slide=[x["slide_to"] for x in n],
                           slideU=[x["slide_unp"] for x in n], bend=[round(x["bend"], 2) for x in n], chord=[x["chord"] for x in n]),
                bends=dict(n=[b["note"] for b in chart["bends"]], t=[r3(b["time"]) for b in chart["bends"]],
                           s=[round(b["step"], 2) for b in chart["bends"]]),
                chords=dict(t=[r3(c["time"]) for c in chart["chords"]], name=[c["name"] for c in chart["chords"]],
                            hd=[int(c["high_density"]) for c in chart["chords"]]),
                anchors=dict(t=[r3(a["time"]) for a in chart["anchors"]], fret=[a["fret"] for a in chart["anchors"]],
                             width=[a["width"] for a in chart["anchors"]]),
                beats=dict(t=[r3(b["time"]) for b in chart["beats"]], m=[b["measure"] for b in chart["beats"]]),
                sections=dict(t=[r3(s["time"]) for s in chart["sections"]], name=[s["name"] for s in chart["sections"]],
                              label=[s["label"] for s in chart["sections"]]))
    if vocals: out["vocals"] = vocals
    if art: out["art"] = art
    return out

# ---------------------------------------------------------------- audio.R
def bank_media_ids(data):                    # mirrors bank_media_ids(): the DIDX section's wem ids
    out, o = [], 0
    while o + 8 <= len(data):
        tag, n = data[o:o + 4].replace(b"\0", b""), struct.unpack("<I", data[o + 4:o + 8])[0]
        if tag == b"DIDX":
            out += [struct.unpack("<I", data[o + 8 + k:o + 12 + k])[0] for k in range(0, n - 11, 12) if o + 12 + k <= len(data)]
        o += 8 + n
    return out

def find_song_wem(arc):                      # mirrors find_song_wem()
    wems = arc.find(r"\.wem$")
    ids = [int(w.split("/")[-1][:-4]) if w.split("/")[-1][:-4].isdigit() else None for w in wems]
    size = {w: arc.by_name[w]["length"] for w in wems}
    banks = arc.find(r"\.bnk$")
    def refs(names):
        hit = [False] * len(wems)
        for b in names:
            data = arc.read(b)
            didx = set(bank_media_ids(data))
            h = [i is not None and i in didx for i in ids]
            if not any(h):
                h = [i is not None and struct.pack("<I", i) in data for i in ids]
            hit = [x or y for x, y in zip(hit, h)]
        return hit
    song_banks = [b for b in banks if not b.endswith("_preview.bnk")]
    prev_banks = [b for b in banks if b.endswith("_preview.bnk")]
    cand = refs(song_banks)
    if not any(cand): cand = [True] * len(wems)
    if sum(cand) > 1 and prev_banks:
        keep = [c and not p for c, p in zip(cand, refs(prev_banks))]
        if any(keep): cand = keep
    return max((w for w, c in zip(wems, cand) if c), key=lambda w: size[w])

if __name__ == "__main__":
    arc = Psarc(sys.argv[1])
    for e in arc.entries: print(e["length"], e["name"])
