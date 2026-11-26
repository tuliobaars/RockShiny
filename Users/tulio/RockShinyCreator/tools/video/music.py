#!/usr/bin/env python3
"""
An original music bed for the RockShiny videos, synthesised from scratch (no
samples, no third-party music): A minor, i-VI-III-VII (Am F C G), drums, bass,
pads and an arpeggio. Royalty-free by construction.

  python3 tools/video/music.py teaser out.wav [seconds]   # builds up, full groove, outro
  python3 tools/video/music.py tour   out.wav [seconds]   # calmer, steady, loops
"""
import sys, wave
import numpy as np

SR = 44100
BPM = 112.0
BEAT = 60.0 / BPM
BAR = 4 * BEAT
rng = np.random.default_rng(7)

def midi_hz(m): return 440.0 * 2 ** ((m - 69) / 12.0)

def env_ad(n, a, d):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-6), np.exp(-(t - a) / d))
    return e

def lp(x, fc):
    """One-pole low-pass (block loop: fast enough for a few minutes of audio)."""
    a = np.exp(-2 * np.pi * fc / SR)
    b = 1 - a
    out = np.empty_like(x)
    s = 0.0
    for i in range(len(x)):
        s = b * x[i] + a * s
        out[i] = s
    return out

def _additive(freq, n, detune, odd_only, top=7000.0, tilt=1.0):
    """Band-limited wave by additive synthesis (no aliasing): 1/k^tilt harmonics up to `top` Hz."""
    t = np.arange(n) / SR
    f = freq * (1 + detune)
    K = max(1, int(min(top, SR / 2 - 2000) // f))
    ks = np.arange(1, K + 1, 2 if odd_only else 1)
    # sum in chunks of harmonics to bound memory
    out = np.zeros(n)
    for i in range(0, len(ks), 8):
        kk = ks[i:i + 8][:, None]
        out += (np.sin(2 * np.pi * kk * f * t[None, :]) / kk ** tilt).sum(axis=0)
    return out * (2 / np.pi)

def saw(freq, n, detune=0.0, top=7000.0):
    return _additive(freq, n, detune, False, top)

def square(freq, n, duty=0.5, top=5000.0):
    return _additive(freq, n, 0.0, True, top)

def soft(freq, n, detune=0.0):
    """A mellow tone (a few harmonics): for the arpeggio."""
    return _additive(freq, n, detune, False, top=2500.0, tilt=1.6)

def add(buf, x, at):
    i = int(round(at * SR))
    if i >= len(buf): return
    x = x[: len(buf) - i]
    buf[i:i + len(x)] += x

def kick(n=int(0.35 * SR)):
    t = np.arange(n) / SR
    f = 48 + 90 * np.exp(-t / 0.035)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / 0.16) * 0.95 + 0.25 * np.exp(-t / 0.004) * rng.standard_normal(n) * 0.3

def snare(n=int(0.25 * SR)):
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    noise = noise - np.concatenate([[0], noise[:-1]]) * 0.6        # brighten
    return (0.55 * noise * np.exp(-t / 0.06) + 0.35 * np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05)) * 0.7

