# -----------------------------------------------------------------------------
# mod_player.R -- sidebar controls (accordion), highway, audio hand-off and
# practice (Riff-Repeater-style section loop) logic.
# -----------------------------------------------------------------------------

AUDIO_URL_PREFIX <- "rs-cache"   # registered with addResourcePath() in app.R

AUDIO_FORMAT_LABELS <- c(ogg = "Ogg Vorbis", m4a = "AAC (M4A)", opus = "Ogg Opus", flac = "FLAC", wav = "WAV")

#' Sidebar: one accordion; `import_ui` (drop zone + library) goes in "Song".
#' @noRd
mod_player_controls_ui <- function(id, import_ui = NULL) {
  ns <- shiny::NS(id)
  hint <- function(...) htmltools::div(class = "rs-hint", ...)
  bslib::accordion(
    id = ns("panels"), multiple = TRUE, open = c("song", "practice"), class = "rs-accordion",
    bslib::accordion_panel(
      "Song", value = "song", icon = shiny::icon("guitar"),
      import_ui,
      shiny::selectInput(ns("arrangement"), "Arrangement", choices = NULL, width = "100%"),
      shiny::radioButtons(ns("instrument"), "Play on", inline = TRUE, width = "100%",
                          choices = c("Guitar / bass" = "guitar", "Piano" = "piano", "Harmonica" = "harmonica")),
      shiny::conditionalPanel(
        sprintf("input['%s'] == 'piano'", ns("instrument")),
        shiny::selectInput(ns("piano_octave"), "Transpose", width = "100%", selected = 0,
                           choices = c("2 octaves down" = -2, "1 octave down" = -1, "As written" = 0,
                                       "1 octave up" = 1, "2 octaves up" = 2))
      ),
      shiny::conditionalPanel(
        sprintf("input['%s'] == 'harmonica'", ns("instrument")),
        shiny::selectInput(ns("harp_key"), "Harmonica key", width = "100%",
                           choices = c("Best fit (auto)" = "auto", stats::setNames(names(HARP_KEYS), names(HARP_KEYS))))
      ),
      hint(shiny::textOutput(ns("instrument_hint"), inline = TRUE)),
      shiny::sliderInput(ns("difficulty"), "Difficulty", min = 0, max = 100, value = 100, step = 5,
                         post = "%", width = "100%"),
      hint(shiny::textOutput(ns("difficulty_hint"), inline = TRUE))
    ),
    bslib::accordion_panel(
      "Practice", value = "practice", icon = shiny::icon("repeat"),
      htmltools::div(class = "rs-row2",
        shiny::selectInput(ns("loop_from"), "From", choices = NULL, width = "100%"),
        shiny::selectInput(ns("loop_to"), "To", choices = NULL, width = "100%")
      ),
      bslib::input_switch(ns("loop"), "Loop this part", value = FALSE),
      shiny::actionButton(ns("loop_here"), "Practice current section", icon = shiny::icon("crosshairs"),
                          class = "btn-sm btn-outline-primary w-100 mb-3"),
      shiny::sliderInput(ns("lead_in"), "Lead-in before the loop", min = 0, max = 4, value = 2, step = 0.5,
                         post = " s", width = "100%"),
      htmltools::div(class = "rs-row2",
        shiny::selectInput(ns("speed"), "Speed",
                           choices = c("100%" = 1, "90%" = 0.9, "80%" = 0.8, "75%" = 0.75, "60%" = 0.6, "50%" = 0.5),
                           selected = 1, width = "100%"),
        shiny::selectInput(ns("ramp"), "Speed up / loop",
                           choices = c("Off" = 0, "+2%" = 0.02, "+5%" = 0.05, "+10%" = 0.1), width = "100%")
      ),
      hint("Tip: double-click a section in the timeline to practise it; ", htmltools::tags$kbd("L"), " toggles the loop.")
    ),
    bslib::accordion_panel(
      "Display", value = "display", icon = shiny::icon("eye"),
      shiny::sliderInput(ns("lookahead"), "Highway length", min = 1, max = 6, value = 3, step = 0.25,
                         post = " s", width = "100%"),
      bslib::input_switch(ns("lyrics"), "Lyrics", value = TRUE),
      bslib::input_switch(ns("fret_numbers"), "Fret numbers on notes", value = TRUE),
      bslib::input_switch(ns("invert"), "Tab order (high e on top)", value = FALSE),
      shiny::selectInput(ns("renderer"), "Renderer",
                         choices = c("Canvas 2D" = "canvas", "HTML / SVG" = "dom"), width = "100%")
    ),
    bslib::accordion_panel(
      "Audio & sync", value = "audio", icon = shiny::icon("headphones"),
      bslib::input_switch(ns("auto_latency"), "Compensate output latency automatically", value = TRUE),
      hint(shiny::textOutput(ns("latency_info"), inline = TRUE)),
      shiny::sliderInput(ns("av_offset"), "Fine-tune offset", min = -250, max = 250, value = 0, step = 5,
                         post = " ms", width = "100%"),
      hint("Increase if you hear notes before they reach the strings."),
      bslib::input_switch(ns("guide"), "Guide tones (synthesized chart notes)", value = FALSE),
      shiny::sliderInput(ns("guide_volume"), "Guide volume", min = 0, max = 100, value = 60, step = 5,
                         post = "%", width = "100%"),
      hint("Plays the chart with a simple synth \u2014 the only sound for MIDI songs. ",
           "Turn it off (or use headphones) while the microphone is scoring you."),
      hint(shiny::textOutput(ns("audio_info"), inline = TRUE)),
      hint(shiny::textOutput(ns("library_progress"), inline = TRUE))
    ),
    bslib::accordion_panel(
      "Scoring (beta)", value = "scoring", icon = shiny::icon("bullseye"),
      shiny::radioButtons(ns("input_source"), "Input",
                          choices = c("Off" = "none", "Microphone / instrument cable" = "microphone",
                                      "Keyboard: D F J K (testing)" = "keyboard"), width = "100%"),
      shiny::conditionalPanel(
        sprintf("input['%s'] == 'microphone'", ns("input_source")),
        shiny::selectInput(ns("input_device"), "Input device", choices = c("Default" = ""), width = "100%"),
        shiny::sliderInput(ns("input_sensitivity"), "Sensitivity", min = 0.5, max = 2, value = 1, step = 0.1,
                           width = "100%"),
        shiny::sliderInput(ns("input_latency"), "Input latency", min = 0, max = 400, value = 40, step = 1,
                           post = " ms", width = "100%"),
        shiny::actionButton(ns("calibrate"), "Calibrate latency", icon = shiny::icon("wave-square"),
                            class = "btn-sm btn-outline-primary w-100 mb-2"),
        hint(shiny::textOutput(ns("input_info"), inline = TRUE)),
        bslib::input_switch(ns("echo_cancel"), "Echo cancellation", value = FALSE),
        hint("Use headphones (or an instrument / Real Tone cable). Through speakers, the recording's own ",
             "guitar reaches the microphone and can be scored as yours; echo cancellation reduces that but can ",
             "swallow quiet notes. Browsers allow the microphone only on https:// or localhost.")
      ),
      shiny::sliderInput(ns("hit_window"), "Timing window", min = 60, max = 200, value = 120, step = 10,
                         post = " ms", width = "100%"),
      bslib::input_switch(ns("hit_feedback"), "Timing feedback (Perfect / Early / Late)", value = TRUE),
      shiny::uiOutput(ns("judge_stats")),
      hint(shiny::textOutput(ns("best_info"), inline = TRUE)),
      htmltools::div(class = "rs-history", shiny::tableOutput(ns("history")))
    ),
    bslib::accordion_panel(
      "Performance", value = "perf", icon = shiny::icon("gauge-high"),
      shiny::actionButton(ns("bench"), "Benchmark renderers", icon = shiny::icon("stopwatch"),
                          class = "btn-sm btn-outline-secondary w-100"),
      htmltools::div(class = "rs-bench-table", shiny::tableOutput(ns("bench_table"))),
      hint("Renders the busiest 3 s of the song with both renderers in your browser.")
    )
  )
}

