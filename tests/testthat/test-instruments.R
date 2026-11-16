test_that("harmonica layout: Richter tuning, bends, overblows, keys", {
  c <- harp_layout("C")
  expect_identical(nrow(c), 39L)                      # 20 natural + 12 bends + 4 overblows + 3 overdraws
  nat <- c[c$cost == 0, ]
  expect_true(all(c(60, 62, 64, 67, 71, 72, 74, 76, 77, 79, 81, 83, 84, 86, 88, 89, 91, 93, 96) %in% nat$midi))
  a <- c[c$midi == 69 & c$bend > 0, ]                 # A4 = 3 draw, whole-step bend
  expect_identical(c(a$hole, a$blow, a$bend), c(3L, 0L, 2L))
  expect_identical(sort(c$midi[c$ob == 1L]), c(63L, 75L, 78L, 82L, 85L, 92L, 97L))
  expect_equal(harp_layout("G")$midi, c$midi - 5)
  expect_equal(harp_layout("F#")$midi, c$midi + 6)
})

test_that("harp_choose: best key and octave for a melody", {
  g <- harp_choose(c(67, 69, 71, 72, 74, 76, 78, 79))          # G major scale
  expect_identical(c(g$key, g$octave), c("G", "0"))
  expect_equal(g$unplayable, 0)
  cmaj <- harp_choose(c(60, 62, 64, 65, 67, 69, 71, 72))       # C major, from C4
  expect_identical(cmaj$key, "C")
  expect_identical(cmaj$octave, 1L)                             # no bends needed an octave up
  expect_identical(harp_choose(c(60, 61), key = "C")$key, "C")
})

test_that("melody_line keeps the top note and thins runs", {
  ev <- data.frame(time = c(0, 0, 0, 1, 1.05, 1.1, 2), midi = c(48L, 55L, 64L, 60L, 62L, 64L, 65L),
                   sustain = c(1, 1, 1, 0.5, 0.5, 0.5, 1), chord = -1L)
  m <- melody_line(ev)
  expect_identical(as.integer(m$midi), c(64L, 60L, 62L, 64L, 65L))
  expect_equal(m$sustain[1:3], c(0.98, 0.03, 0.03))   # cut where the next note begins
  t <- melody_line(ev, min_gap = 0.09)
  expect_identical(as.integer(t$midi), c(64L, 60L, 64L, 65L))
})

mini_chart <- function() {
  list(
    meta = list(n_strings = 6L, tuning = rep(-1L, 6), capo = 2L, arrangement = "Lead", title = "T", song_length = 10),
    notes = data.frame(time = c(1, 2, 3, 4, 5, 6), string = c(0L, 5L, 1L, 1L, 2L, 3L), fret = c(0L, 3L, 12L, 7L, 5L, 5L),
                       sustain = c(0, 0, 0, 0, 1, 0.5), slide_to = -1L, slide_unp = -1L, bend = c(0, 0, 0, 0, 2, 1),
                       tech = c(0L, 0L, TECH[["harmonic"]], TECH[["harmonic"]], TECH[["bend"]], TECH[["bend"]]),
                       chord = -1L),
    bends = data.frame(note = c(4L, 4L, 5L, 5L), time = c(5, 5.3, 6, 6.3), step = c(0, 2, 1, 0)),
    chords = data.frame(time = numeric(), template = integer(), name = character(), high_density = logical()),
    beats = data.frame(time = 0:9, measure = c(1L, -1L, -1L, -1L, 2L, -1L, -1L, -1L, 3L, -1L)),
    sections = section_labels(data.frame(name = "verse", time = 0))
  )
}

test_that("sounding pitch of guitar notes: tuning, capo, harmonics", {
  expect_identical(chart_note_midi(mini_chart()),
                   c(41L,            # low E open, Eb tuning, capo 2
                     66L,            # high e fret 3 (frets are absolute)
                     56L,            # A string, 12th-fret harmonic
                     63L,            # A string, 7th-fret harmonic: +19
                     54L, 59L))      # D fret 5; G fret 5 (pre-bend handled in chart_pitch_events)
})

