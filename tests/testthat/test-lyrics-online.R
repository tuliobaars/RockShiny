# Lyrics for songs without lyrics in the archive (R/lyrics_online.R). No network:
# LRCLIB is replaced by a fake `fetch`, the cache by a temporary folder.
NO_LYRICS <- "Carlos-Santana-ft-Chad-Kroeger_Into-The-Night_v2_m.psarc"

fake_lrclib <- function(log = new.env()) {
  log$urls <- character()
  function(url) {
    log$urls <- c(log$urls, url)
    list(
      list(id = 1, trackName = "Into the Night (Live)", artistName = "Santana", duration = 200, instrumental = FALSE,
           plainLyrics = "unsynced"),
      list(id = 2, trackName = "Into the Night", artistName = "Santana", duration = 226, instrumental = FALSE,
           syncedLyrics = "[00:10.00]la la\n[00:14.00]la la la", plainLyrics = "la la"),
      list(id = 3, trackName = "Some Other Song", artistName = "Santana", duration = 226, instrumental = FALSE,
           syncedLyrics = "[00:01.00]no"),
      list(id = 4, trackName = "Into the Night", artistName = "Santana", duration = 226, instrumental = TRUE,
           syncedLyrics = "[00:01.00]instrumental")
    )
  }
}

test_that("parse_lrc(): timestamps, repeated lines, word tags, metadata, plain text", {
  x <- parse_lrc("[ar:Someone]\n[00:10.50][01:10.00]Hello <00:11.00>world\n[00:12.00]Second line\nplain text\n[00:20.00]")
  expect_equal(x$time, c(10.5, 12, 70, NA))
  expect_identical(x$text, c("Hello world", "Second line", "Hello world", "plain text"))
  expect_identical(nrow(parse_lrc("")), 0L)
})

test_that("artist and title variants for the search", {
  expect_identical(lyrics_main_artist("Carlos Santana (ft Chad Kroeger)"), "Carlos Santana")
  expect_identical(lyrics_main_artist("Santana feat. Rob Thomas"), "Santana")
  expect_identical(lyrics_main_artist("B.B. King & Eric Clapton"), "B.B. King")
  expect_identical(lyrics_clean_title("Into The Night (Live)"), "Into The Night")
  expect_identical(lyrics_clean_title("Song [Remastered 2011]"), "Song")
})

test_that("lrclib_search() prefers synced lyrics of the same song and length", {
  log <- new.env()
  hit <- lrclib_search(list(title = "Into The Night", artist = "Carlos Santana (ft Chad Kroeger)", song_length = 225.6),
                       fetch = fake_lrclib(log))
  expect_identical(hit$synced, "line")
  expect_identical(hit$lrc, "[00:10.00]la la\n[00:14.00]la la la")
  expect_identical(hit$url, "https://lrclib.net/api/get/2")
  expect_match(log$urls[1], "^https://lrclib.net/api/search\\?artist_name=Carlos%20Santana")
  expect_null(lrclib_search(list(title = "Into The Night", artist = "x"), fetch = function(u) list()))
})

test_that("lyrics_lookup(): sidecar .lrc, cache, negative cache, offline", {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))
  dir <- withr::local_tempdir()
  f <- file.path(dir, "song.psarc"); writeBin(as.raw(1:10), f)
  meta <- list(title = "Into The Night", artist = "Santana", song_length = 226)
  # online hit -> cached; a later lookup does not ask again
  l <- lyrics_lookup(f, "k1", meta, fetch = fake_lrclib())
  expect_identical(l$source, "lrclib")
  expect_identical(lyrics_lookup(f, "k1", meta, fetch = function(u) stop("no second request"))$lrc, l$lrc)
  # the offset found when syncing is remembered
  lyrics_cache_offset("k1", 1234.4)
  expect_identical(lyrics_lookup(f, "k1", meta, fetch = function(u) stop("cached"))$offset_ms, 1234)
  # not found -> remembered (no new request within a week)
  expect_null(lyrics_lookup(f, "k2", meta, fetch = function(u) list()))
  expect_null(lyrics_lookup(f, "k2", meta, fetch = function(u) stop("negative result is cached")))
  # offline -> not cached
  expect_s3_class(lyrics_lookup(f, "k3", meta, fetch = function(u) stop("cannot open URL")), "lyrics_offline")
  expect_null(lyrics_cache_read("k3"))
  # online lookups can be switched off
  expect_null(lyrics_lookup(f, "k4", meta, online = FALSE, fetch = function(u) stop("offline mode")))
  # a sidecar .lrc wins over everything
  writeLines("[00:05.00]from the file", file.path(dir, "song.lrc"))
  s <- lyrics_lookup(f, "k1", meta, fetch = function(u) stop("sidecar first"))
  expect_identical(s$source, "file")
  expect_true(lyrics_known(f, "k1"))
})

test_that("a song without lyrics in the archive gets them from the lookup (payload with the LRC)", {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))
  k <- load_karaoke_song(need_song(NO_LYRICS), fetch = fake_lrclib())
  expect_identical(nrow(k$vocals), 0L)
  expect_identical(karaoke_lines(k), c("la la", "la la la"))
  j <- jsonlite::fromJSON(karaoke_json(k), simplifyVector = FALSE)
  expect_identical(j$lyrics$source, "lrclib")
  expect_identical(j$lyrics$synced, "line")
  expect_identical(j$lyrics$lrc, "[00:10.00]la la\n[00:14.00]la la la")
  expect_true(j$lyrics$align)
  expect_length(j$vocals$t, 0)
  # now known: listed with the songs that have lyrics
  expect_true(normalizePath(need_song(NO_LYRICS)) %in% karaoke_choices(songs_dir()))
})

test_that("without lyrics anywhere: a clear error, or a page that looks them up in the browser", {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))
  f <- need_song(NO_LYRICS)
  expect_error(load_karaoke_song(f, fetch = function(u) list()), "none were found online")
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir()))
  expect_error(load_karaoke_song(f, fetch = function(u) stop("offline")), "could not be reached")
  k <- load_karaoke_song(f, online = FALSE, allow_missing = TRUE)
  j <- jsonlite::fromJSON(karaoke_json(k), simplifyVector = FALSE)
  expect_identical(j$lyrics$source, "lookup")
  expect_identical(j$lyrics$lookup$title, "Into The Night")
  expect_true(normalizePath(f) %in% karaoke_choices_online(songs_dir()))
})
