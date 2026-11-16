"""Write inst/examples/ode-to-joy-demo.mid: Beethoven's "Ode to Joy" (public
domain) for trying MIDI songs, piano (two hands) and harmonica (C harp).
Format 1: conductor (tempo, 4/4, section markers) + piano right hand + piano
left hand + harmonica (General MIDI program 23)."""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
import instruments_ref as I

C, D, E, F, G, G3 = 60, 62, 64, 65, 67, 55
A = [(E, 1), (E, 1), (F, 1), (G, 1), (G, 1), (F, 1), (E, 1), (D, 1), (C, 1), (C, 1), (D, 1), (E, 1)]
line1 = A + [(E, 1.5), (D, 0.5), (D, 2)]
line2 = A + [(D, 1.5), (C, 0.5), (C, 2)]
line3 = [(D, 1), (D, 1), (E, 1), (C, 1), (D, 1), (E, .5), (F, .5), (E, 1), (C, 1),
         (D, 1), (E, .5), (F, .5), (E, 1), (D, 1), (C, 1), (D, 1), (G3, 2)]
melody = line1 + line2 + line3 + line2
# left hand: one bass note + fifth per half bar (C or G harmony)
harmony = ["C", "G", "C", "G", "C", "G", "C", "G"] * 2 + ["G", "C", "G", "C", "G", "C", "G", "G"] + ["C", "G", "C", "G", "C", "G", "G", "C"]
chord = {"C": (48, 55), "G": (43, 50)}

DIV = 480
def track(name, ch, program, notes):
    ev = [(0, I.meta(0x03, name.encode())), (0, bytes([0xC0 | ch, program]))]
    for start, pitch, beats in notes:
        on = int(start * DIV); off = int((start + beats * 0.95) * DIV)
        ev += [(on, bytes([0x90 | ch, pitch, 92])), (off, bytes([0x80 | ch, pitch, 0]))]
    return ev

t, mel = 0.0, []
for p, d in melody: mel.append((t, p + 12, d)); t += d            # right hand an octave up (C5 region)
lh = []
for k, h in enumerate(harmony):
    for p in chord[h]: lh.append((k * 2.0, p, 2.0))
harp = [(s, p, d) for s, p, d in mel]                             # melody on a C harp (holes 4-7)
conductor = [(0, I.meta(0x03, b"Ode to Joy (demo)")), (0, I.tempo(100)), (0, I.timesig(4, 4)),
             (0, I.meta(0x06, b"Theme")), (int(16 * DIV * 2), I.meta(0x06, b"Bridge")), (int(24 * DIV * 2), I.meta(0x06, b"Theme"))]
data = I.write_midi([conductor, track("Piano right hand", 0, 0, mel), track("Piano left hand", 1, 0, lh),
                     track("Harmonica", 2, 22, harp)], DIV)
out = os.path.join(os.path.dirname(__file__), "..", "..", "inst", "examples", "ode-to-joy-demo.mid")
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, "wb").write(data)
mid = I.read_midi(data)
print(out, len(data), "bytes;", [(p["label"], p["n_notes"], p["instrument"]) for p in I.midi_parts(mid)], f"{mid['length']:.1f} s")
