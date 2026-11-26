# -----------------------------------------------------------------------------
# karaoke_output.R -- R side of the karaoke output binding (inst/karaoke/).
#
# Same channels as the note highway (highway_output.R), with their own names:
#
#   R --(output value, once per song)-------> karaoke-shiny.js  renderValue()
#   R --(custom message "rs-karaoke")-------> player (audio URL, settings,
#                                                     play / pause / seek, status)
#   JS --(input <id>_ready)-----------------> R      (song on screen: send audio)
#   JS --(input <id>_latency)---------------> R      (output-latency compensation)
#   JS --(input <id>_aligned)---------------> R      (LRC lyrics synced to the recording: cache it)
#
# Highlighting runs entirely in the browser, on the audio-master clock that the
# highway uses (clock.js): nothing time-critical crosses the websocket.
# -----------------------------------------------------------------------------

karaoke_dependency <- function() {
  htmltools::htmlDependency(
    name = "rockshiny-karaoke", version = "0.1.0",
    src = c(file = asset_dir("karaoke")),
    script = c("karaoke.js", "karaoke-sync.js", "karaoke-voice.js", "karaoke-sing.js", "karaoke-shiny.js"),   # needs rs_core_dependency() (clock.js, dds.js)
    stylesheet = "karaoke.css"
  )
}

#' Karaoke output placeholder. Fills its container by default (bslib fillable
#' card/page); give a fixed `height` and `fill = FALSE` otherwise.
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param width CSS width.
#' @param height CSS height.
#' @param fill take part in bslib's fill layout (fill the container).
#' @export
karaokeOutput <- function(outputId, width = "100%", height = "100%", fill = TRUE) {
  htmltools::tagList(
    rs_core_dependency(),
    karaoke_dependency(),
    htmltools::bindFillRole(
      htmltools::div(
        id = outputId, class = "rs-karaoke", tabindex = "0",
        style = htmltools::css(width = htmltools::validateCssUnit(width),
                               height = htmltools::validateCssUnit(height))
      ),
      item = fill
    )
  )
}

#' Render a karaoke song into a karaokeOutput().
#'
#' `expr` returns NULL, an rs_karaoke_song (load_karaoke_song()), or
#' `list(song = <rs_karaoke_song>, options = <list>)`; options as in
#' karaoke_settings(). The song is sent as a pre-serialised JSON string
#' (karaoke_json()), parsed once by the browser.
#' @param expr an expression returning the value to render (see Details).
#' @param env the environment in which to evaluate `expr`.
#' @param quoted is `expr` a quoted expression?
#' @export
renderKaraoke <- function(expr, env = parent.frame(), quoted = FALSE) {
  func <- shiny::exprToFunction(expr, env, quoted)
  shiny::createRenderFunction(
    func,
    function(value, session, name, ...) {
      if (is.null(value)) return(NULL)
      song <- if (inherits(value, "rs_karaoke_song")) value else value$song
      if (is.null(song)) return(NULL)
      list(song = as.character(karaoke_json(song)),
           options = if (inherits(value, "rs_karaoke_song")) NULL else value$options)
    },
    karaokeOutput
  )
}

# ---- R -> JS control channel -------------------------------------------------

karaoke_send <- function(session, outputId, cmd, ...) {
  session$sendCustomMessage("rs-karaoke", list(id = session$ns(outputId), cmd = cmd, args = list(...)))
}

#' Attach audio (a URL served via addResourcePath) to a karaoke player.
#' `song_key` guards against late audio for a song the user already left;
#' `kind = "head"` is a quick-start clip of the first `seconds`, handed over
#' seamlessly when the "full" file arrives (as in highway_set_audio()).
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param url URL of the audio file (served by Shiny, e.g. via `addResourcePath()`).
#' @param song_key key (md5) of the song the audio belongs to; audio for another song is ignored.
#' @param kind "full" (the whole song) or "head" (a quick-start clip of the first `seconds`).
#' @param seconds length in seconds (the clip's, or the benchmark's).
#' @param time position in seconds (`*_seek()`).
#' @export
karaoke_set_audio <- function(session, outputId, url, song_key, kind = c("full", "head"), seconds = NULL) {
  karaoke_send(session, outputId, "audio", url = url, songKey = song_key, kind = match.arg(kind), seconds = seconds)
}
#' @rdname karaoke_set_audio
#' @export
karaoke_play  <- function(session, outputId) karaoke_send(session, outputId, "play")
#' @rdname karaoke_set_audio
#' @export
karaoke_pause <- function(session, outputId) karaoke_send(session, outputId, "pause")
#' @rdname karaoke_set_audio
#' @export
karaoke_seek  <- function(session, outputId, time) karaoke_send(session, outputId, "seek", time = time)
#' Update player settings; any subset of
#' list(view = "stage" | "sheet", textScale = 1, countIn = TRUE, sectionLabels = TRUE,
#'      backdrop = TRUE, offsetMs = 0, autoLatency = TRUE, playbackRate = 1).
#' `offsetMs` > 0 highlights later (as the highway's fine-tune offset).
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param settings named list of settings to change.
#' @export
karaoke_settings <- function(session, outputId, settings) {
  karaoke_send(session, outputId, "settings", settings = settings)
}
#' Show a status / error banner inside the player.
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param text message text.
#' @param level "info", "error" or "clear" (hide the banner).
#' @export
karaoke_status <- function(session, outputId, text, level = c("info", "error", "clear")) {
  karaoke_send(session, outputId, "status", text = text, level = match.arg(level))
}

#' Sing & score: switch the microphone scoring on or off, set the original voice.
#' @param session the Shiny session.
#' @param outputId id of the karaoke output.
#' @param on TRUE to start scoring (the browser asks for the microphone), FALSE to stop.
#' @param volume the original voice's volume, 0..1.
#' @param mute mute it.
#' @export
karaoke_sing <- function(session, outputId, on = TRUE) karaoke_send(session, outputId, "sing", on = isTRUE(on))
#' @rdname karaoke_sing
#' @export
karaoke_voice <- function(session, outputId, volume = NULL, mute = NULL) {
  karaoke_send(session, outputId, "voice", volume = volume, mute = mute)
}

