# -----------------------------------------------------------------------------
# library.R -- the song library: a folder of .psarc / MIDI files (optionally
# with subfolders), described by a persistent index so that big libraries
# (hundreds of songs, gigabytes) open at once.
#
#   lib <- library_open("~/Rocksmith/dlc", recursive = TRUE)
#   lib                                 # 827 songs (827 scanned), lazy
#   library_choices_of(lib)             # c("Artist \u2014 Title" = path, ...)
#   karaoke_groups(lib)                 # songs with lyrics / to look up online / not checked yet
#
# Reading an archive's metadata (title, artist, album, year, length) and
# whether it has lyrics costs one header + table-of-contents read and two small
# entries; the result is kept in an index (<cache>/library/index.tsv) keyed by
# path + size + modification time, shared with tools/karaoke_export_html.py.
#
# One threshold, getOption("rockshiny.library_lazy_threshold", 50) files:
#   * small libraries are scanned completely when opened, their audio is
#     pre-decoded in the background (audio_prewarm_library()) and their md5 keys
#     are computed to find lyrics cached for them;
#   * above it a library is *lazy*: the folder is only mapped (file names, plus
#     whatever the index already knows; ~0.1 s for 827 files), metadata is
#     scanned in the background in short time slices (library_scan_more()), and
#     a song's md5, lyrics lookup and audio are produced only when it is picked.
# Why 50: a first scan costs 2-5 ms per file with a warm disk cache and ~60 ms
# cold (measured on 827 files; more in webR), md5 keys read every file in full
# (~7 MB each), and pre-decoding takes seconds of CPU per song -- 50 songs keep
# all of that to a few seconds (once; the index remembers) and ~0.4 GB of cache.
# -----------------------------------------------------------------------------

LIBRARY_INDEX_FORMAT <- "rockshiny-library/1"
LIBRARY_INDEX_FIELDS <- c("path", "size", "mtime", "kind", "artist", "title", "album", "year", "length",
                          "lyrics", "md5", "error")
LIBRARY_PATTERN <- "\\.(psarc|mid|midi|kar)$"

.library_state <- new.env(parent = emptyenv())

# ---- settings -----------------------------------------------------------------------------

library_config_file <- function() {
  d <- getOption("rockshiny.config_dir", tools::R_user_dir("RockShiny", which = "config"))
  file.path(d, "library.dcf")
}

#' The library folder: options(rockshiny.library_dir =), else the folder chosen
#' in the app before (library_set_dir()), else "songs".
#' @export
library_dir <- function() {
  d <- getOption("rockshiny.library_dir")
  if (!is.null(d)) return(d)
  cfg <- library_config()
  cfg$dir %||% "songs"
}

#' Include subfolders? options(rockshiny.library_recursive =), else the saved choice.
#' @noRd
library_recursive <- function() {
  r <- getOption("rockshiny.library_recursive")
  if (!is.null(r)) return(isTRUE(r))
  isTRUE(as.logical(library_config()$recursive %||% FALSE))
}

library_config <- function() {
  f <- library_config_file()
  if (!file.exists(f)) return(list())
  tryCatch(as.list(read.dcf(f)[1, ]), error = function(e) list())
}

#' Remember the library folder (for this R session and the next ones).
#' @param dir the folder.
#' @param recursive include subfolders.
#' @export
library_set_dir <- function(dir, recursive = FALSE) {
  if (!dir.exists(dir)) stop(dir, ": no such folder", call. = FALSE)
  dir <- normalizePath(dir)
  options(rockshiny.library_dir = dir, rockshiny.library_recursive = isTRUE(recursive))
  f <- library_config_file()
  ok <- tryCatch({
    dir.create(dirname(f), showWarnings = FALSE, recursive = TRUE)
    write.dcf(data.frame(dir = dir, recursive = isTRUE(recursive)), f)
    TRUE
  }, error = function(e) FALSE, warning = function(w) FALSE)
  invisible(ok)
}

# ---- files ------------------------------------------------------------------------------

