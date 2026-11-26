# RockShiny

Rocksmith 2014 `.psarc` (or a MIDI file) → Rocksmith-style 3D note highway in
Shiny, with the song audio in sync, for guitar, bass, piano and harmonica —
and a **karaoke mode** that sings along with any song whose archive has lyrics.

[![RockShiny in one minute: the highway, piano, karaoke, the home page and the Creator](creator/docs/video/rockshiny-teaser-poster.jpg)](creator/docs/video/rockshiny-teaser.mp4)

▶ **[RockShiny in one minute](creator/docs/video/rockshiny-teaser.mp4)** (the teaser) · ▶ **[The Creator, a guided tour](creator/docs/video/creator-tour.mp4)** (about 3 minutes). Both are silent except for an original music bed, with captions in the picture.

* **R** (`R/`): PSARC unpacking (AES-CFB TOC, zlib blocks), XML and SNG chart
  parsing with the Dynamic Difficulty merge, Wwise audio conversion.
* **JS** (`inst/highway/`): custom Shiny output binding, audio-master clock,
  two zero-dependency renderers (Canvas 2D or HTML/SVG) switchable at runtime,
  a smooth dead-zone camera, a ghost fretboard with headstock and tuning pegs,
  lyrics, album art, and an in-browser "Benchmark renderers" button.
* **Practice**: loop any range of sections with a lead-in countdown, slow it
  down, speed up automatically on each pass, or lower the difficulty.
* **Fast audio**: a small library is pre-decoded in the background (once,
  cached); new songs start on a 30 s quick-start clip and switch seamlessly to
  the full file.
* **Home page** (the first screen): your library by artist, album and genre,
  playlists (create, reorder, rename), recently played and search, laid out
  like a music app's home page; a song, album, artist, genre or playlist plays
  in the instrument or the karaoke mode, one song after the other. Genres are
  set by hand or looked up on MusicBrainz.
* **Any library folder, any size**: choose the folder in the app (*Change…*,
  subfolders optional, remembered). Libraries of more than 50 songs are mapped
  at once (827 songs / 6 GB: listed in a moment, 0.1 s from the index after
  the first time), checked in the background, and each song is read, keyed
  and decoded only when it is picked.
* **Technique animations**: bends follow their real curves (the string is
  pushed up), plus vibrato, tremolo, accents, harmonics, mutes and legato.
* **Sync**: the `<audio>` element is the master clock, extrapolated per frame,
  predicted to the frame's display time, with output latency compensated via
  Web Audio (measured end to end: within a frame).
* **Piano and harmonica**: any guitar/bass part (or pitched lyrics, or a
  `.mid` file) can be played on a 3D keyboard highway (hands coloured) or on
  a 10-hole harmonica (best harp key chosen automatically; tab with
  blow/draw, bends and overblows). Guide tones synthesize the part, which is
  the only sound for MIDI songs. A public-domain demo is in `inst/examples`.
* **Karaoke mode** (navbar: *Instrument | Karaoke*, its own sidebar and
  player): big lyrics, highlighted syllable by syllable with a colour wipe, on
  the same audio-master clock as the highway (latency-compensated). Songs
  without lyrics in the file get them from a `.lrc` next to them or from
  **LRCLIB** (web), **synced to the recording automatically** and wiped
  syllable by syllable too (estimated timing, flagged ≈); a song gets a
  "Sing along" button in instrument mode. Stage or lyric-sheet view, countdown and count-in dots
  through intros and solos, section names, click a line to sing from there,
  timing fine-tune, slow-down. **Runs as a Shiny module and as a standalone
  HTML page**: `karaoke_export_html()` (or *Download as HTML* in the app)
  writes one offline page with the lyrics, album art and audio;
  `karaoke_export_library()` a searchable catalog of a whole library whose
  songs load when picked.
* **Sing and get scored** (karaoke): turn the original singer down or mute
  them (the centre of the stereo mix, in the voice's range, while lines are
  sung; an AudioWorklet), sing into the microphone, and get scored in real
  time: note by note against the melody where the chart has one, otherwise
  against the notes the singer uses in each line. Pitch lane, live score and
  line ratings, a results card, personal bests saved by R (or the browser, in
  the HTML page). Measured on a synthetic singer: the right melody ~9 850 of
  10 000, wrong notes 2 500–5 700 (`tests/frontend/check_sing.py`).
* **Shuffle**: each start opens a random song (one with lyrics), in the app
  and in the HTML page; Shuffle buttons pick another.
