"""
Synthesize a *performance* of a chart excerpt with known mistakes, for testing
microphone scoring: guitar/bass (Karplus-Strong plucked strings), piano
(inharmonic struck strings) or harmonica (breathy reed), per the chart.

  python3 synth_performance.py CHART.json START END OUT.wav OUT_truth.json [seed]

Per event (single note or chord): 80 % played correctly, 10 % a semitone off,
10 % omitted; +/-15 ms timing jitter; chords strummed (7 ms/string); legato
notes (hammer-on/pull-off/tap) get a much softer attack; fret-hand mutes are
short noise bursts; a new note on a string stops the previous one.
The truth file lists every event with its outcome and actual played time.
"""
import json, sys, wave
import numpy as np
from scipy.signal import lfilter

SR = 48000
TECH = dict(HAMMER_ON=1, PULL_OFF=2, PALM_MUTE=4, FRET_HAND_MUTE=8, HARMONIC=16, PINCH_HARMONIC=32, TAP=1024)
OPEN = {6: [40, 45, 50, 55, 59, 64], 4: [28, 33, 38, 43]}
HARM = {12: 12, 7: 19, 19: 19, 5: 24, 24: 24, 4: 28, 9: 28, 16: 28, 3: 31}

def expected_semitones(meta, s, f, tech):            # mirrors HitJudge.setChart (input.js)
    base = OPEN[4 if meta.get("n_strings") == 4 else 6][s] + (meta.get("tuning") or [0] * 6)[s]
    semis = base + (meta.get("capo") or 0 if f == 0 else f)
    if tech & TECH["HARMONIC"] and f in HARM: semis = base + HARM[f]
    return semis + (meta.get("cent_offset") or 0) / 100

def pluck(freq, dur, amp, rng, soft=False, palm=False):
    n = int(dur * SR)
    N = max(2, int(round(SR / freq - 0.5)))            # KS loop delay (averaging adds half a sample)
    burst = rng.uniform(-1, 1, N)
    if soft: burst = np.convolve(burst, np.ones(6) / 6, "same") * 0.45   # hammer-on: no pick attack
    x = np.zeros(n); x[:N] = burst * amp
    g = 0.985 if palm else 0.9985
    a = np.zeros(N + 2); a[0] = 1; a[N] = -g / 2; a[N + 1] = -g / 2
    y = lfilter([1.0], a, x)
    fade = int(0.01 * SR)
    y[-fade:] *= np.linspace(1, 0, fade)
    return y

def piano(freq, dur, amp, rng):
    """Struck string: inharmonic partials (B ~ 4e-4), faster decay for upper partials,
    a short hammer thump, damper at key release."""
    n = int((dur + 0.25) * SR); t = np.arange(n) / SR
    B = 4e-4 * (freq / 261.6) ** 0.5
    y = np.zeros(n)
    for k in range(1, 14):
        fk = k * freq * np.sqrt(1 + B * k * k)
        if fk > SR / 2 - 1000: break
        decay = (0.6 + 0.25 * k) * (freq / 261.6) ** 0.4
        y += (k ** -1.1) * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28)) * np.exp(-decay * t)
    y[:int(0.003 * SR)] += rng.normal(0, 0.3, int(0.003 * SR))            # hammer
    rel = int(dur * SR)
    if rel < n: y[rel:] *= np.exp(-np.arange(n - rel) / (0.06 * SR))      # damper
    y *= np.minimum(1, t / 0.002)
    return amp * 0.5 * y / max(1e-9, np.max(np.abs(y[:int(0.05 * SR)])))

def reed(freq, dur, amp, rng):
    """Harmonica reed: bright harmonic series with a formant, breathy 40 ms onset,
    slight vibrato, sustained until the breath stops."""
    n = int((dur + 0.06) * SR); t = np.arange(n) / SR
    vib = 1 + 0.004 * np.sin(2 * np.pi * 4.8 * t) * np.minimum(1, t / 0.3)
    phase = 2 * np.pi * freq * np.cumsum(vib) / SR
    y = np.zeros(n)
    for k in range(1, 16):
        if k * freq > SR / 2 - 1000: break
        form = 1 + 1.5 * np.exp(-((k * freq - 1400) / 700) ** 2)
        y += (k ** -0.9) * form * np.sin(k * phase)
    env = np.minimum(1, t / 0.04) * np.where(t > dur, np.exp(-(t - dur) / 0.02), 1)
    y = y / np.max(np.abs(y)) * env + rng.normal(0, 0.02, n) * np.minimum(1, t / 0.04)
    return amp * 0.5 * y

