# -----------------------------------------------------------------------------
# mod_project.R -- "Song": open a song to edit (RockShiny's library, or a
# dropped .psarc) or start a new one from an audio file.
#
#   UI:     mod_project_ui("project")                 an accordion panel
#   server: mod_project_server("project", studio, lib)
# -----------------------------------------------------------------------------

CREATOR_AUDIO_EXT <- c("mp3", "ogg", "oga", "wav", "flac", "m4a", "aac", "opus", "webm", "wem")

#' @noRd
mod_project_ui <- function(id) {
  ns <- shiny::NS(id)
  bslib::accordion_panel(
    "Song", value = "song", icon = shiny::icon("music"),
    dropzone_dependency(),
    htmltools::div(
      class = "rs-dropzone", `data-accept` = paste0(".psarc,", paste0(".", CREATOR_AUDIO_EXT, collapse = ",")),
      tabindex = "0", role = "button", `aria-label` = "Drop or browse for a .psarc or an audio file",
      htmltools::div(class = "rs-dropzone-icon", shiny::icon("cloud-arrow-up")),
      htmltools::div(class = "rs-dropzone-label",
        htmltools::strong("Drop a .psarc or audio"), htmltools::span("or click to browse")),
      shiny::fileInput(ns("file"), NULL, accept = c(".psarc", paste0(".", CREATOR_AUDIO_EXT)), width = "100%")
    ),
    shiny::selectizeInput(ns("library"), "From the library", choices = "", width = "100%",
                          options = list(placeholder = "Search songs\u2026", maxOptions = 100000)),
    htmltools::div(class = "rsc-songbtns",
      shiny::actionButton(ns("new"), "New song\u2026", icon = shiny::icon("plus"), class = "btn-sm rs-shuffle",
                          title = "Start a new song from an audio file"),
      htmltools::tags$button(type = "button", class = "btn btn-sm rs-shuffle", `data-rsc-help` = sub("project-$", "studio-studio", ns("")),
                             `data-rsc-what` = "demo", title = "Night Drive: a song made from scratch, to try everything on",
                             shiny::icon("music"), "Demo song")),
    htmltools::div(class = "rs-hint", "A .psarc opens for editing; an audio file (mp3, ogg, wav, flac, m4a, .wem) starts a new song."),
    shiny::uiOutput(ns("state"))
  )
}

#' The new-song form.
#' @noRd
creator_new_song_modal <- function(ns, audio_name = NULL, guess = list()) {
  shiny::modalDialog(
    title = "New song", size = "m", easyClose = TRUE, class = "rsc-modal",
    if (is.null(audio_name)) shiny::fileInput(ns("audio"), "Audio (mp3, ogg, wav, flac, m4a or a Wwise .wem)",
                                              accept = paste0(".", CREATOR_AUDIO_EXT), width = "100%")
    else htmltools::p(class = "rs-hint", style = "margin:0 0 .8rem", "Audio: ", htmltools::strong(audio_name)),
    htmltools::div(class = "rs-row2",
      shiny::textInput(ns("title"), "Title", guess$title %||% "", width = "100%"),
      shiny::textInput(ns("artist"), "Artist", guess$artist %||% "", width = "100%")),
    htmltools::div(class = "rs-row2",
      shiny::textInput(ns("album"), "Album", "", width = "100%"),
      shiny::textInput(ns("year"), "Year", format(Sys.Date(), "%Y"), width = "100%")),
    htmltools::div(class = "rsc-checks",
      shiny::checkboxGroupInput(ns("charts"), "Charts", c(Lead = "lead", Rhythm = "rhythm", Bass = "bass"),
                                selected = c("lead", "bass"), inline = TRUE)),
    htmltools::div(class = "rs-row2",
      shiny::selectInput(ns("tuning"), "Tuning", c("E standard", "Drop D", "Eb standard", "Drop C#", "D standard", "Drop C",
                                                   "Open G", "Open D", "Open E", "DADGAD", "C standard", "B standard"), width = "100%"),
      shiny::numericInput(ns("bpm"), "Tempo (BPM, empty = detect)", NA, min = 30, max = 300, width = "100%")),
    shiny::radioButtons(ns("platform"), "Package for", c(PC = "pc", Mac = "mac"), inline = TRUE),
    shiny::checkboxInput(ns("draft"), "Draft the rhythm and bass charts from the audio (rough: to correct by ear)", FALSE),
    htmltools::p(class = "rs-hint", "The beat grid is found in the audio; the audio is stored as 16-bit PCM (a Wwise .wem is used as it is)."),
    footer = htmltools::tagList(shiny::modalButton("Cancel"),
                                shiny::actionButton(ns("create"), "Create the song", class = "btn-primary", icon = shiny::icon("wand-magic-sparkles")))
  )
}