* **Microphone scoring (beta)**: play along on a real guitar or bass. An
  AudioWorklet finds onsets and spectra, and a chart-aware verifier checks
  that the due notes (chords included) actually sounded. You get a results
  card with per-section accuracy, loop-pass scores, latency calibration and
  personal bests saved by R. Keyboard input (D/F/J/K) and `highway_input()`
  from R use the same judge.

```r
renv::install(c("xml2", "openssl")); renv::snapshot()
shiny::runApp()

# karaoke without Shiny: a standalone page (one song, or a songbook)
for (f in list.files("R", full.names = TRUE)) source(f)
karaoke_export_html("songs/Dire-Straits_Sultans-of-Swing_v443_m.psarc", "sultans.html")
karaoke_export_html("songs", "karaoke/index.html", audio_format = "m4a")   # a folder: a standalone karaoke folder
karaoke_export_html("songs", "karaoke/index.html", lyrics_only = TRUE)     # ...only the songs with lyrics in the file
karaoke_export_library("~/Music/Rocksmith", "karaoke/index.html")   # a big library (over 100 songs): a catalog
```

**A standalone karaoke folder.** Give the exporter a folder of `.psarc` files and it
writes one page with every song of the folder, and each song's audio next to it:
`karaoke/index.html` + `karaoke/index_files/<artist-title>.m4a`. Nothing else is
made (no library index, no catalog), up to 100 songs. Open `karaoke/index.html` from
disk, or copy the `karaoke/` folder anywhere: it needs nothing outside itself. Songs
without lyrics in the file are looked up (a `.lrc` next to the file, LRCLIB, or by the
page when it opens); `lyrics_only = TRUE` / `--lyrics-only` lists only the songs whose
lyrics are in the file. The same without R (byte-identical output); with no arguments
it builds `karaoke/` from `songs/`:

```bash
pip install wem2ogg                       # audio decoder (unless vgmstream-cli is installed)
python3 tools/karaoke_export_html.py      # songs/ -> karaoke/index.html + karaoke/index_files/ (m4a)
python3 tools/karaoke_export_html.py ~/Music/Rocksmith -o karaoke/index.html --audio-format m4a --lyrics-only
python3 tools/karaoke_export_html.py --library ~/Music/Rocksmith --serve   # a big library: songs built when opened
```

`karaoke/` in this folder is that build of the sample songs (18 songs, 160 MB of
audio). Opened from disk everything plays; turning the singer's voice down and
aligning lyrics found on the web to the recording read the audio's samples, which a
page opened from disk may not do with files next to it: serve the folder for those
(`python3 -m http.server -d karaoke`). `exports/sing-sampler.html` is the other
kind: one file with 6 songs and their audio inside, everything from disk.

Audio needs `vgmstream-cli` + `ffmpeg` on `PATH`. FFmpeg alone **cannot** decode
`.wem`. The delivery format (Ogg Vorbis, AAC, Opus, FLAC or WAV) is negotiated
from the encoders your FFmpeg has and the formats your browser plays. Without
these tools the highway runs silently.

**Start with [docs/GUIDE.md](docs/GUIDE.md)** (the short guide: run it, use it, what's
where). [docs/IMPLEMENTATION_GUIDE.md](docs/IMPLEMENTATION_GUIDE.md) is the full reference:
the architecture, a step-by-step walkthrough of every module, and verification results.

![How RockShiny works](docs/images/architecture.svg)

## RockShiny Creator: the song-making studio

**[creator/](creator/README.md)** is RockShiny's admin and song-making studio.
You can open any `.psarc` or start a new song from an audio file. Then edit the
beat grid, sections, charts and lyrics on a timeline that works like an audio or
video editor, keep, hand-edit or automatically build the **difficulty levels**,
split the mix into instrument stems, fetch lyrics and sync them to the singing
(a **voice model** finds the sung phrases), **draft the rhythm and bass charts by
ear** or **play any part in with a tuner**, and save a `.psarc` for PC or Mac. The
codec (PSARC, SNG, Wwise audio, DDS) is written in plain JavaScript. That lets the
studio run in Shiny, on its own or inside RockShiny, and as a single offline HTML
file. The `creator/` folder is self-contained: copied anywhere on its own, it runs
with the copy of RockShiny's code it carries (`creator/rockshiny/`), and **Demo
song** opens *Night Drive*, a complete song it composes from scratch:

```r
shiny::runApp("creator")     # on its own (creator/app.R)
shiny::runApp()              # inside RockShiny: the "Creator" page (options(rockshiny.creator = FALSE) leaves it out)
```

New to it? **[The Creator tutorial](creator/TUTORIAL.md)** walks through every task and says plainly
what it can and can't do; in the studio, **?** opens the same Help and a guided tour.

