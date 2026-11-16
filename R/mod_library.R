# -----------------------------------------------------------------------------
# mod_library.R -- the library folder: a status bar in each mode's sidebar and
# a dialog to choose the folder (typed, or picked in a small folder browser on
# the machine running the app). The library is app-wide (library.R): every
# session sees the same folder, and big libraries are scanned in the background.
#
#   UI:     mod_library_bar_ui("library", "instrument")   (one per mode)
#   server: lib <- mod_library_server("library")           reactive rs_library
#
# options(rockshiny.library_picker = FALSE) hides "Change..." (e.g. on a shared
# server, where users should not browse its folders).
# -----------------------------------------------------------------------------

mod_library_bar_ui <- function(id, where) {
  ns <- shiny::NS(id)
  htmltools::div(
    class = "rs-libbar",
    shiny::icon("folder-open"),
    htmltools::div(class = "rs-libbar-text", shiny::uiOutput(ns(paste0("bar_", where)), inline = TRUE)),
    if (isTRUE(getOption("rockshiny.library_picker", TRUE)))     # FALSE on shared servers: no folder browsing
      shiny::actionLink(ns(paste0("change_", where)), "Change\u2026", class = "rs-libbar-change",
                        title = "Choose the folder with your .psarc files")
  )
}

#' Short form of a folder path for the status bar.
#' @noRd
library_short_dir <- function(dir, width = 34) {
  home <- normalizePath("~", mustWork = FALSE)
  d <- dir
  if (startsWith(d, home)) d <- paste0("~", substring(d, nchar(home) + 1L))
  if (nchar(d) > width) d <- paste0("\u2026", substring(d, nchar(d) - width + 2L))
  d
}

#' One line about the library: folder, songs, scanning progress.
#' @noRd
library_status_text <- function(lib) {
  s <- lib$songs
  n <- nrow(s)
  txt <- sprintf("%d song%s", n, if (n == 1) "" else "s")
  if (lib$pending) txt <- sprintf("%s \u00b7 checking %d/%d\u2026", txt, n - lib$pending, n)
  else if (lib$lazy) txt <- paste(txt, "\u00b7 large library: each song loads when picked")
  txt
}

mod_library_server <- function(id) {
  shiny::moduleServer(id, function(input, output, session) {
    ns <- session$ns
    lib <- shiny::reactivePoll(500, session, checkFunc = library_version, valueFunc = library_current)
    lists <- shiny::throttle(lib, 2000)          # song lists: at most every 2 s while a scan runs

    bar <- function() shiny::renderUI({
      l <- lib()
      htmltools::tagList(
        htmltools::span(class = "rs-libbar-dir", title = l$dir, library_short_dir(l$dir)),
        htmltools::span(class = "rs-libbar-count", library_status_text(l))
      )
    })
    output$bar_instrument <- bar()
    output$bar_karaoke <- bar()
    output$bar_home <- bar()

    # ---- the dialog ---------------------------------------------------------------------
    open_dialog <- function() {
      l <- shiny::isolate(lib())
      shiny::showModal(shiny::modalDialog(
        title = "Song library", size = "m", easyClose = TRUE,
        htmltools::p(class = "rs-hint", style = "margin: 0 0 .8rem",
                     "A folder with your Rocksmith .psarc files (and MIDI files) on the computer running RockShiny. ",
                     sprintf("Libraries of more than %d songs are mapped at once and read song by song when you pick one.",
                             as.integer(getOption("rockshiny.library_lazy_threshold", 50)))),
        shiny::textInput(ns("dir"), "Folder", value = normalizePath(l$dir, mustWork = FALSE), width = "100%"),
        shiny::checkboxInput(ns("recursive"), "Include subfolders", value = l$recursive),
        shiny::uiOutput(ns("browse")),
        footer = htmltools::tagList(
          shiny::modalButton("Cancel"),
          shiny::actionButton(ns("apply"), "Use this folder", class = "btn-primary", icon = shiny::icon("check"))
        )
      ))
    }
    shiny::observeEvent(input$change_instrument, open_dialog())
    shiny::observeEvent(input$change_karaoke, open_dialog())
    shiny::observeEvent(input$change_home, open_dialog())
    shiny::observeEvent(input$pick, shiny::updateTextInput(session, "dir", value = input$pick))

    dir_typed <- shiny::debounce(shiny::reactive(path.expand(trimws(input$dir %||% ""))), 300)
    output$browse <- shiny::renderUI({
      d <- dir_typed()
      shiny::req(nzchar(d))
      if (!dir.exists(d)) return(htmltools::div(class = "rs-libdir-msg is-error", "No such folder."))
      d <- normalizePath(d)
      subs <- tryCatch(list.dirs(d, full.names = TRUE, recursive = FALSE), error = function(e) character())
      subs <- subs[!startsWith(basename(subs), ".")]
      here <- length(library_files(d, FALSE))
      deep <- if (isTRUE(input$recursive)) length(library_files(d, TRUE)) else NA
      pick <- function(path, label, cls = "") {
        htmltools::tags$button(
          type = "button", class = paste("rs-libdir", cls), title = path,
          onclick = sprintf("Shiny.setInputValue('%s', %s, {priority: 'event'})", ns("pick"),
                            jsonlite::toJSON(path, auto_unbox = TRUE)),
          label)
      }
      up <- dirname(d)
      htmltools::tagList(
        htmltools::div(class = "rs-libdir-msg",
          if (is.na(deep)) sprintf("%d song file%s in this folder.", here, if (here == 1) "" else "s")
          else sprintf("%d song files here, %d with subfolders.", here, deep)),
        htmltools::div(
          class = "rs-libdirs",
          if (!identical(up, d)) pick(up, htmltools::tagList(shiny::icon("arrow-up"), " Up"), "is-up"),
          lapply(utils::head(subs, 300), function(s) pick(s, htmltools::tagList(shiny::icon("folder"), " ", basename(s))))
        )
      )
    })

    shiny::observeEvent(input$apply, {
      d <- path.expand(trimws(input$dir %||% ""))
      if (!nzchar(d) || !dir.exists(d)) {
        shiny::showNotification("That folder does not exist.", type = "error", duration = 5)
        return()
      }
      rec <- isTRUE(input$recursive)
      shiny::removeModal()
      l <- shiny::withProgress(message = "Opening the library\u2026", value = 0.5, {
        library_set_dir(d, rec)
        library_use(normalizePath(d), rec)
      })
      audio_prewarm_library(l)
      shiny::showNotification(
        if (!nrow(l$songs)) "No .psarc or MIDI files in that folder."
        else if (l$pending) sprintf("%d songs. Their titles and lyrics are being checked in the background.", nrow(l$songs))
        else sprintf("%d songs.", nrow(l$songs)),
        type = if (nrow(l$songs)) "message" else "warning", duration = 6)
    })

    lists
  })
}
