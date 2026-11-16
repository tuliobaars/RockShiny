# A hand-made format-1 file: conductor track (120 bpm, 3/4, a "Verse" marker and a
# tempo change to 60 bpm at tick 192) + a harmonica track (GM program 22) whose notes
# use running status, velocity-0 note-ons and an explicit note-off.
small_midi <- function() hex_to_raw(paste0(
  "4d546864000000060001000200604d54726b0000002d00ff510307a12000ff58040302180800ff030554656d706f8140ff5103",
  "0f424000ff0605566572736500ff2f004d54726b0000002200c01600903c64603c00003e6460803e400090406460400000416460",
  "410000ff2f00"))

test_that("read_midi: tempo map, running status, note-offs, meta events", {
  m <- read_midi(small_midi())
  expect_identical(m$format, 1)
  expect_identical(m$division, 96)
  expect_length(m$tracks, 2L)
  expect_identical(m$tracks[[1]]$name, "Tempo")
  n <- m$tracks[[2]]$notes
  expect_identical(as.integer(n$midi), c(60L, 62L, 64L, 65L))
  expect_equal(n$time, c(0, 0.5, 1, 2))             # 120 bpm until tick 192, then 60 bpm
  expect_equal(n$sustain, c(0.5, 0.5, 1, 1))
  expect_equal(m$length, 3)
  expect_equal(m$markers$time, 1)
  expect_identical(m$markers$text, "Verse")
  expect_equal(m$time_sigs$nn, 3)
  expect_equal(m$time_sigs$dd, 4)
})

test_that("MIDI parts, beats and sections", {
  m <- read_midi(small_midi())
  p <- midi_parts(m)
  expect_identical(nrow(p), 1L)
  expect_identical(p$label, "Harmonica")
  expect_identical(p$instrument, "harmonica")       # GM program 23 (0-based 22)
  b <- midi_beats(m)
  expect_equal(b$time, c(0, 0.5, 1, 2, 3))
  expect_identical(as.integer(b$measure), c(1L, -1L, -1L, 2L, -1L))   # 3/4: downbeats every 3 beats
  s <- midi_sections(m, b)
  expect_identical(s$label, "Verse")
  expect_equal(s$time, 1)
})

test_that("a MIDI file loads as a song and converts to harmonica / piano", {
  f <- tempfile(fileext = ".mid")
  on.exit(unlink(f))
  writeBin(small_midi(), f)
  s <- load_song(f, "small test.mid")
  expect_identical(s$kind, "midi")
  expect_identical(s$meta$title, "small test")
  expect_identical(song_instruments(s, s$arrangements$id[1]), c("piano", "harmonica"))
  h <- song_chart(s, instrument = "harmonica", harp_key = "C")
  expect_identical(h$instrument, "harmonica")
  expect_identical(h$meta$harp_octave, 1L)            # the harp's full scale lives an octave up
  expect_identical(as.integer(h$notes$hole), c(4L, 4L, 5L, 5L))
  expect_identical(as.integer(h$notes$blow), c(1L, 0L, 1L, 0L))
  js <- jsonlite::fromJSON(as.character(chart_json(h, "k")))
  expect_identical(js$instrument, "harmonica")
  expect_identical(js$notes$hole, c(4L, 4L, 5L, 5L))
  p <- song_chart(s, instrument = "piano")
  expect_identical(as.integer(p$notes$midi), c(60L, 62L, 64L, 65L))
  expect_identical(as.integer(p$notes$hand), c(1L, 1L, 1L, 1L))
  expect_null(song_vocals(s))
  expect_null(song_album_art(s))
})

test_that("SMPTE time division and non-MIDI input", {
  clock <- midi_clock(data.frame(tick = numeric(), type = integer(), v1 = numeric(), v2 = numeric(), text = character()),
                      0xE728)                          # -25 fps, 40 ticks per frame
  expect_equal(clock(1000), 1)
  expect_error(read_midi(charToRaw("RIFF....WAVEfmt ")), "Standard MIDI")
})

test_that("the bundled demo (Ode to Joy) has piano parts, a combined part and a harmonica part", {
  dir <- tryCatch(asset_dir("examples"), error = function(e) "")
  f <- file.path(dir, "ode-to-joy-demo.mid")
  skip_if_not(file.exists(f), "inst/examples/ode-to-joy-demo.mid missing (python3 tests/reference/make_demo_midi.py)")
  s <- load_song(f)
  expect_identical(s$arrangements$label, c("Piano (all parts)", "Piano left hand", "Piano right hand", "Harmonica"))
  expect_identical(as.integer(s$arrangements$n_notes), c(126L, 64L, 62L, 62L))
  expect_equal(s$meta$song_length, 38.34)
  expect_identical(s$sections$label, c("Theme 1", "Bridge", "Theme 2"))
  p <- song_chart(s, "piano_all", instrument = "piano")
  expect_identical(nrow(p$notes), 126L)
  expect_identical(c(p$meta$range_lo, p$meta$range_hi), c(36L, 84L))
  h <- song_chart(s, s$arrangements$id[4], instrument = "harmonica")
  expect_identical(h$meta$harp_key, "C")
  expect_identical(h$meta$harp_dropped, 0L)
  expect_identical(nrow(h$notes), 62L)
})