Or open **`creator/RockShinyCreator.html`**, one offline file that needs no
server and no network (rebuild it with `creator_build_html()`). Inside
RockShiny, the same module saves into the library, where RockShiny's own
parsers check the package. *Play it* / *Sing it* then opens the song in the
Instrument or Karaoke mode.

| | |
|---|---|
| ![The studio](creator/docs/screenshots/01-studio.jpg)<br>**The studio**: the mix, each chart as tablature (chords framed and named, sustains, techniques), the lyrics syllable by syllable, sections and the beat grid on one timeline. | ![Chart editing](creator/docs/screenshots/02-chart-editing.jpg)<br>**Chart editing**: draw, move, stretch, erase, quantize, copy and paste, with undo; fret, string, sustain, bend, slide and every technique in the inspector or from the keyboard. |
| ![Song details](creator/docs/screenshots/03-song.jpg)<br>**Song details and charts**: title, artist, album, volumes, album art (any image, stored as the game's DDS); add a lead, rhythm, bass or combo chart in any tuning. | ![Lyrics](creator/docs/screenshots/04-lyrics.jpg)<br>**Lyrics, synced to the recording**: LRCLIB, a `.lrc` file or pasted text become Rocksmith syllables; auto-sync lines them up with the singing, then tap-sync, stretch or drag. |
| ![Stems](creator/docs/screenshots/05-stems.jpg)<br>**Instrument stems**: vocals, guitar, bass, drums and the rest, separated using the song's own charts and lyrics; mute, solo, mix, download as WAV or keep them in the library. | ![Beats](creator/docs/screenshots/06-beats.jpg)<br>**Beats and tempo**: detected from the audio or set from any beat on; drag a beat, set bar starts, ×2 / ÷2, shift the chart, metronome. |
| ![New song](creator/docs/screenshots/07-new-song.jpg)<br>**A new song from an audio file**: mp3, ogg, wav, flac, m4a or `.wem`; details from the file name, beat grid from the audio, empty charts ready to draw in. | ![Save](creator/docs/screenshots/08-save.jpg)<br>**Save for PC or Mac, checked**: unchanged files written back byte for byte, edited charts recompiled, saved into the library and read back by RockShiny's parsers. |
| ![Difficulty levels](creator/docs/screenshots/11-levels.jpg)<br>**Difficulty levels, kept and edited**: any level of a chart on the timeline (what a player at that level plays), with the notes it leaves out as dashed ghosts; add or remove a level for one part of the song or everywhere. | ![Automatic levels](creator/docs/screenshots/12-auto-levels.jpg)<br>**Easier levels, created automatically**: *Create easier levels* makes them from the full chart, strongest beats first, chords on fewer strings; RockShiny's difficulty slider uses them. |
| ![Help](creator/docs/screenshots/13-help.jpg)<br>**Help built in**: what the Creator can do, what it can't, how difficulty levels work, every shortcut (the **?** button or key). | ![Tour](creator/docs/screenshots/14-tour.jpg)<br>**A guided tour**: a spotlight moves over each part of the studio with a card that explains it. |
| ![Lyrics over the voice](creator/docs/screenshots/15-voice-sync.jpg)<br>**Lyrics over the voice**: where someone sings, drawn under the lyrics; *Sync each line* fits lyrics of another take line by line. | ![Draft](creator/docs/screenshots/16-draft.jpg)<br>**A chart drafted by ear**: a chord on every beat heard in the recording, in shapes for the chart's tuning (a rough start: about half right). |
| ![Tuner](creator/docs/screenshots/17-tuner.jpg)<br>**Play it in with the tuner**: your guitar into the microphone; each note or strum goes into the chart at the playhead, or as you play along. | ![In RockShiny](creator/docs/screenshots/09-in-rockshiny.jpg)<br>**A page of RockShiny**: Home · Instrument · Karaoke · Creator, all one app. |
| ![Offline](creator/docs/screenshots/10-offline.jpg)<br>**One offline HTML file**: the whole studio opens from disk. It reads, decodes (Wwise audio included), edits and writes `.psarc` files with no server. | |

**Tested on the 18 sample songs:** every archive re-packs entry for entry;
64 / 64 SNGs serialize back byte for byte; open + save without edits gives
byte-identical files. The XML → SNG compiler matches the community toolkit on
99.986 % of 2.49 M fields. Vocals SNGs (13 / 13) and sound banks (36 / 36)
rebuild byte-identical. Wwise → Ogg is sample-identical to `wem2ogg`. In every
edited, PC ↔ Mac converted and new package, RockShiny's reader finds that the
XML and the SNG agree, and with difficulty levels they also agree at 0, ⅓ and
⅔ difficulty. In all 25 charts that have difficulty levels, viewing any level
and writing it back leaves the stored levels unchanged. The automatic easy level matches the chart authors'
with an F1 of 0.77 on note times, against 0.45 for a random subset of the
same size.

**Lyrics auto-sync**, measured on the 11 sample songs with lyrics (each scored
by a voice model trained without it): median line error 0.08 s, 75 % of lines
within 0.3 s (before: 0.30 s, 48 %).

**Limits:** stems come from chart-guided signal processing, not a neural
model. Drafts by ear are rough (about half of the chords, a third of the bass
notes) and lead parts are played in with the tuner, not drafted. Lyrics sync is
a first pass, so tap-sync or a drag finishes it. Detected beats sometimes need ×2 / ÷2 or a bar start fixed by
hand. Automatic difficulty levels pick which notes to keep; they don't
re-arrange a part into simpler fingerings. New songs
store PCM audio, and those packages have not been tried in the game itself.
The tests, measurements and details are in [creator/README.md](creator/README.md).

<!-- taiga:begin -->
## Feature tour

| | | |
|---|---|---|
| ![Note highway](docs/features/01-highway.jpg)<br>**Note highway** | ![Bass](docs/features/02-bass.jpg)<br>**Bass** | ![Practice loop](docs/features/03-practice-loop.jpg)<br>**Practice loop** |
| ![Piano](docs/features/04-piano.jpg)<br>**Piano** | ![Harmonica](docs/features/05-harmonica.jpg)<br>**Harmonica** | ![HTML/SVG renderer](docs/features/06-html-renderer.jpg)<br>**HTML/SVG renderer** |
| ![Karaoke](docs/features/07-karaoke.jpg)<br>**Karaoke** | ![Karaoke as HTML](docs/features/08-karaoke-html.jpg)<br>**Karaoke as a standalone HTML page** | ![Web lyrics](docs/features/11-web-lyrics-syllables.jpg)<br>**Web lyrics, syllable by syllable** |
| ![Song library](docs/features/09-library.jpg)<br>**Song library folder** | ![Karaoke catalog](docs/features/10-karaoke-catalog.jpg)<br>**A catalog of 827 songs** | ![Home](docs/features/12-home.jpg)<br>**Home** |
| ![Playlist](docs/features/13-playlist.jpg)<br>**Playlist** | ![Opening a song](docs/features/14-loading.jpg)<br>**Opening a song** | ![Singing](docs/features/15-singing.jpg)<br>**Singing, scored** |
| ![Results](docs/features/16-sing-results.jpg)<br>**Results of a sung song** | ![Original voice](docs/features/17-voice.jpg)<br>**The original voice: volume, mute** | |

*Screenshots of the players themselves (test harness, real song data and the songs' own audio). See [docs/DESIGN.md](docs/DESIGN.md#feature-screenshots).* All 17 screenshots, with captions: [docs/DESIGN.md](docs/DESIGN.md).

### Delivery formats

| Format | Status | Entry point |
|---|---|---|
| Shiny | ✓ | `shiny::runApp()` (`app.R`); karaoke: `mod_karaoke_*()`, `karaokeOutput()` |
| Quarto | specified, not yet built | planned `rs_quarto_block(song, …)` |
| HTML | ✓ karaoke; highway specified, not yet built | `karaoke_export_html(songs, file)`, `karaoke_export_library(dir, file)` or `tools/karaoke_export_html.py`; planned `rs_export_html(song, arrangement, instrument)` |
| Creator (studio) | ✓ Shiny (standalone and inside RockShiny) and ✓ offline HTML | `shiny::runApp("creator")`, `mod_creator_ui()` / `mod_creator_server()`; `creator/RockShinyCreator.html` (`creator_build_html()`) |

Design system: **Lumen** (cinematic, high-contrast, glass-driven), from the **taiga** R package in [`../taiga-design-system/`](../taiga-design-system/README.md): styleguide, requirements, tokens and the Shiny · Quarto · HTML delivery model (`taiga::taiga_guide()`, `taiga::taiga_export_html()`…). This project's page is [docs/DESIGN.md](docs/DESIGN.md).

<!-- taiga:end -->

## License

MIT — see [LICENSE.md](LICENSE.md) (the package's `LICENSE` file holds the year and copyright holder, as
`DESCRIPTION`'s `MIT + file LICENSE` requires). Rocksmith archives and their audio are not part of this
license: use only songs you own.