def hat(open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    x = x - np.concatenate([[0], x[:-1]])                              # high-pass
    return x * np.exp(-t / (0.09 if open_ else 0.018)) * 0.11

CHORDS = [(57, [57, 60, 64]), (53, [53, 57, 60]), (48, [48, 52, 55]), (55, [55, 59, 62])]   # Am F C G (roots, triads)

def render(kind, seconds):
    n = int(seconds * SR) + SR
    L = np.zeros(n); R = np.zeros(n)
    drums = np.zeros(n); bass = np.zeros(n); pad = np.zeros(n); arp = np.zeros(n); pump = np.ones(n)
    bars = int(np.ceil(seconds / BAR)) + 1
    for b in range(bars):
        t0 = b * BAR
        if t0 > seconds: break
        root, triad = CHORDS[b % 4]
        if kind == "teaser":
            part = "intro" if b < 4 else "build" if b < 8 else "outro" if t0 > seconds - 4 * BAR else "main"
        else:
            part = "intro" if b < 2 else "outro" if t0 > seconds - 2 * BAR else ("main" if (b // 8) % 2 == 0 else "soft")
        # pad: detuned saws, low-passed, slow attack
        m = int(BAR * SR)
        p = np.zeros(m)
        for note in triad + [triad[0] + 12]:
            f = midi_hz(note)
            p += saw(f, m, -0.004, top=3500.0) + saw(f, m, 0.005, top=3500.0)
        att = np.minimum(1, np.arange(m) / (0.35 * SR)); rel = np.minimum(1, (m - np.arange(m)) / (0.25 * SR))
        p *= att * rel * (0.05 if part != "intro" else 0.065)
        add(pad, p, t0)
        # drums
        if part in ("build", "main", "soft"):
            for q in range(4):
                if part == "soft" and q % 2: continue
                add(drums, kick(), t0 + q * BEAT)
                i = int((t0 + q * BEAT) * SR); k = int(0.22 * SR)
                if i < n: pump[i:i + k] = np.minimum(pump[i:i + k], 0.45 + 0.55 * np.linspace(0, 1, len(pump[i:i + k])))
            if part != "soft":
                for q in (1, 3): add(drums, snare(), t0 + q * BEAT)
        if part in ("intro", "build", "main", "soft"):
            for e in range(8):
                if part == "intro" and b < 2: break
                add(drums, hat(open_=(e % 2 == 1 and part == "main" and e == 7)), t0 + e * BEAT / 2 + (0.012 if e % 2 else 0))
        if part == "build" and b == 7:                                  # fill into the groove
            for e in range(4): add(drums, snare() * (0.5 + 0.12 * e), t0 + 3 * BEAT + e * BEAT / 4)
        # bass: eighths on the root, octave pops
        if part in ("build", "main", "soft"):
            for e in range(8):
                note = root - 24 + (12 if e in (3, 7) and part == "main" else 0)
                k = int(BEAT / 2 * SR * 0.92)
                x = saw(midi_hz(note), k, top=1800.0) * 0.7 + np.sin(2 * np.pi * midi_hz(note) * np.arange(k) / SR) * 0.5
                x *= env_ad(k, 0.004, 0.16) * 0.32
                add(bass, x, t0 + e * BEAT / 2)
        # arpeggio: 16ths over the triad, up and down
        if part == "main" or (part == "build" and b >= 6):
            seq = [0, 1, 2, 3, 2, 1, 0, 1]
            notes = triad + [triad[0] + 12]
            for s in range(16):
                note = notes[seq[s % 8]] + 12
                k = int(BEAT / 4 * SR * 0.9)
                x = soft(midi_hz(note), k) * 0.7 + soft(midi_hz(note), k, 0.004) * 0.3
                x *= env_ad(k, 0.003, 0.09) * (0.09 if part == "main" else 0.06)
                add(arp, x, t0 + s * BEAT / 4)
    # a little filtering and space
    bass = lp(bass, 900.0)
    arp_d = arp.copy()
    d = int(BEAT * 0.75 * SR)
    for k, g in ((d, 0.35), (2 * d, 0.18)):
        arp_d[k:] += arp[:-k] * g
    pad = lp(lp(pad, 2200.0), 2200.0)
    drums = drums * 0.85 + lp(drums, 6000.0) * 0.15
    mix_mono = drums * 0.9 + bass
    pad_p = pad * pump
    L = mix_mono + pad_p * 1.0 + arp_d * 0.8 + np.concatenate([np.zeros(int(0.011 * SR)), arp_d[:-int(0.011 * SR)]]) * 0.25
    R = mix_mono + np.concatenate([np.zeros(int(0.017 * SR)), pad_p[:-int(0.017 * SR)]]) + arp_d * 0.45 + arp * 0.2
    out = np.stack([L, R])[:, : int(seconds * SR)]
    # fades, soft clip, normalise
    fi, fo = int(1.0 * SR), int(2.5 * SR)
    out[:, :fi] *= np.linspace(0, 1, fi)
    out[:, -fo:] *= np.linspace(1, 0, fo) ** 1.5
    # master: tame the very top, soft clip
    out = np.stack([0.6 * ch + 0.4 * lp(ch, 9000.0) for ch in out])
    out = np.tanh(out * 1.2)
    out *= 0.89 / max(1e-9, np.abs(out).max())
    return out

def write(path, x):
    pcm = (np.clip(x.T, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

if __name__ == "__main__":
    kind, path = sys.argv[1], sys.argv[2]
    secs = float(sys.argv[3]) if len(sys.argv) > 3 else (60 if kind == "teaser" else 180)
    write(path, render(kind, secs))
    print("wrote", path, secs, "s")
