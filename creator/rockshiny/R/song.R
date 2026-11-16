# -----------------------------------------------------------------------------
# song.R -- high-level API used by the Shiny layer. No Shiny code in here, so
# everything is scriptable / testable from the console:
#
#   song  <- load_song("songs/Pink-Floyd_Wish-You-Were-Here_v5_DD_m.psarc")
#   song$arrangements
#   chart <- song_chart(song, "Lead")
#   audio <- song_audio(song)           # path to cached .ogg
# -----------------------------------------------------------------------------

#' Root of the on-disk cache of converted audio. Persistent by default (so the
#' background pre-decoding happens once per song, ever); override with
#' options(rockshiny.cache_dir = ...), e.g. tempdir() for throw-away caches.
#' @noRd
cache_root <- function() {
  d <- getOption("rockshiny.cache_dir", tools::R_user_dir("RockShiny", which = "cache"))
  dir.create(d, showWarnings = FALSE, recursive = TRUE)
  normalizePath(d)
}

#' Open a .psarc (or a .mid, see midi.R) and index its arrangements.
#' A .psarc whose lyrics carry pitches also gets a "Vocals (melody)"
#' arrangement (id "vocals"), playable on piano / harmonica.
#' @param path path of a .psarc or MIDI file.
#' @param display_name name shown in messages (uploads arrive with a temporary path).
#' @export
load_song <- function(path, display_name = basename(path)) {
  if (grepl("\\.(mid|midi|kar)$", display_name, ignore.case = TRUE)) return(load_midi_song(path, display_name))
  key <- file_key(path)                              # content hash = cache key (memoised md5)
  library_note_key(normalizePath(path, winslash = "/"), key)         # remembered in the library index
  arc <- psarc_open(path)
  arrangements <- list_arrangements(arc)
  if (!nrow(arrangements)) stop("No playable arrangements in ", display_name)
  first <- arrangements[1, ]
  arrangements$melody_only <- FALSE
  song <- structure(list(
    key = key,
    name = display_name,
    path = normalizePath(path, winslash = "/", mustWork = FALSE),
    kind = "psarc",
    arc = arc,
    cache_dir = file.path(cache_root(), key),
    arrangements = arrangements,
    meta = list(title = first$song, artist = first$artist, album = first$album,
                year = first$year, song_length = first$song_length)
  ), class = "rs_song")
  if (nrow(vocal_pitch_events(song_vocals_raw(song))) >= 16L) {
    v <- first
    v[] <- lapply(v, function(col) if (is.character(col)) NA_character_ else NA)
    v$id <- "vocals"; v$label <- "Vocals (melody)"; v$name <- "Vocals"; v$melody_only <- TRUE
    v$song <- first$song; v$artist <- first$artist
    song$arrangements <- rbind(arrangements, v)
  }
  song
}

#' Print a song: its arrangements.
#' @param x the object.
#' @param ... ignored.
#' @export
print.rs_song <- function(x, ...) {
  cat("<rs_song>", x$meta$artist, "-", x$meta$title, if (identical(x$kind, "midi")) "(MIDI)", "\n")
  cols <- intersect(c("id", "label", "xml", "sng", "n_notes", "instrument"), names(x$arrangements))
  print(x$arrangements[, cols], row.names = FALSE)
  invisible(x)
}

#' Instruments an arrangement can be played on ("guitar" = as charted).
#' @param song a song from `load_song()` (or `load_karaoke_song()`).
#' @param arrangement arrangement id (`song$arrangements$id`).
#' @export
song_instruments <- function(song, arrangement) {
  a <- song$arrangements[match(arrangement, song$arrangements$id), , drop = FALSE]
  melody <- identical(song$kind, "midi") || isTRUE(a$melody_only)
  if (melody) c("piano", "harmonica") else c("guitar", "piano", "harmonica")
}

