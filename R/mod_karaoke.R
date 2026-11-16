# -----------------------------------------------------------------------------
# mod_karaoke.R -- the karaoke mode: its own sidebar (song, display, audio &
# sync, HTML export) and lyrics stage. Independent of the note highway
# (mod_player.R): separate song, player, audio element and settings. Only
# songs with lyrics can be opened (karaoke.R).
#
#   UI:     mod_karaoke_controls_ui("karaoke")   sidebar
#           mod_karaoke_stage_ui("karaoke")      the lyrics stage (fills its container)
#   server: mod_karaoke_server("karaoke", request = reactive(list(path, name)))
#           `request` (optional) opens a song from elsewhere in the app, e.g. the
#           "Sing along" button of the instrument mode.
# -----------------------------------------------------------------------------

#' Sidebar. `extra_ui` goes at the end of the "Song" panel (e.g. a link to the
#' instrument mode).
#' @noRd
mod_karaoke_controls_ui <- function(id, extra_ui = NULL, library_ui = NULL) {
  ns <- shiny::NS(id)
  hint <- function(...) htmltools::div(class = "rs-hint", ...)
  online <- isTRUE(getOption("rockshiny.lyrics_online", TRUE))
  bslib::accordion(
    id = ns("panels"), multiple = TRUE, open = c("song", "display"), class = "rs-accordion",
    bslib::accordion_panel(
      "Song", value = "song", icon = shiny::icon("microphone-lines"),
      dropzone_dependency(),
      htmltools::div(
        class = "rs-dropzone", `data-accept` = ".psarc,.lrc", tabindex = "0", role = "button",
        `aria-label` = "Drop or browse for a .psarc song, or a .lrc lyrics file for the current song",
        htmltools::div(class = "rs-dropzone-icon", shiny::icon("cloud-arrow-up")),
        htmltools::div(class = "rs-dropzone-label",
          htmltools::strong("Drop a .psarc (or a .lrc)"), htmltools::span("a .lrc gives the current song its lyrics")),
        shiny::fileInput(ns("file"), NULL, accept = c(".psarc", ".lrc"), width = "100%")
      ),
      shiny::selectizeInput(ns("library"), "Songs", choices = "", width = "100%",       # filled by the server
                            options = list(placeholder = "Search songs\u2026", maxOptions = 100000)),
      shiny::actionButton(ns("shuffle"), "Shuffle", icon = shiny::icon("shuffle"), class = "btn-sm rs-shuffle",
                          title = "Another song with lyrics, picked at random"),
      library_ui,
      hint(shiny::textOutput(ns("library_info"), inline = TRUE)),
      bslib::input_switch(ns("online"), "Look up missing lyrics online (LRCLIB)", value = online),
      hint(shiny::textOutput(ns("song_info"), inline = TRUE)),
      extra_ui
    ),
    bslib::accordion_panel(
      "Display", value = "display", icon = shiny::icon("eye"),
      shiny::radioButtons(ns("view"), "View", inline = TRUE, width = "100%",
                          choices = c("Stage" = "stage", "Lyric sheet" = "sheet")),
      shiny::sliderInput(ns("text_size"), "Text size", min = 60, max = 160, value = 100, step = 10,
                         post = "%", width = "100%"),
      bslib::input_switch(ns("count_in"), "Count-in before each verse", value = TRUE),
      bslib::input_switch(ns("section_labels"), "Section names", value = TRUE),
      bslib::input_switch(ns("backdrop"), "Album art backdrop", value = TRUE)
    ),
    bslib::accordion_panel(
      "Audio & sync", value = "audio", icon = shiny::icon("headphones"),
      bslib::input_switch(ns("auto_latency"), "Compensate output latency automatically", value = TRUE),
      hint(shiny::textOutput(ns("latency_info"), inline = TRUE)),
      shiny::sliderInput(ns("offset"), "Lyrics timing", min = -2000, max = 2000, value = 0, step = 10,
                         post = " ms", width = "100%"),
      hint("Increase if the words light up before you hear them; decrease if they lag."),
      shiny::selectInput(ns("speed"), "Speed", width = "100%", selected = 1,
                         choices = c("100%" = 1, "90%" = 0.9, "80%" = 0.8, "75%" = 0.75)),
      hint(shiny::textOutput(ns("audio_info"), inline = TRUE))
    ),
    bslib::accordion_panel(
      "Sing & score", value = "sing", icon = shiny::icon("star"),
      bslib::input_switch(ns("sing"), "Score my singing (microphone)", value = FALSE),
      hint("Your voice, compared as you sing with the song's melody (when its chart has one) or with the notes its ",
           "singer uses in each line. Sing in any octave. Use headphones, or turn the original voice down."),
      shiny::sliderInput(ns("voice"), "Original voice", min = 0, max = 100, value = 100, step = 5, post = "%", width = "100%"),
      bslib::input_switch(ns("voice_mute"), "Mute the original voice", value = FALSE),
      hint("Estimated from the stereo mix: the centre of the mix is turned down while lines are sung."),
      hint(shiny::textOutput(ns("sing_info"), inline = TRUE)),
      shiny::tableOutput(ns("sing_history"))
    ),
    bslib::accordion_panel(
      "Take it with you", value = "export", icon = shiny::icon("file-export"),
      shiny::uiOutput(ns("export_ui")),
      hint("One self-contained web page: the lyrics, album art and the song audio, with the same player. ",
           "Opens offline in any browser, no R needed. Only share it if you have the rights to the recording.")
    )
  )
}

