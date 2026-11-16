# Always source the app's current R/ files into the test environment. (Do not
# skip when functions already exist: a previous run in the same R session
# would otherwise leave stale definitions in the global environment.)
options(rockshiny.root = normalizePath(test_path("..", "..")))   # project root (tests run in tests/testthat)
if (!"RockShiny" %in% loadedNamespaces()) {
  for (f in list.files(test_path("..", "..", "R"), pattern = "[.]R$", full.names = TRUE)) {
    sys.source(f, envir = environment(), keep.source = FALSE)
  }
}
songs_dir <- function() test_path("..", "..", "songs")
sample_songs <- function() list.files(songs_dir(), pattern = "\\.psarc$", full.names = TRUE)
skip_if_no_songs <- function() skip_if(length(sample_songs()) == 0L, "no sample .psarc files in songs/")
#' Path of a named sample song; skips the test (with the song's name) when it is
#' not in songs/ -- the tests run on whatever part of the library is present.
need_song <- function(name) {
  f <- file.path(songs_dir(), name)
  skip_if_not(file.exists(f), paste(name, "is not in songs/"))
  f
}