#' Artist and title from a file name like "Artist - Title.mp3".
#' @noRd
creator_guess_name <- function(name) {
  b <- gsub("_", " ", tools::file_path_sans_ext(basename(name)))
  m <- regmatches(b, regexec("^(.*?)\\s+-\\s+(.*)$", b))[[1]]
  if (length(m) == 3L) list(artist = trimws(m[2]), title = trimws(m[3])) else list(artist = "", title = b)
}

#' @param studio the handle from mod_studio_server().
#' @param lib reactive rs_library (RockShiny's mod_library_server()), or NULL: the app's library.
#' @noRd
mod_project_server <- function(id, studio, lib = NULL) {
  shiny::moduleServer(id, function(input, output, session) {
    ns <- session$ns
    if (is.null(lib)) lib <- shiny::reactivePoll(2000, session, checkFunc = library_version, valueFunc = library_current)
    offered <- shiny::reactiveVal(character())
    shiny::observe({
      l <- lib()
      s <- library_all_songs(l)
      s <- s[s$kind == "psarc" | grepl("\\.psarc$", s$path, ignore.case = TRUE), , drop = FALSE]
      paths <- s$path[order(tolower(s$label))]
      if (identical(paths, shiny::isolate(offered()))) return()
      offered(paths)
      labels <- s$label[order(tolower(s$label))]
      shiny::updateSelectizeInput(session, "library", choices = c(list(""), as.list(stats::setNames(paths, labels))),
                                  selected = shiny::isolate(input$library) %||% "")
    })
    shiny::observeEvent(input$library, {
      shiny::req(nzchar(input$library), input$library %in% offered())
      studio$open(input$library, basename(input$library))
    }, ignoreInit = TRUE)

    audio <- shiny::reactiveVal(NULL)                 # an audio file waiting for the new-song form
    shiny::observeEvent(input$file, {
      f <- input$file
      if (grepl("\\.psarc$", f$name, ignore.case = TRUE)) {
        path <- tryCatch(library_store_upload(f$datapath, f$name), error = function(e) f$datapath)   # kept, as RockShiny does
        studio$open(path, f$name)
        rs_loading(session, ns("file"), "end", zone = ns("file"))      # RockShiny's dropzone: "Opened"
      } else {
        audio(list(path = f$datapath, name = f$name))
        rs_loading(session, ns("file"), "end", zone = ns("file"))
        shiny::showModal(creator_new_song_modal(ns, f$name, creator_guess_name(f$name)))
      }
    })
    shiny::observeEvent(input$new, {
      audio(NULL)
      shiny::showModal(creator_new_song_modal(ns))
    })
    shiny::observeEvent(input$audio, {
      f <- input$audio
      audio(list(path = f$datapath, name = f$name))
      g <- creator_guess_name(f$name)
      if (!nzchar(input$title %||% "")) shiny::updateTextInput(session, "title", value = g$title)
      if (!nzchar(input$artist %||% "") && nzchar(g$artist)) shiny::updateTextInput(session, "artist", value = g$artist)
    })
    shiny::observeEvent(input$create, {
      a <- audio()
      if (is.null(a)) { shiny::showNotification("Choose the song's audio first.", type = "warning"); return() }
      shiny::removeModal()
      studio$new_song(list(
        audio_path = a$path, audio_name = a$name, title = trimws(input$title %||% "") %|NA|% "Untitled",
        artist = trimws(input$artist %||% "") %|NA|% "Unknown Artist", album = trimws(input$album %||% ""),
        year = trimws(input$year %||% ""), platform = input$platform %||% "pc",
        arrangements = if (length(input$charts)) input$charts else "lead", tuning = input$tuning %||% "E standard",
        bpm = if (is.na(input$bpm %||% NA)) NULL else input$bpm, draft = isTRUE(input$draft)
      ))
    })

    output$state <- shiny::renderUI({
      s <- studio$state()
      if (is.null(s) || !isTRUE(s$open)) return(htmltools::div(class = "rsc-state", "Nothing open yet."))
      htmltools::div(class = "rsc-state",
        htmltools::tags$b(s$title %||% "Untitled"), " \u2014 ", s$artist %||% "", htmltools::br(),
        paste(length(s$charts), "chart(s):", paste(unlist(s$charts), collapse = ", ")),
        if (isTRUE(s$lyrics > 0)) paste0(" \u00b7 ", s$lyrics, " syllables"),
        if (isTRUE(s$dirty)) htmltools::tagList(htmltools::br(), htmltools::span(style = "color:#ffc46b", "Unsaved changes")))
    })
  })
}
