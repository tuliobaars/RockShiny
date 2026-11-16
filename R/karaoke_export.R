# -----------------------------------------------------------------------------
# karaoke_export.R -- the karaoke player as a standalone HTML page (the "HTML"
# delivery format): one file that opens in any browser, offline, no R needed.
#
# The page runs the very same front end as the Shiny app (inst/karaoke/
# karaoke.js + clock.js + dds.js, inlined) behind a small page host
# (karaoke-page.js): song picker, view / text size / timing / speed controls,
# full screen, and "Load audio..." to pair the lyrics with any local file.
#
#   karaoke_export_html("songs/Dire-Straits_Sultans-of-Swing_v443_m.psarc", "sultans.html")
#   karaoke_export_html(karaoke_choices(), "songbook.html", audio = "files")
#   karaoke_export_library("~/Rocksmith/dlc", "karaoke/index.html")   # big libraries: songs load when picked
#
# Audio: the song's converted audio (the cache the app uses; converted on the
# spot when missing, which needs vgmstream-cli + ffmpeg like the app). Only
# share pages with embedded audio when you have the rights to the recording.
# -----------------------------------------------------------------------------

#' Write a standalone karaoke page.
#'
#' @param songs one or more .psarc paths (songs with lyrics) or rs_karaoke_song
#'   objects; several songs make a songbook with a song picker.
#' @param file output .html path.
#' @param audio "embed" (default: audio inside the page, a single portable
#'   file), "files" (audio copied next to the page, in `<file>_files/`) or
#'   "none" (lyrics only; the page offers "Load audio...").
#' @param audio_format "auto" keeps the cached conversion (Ogg Vorbis for most
#'   browsers); "mp3" or "m4a" re-encode with ffmpeg for the widest browser
#'   support (e.g. older Safari has no Ogg).
#' @param title page title (default: the song, or "RockShiny karaoke").
#' @param options initial player settings, as in karaoke_settings().
#' @param online look up lyrics on LRCLIB for songs whose archive has none (lyrics_online.R).
#' @param lookup_in_browser keep songs whose lyrics were not found (e.g. offline):
#'   the page looks them up itself when opened (LRCLIB, from the browser).
#' @return `file`, invisibly.
#' @export
karaoke_export_html <- function(songs, file = "karaoke.html", audio = c("embed", "files", "none"),
                                audio_format = c("auto", "mp3", "m4a"), title = NULL, options = list(),
                                online = getOption("rockshiny.lyrics_online", TRUE), lookup_in_browser = FALSE) {
  audio <- match.arg(audio)
  audio_format <- match.arg(audio_format)
  if (inherits(songs, "rs_karaoke_song")) songs <- list(songs)
  songs <- lapply(songs, function(s) {
    if (inherits(s, "rs_karaoke_song")) s else load_karaoke_song(s, online = online, allow_missing = lookup_in_browser)
  })
  if (!length(songs)) stop("No songs to export.", call. = FALSE)
  if (audio == "embed" && length(songs) > KARAOKE_EMBED_MAX) {
    stop(length(songs), " songs are too many to embed their audio in one page (at most ", KARAOKE_EMBED_MAX,
         "): use audio = \"files\", or karaoke_export_library() for a whole library.", call. = FALSE)
  }

  files_dir <- paste0(tools::file_path_sans_ext(file), "_files")
  payloads <- character(length(songs))
  blobs <- character(0)
  for (i in seq_along(songs)) {
    k <- songs[[i]]
    a <- NULL
    if (audio != "none") {
      src <- tryCatch(karaoke_export_audio(k, audio_format), error = function(e) {
        warning("No audio for ", k$meta$title %|NA|% k$name, ": ", conditionMessage(e),
                " (the page will offer 'Load audio...').", call. = FALSE)
        NULL
      })
      if (!is.null(src)) {
        ext <- tolower(tools::file_ext(src))
        mime <- KARAOKE_AUDIO_MIME[[ext]] %||% "application/octet-stream"
        if (audio == "embed") {
          id <- sprintf("rs-karaoke-audio-%d", i)
          blobs <- c(blobs, sprintf('<script type="text/plain" id="%s">%s</script>', id,
                                    jsonlite::base64_enc(readBin(src, "raw", file.size(src)))))
          a <- list(embed = id, type = mime)
        } else {
          dir.create(files_dir, showWarnings = FALSE, recursive = TRUE)
          dest <- file.path(files_dir, paste0(karaoke_slug(k), ".", ext))
          file.copy(src, dest, overwrite = TRUE)
          a <- list(src = paste(basename(files_dir), basename(dest), sep = "/"), type = mime)
        }
      }
    }
    payloads[i] <- karaoke_json(k, audio = a)
  }

  if (is.null(title)) {
    m <- songs[[1]]$meta
    title <- if (length(songs) == 1L) paste0(m$title %|NA|% songs[[1]]$name, " \u2014 karaoke") else "RockShiny karaoke"
  }
  karaoke_write_page(file, title, options, payloads, blobs)
}

