# -----------------------------------------------------------------------------
# highway_output.R -- R side of the custom Shiny output binding.
#
# Data flow (one direction per channel, nothing time-critical crosses R):
#
#   R --(output value, once per chart)------> binding.js  renderValue()
#   R --(custom message "rs-highway")-------> controller  (audio URL, settings,
#                                                          play/pause/seek)
#   JS --(input <id>_ready / <id>_state)----> R           (chart loaded, ~4 Hz
#                                                          playback telemetry)
#   JS --(input <id>_judge / <id>_result)---> R           (scoring: live summary,
#                                                          end-of-run results)
#
# The render loop, audio clock and transport live entirely in the browser.
# -----------------------------------------------------------------------------

#' Locate static assets in both "package" and "plain app directory" modes.
#' @noRd
asset_dir <- function(sub) {
  # app/test mode: the project's working copy. The root is recorded when the code
  # is loaded (app.R, tests/testthat/helper-setup.R): tests run with the working
  # directory set to tests/testthat, so "inst/" relative to getwd() is not enough.
  local <- file.path(getOption("rockshiny.root", "."), "inst", sub)
  if (dir.exists(local)) return(normalizePath(local))
  pkg <- system.file(sub, package = "RockShiny")      # installed-package mode
  if (nzchar(pkg)) return(pkg)
  stop("Cannot find asset directory ", sub)
}

#' Scripts shared by the note highway and the karaoke player (karaoke_output.R):
#' the audio-master clock + output-latency routing, and the album-art decoder.
#' A separate dependency, so a page with both players loads them once.
#' @noRd
rs_core_dependency <- function() {
  htmltools::htmlDependency(
    name = "rockshiny-core", version = "0.1.0",
    src = c(file = asset_dir("highway")),
    script = c("clock.js", "dds.js")
  )
}

highway_dependency <- function() {
  htmltools::htmlDependency(
    name = "rockshiny-highway", version = "0.1.0",
    src = c(file = asset_dir("highway")),
    script = c("renderer.js", "renderer-dom.js", "renderer-lanes.js", "overlays.js", "input.js",
               "mic.js", "guide.js", "binding.js"),   # + pitch-worklet.js (loaded by mic.js); needs rs_core_dependency()
    stylesheet = "highway.css"
  )
}

#' Highway output placeholder. By default it fills its container (bslib
#' fillable card/page); give a fixed `height` and `fill = FALSE` otherwise.
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param width CSS width.
#' @param height CSS height.
#' @param fill take part in bslib's fill layout (fill the container).
#' @export
highwayOutput <- function(outputId, width = "100%", height = "100%", fill = TRUE) {
  htmltools::tagList(
    rs_core_dependency(),
    highway_dependency(),
    htmltools::bindFillRole(
      htmltools::div(
        id = outputId, class = "rs-highway", tabindex = "0",
        style = htmltools::css(width = htmltools::validateCssUnit(width),
                               height = htmltools::validateCssUnit(height))
      ),
      item = fill
    )
  )
}

#' Render a chart into a highwayOutput().
#'
#' `expr` should return NULL or `list(chart = <chart from song_chart()>,
#' song_key = <chr>, options = <list>, vocals = <song_vocals()>, art = <song_album_art()>)`
#' (all but `chart` optional). The chart is serialised
#' with chart_json() (exact control over arrays vs scalars), and sent as a
#' JSON string that the binding JSON.parse()s.
#' @param expr an expression returning the value to render (see Details).
#' @param env the environment in which to evaluate `expr`.
#' @param quoted is `expr` a quoted expression?
#' @export
renderHighway <- function(expr, env = parent.frame(), quoted = FALSE) {
  func <- shiny::exprToFunction(expr, env, quoted)
  shiny::createRenderFunction(
    func,
    function(value, session, name, ...) {
      if (is.null(value)) return(NULL)
      list(
        chart = as.character(chart_json(value$chart, value$song_key, vocals = value$vocals, art = value$art)),
        options = value$options
      )
    },
    highwayOutput
  )
}

# ---- R -> JS control channel -------------------------------------------------

highway_send <- function(session, outputId, cmd, ...) {
  session$sendCustomMessage("rs-highway", list(id = session$ns(outputId), cmd = cmd, args = list(...)))
}