#' Song files in a folder (full, normalised paths; sorted).
#' @noRd
library_files <- function(dir, recursive = FALSE) {
  if (!length(dir) || !dir.exists(dir)) return(character())
  f <- list.files(dir, pattern = LIBRARY_PATTERN, ignore.case = TRUE, recursive = recursive)
  f <- f[!grepl("(^|/)[.]", f)]                                   # hidden files / folders (._x.psarc from macOS zips)
  if (!length(f)) return(character())
  sort(file.path(normalizePath(dir, winslash = "/"), f))                          # one normalizePath(), not one per file
}

#' Artist and title guessed from file names ("Artist-Name_Song-Title_v2_DD_p.psarc",
#' "Artist - Title.psarc"), for songs not scanned yet. Vectorised:
#' list(artist = character, title = character).
#' @noRd
library_guess <- function(path) {
  b <- sub(LIBRARY_PATTERN, "", basename(path), ignore.case = TRUE)
  b <- sub("(_v[0-9][0-9_.]*)?(_DD)?(_[mp])?$", "", b, ignore.case = TRUE)      # CustomsForge suffixes
  clean <- function(x) trimws(gsub("\\s+", " ", gsub("[_]+|(?<=\\S)-(?=\\S)", " ", x, perl = TRUE)))
  dash <- regexpr(" - ", b, fixed = TRUE)
  under <- regexpr("_", b, fixed = TRUE)
  artist <- rep(NA_character_, length(b))
  title <- b
  d <- dash > 0
  artist[d] <- substr(b[d], 1L, dash[d] - 1L)
  title[d] <- substring(b[d], dash[d] + 3L)
  u <- !d & under > 0
  artist[u] <- substr(b[u], 1L, under[u] - 1L)
  title[u] <- substring(b[u], under[u] + 1L)
  artist[!is.na(artist)] <- clean(artist[!is.na(artist)])
  list(artist = artist, title = clean(title))
}

#' Title, artist, ... of an archive: the first instrument manifest that names the song.
#' @noRd
psarc_song_meta <- function(arc) {
  for (m in psarc_find(arc, "^manifests/.*\\.json$")) {
    a <- tryCatch(jsonlite::fromJSON(rawToChar(psarc_read(arc, m)), simplifyVector = FALSE)$Entries[[1]]$Attributes,
                  error = function(e) NULL)
    if (is.null(a) || is.null(a$SongName)) next
    return(list(title = a$SongName, artist = a$ArtistName %||% NA_character_, album = a$AlbumName %||% NA_character_,
                year = as.character(a$SongYear %||% NA), song_length = as.numeric(a$SongLength %||% NA)))
  }
  NULL
}

#' Does an archive have lyrics? lyrics_present(song_vocals_raw()) without parsing
#' the vocals XML: a scan only needs one non-empty lyric="..." attribute (SNG vocals
#' of official DLC are parsed as usual).
#' @noRd
archive_has_lyrics <- function(arc) {
  files <- arc$entries$name
  xml <- files[grepl("^songs/arr/.*vocals\\.xml$", files)]
  xml <- xml[order(grepl("jvocals", xml))][1]
  if (is.na(xml)) return(lyrics_present(song_vocals_raw(list(arc = arc))))
  raw <- tryCatch(psarc_read(arc, xml), error = function(e) raw())
  txt <- rawToChar(raw[raw != as.raw(0)])
  m <- regmatches(txt, gregexpr('lyric="[^"]*"', txt, useBytes = TRUE))[[1]]
  # (matched as bytes: nchar()/substr() would fail on lyrics with non-ASCII letters, e.g. a
  # typographic apostrophe -- that made songs with such lyrics look lyric-less in a scan)
  m <- gsub('^lyric="|"$', "", m, useBytes = TRUE)
  m <- gsub("[+-]+$|^[[:space:]]+|[[:space:]]+$", "", m, useBytes = TRUE)
  any(nzchar(m))
}