def main_lanes(c, t0, t1, out_wav, out_truth, rng):
    """Piano / harmonica lane charts: the chart gives the MIDI pitch; chords are
    struck together (piano), the harmonica is a legato melody."""
    N = c["notes"]; harp = c.get("instrument") == "harmonica"
    idx = [i for i, t in enumerate(N["t"]) if t0 <= t < t1]
    events = []
    for i in idx:
        if events and abs(N["t"][i] - events[-1]["time"]) < 0.002: events[-1]["notes"].append(i)
        else: events.append(dict(time=N["t"][i], notes=[i]))
    out = np.zeros(int((t1 - t0 + 3) * SR)); truth = []
    for k, ev in enumerate(events):
        r = rng.random()
        outcome = "correct" if r < 0.8 else ("wrong" if r < 0.9 else "omitted")
        played = ev["time"] + float(np.clip(rng.normal(0, 0.015), -0.04, 0.04))
        truth.append(dict(time=ev["time"], played=played, outcome=outcome, notes=ev["notes"]))
        if outcome == "omitted": continue
        shift = rng.choice([-1, 1]) if outcome == "wrong" else 0
        amp = rng.uniform(0.7, 1.0)
        nxt = events[k + 1]["time"] if k + 1 < len(events) else 1e9
        for j, i in enumerate(ev["notes"]):
            f = 440 * 2 ** ((N["midi"][i] + shift - 69) / 12)
            if harp:
                dur = max(0.1, min(nxt - 0.03, ev["time"] + max(N["sus"][i], 0.15)) - played)
                y = reed(f, dur, 0.35 * amp, rng)
            else:
                dur = max(0.12, ev["time"] + max(N["sus"][i], 0.2) - played)
                y = piano(f, dur, 0.3 * amp / max(1, len(ev["notes"])) ** 0.3, rng)
            p0 = int((played + 0.004 * j - t0) * SR)
            if p0 < 0 or p0 >= len(out): continue
            seg = out[p0:p0 + len(y)]; seg += y[:len(seg)]
    out += rng.normal(0, 10 ** (-55 / 20), len(out))
    out /= max(1.0, np.max(np.abs(out)) / 0.9)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((out * 32767).astype("<i2").tobytes())
    json.dump(dict(start=t0, end=t1, events=truth), open(out_truth, "w"))
    counts = {k: sum(e["outcome"] == k for e in truth) for k in ("correct", "wrong", "omitted")}
    print(f"{out_wav}: {len(truth)} events {counts}, {len(out) / SR:.1f} s")

def main():
    chart_path, t0, t1, out_wav, out_truth = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), sys.argv[4], sys.argv[5]
    rng = np.random.default_rng(int(sys.argv[6]) if len(sys.argv) > 6 else 7)
    c = json.load(open(chart_path)); meta = c["meta"]; N = c["notes"]
    if c.get("instrument") in ("piano", "harmonica"): return main_lanes(c, t0, t1, out_wav, out_truth, rng)
    idx = [i for i, t in enumerate(N["t"]) if t0 <= t < t1]
    events = []
    for i in idx:
        if events and abs(N["t"][i] - events[-1]["time"]) < 0.002: events[-1]["notes"].append(i)
        else: events.append(dict(time=N["t"][i], notes=[i]))
    # next note per string (a new note stops the string)
    nxt = {}
    by_string = {}
    for i in idx: by_string.setdefault(N["s"][i], []).append(i)
    for s, lst in by_string.items():
        for a, b in zip(lst, lst[1:]): nxt[a] = N["t"][b]
    out = np.zeros(int((t1 - t0 + 3) * SR))
    truth = []
    for ev in events:
        r = rng.random()
        outcome = "correct" if r < 0.8 else ("wrong" if r < 0.9 else "omitted")
        jitter = float(np.clip(rng.normal(0, 0.015), -0.04, 0.04))
        played = ev["time"] + jitter
        truth.append(dict(time=ev["time"], played=played, outcome=outcome, notes=ev["notes"]))
        if outcome == "omitted": continue
        shift = rng.choice([-1, 1]) if outcome == "wrong" else 0
        amp_ev = rng.uniform(0.7, 1.0)
        for k, i in enumerate(sorted(ev["notes"], key=lambda j: N["s"][j])):
            tech = N["tech"][i]
            start = played + 0.007 * k
            end = min(nxt.get(i, 1e9), ev["time"] + max(N["sus"][i], 0.25) + 0.2)
            dur = max(0.08, end - start)
            p0 = int((start - t0) * SR)
            if p0 < 0 or p0 >= len(out): continue
            if tech & TECH["FRET_HAND_MUTE"]:
                y = rng.uniform(-1, 1, int(0.04 * SR)) * np.exp(-np.linspace(0, 6, int(0.04 * SR))) * 0.25 * amp_ev
            else:
                semis = expected_semitones(meta, N["s"][i], N["f"][i], tech) + shift
                f = 440 * 2 ** ((semis - 69) / 12)
                soft = bool(tech & (TECH["HAMMER_ON"] | TECH["PULL_OFF"] | TECH["TAP"]))
                y = pluck(f, dur, 0.3 * amp_ev, rng, soft=soft, palm=bool(tech & TECH["PALM_MUTE"]))
            seg = out[p0:p0 + len(y)]
            seg += y[:len(seg)]
    out += rng.normal(0, 10 ** (-55 / 20), len(out))       # noise floor (-55 dBFS)
    out /= max(1.0, np.max(np.abs(out)) / 0.9)
    with wave.open(out_wav, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((out * 32767).astype("<i2").tobytes())
    json.dump(dict(start=t0, end=t1, events=truth), open(out_truth, "w"))
    counts = {k: sum(e["outcome"] == k for e in truth) for k in ("correct", "wrong", "omitted")}
    print(f"{out_wav}: {len(truth)} events {counts}, {len(out) / SR:.1f} s")

if __name__ == "__main__":
    main()
