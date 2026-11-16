# The home screen's data (R/home.R): catalog, playlists, recently played, genres.

local_home <- function(env = parent.frame()) {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.config_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.data_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.genres_online = FALSE), .local_envir = env)
}

test_that("home_catalog(): every song with artist, album, lyrics state and a stable id", {
  skip_if_no_songs()
  local_home()
  cat <- home_catalog(library_open(songs_dir()))
  expect_true(all(c("id", "path", "title", "artist", "album", "year", "length", "lyrics", "kind", "source", "genre") %in% names(cat)))
  expect_true(all(nchar(cat$id) == 12L))
  expect_false(any(duplicated(cat$id)))
  expect_identical(cat$id, song_id(cat$path))
  expect_true(all(cat$lyrics[cat$kind == "psarc"] %in% c("archive", "web")))
  s <- cat[basename(cat$path) == "Dire-Straits_Sultans-of-Swing_v443_m.psarc", ]
  if (nrow(s)) {
    expect_identical(s$lyrics, "archive")
    expect_identical(s$album, "Money for Nothing")
  }
  n <- cat[basename(cat$path) == "Carlos-Santana-ft-Chad-Kroeger_Into-The-Night_v2_m.psarc", ]
  if (nrow(n)) expect_identical(n$lyrics, "web")
  expect_true("examples" %in% cat$source)                     # the MIDI demo is offered too
  expect_identical(cat$lyrics[cat$kind == "midi"][1], "")
  j <- home_catalog_json(cat)
  expect_identical(length(j$id), nrow(cat))
})

test_that("playlists: create, add, move, remove, rename, delete; kept in the data folder", {
  local_home()
  a <- file.path(withr::local_tempdir(), c("a.psarc", "b.psarc", "c.psarc"))
  for (f in a) writeBin(as.raw(1:4), f)
  id <- playlist_create("Road trip", a[1:2])
  expect_match(id, "^pl[0-9a-f]{8}$")
  p <- playlists_read()
  expect_length(p, 1L)
  expect_identical(p[[1]]$name, "Road trip")
  expect_identical(vapply(p[[1]]$songs, function(e) e$path, ""), a[1:2])
  playlist_add(id, a[3])
  playlist_move(id, 3, 1)
  expect_identical(vapply(playlists_read()[[1]]$songs, function(e) e$path, ""), a[c(3, 1, 2)])
  playlist_remove(id, 2)
  expect_identical(vapply(playlists_read()[[1]]$songs, function(e) e$path, ""), a[c(3, 2)])
  playlist_rename(id, "  Night drive ")
  expect_identical(playlists_read()[[1]]$name, "Night drive")
  id2 <- playlist_create("")
  expect_identical(playlists_read()[[2]]$name, "My playlist #2")
  playlist_delete(id)
  expect_identical(vapply(playlists_read(), function(q) q$id, ""), id2)
  expect_true(file.exists(file.path(getOption("rockshiny.data_dir"), "playlists.json")))
  expect_error(playlist_rename("nope", "x"), "no playlist")
})

test_that("a playlist finds a moved song again by artist and title", {
  local_home()
  cat <- data.frame(id = c("i1", "i2"), path = c("/new/place/x.psarc", "/y.psarc"), title = c("Sultans of Swing", "Other"),
                    artist = c("Dire Straits", "Someone"), stringsAsFactors = FALSE)
  q <- list(songs = list(list(path = "/old/place/x.psarc", title = "Sultans of Swing", artist = "Dire Straits"),
                         list(path = "/y.psarc", title = "Other", artist = "Someone"),
                         list(path = "/gone.psarc", title = "Gone", artist = "Nobody")))
  expect_identical(playlist_resolve(q, cat), c("/new/place/x.psarc", "/y.psarc", NA))
})

test_that("recently played: newest first, no repeats, at most 100", {
  local_home()
  for (i in 1:3) history_add(paste0("/s", i, ".psarc"), "karaoke")
  history_add("/s1.psarc", "instrument")
  h <- history_read()
  expect_identical(vapply(h, function(e) e$path, ""), c("/s1.psarc", "/s3.psarc", "/s2.psarc"))
  expect_identical(h[[1]]$mode, "instrument")
  for (i in 1:120) history_add(paste0("/t", i, ".psarc"), "instrument")
  expect_length(history_read(), HISTORY_MAX)
})