#' page.html filled with the player, its page host and the data (songs: JSON strings).
#' @noRd
karaoke_write_page <- function(file, title, options, payloads, blobs = character()) {
  data <- paste0('{"format":"rockshiny-karaoke-page/1","title":', jsonlite::toJSON(jsonlite::unbox(title)),
                 ',"options":', if (length(options)) jsonlite::toJSON(options, auto_unbox = TRUE) else "{}",
                 ',"songs":[', paste(payloads, collapse = ","), "]}")

  asset <- function(dir, f) paste(readLines(file.path(asset_dir(dir), f), encoding = "UTF-8", warn = FALSE), collapse = "\n")
  script <- function(code) paste0("<script>\n", gsub("</(script)", "<\\\\/\\1", code, ignore.case = TRUE, perl = TRUE), "\n</script>")
  html <- asset("karaoke", "page.html")
  html <- karaoke_fill(html, "{{TITLE}}", karaoke_html_escape(title))
  html <- karaoke_fill(html, "{{STYLE}}", paste0("<style>\n", asset("karaoke", "karaoke.css"), "\n", asset("karaoke", "page.css"), "\n</style>"))
  html <- karaoke_fill(html, "{{DATA}}", paste0('<script type="application/json" id="rs-karaoke-data">',
                                                  karaoke_json_for_html(data), "</script>"))
  html <- karaoke_fill(html, "{{AUDIO}}", paste(blobs, collapse = "\n"))
  html <- karaoke_fill(html, "{{SCRIPTS}}", paste(script(asset("highway", "clock.js")), script(asset("highway", "dds.js")),
                                                  script(asset("karaoke", "karaoke.js")), script(asset("karaoke", "karaoke-sync.js")),
                                                  script(asset("karaoke", "karaoke-voice.js")), script(asset("karaoke", "karaoke-sing.js")),
                                                  script(asset("karaoke", "karaoke-page.js")),
                                                  sep = "\n"))
  dir.create(dirname(normalizePath(file, mustWork = FALSE)), showWarnings = FALSE, recursive = TRUE)
  con <- file(file, open = "wb")
  on.exit(close(con), add = TRUE)
  writeBin(charToRaw(enc2utf8(html)), con)
  invisible(file)
}

# ---- catalogs: big libraries ----------------------------------------------------------------

#' Most songs with embedded audio in one page (karaoke_export_html(audio = "embed")):
#' every song adds ~5-10 MB of base64 text that the browser parses up front.
#' @noRd
KARAOKE_EMBED_MAX <- 12L

