# -----------------------------------------------------------------------------
# mod_export.R -- "Save": the package for PC or Mac, into the library folder
# (checked with RockShiny's own readers, then listed in every mode), as a
# download, and the Creator itself as an offline HTML file.
#
#   UI:     mod_export_ui("export")
#   server: saved <- mod_export_server("export", studio, lib, on_play)
#           saved(): path of the last package saved to the library
#   on_play(path, mode): open a saved song in RockShiny ("instrument" / "karaoke")
# -----------------------------------------------------------------------------

#' @noRd
mod_export_ui <- function(id) {
  ns <- shiny::NS(id)
  bslib::accordion_panel(
    "Save", value = "save", icon = shiny::icon("floppy-disk"),
    htmltools::div(class = "rsc-platform", shiny::radioButtons(ns("platform"), "Package for", c(PC = "pc", Mac = "mac"), inline = TRUE, width = "100%")),
    shiny::actionButton(ns("save"), "Save to the library", icon = shiny::icon("floppy-disk"), class = "btn-primary rsc-wide"),
    shiny::actionButton(ns("download"), "Download .psarc", icon = shiny::icon("download"), class = "rsc-wide"),
    shiny::uiOutput(ns("report")),
    shiny::uiOutput(ns("play")),
    shiny::downloadButton(ns("offline"), "Offline studio (.html)", class = "btn-sm rs-shuffle", icon = shiny::icon("plane")),
    htmltools::div(class = "rs-hint", "Unchanged files are written back byte for byte; edited charts get a new XML and a compiled SNG, ",
                   "with their difficulty levels as the studio's Levels tab says (kept, rebuilt or one level). ",
                   "The offline studio is this app in one HTML file: it opens and saves .psarc files without a server.")
  )
}

#' Where a saved package goes: the library folder, never over an existing file.
#' @noRd
creator_save_path <- function(dir, name) {
  name <- gsub("[/\\\\:*?\"<>|]+", "_", basename(name))
  dest <- file.path(dir, name)
  k <- 2L
  while (file.exists(dest)) {
    dest <- file.path(dir, sub("(_[pm])?\\.psarc$", paste0("-", k, "\\1.psarc"), name))
    k <- k + 1L
  }
  dest
}

#' @noRd
mod_export_server <- function(id, studio, lib = NULL, on_play = NULL) {
  shiny::moduleServer(id, function(input, output, session) {
    ns <- session$ns
    pending <- shiny::reactiveVal(NULL)
    saved <- shiny::reactiveVal(NULL)
    report <- shiny::reactiveVal(NULL)
    shiny::observeEvent(studio$state(), {                # the platform follows the song that is opened
      s <- studio$state()
      if (isTRUE(s$open) && !is.null(s$platform) && !identical(s$key, shiny::isolate(pending()$key)))
        shiny::updateRadioButtons(session, "platform", selected = s$platform)
    }, ignoreInit = TRUE)
    shiny::observeEvent(input$save, {
      s <- studio$state()
      if (is.null(s) || !isTRUE(s$open)) { shiny::showNotification("Open or create a song first.", type = "warning"); return() }
      pending(list(token = studio$save(input$platform, "library"), key = s$key))
    })
    shiny::observeEvent(input$download, {
      s <- studio$state()
      if (is.null(s) || !isTRUE(s$open)) { shiny::showNotification("Open or create a song first.", type = "warning"); return() }
      studio$save(input$platform, "download")
    })
    shiny::observeEvent(studio$saved(), {
      r <- studio$saved()
      p <- pending()
      if (is.null(p) || !identical(r$token, p$token)) return()
      pending(NULL)
      src <- studio$uploaded(r$token, "psarc")
      dir <- if (!is.null(lib)) lib()$dir else library_dir()
      dest <- creator_save_path(dir, r$name)
      ok <- file.exists(src) && file.copy(src, dest)
      unlink(src)
      if (!ok) { report(list(ok = FALSE, lines = paste("Could not write", dest))); return() }
      v <- creator_validate(dest)
      report(c(v, list(path = dest, size = file.size(dest))))
      saved(normalizePath(dest, winslash = "/"))
      library_use(dir, library_recursive())          # every mode lists it now
    })
    shiny::observeEvent(studio$errors(), {
      e <- studio$errors()
      if (identical(e$cmd, "save")) { pending(NULL); report(list(ok = FALSE, lines = e$message)) }
    })
    output$report <- shiny::renderUI({
      r <- report()
      if (is.null(r)) return(NULL)
      htmltools::div(class = paste("rsc-report", if (isTRUE(r$ok)) "is-ok" else "is-error"),
        htmltools::tags$b(if (isTRUE(r$ok)) "Saved and checked" else "Problems"), " \u2014 ", paste(r$lines, collapse = " \u00b7 "),
        if (!is.null(r$path)) htmltools::tagList(htmltools::br(), htmltools::tags$code(library_short_dir(r$path, 44)),
                                                  sprintf(" (%.1f MB)", r$size / 1e6)))
    })
    output$play <- shiny::renderUI({
      if (is.null(on_play) || is.null(saved())) return(NULL)
      htmltools::div(class = "rsc-play",
        shiny::actionButton(ns("play_instrument"), "Play it", icon = shiny::icon("guitar"), class = "btn-sm"),
        shiny::actionButton(ns("play_karaoke"), "Sing it", icon = shiny::icon("microphone-lines"), class = "btn-sm"))
    })
    shiny::observeEvent(input$play_instrument, on_play(saved(), "instrument"))
    shiny::observeEvent(input$play_karaoke, on_play(saved(), "karaoke"))
    output$offline <- shiny::downloadHandler(
      filename = function() "RockShinyCreator.html",
      content = function(file) creator_build_html(file)
    )
    saved
  })
}
