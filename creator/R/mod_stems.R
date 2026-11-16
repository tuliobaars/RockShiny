# -----------------------------------------------------------------------------
# mod_stems.R -- "Stems": separate the song into vocals, guitar, bass, drums
# and the rest, and keep them next to the song on the server.
#
# The separation itself runs in the browser (creator/inst/engine/rsc-stems.js,
# in a Web Worker), guided by the song's charts and lyrics; the mixer (mute,
# solo, volume) and the WAV downloads are in the studio's Stems tab. Here: the
# button, the status, and saving the stems as WAV files into a folder next to
# the song ("<song> (stems)/vocals.wav" ...) on the machine running the app.
#
#   UI:     mod_stems_ui("stems")
#   server: mod_stems_server("stems", studio, lib)
# -----------------------------------------------------------------------------

#' @noRd
mod_stems_ui <- function(id) {
  ns <- shiny::NS(id)
  bslib::accordion_panel(
    "Stems", value = "stems", icon = shiny::icon("layer-group"),
    shiny::actionButton(ns("run"), "Separate stems", icon = shiny::icon("wand-magic-sparkles"), class = "btn-primary rsc-wide"),
    shiny::uiOutput(ns("status")),
    shiny::actionButton(ns("save"), "Save the stems next to the song", icon = shiny::icon("floppy-disk"), class = "rsc-wide"),
    htmltools::div(class = "rs-hint", "Guided by the charts (every guitar and bass note) and the lyrics. Mute, solo and download each stem in the studio's Stems tab.")
  )
}

#' Folder for a song's stems: next to its file in the library, else in the library folder.
#' @noRd
creator_stems_dir <- function(song_path, title, artist, lib_dir = library_dir()) {
  base <- if (!is.null(song_path) && file.exists(song_path) && !startsWith(normalizePath(song_path, winslash = "/"), normalizePath(tempdir(), winslash = "/")))
    tools::file_path_sans_ext(song_path) else file.path(lib_dir, gsub("[^A-Za-z0-9 ._-]+", "_", paste(artist, "-", title)))
  paste0(base, " (stems)")
}

#' @noRd
mod_stems_server <- function(id, studio, lib = NULL) {
  shiny::moduleServer(id, function(input, output, session) {
    saved <- shiny::reactiveVal(NULL)
    shiny::observeEvent(input$run, studio$send("stems"))
    shiny::observeEvent(input$save, {
      s <- studio$state()
      if (is.null(s) || !length(s$stems)) { shiny::showNotification("Separate the stems first.", type = "warning"); return() }
      studio$send("save-stems")
    })
    shiny::observeEvent(studio$stems_saved(), {
      r <- studio$stems_saved()
      cur <- studio$current()
      dir <- creator_stems_dir(if (!is.null(cur)) cur$path, r$title %||% "Song", r$artist %||% "Artist",
                               if (!is.null(lib)) lib()$dir else library_dir())
      dir.create(dir, showWarnings = FALSE, recursive = TRUE)
      files <- character()
      for (part in unlist(r$ids)) {
        src <- studio$uploaded(r$token, "stem", part)
        if (!file.exists(src)) next
        dest <- file.path(dir, paste0(part, ".wav"))
        if (file.copy(src, dest, overwrite = TRUE)) files <- c(files, dest)
        unlink(src)
      }
      saved(list(dir = dir, files = files))
      shiny::showNotification(paste0(length(files), " stems saved in ", dir), type = "message", duration = 6)
    })
    output$status <- shiny::renderUI({
      s <- studio$state(); sv <- saved()
      if (is.null(s) || !isTRUE(s$open)) return(NULL)
      htmltools::div(class = "rsc-state",
        if (length(s$stems)) htmltools::tagList(htmltools::tags$b(length(s$stems), " stems: "), paste(unlist(s$stems), collapse = ", "))
        else "No stems yet.",
        if (!is.null(sv)) htmltools::tagList(htmltools::br(), "Saved: ", htmltools::tags$code(library_short_dir(sv$dir, 40))))
    })
  })
}
