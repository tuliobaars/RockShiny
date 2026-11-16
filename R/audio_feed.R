# -----------------------------------------------------------------------------
# audio_feed.R -- serve a song's audio to a browser player, reusable by any
# player module (the karaoke mode uses it; mod_player has the same logic inline).
#
# When the player reports `<id>_ready` (song on screen + the formats the
# browser plays):
#   * background path (sh + vgmstream): the song's conversion job jumps the
#     queue (audio_jobs.R); a quick-start clip is sent as soon as it exists,
#     the full file when it is ready (the browser hands over seamlessly);
#   * otherwise the synchronous song_audio() fallback.
# Converted files are cached by content hash, so a song that the library
# warm-up (or the note highway) already converted starts immediately.
# -----------------------------------------------------------------------------

#' @param ready reactive returning the player's `<id>_ready` input value
#'   (list(songKey, audio = "none"|"head"|"full", formats, nonce)).
#' @param song reactive returning the current song: a list with `key` and
#'   `path` (or `arc$path`); `song_audio()` also needs `arc` and `cache_dir`.
#' @param send function(url, key, kind, seconds) forwarding the audio URL to
#'   the player (e.g. karaoke_set_audio()).
#' @param status function(text, level) for the player's banner.
#' @return A reactiveVal with a one-line description for the sidebar.
#' @noRd
audio_feed <- function(ready, song, send, status) {
  info <- shiny::reactiveVal("Audio: waiting for a song.")
  want <- shiny::reactiveVal(NULL)                               # list(key, path, formats, nonce)
  sent <- shiny::reactiveValues(head = NULL, full = NULL)
  url_for <- function(key, path) paste(AUDIO_URL_PREFIX, key, basename(path), sep = "/")
  label <- function(path) {
    ext <- tools::file_ext(path)
    sprintf("Audio: %s, %.1f MB (cached).", AUDIO_FORMAT_LABELS[[ext]] %||% ext, file.size(path) / 1e6)
  }

  shiny::observeEvent(ready(), {
    r <- ready()
    s <- song()
    if (is.null(s) || !identical(r$songKey, s$key)) return()
    formats <- as.character(unlist(r$formats))
    audio_set_browser_formats(formats)
    have <- r$audio %||% "none"
    if (identical(have, "full")) return()
    if (identical(have, "none")) { sent$head <- NULL; sent$full <- NULL }
    path <- s$path %||% s$arc$path
    if (background_supported()) {
      want(list(key = s$key, path = path, formats = formats, nonce = r$nonce))   # nonce: always re-polls
      audio_job_enqueue(path, s$key, full = TRUE, priority = TRUE)
      return()
    }
    status("Decoding audio\u2026", "info")
    out <- tryCatch(
      shiny::withProgress(message = "Decoding audio (Wwise \u2192 web)...", value = 0.3,
                          song_audio(s, browser = formats)),
      error = function(e) {
        status(paste("Audio unavailable \u2014", conditionMessage(e)), "error")
        info(paste("Audio unavailable:", conditionMessage(e)))
        NULL
      }
    )
    if (!is.null(out)) {
      info(label(out))
      send(url_for(s$key, out), s$key, "full", NULL)
    }
  })

  # poll the background job of the current song (cheap: a few file.exists())
  shiny::observe({
    w <- want()
    shiny::req(w)
    cur <- shiny::isolate(song())
    if (is.null(cur) || !identical(cur$key, w$key)) return()      # the user moved on
    st <- audio_cache_state(w$key, audio_format_candidates(audio_tools(), w$formats))
    if (!is.null(st$full)) {
      if (!identical(shiny::isolate(sent$full), w$key)) {
        sent$full <- w$key
        info(label(st$full))
        send(url_for(w$key, st$full), w$key, "full", NULL)
      }
      return()
    }
    if (!is.null(st$head) && !identical(shiny::isolate(sent$head), w$key)) {
      sent$head <- w$key
      info("Audio: quick-start clip playing while the full song decodes\u2026")
      send(url_for(w$key, st$head), w$key, "head", getOption("rockshiny.head_seconds", AUDIO_HEAD_SECONDS))
    }
    if (identical(st$state, "error")) {
      status(paste("Audio unavailable \u2014", st$message), "error")
      info(paste("Audio unavailable:", st$message))
      return()
    }
    if (identical(st$state, "idle")) audio_job_enqueue(w$path, w$key, full = TRUE, priority = TRUE)
    shiny::invalidateLater(400)
  })

  info
}
