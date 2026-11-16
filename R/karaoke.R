# -----------------------------------------------------------------------------
# karaoke.R -- lyrics-first song model for the karaoke mode (no Shiny code).
#
# A karaoke song needs only what a singer sees and hears: the lyrics (vocals
# XML, or the vocals SNG of official DLC -- see vocals.R), the song metadata
# and section list (from any instrument manifest), the album art and the audio
# (the same cached conversion the note highway uses, keyed by the file's md5).
# No note chart is parsed, so opening a song is fast.
#
#   k <- load_karaoke_song("songs/Dire-Straits_Sultans-of-Swing_v443_m.psarc")
#   k                                  # title, lines, syllables
#   karaoke_choices()                  # library songs that have lyrics
#   karaoke_json(k)                    # payload for the browser (karaoke.js)
#   karaoke_export_html(k, "sultans.html")   # standalone page, see karaoke_export.R
# -----------------------------------------------------------------------------

KARAOKE_FORMAT <- "rockshiny-karaoke/1"

.lyrics_cache <- new.env(parent = emptyenv())

#' Does a file carry lyrics? TRUE for a .psarc whose vocals track has at least
#' one non-empty syllable. Cached per path + modification time + size, so the
#' library filter costs one archive scan per song, ever (per R session).
#' @param path file path.
#' @export
song_has_lyrics <- function(path) {
  if (!grepl("\\.psarc$", path, ignore.case = TRUE) || !file.exists(path)) return(FALSE)
  info <- file.info(path)
  key <- paste(normalizePath(path), info$mtime, info$size)
  hit <- .lyrics_cache[[key]]
  if (!is.null(hit)) return(hit)
  ok <- tryCatch(lyrics_present(song_vocals_raw(list(arc = psarc_open(path)))), error = function(e) FALSE)
  .lyrics_cache[[key]] <- ok
  ok
}

lyrics_present <- function(v) !is.null(v) && nrow(v) > 0L && any(nzchar(trimws(sub("[+-]+$", "", v$lyric[!is.na(v$lyric)]))))

#' Karaoke library: the songs of a folder that have lyrics -- in the archive,
#' in a sidecar .lrc, or found online before (lyrics_online.R); see
#' karaoke_groups() (library.R). Values are full paths, labels "Artist -- Title".
#' @param dir library folder.
#' @param recursive include subfolders.
#' @export
karaoke_choices <- function(dir = library_dir(), recursive = FALSE) {
  karaoke_groups(library_open(dir, recursive, budget = Inf), extra = FALSE)$with
}

#' Library songs without lyrics (yet): candidates for the online lookup.
#' @param dir library folder.
#' @param recursive include subfolders.
#' @export
karaoke_choices_online <- function(dir = library_dir(), recursive = FALSE) {
  karaoke_groups(library_open(dir, recursive, budget = Inf), extra = FALSE)$online
}

karaoke_lyrics_known <- function(path) {
  grepl("\\.psarc$", path, ignore.case = TRUE) && tryCatch(lyrics_known(path), error = function(e) FALSE)
}

#' Song metadata and sections from the archive's instrument manifests (the
#' vocals manifest has neither). Falls back to the library label (file name).
#' @noRd
karaoke_manifest <- function(arc, path = arc$path) {
  meta <- NULL
  sections <- data.frame(name = character(), number = integer(), time = numeric(), stringsAsFactors = FALSE)
  for (m in psarc_find(arc, "^manifests/.*\\.json$")) {
    a <- tryCatch(jsonlite::fromJSON(rawToChar(psarc_read(arc, m)), simplifyVector = FALSE)$Entries[[1]]$Attributes,
                  error = function(e) NULL)
    if (is.null(a) || is.null(a$SongName)) next
    if (is.null(meta)) {
      meta <- list(title = a$SongName, artist = a$ArtistName %||% NA_character_, album = a$AlbumName %||% NA_character_,
                   year = as.character(a$SongYear %||% NA), song_length = as.numeric(a$SongLength %||% NA))
    }
    s <- a$Sections
    if (length(s)) {
      sections <- data.frame(
        name = vapply(s, function(x) as.character(x$Name %||% ""), character(1)),
        number = vapply(s, function(x) as.integer(x$Number %||% NA), integer(1)),
        time = vapply(s, function(x) as.numeric(x$StartTime %||% NA), numeric(1)),
        stringsAsFactors = FALSE
      )
      break
    }
  }
  if (is.null(meta)) {
    lm <- library_meta(path)
    meta <- list(title = lm$song, artist = lm$artist, album = lm$album, year = NA_character_, song_length = NA_real_)
  }
  sections <- sections[!is.na(sections$time) & nzchar(sections$name), , drop = FALSE]
  sections <- sections[order(sections$time), , drop = FALSE]
  list(meta = meta, sections = section_labels(sections))
}

