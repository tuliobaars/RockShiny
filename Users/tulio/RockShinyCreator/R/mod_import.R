# -----------------------------------------------------------------------------
# mod_import.R -- drag & drop / library picker -> reactive rs_song.
# -----------------------------------------------------------------------------

dropzone_dependency <- function() {
  htmltools::htmlDependency(
    name = "rockshiny-dropzone", version = "0.1.0",
    src = c(file = asset_dir("dropzone")),
    script = "dropzone.js", stylesheet = "dropzone.css"
  )
}

#' Artist, song and album of a library file from the library index (library.R),
#' scanning it if needed; the file name when the archive has no manifest.
#' @noRd
library_meta <- function(path) {
  p <- normalizePath(path, winslash = "/", mustWork = FALSE)
  r <- library_index()
  i <- match(p, r$path)
  info <- file.info(p)
  row <- if (!is.na(i) && r$size[i] == as.numeric(info$size) && r$mtime[i] == floor(as.numeric(info$mtime))) r[i, ]
         else library_scan_file(p)
  list(artist = row$artist, song = row$title, album = row$album %|NA|% "")
}

#' Library entries: a folder's songs plus the bundled examples (inst/examples).
#' Values are full paths; labels "Artist -- Title" (library.R).
#' @noRd
library_choices <- function(dir = library_dir(), examples = TRUE) {
  lib <- library_open(dir, library_recursive(), budget = Inf)
  if (examples) unlist(unname(library_instrument_choices(lib))) else library_choices_of(lib)
}

mod_import_ui <- function(id, library_ui = NULL) {
  ns <- shiny::NS(id)
  htmltools::tagList(
    dropzone_dependency(),
    htmltools::div(
      class = "rs-dropzone", `data-accept` = ".psarc,.mid,.midi,.kar", tabindex = "0", role = "button",
      `aria-label` = "Drop or browse for a .psarc or MIDI file",
      htmltools::div(class = "rs-dropzone-icon", shiny::icon("cloud-arrow-up")),
      htmltools::div(class = "rs-dropzone-label",
        htmltools::strong("Drop a .psarc or .mid"), htmltools::span("or click to browse")),
      # The real Shiny file input (visually hidden; its progress bar stays visible).
      shiny::fileInput(ns("file"), NULL, accept = c(".psarc", ".mid", ".midi", ".kar"), width = "100%")
    ),
    shiny::selectizeInput(ns("library"), "Library", choices = "", width = "100%",          # filled by the server
                          options = list(placeholder = "Search songs\u2026", maxOptions = 100000)),
    shiny::actionButton(ns("shuffle"), "Shuffle", icon = shiny::icon("shuffle"), class = "btn-sm rs-shuffle",
                        title = "Another song, picked at random"),
    if (!is.null(library_ui)) library_ui
  )
}

#' Loading overlay on a player (inst/app/app.js RSLoading): "start" shows it with
#' `text`; it goes away when the player has the new song, or on "end" / "error".
#' `zone`: the file input of an upload, whose dropzone follows the same states.
#' @noRd
rs_loading <- function(session, target, state = c("start", "end", "error"), text = NULL, sub = NULL, zone = NULL, name = NULL) {
  if (is.null(target)) return(invisible(NULL))
  session$sendCustomMessage("rs-loading", Filter(Negate(is.null), list(
    target = target, state = match.arg(state), text = text, sub = sub, zone = zone, name = name)))
}

#' "Artist -- Title" of a file for messages (the index knows it; else the file name).
#' @noRd
song_label <- function(path, fallback = basename(path)) {
  m <- tryCatch(library_meta(path), error = function(e) NULL)
  if (is.null(m) || is.null(m$song) || is.na(m$song)) return(fallback)
  if (is.null(m$artist) || is.na(m$artist) || !nzchar(m$artist)) m$song else paste(m$artist, "\u2014", m$song)
}

#' @param lib reactive rs_library (mod_library_server()); NULL: the app's library, fixed.
#' @param request optional reactive yielding list(path, name) to open a song from
#'   elsewhere in the app (the home screen, playlists).
#' @param stage id of the player output (for the loading overlay), e.g. "player-highway".
#' @return reactive() yielding an rs_song (or NULL while nothing is loaded).
#' @noRd
mod_import_server <- function(id, lib = NULL, request = NULL, stage = NULL) {
  shiny::moduleServer(id, function(input, output, session) {
    selected <- shiny::reactiveVal(NULL)
    if (is.null(lib)) lib <- shiny::reactive(library_current())
    choices <- shiny::reactive(library_instrument_choices(lib()))
    offered <- shiny::reactiveVal(NULL)
    shiny::observe({                                          # the list follows the library (its scan, uploads)
      ch <- choices()
      if (identical(ch, shiny::isolate(offered()))) return()
      offered(ch)
      paths <- unlist(ch, use.names = FALSE)
      sel <- shiny::isolate(selected())
      cur <- shiny::isolate(input$library)
      keep <- if (!is.null(sel) && sel$path %in% paths) sel$path else if (isTRUE(cur %in% paths)) cur else ""
      shiny::updateSelectizeInput(session, "library", choices = c(list(""), ch), selected = keep)
    })
    open <- function(path, name, zone = NULL) {
      if (identical(path, shiny::isolate(selected())$path)) {                        # already open
        if (!is.null(zone)) rs_loading(session, stage, "end", zone = zone)
        return(invisible())
      }
      rs_loading(session, stage, "start", text = paste0("Opening ", song_label(path, name), "\u2026"),
                 sub = if (grepl("\\.psarc$", name, ignore.case = TRUE)) "Unpacking the archive" else "Reading the MIDI file",
                 zone = zone, name = name)
      selected(list(path = path, name = name))
    }

    shiny::observeEvent(input$file, {                         # an upload: kept, listed, opened
      f <- input$file
      path <- tryCatch(library_store_upload(f$datapath, f$name), error = function(e) {
        shiny::showNotification(conditionMessage(e), type = "warning", duration = 6)
        f$datapath
      })
      open(path, f$name, zone = session$ns("file"))
      shiny::updateSelectizeInput(session, "library", selected = path)
    })
    shiny::observeEvent(input$shuffle, {                     # a song picked at random
      path <- random_song(lib(), "any")
      if (is.null(path)) return()
      open(path, basename(path))
      if (path %in% unlist(offered(), use.names = FALSE)) shiny::updateSelectizeInput(session, "library", selected = path)
    })
    shiny::observeEvent(input$library, {
      shiny::req(nzchar(input$library))
      path <- input$library                                  # a full path from the library
      shiny::req(path %in% unlist(offered(), use.names = FALSE))   # only files the library offers
      open(path, basename(path))
    }, ignoreInit = TRUE)
    if (!is.null(request)) {
      shiny::observeEvent(request(), {
        r <- request()
        shiny::req(r$path)
        open(r$path, r$name %||% basename(r$path))
        if (r$path %in% unlist(offered(), use.names = FALSE)) shiny::updateSelectizeInput(session, "library", selected = r$path)
      })
    }

    shiny::reactive({
      sel <- selected()
      shiny::req(sel)
      tryCatch(load_song(sel$path, sel$name), error = function(e) {
        msg <- paste("Could not open", sel$name, ":", conditionMessage(e))
        rs_loading(session, stage, "error", text = msg)
        shiny::showNotification(msg, type = "error", duration = 10)
        NULL
      })
    })
  })
}
