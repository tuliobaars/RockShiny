# -----------------------------------------------------------------------------
# lyrics_online.R -- lyrics for songs whose archive has none.
#
# Where they come from, first hit wins:
#   1. a sidecar file next to the .psarc with the same name and .lrc
#      ("Song_m.psarc" + "Song_m.lrc"), e.g. one you timed or downloaded;
#   2. the cache (<cache>/lyrics/<md5 of the .psarc>.json): an earlier lookup,
#      a dropped .lrc, and the offset the browser found when syncing;
#   3. LRCLIB (https://lrclib.net): a free, open database of synced lyrics,
#      no key. Searched by artist and title (variants without "ft. ..." or
#      "(Live)"), results preferred with synced lyrics and the song's length.
#
# LRC lyrics are timed for *a* recording of the song. The browser aligns them
# to this recording (inst/karaoke/karaoke-sync.js) and reports the offset,
# which is cached here, so a song is synced once.
#
# options(rockshiny.lyrics_online = FALSE) turns the online lookup off (only
# artist and title are sent, to lrclib.net).
# -----------------------------------------------------------------------------

LRCLIB_API <- "https://lrclib.net/api"
LYRICS_RETRY_DAYS <- 7           # a "not found" is retried after this long

#' The fields of a lyrics result, in a fixed order (also the JSON order).
#' @noRd
lyrics_result <- function(x) list(lrc = x$lrc, source = x$source, synced = x$synced %||% "line",
                                  lrc_duration = as.numeric(x$lrc_duration %||% NA), url = x$url %||% NA_character_,
                                  offset_ms = if (is.null(x$offset_ms)) NULL else as.numeric(x$offset_ms))   # JSON 1234 reads as integer

lyrics_cache_file <- function(key) file.path(cache_root(), "lyrics", paste0(key, ".json"))

lyrics_cache_read <- function(key) {
  f <- lyrics_cache_file(key)
  if (!file.exists(f)) return(NULL)
  tryCatch(jsonlite::fromJSON(paste(readLines(f, warn = FALSE, encoding = "UTF-8"), collapse = "\n"), simplifyVector = FALSE),
           error = function(e) NULL)
}

lyrics_cache_write <- function(key, entry) {
  f <- lyrics_cache_file(key)
  dir.create(dirname(f), recursive = TRUE, showWarnings = FALSE)
  entry$time <- format(Sys.time(), "%Y-%m-%dT%H:%M:%S")
  writeLines(enc2utf8(as.character(jsonlite::toJSON(lapply(entry, jsonlite::unbox), null = "null", na = "null"))),
             f, useBytes = TRUE)
  invisible(entry)
}

#' Remember the offset the browser found when syncing LRC lyrics (ms).
#' @param key content key (md5 of the .psarc).
#' @param offset_ms the lyrics offset found when syncing, in milliseconds.
#' @export
lyrics_cache_offset <- function(key, offset_ms) {
  e <- lyrics_cache_read(key)
  if (is.null(e) || !isTRUE(e$found)) return(invisible(NULL))
  e$offset_ms <- round(as.numeric(offset_ms))
  lyrics_cache_write(key, e)
}

#' The sidecar .lrc of a song file (same folder, same name), or NA.
#' @noRd
sidecar_lrc <- function(path) {
  f <- paste0(tools::file_path_sans_ext(path), ".lrc")
  if (file.exists(f)) f else NA_character_
}

read_text <- function(f) paste(readLines(f, warn = FALSE, encoding = "UTF-8"), collapse = "\n")