#' Arrangements from the JSON manifests (authoritative names + metadata),
#' falling back to the file listing when manifests are missing.
#' @noRd
list_arrangements <- function(arc) {
  files <- arc$entries$name
  xmls <- files[grepl("^songs/arr/.*\\.xml$", files)]
  sngs <- files[grepl("^songs/bin/.*\\.sng$", files)]
  manifests <- files[grepl("^manifests/.*\\.json$", files)]
  base_of <- function(p) sub("\\.(xml|sng|json)$", "", basename(p))

  rows <- lapply(manifests, function(m) {
    j <- tryCatch(jsonlite::fromJSON(rawToChar(psarc_read(arc, m)), simplifyVector = FALSE),
                  error = function(e) NULL)
    a <- j$Entries[[1]]$Attributes
    if (is.null(a) || is.null(a$ArrangementName)) return(NULL)
    if (a$ArrangementName %in% c("Vocals", "JVocals", "ShowLights")) return(NULL)
    b <- base_of(m)
    data.frame(
      base = b, name = a$ArrangementName, song = a$SongName %||% NA, artist = a$ArtistName %||% NA,
      album = a$AlbumName %||% NA, year = as.character(a$SongYear %||% NA),
      song_length = as.numeric(a$SongLength %||% NA),
      tuning = paste(unlist(a$Tuning), collapse = " "),
      stringsAsFactors = FALSE
    )
  })
  df <- do.call(rbind, rows)
  if (is.null(df)) {                                  # no manifests: infer from files
    b <- unique(base_of(c(xmls, sngs)))
    b <- b[!grepl("_(vocals|jvocals|showlights)$", b)]
    na <- rep(NA, length(b))                                            # b may be empty
    df <- data.frame(base = b, name = tools::toTitleCase(sub(".*_", "", b)), song = na, artist = na,
                     album = na, year = na, song_length = na, tuning = na, stringsAsFactors = FALSE)
  }
  df$xml <- xmls[match(df$base, base_of(xmls))]
  df$sng <- sngs[match(df$base, base_of(sngs))]
  df <- df[!is.na(df$xml) | !is.na(df$sng), , drop = FALSE]

  order_key <- match(sub("[0-9]+$", "", df$name), c("Lead", "Rhythm", "Combo", "Bass"))
  df <- df[order(order_key, df$base), , drop = FALSE]
  df$label <- make_unique_labels(df$name)
  df$id <- df$base
  rownames(df) <- NULL
  df
}

make_unique_labels <- function(x) {
  out <- x
  for (v in unique(x[duplicated(x)])) {
    i <- which(x == v)
    out[i] <- paste(v, seq_along(i))
  }
  out
}

#' Parse one arrangement (XML preferred; SNG fallback for official DLC),
#' optionally converted to another instrument (instruments.R).
#' @param arrangement id (file base name) or label, e.g. "Lead"; "vocals" = the
#'   pitched vocal melody; for MIDI songs a part id from midi_parts().
#' @param source "auto", "xml" or "sng".
#' @param instrument "guitar" (as charted), "piano" or "harmonica".
#' @param octave piano: transpose by octaves.
#' @param harp_key harmonica key or "auto".
#' @param song a song from `load_song()` (or `load_karaoke_song()`).
#' @param difficulty 0..1 share of each phrase's maximum difficulty.
#' @export
song_chart <- function(song, arrangement = NULL, source = c("auto", "xml", "sng"), difficulty = 1,
                       instrument = c("guitar", "piano", "harmonica"), octave = 0L, harp_key = "auto") {
  source <- match.arg(source)
  instrument <- match.arg(instrument)
  if (identical(song$kind, "midi")) return(midi_song_chart(song, arrangement, instrument, octave, harp_key))
  if (identical(arrangement, "vocals")) {
    if (instrument == "guitar") instrument <- "piano"
    base <- song_chart(song, song$arrangements$id[!song$arrangements$melody_only][1], source = source)
    base$meta$arrangement <- "Vocals"
    ev <- vocal_pitch_events(song_vocals_raw(song))
    base$chords <- base$chords[0, , drop = FALSE]
    return(chart_for_instrument(base, instrument, ev = ev, octave = octave, harp_key = harp_key))
  }
  arr <- song$arrangements
  row <- if (is.null(arrangement)) 1L else match(arrangement, arr$id, nomatch = match(arrangement, arr$label))
  if (is.na(row)) stop("Unknown arrangement: ", arrangement)
  a <- arr[row, ]

  use_xml <- !is.na(a$xml) && source != "sng"
  if (!use_xml && is.na(a$sng)) stop("Arrangement has no XML or SNG chart.")
  raw <- if (use_xml) {
    parse_arrangement_xml(psarc_read(song$arc, a$xml))
  } else {
    platform <- if (grepl("/macos/", a$sng)) "mac" else if (grepl("/generic/", a$sng)) "pc" else "auto"
    parse_arrangement_sng(sng_decrypt(psarc_read(song$arc, a$sng), platform))
  }

  # manifest metadata wins over (often incomplete) chart metadata
  m <- raw$meta
  m$title  <- a$song %|NA|% m$title %|NA|% song$meta$title
  m$artist <- a$artist %|NA|% m$artist
  m$album  <- a$album %|NA|% m$album
  m$year   <- a$year %|NA|% m$year
  m$arrangement <- a$label
  m$is_bass <- isTRUE(m$is_bass) || grepl("^Bass", a$name)
  if (is.null(m$song_length) || is.na(m$song_length)) m$song_length <- a$song_length
  raw$meta <- m
  chart_for_instrument(build_chart(raw, difficulty), instrument, octave = octave, harp_key = harp_key)
}