#' Attach audio (URL served via addResourcePath) to a highway. `song_key`
#' guards against late audio for a song the user already navigated away from.
#' `kind = "head"` is a quick-start clip of the first `seconds`: playback starts
#' on it and is handed over seamlessly when the "full" file arrives.
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param url URL of the audio file (served by Shiny, e.g. via `addResourcePath()`).
#' @param song_key key (md5) of the song the audio belongs to; audio for another song is ignored.
#' @param kind "full" (the whole song) or "head" (a quick-start clip of the first `seconds`).
#' @param seconds length in seconds (the clip's, or the benchmark's).
#' @param time position in seconds (`*_seek()`).
#' @export
highway_set_audio <- function(session, outputId, url, song_key, kind = c("full", "head"), seconds = NULL) {
  highway_send(session, outputId, "audio", url = url, songKey = song_key, kind = match.arg(kind), seconds = seconds)
}
#' @rdname highway_set_audio
#' @export
highway_play  <- function(session, outputId) highway_send(session, outputId, "play")
#' @rdname highway_set_audio
#' @export
highway_pause <- function(session, outputId) highway_send(session, outputId, "pause")
#' @rdname highway_set_audio
#' @export
highway_seek  <- function(session, outputId, time) highway_send(session, outputId, "seek", time = time)
#' Update renderer/clock settings, e.g. list(lookahead = 3, avOffsetMs = 40,
#' invertStrings = FALSE, playbackRate = 0.75, showFretNumbers = TRUE,
#' maxDpr = 1.5, renderer = "dom", guideTones = TRUE, guideVolume = 0.6).
#' `guideTones` plays the chart with a small synth (guide.js). `maxDpr` caps the canvas pixel ratio (fill
#' cost scales with pixel count); `renderer` switches between the Canvas 2D
#' ("canvas") and HTML/SVG ("dom") backends at runtime.
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param settings named list of settings to change.
#' @export
highway_settings <- function(session, outputId, settings) {
  highway_send(session, outputId, "settings", settings = settings)
}
#' Benchmark both renderers in the user's browser on the densest part of the
#' loaded chart; results arrive as input$<outputId>_benchmark.
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param seconds length in seconds (the clip's, or the benchmark's).
#' @export
highway_benchmark <- function(session, outputId, seconds = 4) {
  highway_send(session, outputId, "benchmark", seconds = seconds)
}
#' External input trigger (e.g. MIDI or a test driver; the microphone runs in the browser):
#' `hit = TRUE` is "the due note was played now" (same as `bus.noteHit = true`
#' in JS); optional `midi`, `string`, `fret` narrow it to one note of a chord;
#' `hit = FALSE` is a wrong note. Judged only while an input source is active.
#' Results arrive as input$<outputId>_judge.
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param hit TRUE: the due note was played now; FALSE: a wrong note.
#' @param midi optional MIDI pitch, to judge one note of a chord.
#' @param string optional string number (0 = low E).
#' @param fret optional fret number.
#' @export
highway_input <- function(session, outputId, hit = TRUE, midi = NULL, string = NULL, fret = NULL) {
  highway_send(session, outputId, "input", hit = isTRUE(hit), midi = midi, string = string, fret = fret)
}
#' Calibrate the microphone input latency in the browser: plays `clicks` clicks
#' and matches the onsets the input hears (speaker bleed, or the player strumming
#' on each click). Needs the "microphone" input source. The result arrives as
#' input$<outputId>_calibration (list(ok, latencyMs, matched, clicks, spreadMs)).
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param clicks number of clicks to play.
#' @export
highway_calibrate <- function(session, outputId, clicks = 8) {
  highway_send(session, outputId, "calibrate", clicks = clicks)
}
#' Tell the results card whether the run it shows is a personal best
#' (`best`, `previous`: accuracies 0..1 or NULL).
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param new_best is the run a personal best?
#' @param best best accuracy so far (0..1) or NULL.
#' @param previous previous best (0..1) or NULL.
#' @export
highway_result_ack <- function(session, outputId, new_best, best = NULL, previous = NULL) {
  highway_send(session, outputId, "result_ack", newBest = isTRUE(new_best), best = best, previous = previous)
}
#' Show a status / error banner inside the highway.
#' @param session the Shiny session (`session` in the server function).
#' @param outputId id of the output (as given to the UI function; namespaced automatically in modules).
#' @param text message text.
#' @param level "info", "error" or "clear" (hide the banner).
#' @export
highway_status <- function(session, outputId, text, level = c("info", "error", "clear")) {
  highway_send(session, outputId, "status", text = text, level = match.arg(level))
}