#' Scan one file: a one-row data.frame of index fields.
#' @noRd
library_scan_file <- function(path, info = file.info(path)) {
  g <- library_guess(path)
  row <- list(path = path, size = as.numeric(info$size), mtime = floor(as.numeric(info$mtime)),
              kind = if (grepl("\\.psarc$", path, ignore.case = TRUE)) "psarc" else "midi",
              artist = g$artist, title = g$title, album = NA_character_, year = NA_character_, length = NA_real_,
              lyrics = NA, md5 = NA_character_, error = NA_character_)
  if (row$kind == "midi") {
    row$title <- paste(gsub("[_]+", " ", sub(LIBRARY_PATTERN, "", basename(path), ignore.case = TRUE)), "(MIDI)")
    row$artist <- NA_character_
  } else {
    res <- tryCatch({
      arc <- psarc_open(path)
      m <- psarc_song_meta(arc)
      if (!is.null(m)) {
        row$artist <- m$artist; row$title <- m$title; row$album <- m$album; row$year <- m$year
        row$length <- m$song_length
      }
      row$lyrics <- archive_has_lyrics(arc)
      NULL
    }, error = function(e) conditionMessage(e))
    if (!is.null(res)) { row$error <- res; row$lyrics <- FALSE }
  }
  row <- lapply(row, function(x) if (is.null(x) || !length(x)) NA else x[[1]])
  as.data.frame(row, stringsAsFactors = FALSE)
}

# ---- the index (shared with tools/karaoke_export_html.py) --------------------------------

library_index_file <- function() file.path(cache_root(), "library", "index.tsv")

library_empty_index <- function() {
  data.frame(path = character(), size = numeric(), mtime = numeric(), kind = character(), artist = character(),
             title = character(), album = character(), year = character(), length = numeric(), lyrics = logical(),
             md5 = character(), error = character(), stringsAsFactors = FALSE)
}

#' The index as a data.frame (LIBRARY_INDEX_FIELDS); re-read when the file changed.
#' @noRd
library_index <- function() {
  f <- library_index_file()
  if (!identical(.library_state$index_path, f)) {            # another cache folder (options(rockshiny.cache_dir =))
    if (isTRUE(.library_state$dirty) && !is.null(.library_state$index_path)) {
      tryCatch(library_index_write(.library_state$index, .library_state$index_path), error = function(e) NULL)
    }
    .library_state$index <- NULL
    .library_state$dirty <- FALSE
    .library_state$index_path <- f
  }
  stamp <- if (file.exists(f)) paste(file.info(f)$mtime, file.info(f)$size) else ""
  if (!is.null(.library_state$index) && (isTRUE(.library_state$dirty) || identical(.library_state$index_stamp, stamp))) {
    return(.library_state$index)
  }
  idx <- library_empty_index()
  if (file.exists(f)) {
    idx <- tryCatch({
      first <- readLines(f, n = 1L, warn = FALSE, encoding = "UTF-8")
      if (!identical(sub("\t.*$", "", sub("^# ", "", first)), LIBRARY_INDEX_FORMAT)) stop("unknown index format")
      x <- utils::read.delim(f, skip = 1L, quote = "", comment.char = "", colClasses = "character", na.strings = "",
                             encoding = "UTF-8", stringsAsFactors = FALSE)
      if (!all(LIBRARY_INDEX_FIELDS %in% names(x))) stop("index fields missing")
      x <- x[LIBRARY_INDEX_FIELDS]
      for (k in c("size", "mtime", "length")) x[[k]] <- as.numeric(x[[k]])
      x$lyrics <- ifelse(is.na(x$lyrics), NA, x$lyrics == "1")
      x
    }, error = function(e) library_empty_index())
  }
  .library_state$index <- idx
  .library_state$index_stamp <- stamp
  idx
}

#' Merge rows into the index (by path) and write it (atomically). With
#' `defer = TRUE` the file is written at most every few seconds (a background
#' scan adds a few rows at a time); library_index_flush() writes the rest.
#' @noRd
library_index_update <- function(rows, defer = FALSE) {
  if (!nrow(rows)) return(invisible(library_index()))
  idx <- library_index()
  idx <- rbind(idx[!idx$path %in% rows$path, , drop = FALSE], rows[LIBRARY_INDEX_FIELDS])
  .library_state$index <- idx
  if (defer && proc.time()[[3]] - (.library_state$written %||% 0) < getOption("rockshiny.library_index_every", 5)) {
    .library_state$dirty <- TRUE
    return(invisible(idx))
  }
  library_index_write(idx)
}

