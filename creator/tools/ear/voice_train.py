#!/usr/bin/env python3
"""
The voice model of rsc-voice.js (where someone sings): features, training, and an honest
test -- each song scored by a model trained on the other songs (leave one song out).

  python3 creator/tools/ear/voice_train.py [cache-dir] [--write]

cache-dir: made by prep.js (default: $TMPDIR/rsc-ear). Every song with lyrics is used;
its syllables are the labels (a frame is "sung" inside a syllable, 10 ms frames).

  features   the log-mel spectrum (40 bands, 80 Hz - 8 kHz) of the mid (L+R) and of the
             sides (L-R) at 22.05 kHz, each band minus its median over the song; then per
             band: the mid over 50 ms and 0.5 s, its spread over 0.5 s, the centre (mid -
             sides) over 0.5 s, and the 50 ms mid minus its 2 s mean (200 numbers a frame)
  model      logistic regression, the classes balanced
  reports    frame AUC per song, left out of the training; saves each song's p(voice)
             (<name>.p.npy, for eval_sync.js --loso)
  --write    trains on every song and writes the model into inst/engine/rsc-voice.js
             (V.MODEL); the JS front end computes the same features (checked: corr 0.99999)

Needs numpy.
"""
import glob, json, os, re, sys, tempfile
import numpy as np

SR, N, HOP, NMEL = 22050, 2048, 220, 40
HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_JS = os.path.join(HERE, "..", "..", "inst", "engine", "rsc-voice.js")

def melfb(nm=NMEL, fmin=80, fmax=8000):
    mel = lambda f: 2595 * np.log10(1 + f / 700); imel = lambda m: 700 * (10 ** (m / 2595) - 1)
    bins = np.floor((N + 1) * imel(np.linspace(mel(fmin), mel(fmax), nm + 2)) / SR).astype(int)
    fb = np.zeros((nm, N // 2 + 1))
    for i in range(nm):
        a, b, c = bins[i], bins[i + 1], bins[i + 2]
        for k in range(a, b): fb[i, k] = (k - a) / max(1, b - a)
        for k in range(b, c): fb[i, k] = (c - k) / max(1, c - b)
    return fb
FB = melfb()

def stft(x):
    frames = len(x) // HOP + 1; w = np.hanning(N).astype(np.float32)
    pad = np.concatenate([np.zeros(N // 2, np.float32), x, np.zeros(N, np.float32)])
    idx = np.arange(N)[None, :] + HOP * np.arange(frames)[:, None]
    return np.abs(np.fft.rfft(pad[idx] * w, axis=1))

def logmel(x):
    out, step = [], HOP * 3000
    for a in range(0, len(x), step):
        m = stft(x[a:a + step]); n = step // HOP if a + step < len(x) else m.shape[0]
        out.append(np.log(1e-6 + m[:n] @ FB.T))
    return np.concatenate(out)

def box(x, w):
    c = np.cumsum(np.vstack([np.zeros((1, x.shape[1])), x]), axis=0); n = x.shape[0]; h = w // 2
    a = np.clip(np.arange(n) - h, 0, n); b = np.clip(np.arange(n) + h + 1, 0, n)
    return (c[b] - c[a]) / (b - a)[:, None]

def features(L, R):
    lm, ls = logmel(0.5 * (L + R)), logmel(0.5 * (L - R))
    lm = lm - np.median(lm, axis=0); ls = ls - np.median(ls, axis=0)
    b51 = box(lm, 51)
    return np.hstack([box(lm, 5), b51, np.sqrt(np.maximum(0, box(lm ** 2, 51) - b51 ** 2)), box(lm - ls, 51), box(lm, 5) - box(lm, 201)]).astype(np.float32)

def song(base):
    cache = base + ".vfeat.npy"
    if os.path.exists(cache): X = np.load(cache)
    else:
        L = np.fromfile(base + ".L.f32", np.float32); R = np.fromfile(base + ".R.f32", np.float32)
        X = features(L, R); np.save(cache, X)
    y = np.zeros(X.shape[0], np.uint8)
    for s in json.load(open(base + ".json"))["syl"]:
        a = int(round(s["time"] * 100)); b = int(round((s["time"] + max(0.12, s["length"])) * 100)); y[max(0, a):min(len(y), b)] = 1
    return X, y

def auc(s, y):
    o = np.argsort(s); r = np.empty(len(s)); r[o] = np.arange(1, len(s) + 1); p = y.sum(); n = len(y) - p
    return (r[y == 1].sum() - p * (p + 1) / 2) / (p * n)

def train(X, y, epochs=4, lr=0.05, l2=1e-4, seed=0):
    rng = np.random.default_rng(seed); mu = X.mean(0); sd = X.std(0) + 1e-6; Xn = (X - mu) / sd
    w = np.zeros(X.shape[1], np.float32); b = 0.0
    wpos, wneg = 0.5 / y.mean(), 0.5 / (1 - y.mean()); idx = np.arange(len(y))
    for _ in range(epochs):
        rng.shuffle(idx)
        for a in range(0, len(idx), 512):
            bi = idx[a:a + 512]; x = Xn[bi]; t = y[bi].astype(np.float32); ww = np.where(t > 0, wpos, wneg)
            p = 1 / (1 + np.exp(-(x @ w + b))); g = (p - t) * ww / len(bi)
            w -= lr * (x.T @ g + l2 * w); b -= lr * g.sum()
    return dict(mu=mu, sd=sd, w=w, b=b)

def predict(m, X): return 1 / (1 + np.exp(-(((X - m["mu"]) / m["sd"]) @ m["w"] + m["b"])))

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    cache = args[0] if args else os.path.join(tempfile.gettempdir(), "rsc-ear")
    bases = sorted(j[:-5] for j in glob.glob(os.path.join(cache, "*.json")) if json.load(open(j))["syl"])
    if len(bases) < 3: sys.exit("needs at least 3 songs with lyrics in %s (run prep.js)" % cache)
    D = [song(b) for b in bases]
    aucs = []
    for i, b in enumerate(bases):
        m = train(np.vstack([D[j][0] for j in range(len(D)) if j != i]), np.concatenate([D[j][1] for j in range(len(D)) if j != i]))
        p = predict(m, D[i][0]); np.save(b + ".p.npy", p.astype(np.float32)); aucs.append(auc(p, D[i][1]))
        print("  %-40s AUC %.3f (left out)" % (os.path.basename(b)[:40], aucs[-1]))
    print("leave-one-song-out frame AUC: mean %.3f, range %.2f-%.2f, %d songs" % (np.mean(aucs), min(aucs), max(aucs), len(aucs)))
    if "--write" in sys.argv:
        m = train(np.vstack([d[0] for d in D]), np.concatenate([d[1] for d in D]))
        r = lambda a: [round(float(v), 5) for v in a]
        model = json.dumps({"mu": r(m["mu"]), "sd": r(m["sd"]), "w": r(m["w"]), "b": round(float(m["b"]), 5)}, separators=(",", ":"))
        js = open(VOICE_JS, encoding="utf-8").read()
        js2 = re.sub(r"V\.MODEL = \{.*?\};", lambda _: "V.MODEL = " + model + ";", js, count=1, flags=re.S)
        open(VOICE_JS, "w", encoding="utf-8").write(js2)
        print("wrote the model (%d songs) into %s" % (len(D), os.path.relpath(VOICE_JS)))

if __name__ == "__main__":
    main()
