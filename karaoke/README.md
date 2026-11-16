# karaoke/ — the standalone karaoke folder

Open **`index.html`** in a browser (Chrome, Edge, Firefox, Safari): every song of
`songs/`, with its lyrics and its audio in `index_files/`. No server, no network
and nothing outside this folder is needed: copy the folder anywhere.

Rebuild it (from RockShiny's folder) after adding songs:

```bash
python3 tools/karaoke_export_html.py                                   # songs/ -> karaoke/ (m4a audio)
python3 tools/karaoke_export_html.py ~/Music/Rocksmith -o karaoke/index.html --audio-format m4a
python3 tools/karaoke_export_html.py ~/Music/Rocksmith -o karaoke/index.html --lyrics-only   # only songs with lyrics in the file
```

or from R: `karaoke_export_html("songs", "karaoke/index.html", audio_format = "m4a")`
(`lyrics_only = TRUE` for only the songs with lyrics in the file). Up to 100 songs
in one page; songs already converted are not converted again, and audio files no
song uses any more are removed from `index_files/`.

Opened from disk everything plays. Turning the singer's voice down and aligning
lyrics found on the web to the recording read the audio's samples, which a page
opened from disk may not do with files next to it; for those, serve the folder:
`python3 -m http.server -d karaoke` and open http://localhost:8000/.

Only share the audio of songs you have the rights to.