#' Open a .psarc for karaoke. Lyrics come from the archive; if it has none,
#' from lyrics_lookup() (sidecar .lrc, cache, LRCLIB). Errors if there are none.
#' @param path file path.
#' @param display_name name shown in messages (uploads
#'   arrive with a temporary path).
#' @param online look lyrics up on LRCLIB when the archive has none.
#' @param fetch HTTP function for the lookup (tests pass a fake).
#' @param allow_missing return the song without lyrics instead of an error; its
#'   page then looks them up in the browser (karaoke_export_html(lookup_in_browser = TRUE)).
#' @return An "rs_karaoke_song": key (md5, shared with the audio cache), name,
#'   path, arc, cache_dir, meta (title, artist, album, year, song_length),
#'   vocals (vocals_lines()), sections (name, number, time, label), art.
#' @export
load_karaoke_song <- function(path, display_name = basename(path), online = getOption("rockshiny.lyrics_online", TRUE),
                              fetch = lrclib_fetch, allow_missing = FALSE) {
  if (!grepl("\\.psarc$", display_name, ignore.case = TRUE)) {
    stop("Karaoke needs a Rocksmith .psarc file (", display_name, " is not one).", call. = FALSE)
  }
  arc <- psarc_open(path)
  raw <- song_vocals_raw(list(arc = arc))
  key <- file_key(path)
  library_note_key(normalizePath(path, winslash = "/"), key)
  m <- karaoke_manifest(arc, path)
  lyrics <- NULL
  if (!lyrics_present(raw)) {
    lyrics <- lyrics_lookup(path, key, m$meta, online = online, fetch = fetch)
    offline <- inherits(lyrics, "lyrics_offline")
    if (offline) lyrics <- NULL
    if (is.null(lyrics) && !allow_missing) {
      stop(display_name, " has no lyrics in the file",
           if (offline) ", and the online lookup (LRCLIB) could not be reached" else if (isTRUE(online)) ", and none were found online (LRCLIB)" else "",
           ". Put a .lrc file next to it (same name) or drop one on the karaoke sidebar.", call. = FALSE)
    }
    if (is.null(lyrics)) {
      lyrics <- list(lookup = list(artist = m$meta$artist %|NA|% "", title = m$meta$title %|NA|% "",
                                   album = m$meta$album %|NA|% "", duration = m$meta$song_length %|NA|% NA_real_))
    }
    raw <- data.frame(time = numeric(), length = numeric(), lyric = character(), note = numeric(), stringsAsFactors = FALSE)
  }
  structure(list(
    key = key,
    name = display_name,
    kind = "psarc",
    path = arc$path,
    arc = arc,
    cache_dir = file.path(cache_root(), key),
    meta = m$meta,
    sections = m$sections,
    vocals = vocals_lines(raw),
    notes = raw$note[order(raw$time)],   # charted pitches (254 = unpitched): the singing score's melody
    lyrics = lyrics,                   # NULL: lyrics from the archive; else list(lrc, source, ...) or list(lookup)
    art = song_album_art(list(arc = arc))
  ), class = "rs_karaoke_song")
}

#' Print a karaoke song: title, lyrics source, lines.
#' @param x the object.
#' @param ... ignored.
#' @export
print.rs_karaoke_song <- function(x, ...) {
  v <- x$vocals
  cat("<rs_karaoke_song>", x$meta$artist %|NA|% "Unknown artist", "-", x$meta$title %|NA|% x$name, "\n")
  if (!is.null(x$lyrics$lrc)) {
    l <- parse_lrc(x$lyrics$lrc)
    cat(sprintf("  lyrics from %s (%s): %d lines\n", if (identical(x$lyrics$source, "file")) "a .lrc file" else "LRCLIB",
                if (identical(x$lyrics$synced, "none")) "no timing" else "timed by line; syllables estimated", nrow(l)))
  } else if (!is.null(x$lyrics$lookup)) cat("  no lyrics yet: looked up in the browser\n")
  if (nrow(v)) {
    cat(sprintf("  %d lines, %d syllables, sung from %s to %s\n", length(unique(v$line)), nrow(v),
                format_time(min(v$time)), format_time(max(v$time + v$length))))
    first <- v[v$line == v$line[1], , drop = FALSE]
    cat("  first line: ", karaoke_line_text(first), "\n", sep = "")
  }
  invisible(x)
}

