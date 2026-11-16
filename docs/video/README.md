# RockShiny videos

| File | What | Length |
|---|---|---|
| [`rockshiny-teaser.mp4`](rockshiny-teaser.mp4) | The whole project in about a minute: the home page, the 3-D highway, piano, karaoke, then the Creator (timeline, editing, difficulty levels, stems, lyrics, save and play) and the offline file | ~1 min |
| [`creator-tour.mp4`](creator-tour.mp4) | A guided tour of the Creator: Help and the built-in tour, opening a song, the timeline, editing notes, difficulty levels, lyrics, stems, a new song from an audio file, saving and playing in RockShiny, the offline file, and what it can't do | ~2 min |
| `*-poster.jpg` | A still from each, for links and previews | |

Both videos are 1920 × 1080, 30 fps, H.264 + AAC. They have no narration:
captions are shown in the picture, and the sound is an original music bed.

**How they are made.** Everything is recorded from the real apps in headless
Chromium, with no editing by hand:

- [`tools/video/make_videos.py`](../../tools/video/make_videos.py) starts the
  Creator and RockShiny on a scratch copy of the sample songs, drives them, and
  records DevTools screencast frames. Waiting (saving, stem separation, lyrics
  sync) is cut out.
- [`tools/video/record.py`](../../tools/video/record.py) draws the captions, the
  pointer and click ripples, and the key badges in the page, then assembles the
  clips with ffmpeg.
- [`tools/video/card.html`](../../tools/video/card.html) provides the title
  cards.
- [`tools/video/music.py`](../../tools/video/music.py) synthesises the music from
  scratch (A minor, Am–F–C–G, drums, bass, pads, arpeggio), so no third-party
  music is used.

```bash
python3 tools/video/make_videos.py            # both (about 20 minutes)
python3 tools/video/make_videos.py teaser     # or one of them
```

The songs on screen are the sample songs in `songs/`, and their audio is not
part of the videos. Share the videos only in ways that respect the rights of the
songs shown.
