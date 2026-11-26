# The song library (R/library.R): index, lazy opening of big folders, karaoke
# grouping, the library folder setting, and catalogs (karaoke_export_library()).

local_library <- function(env = parent.frame()) {
  withr::local_options(list(rockshiny.cache_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.config_dir = withr::local_tempdir(.local_envir = env),
                            rockshiny.data_dir = withr::local_tempdir(.local_envir = env)), .local_envir = env)
}

test_that("library_guess(): artist and title from file names", {
  g <- library_guess(c("x/B_B_ King & Eric Clapton - Key to the Highway_m.psarc", "Broken-Bandits_Road-of-Ocean_v1_DD_p.psarc",
                       "Solo.psarc", "AC-DC_Back-in-Black_v3_5_m.psarc", "tune.mid"))
  expect_identical(g$artist, c("B B King & Eric Clapton", "Broken Bandits", NA, "AC DC", NA))
  expect_identical(g$title, c("Key to the Highway", "Road of Ocean", "Solo", "Back in Black", "tune"))
})

test_that("library_open(): scans a small library, writes the index, reuses it", {
  skip_if_no_songs()
  local_library()
  # "small": not lazy, whatever the number of songs in songs/ (the default threshold is 50 files)
  withr::local_options(list(rockshiny.library_lazy_threshold = max(50L, length(sample_songs()))))
  lib <- library_open(songs_dir())
  n <- length(sample_songs())
  expect_false(lib$lazy)
  expect_identical(nrow(lib$songs), n)
  expect_true(all(lib$songs$scanned))
  expect_identical(lib$pending, 0L)
  f <- library_index_file()
  expect_true(file.exists(f))
  expect_match(readLines(f, n = 1L), "^# rockshiny-library/1")
  s <- lib$songs[basename(lib$songs$path) == "Dire-Straits_Sultans-of-Swing_v443_m.psarc", ]
  if (nrow(s)) {
    expect_identical(s$label, "Dire Straits \u2014 Sultans of Swing")
    expect_true(s$lyrics)
    expect_equal(s$length, 345.999, tolerance = 1e-3)
  }
  # a second open reads the index (no archive is opened): an edited title shows
  idx <- library_index()
  idx$title[1] <- "From the index"
  library_index_write(idx)
  lib2 <- library_open(songs_dir())
  expect_true("From the index" %in% lib2$songs$title)
  # ... unless the file changed (size / modification time)
  idx$mtime[1] <- idx$mtime[1] - 100
  library_index_write(idx)
  lib3 <- library_open(songs_dir())
  expect_false("From the index" %in% lib3$songs$title)
})

test_that("big libraries are lazy: mapped from file names, scanned in slices", {
  skip_if_no_songs()
  local_library()
  lib <- library_open(songs_dir(), threshold = 2, budget = 0)
  n <- length(sample_songs())
  expect_true(lib$lazy)
  expect_identical(lib$pending, n)
  expect_false(any(lib$songs$scanned))
  expect_true(all(is.na(lib$songs$lyrics)))
  expect_true(all(nzchar(lib$songs$label)))                  # labels from the file names meanwhile
  g <- karaoke_groups(lib)
  expect_length(g$unknown, n)                                # not checked yet
  expect_length(g$with, 0L)
  lib <- library_scan_more(lib, seconds = 0)                 # no time, no scan
  expect_identical(lib$pending, n)
  lib <- library_scan_more(lib, seconds = 60)
  expect_identical(lib$pending, 0L)
  g <- karaoke_groups(lib)
  expect_length(g$unknown, 0L)
  expect_identical(length(g$with) + length(g$online), n)
  expect_true(all(is.na(lib$songs$md5)))                     # no md5 yet: computed when a song is opened
})

test_that("karaoke_groups(): lyrics in the archive, a sidecar .lrc, cached lyrics, online", {
  local_library()
  NO_LYRICS <- "Carlos-Santana-ft-Chad-Kroeger_Into-The-Night_v2_m.psarc"
  f <- need_song(NO_LYRICS)
  dir <- withr::local_tempdir()
  file.copy(f, dir)
  lib <- library_open(dir)
  g <- karaoke_groups(lib)
  expect_length(g$with, 0L)
  expect_length(g$online, 1L)
  writeLines("[00:01.00]la", file.path(dir, sub("psarc$", "lrc", NO_LYRICS)))
  expect_length(karaoke_groups(lib)$with, 1L)
  # opening a song records its md5 in the index
  k <- load_karaoke_song(file.path(dir, NO_LYRICS), online = FALSE)
  expect_identical(library_index()$md5[match(normalizePath(file.path(dir, NO_LYRICS), winslash = "/"), library_index()$path)], k$key)
})

test_that("the library folder setting is remembered", {
  local_library()
  withr::local_options(list(rockshiny.library_dir = NULL, rockshiny.library_recursive = NULL))
  expect_identical(library_dir(), "songs")
  d <- withr::local_tempdir()
  expect_true(library_set_dir(d, recursive = TRUE))
  expect_identical(library_dir(), normalizePath(d))
  options(rockshiny.library_dir = NULL, rockshiny.library_recursive = NULL)     # a new session: from the config file
  expect_identical(library_dir(), normalizePath(d))
  expect_true(library_recursive())
  expect_error(library_set_dir(file.path(d, "nope")), "no such folder")
})