library_index_flush <- function() {
  if (isTRUE(.library_state$dirty)) library_index_write(.library_state$index)
  invisible(NULL)
}

library_index_write <- function(idx, f = library_index_file()) {
  idx <- idx[order(idx$path), , drop = FALSE]
  dir.create(dirname(f), showWarnings = FALSE, recursive = TRUE)
  tmp <- paste0(f, ".tmp", Sys.getpid())
  cell <- function(x) {
    x <- as.character(x)
    x[is.na(x)] <- ""
    gsub("[\t\r\n]+", " ", x)
  }
  out <- idx
  num <- function(x, f) ifelse(is.na(x), NA, sprintf(f, x))
  out$size <- num(out$size, "%.0f")
  out$mtime <- num(out$mtime, "%.0f")
  out$length <- num(out$length, "%.3f")
  out$lyrics <- ifelse(is.na(out$lyrics), NA, ifelse(out$lyrics, "1", "0"))
  lines <- c(paste0("# ", LIBRARY_INDEX_FORMAT, "\tsongs scanned by RockShiny (R and tools/karaoke_export_html.py)"),
             paste(LIBRARY_INDEX_FIELDS, collapse = "\t"),
             if (nrow(out)) do.call(paste, c(lapply(out[LIBRARY_INDEX_FIELDS], cell), sep = "\t")))
  con <- file(tmp, "w", encoding = "UTF-8")
  writeLines(lines, con, useBytes = FALSE)
  close(con)
  if (!file.rename(tmp, f)) { file.copy(tmp, f, overwrite = TRUE); unlink(tmp) }
  .library_state$index <- idx
  .library_state$index_stamp <- paste(file.info(f)$mtime, file.info(f)$size)
  .library_state$written <- proc.time()[[3]]
  .library_state$dirty <- FALSE
  invisible(idx)
}

#' Remember a song's md5 (computed when it was opened) in the index.
#' @noRd
library_note_key <- function(path, key) {
  idx <- library_index()
  i <- match(path, idx$path)
  if (is.na(i) || identical(idx$md5[i], key)) return(invisible(FALSE))
  row <- idx[i, , drop = FALSE]
  row$md5 <- key
  library_index_update(row)
  invisible(TRUE)
}

# ---- libraries ----------------------------------------------------------------------------

#' Open a library folder.
#' @param dir folder;
#' @param recursive include subfolders.
#' @param budget seconds to spend scanning unscanned files now (default: all of
#'   them for a small library, getOption("rockshiny.library_scan_budget", 1) s for a
#'   lazy one; library_scan_more() continues).
#' @param threshold libraries with more files than this are lazy.
#' @return an "rs_library": dir, recursive, lazy, songs (data.frame: path, label,
#'   kind, artist, title, album, year, length, lyrics (TRUE / FALSE / NA = not
#'   known yet), md5, scanned, size, mtime), pending (paths still to scan).
#' @export
library_open <- function(dir = library_dir(), recursive = library_recursive(), budget = NULL,
                         threshold = getOption("rockshiny.library_lazy_threshold", 50)) {
  t0 <- proc.time()[[3]]
  files <- library_files(dir, recursive)
  info <- file.info(files)
  size <- as.numeric(info$size)
  mtime <- floor(as.numeric(info$mtime))
  idx <- library_index()
  i <- match(files, idx$path)
  fresh <- !is.na(i)
  fresh[fresh] <- idx$size[i[fresh]] == size[fresh] & idx$mtime[i[fresh]] == mtime[fresh]
  # a file that could not be read is tried again: the error may have been a bug since fixed
  # (e.g. lyrics with non-ASCII letters made the scan fail and the song look lyric-less)
  fresh[fresh] <- is.na(idx$error[i[fresh]])
  songs <- library_empty_index()[rep(NA_integer_, length(files)), , drop = FALSE]
  rownames(songs) <- NULL
  songs$path <- files
  songs$size <- size
  songs$mtime <- mtime
  if (any(fresh)) songs[fresh, LIBRARY_INDEX_FIELDS] <- idx[i[fresh], LIBRARY_INDEX_FIELDS]
  songs$scanned <- fresh
  if (any(!fresh)) {                                                  # mapped from the file name for now
    g <- library_guess(files[!fresh])
    songs$artist[!fresh] <- g$artist
    songs$title[!fresh] <- g$title
    songs$kind[!fresh] <- ifelse(grepl("\\.psarc$", files[!fresh], ignore.case = TRUE), "psarc", "midi")
  }
  lib <- structure(list(dir = dir, recursive = isTRUE(recursive), lazy = length(files) > threshold,
                        songs = songs, map_seconds = proc.time()[[3]] - t0,
                        dir_mtime = suppressWarnings(file.mtime(dir))), class = "rs_library")
  if (is.null(budget)) budget <- if (lib$lazy) getOption("rockshiny.library_scan_budget", 1) else Inf
  lib <- library_scan_more(lib, budget)
  lib$open_seconds <- proc.time()[[3]] - t0
  lib
}

