# The Creator's R tests: testthat::test_dir("creator/tests/testthat") from the RockShiny
# folder (or "tests/testthat" from creator/). Loads RockShiny's R/ and the Creator's R/.
# RockShiny's code: the project above creator/, or (creator/ on its own) the bundled copy.
creator_root <- normalizePath(test_path("..", ".."), winslash = "/")
rockshiny_root <- local({
  parent <- normalizePath(file.path(creator_root, ".."), winslash = "/")
  if (file.exists(file.path(parent, "R", "psarc.R"))) parent else file.path(creator_root, "rockshiny")
})
local({
  old <- setwd(creator_root)
  on.exit(setwd(old))
  options(rockshiny.root = rockshiny_root, rockshiny.creator.root = creator_root,
          rockshiny.cache_dir = file.path(tempdir(), "rsc-cache"), rockshiny.lyrics_online = FALSE)
  sys.source("global.R", envir = globalenv())
})
# the sample songs: RockShiny's songs/ (not part of creator/: those tests skip without it)
songs_dir <- function() file.path(creator_root, "..", "songs")
need_song <- function(name) {
  f <- file.path(songs_dir(), name)
  skip_if_not(file.exists(f), paste(name, "is not in songs/"))
  f
}
node <- Sys.which("node")
skip_if_no_node <- function() skip_if(!nzchar(node), "node is not installed")
engine <- function(...) {
  out <- system2(node, c(shQuote(file.path(creator_root, "tests", "js", "cli.js")), vapply(c(...), shQuote, "")), stdout = TRUE, stderr = TRUE)
  if (!is.null(attr(out, "status")) && attr(out, "status") != 0) stop(paste(out, collapse = "\n"))
  out
}

# Without the sample songs (creator/ on its own) the demo song stands in: the engine makes
# it from scratch ("Night Drive": 3 charts and lyrics; "dd": the same with difficulty levels).
.fixtures <- new.env()
demo_song <- function(kind = c("plain", "dd")) {
  kind <- match.arg(kind)
  if (!is.null(.fixtures[[kind]]) && file.exists(.fixtures[[kind]])) return(.fixtures[[kind]])
  skip_if_no_node()
  f <- file.path(tempdir(), if (kind == "dd") "RockShiny-Demo_Night-Drive_v1_DD_m.psarc" else "RockShiny-Demo_Night-Drive_v1_m.psarc")
  if (kind == "plain") engine("demo", f, "mac") else engine("dd-auto", demo_song("plain"), f, "4")
  .fixtures[[kind]] <- f
  f
}
song_or_demo <- function(name, kind = "plain") {
  f <- file.path(songs_dir(), name)
  if (file.exists(f)) f else demo_song(kind)
}