#' Timed lines of an LRC text (the browser does the full parse, incl. word
#' tags and `[offset:]`): data.frame(time, text), sorted; plain text lines give
#' time NA. Used for the sidebar info and tests.
#' @param text LRC text.
#' @export
parse_lrc <- function(text) {
  lines <- strsplit(sub("^\ufeff", "", text), "\r?\n")[[1]]
  tag <- "\\[(\\d{1,3}):(\\d{1,2}(?:[.:]\\d{1,3})?)\\]"
  out <- list()
  for (l in lines) {
    m <- regmatches(l, regexpr(paste0("^(", tag, ")+"), l, perl = TRUE))
    if (!length(m)) {
      if (nzchar(trimws(l)) && !grepl("^\\s*\\[[A-Za-z#]+:.*\\]\\s*$", l)) out[[length(out) + 1L]] <- data.frame(time = NA_real_, text = trimws(l))
      next
    }
    txt <- trimws(gsub("<\\d{1,3}:\\d{1,2}(?:[.:]\\d{1,3})?>", "", substring(l, nchar(m) + 1L), perl = TRUE))
    st <- regmatches(m, gregexpr(tag, m, perl = TRUE))[[1]]
    mm <- as.numeric(sub(tag, "\\1", st, perl = TRUE))
    ss <- as.numeric(chartr(":", ".", sub(tag, "\\2", st, perl = TRUE)))
    out[[length(out) + 1L]] <- data.frame(time = mm * 60 + ss, text = rep(txt, length(st)))
  }
  df <- if (length(out)) do.call(rbind, out) else data.frame(time = numeric(), text = character())
  df$text <- as.character(df$text)
  df <- df[order(df$time, na.last = TRUE), , drop = FALSE]
  rownames(df) <- NULL
  df[is.na(df$time) | nzchar(df$text), , drop = FALSE]
}

#' GET an LRCLIB endpoint -> parsed JSON (list), or NULL for "not found".
#' Network failures are errors (so that they are not cached as "not found").
#' @noRd
lrclib_fetch <- function(url) {
  old <- options(timeout = getOption("rockshiny.lyrics_timeout", 10))
  on.exit(options(old), add = TRUE)
  con <- url(url, headers = c(`User-Agent` = "RockShiny karaoke (R; https://lrclib.net/docs)", Accept = "application/json"))
  on.exit(close(con), add = TRUE)
  res <- tryCatch(readLines(con, warn = FALSE, encoding = "UTF-8"), error = function(e) e)
  if (inherits(res, "error")) {
    if (grepl("404", conditionMessage(res))) return(NULL)
    stop(res)
  }
  jsonlite::fromJSON(paste(res, collapse = "\n"), simplifyVector = FALSE)
}

lyrics_clean_title <- function(x) trimws(gsub("\\s*[([][^)\\]]*(live|remaster|version|edit|mix|mono|stereo|feat)[^)\\]]*[)\\]]", "", x %||% "",
                                              ignore.case = TRUE, perl = TRUE))
lyrics_main_artist <- function(x) {
  x <- gsub("\\s*[([]\\s*(ft\\.?|feat\\.?|featuring|with)\\s[^)\\]]*[)\\]]", "", x %||% "", ignore.case = TRUE, perl = TRUE)
  trimws(strsplit(x, "\\s+(ft\\.?|feat\\.?|featuring|with|&|and|x)\\s+|,", perl = TRUE)[[1]][1] %||% "")
}
lyrics_norm <- function(x) gsub("[^a-z0-9]+", "", tolower(ascii_fold(x %||% "")))

#' Search LRCLIB for a song's lyrics.
#' @param meta list(title, artist, album, song_length).
#' @param fetch function(url) -> parsed JSON or NULL (lrclib_fetch(); tests pass a fake).
#' @return list(found = TRUE, lrc, synced = "line"|"none", lrc_duration, source = "lrclib", url), or NULL.
#' @export
lrclib_search <- function(meta, fetch = lrclib_fetch) {
  title <- meta$title %|NA|% ""
  artist <- meta$artist %|NA|% ""
  if (!nzchar(title)) return(NULL)
  enc <- function(x) utils::URLencode(x, reserved = TRUE)
  q <- function(a, t) sprintf("%s/search?artist_name=%s&track_name=%s", LRCLIB_API, enc(a), enc(t))
  urls <- unique(c(q(artist, title), q(lyrics_main_artist(artist), lyrics_clean_title(title)),
                   sprintf("%s/search?q=%s", LRCLIB_API, enc(trimws(paste(lyrics_main_artist(artist), lyrics_clean_title(title)))))))
  want <- lyrics_norm(lyrics_clean_title(title))
  dur <- as.numeric(meta$song_length %||% NA)
  for (u in urls) {
    res <- fetch(u)
    if (!length(res)) next
    ok <- Filter(function(r) {
      has <- !is.null(r$syncedLyrics) || !is.null(r$plainLyrics)
      got <- lyrics_norm(lyrics_clean_title(r$trackName %||% r$name %||% ""))
      has && !isTRUE(r$instrumental) && nzchar(got) && (grepl(want, got, fixed = TRUE) || grepl(got, want, fixed = TRUE))
    }, res)
    if (!length(ok)) next
    synced <- vapply(ok, function(r) !is.null(r$syncedLyrics), logical(1))
    gap <- vapply(ok, function(r) if (is.na(dur) || is.null(r$duration)) 0 else abs(as.numeric(r$duration) - dur), numeric(1))
    best <- ok[[order(!synced, gap)[1]]]
    return(list(found = TRUE, lrc = best$syncedLyrics %||% best$plainLyrics,
                synced = if (!is.null(best$syncedLyrics)) "line" else "none",
                lrc_duration = as.numeric(best$duration %||% NA), source = "lrclib",
                url = sprintf("%s/get/%s", LRCLIB_API, best$id %||% "")))
  }
  NULL
}