#' Write a karaoke catalog of a library folder: one page listing the songs that
#' can be sung (from the library index -- no archive is opened to list them),
#' and one small script per song that the page loads when the song is picked:
#' `<file>`, `<file>_files/songs/<id>.js`, `<file>_files/audio/<id>.<ext>`.
#' Opens from disk (file://) or any static web server. Songs already written
#' (and not changed since) are kept, so re-running it only adds what is new.
#' tools/karaoke_export_html.py --library DIR writes the same catalog (and can
#' serve one that builds each song only when it is first opened: --serve).
#'
#' @param dir library folder;
#' @param recursive include subfolders.
#' @param file the page.
#' @param audio "files" (converted like the app does; the
#'   slow part: about one audio conversion per song) or "none" (lyrics only;
#'   the page offers "Audio..." to pair a local file).
#' @param lookup_in_browser keep songs without lyrics: the page looks them up online when opened.
#' @param audio_format "auto" keeps the cached conversion; "mp3" or "m4a" re-encode with ffmpeg.
#' @param title page title.
#' @param options initial player settings, as in `karaoke_settings()`.
#' @param online look up lyrics on LRCLIB for songs whose archive has none.
#' @return `file`, invisibly.
#' @export
karaoke_export_library <- function(dir = library_dir(), file = "karaoke.html", audio = c("files", "none"),
                                   audio_format = c("auto", "mp3", "m4a"), recursive = library_recursive(),
                                   title = "RockShiny karaoke", options = list(),
                                   online = getOption("rockshiny.lyrics_online", TRUE), lookup_in_browser = TRUE) {
  audio <- match.arg(audio)
  audio_format <- match.arg(audio_format)
  lib <- library_open(dir, recursive, budget = Inf)
  g <- karaoke_groups(lib, extra = FALSE)
  paths <- c(g$with, if (lookup_in_browser) g$online)
  if (!length(paths)) stop("None of the songs in ", dir, " has lyrics.", call. = FALSE)
  songs <- lib$songs[match(paths, lib$songs$path), , drop = FALSE]
  files_dir <- paste0(tools::file_path_sans_ext(file), "_files")
  rel <- basename(files_dir)
  base <- normalizePath(dir, winslash = "/")
  keep <- logical(nrow(songs))
  stubs <- character(nrow(songs))
  for (i in seq_len(nrow(songs))) {
    e <- songs[i, , drop = FALSE]
    id <- karaoke_catalog_id(substring(e$path, nchar(base) + 2L), e$artist, e$title)
    js <- file.path(files_dir, "songs", paste0(id, ".js"))
    keep[i] <- file.exists(js) && file.mtime(js) >= file.mtime(e$path)
    if (!keep[i]) {
      k <- tryCatch(load_karaoke_song(e$path, online = online, allow_missing = lookup_in_browser), error = function(err) {
        message("  skipped ", e$label, ": ", conditionMessage(err))
        NULL
      })
      if (!is.null(k)) {
        a <- NULL
        if (audio == "files") {
          src <- tryCatch(karaoke_export_audio(k, audio_format), error = function(err) {
            warning("No audio for ", e$label, ": ", conditionMessage(err), call. = FALSE)
            NULL
          })
          if (!is.null(src)) {
            ext <- tolower(tools::file_ext(src))
            dir.create(file.path(files_dir, "audio"), showWarnings = FALSE, recursive = TRUE)
            file.copy(src, file.path(files_dir, "audio", paste0(id, ".", ext)), overwrite = TRUE)
            a <- list(src = paste(rel, "audio", paste0(id, ".", ext), sep = "/"),
                      type = KARAOKE_AUDIO_MIME[[ext]] %||% "application/octet-stream")
          }
        }
        dir.create(dirname(js), showWarnings = FALSE, recursive = TRUE)
        writeLines(paste0("RSKaraokeSong(", jsonlite::toJSON(jsonlite::unbox(id)), ",", karaoke_json(k, audio = a), ");"),
                   js, useBytes = TRUE)
        keep[i] <- TRUE
      }
    }
    stubs[i] <- karaoke_catalog_stub(e, id, rel)
  }
  karaoke_write_page(file, title, options, stubs[keep])
  invisible(file)
}