test_that("chart_pitch_events: held bends add their target, pre-bends sound bent", {
  ev <- chart_pitch_events(mini_chart())
  expect_identical(as.integer(ev$midi), c(41L, 66L, 56L, 63L, 54L, 56L, 60L))
  expect_equal(ev$time, c(1, 2, 3, 4, 5, 5.3, 6))
  expect_equal(ev$sustain[5], 0.29)                   # ends where the bend arrives
  expect_equal(ev$sustain[6], 0.7)
})

test_that("piano conversion: octave shift, hands, range", {
  p <- chart_for_instrument(mini_chart(), "piano")
  expect_identical(p$instrument, "piano")
  expect_identical(as.integer(p$notes$hand), c(0L, 1L, 0L, 1L, 0L, 0L, 1L))
  expect_identical(c(p$meta$range_lo, p$meta$range_hi), c(36L, 72L))
  expect_identical(p$meta$arrangement, "Piano \u00b7 Lead")
  expect_null(p$meta$tuning)
  up <- chart_for_instrument(mini_chart(), "piano", octave = 2L)
  expect_identical(as.integer(up$notes$midi), as.integer(p$notes$midi) + 24L)
  j <- jsonlite::fromJSON(as.character(chart_json(p, "k")))
  expect_identical(j$instrument, "piano")
  expect_identical(j$notes$hand, c(0L, 1L, 0L, 1L, 0L, 0L, 1L))
  expect_identical(j$meta$instrument_tag, "Keys C2\u2013C5")
})

test_that("vocal_pitch_events: unpitched or missing lyrics give zero events (no error)", {
  v <- data.frame(time = c(1, 2), length = c(0.5, 0.5), lyric = c("a", "b+"), note = c(254, 254))
  e <- vocal_pitch_events(v)
  expect_identical(nrow(e), 0L)
  expect_identical(names(e), c("time", "midi", "sustain", "chord"))
  expect_identical(nrow(vocal_pitch_events(v[0, ])), 0L)
  expect_identical(nrow(vocal_pitch_events(NULL)), 0L)
  p <- vocal_pitch_events(transform(v, note = c(60, 254)))
  expect_identical(as.integer(p$midi), 60L)
})

# Real songs (values from the Python mirror, tests/reference/instruments_ref.py).
# One test per song, so each runs whenever its song is in songs/.
test_that("real songs convert: Sultans of Swing lead -> harmonica", {
  s <- load_song(need_song("Dire-Straits_Sultans-of-Swing_v443_m.psarc"))
  h <- song_chart(s, "direstraitssultansplum_lead", instrument = "harmonica")
  expect_identical(h$meta$harp_key, "C")
  expect_identical(h$meta$harp_octave, 1L)
  expect_identical(nrow(h$notes), 768L)
  expect_identical(h$meta$harp_thinned, 4L)
  expect_false("vocals" %in% s$arrangements$id)               # Sultans' lyrics are unpitched
})

test_that("real songs convert: Wish You Were Here lead -> piano", {
  w <- load_song(need_song("Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc"))
  p <- song_chart(w, "wishyouwhizzhere_lead", instrument = "piano")
  expect_identical(nrow(p$notes), 1746L)
  expect_identical(c(p$meta$range_lo, p$meta$range_hi), c(36L, 72L))
})

test_that("real songs convert: Get Lucky's pitched vocals -> harmonica", {
  g <- load_song(need_song("DaftPunk_GetLucky_m.psarc"))
  expect_true("vocals" %in% g$arrangements$id)                # pitched lyrics -> melody arrangement
  expect_identical(song_instruments(g, "vocals"), c("piano", "harmonica"))
  v <- song_chart(g, "vocals", instrument = "harmonica")
  expect_identical(v$meta$harp_key, "A")
  expect_identical(nrow(v$notes), 545L)
})
