"""Generate frontend fixtures: chart JSON (exact chart_json() shape) and a
synthetic click-track OGG with a click at every note onset (for A/V checks).
Usage: python3 tests/reference/make_fixtures.py [out_dir]"""
import hashlib, json, os, subprocess, sys, wave
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import rockshiny_ref as R

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "frontend", "fixtures")
os.makedirs(OUT, exist_ok=True)
SONGS = [("Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc", "wishyouwhizzhere_lead", "wywh_lead", 1.0),
         ("Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc", "wishyouwhizzhere_lead", "wywh_lead_50", 0.5),
         ("Dire-Straits_Sultans-of-Swing_v443_m.psarc", "direstraitssultansplum_lead", "sultans_lead", 1.0),
         ("Dire-Straits_Sultans-of-Swing_v443_m.psarc", "direstraitssultansplum_bass", "sultans_bass", 1.0),
         ("DaftPunk_GetLucky_m.psarc", "getluckydaftpunk_lead", "getlucky_lead", 1.0),
         ("Daiki_Kasho_All_My_Life_v1_m.psarc", "daikikashoallmylife_rhythm", "allmylife_rhythm", 1.0),
         # held out from all detector tuning (scoring accuracy only):
         ("Gary-Moore_Still-Got-the-Blues-Live_v1_m.psarc", "gmstillgotbluesplum_lead", "stillgotblues_lead", 1.0),
         ("Eric-Clapton_Riding-With-The-King_v2_DD_m.psarc", "ecridingwiththeking_rhythm", "ridingking_rhythm", 1.0),
         ("Pink-Floyd_Comfortably-Numb_v6_m.psarc", "floydcomfortably_lead", "numb_lead", 1.0)]