#' Stable id of a catalog song: "artist-title-" + 6 hex digits of the md5 of its
#' path inside the library folder (so ids survive moving the folder).
#' @noRd
karaoke_catalog_id <- function(path, artist, title) {
  s <- paste(if (is.na(artist)) "" else artist, if (is.na(title)) "" else title, sep = "-")
  s <- tolower(gsub("^-+|-+$", "", gsub("[^A-Za-z0-9]+", "-", ascii_fold(s))))
  s <- gsub("-+$", "", substr(s, 1L, 60L))
  paste0(if (nzchar(s)) s else "song", "-", substr(openssl::md5(path), 1L, 6L))
}

#' A catalog entry (JSON): what the page lists before the song is loaded.
#' @noRd
karaoke_catalog_stub <- function(e, id, rel) {
  u <- function(x) jsonlite::unbox(if (is.null(x) || !length(x) || is.na(x)) NA else x)
  jsonlite::toJSON(list(
    id = u(id),
    meta = list(title = u(e$title), artist = u(e$artist), album = u(e$album), year = u(e$year),
                duration = u(if (is.na(e$length)) NA else round(e$length, 3))),
    lyrics = u(if (isTRUE(e$lyrics)) "archive" else "web"),
    src = u(paste(rel, "songs", paste0(id, ".js"), sep = "/"))
  ), auto_unbox = FALSE, digits = NA, na = "null", null = "null")
}

KARAOKE_AUDIO_MIME <- list(ogg = "audio/ogg", opus = "audio/ogg", m4a = "audio/mp4", mp3 = "audio/mpeg",
                           flac = "audio/flac", wav = "audio/wav")

#' Audio file for an exported page: the cached conversion (or a fresh one),
#' optionally re-encoded to MP3 / AAC (cached as export.<ext>).
#' @noRd
karaoke_export_audio <- function(song, format = "auto") {
  src <- audio_cache_state(song$key)$full %||% song_audio(song)
  if (identical(format, "auto") || identical(tools::file_ext(src), format)) return(src)
  out <- file.path(song$cache_dir, paste0("export.", format))
  if (file.exists(out) && file.size(out) > 0 && file.mtime(out) >= file.mtime(src)) return(out)
  tools <- audio_tools()
  if (is.na(tools$ffmpeg)) stop("ffmpeg is needed to re-encode the audio as ", format)
  args <- if (format == "mp3") c("-c:a", "libmp3lame", "-q:a", "2") else AUDIO_FORMATS$m4a$args
  part <- paste0(out, ".partial.", format)
  on.exit(unlink(part), add = TRUE)
  run_tool(tools$ffmpeg, c("-y", "-hide_banner", "-loglevel", "error", "-i", shQuote(src), "-vn", args, shQuote(part)))
  if (!file.rename(part, out)) stop("could not write ", out)
  out
}

karaoke_slug <- function(song) {
  s <- paste(song$meta$artist %|NA|% "", song$meta$title %|NA|% song$key, sep = "-")
  s <- gsub("[^A-Za-z0-9]+", "-", ascii_fold(s))
  s <- gsub("^-+|-+$", "", s)
  if (nzchar(s)) tolower(s) else substr(song$key, 1, 12)
}

#' Replace the first `key` in `x` with `value`, literally (no regex, no escapes).
#' @noRd
karaoke_fill <- function(x, key, value) {
  i <- regexpr(key, x, fixed = TRUE)
  if (i < 0) stop("template placeholder ", key, " not found")
  paste0(substr(x, 1L, i - 1L), value, substr(x, i + nchar(key), nchar(x)))
}

karaoke_html_escape <- function(x) {
  x <- gsub("&", "&amp;", x, fixed = TRUE)
  x <- gsub("<", "&lt;", x, fixed = TRUE)
  gsub(">", "&gt;", x, fixed = TRUE)
}

#' JSON inside <script>: "<" only occurs inside JSON strings, where < is equivalent.
#' @noRd
karaoke_json_for_html <- function(json) gsub("<", "\\u003c", json, fixed = TRUE)
