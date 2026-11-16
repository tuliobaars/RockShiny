# tools/ear — the voice model and the measurements "by ear"

Scripts behind the Creator's voice model (`inst/engine/rsc-voice.js`) and the
numbers quoted for lyrics sync and chart drafts (`inst/engine/rsc-transcribe.js`).
They need the sample songs (RockShiny's `songs/`, or any folder of `.psarc`
files you own), Node, ffmpeg, and Python 3 with numpy.

```bash
node    creator/tools/ear/prep.js [songs-dir] [cache-dir]       # decode every song once (stereo 22.05 kHz + its charts and lyrics)
python3 creator/tools/ear/voice_train.py [cache-dir]            # the voice model, tested leave-one-song-out (frame AUC per song)
python3 creator/tools/ear/voice_train.py [cache-dir] --write    # ...and write the model trained on every song into rsc-voice.js
node    creator/tools/ear/eval_sync.js [cache-dir] --loso       # auto-sync and "Sync each line", with models that never saw the song
node    creator/tools/ear/eval_drafts.js [cache-dir]            # the chord and bass drafts against the songs' own charts
```

`cache-dir` defaults to `$TMPDIR/rsc-ear` (about 40 MB of audio per song).

**Labels.** A 10 ms frame counts as *sung* when it lies inside one of the song's
own lyric syllables (at least 0.12 s each). Charts give the notes: the drafts are
compared with the rhythm chart's chords (the root is the chord's lowest note) and
with the bass chart's notes (onsets within 0.1 s).

**Honest numbers.** The shipped model was trained on every song that has lyrics,
so scoring the sync with it would flatter it. `voice_train.py` saves, for each
song, p(voice) from a model trained on the *other* songs (`<name>.p.npy`), and
`eval_sync.js --loso` uses those. Results on the 11 sample songs with lyrics
(creator/README.md has the table):

| | |
|---|---|
| frame AUC, leave one song out | 0.77 (0.54–0.92) |
| auto-sync, lyrics moved ≤ 2.5 s | median 0.08 s, 75 % of lines < 0.3 s, worst 0.72 s (onsets only: 0.30 s, 48 %) |
| sync each line, lines ±0.8 s | median 0.35 s (one shift 0.51 s) |
| sync each line, another take 0.5 % slower | median 0.28 s (one shift 0.38 s) |
| chord roots (10 songs) | 51 % of the chords |
| bass draft (12 songs) | F 0.21 (any octave 0.31) |