mod_player_highway_ui <- function(id) {
  bslib::card(
    full_screen = TRUE, class = "rs-stage",
    bslib::card_body(padding = 0, highwayOutput(shiny::NS(id, "highway")))
  )
}

#' @param song reactive rs_song from mod_import_server().
#' @noRd
mod_player_server <- function(id, song) {
  shiny::moduleServer(id, function(input, output, session) {

    # ---- song-level data ---------------------------------------------------------------
    shiny::observeEvent(song(), {
      s <- song()
      arr <- s$arrangements
      shiny::updateSelectInput(session, "arrangement",
                               choices = stats::setNames(arr$id, arr$label), selected = arr$id[1])
      bslib::update_switch("guide", value = identical(s$kind, "midi"), session = session)   # MIDI: no recording
    })
    # instruments the selected arrangement can be played on
    shiny::observe({
      s <- shiny::req(song())
      shiny::req(input$arrangement %in% s$arrangements$id)
      ok <- song_instruments(s, input$arrangement)
      cur <- shiny::isolate(input$instrument) %||% "guitar"
      pref <- if (identical(s$kind, "midi")) s$arrangements$instrument[match(input$arrangement, s$arrangements$id)] else "piano"
      labels <- INSTRUMENT_LABELS[ok]
      shiny::updateRadioButtons(session, "instrument", inline = TRUE,
                                choices = stats::setNames(names(labels), unname(labels)),
                                selected = if (cur %in% ok) cur else pref)
    })
    instrument <- shiny::reactive({
      s <- shiny::req(song())
      ok <- song_instruments(s, shiny::req(input$arrangement))
      if (isTRUE(input$instrument %in% ok)) input$instrument else ok[1]
    })
    vocals <- shiny::reactive(song_vocals(shiny::req(song())))
    art <- shiny::reactive(song_album_art(shiny::req(song())))
    difficulty <- shiny::debounce(shiny::reactive(input$difficulty / 100), 350)

    chart <- shiny::reactive({
      s <- song()
      shiny::req(s, input$arrangement, input$arrangement %in% s$arrangements$id)
      shiny::withProgress(message = "Building note chart...", value = 0.5, {
        tryCatch(song_chart(s, input$arrangement, difficulty = difficulty(), instrument = instrument(),
                            octave = as.integer(input$piano_octave %||% 0L), harp_key = input$harp_key %||% "auto"),
                 error = function(e) {
          shiny::showNotification(paste("Chart error:", conditionMessage(e)), type = "error", duration = 10)
          NULL
        })
      })
    })

    output$instrument_hint <- shiny::renderText({
      ch <- shiny::req(chart())
      m <- ch$meta
      if (identical(m$instrument, "harmonica")) {
        paste0(sprintf("%s harmonica%s", m$harp_key, if (isTRUE(m$harp_auto)) " (best fit)" else ""),
               if (m$harp_octave != 0) sprintf(", melody moved %+d octave%s", m$harp_octave, if (abs(m$harp_octave) > 1) "s" else "") else "",
               if (m$harp_dropped > 0) sprintf("; %d note%s out of range left out", m$harp_dropped, if (m$harp_dropped > 1) "s" else "") else "",
               if (isTRUE(m$harp_thinned > 0)) sprintf("; fast runs thinned (%d notes)", m$harp_thinned) else "",
               ". Tab: 4 = blow, -4 = draw, ' = bend, o = overblow.")
      } else if (identical(m$instrument, "piano")) {
        sprintf("%s. Left hand (blue) below middle C, right hand (green) above.", m$instrument_tag)
      } else ""
    })

    output$difficulty_hint <- shiny::renderText({
      ch <- shiny::req(chart())
      md <- ch$meta$max_difficulty
      if (md > 0) sprintf("%d notes at %d%% \u2014 this chart has %d difficulty levels.",
                          ch$meta$n_notes, round(100 * ch$meta$difficulty), md + 1)
      else "This chart has a single difficulty level."
    })

    # ---- practice: section pickers --------------------------------------------------------
    sections <- shiny::reactive(shiny::req(chart())$sections)
    sig_of <- function(s) paste(s$label, round(s$time, 2), collapse = "|")
    section_sig <- shiny::reactiveVal("")
    shiny::observe({
      s <- sections()
      sig <- sig_of(s)
      if (identical(sig, shiny::isolate(section_sig()))) return()   # difficulty change: keep picks
      section_sig(sig)
      ch <- stats::setNames(seq_len(nrow(s)) - 1L, sprintf("%s  \u00b7  %s", s$label, format_time(s$time)))
      shiny::updateSelectInput(session, "loop_from", choices = ch, selected = 0L)
      shiny::updateSelectInput(session, "loop_to", choices = ch, selected = 0L)
      bslib::update_switch("loop", value = FALSE, session = session)
    })

    select_section <- function(i) {
      if (is.null(i) || is.na(i) || i < 0) return()
      shiny::updateSelectInput(session, "loop_from", selected = i)
      shiny::updateSelectInput(session, "loop_to", selected = i)
      bslib::update_switch("loop", value = TRUE, session = session)
      bslib::accordion_panel_open("panels", "practice", session = session)
    }
    shiny::observeEvent(input$highway_section_pick, select_section(as.integer(input$highway_section_pick$index)))
    shiny::observeEvent(input$loop_here, select_section(as.integer(input$highway_state$sectionIndex %||% 0L)))
    shiny::observeEvent(input$highway_loop_toggle, bslib::update_switch("loop", value = !isTRUE(input$loop), session = session))

    practice <- shiny::reactive({
      s <- sections()
      from <- suppressWarnings(as.integer(input$loop_from))
      to <- suppressWarnings(as.integer(input$loop_to))
      # until the pickers have been reset for *these* sections, report no loop
      ok <- identical(sig_of(s), section_sig()) &&
        length(from) && length(to) && !is.na(from) && !is.na(to) && nrow(s) > 0
      if (!ok) return(list(loop = FALSE, start = 0, end = 0, leadIn = input$lead_in, ramp = 0))
      lo <- min(from, to); hi <- max(from, to)
      end <- if (hi + 2L <= nrow(s)) s$time[hi + 2L] else shiny::isolate(chart())$meta$song_length
      list(loop = isTRUE(input$loop), start = s$time[lo + 1L], end = end,
           leadIn = input$lead_in, ramp = as.numeric(input$ramp %||% 0))
    })

    # ---- settings -> client (only changed values take effect there) -------------------------
    settings <- shiny::reactive(list(
      lookahead = input$lookahead,
      avOffsetMs = input$av_offset,
      playbackRate = as.numeric(input$speed %||% 1),
      invertStrings = isTRUE(input$invert),
      showFretNumbers = isTRUE(input$fret_numbers),
      lyrics = isTRUE(input$lyrics),
      guideTones = isTRUE(input$guide),
      guideVolume = (input$guide_volume %||% 60) / 100,
      renderer = input$renderer %||% "canvas",
      autoLatency = !isFALSE(input$auto_latency),
      inputSource = input$input_source %||% "none",
      inputDevice = input$input_device %||% "",
      inputSensitivity = input$input_sensitivity %||% 1,
      # until the slider shows the browser's value (remembered calibration or estimate),
      # do not send it: it would overwrite that value with the slider default
      inputLatencyMs = if (latency_synced()) input$input_latency else NULL,
      echoCancellation = isTRUE(input$echo_cancel),
      hitWindowMs = input$hit_window %||% 120,
      hitFeedback = !isFALSE(input$hit_feedback),
      practice = practice()
    ))

    output$highway <- renderHighway({
      ch <- chart()
      shiny::req(ch)
      list(chart = ch, song_key = shiny::isolate(song()$key), options = shiny::isolate(settings()),
           vocals = shiny::isolate(vocals()), art = shiny::isolate(art()))
    })
    shiny::observe(highway_settings(session, "highway", settings()))

    # ---- audio ----------------------------------------------------------------------------
    # Background path (sh + vgmstream): the song's job jumps the queue; a quick-start
    # clip is sent as soon as it exists, the full file when ready (seamless handover
    # in the browser). Otherwise: the synchronous fallback below.
    audio_info <- shiny::reactiveVal("Audio: waiting for a song.")
    output$audio_info <- shiny::renderText(audio_info())
    want <- shiny::reactiveVal(NULL)                       # list(key, path, formats)
    sent <- shiny::reactiveValues(head = NULL, full = NULL)
    url_for <- function(key, path) paste(AUDIO_URL_PREFIX, key, basename(path), sep = "/")

    shiny::observeEvent(input$highway_ready, {
      ready <- input$highway_ready
      s <- song()
      if (is.null(s) || !identical(ready$songKey, s$key)) return()
      if (identical(s$kind, "midi")) {                      # no recording: guide tones only
        audio_info("MIDI file: no recording \u2014 turn on guide tones to hear the part.")
        return()
      }
      formats <- as.character(unlist(ready$formats))
      audio_set_browser_formats(formats)
      have <- ready$audio %||% if (isTRUE(ready$hasAudio)) "full" else "none"
      if (identical(have, "full")) return()
      if (identical(have, "none")) { sent$head <- NULL; sent$full <- NULL }
      if (background_supported()) {
        want(list(key = s$key, path = s$arc$path, formats = formats, nonce = ready$nonce))   # nonce: always re-polls
        audio_job_enqueue(s$arc$path, s$key, full = TRUE, priority = TRUE)
        return()
      }
      highway_status(session, "highway", "Decoding audio\u2026", "info")
      path <- tryCatch(
        shiny::withProgress(message = "Decoding audio (Wwise \u2192 web)...", value = 0.3,
                            song_audio(s, browser = unlist(ready$formats))),
        error = function(e) {
          highway_status(session, "highway", paste("Audio unavailable \u2014", conditionMessage(e)), "error")
          audio_info(paste("Audio unavailable:", conditionMessage(e)))
          NULL
        }
      )
      if (!is.null(path)) {
        ext <- tools::file_ext(path)
        audio_info(sprintf("Audio: %s, %.1f MB (cached).", AUDIO_FORMAT_LABELS[[ext]] %||% ext, file.size(path) / 1e6))
        highway_set_audio(session, "highway", url_for(s$key, path), s$key)
      }
    })

    # poll the background job of the current song (cheap: a few file.exists())
    shiny::observe({
      w <- want()
      shiny::req(w)
      st <- audio_cache_state(w$key, audio_format_candidates(audio_tools(), w$formats))
      if (!is.null(st$full)) {
        if (!identical(shiny::isolate(sent$full), w$key)) {
          sent$full <- w$key
          ext <- tools::file_ext(st$full)
          audio_info(sprintf("Audio: %s, %.1f MB (cached).", AUDIO_FORMAT_LABELS[[ext]] %||% ext, file.size(st$full) / 1e6))
          highway_set_audio(session, "highway", url_for(w$key, st$full), w$key, kind = "full")
        }
        return()
      }
      if (!is.null(st$head) && !identical(shiny::isolate(sent$head), w$key)) {
        sent$head <- w$key
        audio_info("Audio: quick-start clip playing while the full song decodes\u2026")
        highway_set_audio(session, "highway", url_for(w$key, st$head), w$key, kind = "head",
                          seconds = getOption("rockshiny.head_seconds", AUDIO_HEAD_SECONDS))
      }
      if (identical(st$state, "error")) {
        highway_status(session, "highway", paste("Audio unavailable \u2014", st$message), "error")
        audio_info(paste("Audio unavailable:", st$message))
        return()
      }
      if (identical(st$state, "idle")) audio_job_enqueue(w$path, w$key, full = TRUE, priority = TRUE)
      shiny::invalidateLater(400)
    })

    output$library_progress <- shiny::renderText({
      p <- audio_prewarm_progress()
      shiny::req(p)
      if (p$ready < p$total) shiny::invalidateLater(2000)
      sprintf("Library audio pre-decoded: %d / %d songs%s.", p$ready, p$total,
              if (p$ready < p$total) " (working in the background)" else "")
    })

    # ---- microphone: devices, latency, calibration ---------------------------------------------
    latency_synced <- shiny::reactiveVal(FALSE)
    latency_pending <- shiny::reactiveVal(NULL)
    input_note <- shiny::reactiveVal("")
    shiny::observeEvent(input$highway_devices, {
      d <- input$highway_devices
      ids <- vapply(d$devices, function(x) as.character(x$id %||% ""), character(1))
      labels <- vapply(d$devices, function(x) as.character(x$label %||% "Input device"), character(1))
      keep <- nzchar(ids) & !ids %in% c("default", "communications") & !duplicated(ids)
      shiny::updateSelectInput(session, "input_device",
                               choices = c("Default" = "", stats::setNames(ids[keep], labels[keep])),
                               selected = shiny::isolate(input$input_device) %||% "")
      if (!latency_synced()) {
        v <- round(as.numeric(d$latencyMs %||% d$estimatedLatencyMs %||% 40))
        if (isTRUE(abs(shiny::isolate(input$input_latency) - v) < 1)) latency_synced(TRUE)
        else { latency_pending(v); shiny::updateSliderInput(session, "input_latency", value = v) }
      }
    })
    shiny::observeEvent(input$input_latency, {
      p <- latency_pending()
      if (!is.null(p) && abs(input$input_latency - p) < 1) { latency_pending(NULL); latency_synced(TRUE) }
    }, ignoreInit = TRUE)
    shiny::observeEvent(input$calibrate, {
      input_note("Calibrating\u2026 strum a muted string on each click.")
      highway_calibrate(session, "highway", clicks = 8)
    })
    shiny::observeEvent(input$highway_calibration, {
      cal <- input$highway_calibration
      if (isTRUE(cal$ok)) {
        latency_pending(NULL); latency_synced(TRUE)
        shiny::updateSliderInput(session, "input_latency", value = cal$latencyMs)
        input_note(sprintf("Calibrated: %d ms (%d of %d clicks, \u00b1%d ms).", as.integer(cal$latencyMs),
                           as.integer(cal$matched), as.integer(cal$clicks), as.integer(cal$spreadMs)))
      } else input_note(paste("Calibration failed:", cal$error %||% "unknown error"))
    })
    shiny::observeEvent(input$highway_input_status, {
      st <- input$highway_input_status
      input_note(if (isTRUE(st$ok)) {
        if (identical(st$source, "microphone")) sprintf("Listening on: %s.", st$label %||% "default input") else ""
      } else paste("Input unavailable:", st$error %||% "unknown error"))
    })
    output$input_info <- shiny::renderText(input_note())

    # ---- scored runs: store, compare with the personal best, history ------------------------
    scores_changed <- shiny::reactiveVal(0)
    shiny::observeEvent(input$highway_result, {
      r <- input$highway_result
      res <- tryCatch(score_save(r), error = function(e) {
        shiny::showNotification(paste("Could not save the score:", conditionMessage(e)), type = "warning")
        NULL
      })
      if (is.null(res)) return()
      scores_changed(scores_changed() + 1)
      if (identical(r$kind, "song")) {
        highway_result_ack(session, "highway", res$new_best, best = res$best, previous = res$previous)
      }
    })
    current_arrangement <- shiny::reactive({
      ch <- shiny::req(chart())
      list(key = shiny::isolate(song()$key), arrangement = ch$meta$arrangement %||% "")
    })
    history <- shiny::reactive({
      scores_changed()
      a <- current_arrangement()
      score_history(a$key, a$arrangement)
    })
    output$best_info <- shiny::renderText({
      a <- current_arrangement()
      scores_changed()
      b <- score_best(a$key, a$arrangement)
      if (is.null(b)) "" else sprintf("Personal best (full song, 100%% speed): %d%%", round(100 * b))
    })
    output$history <- shiny::renderTable({
      h <- utils::head(history(), 6)
      shiny::req(nrow(h) > 0)
      data.frame(
        When = substr(h$time, 6, 16),
        Run = ifelse(h$kind == "loop", "loop", ifelse(h$coverage >= 0.9, "song", "part")),
        Speed = sprintf("%d%%", round(100 * h$rate)),
        Accuracy = ifelse(is.na(h$accuracy), "\u2013", sprintf("%d%%", round(100 * h$accuracy))),
        check.names = FALSE
      )
    }, striped = FALSE, width = "100%", spacing = "xs")

    # ---- latency + scoring telemetry from the browser ----------------------------------------
    output$latency_info <- shiny::renderText({
      l <- input$highway_latency
      if (is.null(l)) return("Output latency: measured when you press Play.")
      if (!isTRUE(l$auto)) return(sprintf("Browser-reported output latency: %d ms (not applied).", as.integer(l$outputMs)))
      if (isTRUE(l$routed) && l$outputMs > 0) sprintf("Compensating %d ms of output latency.", as.integer(l$outputMs))
      else "Your browser does not report its output latency; use the fine-tune slider."
    })
    output$judge_stats <- shiny::renderUI({
      j <- input$highway_judge
      if (is.null(j) || identical(input$input_source, "none")) return(NULL)
      acc <- if (is.null(j$accuracy)) "\u2013" else sprintf("%d%%", round(100 * j$accuracy))
      htmltools::tags$table(class = "table table-sm rs-judge-table",
        htmltools::tags$tr(htmltools::tags$th("Accuracy"), htmltools::tags$td(acc)),
        htmltools::tags$tr(htmltools::tags$th("Hits / misses"), htmltools::tags$td(sprintf("%d / %d", j$hits, j$misses))),
        htmltools::tags$tr(htmltools::tags$th("Perfect (\u00b140 ms)"), htmltools::tags$td(j$perfect)),
        htmltools::tags$tr(htmltools::tags$th("Streak (best)"), htmltools::tags$td(sprintf("%d (%d)", j$streak, j$bestStreak))))
    })

    # ---- renderer benchmark (runs in the browser) ------------------------------------------
    shiny::observeEvent(input$bench, highway_benchmark(session, "highway", seconds = 4))
    output$bench_table <- shiny::renderTable({
      b <- input$highway_benchmark
      shiny::req(b)
      rows <- lapply(b$results, function(r) as.data.frame(r[c("renderer", "fps", "p95FrameMs", "jankPct")]))
      stats::setNames(do.call(rbind, rows), c("Renderer", "FPS", "p95 ms", "Jank %"))
    }, digits = 1, striped = FALSE, width = "100%")
  })
}

format_time <- function(t) sprintf("%d:%02d", as.integer(t %/% 60), as.integer(floor(t %% 60)))