#' Scan more of a library's unscanned files for up to `seconds`; updates the index.
#' @param lib a library from `library_open()`.
#' @param seconds time budget in seconds.
#' @export
library_scan_more <- function(lib, seconds = 0.5) {
  todo <- which(!lib$songs$scanned)
  if (!length(todo) || seconds <= 0) return(library_finish(lib))
  t0 <- proc.time()[[3]]
  rows <- list()
  for (k in todo) {
    p <- lib$songs$path[k]
    r <- if (file.exists(p)) library_scan_file(p) else NULL
    if (!is.null(r)) {
      rows[[length(rows) + 1L]] <- r
      lib$songs[k, LIBRARY_INDEX_FIELDS] <- r[LIBRARY_INDEX_FIELDS]
    }
    lib$songs$scanned[k] <- TRUE
    if (proc.time()[[3]] - t0 >= seconds) break
  }
  if (length(rows)) library_index_update(do.call(rbind, rows), defer = TRUE)
  if (!any(!lib$songs$scanned)) library_index_flush()
  library_finish(lib)
}

library_finish <- function(lib) {
  s <- lib$songs
  lib$pending <- sum(!s$scanned)
  lib$songs$label <- library_labels(s)
  lib
}

#' "Artist -- Title" labels; duplicates get the album, then the file name.
#' @noRd
library_labels <- function(s) {
  if (!nrow(s)) return(character())
  has <- function(x) !is.na(x) & nzchar(ifelse(is.na(x), "", x))
  labels <- ifelse(has(s$artist), paste(s$artist, "\u2014", s$title), s$title)
  labels[is.na(labels)] <- basename(s$path[is.na(labels)])
  dup <- labels %in% labels[duplicated(labels)]
  alb <- has(s$album)
  labels[dup & alb] <- paste0(labels[dup & alb], " (", s$album[dup & alb], ")")
  dup <- labels %in% labels[duplicated(labels)]
  labels[dup] <- paste0(labels[dup], " [", basename(s$path[dup]), "]")
  labels
}

#' Named vector of the library's songs (label = path), sorted by label.
#' @param lib a library from `library_open()`.
#' @param kinds file kinds to list: "psarc", "midi".
#' @export
library_choices_of <- function(lib, kinds = c("psarc", "midi")) {
  s <- lib$songs[lib$songs$kind %in% kinds, , drop = FALSE]
  o <- order(tolower(s$label))
  stats::setNames(s$path[o], s$label[o])
}

#' Is `path` one of the library's songs?
#' @noRd
library_has <- function(lib, path) !is.null(lib) && length(path) == 1L && path %in% library_all_songs(lib)$path

#' Print a song library: folder, songs, scan progress.
#' @param x the object.
#' @param ... ignored.
#' @export
print.rs_library <- function(x, ...) {
  s <- x$songs
  cat(sprintf("<rs_library> %s%s: %d songs (%d scanned)%s\n", x$dir, if (x$recursive) " (with subfolders)" else "",
              nrow(s), sum(s$scanned), if (x$lazy) ", lazy: details load when a song is selected" else ""))
  if (any(s$scanned & s$kind == "psarc")) {
    cat(sprintf("  %d with lyrics in the archive, %d without\n", sum(s$lyrics %in% TRUE), sum(s$scanned & s$lyrics %in% FALSE)))
  }
  invisible(x)
}

