test_that("lyrics: '+' ends a line, '-' joins syllables", {
  v <- data.frame(time = c(1, 1.3, 1.6, 3, 3.2), length = 0.2,
                  lyric = c("Like", "the", "le-", "gend+", "Hmm+"), stringsAsFactors = FALSE)
  l <- vocals_lines(v)
  expect_identical(l$text, c("Like", "the", "le", "gend", "Hmm"))
  expect_identical(l$join, c(FALSE, FALSE, TRUE, FALSE, FALSE))
  expect_identical(l$line, c(0L, 0L, 0L, 0L, 1L))
})

test_that("lyrics without '+' markers break at pauses and after 8 words", {
  v <- data.frame(time = c(0:9 * 0.3, 10, 10.3), length = 0.1, lyric = paste0("w", 1:12), stringsAsFactors = FALSE)
  l <- vocals_lines(v)
  expect_identical(l$line, c(rep(0L, 8), 1L, 1L, 2L, 2L))
})

test_that("vocals XML and SNG agree for every song with lyrics", {
  skip_if_no_songs()
  n <- 0
  for (f in sample_songs()) {
    arc <- psarc_open(f)
    x <- psarc_find(arc, "^songs/arr/.*_vocals\\.xml$")
    s <- psarc_find(arc, "^songs/bin/.*_vocals\\.sng$")
    if (!length(x) || !length(s)) next
    vx <- parse_vocals_xml(psarc_read(arc, x[1]))
    vs <- parse_vocals_sng(sng_decrypt(psarc_read(arc, s[1])))
    expect_equal(round(vs$time, 3), round(vx$time, 3), info = basename(f))
    expect_identical(vs$lyric, vx$lyric, info = basename(f))
    n <- n + 1
  }
  # every song that has both (13 in the full 18-song library) was compared
  skip_if(n == 0L, "no song in songs/ has both a vocals XML and a vocals SNG")
  expect_gt(n, 0)
})

test_that("tuning names", {
  expect_identical(tuning_name(rep(0, 6)), "E Standard")
  expect_identical(tuning_name(rep(-1, 6)), "Eb Standard")
  expect_identical(tuning_name(c(-2, 0, 0, 0, 0, 0)), "Drop D")
  expect_identical(tuning_name(c(-7, -5, -5, -5, -5, -5)), "Drop A")
  expect_identical(tuning_name(c(0, 0, 0, 0), 4L), "E Standard")
  expect_identical(tuning_name(c(-2, 0, 0, -1, 0, 0)), "D A D F# B E")
})

test_that("section labels number only repeated names", {
  s <- section_labels(data.frame(name = c("intro", "verse", "chorus", "verse", "noguitar"), time = 1:5,
                                 number = c(1, 1, 1, 2, 1), stringsAsFactors = FALSE))
  expect_identical(s$label, c("Intro", "Verse 1", "Chorus", "Verse 2", "No guitar"))
})

test_that("difficulty: fewer notes at lower difficulty, XML and SNG agree", {
  song <- load_song(need_song("Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc"))
  n <- vapply(c(0, 0.5, 0.8, 1), function(d) nrow(song_chart(song, "wishyouwhizzhere_lead", difficulty = d)$notes), numeric(1))
  expect_equal(n, c(178, 611, 1489, 1742))          # cross-checked with the Python reference
  x <- song_chart(song, "wishyouwhizzhere_lead", source = "xml", difficulty = 0.5)
  s <- song_chart(song, "wishyouwhizzhere_lead", source = "sng", difficulty = 0.5)
  expect_identical(x$notes$fret, s$notes$fret)
  expect_equal(round(x$notes$time, 3), round(s$notes$time, 3))
})

test_that("chart_json carries lyrics, art and section labels", {
  song <- load_song(need_song("DaftPunk_GetLucky_m.psarc"))
  j <- jsonlite::fromJSON(chart_json(song_chart(song, "getluckydaftpunk_lead"), song$key,
                                     vocals = song_vocals(song), art = song_album_art(song)))
  expect_length(j$vocals$t, 545)
  expect_identical(max(j$vocals$l) + 1L, 87L)
  expect_identical(rawToChar(jsonlite::base64_dec(j$art)[1:4]), "DDS ")
  expect_true("Post-chorus 1" %in% j$sections$label)
})
