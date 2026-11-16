# The strongest available check: XML and SNG are independent encodings of the
# same chart, so after the Dynamic-Difficulty merge they must agree note for note.
test_that("XML and SNG charts agree for every arrangement", {
  skip_if_no_songs()
  for (f in sample_songs()) {
    song <- load_song(f)
    for (id in song$arrangements$id) {
      a <- song$arrangements[song$arrangements$id == id, ]
      skip_if(is.na(a$xml) || is.na(a$sng))
      x <- song_chart(song, id, source = "xml")
      s <- song_chart(song, id, source = "sng")
      info <- paste(basename(f), id)
      expect_equal(nrow(x$notes), nrow(s$notes), info = info)
      expect_equal(round(x$notes$time, 3), round(s$notes$time, 3), info = info)
      expect_identical(x$notes$string, s$notes$string, info = info)
      expect_identical(x$notes$fret, s$notes$fret, info = info)
      expect_identical(x$notes$tech, s$notes$tech, info = info)
      expect_identical(x$notes$slide_to, s$notes$slide_to, info = info)
      expect_equal(nrow(x$chords), nrow(s$chords), info = info)
      expect_equal(nrow(x$anchors), nrow(s$anchors), info = info)
    }
  }
})

test_that("Wish You Were Here lead (7 DD levels) collapses to the known max-difficulty chart", {
  ch <- song_chart(load_song(need_song("Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc")), "wishyouwhizzhere_lead")
  expect_equal(nrow(ch$notes), 1742)    # values cross-checked against the SNG
  expect_equal(nrow(ch$chords), 296)
  expect_equal(nrow(ch$anchors), 68)
  expect_false(is.unsorted(ch$notes$time))
  expect_true(all(ch$notes$chord < nrow(ch$chords)))
})

test_that("chart_json keeps arrays for 1-element columns and unboxes metadata", {
  raw <- list(
    meta = list(title = "T", song_length = 10, tuning = rep(0L, 6), is_bass = FALSE),
    beats = data.frame(time = 0, measure = 1L),
    sections = data.frame(name = "intro", time = 0),
    phrases = data.frame(max_difficulty = 0L, name = "p"),
    phrase_iterations = data.frame(time = 0, phrase_id = 0L),
    templates = list(name = character(0), frets = matrix(integer(0), 0, 6)),
    notes = transform(empty_notes()[NA_integer_, ], level = 0L, time = 1.5, string = 2L, fret = 5L,
                      sustain = 0, slide_to = -1L, slide_unp = -1L, bend = 0, tech = 0L, chord_key = NA_integer_),
    chords = empty_chords(),
    anchors = data.frame(level = 0L, time = 0, fret = 3L, width = 4)
  )
  j <- jsonlite::fromJSON(chart_json(build_chart(raw), "k"), simplifyVector = FALSE)
  expect_identical(j$meta$title, "T")
  expect_length(j$meta$tuning, 6)
  expect_type(j$notes$t, "list")          # still an array with one element
  expect_equal(j$notes$t[[1]], 1.5)
  expect_equal(j$notes$chord[[1]], -1)
})

test_that("Key to the Highway lead (14 DD levels, file name with spaces/&) parses", {
  song <- load_song(need_song("B_B_ King & Eric Clapton - Key to the Highway_m.psarc"))
  ch <- song_chart(song, "sirbbkeckeytothehighway_lead")
  expect_equal(c(nrow(ch$notes), nrow(ch$chords), nrow(ch$anchors)), c(475, 58, 69))
  expect_identical(song$arrangements$label, c("Lead", "Rhythm", "Bass"))
})