# ---- karaoke view of a library ------------------------------------------------------------

#' Split a library for the karaoke mode: songs with lyrics (in the archive, a
#' sidecar .lrc, or found online before), songs to look up online (scanned: no
#' lyrics), and songs not checked yet (lazy libraries, until scanned).
#' md5 keys (for cached lyrics) are computed for small libraries only; lazy ones
#' use the keys the index knows (songs opened before).
#' @param lib a library from `library_open()`.
#' @param extra also the songs uploaded in the app (`library_uploads()`).
#' @export
karaoke_groups <- function(lib, extra = TRUE) {
  s <- if (extra) library_all_songs(lib) else lib$songs
  s <- s[s$kind == "psarc", , drop = FALSE]
  if (!nrow(s)) return(list(with = character(), online = character(), unknown = character()))
  lazy <- isTRUE(lib$lazy) & (if (is.null(s[["source"]])) rep(TRUE, nrow(s)) else s[["source"]] == "library")
  side <- file.exists(sub("\\.psarc$", ".lrc", s$path, ignore.case = TRUE))
  known <- side
  cand <- which(!known & !(s$lyrics %in% TRUE) & s$scanned)
  for (k in cand) {
    key <- s$md5[k]
    if (is.na(key) && !lazy[k]) key <- tryCatch(file_key(s$path[k]), error = function(e) NA_character_)
    if (!is.na(key)) known[k] <- isTRUE(lyrics_cache_read(key)$found)
  }
  with <- s$lyrics %in% TRUE | known
  grp <- ifelse(with, "with", ifelse(s$scanned, "online", "unknown"))
  pick <- function(g) {
    x <- s[grp == g, , drop = FALSE]
    o <- order(tolower(x$label))
    stats::setNames(x$path[o], x$label[o])
  }
  list(with = pick("with"), online = pick("online"), unknown = pick("unknown"))
}

# ---- uploads and the bundled examples -------------------------------------------------------

#' Where songs uploaded in the app are kept (so they stay in the song lists).
#' @noRd
uploads_dir <- function() getOption("rockshiny.uploads_dir", file.path(score_dir(), "uploads"))

#' Keep an uploaded file: copied into uploads_dir() under its own name (a
#' different file with the same name gets a suffix; the same file is kept once).
#' @return the stored file's path.
#' @noRd
library_store_upload <- function(datapath, name) {
  d <- uploads_dir()
  dir.create(d, showWarnings = FALSE, recursive = TRUE)
  name <- gsub("[/\\\\:*?\"<>|]+", "_", basename(name))
  if (!nzchar(name)) name <- basename(datapath)
  dest <- file.path(d, name)
  new_md5 <- unname(tools::md5sum(datapath))
  if (file.exists(dest) && !identical(unname(tools::md5sum(dest)), new_md5)) {
    ext <- tools::file_ext(name)
    dest <- file.path(d, paste0(tools::file_path_sans_ext(name), "-", substr(new_md5, 1L, 6L), if (nzchar(ext)) paste0(".", ext)))
  }
  if (!file.exists(dest) && !file.copy(datapath, dest)) stop("could not keep the upload in ", d, call. = FALSE)
  library_touch()
  normalizePath(dest, winslash = "/")
}

#' Songs uploaded in the app (a small library of their own).
#' @noRd
library_uploads <- function() {
  d <- uploads_dir()
  stamp <- if (dir.exists(d)) paste(file.mtime(d), length(list.files(d))) else ""
  if (!identical(.library_state$uploads_stamp, stamp) || is.null(.library_state$uploads)) {
    .library_state$uploads <- if (nzchar(stamp)) library_open(d, FALSE, budget = Inf, threshold = Inf)$songs else NULL
    .library_state$uploads_stamp <- stamp
  }
  .library_state$uploads
}

