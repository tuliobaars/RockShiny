# Extracted from test-lyrics-online.R:87

# setup ------------------------------------------------------------------------
library(testthat)
test_env <- simulate_test_env(package = "RockShiny", path = "..")
attach(test_env, warn.conflicts = FALSE)

# prequel ----------------------------------------------------------------------
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

# test -------------------------------------------------------------------------
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
expect_true(normalizePath(need_song(NO_LYRICS)) %in% karaoke_choices(songs_dir()))
