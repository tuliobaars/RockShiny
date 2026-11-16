SULTANS <- "Dire-Straits_Sultans-of-Swing_v443_m.psarc"
NO_LYRICS <- "Carlos-Santana-ft-Chad-Kroeger_Into-The-Night_v2_m.psarc"

test_that("lyrics_present() needs at least one real syllable", {
  expect_false(lyrics_present(NULL))
  expect_false(lyrics_present(data.frame(time = 1, length = 1, lyric = c("+"), stringsAsFactors = FALSE)))
  expect_false(lyrics_present(data.frame(time = 1:2, length = 1, lyric = c(" -", NA), stringsAsFactors = FALSE)))
  expect_true(lyrics_present(data.frame(time = 1, length = 1, lyric = "la+", stringsAsFactors = FALSE)))
})

test_that("the karaoke library lists only songs with lyrics", {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))   # no lyrics found online before
  sultans <- need_song(SULTANS)
  no_lyrics <- need_song(NO_LYRICS)
  expect_true(song_has_lyrics(sultans))
  expect_false(song_has_lyrics(no_lyrics))
  expect_false(song_has_lyrics(tempfile(fileext = ".psarc")))          # missing file
  expect_false(song_has_lyrics(file.path(songs_dir(), "x.mid")))
  ch <- karaoke_choices(songs_dir())
  expect_true(normalizePath(sultans) %in% ch)
  expect_false(normalizePath(no_lyrics) %in% ch)
  expect_true(all(vapply(unname(ch), song_has_lyrics, logical(1))))
  expect_identical(names(ch)[ch == normalizePath(sultans)], "Dire Straits \u2014 Sultans of Swing")
})

test_that("load_karaoke_song() reads lyrics, metadata and sections, without a chart", {
  f <- need_song(SULTANS)
  k <- load_karaoke_song(f)
  expect_s3_class(k, "rs_karaoke_song")
  expect_identical(k$key, unname(tools::md5sum(f)))   # shared with the audio cache
  expect_identical(k$meta$title, "Sultans of Swing")
  expect_identical(k$meta$artist, "Dire Straits")
  expect_identical(k$meta$year, "1988")
  expect_equal(k$meta$song_length, 345.999, tolerance = 1e-6)
  expect_identical(nrow(k$vocals), 267L)                               # cross-checked with karaoke_ref.py
  expect_identical(length(unique(k$vocals$line)), 30L)
  expect_identical(karaoke_lines(k)[1:2], c("You get a shiver in the dark", "It's raining in the park but meantime"))
  expect_identical(nrow(k$sections), 41L)
  expect_identical(k$sections$label[1:3], c("Intro", "Verse 1", "Verse 2"))
  expect_false(is.unsorted(k$sections$time))
  expect_identical(rawToChar(jsonlite::base64_dec(k$art)[1:4]), "DDS ")
})

test_that("songs without lyrics and other files are refused with a clear message", {
  expect_error(load_karaoke_song(tempfile(), "song.mid"), "needs a Rocksmith .psarc")
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))
  expect_error(load_karaoke_song(need_song(NO_LYRICS), online = FALSE), "has no lyrics")
})

test_that("karaoke_json() carries the lyrics columns, metadata and sections", {
  k <- load_karaoke_song(need_song(SULTANS))
  j <- jsonlite::fromJSON(karaoke_json(k), simplifyVector = FALSE)
  expect_identical(j$format, "rockshiny-karaoke/1")
  expect_identical(j$songKey, k$key)
  expect_identical(j$meta$title, "Sultans of Swing")
  n <- nrow(k$vocals)
  for (col in c("t", "d", "w", "j", "l")) expect_length(j$vocals[[col]], n)
  expect_identical(unlist(j$vocals$w)[1:3], c("You", "get", "a"))
  expect_equal(unlist(j$vocals$t)[1], 16.159)
  expect_identical(as.integer(unlist(j$vocals$l))[n], 29L)
  expect_length(j$sections$label, 41)
  expect_null(j$audio)
  j2 <- jsonlite::fromJSON(karaoke_json(k, audio = list(src = "a/b.ogg", type = "audio/ogg")), simplifyVector = FALSE)
  expect_identical(j2$audio$src, "a/b.ogg")
  # a one-syllable song still gets arrays (the JS also accepts scalars)
  k1 <- k
  k1$vocals <- k$vocals[1, , drop = FALSE]
  expect_match(as.character(karaoke_json(k1)), '"w":["You"]', fixed = TRUE)
})

test_that("karaoke_export_html() writes a standalone page (lyrics only, and with embedded audio)", {
  f <- need_song(SULTANS)
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))
  k <- load_karaoke_song(f)
  out <- file.path(withr::local_tempdir(), "sultans.html")
  karaoke_export_html(k, out, audio = "none")
  html <- paste(readLines(out, encoding = "UTF-8", warn = FALSE), collapse = "\n")
  expect_match(html, "<title>Sultans of Swing \u2014 karaoke</title>", fixed = TRUE)
  expect_match(html, '<script type="application/json" id="rs-karaoke-data">', fixed = TRUE)
  expect_match(html, "RSKaraoke.KaraokePlayer", fixed = TRUE)                       # player inlined
  expect_false(grepl("{{", html, fixed = TRUE))                                     # all placeholders filled
  data <- sub('.*<script type="application/json" id="rs-karaoke-data">(.*?)</script>.*', "\\1", html)
  expect_false(grepl("<", data, fixed = TRUE))                                      # "<" escaped as \u003c
  d <- jsonlite::fromJSON(data, simplifyVector = FALSE)
  expect_identical(d$songs[[1]]$meta$title, "Sultans of Swing")
  # embedded audio: the cached conversion (a stand-in file here) as a base64 <script>
  dir.create(k$cache_dir, recursive = TRUE, showWarnings = FALSE)
  writeBin(as.raw(c(0x4f, 0x67, 0x67, 0x53, 1:60)), file.path(k$cache_dir, "audio.ogg"))
  karaoke_export_html(k, out)
  html <- paste(readLines(out, warn = FALSE), collapse = "\n")
  expect_match(html, '<script type="text/plain" id="rs-karaoke-audio-1">T2dnUw', fixed = TRUE)
  expect_match(html, '"audio":{"embed":"rs-karaoke-audio-1","type":"audio/ogg"}', fixed = TRUE)
  # sidecar files
  karaoke_export_html(list(k), out, audio = "files")
  expect_true(file.exists(file.path(sub("\\.html$", "_files", out), "dire-straits-sultans-of-swing.ogg")))
})

test_that("template filling is literal and inlined scripts cannot close their <script>", {
  expect_identical(karaoke_fill("a {{X}} b {{X}}", "{{X}}", "\\1 $& \\\\"), "a \\1 $& \\\\ b {{X}}")
  expect_identical(karaoke_json_for_html('{"w":"</script>"}'), '{"w":"\\u003c/script>"}')
  expect_error(karaoke_fill("abc", "{{Y}}", ""), "not found")
})