test_that("genres: by hand per artist and per song, found online per artist (MusicBrainz, faked)", {
  local_home()
  expect_identical(genre_from_tags(c("british", "classic rock", "rock")), "Classic Rock")
  expect_identical(genre_from_tags(c("seen live", "blues")), "Blues")
  expect_true(is.na(genre_from_tags(c("seen live", "british"))))
  seen <- character()
  fake <- function(url) {
    seen <<- c(seen, url)
    list(artists = list(
      list(name = "Dire Straits Tribute", score = 85, tags = list(list(name = "pop", count = 9))),
      list(name = "Dire Straits", score = 100, tags = list(list(name = "rock", count = 5), list(name = "classic rock", count = 12)))))
  }
  expect_identical(genre_lookup_artist("Dire Straits", fetch = fake), "Classic Rock")
  expect_match(seen[1], "musicbrainz.org/ws/2/artist/\\?query=artist%3A%22Dire%20Straits%22", fixed = FALSE)
  expect_identical(genre_lookup_artist("Carlos Santana (ft Chad Kroeger)", fetch = function(u) {
    expect_match(u, "Carlos%20Santana%22")                       # searched without "(ft ...)"
    list(artists = list(list(name = "Carlos Santana", score = 100, tags = list(list(name = "latin rock", count = 3)))))
  }), "Latin")
  expect_identical(genre_of(c("Dire Straits", "Carlos Santana (ft Chad Kroeger)", "Nobody"), c("/a", "/b", "/c")),
                   c("Classic Rock", "Latin", NA))
  expect_length(genres_missing(c("Dire Straits", "Nobody")), 1L)  # looked up already: not again
  genre_set_artist("Dire Straits", "Rock")                        # by hand wins
  genre_set_song("/b", "Blues")
  expect_identical(genre_of(c("Dire Straits", "Carlos Santana (ft Chad Kroeger)"), c("/a", "/b")), c("Rock", "Blues"))
  genre_set_artist("dire straits ", "")
  expect_identical(genre_of("Dire Straits", "/a"), "Classic Rock")
  # network errors are not cached
  expect_error(genre_lookup_artist("Nobody", fetch = function(u) stop("cannot open URL")))
  expect_null(genres_online_cache()[["nobody"]])
})

test_that("home_user_json(): playlists as song ids, recently played, genres", {
  skip_if_no_songs()
  local_home()
  cat <- home_catalog(library_open(songs_dir()))
  id <- playlist_create("Mix", c(cat$path[2], "/not/there.psarc", cat$path[1]))
  history_add(cat$path[1], "karaoke")
  genre_set_artist(cat$artist[1], "Blues")
  u <- home_user_json(cat, created = list(token = "t1", id = id))
  expect_identical(u$playlists[[1]]$songs, list(cat$id[2], NA_character_, cat$id[1]))
  expect_identical(u$playlists[[1]]$missing[[2]]$title, "there")
  expect_identical(u$recent[[1]]$id, cat$id[1])
  expect_identical(u$artistGenres[[artist_key(cat$artist[1])]], "Blues")
  expect_identical(u$created$id, id)
  js <- jsonlite::toJSON(u, auto_unbox = TRUE, null = "null", na = "null")
  expect_match(as.character(js), '"songs":\\[')
})

test_that("uploads are kept and offered in both modes", {
  skip_if_no_songs()
  local_home()
  f <- sample_songs()[1]
  tmp <- file.path(withr::local_tempdir(), "0.psarc")                  # Shiny's upload name
  file.copy(f, tmp)
  p <- library_store_upload(tmp, basename(f))
  expect_identical(basename(p), basename(f))
  expect_identical(library_store_upload(tmp, basename(f)), p)           # the same file: kept once
  other <- file.path(withr::local_tempdir(), "1.psarc"); file.copy(sample_songs()[2], other)
  p2 <- library_store_upload(other, basename(f))                        # same name, other content
  expect_false(identical(p2, p))
  lib <- library_open(withr::local_tempdir())                           # an empty library folder
  ch <- library_instrument_choices(lib)
  expect_true(all(c(p, p2) %in% unlist(ch$Uploaded)))
  expect_true(library_has(lib, p))
  g <- karaoke_groups(lib)
  expect_true(p %in% c(g$with, g$online))
  expect_false(p %in% c(karaoke_groups(lib, extra = FALSE)$with))
})