built = {}
for fname, arr, tag, difficulty in SONGS:
    path = os.path.join(os.path.dirname(__file__), "..", "..", "songs", fname)
    arc = R.Psarc(path)
    chart = R.build_chart(R.parse_arrangement_xml(arc.read(f"songs/arr/{arr}.xml")), difficulty)
    chart["meta"].update(title=chart["meta"]["title"], arrangement=arr.split("_")[-1].title())
    key = hashlib.md5(fname.encode()).hexdigest()
    payload = R.chart_json(chart, key, vocals=R.song_vocals(arc), art=R.song_album_art(arc))
    built[tag] = (chart, key, arc)
    with open(os.path.join(OUT, tag + ".json"), "w") as f: json.dump(payload, f, separators=(",", ":"))
    print(tag, len(chart["notes"]), "notes", os.path.getsize(os.path.join(OUT, tag + ".json")) // 1024, "KB")

# ---- other instruments (R/instruments.R mirror) + MIDI (R/midi.R mirror)
import copy, xml.etree.ElementTree as ET
import instruments_ref as I
def save_lane(tag, lane, key, arc=None):
    payload = I.lane_chart_json(lane, key, vocals=R.song_vocals(arc) if arc else None, art=R.song_album_art(arc) if arc else None)
    with open(os.path.join(OUT, tag + ".json"), "w") as f: json.dump(payload, f, separators=(",", ":"))
    m = lane["meta"]
    print(tag, len(lane["notes"]), "notes", m.get("instrument_tag"), f"dropped {m.get('harp_dropped', 0)}" if m["instrument"] == "harmonica" else "")
for src, tag, inst in [("wywh_lead", "wywh_piano", "piano"), ("allmylife_rhythm", "allmylife_piano", "piano"),
                       ("sultans_lead", "sultans_harmonica", "harmonica"), ("stillgotblues_lead", "stillgot_harmonica", "harmonica"),
                       # held out from all tuning:
                       ("ridingking_rhythm", "riding_piano", "piano"), ("numb_lead", "numb_harmonica", "harmonica")]:
    chart, key, arc = built[src]
    save_lane(tag, I.chart_for_instrument(copy.deepcopy(chart), inst), key, arc)
# pitched vocals (Get Lucky) -> harmonica, on the lead chart's timeline
chart, key, arc = built["getlucky_lead"]
vx = [f for f in arc.find(r"^songs/arr/.*_vocals\.xml$")][0]
v = [(float(e.get("time")), float(e.get("length") or 0), e.get("lyric"), float(e.get("note") or 254)) for e in ET.fromstring(arc.read(vx)).findall("vocal")]
base = copy.deepcopy(chart); base["meta"]["arrangement"] = "Vocals"; base["chords"] = []
save_lane("getlucky_vocals_harmonica", I.chart_for_instrument(base, "harmonica", ev=I.vocal_pitch_events(v)), key, arc)

# a MIDI file with the WYWH piano part: 3 tracks (conductor with tempo changes + markers,
# right hand, left hand), running status, note-off as velocity-0 note-on
wp = I.events_to_piano(copy.deepcopy(built["wywh_lead"][0]), I.chart_pitch_events(copy.deepcopy(built["wywh_lead"][0])))
DIV = 480
tempo_map = [(0, 60.0), (DIV * 16, 63.0), (DIV * 40, 61.5)]          # bpm changes at ticks
def sec_to_tick(sec):
    t0, acc = 0, 0.0
    for k, (tk, bpm) in enumerate(tempo_map):
        nxt = tempo_map[k + 1][0] if k + 1 < len(tempo_map) else None
        spt = 60.0 / bpm / DIV
        seg = (nxt - tk) * spt if nxt is not None else None
        if seg is None or sec < acc + seg: return tk + round((sec - acc) / spt)
        acc += seg
conductor = [(0, I.meta(0x03, b"WYWH test")), (0, I.timesig(4, 4)), (DIV * 24, I.timesig(3, 4)), (DIV * 27, I.timesig(4, 4)),
             (0, I.meta(0x06, b"Intro")), (DIV * 32, I.meta(0x06, b"Verse"))] + [(tk, I.tempo(b)) for tk, b in tempo_map]
hands = {0: [(0, I.meta(0x03, b"Left hand")), (0, bytes([0xC1, 0]))], 1: [(0, I.meta(0x03, b"Right hand")), (0, bytes([0xC0, 0]))]}
for e in wp["notes"]:
    if e["time"] > 60: break
    ch = 0 if e["hand"] == 1 else 1
    on = sec_to_tick(e["time"]); off = max(on + 1, sec_to_tick(e["time"] + max(e["sustain"], 0.1)))
    hands[e["hand"]] += [(on, bytes([0x90 | ch, e["midi"], 90])), (off, bytes([0x90 | ch, e["midi"], 0]))]
mid_bytes = I.write_midi([conductor, hands[1], hands[0]], DIV)
with open(os.path.join(OUT, "wywh_test.mid"), "wb") as f: f.write(mid_bytes)
mid = I.read_midi(mid_bytes)
parts = I.midi_parts(mid)
save_lane("midi_piano", I.midi_song_chart(mid, parts[0], title="WYWH test"), "midi-" + hashlib.md5(mid_bytes).hexdigest())
print("midi parts:", [(p["label"], p["n_notes"]) for p in parts])

# click track for the first song: 48 kHz stereo, 4 ms clicks at each onset
chart = json.load(open(os.path.join(OUT, "wywh_lead.json")))
sr, dur = 48000, 70.0
x = np.zeros(int(sr * dur), dtype=np.float32)
click = (np.sin(2 * np.pi * 2000 * np.arange(int(0.004 * sr)) / sr) * np.hanning(int(0.004 * sr))).astype(np.float32)
for t in sorted(set(chart["notes"]["t"])):
    i = int(round(t * sr))
    if i + len(click) < len(x): x[i:i + len(click)] += 0.8 * click
pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
wav = os.path.join(OUT, "clicks.wav")
with wave.open(wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
# same encoder settings as R/audio.R::ffmpeg_encode()
subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-vn", "-c:a", "libvorbis", "-q:a", "5",
                os.path.join(OUT, "clicks.ogg")], check=True)
# quick-start clip of the same audio (first 30 s), encoded like rs-convert.sh does
subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-t", "30", "-vn", "-c:a", "libvorbis", "-q:a", "5",
                os.path.join(OUT, "clicks_head.ogg")], check=True)
os.remove(wav)
print("clicks.ogg", os.path.getsize(os.path.join(OUT, "clicks.ogg")) // 1024, "KB")