#' Display text of syllables (vocals_lines() rows): joined syllables have no space.
#' @noRd
karaoke_line_text <- function(v) {
  trimws(paste0(v$text, ifelse(v$join, "", " "), collapse = ""))
}

#' One line of text per lyric line (handy in the console and for tests).
#' @param song a song from `load_karaoke_song()`.
#' @export
karaoke_lines <- function(song) {
  if (!is.null(song$lyrics$lrc)) return(parse_lrc(song$lyrics$lrc)$text)
  v <- song$vocals
  vapply(split(v, v$line), karaoke_line_text, character(1), USE.NAMES = FALSE)
}

#' Serialise a karaoke song for the browser. Columns, not rows, as in
#' chart_json(): `vocals` has the same shape as the highway's lyrics
#' (t, d, w, j, l), so both frontends read lyrics the same way.
#' @param audio optional list(src =, type =) or list(embed =, type =) for
#'   standalone pages (karaoke_export_html()); Shiny sends audio separately.
#' @param song a song from `load_karaoke_song()`.
#' @export
karaoke_json <- function(song, audio = NULL) {
  v <- song$vocals
  s <- song$sections
  m <- song$meta
  one <- function(x) jsonlite::unbox(if (is.null(x) || !length(x)) NA else x[[1]])
  payload <- list(
    format = jsonlite::unbox(KARAOKE_FORMAT),
    songKey = jsonlite::unbox(song$key),
    meta = list(title = one(m$title), artist = one(m$artist), album = one(m$album), year = one(m$year),
                duration = one(round(as.numeric(m$song_length %||% NA), 3))),
    vocals = list(t = round(v$time, 3), d = round(v$length, 3), w = v$text, j = as.integer(v$join),
                  l = as.integer(v$line)),
    sections = list(t = round(s$time, 3), name = as.character(s$name), label = as.character(s$label))
  )
  if (karaoke_melody(song$notes)) payload$vocals$n <- as.integer(song$notes)   # a sung melody: scored note by note
  if (!is.null(song$lyrics)) payload$lyrics <- karaoke_lyrics_json(song$lyrics)
  if (!is.null(song$art)) payload$art <- jsonlite::unbox(song$art)
  if (!is.null(audio)) payload$audio <- lapply(audio, jsonlite::unbox)
  jsonlite::toJSON(payload, auto_unbox = FALSE, digits = NA, na = "null", null = "null")
}

#' Do the charted vocal pitches look like a melody? Rocksmith writes 254 for
#' "no pitch"; some charts fill in one constant or 0. At least 8 pitched notes,
#' 4 different ones, spanning 5 semitones (karaoke-sing.js applies the same test).
#' @noRd
karaoke_melody <- function(n) {
  p <- n[!is.na(n) & n != 254 & n > 20 & n < 110]
  length(p) >= 8L && length(unique(p)) >= 4L && diff(range(p)) >= 5
}

#' The "lyrics" member of the payload (camelCase for the browser; order fixed,
#' mirrored by tools/karaoke_export_html.py).
#' @noRd
karaoke_lyrics_json <- function(l) {
  u <- function(x) jsonlite::unbox(if (is.null(x) || !length(x)) NA else x)
  if (!is.null(l$lookup)) {
    return(list(source = u("lookup"), align = u(TRUE),
                lookup = list(artist = u(l$lookup$artist), title = u(l$lookup$title), album = u(l$lookup$album),
                              duration = u(l$lookup$duration))))
  }
  out <- list(source = u(l$source), synced = u(l$synced), lrc = u(l$lrc), lrcDuration = u(l$lrc_duration),
              url = u(l$url), align = u(TRUE))
  if (!is.null(l$offset_ms) && !is.na(l$offset_ms)) out$offsetMs <- u(round(as.numeric(l$offset_ms)))
  out
}