#' The bundled examples (inst/examples: a MIDI demo).
#' @noRd
library_examples <- function() {
  if (is.null(.library_state$examples_songs)) {
    .library_state$examples_songs <- tryCatch(library_open(asset_dir("examples"), FALSE, budget = Inf, threshold = Inf)$songs,
                                              error = function(e) NULL)
  }
  .library_state$examples_songs
}

#' Every song the app offers: the library folder, the uploads and the examples,
#' with a `source` column ("library", "uploads", "examples").
#' @noRd
library_all_songs <- function(lib) {
  tag <- function(x, src) {
    if (is.null(x) || !nrow(x)) return(NULL)
    x$source <- src
    x
  }
  parts <- list(tag(lib$songs, "library"), tag(library_uploads(), "uploads"), tag(library_examples(), "examples"))
  parts <- Filter(Negate(is.null), parts)
  cols <- Reduce(intersect, lapply(parts, names))
  s <- do.call(rbind, lapply(parts, function(x) x[cols]))
  if (is.null(s)) return(cbind(library_empty_index(), scanned = logical(), label = character(), source = character()))
  s[!duplicated(s$path), , drop = FALSE]
}

#' Something changed (an upload): song lists refresh in every session.
#' @noRd
library_touch <- function() {
  .library_state$version <- (.library_state$version %||% 0) + 1
  invisible(NULL)
}

# ---- the app's library (shared by all sessions; scanned in the background) -------------------

#' The current library of the app (opened on first use).
#' @noRd
library_current <- function() {
  lib <- .library_state$lib
  if (is.null(lib)) lib <- library_use(library_dir(), library_recursive())
  lib
}

#' Switch the app's library (and start scanning it in the background when lazy).
#' @noRd
library_use <- function(dir, recursive = FALSE) {
  lib <- library_open(dir, recursive)
  .library_state$lib <- lib
  .library_state$version <- (.library_state$version %||% 0) + 1
  if (lib$pending) library_background()
  lib
}

#' Version counter of the app's library: changes as the background scan proceeds,
#' and when files are added to / removed from the folder (checked every few seconds;
#' the folder's modification time -- subfolders of a recursive library are not watched).
#' @noRd
library_version <- function() {
  lib <- .library_state$lib
  now <- proc.time()[[3]]
  if (!is.null(lib) && now - (.library_state$checked %||% 0) > 5) {
    .library_state$checked <- now
    m <- suppressWarnings(file.mtime(lib$dir))
    if (!is.na(m) && !identical(m, lib$dir_mtime)) library_use(lib$dir, lib$recursive)
  }
  .library_state$version %||% 0
}

#' Scan the current library's pending files in short slices between Shiny's work.
#' @noRd
library_background <- function(slice = getOption("rockshiny.library_scan_slice", 0.25)) {
  if (isTRUE(.library_state$scanning)) return(invisible(FALSE))
  .library_state$scanning <- TRUE
  step <- function() {
    lib <- .library_state$lib
    if (is.null(lib) || !lib$pending) { .library_state$scanning <- FALSE; return(invisible()) }
    lib2 <- tryCatch(library_scan_more(lib, slice), error = function(e) { lib$pending <- 0L; lib })
    if (identical(.library_state$lib$dir, lib$dir)) {             # not switched meanwhile
      .library_state$lib <- lib2
      .library_state$version <- (.library_state$version %||% 0) + 1
    }
    later::later(step, 0.05)
  }
  later::later(step, 0.1)
  invisible(TRUE)
}

#' Song list of the instrument mode: the library, then the uploads and the
#' examples in their own groups (a named list of named vectors; label = path).
#' @noRd
library_instrument_choices <- function(lib) {
  s <- library_all_songs(lib)
  grp <- c(library = "Library", uploads = "Uploaded", examples = "Examples")
  out <- list()
  for (src in names(grp)) {
    x <- s[s$source == src, , drop = FALSE]
    if (!nrow(x)) next
    o <- order(tolower(x$label))
    out[[grp[[src]]]] <- as.list(stats::setNames(x$path[o], x$label[o]))
  }
  out
}