#' Lyrics for a song whose archive has none: sidecar .lrc, cache, LRCLIB.
#' @param path the .psarc (for the sidecar).
#' @param key its md5 (cache key).
#' @param meta list(title, artist, album, song_length) (karaoke_manifest()).
#' @param online look up LRCLIB when nothing else is there.
#' @param fetch HTTP function for LRCLIB (`lrclib_fetch()`; tests pass a fake).
#' @param refresh ignore the cache.
#' @return list(lrc, source = "file"|"lrclib", synced, lrc_duration, url, offset_ms); NULL when
#'   none were found; an empty "lyrics_offline" object when LRCLIB could not be reached.
#' @export
lyrics_lookup <- function(path, key, meta, online = getOption("rockshiny.lyrics_online", TRUE),
                          fetch = lrclib_fetch, refresh = FALSE) {
  side <- sidecar_lrc(path)
  cached <- if (refresh) NULL else lyrics_cache_read(key)
  if (!is.na(side)) {
    lrc <- read_text(side)
    off <- if (!is.null(cached) && identical(cached$source, "file") && identical(cached$lrc, lrc)) cached$offset_ms else NULL
    return(lyrics_result(list(lrc = lrc, source = "file", synced = if (any(!is.na(parse_lrc(lrc)$time))) "line" else "none",
                              offset_ms = off)))
  }
  if (!is.null(cached)) {
    if (isTRUE(cached$found)) return(lyrics_result(cached))
    age <- tryCatch(as.numeric(difftime(Sys.time(), as.POSIXct(cached$time, format = "%Y-%m-%dT%H:%M:%S"), units = "days")),
                    error = function(e) Inf)
    if (isTRUE(age < LYRICS_RETRY_DAYS)) return(NULL)
  }
  if (!isTRUE(online)) return(NULL)
  hit <- tryCatch(lrclib_search(meta, fetch), error = function(e) {
    message("RockShiny: lyrics lookup failed (", conditionMessage(e), ")")
    structure(list(), class = "lookup_failed")
  })
  if (inherits(hit, "lookup_failed")) return(structure(list(), class = "lyrics_offline"))   # not cached
  if (is.null(hit)) { lyrics_cache_write(key, list(found = FALSE)); return(NULL) }
  lyrics_cache_write(key, hit)
  lyrics_result(hit)
}

#' Known lyrics without a lookup (sidecar .lrc, or a cached hit)?
#' @noRd
lyrics_known <- function(path, key = NULL) {
  if (!is.na(sidecar_lrc(path))) return(TRUE)
  if (is.null(key)) key <- file_key(path)
  isTRUE(lyrics_cache_read(key)$found)
}

.key_cache <- new.env(parent = emptyenv())
#' md5 of a file (the cache key), memoised per path + modification time + size.
#' @noRd
file_key <- function(path) {
  info <- file.info(path)
  id <- paste(normalizePath(path), info$mtime, info$size)
  .key_cache[[id]] %||% (.key_cache[[id]] <- unname(tools::md5sum(path)))
}
