"""Python mirror of R/instruments.R and R/midi.R (the R code cannot run in the
authoring environment; this mirror is validated here and produces the lane
chart fixtures for the frontend tests). Also a small Standard MIDI File writer
for test files. Keep in step with the R code."""
import bisect, math, struct
import rockshiny_ref as R

INSTRUMENT_LABELS = dict(guitar="Guitar / bass", piano="Piano", harmonica="Harmonica")
OPEN6 = [40, 45, 50, 55, 59, 64]; OPEN4 = [28, 33, 38, 43]
HARM_FRETS = [12, 7, 19, 5, 24, 4, 9, 16, 3]; HARM_SEMIS = [12, 19, 19, 24, 24, 28, 28, 28, 31]
NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
def midi_name(m): return f"{NOTE_NAMES[m % 12]}{m // 12 - 1}"

def chart_note_midi(chart):                              # mirrors chart_note_midi()
    m = chart["meta"]
    open_ = OPEN4 if m.get("n_strings") == 4 else OPEN6
    tun = (list(m.get("tuning") or []) + [0] * 6)[:6]
    tun = [0 if t is None else int(t) for t in tun]
    capo = int(m.get("capo") or 0)
    out = []
    for n in chart["notes"]:
        s, f = n["string"], n["fret"]
        base = open_[s] + tun[s]
        semis = base + (capo if f == 0 else f)
        if R.has_bit(n["tech"], R.TECH["harmonic"]) and f in HARM_FRETS: semis = base + HARM_SEMIS[HARM_FRETS.index(f)]
        out.append(semis)
    return out

def dedupe_events(ev):                                   # mirrors dedupe_events()
    if not ev: return ev
    ev = sorted(ev, key=lambda e: (e["time"], e["midi"], -e["sustain"]))
    slot, out, seen = 0, [], set()
    for i, e in enumerate(ev):
        if i and e["time"] - ev[i - 1]["time"] > 0.002: slot += 1
        if (slot, e["midi"]) in seen: continue
        seen.add((slot, e["midi"])); out.append(e)
    return out

def chart_pitch_events(chart):                           # mirrors chart_pitch_events()
    N = chart["notes"]
    if not N: return []
    midi = chart_note_midi(chart)
    sus = [n["sustain"] for n in N]
    extra = []
    B = chart.get("bends") or []
    if B:
        pre_amt = [0.0] * len(N)
        seen = set()
        for b in B:
            i = b["note"]
            if i not in seen:
                seen.add(i)
                if b["time"] - N[i]["time"] < 0.01 and b["step"] > 0: pre_amt[i] = b["step"]
        midi = [m + R.r_round(p) for m, p in zip(midi, pre_amt)]
        order = []
        for b in B:
            if b["note"] not in order: order.append(b["note"])
        for i in order:
            pts = [b for b in B if b["note"] == i]
            mx = max(b["step"] for b in pts)
            if mx - pre_amt[i] < 0.9: continue
            tb = next(b["time"] for b in pts if b["step"] >= mx - 0.05)
            if tb - N[i]["time"] < 0.05: continue
            end = N[i]["time"] + N[i]["sustain"]
            extra.append(dict(time=tb, midi=midi[i] - R.r_round(pre_amt[i]) + R.r_round(mx), sustain=max(0, end - tb), chord=-1))
            sus[i] = max(0, tb - N[i]["time"] - 0.01)
    ev = [dict(time=n["time"], midi=midi[k], sustain=sus[k], chord=n["chord"]) for k, n in enumerate(N)
          if not R.has_bit(n["tech"], R.TECH["fret_hand_mute"])]
    return dedupe_events(ev + extra)

def vocal_pitch_events(v):                               # v = [(time, length, lyric, note)]
    return dedupe_events([dict(time=t, midi=int(n), sustain=max(0, l), chord=-1) for t, l, _, n in v if n is not None and 0 < n < 128])