mod_karaoke_stage_ui <- function(id) {
  bslib::card(
    full_screen = TRUE, class = "rs-stage",
    bslib::card_body(padding = 0, karaokeOutput(shiny::NS(id, "stage")))
  )
}

#' @param request optional reactive yielding list(path, name) to open a song
#'   from elsewhere in the app (checked for lyrics like any other song).
#' @return the current rs_karaoke_song as a reactive (NULL until one is open).
#' @noRd
mod_karaoke_server <- function(id, request = NULL, lib = NULL) {
  shiny::moduleServer(id, function(input, output, session) {
    # ---- the song list: songs with lyrics (+ those to look up online) -----------------------
    if (is.null(lib)) lib <- shiny::reactive(library_current())
    groups <- shiny::reactive(karaoke_groups(lib()))
    offered <- shiny::reactiveVal(NULL)
    shiny::observe({
      g <- groups()
      online <- !isFALSE(input$online)
      ch <- list(`Songs with lyrics` = as.list(g$with))
      if (length(g$online)) ch[[if (online) "Find the lyrics online" else "No lyrics yet (add a .lrc file)"]] <- as.list(g$online)
      if (length(g$unknown)) ch[["Not checked yet"]] <- as.list(g$unknown)
      if (identical(ch, shiny::isolate(offered()))) return()
      offered(ch)
      paths <- unlist(ch, use.names = FALSE)
      on_stage <- shiny::isolate(current())$path
      keep <- if (isTRUE(on_stage %in% paths)) on_stage else shiny::isolate(if (isTRUE(input$library %in% paths)) input$library else "")
      shiny::updateSelectizeInput(session, "library", choices = c(list(""), ch), selected = keep)
    })
    output$library_info <- shiny::renderText({
      g <- groups()
      online <- !isFALSE(input$online)
      paste0(sprintf("%d of the library's songs have lyrics", length(g$with)),
             if (length(g$online)) sprintf("; %d without %s", length(g$online),
                                           if (online) "are looked up online (LRCLIB) when opened" else "need a .lrc file") else "",
             if (length(g$unknown)) sprintf("; %d not checked yet", length(g$unknown)) else "", ".")
    })
    in_library <- function(path) isTRUE(path %in% unlist(offered(), use.names = FALSE))

    # ---- song selection (library, upload, or a request from the instrument mode) ----------
    selected <- shiny::reactiveVal(NULL)
    stage <- session$ns("stage")
    open <- function(path, name, zone = NULL) {
      k <- shiny::isolate(current())
      if (!is.null(k) && identical(normalizePath(path, winslash = "/", mustWork = FALSE),
                                   normalizePath(k$path, winslash = "/", mustWork = FALSE))) {      # already on stage
        if (!is.null(zone)) rs_loading(session, stage, "end", zone = zone)
        return(invisible())
      }
      rs_loading(session, stage, "start", text = paste0("Opening ", song_label(path, name), "\u2026"),
                 sub = "Reading the lyrics", zone = zone, name = name)
      selected(list(path = path, name = name, nonce = as.numeric(Sys.time())))
    }
    shiny::observeEvent(input$file, {
      f <- input$file
      if (grepl("\\.lrc$", f$name, ignore.case = TRUE)) { attach_lrc(f$datapath, f$name); return() }
      path <- tryCatch(library_store_upload(f$datapath, f$name), error = function(e) {
        shiny::showNotification(conditionMessage(e), type = "warning", duration = 6)
        f$datapath
      })
      open(path, f$name, zone = session$ns("file"))
    })
    shiny::observeEvent(input$shuffle, {                         # a song with lyrics, picked at random
      path <- random_song(lib(), "lyrics")
      if (is.null(path)) return()
      open(path, basename(path))
      if (in_library(path)) shiny::updateSelectizeInput(session, "library", selected = path)
    })
    shiny::observeEvent(input$library, {
      shiny::req(nzchar(input$library))
      shiny::req(in_library(input$library))                      # only files the library offers
      open(input$library, basename(input$library))
    }, ignoreInit = TRUE)
    if (!is.null(request)) {
      shiny::observeEvent(request(), {
        r <- request()
        shiny::req(r$path)
        open(r$path, r$name %||% basename(r$path))
        if (in_library(r$path)) shiny::updateSelectizeInput(session, "library", selected = r$path)
      })
    }

    # the song on stage: replaced only by a song that opened fine (a file without
    # lyrics shows a message and keeps the current song)
    current <- shiny::reactiveVal(NULL)
    shiny::observeEvent(selected(), {
      sel <- selected()
      k <- tryCatch(load_karaoke_song(sel$path, sel$name, online = !isFALSE(input$online)), error = function(e) {
        rs_loading(session, stage, "error", text = conditionMessage(e))
        shiny::showNotification(conditionMessage(e), type = "warning", duration = 8)
        NULL
      })
      if (!is.null(k)) current(k)
    })

    # a dropped .lrc: the current song's lyrics (synced to the audio in the browser, then cached)
    attach_lrc <- function(file, name) {
      k <- current()
      if (is.null(k)) {
        shiny::showNotification("Open a song first, then drop its .lrc lyrics.", type = "warning", duration = 6)
        return()
      }
      lrc <- read_text(file)
      if (!nrow(parse_lrc(lrc))) {
        shiny::showNotification(paste(name, "contains no lyrics."), type = "warning", duration = 6)
        return()
      }
      l <- lyrics_result(list(lrc = lrc, source = "file", synced = if (any(!is.na(parse_lrc(lrc)$time))) "line" else "none"))
      lyrics_cache_write(k$key, c(list(found = TRUE), l[c("lrc", "source", "synced")]))
      k$lyrics <- l
      k$vocals <- k$vocals[0, , drop = FALSE]
      current(k)
      shiny::showNotification(sprintf("Lyrics from %s: syncing them to the song\u2026", name), duration = 4)
    }
    aligned <- shiny::reactiveVal(NULL)                        # list(key, offsetMs, moved)
    shiny::observeEvent(input$stage_aligned, {
      a <- input$stage_aligned
      k <- current()
      if (is.null(k) || !identical(a$songKey, k$key)) return()
      lyrics_cache_offset(k$key, a$offsetMs)
      aligned(list(key = k$key, offsetMs = a$offsetMs, moved = isTRUE(a$moved)))
    })
    shiny::observeEvent(input$stage_lyrics, {                  # found online by the browser
      l <- input$stage_lyrics
      k <- current()
      if (is.null(k) || !identical(l$songKey, k$key) || is.null(l$lyrics$lrc)) return()
      lyrics_cache_write(k$key, list(found = TRUE, lrc = l$lyrics$lrc, source = "lrclib", synced = l$lyrics$synced %||% "line",
                                     lrc_duration = l$lyrics$lrcDuration %||% NA, url = l$lyrics$url %||% NA))
    })

    output$song_info <- shiny::renderText({
      k <- shiny::req(current())
      if (!is.null(k$lyrics$lookup)) return("No lyrics in the file: looking them up online\u2026")
      if (!is.null(k$lyrics$lrc)) {
        n <- nrow(parse_lrc(k$lyrics$lrc))
        from <- if (identical(k$lyrics$source, "file")) "a .lrc file" else "LRCLIB (lrclib.net)"
        if (identical(k$lyrics$synced, "none")) return(sprintf("Lyrics from %s: %d lines, without timing (shown as a sheet).", from, n))
        a <- aligned()
        off <- if (!is.null(a) && identical(a$key, k$key)) a$offsetMs else k$lyrics$offset_ms
        sync <- if (is.null(off)) "they are synced to this recording when its audio is ready"
                else if (abs(off) < 60) "they fit this recording as they are"
                else sprintf("synced to this recording: %+.2f s", off / 1000)
        return(sprintf("Lyrics from %s, timed by line (%d lines; the syllable highlight is estimated); %s. Fine-tune with Lyrics timing.",
                       from, n, sync))
      }
      v <- k$vocals
      sprintf("%d lines, %d syllables; singing from %s to %s.", length(unique(v$line)), nrow(v),
              format_time(min(v$time)), format_time(max(v$time + v$length)))
    })

    # ---- player + settings ------------------------------------------------------------------
    settings <- shiny::reactive(list(
      view = input$view %||% "stage",
      textScale = (input$text_size %||% 100) / 100,
      countIn = !isFALSE(input$count_in),
      sectionLabels = !isFALSE(input$section_labels),
      backdrop = !isFALSE(input$backdrop),
      offsetMs = input$offset %||% 0,
      autoLatency = !isFALSE(input$auto_latency),
      playbackRate = as.numeric(input$speed %||% 1)
    ))
    output$stage <- renderKaraoke({
      k <- shiny::req(current())
      list(song = k, options = shiny::isolate(settings()))
    })
    shiny::observe(karaoke_settings(session, "stage", settings()))

    output$latency_info <- shiny::renderText({
      l <- input$stage_latency
      if (is.null(l)) return("Output latency: measured when you press Play.")
      if (!isTRUE(l$auto)) return(sprintf("Browser-reported output latency: %d ms (not applied).", as.integer(l$outputMs)))
      if (isTRUE(l$routed) && l$outputMs > 0) sprintf("Compensating %d ms of output latency.", as.integer(l$outputMs))
      else "Your browser does not report its output latency; use the timing slider."
    })

    # ---- audio: same cache and background conversion as the note highway ---------------------
    audio_info <- audio_feed(
      ready = shiny::reactive(input$stage_ready),
      song = current,
      send = function(url, key, kind, seconds) karaoke_set_audio(session, "stage", url, key, kind, seconds),
      status = function(text, level) karaoke_status(session, "stage", text, level)
    )
    output$audio_info <- shiny::renderText(audio_info())

    # ---- Sing & score: microphone, original voice, results ----------------------------------
    shiny::observeEvent(input$sing, karaoke_sing(session, "stage", isTRUE(input$sing)), ignoreInit = TRUE)
    shiny::observeEvent(list(input$voice, input$voice_mute), {
      karaoke_voice(session, "stage", volume = (input$voice %||% 100) / 100, mute = isTRUE(input$voice_mute))
    }, ignoreInit = TRUE)
    shiny::observeEvent(input$stage_voice, {                  # changed on the player itself (or restored there)
      v <- input$stage_voice
      if (!identical(round(100 * (v$volume %||% 1)), round(input$voice %||% 100))) shiny::updateSliderInput(session, "voice", value = round(100 * v$volume))
      if (!identical(isTRUE(v$mute), isTRUE(input$voice_mute))) bslib::update_switch("voice_mute", value = isTRUE(v$mute))
    })
    shiny::observeEvent(input$stage_sing, {
      v <- input$stage_sing
      if (!identical(isTRUE(v$on), isTRUE(input$sing))) bslib::update_switch("sing", value = isTRUE(v$on))
      if (!is.null(v$error)) shiny::showNotification(paste("Microphone:", v$error), type = "warning", duration = 8)
    })
    scored <- shiny::reactiveVal(0)
    shiny::observeEvent(input$stage_score, {
      r <- input$stage_score
      k <- current()
      res <- tryCatch(sing_score_save(r, k), error = function(e) NULL)
      if (is.null(res)) return()
      karaoke_send(session, "stage", "score_ack", newBest = isTRUE(res$new_best), best = res$best, previous = res$previous)
      scored(scored() + 1)
    })
    output$sing_info <- shiny::renderText({
      scored()
      k <- shiny::req(current())
      b <- sing_score_best(k$key)
      if (is.null(b)) "No complete run of this song yet." else sprintf("Your best on this song: %s points.", format(b, big.mark = ","))
    })
    output$sing_history <- shiny::renderTable({
      scored()
      k <- shiny::req(current())
      d <- score_history(k$key, "vocals", kind = "sing")
      shiny::req(nrow(d))
      d <- utils::head(d, 5)
      data.frame(When = substr(d$time, 6, 16), Points = format(d$score, big.mark = ","),
                 Lines = sprintf("%d/%d", as.integer(d$hits), as.integer(d$hits + d$misses)), check.names = FALSE)
    }, striped = FALSE, spacing = "xs", width = "100%", class = "rs-history")

    # ---- standalone HTML page ---------------------------------------------------------------
    output$export_ui <- shiny::renderUI({
      shiny::req(current())
      shiny::downloadButton(session$ns("export"), "Download as HTML", icon = shiny::icon("download"),
                            class = "btn-sm btn-outline-primary w-100 mb-2")
    })
    output$export <- shiny::downloadHandler(
      filename = function() {
        k <- current()
        paste0(if (is.null(k)) "karaoke" else karaoke_slug(k), "-karaoke.html")
      },
      content = function(file) {
        k <- current()
        if (is.null(k)) stop("No song loaded.")
        if (!is.null(k$lyrics$lrc)) k$lyrics$offset_ms <- lyrics_cache_read(k$key)$offset_ms %||% k$lyrics$offset_ms
        shiny::withProgress(message = "Building the karaoke page\u2026", value = 0.5, session = session, {
          withCallingHandlers(
            karaoke_export_html(k, file, audio = "embed"),
            warning = function(w) {
              shiny::showNotification(conditionMessage(w), type = "warning", duration = 10, session = session)
              invokeRestart("muffleWarning")
            }
          )
        })
      }
    )

    current
  })
}