test_that("subfolders are included on request; hidden files never", {
  skip_if_no_songs()
  local_library()
  d <- withr::local_tempdir()
  dir.create(file.path(d, "sub", "deeper"), recursive = TRUE)
  dir.create(file.path(d, ".hidden"))
  s <- sample_songs()[1]
  file.copy(s, file.path(d, "sub", "deeper"))
  file.copy(s, file.path(d, ".hidden"))
  file.copy(s, file.path(d, paste0("._", basename(s))))
  expect_length(library_files(d), 0L)
  expect_length(library_files(d, recursive = TRUE), 1L)
  expect_match(library_files(d, recursive = TRUE), "/sub/deeper/")
})

test_that("karaoke_export_library(): a catalog page and one script per song", {
  skip_if_no_songs()
  local_library()
  out <- file.path(withr::local_tempdir(), "karaoke.html")
  karaoke_export_library(songs_dir(), out, audio = "none", online = FALSE)
  html <- paste(readLines(out, encoding = "UTF-8", warn = FALSE), collapse = "\n")
  data <- jsonlite::fromJSON(regmatches(html, regexpr('(?<=id="rs-karaoke-data">).*?(?=</script>)', html, perl = TRUE)),
                             simplifyVector = FALSE)
  songs <- data$songs
  g <- karaoke_groups(library_open(songs_dir()))
  expect_identical(length(songs), length(g$with) + length(g$online))
  ids <- vapply(songs, function(s) s$id, "")
  expect_true(all(grepl("^[a-z0-9-]+-[0-9a-f]{6}$", ids)))
  js <- file.path(dirname(out), "karaoke_files", "songs", paste0(ids, ".js"))
  expect_true(all(file.exists(js)))
  first <- readLines(js[1], warn = FALSE, encoding = "UTF-8")
  expect_match(first[1], paste0('^RSKaraokeSong\\("', ids[1], '",\\{"format":"rockshiny-karaoke/1"'))
  expect_true(all(vapply(songs, function(s) s$lyrics %in% c("archive", "web"), logical(1))))
  # re-running keeps what is up to date
  before <- file.mtime(js[1])
  Sys.sleep(1.1)
  karaoke_export_library(songs_dir(), out, audio = "none", online = FALSE)
  expect_identical(file.mtime(js[1]), before)
})

test_that("too many songs to embed their audio in one page", {
  skip_if_no_songs()
  local_library()
  k <- load_karaoke_song(need_song("Dire-Straits_Sultans-of-Swing_v443_m.psarc"), online = FALSE)
  expect_error(karaoke_export_html(rep(list(k), KARAOKE_EMBED_MAX + 1L), tempfile(fileext = ".html"), audio = "embed"), "too many")
})

test_that("the app's library notices new files in its folder", {
  skip_if_no_songs()
  local_library()
  d <- withr::local_tempdir()
  file.copy(sample_songs()[1], d)
  old <- .library_state$lib
  on.exit(.library_state$lib <- old, add = TRUE)
  lib <- library_use(d)
  expect_identical(nrow(lib$songs), 1L)
  v <- library_version()
  Sys.sleep(1.1)                                              # a new modification time
  file.copy(sample_songs()[2], d)
  .library_state$checked <- 0
  expect_gt(library_version(), v)
  expect_identical(nrow(library_current()$songs), 2L)
})

test_that("dlc alias resolves macOS bookmark, symlink, and text pointer; library bar switches to DLC", {
  local_library()
  # 1. Real root macOS Finder Alias file (when present in project root)
  root_dlc <- file.path(getOption("rockshiny.root", "."), "dlc")
  if (file.exists(root_dlc) && !dir.exists(root_dlc)) {
    p <- parse_macos_bookmark(root_dlc)
    expect_type(p, "character")
    expect_true(startsWith(p, "/") && grepl("/dlc$", p))
    expect_identical(library_dlc_dir(), resolve_path_alias(root_dlc))
  }
  # 2. Text pointer & directory / symlink resolution via options(rockshiny.dlc_alias)
  target <- withr::local_tempdir()
  ptr <- tempfile("dlc-ptr-")
  writeLines(target, ptr)
  on.exit(unlink(ptr), add = TRUE)
  expect_identical(resolve_path_alias(ptr), normalizePath(target, winslash = "/"))
  withr::local_options(list(rockshiny.dlc_alias = ptr, rockshiny.dlc_dir = NULL))
  expect_identical(library_dlc_dir(), normalizePath(target, winslash = "/"))
  # 3. mod_library_bar_ui wires all four modules (instrument, karaoke, creator, home)
  for (w in c("instrument", "karaoke", "creator", "home")) {
    html <- as.character(mod_library_bar_ui("library", w))
    expect_match(html, paste0("library-bar_", w), fixed = TRUE)
    expect_match(html, paste0("library-src_", w), fixed = TRUE)
    expect_match(html, paste0("library-change_", w), fixed = TRUE)
  }
  # 4. mod_library_server switches to the dlc alias folder (recursive = TRUE) on click
  sub <- file.path(target, "sub"); dir.create(sub)
  if (length(sample_songs())) file.copy(sample_songs()[1], sub)
  old_lib <- .library_state$lib
  on.exit(.library_state$lib <- old_lib, add = TRUE)
  def <- withr::local_tempdir()
  library_use(def, FALSE)
  withr::local_options(list(rockshiny.library_dir = def, rockshiny.library_recursive = FALSE))
  shiny::testServer(mod_library_server, {
    session$setInputs(source = list(kind = "dlc", n = 1))
    expect_identical(library_dir(), normalizePath(target))
    expect_true(library_recursive())
    if (length(sample_songs())) expect_identical(nrow(library_current()$songs), 1L)
  })
})