def piano_range(midi):
    if not midi: return [48, 72]
    lo = 12 * (min(midi) // 12); hi = 12 * (max(midi) // 12 + 1)
    if hi - lo < 24: hi = lo + 24
    return [max(21, lo), min(108, hi)]

def events_to_piano(src, ev, octave=0, split=60):
    ev = [dict(e, midi=e["midi"] + 12 * octave) for e in ev]
    ev = [e for e in ev if 21 <= e["midi"] <= 108]
    for e in ev: e["hand"] = int(e["midi"] >= split)
    lo, hi = piano_range([e["midi"] for e in ev])
    return lane_chart(src, ev, "piano", dict(piano_octave=octave, range_lo=lo, range_hi=hi,
                                             instrument_tag=f"Keys {midi_name(lo)}\u2013{midi_name(hi)}"))

HARP_KEYS = dict(zip(["G", "Ab", "A", "Bb", "B", "C", "Db", "D", "Eb", "E", "F", "F#"], range(-5, 7)))

def harp_layout(key="C"):                                # mirrors harp_layout()
    off = HARP_KEYS[key]
    blow = [60, 64, 67, 72, 76, 79, 84, 88, 91, 96]; draw = [62, 67, 71, 74, 77, 81, 83, 86, 89, 93]
    rows = [dict(midi=blow[h], hole=h + 1, blow=1, bend=0, ob=0, cost=0.0) for h in range(10)]
    rows += [dict(midi=draw[h], hole=h + 1, blow=0, bend=0, ob=0, cost=0.0) for h in range(10)]
    for h in range(10):
        hi, lo = max(blow[h], draw[h]), min(blow[h], draw[h])
        for k in range(1, hi - lo):
            rows.append(dict(midi=hi - k, hole=h + 1, blow=int(blow[h] > draw[h]), bend=k, ob=0, cost=0.6 + 0.4 * k))
    for h in [1, 4, 5, 6]: rows.append(dict(midi=draw[h - 1] + 1, hole=h, blow=1, bend=0, ob=1, cost=3.0))
    for h in [7, 9, 10]: rows.append(dict(midi=blow[h - 1] + 1, hole=h, blow=0, bend=0, ob=1, cost=3.0))
    for r in rows: r["midi"] += off
    return sorted(rows, key=lambda r: (r["midi"], r["cost"], r["hole"]))

def melody_line(ev, min_gap=0.0):
    if not ev: return ev
    ev = sorted(ev, key=lambda e: (e["time"], -e["midi"]))
    out = []
    for i, e in enumerate(ev):
        if i and e["time"] - ev[i - 1]["time"] <= 0.002: continue
        out.append(dict(e))
    if min_gap > 0 and len(out) > 1:
        kept, last = [], -math.inf
        for e in out:
            if e["time"] - last >= min_gap: kept.append(e); last = e["time"]
        out = kept
    for i, e in enumerate(out):
        nxt = out[i + 1]["time"] if i + 1 < len(out) else math.inf
        e["sustain"] = max(0, min(e["sustain"], nxt - e["time"] - 0.02)); e["chord"] = -1
    return out

def harp_choose(midi, key="auto"):                       # mirrors harp_choose()
    keys = list(HARP_KEYS) if key == "auto" else [key]
    u = sorted(set(midi)); w = [midi.count(p) for p in u]
    best = None
    for k in keys:
        cheapest = {}
        for r in harp_layout(k): cheapest[r["midi"]] = min(cheapest.get(r["midi"], 99), r["cost"])
        for octv in range(-3, 4):
            cost = [cheapest.get(p + 12 * octv, 10.0) for p in u]
            total = sum(c * x for c, x in zip(cost, w)); bad = sum(x for c, x in zip(cost, w) if c >= 10)
            score = (total, bad, abs(octv), abs(HARP_KEYS[k]))
            if best is None or score < best["score"]:
                best = dict(key=k, octave=octv, cost=total, unplayable=bad, score=score)
    del best["score"]
    return best

def harp_assign(ev, lay):                                # mirrors harp_assign() (Viterbi)
    opts = [[j for j, r in enumerate(lay) if r["midi"] == e["midi"]] for e in ev]
    keep = [k for k, o in enumerate(opts) if o]
    ev = [dict(ev[k]) for k in keep]; opts = [opts[k] for k in keep]
    if not ev: return []
    cost = [[lay[j]["cost"] for j in opts[0]]]; back = [None]
    for i in range(1, len(ev)):
        prev, cur = opts[i - 1], opts[i]
        bk, cc = [], []
        for b, jc in enumerate(cur):
            trans = [cost[i - 1][a] + 0.15 * abs(lay[jp]["hole"] - lay[jc]["hole"]) for a, jp in enumerate(prev)]
            a = min(range(len(trans)), key=lambda x: (trans[x], x))
            bk.append(a); cc.append(trans[a] + lay[jc]["cost"])
        back.append(bk); cost.append(cc)
    pick = [0] * len(ev)
    pick[-1] = min(range(len(cost[-1])), key=lambda x: (cost[-1][x], x))
    for i in range(len(ev) - 2, -1, -1): pick[i] = back[i + 1][pick[i + 1]]
    for i, e in enumerate(ev):
        r = lay[opts[i][pick[i]]]
        e.update(hole=r["hole"], blow=r["blow"], bend=r["bend"], ob=r["ob"])
    return ev

HARP_MIN_GAP = 0.09
def events_to_harmonica(src, ev, key="auto"):
    full = melody_line(ev)
    mel = melody_line(ev, HARP_MIN_GAP)
    ch = harp_choose([e["midi"] for e in mel], key) if mel else dict(key="C" if key == "auto" else key, octave=0, unplayable=0)
    for e in mel: e["midi"] += 12 * ch["octave"]
    out = harp_assign(mel, harp_layout(ch["key"]))
    return lane_chart(src, out, "harmonica", dict(harp_key=ch["key"], harp_octave=ch["octave"], harp_dropped=len(mel) - len(out), harp_thinned=len(full) - len(mel),
                                                  harp_auto=key == "auto", instrument_tag=f"Key of {ch['key']}"))

def lane_chart(src, ev, instrument, extra):
    meta = {k: v for k, v in src["meta"].items() if k not in ("tuning", "capo", "cent_offset", "n_strings", "tuning_name", "max_fret", "is_bass")}
    meta["instrument"] = instrument
    meta["source_arrangement"] = meta.get("arrangement", "")
    lab, src_lab = INSTRUMENT_LABELS[instrument], meta.get("arrangement", "")
    meta["arrangement"] = src_lab if src_lab.startswith(lab) else f"{lab} \u00b7 {src_lab}"
    meta["n_notes"] = len(ev)
    if ev: meta["lowest_midi"] = min(e["midi"] for e in ev)
    meta.update(extra)
    ev = sorted(ev, key=lambda e: (e["time"], e["midi"]))
    return dict(instrument=instrument, meta=meta, notes=ev, chords=src.get("chords", []), beats=src["beats"], sections=src["sections"])

def chart_for_instrument(chart, instrument, ev=None, octave=0, harp_key="auto"):
    if instrument == "guitar": return chart
    if ev is None: ev = chart_pitch_events(chart)
    return events_to_piano(chart, ev, octave) if instrument == "piano" else events_to_harmonica(chart, ev, harp_key)

def lane_chart_json(chart, song_key=None, vocals=None, art=None):   # mirrors lane_chart_payload()
    r3 = lambda v: round(v, 3)
    n = chart["notes"]
    notes = dict(t=[r3(e["time"]) for e in n], sus=[r3(e["sustain"]) for e in n], midi=[e["midi"] for e in n],
                 chord=[e["chord"] for e in n])
    if chart["instrument"] == "piano": notes["hand"] = [e["hand"] for e in n]
    if chart["instrument"] == "harmonica":
        for k in ("hole", "blow", "bend", "ob"): notes[k] = [e[k] for e in n]
    out = dict(format="rockshiny-chart/1", instrument=chart["instrument"], songKey=song_key, meta=chart["meta"], notes=notes,
               chords=dict(t=[r3(c["time"]) for c in chart["chords"]], name=[c["name"] for c in chart["chords"]],
                           hd=[int(c["high_density"]) for c in chart["chords"]]),
               beats=dict(t=[r3(b["time"]) for b in chart["beats"]], m=[b["measure"] for b in chart["beats"]]),
               sections=dict(t=[r3(s["time"]) for s in chart["sections"]], name=[s["name"] for s in chart["sections"]],
                             label=[s["label"] for s in chart["sections"]]))
    if vocals: out["vocals"] = vocals
    if art: out["art"] = art
    return out

# ---------------------------------------------------------------- midi.R
def read_midi(data):                                     # mirrors read_midi()
    b = data
    if len(b) < 14 or b[:4] != b"MThd": raise ValueError("Not a Standard MIDI File")
    hlen, fmt, ntrk, division = struct.unpack(">IHHH", b[4:14])
    pos, tracks = 8 + hlen, []
    while pos + 8 <= len(b) and len(tracks) < ntrk:
        (ln,) = struct.unpack(">I", b[pos + 4:pos + 8])
        if b[pos:pos + 4] == b"MTrk": tracks.append(parse_track(b, pos + 8, min(len(b), pos + 8 + ln)))
        pos += 8 + ln
    metas = [m for t in tracks for m in t["meta"]]
    seconds = midi_clock(metas, division)
    end_tick = max(t["end_tick"] for t in tracks)
    out_tracks = []
    for t in tracks:
        notes = pair_notes(t["events"], t["end_tick"])
        for n in notes: n["time"] = seconds(n["start"]); n["sustain"] = seconds(n["end"]) - n["time"]
        names = [m["text"] for m in t["meta"] if m["type"] == 3]
        out_tracks.append(dict(name=names[0].strip() if names else "", notes=notes,
                               programs=[e for e in t["events"] if e["type"] == 12]))
    ts = sorted([m for m in metas if m["type"] == 88], key=lambda m: m["tick"])
    mk = [m for m in metas if m["type"] in (6, 7) and m["text"].strip()]
    return dict(format=fmt, division=division, tracks=out_tracks, seconds=seconds, end_tick=end_tick, length=seconds(end_tick),
                time_sigs=[dict(tick=m["tick"], nn=m["v1"], dd=m["v2"]) for m in ts],
                markers=[dict(time=seconds(m["tick"]), text=m["text"].strip()) for m in mk])

def parse_track(b, start, end):
    pos, t, status, events, meta = start, 0, 0, [], []
    def vlq():
        nonlocal pos
        v = 0
        while True:
            c = b[pos]; pos += 1; v = v * 128 + (c & 127)
            if c < 128 or pos >= end: return v
    while pos < end:
        t += vlq()
        if pos >= end: break
        c = b[pos]
        if c >= 128: st = c; pos += 1
        else:
            if status == 0: raise ValueError("running status without status")
            st = status
        if st == 255:
            mt = b[pos]; pos += 1; ln = vlq(); data = b[pos:pos + min(ln, end - pos)]; pos += ln
            v1 = v2 = None; txt = ""
            if mt == 81 and len(data) >= 3: v1 = data[0] * 65536 + data[1] * 256 + data[2]
            elif mt == 88 and len(data) >= 2: v1 = data[0]; v2 = 2 ** data[1]
            elif 1 <= mt <= 7:
                raw = bytes(x for x in data if x != 0)
                try: txt = raw.decode("utf-8")
                except UnicodeDecodeError: txt = raw.decode("latin-1")
            if mt == 47: break
            meta.append(dict(tick=t, type=mt, v1=v1, v2=v2, text=txt))
        elif st in (240, 247): pos += vlq()
        elif 128 <= st < 240:
            status = st; hi = st >> 4; nd = 1 if hi in (12, 13) else 2
            if pos + nd > end: break
            events.append(dict(tick=t, type=hi, ch=st & 15, d1=b[pos], d2=b[pos + 1] if nd == 2 else 0)); pos += nd
        else: break
    return dict(events=events, meta=meta, end_tick=t)

def midi_clock(metas, division):
    if division >= 32768:
        fps = 256 - division // 256; fps = 29.97 if fps == 29 else fps; tpf = division % 256
        return lambda tick: tick / (fps * tpf)
    tp = sorted([m for m in metas if m["type"] == 81 and m["v1"]], key=lambda m: m["tick"])
    last = {}
    for m in tp: last[m["tick"]] = m["v1"]
    tt = [0] + [m["tick"] for m in tp]; us = [500000] + [m["v1"] for m in tp]
    keep = {}
    for k, x in enumerate(tt): keep[x] = k
    idx = sorted(set(keep.values()))
    tt = [tt[k] for k in idx]; us = [us[k] for k in idx]
    sec = [0.0]
    for k in range(1, len(tt)): sec.append(sec[-1] + (tt[k] - tt[k - 1]) * us[k - 1] / (1e6 * division))
    def f(tick):
        i = bisect.bisect_right(tt, tick) - 1
        return sec[i] + (tick - tt[i]) * us[i] / (1e6 * division)
    return f

def pair_notes(events, end_tick):
    pending, notes = {}, []
    for e in events:
        on = e["type"] == 9 and e["d2"] > 0
        off = e["type"] == 8 or (e["type"] == 9 and e["d2"] == 0)
        k = (e["ch"], e["d1"])
        if on:
            notes.append(dict(start=e["tick"], end=None, midi=e["d1"], channel=e["ch"], velocity=e["d2"]))
            pending.setdefault(k, []).append(len(notes) - 1)
        elif off and pending.get(k):
            notes[pending[k].pop(0)]["end"] = e["tick"]
    for n in notes:
        if n["end"] is None: n["end"] = end_tick
    return sorted(notes, key=lambda n: (n["start"], n["midi"]))

MIDI_FAMILIES = ["Piano", "Chromatic percussion", "Organ", "Guitar", "Bass", "Strings", "Ensemble", "Brass", "Reed", "Pipe",
                 "Synth lead", "Synth pad", "Synth effects", "Ethnic", "Percussive", "Sound effects"]

def midi_parts(mid):
    rows = []
    allp = [p for t in mid["tracks"] for p in t["programs"]]
    for ti, tr in enumerate(mid["tracks"], 1):
        for ch in sorted(set(n["channel"] for n in tr["notes"])):
            if ch == 9: continue
            nn = sum(1 for n in tr["notes"] if n["channel"] == ch)
            if nn < 4: continue
            pg = [p["d1"] for p in tr["programs"] if p["ch"] == ch] or [p["d1"] for p in allp if p["ch"] == ch]
            prog = pg[0] if pg else 0
            fam = "Harmonica" if prog == 22 else MIDI_FAMILIES[prog // 8]
            rows.append(dict(id=f"t{ti}c{ch + 1}", name=tr["name"] or fam, track=ti, channel=ch + 1, program=prog, n_notes=nn,
                             instrument="harmonica" if prog == 22 else "piano", family=fam))
    multi = {r["track"] for r in rows if sum(1 for x in rows if x["track"] == r["track"]) > 1}
    for r in rows:
        if r["track"] in multi: r["name"] = f"{r['name']} (ch {r['channel']})"
    rows.sort(key=lambda r: (r["family"] != "Piano", -r["n_notes"]))
    pianos = [r for r in rows if r["family"] == "Piano"]
    if len(pianos) >= 2:
        rows.insert(0, dict(pianos[0], id="piano_all", name="Piano (all parts)", track=0, channel=0, n_notes=sum(r["n_notes"] for r in pianos)))
    names = [r["name"] for r in rows]
    for r, lab in zip(rows, unique_labels(names)): r["label"] = lab
    return rows

def unique_labels(x):
    out = list(x)
    for v in set(v for v in x if x.count(v) > 1):
        k = 0
        for i, y in enumerate(x):
            if y == v: k += 1; out[i] = f"{v} {k}"
    return out

def midi_part_events(mid, part):
    if part["track"] == 0:
        return dedupe_events([e for p in midi_parts(mid) if p["family"] == "Piano" and p["track"] > 0 for e in midi_part_events(mid, p)])
    tr = mid["tracks"][part["track"] - 1]
    return dedupe_events([dict(time=n["time"], midi=n["midi"], sustain=max(0, n["sustain"]), chord=-1)
                          for n in tr["notes"] if n["channel"] == part["channel"] - 1])

def midi_beats(mid):
    ts = {}
    for t in mid["time_sigs"]: ts[t["tick"]] = t
    ts = [ts[k] for k in sorted(ts)]
    if not ts or ts[0]["tick"] > 0: ts = [dict(tick=0, nn=4, dd=4)] + ts
    ticks, down = [], []
    for j, t in enumerate(ts):
        s0 = t["tick"]; s1 = ts[j + 1]["tick"] if j + 1 < len(ts) else mid["end_tick"] + 1
        step = mid["division"] * 4 / t["dd"]
        k = 0
        while s0 + k * step <= s1 - 1e-9:
            ticks.append(s0 + k * step); down.append(k % max(1, t["nn"]) == 0); k += 1
    out, m = [], 0
    for tk, d in zip(ticks, down):
        if d: m += 1
        out.append(dict(time=mid["seconds"](tk), measure=m if d else -1))
    return out

def midi_sections(mid, beats):
    import re
    if mid["markers"]:
        sec = [dict(name=(re.sub("[^A-Za-z]+", "", m["text"]).lower() or "part"), time=m["time"]) for m in mid["markers"]]
    else:
        bars = [b["time"] for b in beats if b["measure"] > 0 and (b["measure"] - 1) % 8 == 0] or [0]
        sec = [dict(name="part", time=t) for t in bars]
    return R.section_labels(sorted(sec, key=lambda s: s["time"]))

def midi_song_chart(mid, part, instrument=None, title="MIDI", octave=0, harp_key="auto"):
    beats = midi_beats(mid)
    src = dict(meta=dict(title=title, artist=None, song_length=mid["length"], arrangement=part["label"], difficulty=1,
                         max_difficulty=0, source="midi"),
               chords=[], beats=beats, sections=midi_sections(mid, beats))
    return chart_for_instrument(src, instrument or part["instrument"], ev=midi_part_events(mid, part), octave=octave, harp_key=harp_key)

# ---------------------------------------------------------------- writer (tests / demo)
def vlq_bytes(v):
    out = [v & 127]; v >>= 7
    while v: out.append((v & 127) | 128); v >>= 7
    return bytes(reversed(out))

def write_midi(tracks, division=480, running_status=True):
    """tracks: list of event lists [(tick, bytes)] (absolute ticks; bytes = status+data or FF meta)."""
    out = struct.pack(">4sIHHH", b"MThd", 6, 1, len(tracks), division)
    for evs in tracks:
        body, last, status = b"", 0, None
        for tick, msg in sorted(evs, key=lambda e: e[0]):
            body += vlq_bytes(tick - last); last = tick
            if running_status and msg[0] < 0xF0 and msg[0] == status: body += msg[1:]
            else: body += msg
            status = msg[0] if msg[0] < 0xF0 else status
        body += vlq_bytes(0) + b"\xff\x2f\x00"
        out += b"MTrk" + struct.pack(">I", len(body)) + body
    return out

def meta(t, data): return bytes([0xFF, t]) + vlq_bytes(len(data)) + data
def tempo(bpm): return meta(0x51, int(round(60e6 / bpm)).to_bytes(3, "big"))
def timesig(nn, dd): return meta(0x58, bytes([nn, int(math.log2(dd)), 24, 8]))