#' Chart of one MIDI part (piano by default; harmonica on request).
#' @noRd
midi_song_chart <- function(song, part_id = NULL, instrument = "piano", octave = 0L, harp_key = "auto") {
  parts <- song$arrangements
  row <- if (is.null(part_id)) 1L else match(part_id, parts$id, nomatch = match(part_id, parts$label))
  if (is.na(row)) stop("Unknown MIDI part: ", part_id)
  part <- parts[row, ]
  if (instrument == "guitar") instrument <- part$instrument
  src <- list(
    meta = list(title = song$meta$title, artist = song$meta$artist, song_length = song$meta$song_length,
                arrangement = part$label, difficulty = 1, max_difficulty = 0L, source = "midi"),
    chords = data.frame(time = numeric(), name = character(), high_density = logical()),
    beats = song$beats, sections = song$sections
  )
  chart_for_instrument(src, instrument, ev = midi_part_events(song$midi, part), octave = octave, harp_key = harp_key)
}

#' Album art: the 256 px .dds (DXT1) as base64; decoded to pixels in the browser.
#' @param song a song from `load_song()` (or `load_karaoke_song()`).
#' @export
song_album_art <- function(song) {
  if (is.null(song$arc)) return(NULL)
  dds <- psarc_find(song$arc, "album_art/.*\\.dds$")
  if (!length(dds)) return(NULL)
  best <- dds[grepl("_256\\.dds$", dds)][1]
  if (is.na(best)) best <- dds[which.max(song$arc$entries$length[match(dds, song$arc$entries$name)])]
  tryCatch(jsonlite::base64_enc(psarc_read(song$arc, best)), error = function(e) NULL)
}

`%|NA|%` <- function(a, b) if (is.null(a) || length(a) == 0L || is.na(a) || identical(a, "")) b else a

#' Extract + convert the song audio once per psarc (cached by content hash).
#' @param browser format ids the client can play (from canPlayType), or NULL.
#' @param song a song from `load_song()` (or `load_karaoke_song()`).
#' @param preferred "auto" or a format id to try first.
#' @return Path to the web-playable audio file.
#' @export
song_audio <- function(song, browser = NULL, preferred = getOption("rockshiny.audio_format", "auto")) {
  dir.create(song$cache_dir, showWarnings = FALSE, recursive = TRUE)
  tools <- audio_tools()
  formats <- audio_format_candidates(tools, browser, preferred)

  # reuse a cached conversion in any acceptable format (best first)
  cached <- file.path(song$cache_dir, paste0("audio.", vapply(AUDIO_FORMATS[formats], function(f) f$ext, character(1))))
  hit <- cached[file.exists(cached) & file.size(cached) > 0]
  if (length(hit)) return(hit[1])

  wem_name <- find_song_wem(song$arc)
  wem <- file.path(song$cache_dir, "audio.wem")
  psarc_read(song$arc, wem_name, out = wem)
  on.exit(unlink(wem), add = TRUE)
  convert_wem(wem, file.path(song$cache_dir, "audio"), formats, tools)
}
